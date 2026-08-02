//! User profiles — read any user's public profile (auth required) and update your
//! own. Profile fields are optional customization surfaced alongside the username;
//! avatars are public (served from the public avatars bucket), unlike E2EE
//! attachments.

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

/// Max avatar object size (bytes) — generous enough for an animated gif.
const AVATAR_MAX_BYTES: i64 = 4 * 1024 * 1024;
/// Max banner object size (bytes) — banners are wider, so a bit larger.
const BANNER_MAX_BYTES: i64 = 8 * 1024 * 1024;
/// Presigned-PUT lifetime for avatar/banner uploads.
const AVATAR_URL_EXPIRY_SECS: u64 = 300;

use crate::domain::{storage, validation};
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::{admin_repo, profile_repo, user_repo};
use crate::state::AppState;

/// A user's public profile.
#[derive(Debug, Serialize)]
pub struct ProfileDto {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub accent_color: Option<String>,
    pub avatar_url: Option<String>,
    pub banner_url: Option<String>,
    /// Instance root admin (crown badge).
    pub is_admin: bool,
    /// Custom instance roles, highest position first (badge chips).
    pub roles: Vec<ProfileRoleDto>,
}

/// A role as shown on a public profile — no permission bits leaked.
#[derive(Debug, Serialize)]
pub struct ProfileRoleDto {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
}

