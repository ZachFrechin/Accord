//! Voice/video call controller (Phase 4). Mints a LiveKit access token for a
//! conversation member so they can join the conversation's call room. The token
//! is the only authorization the SFU needs; membership is enforced here, and the
//! media itself is E2EE (keys from the MLS group exporter — the SFU stays blind).

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::{livekit, xp};
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::realtime::call_state::{self, CALL_TTL_SECS};
use crate::realtime::protocol::ServerEvent;
use crate::repositories::{conversation_repo, xp_repo};
use crate::state::AppState;

/// A minted call token's lifetime. LiveKit disconnects a participant when their
/// token expires, so this is effectively the maximum uninterrupted call length —
/// 15 minutes was dropping real calls. Sized to a long call instead. The security
/// cost of a longer-lived token is small: it only grants JOIN to this one
/// conversation's SFU room, and the media is E2EE (MLS-keyed), so a leaked token
/// buys a blind ghost participant, never plaintext.
const TOKEN_TTL_SECS: i64 = 6 * 60 * 60;

/// The LiveKit participant identity for a (user, device): one per device so the
/// same user on two devices doesn't self-evict from the SFU room.
fn identity_for(user_id: Uuid, device: Option<&str>) -> String {
    match device.filter(|d| !d.is_empty()) {
        Some(device) => format!("{user_id}:{device}"),
        None => user_id.to_string(),
    }
}

/// The deterministic LiveKit room name for a conversation (one room per conversation).
fn room_for(conversation_id: Uuid) -> String {
    format!("conv-{conversation_id}")
}

/// Mints a LiveKit access token for `identity` to join `room`.
fn mint(state: &AppState, identity: &str, room: &str) -> Result<String, ApiError> {
    let cfg = &state.config.livekit;
    livekit::mint_livekit_token(
        &cfg.api_key,
        &cfg.api_secret,
        identity,
        room,
        TOKEN_TTL_SECS,
        Utc::now().timestamp(),
    )
}

/// Query for `POST /conversations/{id}/call/token`.
#[derive(Debug, Deserialize)]
pub struct CallTokenQuery {
    /// Optional device/instance id: the same user on two devices needs distinct
    /// LiveKit identities (the SFU allows one connection per identity per room).
    #[serde(default)]
    device: Option<String>,
}

/// `POST /conversations/{id}/call/token` — a LiveKit access token that lets the
/// caller (a member) join this conversation's call room.
pub async fn mint_token(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden(
            "not a member of this conversation".to_string(),
        ));
    }

    let identity = identity_for(caller.user_id, query.device.as_deref());
    let room = room_for(conversation_id);
    let token = mint(&state, &identity, &room)?;

    // A token refresh also keeps the caller's call-roster entry alive (best-effort;
    // the dedicated heartbeat is the primary liveness signal).
    let _ = call_state::heartbeat(
        &state.redis,
        conversation_id,
        caller.user_id,
        query.device.as_deref(),
        CALL_TTL_SECS,
    )
    .await;

    Ok(Json(
        json!({ "url": state.config.livekit.url, "room": room, "token": token }),
    ))
}

/// Delivers a call signal to every OTHER member (best-effort fan-out).
async fn fan_to_others(state: &AppState, conversation_id: Uuid, caller: Uuid, event: ServerEvent) {
    let members = conversation_repo::member_ids(&state.db, conversation_id)
        .await
        .unwrap_or_default();
    for member in members {
        if member != caller {
            let _ = state.realtime.deliver_to_user(member, &event).await;
        }
    }
}

/// Body of `POST /conversations/{id}/call/ring`.
#[derive(Debug, Deserialize)]
pub struct RingBody {
    #[serde(default = "default_media")]
    media: String,
}
fn default_media() -> String {
    "audio".to_string()
}

/// `POST /conversations/{id}/call/ring` — announce a new call to the other
/// members (they ring). Returns the server-issued `call_id` correlating this call.
pub async fn ring(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<RingBody>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let media = if body.media == "video" {
        "video"
    } else {
        "audio"
    };
    let call_id = Uuid::now_v7();
    fan_to_others(
        &state,
        conversation_id,
        caller.user_id,
        ServerEvent::CallRing {
            conversation_id,
            from: caller.user_id,
            call_id,
            media: media.to_string(),
        },
    )
    .await;
    Ok(Json(json!({ "call_id": call_id })))
}

/// Body of `POST /conversations/{id}/call/end`.
#[derive(Debug, Deserialize)]
pub struct EndBody {
    call_id: Uuid,
}

/// `POST /conversations/{id}/call/end` — signal the call ended / was declined so a
/// still-ringing prompt on the other members dismisses.
pub async fn end(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<EndBody>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    fan_to_others(
        &state,
        conversation_id,
        caller.user_id,
        ServerEvent::CallEnd {
            conversation_id,
            call_id: body.call_id,
        },
    )
    .await;
    Ok(Json(json!({ "status": "ended" })))
}

