//! Email outbox worker.
//!
//! A background loop that drains `email_outbox`: it atomically claims a batch of
//! due rows (flipping them to `sending` under `FOR UPDATE SKIP LOCKED`, so many
//! replicas can run this worker without double-sending), delivers each via SMTP
//! outside any transaction (no long-held row locks), then marks them `sent` or
//! schedules a retry with exponential backoff. This decouples "an email is
//! needed" from "an email was sent" so a slow provider never blocks a request.

use std::time::Duration;

use sqlx::PgPool;

use crate::domain::mailer::{self, SmtpMailer};
use crate::error::ApiError;

/// Rows claimed per drain.
const BATCH: i64 = 10;

/// Runs the outbox worker forever, polling every `poll_secs`.
pub async fn run_worker(pool: PgPool, mailer: SmtpMailer, poll_secs: u64, max_attempts: i32) {
    let interval = Duration::from_secs(poll_secs.max(1));
    loop {
        match drain_once(&pool, &mailer, max_attempts).await {
            Ok(0) => {}
            Ok(n) => tracing::debug!(delivered_or_retried = n, "outbox batch processed"),
            Err(err) => tracing::error!(error = %err, "outbox drain failed"),
        }
        tokio::time::sleep(interval).await;
    }
}

/// Claims and processes one batch. Returns the number of rows handled.
async fn drain_once(
    pool: &PgPool,
    mailer: &SmtpMailer,
    max_attempts: i32,
) -> Result<usize, ApiError> {
    // Atomically claim due rows: flip pending -> sending so no other worker (or
    // replica) grabs them. SKIP LOCKED avoids contention across workers. The
    // `payload::text` cast is asserted non-null (`"payload!"`) since the column is.
    let claimed = sqlx::query!(
        r#"UPDATE email_outbox SET status = 'sending'
           WHERE id IN (
               SELECT id FROM email_outbox
               WHERE status = 'pending' AND next_attempt_at <= now()
               ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
           )
           RETURNING id, recipient, template, payload::text AS "payload!""#,
        BATCH,
    )
    .fetch_all(pool)
    .await?;

    let count = claimed.len();
    for row in claimed {
        let id = row.id;
        let payload = serde_json::from_str(&row.payload).unwrap_or_else(|_| serde_json::json!({}));
        let message = mailer::render(&row.template, &row.recipient, &payload);

        match mailer.send(message).await {
            Ok(()) => {
                sqlx::query!(
                    "UPDATE email_outbox SET status = 'sent', sent_at = now() WHERE id = $1",
                    id,
                )
                .execute(pool)
                .await?;
            }
            Err(err) => {
                // Retry with exponential backoff (capped at 5 min); give up after
                // `max_attempts`.
                sqlx::query!(
                    "UPDATE email_outbox SET \
                         attempts = attempts + 1, \
                         last_error = $2, \
                         status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END, \
                         next_attempt_at = now() + make_interval(secs => LEAST(300, power(2, attempts + 1)::int)) \
                     WHERE id = $1",
                    id,
                    err.to_string(),
                    max_attempts,
                )
                .execute(pool)
                .await?;
                tracing::warn!(outbox_id = %id, error = %err, "email delivery failed; scheduled retry");
            }
        }
    }
    Ok(count)
}
