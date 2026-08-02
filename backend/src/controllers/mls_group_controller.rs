//! MLS Delivery-Service controller (Phase 3 · Lot 3).
//!
//! The server orders handshake messages and relays opaque frames — it never reads
//! plaintext or holds a group secret. A Commit is accepted only if it targets the
//! current epoch (atomic CAS); a stale one gets 409 → the client resyncs, rebases,
//! and retries. Membership (routing/authorization) reuses `conversation_members`.

use axum::Json;
use axum::extract::{Path, Query, State};
use data_encoding::BASE64;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::realtime::protocol::ServerEvent;
use crate::repositories::{conversation_repo, mls_group_repo};
use crate::state::AppState;

const MAX_FRAME: usize = 256 * 1024;
const MAX_WELCOMES: usize = 512;
const MAX_DEVICE_ID: usize = 128;

fn decode_frame(b64: &str, what: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = BASE64
        .decode(b64.as_bytes())
        .map_err(|_| ApiError::Validation(format!("{what} must be base64")))?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(ApiError::Validation(format!("invalid {what} length")));
    }
    Ok(bytes)
}

async fn require_member(
    state: &AppState,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    Ok(())
}

async fn fanout(state: &AppState, group_id: Uuid, epoch: i64, order_seq: i64) {
    let event = ServerEvent::MlsFrame {
        conversation_id: group_id,
        epoch: epoch.max(0) as u64,
        order_seq: order_seq.max(0) as u64,
    };
    let members = conversation_repo::member_ids(&state.db, group_id)
        .await
        .unwrap_or_default();
    for member in members {
        if let Err(err) = state.realtime.deliver_to_user(member, &event).await {
            tracing::warn!(%member, error = %err, "mls frame fan-out failed");
        }
    }
}

