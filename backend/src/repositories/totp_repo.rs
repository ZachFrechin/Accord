//! TOTP enrollment state (one row per user in `user_totp`).
//!
//! The stored `secret_enc` is the AEAD-sealed shared secret; the domain layer
//! (`domain::totp`) seals/opens it. A row with `confirmed_at IS NULL` is a pending
//! enrollment (secret generated, first code not yet proven) and does NOT gate
//! login; only a confirmed row makes a second factor required.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::ApiError;

/// A user's TOTP row.
pub struct TotpRow {
    pub secret_enc: Vec<u8>,
    pub confirmed_at: Option<DateTime<Utc>>,
}

/// Fetch a user's TOTP row (pending or confirmed), if any.
pub async fn get(pool: &sqlx::PgPool, user_id: Uuid) -> Result<Option<TotpRow>, ApiError> {
    let row = sqlx::query_as!(
        TotpRow,
        r#"SELECT secret_enc, confirmed_at FROM user_totp WHERE user_id = $1"#,
        user_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Start (or restart) enrollment: store a fresh sealed secret, PENDING. Re-enrolling
/// overwrites any prior secret and clears confirmation — a half-finished enrollment
/// never locks the account (login still ignores an unconfirmed row).
pub async fn upsert_pending(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    secret_enc: &[u8],
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"INSERT INTO user_totp (user_id, secret_enc, confirmed_at, created_at)
           VALUES ($1, $2, NULL, now())
           ON CONFLICT (user_id)
           DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL, created_at = now()"#,
        user_id,
        secret_enc,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Confirm a pending enrollment. Returns true if a pending row was just confirmed,
/// false if there was no pending row (already confirmed / absent).
pub async fn confirm(pool: &sqlx::PgPool, user_id: Uuid) -> Result<bool, ApiError> {
    let row = sqlx::query_scalar!(
        r#"UPDATE user_totp SET confirmed_at = now()
           WHERE user_id = $1 AND confirmed_at IS NULL
           RETURNING user_id"#,
        user_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Remove TOTP for a user (disable 2FA).
pub async fn delete(pool: &sqlx::PgPool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query!(r#"DELETE FROM user_totp WHERE user_id = $1"#, user_id)
        .execute(pool)
        .await?;
    Ok(())
}
