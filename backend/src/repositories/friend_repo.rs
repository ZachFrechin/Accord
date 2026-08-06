//! Friendships repository (social graph). Compile-checked by the sqlx macros.
//!
//! Every pair is stored once, canonicalised as `(user_lo < user_hi)`. The
//! controller owns the state machine; this layer offers pair-addressed
//! primitives plus a per-user listing that resolves "the other side".

use uuid::Uuid;

use crate::error::ApiError;

/// The mutable part of a friendship edge (the caller already holds the pair).
#[derive(Debug, Clone)]
pub struct FriendEdge {
    pub state: String,
    pub requested_by: Uuid,
}

/// A row of a user's friend listing: the *other* party plus the edge state.
#[derive(Debug, Clone)]
pub struct FriendListRow {
    pub other_id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_version: Option<i32>,
    pub state: String,
    pub requested_by: Uuid,
}

/// Canonical pair ordering (`lo < hi`). Callers guarantee `a != b`.
pub fn ordered(a: Uuid, b: Uuid) -> (Uuid, Uuid) {
    if a <= b { (a, b) } else { (b, a) }
}

/// Fetches the edge for a canonical pair, if any.
pub async fn get_pair(
    pool: &sqlx::PgPool,
    lo: Uuid,
    hi: Uuid,
) -> Result<Option<FriendEdge>, ApiError> {
    sqlx::query_as!(
        FriendEdge,
        "SELECT state, requested_by \
         FROM friendships WHERE user_lo = $1 AND user_hi = $2",
        lo,
        hi,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Inserts a fresh pending request for a canonical pair.
pub async fn insert_pending(
    pool: &sqlx::PgPool,
    lo: Uuid,
    hi: Uuid,
    requested_by: Uuid,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO friendships (user_lo, user_hi, state, requested_by) \
         VALUES ($1, $2, 'pending', $3)",
        lo,
        hi,
        requested_by,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Sets the state of an existing pair.
pub async fn set_state(
    pool: &sqlx::PgPool,
    lo: Uuid,
    hi: Uuid,
    state: &str,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE friendships SET state = $3, updated_at = now() \
         WHERE user_lo = $1 AND user_hi = $2",
        lo,
        hi,
        state,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Upserts a pair into the `blocked` state, recording `blocker` as `requested_by`.
pub async fn block(pool: &sqlx::PgPool, lo: Uuid, hi: Uuid, blocker: Uuid) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO friendships (user_lo, user_hi, state, requested_by) \
         VALUES ($1, $2, 'blocked', $3) \
         ON CONFLICT (user_lo, user_hi) \
         DO UPDATE SET state = 'blocked', requested_by = $3, updated_at = now()",
        lo,
        hi,
        blocker,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Deletes a pair. Returns whether a row was removed.
pub async fn delete_pair(pool: &sqlx::PgPool, lo: Uuid, hi: Uuid) -> Result<bool, ApiError> {
    let affected = sqlx::query!(
        "DELETE FROM friendships WHERE user_lo = $1 AND user_hi = $2",
        lo,
        hi,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected > 0)
}

/// Lists every edge touching `user_id`, resolving the other party's username.
pub async fn list_for_user(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Vec<FriendListRow>, ApiError> {
    sqlx::query_as!(
        FriendListRow,
        r#"SELECT
             (CASE WHEN f.user_lo = $1 THEN f.user_hi ELSE f.user_lo END) AS "other_id!",
             u.username AS "username!",
             p.display_name AS "display_name?",
             p.avatar_version AS "avatar_version?",
             f.state AS "state!",
             f.requested_by AS "requested_by!"
           FROM friendships f
           JOIN users u
             ON u.id = (CASE WHEN f.user_lo = $1 THEN f.user_hi ELSE f.user_lo END)
           LEFT JOIN user_profiles p ON p.user_id = u.id
           WHERE f.user_lo = $1 OR f.user_hi = $1
           ORDER BY u.username"#,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Les personnes qui doivent voir la présence de `user_id`.
///
/// Ses amis acceptés, plus toute personne partageant une conversation avec elle
/// — un membre de groupe n'est pas forcément un ami, et il voit pourtant son
/// avatar dans la barre des membres.
///
/// Le bloc `status_text` n'est PAS concerné : il reste réservé aux amis et
/// passe par `/friends`. Ici on ne diffuse que le statut brut.
pub async fn presence_audience(pool: &sqlx::PgPool, user_id: Uuid) -> Result<Vec<Uuid>, ApiError> {
    sqlx::query_scalar!(
        r#"SELECT DISTINCT other AS "other!" FROM (
             SELECT (CASE WHEN f.user_lo = $1 THEN f.user_hi ELSE f.user_lo END) AS other
             FROM friendships f
             WHERE (f.user_lo = $1 OR f.user_hi = $1) AND f.state = 'accepted'
             UNION
             SELECT cm2.user_id AS other
             FROM conversation_members cm1
             JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
             WHERE cm1.user_id = $1 AND cm2.user_id <> $1
           ) audience"#,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}
