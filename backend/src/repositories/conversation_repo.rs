//! Conversations & membership repository. Compile-checked by the sqlx macros.
//!
//! A conversation is a DM (2 members, deduplicated by a canonical `dm_key`) or a
//! group (Lot 4). This layer owns creation, membership checks, and the member
//! fan-out list used to route realtime events.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::ApiError;
use crate::repositories::friend_repo::ordered;

/// A conversation the caller belongs to, with their unread count.
#[derive(Debug, Clone)]
pub struct ConversationRow {
    pub id: Uuid,
    pub kind: String,
    pub name: Option<String>,
    pub protocol: String,
    pub created_at: DateTime<Utc>,
    pub unread: i64,
    pub last_read_at: Option<DateTime<Utc>>,
    pub description: Option<String>,
    pub avatar_version: i32,
}

/// A conversation's kind, used to gate group-only operations.
#[derive(Debug, Clone)]
pub struct ConversationInfo {
    pub kind: String,
}

/// A group member with their display name and role.
#[derive(Debug, Clone)]
pub struct MemberRow {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_version: Option<i32>,
    pub role: String,
}

/// Gets (or creates) the single DM conversation for a pair, ensuring both are
/// members. Race-safe via `ON CONFLICT (dm_key)`.
pub async fn get_or_create_dm(pool: &sqlx::PgPool, a: Uuid, b: Uuid) -> Result<Uuid, ApiError> {
    let (lo, hi) = ordered(a, b);
    let dm_key = format!("{lo}:{hi}");
    let new_id = Uuid::now_v7();

    let mut tx = pool.begin().await?;
    sqlx::query!(
        "INSERT INTO conversations (id, kind, dm_key, created_by, protocol) \
         VALUES ($1, 'dm', $2, $3, 'mls') \
         ON CONFLICT (dm_key) DO NOTHING",
        new_id,
        dm_key,
        a,
    )
    .execute(&mut *tx)
    .await?;
    let conv_id = sqlx::query_scalar!("SELECT id FROM conversations WHERE dm_key = $1", dm_key)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query!(
        "INSERT INTO conversation_members (conversation_id, user_id) \
         VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING",
        conv_id,
        a,
        b,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(conv_id)
}

/// A conversation's E2EE protocol flag ("x25519" legacy or "mls").
pub async fn protocol_of(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
) -> Result<Option<String>, ApiError> {
    Ok(sqlx::query_scalar!(
        "SELECT protocol FROM conversations WHERE id = $1",
        conversation_id,
    )
    .fetch_optional(pool)
    .await?)
}

/// Whether a user is a member of a conversation (authorization gate).
pub async fn is_member(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    let found = sqlx::query_scalar!(
        "SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        user_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

/// All member user ids of a conversation (used to fan out realtime events).
pub async fn member_ids(pool: &sqlx::PgPool, conversation_id: Uuid) -> Result<Vec<Uuid>, ApiError> {
    sqlx::query_scalar!(
        "SELECT user_id FROM conversation_members WHERE conversation_id = $1",
        conversation_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// The caller's conversations, most-recently-active first (by last message, then
/// creation).
pub async fn list_for_user(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Vec<ConversationRow>, ApiError> {
    sqlx::query_as!(
        ConversationRow,
        r#"SELECT c.id, c.kind, c.name, c.protocol, c.created_at,
                  c.description, c.avatar_version,
                  m.last_read_at,
                  (SELECT count(*) FROM messages msg
                     WHERE msg.conversation_id = c.id
                       AND msg.deleted_at IS NULL
                       AND msg.sender_id IS DISTINCT FROM $1
                       AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at)
                  ) AS "unread!"
           FROM conversations c
           JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1
           ORDER BY c.created_at DESC"#,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Sets a conversation's E2EE protocol (the cutover flag). Forward-only in
/// practice — callers flip legacy → 'mls' once the MLS group exists.
pub async fn set_protocol(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    protocol: &str,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE conversations SET protocol = $2 WHERE id = $1",
        conversation_id,
        protocol,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Advances the caller's read marker to `up_to` (never backwards).
pub async fn set_last_read(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
    up_to: DateTime<Utc>,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE conversation_members SET last_read_at = GREATEST(last_read_at, $3) \
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        user_id,
        up_to,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Creates a group conversation with `creator` as its first (admin) member.
pub async fn create_group(
    pool: &sqlx::PgPool,
    creator: Uuid,
    name: &str,
) -> Result<Uuid, ApiError> {
    let id = Uuid::now_v7();
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "INSERT INTO conversations (id, kind, name, created_by, protocol) \
         VALUES ($1, 'group', $2, $3, 'mls')",
        id,
        name,
        creator,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')",
        id,
        creator,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
}

/// Fetches a conversation's kind/name/creator (for group-operation gating).
pub async fn get_info(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
) -> Result<Option<ConversationInfo>, ApiError> {
    sqlx::query_as!(
        ConversationInfo,
        "SELECT kind FROM conversations WHERE id = $1",
        conversation_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// A member's role in a conversation, or `None` if they are not a member.
pub async fn get_role(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar!(
        "SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        user_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Adds a member to a conversation (idempotent). Returns whether a row was added.
pub async fn add_member(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> Result<bool, ApiError> {
    let affected = sqlx::query!(
        "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING",
        conversation_id,
        user_id,
        role,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected > 0)
}

/// Removes a member. Returns whether a row was removed.
pub async fn remove_member(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<bool, ApiError> {
    let affected = sqlx::query!(
        "DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        user_id,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected > 0)
}

/// Renames a group conversation.
/// Set (or clear, with None) a group's description.
pub async fn set_description(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    description: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE conversations SET description = $2 WHERE id = $1",
        conversation_id,
        description,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Current group avatar version (0 = none).
pub async fn group_avatar_version(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
) -> Result<i32, ApiError> {
    Ok(sqlx::query_scalar!(
        "SELECT avatar_version FROM conversations WHERE id = $1",
        conversation_id,
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or(0))
}

/// Point the group at a new (already uploaded) avatar version; 0 clears it.
pub async fn set_group_avatar_version(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    version: i32,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE conversations SET avatar_version = $2 WHERE id = $1",
        conversation_id,
        version,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn rename(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
    name: &str,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE conversations SET name = $2 WHERE id = $1",
        conversation_id,
        name,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Lists a conversation's members with their username and role.
pub async fn list_members(
    pool: &sqlx::PgPool,
    conversation_id: Uuid,
) -> Result<Vec<MemberRow>, ApiError> {
    sqlx::query_as!(
        MemberRow,
        r#"SELECT m.user_id, u.username,
                  p.display_name AS "display_name?", p.avatar_version AS "avatar_version?",
                  m.role
           FROM conversation_members m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN user_profiles p ON p.user_id = m.user_id
           WHERE m.conversation_id = $1 ORDER BY u.username"#,
        conversation_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Whether two users share at least one conversation (co-membership) — used to
/// authorize fetching a co-member's key bundle even without a friendship.
pub async fn shares_conversation(pool: &sqlx::PgPool, a: Uuid, b: Uuid) -> Result<bool, ApiError> {
    let found = sqlx::query_scalar!(
        "SELECT 1 FROM conversation_members m1 \
         JOIN conversation_members m2 ON m1.conversation_id = m2.conversation_id \
         WHERE m1.user_id = $1 AND m2.user_id = $2 LIMIT 1",
        a,
        b,
    )
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}
