use sqlx::Row;
use uuid::Uuid;

use crate::error::ApiError;

/// Mark a conversation-owned attachment as a call sound and roll its expiry.
/// Returns false when the blob does not exist in this conversation.
pub async fn touch(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    blob_id: Uuid,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r#"INSERT INTO call_sound_assets (conversation_id, blob_id, last_used_at, expires_at)
           SELECT conversation_id, id, now(), now() + INTERVAL '30 days'
           FROM attachments
           WHERE id = $1 AND conversation_id = $2
           ON CONFLICT (blob_id) DO UPDATE
             SET last_used_at = now(), expires_at = now() + INTERVAL '30 days'
           RETURNING blob_id"#,
    )
    .bind(blob_id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(result.is_some())
}

pub async fn expired(pool: &sqlx::PgPool, limit: i64) -> Result<Vec<(Uuid, Uuid)>, ApiError> {
    let rows = sqlx::query(
        "SELECT conversation_id, blob_id FROM call_sound_assets \
         WHERE expires_at <= now() ORDER BY expires_at LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| Ok((row.try_get("conversation_id")?, row.try_get("blob_id")?)))
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(ApiError::from)
}

/// Removing the attachment cascades the lifecycle row. Only expired rows are
/// eligible, which keeps concurrent trigger/touch operations retry-safe.
pub async fn remove_if_expired(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    blob_id: Uuid,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        r#"DELETE FROM attachments
           WHERE id = $1 AND conversation_id = $2
             AND EXISTS (
               SELECT 1 FROM call_sound_assets
               WHERE blob_id = $1 AND conversation_id = $2 AND expires_at <= now()
             )"#,
    )
    .bind(blob_id)
    .bind(conversation_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
