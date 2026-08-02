//! Attachment blob records (E2EE object storage). The server tracks only who may
//! fetch a blob — never the file key or plaintext. Compile-checked by sqlx.

use uuid::Uuid;

use crate::error::ApiError;

/// Records a blob a client is about to upload (as ciphertext) to object storage.
pub async fn create(
    pool: &sqlx::PgPool,
    id: Uuid,
    conversation_id: Uuid,
    owner_id: Uuid,
    size_bytes: i64,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO attachments (id, conversation_id, owner_id, size_bytes) \
         VALUES ($1, $2, $3, $4)",
        id,
        conversation_id,
        owner_id,
        size_bytes,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns the conversation a blob belongs to (for download authorization).
pub async fn conversation_of(pool: &sqlx::PgPool, id: Uuid) -> Result<Option<Uuid>, ApiError> {
    sqlx::query_scalar!("SELECT conversation_id FROM attachments WHERE id = $1", id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from)
}