/// `GET /users/{user_id}/profile` — any authenticated user may read any profile.
pub async fn get_profile(
    State(state): State<AppState>,
    _caller: AuthUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<ProfileDto>, ApiError> {
    let user = user_repo::find_by_id(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;
    let profile = profile_repo::get(&state.db, user_id).await?;
    Ok(Json(
        build_dto(&state, user_id, user.username.clone(), &user.role, profile).await?,
    ))
}

/// Body of `PATCH /me/profile`. Each field is fully replaced (empty/omitted clears).
#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub accent_color: Option<String>,
}

/// `PATCH /me/profile` — update the caller's own profile text fields.
pub async fn update_my_profile(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(req): Json<UpdateProfileRequest>,
) -> Result<Json<ProfileDto>, ApiError> {
    let display_name = req
        .display_name
        .as_deref()
        .and_then(|s| validation::validate_display_name(s));
    let bio = req.bio.as_deref().and_then(|s| validation::validate_bio(s));
    let accent_color = match req.accent_color.as_deref() {
        Some(c) => validation::validate_accent_color(c)?,
        None => None,
    };
    profile_repo::upsert_fields(
        &state.db,
        caller.user_id,
        display_name.as_deref(),
        bio.as_deref(),
        accent_color.as_deref(),
    )
    .await?;

    let user = user_repo::find_by_id(&state.db, caller.user_id)
        .await?
        .ok_or_else(|| ApiError::Unauthorized("unknown user".to_string()))?;
    let profile = profile_repo::get(&state.db, caller.user_id).await?;
    Ok(Json(
        build_dto(&state, caller.user_id, user.username.clone(), &user.role, profile).await?,
    ))
}

/// Body of `POST /me/avatar`.
#[derive(Debug, Deserialize)]
pub struct AvatarUploadRequest {
    pub size_bytes: i64,
}

/// `POST /me/avatar` — reserve the next avatar version and return a presigned PUT
/// URL the client uploads the image/gif to directly (public avatars bucket). The
/// version isn't committed until the upload succeeds (see `commit_avatar`).
pub async fn request_avatar_upload(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(req): Json<AvatarUploadRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.size_bytes <= 0 || req.size_bytes > AVATAR_MAX_BYTES {
        return Err(ApiError::Validation(format!(
            "avatar must be between 1 and {AVATAR_MAX_BYTES} bytes"
        )));
    }
    let current = profile_repo::get(&state.db, caller.user_id)
        .await?
        .map(|p| p.avatar_version)
        .unwrap_or(0);
    let version = current + 1;
    let key = storage::avatar_key(&caller.user_id, version);
    let upload_url = storage::presign(
        &state.config.storage,
        &state.config.storage.avatars_bucket,
        "PUT",
        &key,
        AVATAR_URL_EXPIRY_SECS,
    );
    Ok(Json(json!({
        "upload_url": upload_url,
        "version": version,
        "expires_in": AVATAR_URL_EXPIRY_SECS,
    })))
}

/// Body of `POST /me/avatar/commit`.
#[derive(Debug, Deserialize)]
pub struct AvatarCommitRequest {
    pub version: i32,
}

/// `POST /me/avatar/commit` — after a successful upload, point the profile at the
/// new avatar version (bumps the stable public URL so caches invalidate).
pub async fn commit_avatar(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(req): Json<AvatarCommitRequest>,
) -> Result<Json<ProfileDto>, ApiError> {
    if req.version <= 0 {
        return Err(ApiError::Validation("invalid avatar version".to_string()));
    }
    profile_repo::set_avatar_version(&state.db, caller.user_id, req.version).await?;
    self_profile(&state, caller.user_id).await
}

/// `DELETE /me/avatar` — remove the avatar (version → 0, URL becomes null).
pub async fn delete_avatar(
    State(state): State<AppState>,
    caller: AuthUser,
) -> Result<Json<ProfileDto>, ApiError> {
    profile_repo::set_avatar_version(&state.db, caller.user_id, 0).await?;
    self_profile(&state, caller.user_id).await
}

/// `POST /me/banner` — presigned PUT for a new banner version (public bucket).
pub async fn request_banner_upload(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(req): Json<AvatarUploadRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.size_bytes <= 0 || req.size_bytes > BANNER_MAX_BYTES {
        return Err(ApiError::Validation(format!(
            "banner must be between 1 and {BANNER_MAX_BYTES} bytes"
        )));
    }
    let current = profile_repo::get(&state.db, caller.user_id)
        .await?
        .map(|p| p.banner_version)
        .unwrap_or(0);
    let version = current + 1;
    let key = storage::banner_key(&caller.user_id, version);
    let upload_url = storage::presign(
        &state.config.storage,
        &state.config.storage.avatars_bucket,
        "PUT",
        &key,
        AVATAR_URL_EXPIRY_SECS,
    );
    Ok(Json(json!({
        "upload_url": upload_url,
        "version": version,
        "expires_in": AVATAR_URL_EXPIRY_SECS,
    })))
}

/// `POST /me/banner/commit` — point the profile at the just-uploaded banner version.
pub async fn commit_banner(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(req): Json<AvatarCommitRequest>,
) -> Result<Json<ProfileDto>, ApiError> {
    if req.version <= 0 {
        return Err(ApiError::Validation("invalid banner version".to_string()));
    }
    profile_repo::set_banner_version(&state.db, caller.user_id, req.version).await?;
    self_profile(&state, caller.user_id).await
}

/// `DELETE /me/banner` — remove the banner.
pub async fn delete_banner(
    State(state): State<AppState>,
    caller: AuthUser,
) -> Result<Json<ProfileDto>, ApiError> {
    profile_repo::set_banner_version(&state.db, caller.user_id, 0).await?;
    self_profile(&state, caller.user_id).await
}

/// Fetch + build the caller's own profile DTO.
async fn self_profile(state: &AppState, user_id: Uuid) -> Result<Json<ProfileDto>, ApiError> {
    let user = user_repo::find_by_id(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::Unauthorized("unknown user".to_string()))?;
    let profile = profile_repo::get(&state.db, user_id).await?;
    Ok(Json(
        build_dto(state, user_id, user.username.clone(), &user.role, profile).await?,
    ))
}

async fn build_dto(
    state: &AppState,
    user_id: Uuid,
    username: String,
    account_role: &str,
    profile: Option<profile_repo::Profile>,
) -> Result<ProfileDto, ApiError> {
    let avatar_v = profile.as_ref().map(|p| p.avatar_version).unwrap_or(0);
    let banner_v = profile.as_ref().map(|p| p.banner_version).unwrap_or(0);
    let roles = admin_repo::roles_of_user(&state.db, user_id)
        .await?
        .into_iter()
        .map(|r| ProfileRoleDto {
            id: r.id,
            name: r.name,
            color: r.color,
        })
        .collect();
    Ok(ProfileDto {
        user_id,
        username,
        display_name: profile.as_ref().and_then(|p| p.display_name.clone()),
        bio: profile.as_ref().and_then(|p| p.bio.clone()),
        accent_color: profile.as_ref().and_then(|p| p.accent_color.clone()),
        avatar_url: storage::avatar_public_url(&state.config.storage, &user_id, avatar_v),
        banner_url: storage::banner_public_url(&state.config.storage, &user_id, banner_v),
        is_admin: account_role == "admin",
        roles,
    })
}
