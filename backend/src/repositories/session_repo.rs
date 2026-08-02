//! Sessions & refresh tokens repository. Queries are compile-checked by the
//! `sqlx::query!` family against the schema (offline data in `.sqlx/`).
//!
//! A session is one authenticated (user, device). Refresh tokens are chained
//! under it: [`rotate_refresh`] consumes the presented token and issues its
//! successor atomically, and reports a *reuse* of an already-consumed token so
//! the caller can revoke the whole session family (RFC 9700).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

/// A session row (safe to expose: no secrets).
#[derive(Debug, Clone)]
pub struct Session {
    pub id: Uuid,
    // Selected for completeness but not surfaced in the self-session list.
    #[allow(dead_code)]
    pub user_id: Uuid,
    pub device_label: Option<String>,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    #[allow(dead_code)]
    pub absolute_expiry: DateTime<Utc>,
}

/// Outcome of presenting a refresh token to [`rotate_refresh`].
pub enum RefreshOutcome {
    /// No such token, or its session is revoked/expired.
    NotFound,
    /// The token was already consumed (or lost a rotation race) — a reuse signal.
    Reuse { session_id: Uuid },
    /// Rotated successfully; the successor token was issued.
    Rotated { session_id: Uuid, user_id: Uuid },
}

/// Creates a session and returns it.
pub async fn create_session(
    pool: &PgPool,
    user_id: Uuid,
    device_label: Option<&str>,
    user_agent: Option<&str>,
    ip: Option<&str>,
    absolute_expiry: DateTime<Utc>,
) -> Result<Session, ApiError> {
    sqlx::query_as!(
        Session,
        "INSERT INTO sessions (user_id, device_label, user_agent, ip, absolute_expiry) \
         VALUES ($1, $2, $3, $4, $5) \
         RETURNING id, user_id, device_label, user_agent, ip, created_at, last_used_at, absolute_expiry",
        user_id,
        device_label,
        user_agent,
        ip,
        absolute_expiry,
    )
    .fetch_one(pool)
    .await
    .map_err(ApiError::from)
}

/// Issues a refresh token (its SHA-256 digest) under a session.
pub async fn issue_refresh(
    pool: &PgPool,
    session_id: Uuid,
    token_hash: &[u8],
    expires_at: DateTime<Utc>,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        session_id,
        token_hash,
        expires_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomically rotates a refresh token: consumes the presented digest and issues
/// its successor, all in one transaction. Detects reuse of a consumed token.
pub async fn rotate_refresh(
    pool: &PgPool,
    old_hash: &[u8],
    new_hash: &[u8],
    new_expires: DateTime<Utc>,
) -> Result<RefreshOutcome, ApiError> {
    // Look up the presented token joined to its (live) session. The `!` overrides
    // assert non-null for columns that are NOT NULL in the schema (an inner join
    // preserves that, but sqlx infers join columns conservatively).
    let row = sqlx::query!(
        r#"SELECT rt.id AS "id!", rt.session_id AS "session_id!", rt.used_at,
                  s.user_id AS "user_id!"
           FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
           WHERE rt.token_hash = $1 AND rt.expires_at > now()
             AND s.revoked_at IS NULL AND s.absolute_expiry > now()"#,
        old_hash,
    )
    .fetch_optional(pool)
    .await?;

    let row = match row {
        None => return Ok(RefreshOutcome::NotFound),
        Some(r) => r,
    };
    let (old_id, session_id, user_id) = (row.id, row.session_id, row.user_id);
    if row.used_at.is_some() {
        return Ok(RefreshOutcome::Reuse { session_id });
    }

    // Insert the successor, then atomically consume the old one. If the consume
    // touches zero rows, another request rotated it first — treat as reuse and
    // roll back so no orphan successor lingers.
    let mut tx = pool.begin().await?;
    let new_id = sqlx::query_scalar!(
        "INSERT INTO refresh_tokens (session_id, token_hash, expires_at) \
         VALUES ($1, $2, $3) RETURNING id",
        session_id,
        new_hash,
        new_expires,
    )
    .fetch_one(&mut *tx)
    .await?;

    let consumed = sqlx::query_scalar!(
        "UPDATE refresh_tokens SET used_at = now(), replaced_by = $2 \
         WHERE id = $1 AND used_at IS NULL RETURNING id",
        old_id,
        new_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    if consumed.is_none() {
        tx.rollback().await?;
        return Ok(RefreshOutcome::Reuse { session_id });
    }

    sqlx::query!(
        "UPDATE sessions SET last_used_at = now() WHERE id = $1",
        session_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(RefreshOutcome::Rotated {
        session_id,
        user_id,
    })
}

/// Revokes a whole session and burns its refresh tokens (reuse response, logout).
pub async fn revoke_session(pool: &PgPool, session_id: Uuid) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        session_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE refresh_tokens SET used_at = now() WHERE session_id = $1 AND used_at IS NULL",
        session_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Revokes a single session owned by `user_id`. Returns whether a row matched.
pub async fn revoke_owned(
    pool: &PgPool,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<bool, ApiError> {
    let affected = sqlx::query!(
        "UPDATE sessions SET revoked_at = now() \
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        session_id,
        user_id,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected > 0)
}

/// Revokes every active session of a user (e.g. after a password reset). Returns
/// the ids revoked so the caller can flip their Redis revocation flags.
pub async fn revoke_all_for_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<Uuid>, ApiError> {
    let ids = sqlx::query_scalar!(
        "UPDATE sessions SET revoked_at = now() \
         WHERE user_id = $1 AND revoked_at IS NULL RETURNING id",
        user_id,
    )
    .fetch_all(pool)
    .await?;
    sqlx::query!(
        "UPDATE refresh_tokens rt SET used_at = now() FROM sessions s \
         WHERE rt.session_id = s.id AND s.user_id = $1 AND rt.used_at IS NULL",
        user_id,
    )
    .execute(pool)
    .await?;
    Ok(ids)
}

/// Lists a user's active (non-revoked, non-expired) sessions, most-recent first.
pub async fn list_active(pool: &PgPool, user_id: Uuid) -> Result<Vec<Session>, ApiError> {
    sqlx::query_as!(
        Session,
        "SELECT id, user_id, device_label, user_agent, ip, created_at, last_used_at, absolute_expiry \
         FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expiry > now() \
         ORDER BY last_used_at DESC",
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}
