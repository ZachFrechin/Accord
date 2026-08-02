//! Messages repository. The server stores only ciphertext + per-device wrapped
//! keys — it never sees a plaintext body or a private key. Compile-checked by the
//! sqlx macros.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::ApiError;

/// A message key wrapped for one recipient device (built by the sender client).
pub struct RecipientKey {
    pub recipient_user_id: Uuid,
    pub recipient_device: String,
    pub wrapped_key: Vec<u8>,
    pub wrap_nonce: Vec<u8>,
}

/// A stored message plus the wrapped key for the *requesting* device (NULL when
/// that device has no key for this message — e.g. it joined after the message).
#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: Uuid,
    pub sender_id: Option<Uuid>,
    pub sender_device: String,
    pub ciphertext: Vec<u8>,
    pub body_nonce: Vec<u8>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub reply_to: Option<Uuid>,
    pub wrapped_key: Option<Vec<u8>>,
    pub wrap_nonce: Option<Vec<u8>>,
}

/// A message's authorship metadata, for edit/delete authorization.
pub struct MessageMeta {
    pub sender_id: Option<Uuid>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// A message to insert (ciphertext already produced by the sender client).
pub struct NewMessage<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub sender_device: &'a str,
    pub ciphertext: &'a [u8],
    pub body_nonce: &'a [u8],
    pub reply_to: Option<Uuid>,
}

/// Inserts a message and its per-device wrapped keys atomically. Returns the
/// server-assigned `created_at`.
pub async fn insert_message(
    pool: &sqlx::PgPool,
    msg: NewMessage<'_>,
    keys: &[RecipientKey],
) -> Result<DateTime<Utc>, ApiError> {
    let mut tx = pool.begin().await?;
    let created_at = sqlx::query_scalar!(
        "INSERT INTO messages (id, conversation_id, sender_id, sender_device, ciphertext, body_nonce, reply_to) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at",
        msg.id,
        msg.conversation_id,
        msg.sender_id,
        msg.sender_device,
        msg.ciphertext,
        msg.body_nonce,
        msg.reply_to,
    )
    .fetch_one(&mut *tx)
    .await?;

    for key in keys {
        sqlx::query!(
            "INSERT INTO message_keys (message_id, recipient_user_id, recipient_device, wrapped_key, wrap_nonce) \
             VALUES ($1, $2, $3, $4, $5)",
            msg.id,
            key.recipient_user_id,
            key.recipient_device,
            key.wrapped_key,
            key.wrap_nonce,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(created_at)
}

/// Returns a keyset page of a conversation's messages (newest first), each joined
/// with the wrapped key for `device_id` (the requesting device). `before` is the
/// `(created_at, id)` of the oldest message already seen, or `None` for the head.
pub async fn list_page(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
    device_id: &str,
    before: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> Result<Vec<MessageRow>, ApiError> {
    let (before_ts, before_id) = match before {
        Some((ts, id)) => (Some(ts), Some(id)),
        None => (None, None),
    };
    sqlx::query_as!(
        MessageRow,
        // `?` forces nullability on the LEFT JOIN columns: sqlx otherwise infers
        // them NOT NULL from message_keys' base schema and fails to decode a NULL
        // when the requesting device has no key for a message.
        r#"SELECT m.id, m.sender_id, m.sender_device, m.ciphertext, m.body_nonce, m.created_at,
                  m.edited_at, m.deleted_at, m.reply_to,
                  mk.wrapped_key AS "wrapped_key?", mk.wrap_nonce AS "wrap_nonce?"
           FROM messages m
           LEFT JOIN message_keys mk
             ON mk.message_id = m.id AND mk.recipient_user_id = $2 AND mk.recipient_device = $3
           WHERE m.conversation_id = $1
             AND ($4::timestamptz IS NULL OR (m.created_at, m.id) < ($4::timestamptz, $5::uuid))
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $6"#,
        conversation_id,
        user_id,
        device_id,
        before_ts,
        before_id,
        limit,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Fetches a message's authorship metadata within a conversation (for edit/
/// delete authorization and read-marker resolution).
pub async fn get_meta(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    message_id: Uuid,
) -> Result<Option<MessageMeta>, ApiError> {
    sqlx::query_as!(
        MessageMeta,
        "SELECT sender_id, deleted_at, created_at FROM messages \
         WHERE id = $1 AND conversation_id = $2",
        message_id,
        conversation_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Replaces a message's ciphertext + wrapped keys (an edit). Stamps `edited_at`.
pub async fn update_message(
    pool: &sqlx::PgPool,
    message_id: Uuid,
    ciphertext: &[u8],
    body_nonce: &[u8],
    keys: &[RecipientKey],
) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "UPDATE messages SET ciphertext = $2, body_nonce = $3, edited_at = now() WHERE id = $1",
        message_id,
        ciphertext,
        body_nonce,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("DELETE FROM message_keys WHERE message_id = $1", message_id)
        .execute(&mut *tx)
        .await?;
    for key in keys {
        sqlx::query!(
            "INSERT INTO message_keys (message_id, recipient_user_id, recipient_device, wrapped_key, wrap_nonce) \
             VALUES ($1, $2, $3, $4, $5)",
            message_id,
            key.recipient_user_id,
            key.recipient_device,
            key.wrapped_key,
            key.wrap_nonce,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Tombstones a message: stamps `deleted_at`, drops the ciphertext and every
/// wrapped key so nothing recoverable remains.
pub async fn delete_message(pool: &sqlx::PgPool, message_id: Uuid) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "UPDATE messages SET deleted_at = now(), ciphertext = ''::bytea, body_nonce = ''::bytea \
         WHERE id = $1 AND deleted_at IS NULL",
        message_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("DELETE FROM message_keys WHERE message_id = $1", message_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
