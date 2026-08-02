//! Device-key distribution controller (E2EE key exchange).
//!
//! Publishes and serves PUBLIC identity keys only — a private key or message
//! plaintext never reaches the server. It is a blind key directory: a sender
//! fetches the public keys of a friend's devices so the client can encrypt a
//! message key to each of them.

use axum::Json;
use axum::extract::{Path, State};
use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::{conversation_repo, device_key_repo, friend_repo, transparency_repo};
use crate::state::AppState;

/// Byte length of an X25519 public key.
const X25519_PUBLIC_LEN: usize = 32;

/// Body of `POST /keys/devices`.
#[derive(Debug, Deserialize)]
pub struct PublishDeviceKey {
    device_id: String,
    /// Standard base64 of the 32-byte X25519 public key.
    public_key: String,
}

/// `POST /keys/devices` — publish (or replace) the caller's public key for a
/// device. The private half never leaves the device.
pub async fn publish(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<PublishDeviceKey>,
) -> Result<Json<Value>, ApiError> {
    let device_id = body.device_id.trim();
    if device_id.is_empty() || device_id.len() > 128 {
        return Err(ApiError::Validation("invalid device_id".to_string()));
    }
    let public_key = BASE64
        .decode(body.public_key.as_bytes())
        .map_err(|_| ApiError::Validation("public_key must be base64".to_string()))?;
    if public_key.len() != X25519_PUBLIC_LEN {
        return Err(ApiError::Validation(
            "public_key must be a 32-byte X25519 key".to_string(),
        ));
    }
    device_key_repo::publish(&state.db, caller.user_id, device_id, &public_key).await?;
    // Record the binding in the append-only key-transparency log (Phase 3 · Lot 6)
    // so clients can later prove this key was published and detect equivocation.
    transparency_repo::append_binding(&state.db, caller.user_id, device_id, &public_key).await?;
    Ok(Json(json!({ "status": "ok" })))
}

/// `GET /keys/users/{user_id}` — a user's active device-key bundle. Restricted to
/// the user themselves or their accepted friends (group co-membership follows in
/// a later lot).
pub async fn bundle(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if user_id != caller.user_id {
        let (lo, hi) = friend_repo::ordered(caller.user_id, user_id);
        let accepted = friend_repo::get_pair(&state.db, lo, hi)
            .await?
            .is_some_and(|e| e.state == "accepted");
        // A shared conversation (e.g. a group) also authorizes fetching the
        // bundle, so members who are not friends can still encrypt to each other.
        let co_member = accepted
            || conversation_repo::shares_conversation(&state.db, caller.user_id, user_id).await?;
        if !co_member {
            return Err(ApiError::Forbidden("not permitted".to_string()));
        }
    }

    let devices: Vec<Value> = device_key_repo::list_active(&state.db, user_id)
        .await?
        .into_iter()
        .map(|d| {
            json!({
                "device_id": d.device_id,
                "public_key": BASE64.encode(&d.public_key),
                "created_at": d.created_at,
            })
        })
        .collect();
    Ok(Json(json!({ "user_id": user_id, "devices": devices })))
}

/// `DELETE /keys/devices/{device_id}` — revoke one of the caller's devices.
pub async fn revoke(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    device_key_repo::revoke(&state.db, caller.user_id, &device_id).await?;
    Ok(Json(json!({ "status": "revoked" })))
}
