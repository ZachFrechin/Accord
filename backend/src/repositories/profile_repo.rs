//! User profiles (1:1 `user_profiles`). Optional customization surfaced alongside
//! the immutable username; absent until the user saves something.

use uuid::Uuid;

use crate::error::ApiError;

pub struct Profile {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub accent_color: Option<String>,
    pub avatar_version: i32,
    pub banner_version: i32,
}

/// A user's profile row, if any.
pub async fn get(pool: &sqlx::PgPool, user_id: Uuid) -> Result<Option<Profile>, ApiError> {
    let row = sqlx::query_as!(
        Profile,
        r#"SELECT display_name, bio, accent_color, avatar_version, banner_version
           FROM user_profiles WHERE user_id = $1"#,
        user_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Replace the editable text fields (display_name / bio / accent_color). Avatar
/// version is left untouched. Values already validated/sanitized by the caller.
pub async fn upsert_fields(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    display_name: Option<&str>,
    bio: Option<&str>,
    accent_color: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"INSERT INTO user_profiles (user_id, display_name, bio, accent_color, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               bio = EXCLUDED.bio,
               accent_color = EXCLUDED.accent_color,
               updated_at = now()"#,
        user_id,
        display_name,
        bio,
        accent_color,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Set ONLY the display name (admin rename) — other profile fields untouched.
pub async fn set_display_name(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    display_name: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"INSERT INTO user_profiles (user_id, display_name, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE
           SET display_name = EXCLUDED.display_name, updated_at = now()"#,
        user_id,
        display_name,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Set the avatar version (after a successful upload commit).
pub async fn set_avatar_version(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    version: i32,
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"INSERT INTO user_profiles (user_id, avatar_version, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE
           SET avatar_version = EXCLUDED.avatar_version, updated_at = now()"#,
        user_id,
        version,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Set the banner version (after a successful upload commit).
pub async fn set_banner_version(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    version: i32,
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"INSERT INTO user_profiles (user_id, banner_version, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE
           SET banner_version = EXCLUDED.banner_version, updated_at = now()"#,
        user_id,
        version,
    )
    .execute(pool)
    .await?;
    Ok(())
}