/// Body of `POST /conversations/{id}/call/join`.
#[derive(Debug, Deserialize)]
pub struct JoinBody {
    #[serde(default = "default_media")]
    media: String,
}

/// `POST /conversations/{id}/call/join` — join (or start) the conversation's call.
/// Records the caller in the server-authoritative roster, mints a LiveKit token,
/// and notifies the other members: the first joiner rings everyone (CALL_RING);
/// every joiner emits CALL_PARTICIPANT_JOINED so peers can show a live roster.
pub async fn join(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
    Json(body): Json<JoinBody>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let media = if body.media == "video" {
        "video"
    } else {
        "audio"
    };
    let device = query.device.as_deref();

    let outcome = call_state::join(
        &state.redis,
        conversation_id,
        caller.user_id,
        device,
        CALL_TTL_SECS,
    )
    .await?;

    let identity = identity_for(caller.user_id, device);
    let room = room_for(conversation_id);
    let token = mint(&state, &identity, &room)?;

    // The first participant rings the others; every join announces the new roster.
    if outcome.is_new {
        fan_to_others(
            &state,
            conversation_id,
            caller.user_id,
            ServerEvent::CallRing {
                conversation_id,
                from: caller.user_id,
                call_id: outcome.call_id,
                media: media.to_string(),
            },
        )
        .await;
    }
    fan_to_others(
        &state,
        conversation_id,
        caller.user_id,
        ServerEvent::CallParticipantJoined {
            conversation_id,
            call_id: outcome.call_id,
            user_id: caller.user_id,
        },
    )
    .await;

    // Leveling: once the room has company, everyone present starts (or keeps)
    // their "in a call" clock. Solo waiting earns nothing.
    if outcome.participants.len() >= 2 {
        if let Err(e) =
            call_state::stamp_xp_start(&state.redis, conversation_id, &outcome.participants).await
        {
            tracing::warn!(error = %e, "call xp stamp failed");
        }
    }

    Ok(Json(json!({
        "call_id": outcome.call_id,
        "is_new": outcome.is_new,
        "url": state.config.livekit.url,
        "room": room,
        "token": token,
        "participants": outcome.participants,
    })))
}

/// `POST /conversations/{id}/call/leave` — leave the conversation's call. Emits
/// CALL_PARTICIPANT_LEFT while others remain, or CALL_END when the last one leaves.
pub async fn leave(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let outcome = call_state::leave(
        &state.redis,
        conversation_id,
        caller.user_id,
        query.device.as_deref(),
    )
    .await?;

    if let Some(call_id) = outcome.call_id {
        if outcome.ended {
            fan_to_others(
                &state,
                conversation_id,
                caller.user_id,
                ServerEvent::CallEnd {
                    conversation_id,
                    call_id,
                },
            )
            .await;
        } else if !outcome.participants.contains(&caller.user_id) {
            // Only announce the departure when the USER is fully gone — closing
            // one device (a pop-out viewer, a second machine) while another stays
            // must not flicker them out of the roster.
            fan_to_others(
                &state,
                conversation_id,
                caller.user_id,
                ServerEvent::CallParticipantLeft {
                    conversation_id,
                    call_id,
                    user_id: caller.user_id,
                },
            )
            .await;
        }
    }

    // Leveling: settle this user's accompanied-call time (whole minutes).
    match call_state::take_xp_start(&state.redis, conversation_id, caller.user_id).await {
        Ok(Some(started_ms)) => {
            let minutes = (Utc::now().timestamp_millis() - started_ms).max(0) / 60_000;
            if minutes > 0 {
                if let Err(e) =
                    xp_repo::award_call_xp(&state.db, caller.user_id, minutes * xp::CALL_XP_PER_MIN)
                        .await
                {
                    tracing::warn!(error = %e, "call xp grant failed");
                }
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = %e, "call xp settle failed"),
    }

    Ok(Json(json!({
        "ended": outcome.ended,
        "participants": outcome.participants,
    })))
}

/// `POST /conversations/{id}/call/heartbeat` — refresh the caller's call-roster
/// liveness while they are in the call (a no-op if they aren't a participant).
pub async fn heartbeat(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    call_state::heartbeat(
        &state.redis,
        conversation_id,
        caller.user_id,
        query.device.as_deref(),
        CALL_TTL_SECS,
    )
    .await?;
    Ok(Json(json!({ "status": "ok" })))
}

/// `GET /conversations/{id}/call` — the conversation's live call, so a client can
/// discover an in-progress call, show its roster, and offer to join.
pub async fn call_state_get(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    match call_state::state(&state.redis, conversation_id).await? {
        Some(cs) => Ok(Json(json!({
            "active": true,
            "call_id": cs.call_id,
            "participants": cs.participants,
        }))),
        None => Ok(Json(json!({ "active": false, "participants": [] }))),
    }
}