/// `POST /mls/groups/{group_id}` — create the ordering row for a group
/// (idempotent), and ARBITRATE creation: exactly one caller ever gets
/// `created: true`. Only that device may build the root MLS group locally;
/// any other device must join via a Welcome — this is what prevents two
/// devices from forking two different groups under the same conversation id.
pub async fn create(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(group_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_member(&state, group_id, caller.user_id).await?;
    let status = mls_group_repo::ensure_group(&state.db, group_id).await?;
    Ok(Json(json!({
        "status": "ok",
        "created": status.created,
        "current_epoch": status.current_epoch,
        "order_seq": status.order_seq,
    })))
}

#[derive(Debug, Deserialize)]
pub struct WelcomeDto {
    user_id: Uuid,
    device_id: String,
    welcome: String,
}

#[derive(Debug, Deserialize)]
pub struct CommitBody {
    epoch: i64,
    frame: String,
    #[serde(default)]
    welcomes: Vec<WelcomeDto>,
}

/// `POST /mls/groups/{group_id}/commit` — submit a Commit (CAS on the epoch) plus
/// any Welcomes for newly added devices. `409` if the epoch moved under us.
pub async fn commit(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(group_id): Path<Uuid>,
    Json(body): Json<CommitBody>,
) -> Result<Json<Value>, ApiError> {
    require_member(&state, group_id, caller.user_id).await?;
    if body.welcomes.len() > MAX_WELCOMES {
        return Err(ApiError::Validation("too many welcomes".to_string()));
    }
    let frame = decode_frame(&body.frame, "frame")?;

    let outcome =
        mls_group_repo::submit_commit(&state.db, group_id, body.epoch, caller.user_id, &frame)
            .await?;
    let Some(order_seq) = outcome else {
        // Carry the authoritative epoch so a stuck client can see it is not
        // merely racing but diverged (its epoch never catches up).
        let server_epoch = mls_group_repo::current_epoch(&state.db, group_id)
            .await?
            .unwrap_or(0);
        return Err(ApiError::Conflict(format!(
            "epoch already advanced; resync and retry (server epoch {server_epoch})"
        )));
    };

    for w in &body.welcomes {
        if w.device_id.is_empty() || w.device_id.len() > MAX_DEVICE_ID {
            return Err(ApiError::Validation(
                "invalid welcome device_id".to_string(),
            ));
        }
        let welcome = decode_frame(&w.welcome, "welcome")?;
        mls_group_repo::store_welcome(&state.db, group_id, w.user_id, &w.device_id, &welcome)
            .await?;
    }

    fanout(&state, group_id, body.epoch, order_seq).await;
    Ok(Json(json!({ "order_seq": order_seq })))
}

#[derive(Debug, Deserialize)]
pub struct FrameBody {
    content_type: String,
    frame: String,
    /// The sender's group epoch (newer clients). When present, a frame lagging
    /// more than the tolerated window behind the group is rejected with 409 —
    /// this is how a split-brain sender finds out instead of "succeeding" into
    /// a log nobody can decrypt.
    #[serde(default)]
    epoch: Option<i64>,
}

/// `POST /mls/groups/{group_id}/frames` — append a proposal or application frame
/// (does not advance the epoch).
pub async fn frame(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(group_id): Path<Uuid>,
    Json(body): Json<FrameBody>,
) -> Result<Json<Value>, ApiError> {
    if body.content_type != "proposal" && body.content_type != "application" {
        return Err(ApiError::Validation("invalid content_type".to_string()));
    }
    require_member(&state, group_id, caller.user_id).await?;
    let frame = decode_frame(&body.frame, "frame")?;

    let outcome = mls_group_repo::submit_frame(
        &state.db,
        group_id,
        &body.content_type,
        caller.user_id,
        &frame,
        body.epoch,
    )
    .await?;
    let order_seq = match outcome {
        mls_group_repo::SubmitFrameOutcome::Accepted { order_seq } => order_seq,
        mls_group_repo::SubmitFrameOutcome::StaleEpoch { current_epoch } => {
            return Err(ApiError::Conflict(format!(
                "frame epoch too far behind the group (server epoch {current_epoch}); resync"
            )));
        }
        mls_group_repo::SubmitFrameOutcome::NoGroup => {
            return Err(ApiError::NotFound("group not initialized".to_string()));
        }
    };

    // Leveling: only ACCEPTED application frames count (a proposal/commit is
    // protocol machinery, not someone talking). The 60s cooldown inside also
    // keeps op frames (reactions, edits) from farming XP.
    if body.content_type == "application"
        && let Err(e) =
            crate::repositories::xp_repo::award_message_xp(&state.db, caller.user_id).await
    {
        tracing::warn!(error = %e, "mls xp grant failed");
    }

    fanout(&state, group_id, -1, order_seq).await;
    Ok(Json(json!({ "order_seq": order_seq })))
}

#[derive(Debug, Deserialize)]
pub struct FramesQuery {
    #[serde(default)]
    after: i64,
}

/// `GET /mls/groups/{group_id}/frames?after=N` — ordered frames after a cursor,
/// for replay on reconnect (every device applies commits in identical order).
pub async fn frames(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(group_id): Path<Uuid>,
    Query(q): Query<FramesQuery>,
) -> Result<Json<Value>, ApiError> {
    require_member(&state, group_id, caller.user_id).await?;
    let frames: Vec<Value> = mls_group_repo::frames_since(&state.db, group_id, q.after)
        .await?
        .into_iter()
        .map(|f| {
            json!({
                "order_seq": f.order_seq,
                "epoch": f.epoch,
                "content_type": f.content_type,
                "sender_id": f.sender_id,
                "frame": BASE64.encode(&f.frame_data),
            })
        })
        .collect();
    Ok(Json(json!({ "frames": frames })))
}

#[derive(Debug, Deserialize)]
pub struct WelcomesQuery {
    device_id: String,
    /// Newer clients pass `ack=true`: welcomes are then NOT consumed by the
    /// fetch — they stay pending until the device explicitly acks each one
    /// after attempting the join (at-least-once, survives a crash in between).
    #[serde(default)]
    ack: bool,
}

/// `GET /mls/welcomes?device_id=X[&ack=true]` — the caller device's pending
/// Welcomes. Legacy behavior (no `ack`): each is marked delivered on fetch.
pub async fn welcomes(
    State(state): State<AppState>,
    caller: AuthUser,
    Query(q): Query<WelcomesQuery>,
) -> Result<Json<Value>, ApiError> {
    if q.device_id.is_empty() || q.device_id.len() > MAX_DEVICE_ID {
        return Err(ApiError::Validation("invalid device_id".to_string()));
    }
    let pending = mls_group_repo::pending_welcomes(&state.db, caller.user_id, &q.device_id).await?;
    let mut welcomes = Vec::with_capacity(pending.len());
    for w in pending {
        welcomes.push(json!({
            "id": w.id,
            "group_id": w.group_id,
            "welcome": BASE64.encode(&w.welcome_data),
        }));
        if !q.ack {
            mls_group_repo::mark_welcome_delivered(&state.db, w.id).await?;
        }
    }
    Ok(Json(json!({ "welcomes": welcomes })))
}

/// `POST /mls/welcomes/{id}/ack` — the device confirms it attempted the join for
/// this Welcome (success or deterministic failure); it stops being replayed.
pub async fn ack_welcome(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if !mls_group_repo::ack_welcome(&state.db, id, caller.user_id).await? {
        return Err(ApiError::NotFound("welcome not found".to_string()));
    }
    Ok(Json(json!({ "status": "ok" })))
}
