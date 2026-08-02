//! Attachment upload/download controller.
//!
//! The backend issues short-lived SigV4 presigned URLs; the client uploads/downloads
//! the (client-encrypted) ciphertext directly against object storage. The server
//! never proxies or sees the bytes — it only records who may fetch a blob and
//! enforces membership + a size ceiling.

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::storage;
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::{attachment_repo, conversation_repo};
use crate::state::AppState;

/// Presigned-URL lifetime.
const URL_EXPIRY_SECS: u64 = 900;

/// Body of `POST /uploads`.
#[derive(Debug, Deserialize)]
pub struct RequestUpload {
    conversation_id: Uuid,
    size_bytes: i64,
}

/// `POST /uploads` — reserve a blob and get a presigned PUT URL. The caller must
/// be a member of the target conversation and stay within the size ceiling.
pub async fn request_upload(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<RequestUpload>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, body.conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    if body.size_bytes <= 0 || body.size_bytes > state.config.storage.max_upload_bytes {
        return Err(ApiError::Validation("invalid attachment size".to_string()));
    }

    let blob_id = Uuid::now_v7();
    attachment_repo::create(
        &state.db,
        blob_id,
        body.conversation_id,
        caller.user_id,
        body.size_bytes,
    )
    .await?;

    let key = storage::attachment_key(&body.conversation_id, &blob_id);
    let upload_url = storage::presign(&state.config.storage, &state.config.storage.bucket, "PUT", &key, URL_EXPIRY_SECS);
    Ok(Json(json!({
        "blob_id": blob_id,
        "upload_url": upload_url,
        "expires_in": URL_EXPIRY_SECS,
    })))
}

/// `GET /uploads/{blob_id}` — a presigned GET URL for a blob, if the caller is a
/// member of the conversation it belongs to.
pub async fn download_url(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(blob_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let conversation_id = attachment_repo::conversation_of(&state.db, blob_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such attachment".to_string()))?;
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }

    let key = storage::attachment_key(&conversation_id, &blob_id);
    let download_url = storage::presign(&state.config.storage, &state.config.storage.bucket, "GET", &key, URL_EXPIRY_SECS);
    Ok(Json(json!({
        "download_url": download_url,
        "expires_in": URL_EXPIRY_SECS,
    })))
}
