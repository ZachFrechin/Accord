//! Message reactions repository. Reactions are plaintext metadata (an emoji + the
//! reactor) so the server can aggregate counts; message bodies stay ciphertext.
//! SQL is compile-checked by the sqlx macros.

use uuid::Uuid;

use crate::error::ApiError;

/// One aggregated reaction bucket for a message: an emoji, how many people used
/// it, and whether the requesting user is one of them.
#[derive(Debug, Clone)]
pub struct ReactionAgg {
    pub message_id: Uuid,
    pub emoji: String,
    pub count: i64,
    pub me: bool,
}

/// Toggles the caller's reaction: adds it if absent, removes it if present.
/// Returns `true` when the reaction is now set (added), `false` when cleared.
pub async fn toggle(
    pool: &sqlx::PgPool,
    message_id: Uuid,
    user_id: Uuid,
    emoji: &str,
) -> Result<bool, ApiError> {
    // INSERT ... ON CONFLICT DO NOTHING reports whether a row was created; if not,
    // the reaction already existed, so remove it. Two statements, but the PK makes
    // each a single index lookup and a stray double-toggle only flips state.
    let inserted = sqlx::query_scalar!(
        "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING RETURNING true AS \"inserted!\"",
        message_id,
        user_id,
        emoji,
    )
    .fetch_optional(pool)
    .await?;

    if inserted.is_some() {
        return Ok(true);
    }
    sqlx::query!(
        "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
        message_id,
        user_id,
        emoji,
    )
    .execute(pool)
    .await?;
    Ok(false)
}

/// Aggregates reactions for a set of messages, oldest-emoji-first, tagging each
/// bucket with whether `user_id` reacted. Returns an empty vec for no reactions.
pub async fn aggregate_for_messages(
    pool: &sqlx::PgPool,
    message_ids: &[Uuid],
    user_id: Uuid,
) -> Result<Vec<ReactionAgg>, ApiError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_as!(
        ReactionAgg,
        r#"SELECT message_id,
                  emoji,
                  COUNT(*)                       AS "count!",
                  bool_or(user_id = $2)          AS "me!"
           FROM message_reactions
           WHERE message_id = ANY($1)
           GROUP BY message_id, emoji
           ORDER BY MIN(created_at)"#,
        message_ids,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}
