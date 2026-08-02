//! MLS KeyPackage directory controller (Phase 3 · Lot 2).
//!
//! A blind directory of PUBLIC KeyPackages: a device publishes a pool of
//! single-use packages (+ one last-resort), and a member adding that device to a
//! group CLAIMS one — enabling offline adds. The server never sees a private key
//! or any group secret. Claiming another user's packages is gated exactly like
//! the legacy key bundle (friend or shared conversation).

use axum::Json;
use axum::extract::{Path, State};
use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::{conversation_repo, friend_repo, mls_key_package_repo};
use crate::state::AppState;

const MAX_DEVICE_ID: usize = 128;
const MAX_POOL: usize = 200;
const MAX_KP_REF: usize = 128;
const MAX_KP_DATA: usize = 16 * 1024;
const MAX_CLAIM_DEVICES: usize = 64;

/// One published KeyPackage: its hash ref + the opaque public bytes, base64.
#[derive(Debug, Deserialize)]
pub struct KeyPackageDto {
    kp_ref: String,
    key_package: String,
}

fn decode_kp(dto: &KeyPackageDto) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let kp_ref = BASE64
        .decode(dto.kp_ref.as_bytes())
        .map_err(|_| ApiError::Validation("kp_ref must be base64".to_string()))?;
    let data = BASE64
        .decode(dto.key_package.as_bytes())
        .map_err(|_| ApiError::Validation("key_package must be base64".to_string()))?;
    if kp_ref.is_empty() || kp_ref.len() > MAX_KP_REF {
        return Err(ApiError::Validation("invalid kp_ref length".to_string()));
    }
    if data.is_empty() || data.len() > MAX_KP_DATA {
        return Err(ApiError::Validation("invalid key_package length".to_string()));
    }
    Ok((kp_ref, data))
}

fn check_device_id(device_id: &str) -> Result<(), ApiError> {
    if device_id.is_empty() || device_id.len() > MAX_DEVICE_ID {
        return Err(ApiError::Validation("invalid device_id".to_string()));
    }
    Ok(())
}

/// Body of `POST /mls/key-packages`.
#[derive(Debug, Deserialize)]
pub struct PublishBody {
    device_id: String,
    #[serde(default)]
    packages: Vec<KeyPackageDto>,
    #[serde(default)]
    last_resort: Option<KeyPackageDto>,
}

/// `POST /mls/key-packages` — publish (append) the caller's device's KeyPackage
/// pool and/or replace its last-resort package.
pub async fn publish(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<PublishBody>,
) -> Result<Json<Value>, ApiError> {
    let device_id = body.device_id.trim();
    check_device_id(device_id)?;
    if body.packages.len() > MAX_POOL {
        return Err(ApiError::Validation("too many key packages".to_string()));
    }

    if !body.packages.is_empty() {
        let mut refs = Vec::with_capacity(body.packages.len());
        let mut datas = Vec::with_capacity(body.packages.len());
        for dto in &body.packages {
            let (r, d) = decode_kp(dto)?;
            refs.push(r);
            datas.push(d);
        }
        mls_key_package_repo::publish_pool(&state.db, caller.user_id, device_id, &refs, &datas)
            .await?;
    }

    if let Some(dto) = &body.last_resort {
        let (r, d) = decode_kp(dto)?;
        mls_key_package_repo::set_last_resort(&state.db, caller.user_id, device_id, &r, &d).await?;
    }

    let remaining = mls_key_package_repo::count_available(&state.db, caller.user_id, device_id).await?;
    Ok(Json(json!({ "status": "ok", "available": remaining })))
}

/// Body of `POST /mls/key-packages/claim`.
#[derive(Debug, Deserialize)]
pub struct ClaimBody {
    user_id: Uuid,
    device_ids: Vec<String>,
}

/// `POST /mls/key-packages/claim` — claim one KeyPackage per requested device of
/// `user_id`, to add them to a group. Single-use is enforced atomically. Devices
/// with no published package are omitted from the response.
pub async fn claim(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<ClaimBody>,
) -> Result<Json<Value>, ApiError> {
    if body.device_ids.is_empty() || body.device_ids.len() > MAX_CLAIM_DEVICES {
        return Err(ApiError::Validation("invalid device_ids".to_string()));
    }
    // Authorization: same gate as the key bundle — self, an accepted friend, or a
    // co-member of a shared conversation.
    if body.user_id != caller.user_id {
        let (lo, hi) = friend_repo::ordered(caller.user_id, body.user_id);
        let accepted = friend_repo::get_pair(&state.db, lo, hi)
            .await?
            .is_some_and(|e| e.state == "accepted");
        let allowed = accepted
            || conversation_repo::shares_conversation(&state.db, caller.user_id, body.user_id)
                .await?;
        if !allowed {
            return Err(ApiError::Forbidden("not permitted".to_string()));
        }
    }

    let mut packages = Vec::new();
    for device_id in &body.device_ids {
        check_device_id(device_id)?;
        if let Some(claimed) =
            mls_key_package_repo::claim(&state.db, body.user_id, device_id).await?
        {
            packages.push(json!({
                "device_id": device_id,
                "key_package": BASE64.encode(&claimed.kp_data),
                "last_resort": claimed.last_resort,
            }));
        }
    }
    Ok(Json(json!({ "user_id": body.user_id, "packages": packages })))
}

/// `GET /mls/key-packages/count/{device_id}` — the caller's remaining available
/// single-use KeyPackages for a device (drives client-side replenishment).
pub async fn count(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    check_device_id(&device_id)?;
    let available = mls_key_package_repo::count_available(&state.db, caller.user_id, &device_id).await?;
    Ok(Json(json!({ "device_id": device_id, "available": available })))
}
