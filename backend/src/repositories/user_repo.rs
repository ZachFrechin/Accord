//! Users repository. Queries are compile-checked by the `sqlx::query!` macros
//! against the schema (offline data in `.sqlx/`).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

/// A user row. `password_hash` is never serialized to the client (this struct is
/// not `Serialize`; controllers project their own response DTOs).
#[derive(Debug, Clone)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub is_active: bool,
    /// `member` or `admin` (see migration 0020).
    pub role: String,
    /// Set when an administrator suspends the account; `None` = usable.
    pub disabled_at: Option<DateTime<Utc>>,
}

/// Inserts a new, inactive user. Returns [`ApiError::Conflict`] on a unique
/// (username or email) violation — the controller maps that to a response that
/// does not reveal *which* field collided.
pub async fn create(
    pool: &PgPool,
    username: &str,
    email: &str,
    password_hash: &str,
) -> Result<User, ApiError> {
    sqlx::query_as!(
        User,
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) \
         RETURNING id, username, email, password_hash, email_verified_at, is_active, role, disabled_at",
        username,
        email,
        password_hash,
    )
    .fetch_one(pool)
    .await
    .map_err(conflict_or_db)
}

/// Finds a user by username (values are stored lowercased).
pub async fn find_by_username(pool: &PgPool, username: &str) -> Result<Option<User>, ApiError> {
    sqlx::query_as!(
        User,
        "SELECT id, username, email, password_hash, email_verified_at, is_active, role, disabled_at \
         FROM users WHERE username = $1",
        username,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Finds a user by email (values are stored lowercased).
pub async fn find_by_email(pool: &PgPool, email: &str) -> Result<Option<User>, ApiError> {
    sqlx::query_as!(
        User,
        "SELECT id, username, email, password_hash, email_verified_at, is_active, role, disabled_at \
         FROM users WHERE email = $1",
        email,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Finds a user by id.
pub async fn find_by_id(pool: &PgPool, id: Uuid) -> Result<Option<User>, ApiError> {
    sqlx::query_as!(
        User,
        "SELECT id, username, email, password_hash, email_verified_at, is_active, role, disabled_at \
         FROM users WHERE id = $1",
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Marks the email verified and activates the account.
pub async fn mark_email_verified(pool: &PgPool, id: Uuid) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE users SET email_verified_at = now(), is_active = true, updated_at = now() \
         WHERE id = $1",
        id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Replaces the password hash (used by the reset flow).
pub async fn set_password(pool: &PgPool, id: Uuid, password_hash: &str) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
        id,
        password_hash,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Sets the account role (`member` | `admin`). Returns whether a row changed.
pub async fn set_role(pool: &PgPool, id: Uuid, role: &str) -> Result<bool, ApiError> {
    let result = sqlx::query!(
        "UPDATE users SET role = $2, updated_at = now() WHERE id = $1",
        id,
        role,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Renames the account's @username. Uniqueness violation maps to a client-safe
/// Conflict instead of a 500.
pub async fn set_username(pool: &PgPool, id: Uuid, username: &str) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE users SET username = $2, updated_at = now() WHERE id = $1",
        id,
        username,
    )
    .execute(pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            ApiError::Conflict("ce pseudo est déjà utilisé".to_string())
        }
        _ => ApiError::from(e),
    })?;
    Ok(())
}

/// Suspends (or reinstates) an account. Returns whether a row changed.
pub async fn set_disabled(pool: &PgPool, id: Uuid, disabled: bool) -> Result<bool, ApiError> {
    let result = sqlx::query!(
        "UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, \
         updated_at = now() WHERE id = $1",
        id,
        disabled,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Promotes the account with this (lowercased) email to `admin` if it exists and
/// is not one already. Returns the id when a promotion actually happened — used
/// by the boot-time bootstrap so repeated boots log only the first time.
pub async fn promote_admin_by_email(pool: &PgPool, email: &str) -> Result<Option<Uuid>, ApiError> {
    sqlx::query_scalar!(
        "UPDATE users SET role = 'admin', updated_at = now() \
         WHERE email = $1 AND role <> 'admin' RETURNING id",
        email,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Maps a unique-violation to [`ApiError::Conflict`], everything else to the
/// generic database error (masked from the client).
fn conflict_or_db(err: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db) = &err
        && db.is_unique_violation()
    {
        return ApiError::Conflict("account already exists".to_string());
    }
    ApiError::Database(err)
}
