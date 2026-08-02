//! Email-verification tokens, recovery codes, and the email outbox. Queries are
//! compile-checked by the `sqlx::query!` family (offline data in `.sqlx/`).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

/// Stores an email-verification token (its SHA-256 digest) with a TTL.
pub async fn create_email_verification(
    pool: &PgPool,
    user_id: Uuid,
    token_hash: &[u8],
    expires_at: DateTime<Utc>,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) \
         VALUES ($1, $2, $3)",
        user_id,
        token_hash,
        expires_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomically consumes a valid, unexpired verification token, returning the
/// user id it belonged to (or `None` if the token is unknown/expired/used).
pub async fn consume_email_verification(
    pool: &PgPool,
    token_hash: &[u8],
) -> Result<Option<Uuid>, ApiError> {
    let user_id = sqlx::query_scalar!(
        "UPDATE email_verification_tokens SET used_at = now() \
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() \
         RETURNING user_id",
        token_hash,
    )
    .fetch_optional(pool)
    .await?;
    Ok(user_id)
}

/// Stores a password-reset token (its SHA-256 digest) with a TTL.
pub async fn create_password_reset(
    pool: &PgPool,
    user_id: Uuid,
    token_hash: &[u8],
    expires_at: DateTime<Utc>,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        user_id,
        token_hash,
        expires_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomically consumes a valid, unexpired reset token, returning its user id.
pub async fn consume_password_reset(
    pool: &PgPool,
    token_hash: &[u8],
) -> Result<Option<Uuid>, ApiError> {
    let user_id = sqlx::query_scalar!(
        "UPDATE password_reset_tokens SET used_at = now() \
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() \
         RETURNING user_id",
        token_hash,
    )
    .fetch_optional(pool)
    .await?;
    Ok(user_id)
}

/// Inserts a user's recovery-code hashes (a full set) in one transaction.
pub async fn insert_recovery_codes(
    pool: &PgPool,
    user_id: Uuid,
    hashes: &[String],
) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    for hash in hashes {
        sqlx::query!(
            "INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)",
            user_id,
            hash.as_str(),
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// A stored recovery code (its salted Argon2id hash) that hasn't been used.
pub struct UnusedRecoveryCode {
    pub id: Uuid,
    pub code_hash: String,
}

/// The unused recovery codes for a user. The hashes are salted Argon2id, so a
/// submitted code can't be looked up by hash — callers Argon2-verify against each
/// row, then atomically consume the match via [`consume_recovery_code`].
pub async fn unused_recovery_codes(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<UnusedRecoveryCode>, ApiError> {
    let rows = sqlx::query_as!(
        UnusedRecoveryCode,
        "SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL",
        user_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Atomically consumes one recovery-code row (single-use). Returns true if it was
/// still unused (the caller has already Argon2-verified the plaintext against it).
pub async fn consume_recovery_code(pool: &PgPool, id: Uuid) -> Result<bool, ApiError> {
    let row = sqlx::query_scalar!(
        "UPDATE recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
        id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Deletes all of a user's recovery codes (before issuing a fresh set on 2FA enable).
pub async fn delete_recovery_codes(pool: &PgPool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query!("DELETE FROM recovery_codes WHERE user_id = $1", user_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Enqueues an email for the outbox worker (Lot 4) to deliver. The payload is
/// bound as text and cast to `jsonb` (`$3::text::jsonb` pins the parameter to
/// text) so no extra sqlx feature is needed.
pub async fn enqueue_email(
    pool: &PgPool,
    recipient: &str,
    template: &str,
    payload: &serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO email_outbox (recipient, template, payload) VALUES ($1, $2, $3::text::jsonb)",
        recipient,
        template,
        payload.to_string(),
    )
    .execute(pool)
    .await?;
    Ok(())
}
