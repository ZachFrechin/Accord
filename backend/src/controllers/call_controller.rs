//! Voice/video call controller (Phase 4). Mints a LiveKit access token for a
//! conversation member so they can join the conversation's call room. The token
//! is the only authorization the SFU needs; membership is enforced here, and the
//! media itself is E2EE (keys from the MLS group exporter — the SFU stays blind).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::{livekit, xp};
use crate::error::ApiError;
use crate::middleware::{auth::AuthUser, rate_limit};
use crate::realtime::call_state::{self, CALL_TTL_SECS};
use crate::realtime::protocol::ServerEvent;
use crate::repositories::{call_sound_asset_repo, conversation_repo, xp_repo};
use crate::state::AppState;

/// A minted call token's lifetime. LiveKit disconnects a participant when their
/// token expires, so this is effectively the maximum uninterrupted call length —
/// 15 minutes was dropping real calls. Sized to a long call instead. The security
/// cost of a longer-lived token is small: it only grants JOIN to this one
/// conversation's SFU room, and the media is E2EE (MLS-keyed), so a leaked token
/// buys a blind ghost participant, never plaintext.
const TOKEN_TTL_SECS: i64 = 6 * 60 * 60;
const MAX_MEDIA_CIPHERTEXT_CHARS: usize = 88_000;
const MAX_SOUND_CIPHERTEXT_CHARS: usize = 12_000;

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
    if outcome.participants.len() >= 2
        && let Err(e) =
            call_state::stamp_xp_start(&state.redis, conversation_id, &outcome.participants).await
    {
        tracing::warn!(error = %e, "call xp stamp failed");
    }

    Ok(Json(json!({
        "call_id": outcome.call_id,
        "is_new": outcome.is_new,
        "url": state.config.livekit.url,
        "room": room,
        "token": token,
        "participants": outcome.participants,
        "call_media_enabled": state.config.call_media.enabled,
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
            if minutes > 0
                && let Err(e) =
                    xp_repo::award_call_xp(&state.db, caller.user_id, minutes * xp::CALL_XP_PER_MIN)
                        .await
            {
                tracing::warn!(error = %e, "call xp grant failed");
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
            "call_media_enabled": state.config.call_media.enabled,
        }))),
        None => Ok(Json(json!({
            "active": false,
            "participants": [],
            "call_media_enabled": state.config.call_media.enabled,
        }))),
    }
}

fn require_call_media(state: &AppState) -> Result<(), ApiError> {
    if state.config.call_media.enabled {
        Ok(())
    } else {
        Err(ApiError::NotFound("call media is disabled".to_string()))
    }
}

fn media_device(query: &CallTokenQuery) -> Result<&str, ApiError> {
    query
        .device
        .as_deref()
        .filter(|device| !device.is_empty() && device.len() <= 128)
        .ok_or_else(|| ApiError::Validation("device is required".to_string()))
}

async fn require_active_call_device(
    state: &AppState,
    conversation_id: Uuid,
    caller: Uuid,
    device: &str,
    requested_call_id: Option<Uuid>,
) -> Result<call_state::CallState, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    if !call_state::participant_is_live(&state.redis, conversation_id, caller, device).await? {
        return Err(ApiError::Forbidden(
            "this device is not an active call participant".to_string(),
        ));
    }
    let call = call_state::state(&state.redis, conversation_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("no active call".to_string()))?;
    if requested_call_id.is_some_and(|id| id != call.call_id) {
        return Err(ApiError::Conflict("call has changed".to_string()));
    }
    Ok(call)
}

async fn fan_to_call_participants(state: &AppState, participants: &[Uuid], event: &ServerEvent) {
    for user_id in participants {
        let _ = state.realtime.deliver_to_user(*user_id, event).await;
    }
}

#[derive(Debug, Deserialize)]
pub struct MediaPutBody {
    call_id: Uuid,
    expected_revision: u64,
    ciphertext: String,
    nonce: String,
}

#[derive(Debug, Deserialize)]
pub struct SoundTriggerBody {
    call_id: Uuid,
    event_id: Uuid,
    scheduled_at_ms: i64,
    #[serde(default)]
    blob_id: Option<Uuid>,
    ciphertext: String,
    nonce: String,
}

/// Read opaque collaborative-media state, authorized by exact call device.
pub async fn media_get(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
) -> Result<Json<Value>, ApiError> {
    require_call_media(&state)?;
    let device = media_device(&query)?;
    let call =
        require_active_call_device(&state, conversation_id, caller.user_id, device, None).await?;
    let media = call_state::media_state(&state.redis, conversation_id).await?;
    Ok(Json(json!({
        "call_id": call.call_id,
        "state": media,
        "server_now_ms": call_state::now_ms(),
    })))
}

/// Atomic revisioned update. Stale writers receive 409 plus the current opaque
/// state so they can reconcile without trusting another client's plaintext.
pub async fn media_put(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
    Json(body): Json<MediaPutBody>,
) -> Result<Response, ApiError> {
    require_call_media(&state)?;
    let device = media_device(&query)?;
    if body.ciphertext.is_empty()
        || body.ciphertext.len() > MAX_MEDIA_CIPHERTEXT_CHARS
        || body.nonce.is_empty()
        || body.nonce.len() > 64
    {
        return Err(ApiError::Validation(
            "invalid encrypted media payload".to_string(),
        ));
    }
    let call = require_active_call_device(
        &state,
        conversation_id,
        caller.user_id,
        device,
        Some(body.call_id),
    )
    .await?;
    rate_limit::check(
        &state.redis,
        &format!(
            "rl:call-media-state:{}:{}:{}",
            body.call_id, caller.user_id, device
        ),
        60,
        state.config.call_media.state_mutations_per_minute,
    )
    .await?;

    match call_state::compare_and_swap_media(
        &state.redis,
        call_state::MediaCasUpdate {
            conversation_id,
            user_id: caller.user_id,
            device,
            call_id: body.call_id,
            expected_revision: body.expected_revision,
            ciphertext: body.ciphertext,
            nonce: body.nonce,
            ttl_secs: CALL_TTL_SECS,
        },
    )
    .await?
    {
        call_state::MediaCasOutcome::Applied(media) => {
            let event = ServerEvent::CallMediaState {
                conversation_id,
                call_id: media.call_id,
                revision: media.revision,
                ciphertext: media.ciphertext.clone(),
                nonce: media.nonce.clone(),
                updated_at_ms: media.updated_at_ms,
            };
            fan_to_call_participants(&state, &call.participants, &event).await;
            tracing::info!(
                conversation_id = %conversation_id,
                revision = media.revision,
                "call media mutation applied"
            );
            Ok((StatusCode::OK, Json(json!({ "state": media }))).into_response())
        }
        call_state::MediaCasOutcome::Conflict(current) => {
            tracing::info!(conversation_id = %conversation_id, "call media revision conflict");
            Ok((
                StatusCode::CONFLICT,
                Json(json!({ "state": current, "server_now_ms": call_state::now_ms() })),
            )
                .into_response())
        }
        call_state::MediaCasOutcome::NotInCall => Err(ApiError::Forbidden(
            "this device is not an active call participant".to_string(),
        )),
        call_state::MediaCasOutcome::WrongCall => {
            Err(ApiError::Conflict("call has changed".to_string()))
        }
    }
}

/// Broadcast one encrypted scheduled sound trigger to the current call roster.
pub async fn sound_trigger(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<CallTokenQuery>,
    Json(body): Json<SoundTriggerBody>,
) -> Result<Json<Value>, ApiError> {
    require_call_media(&state)?;
    let device = media_device(&query)?;
    if body.ciphertext.is_empty()
        || body.ciphertext.len() > MAX_SOUND_CIPHERTEXT_CHARS
        || body.nonce.is_empty()
        || body.nonce.len() > 64
    {
        return Err(ApiError::Validation(
            "invalid encrypted sound payload".to_string(),
        ));
    }
    let now = call_state::now_ms();
    if body.scheduled_at_ms < now - 2_000 || body.scheduled_at_ms > now + 10_000 {
        return Err(ApiError::Validation("invalid sound schedule".to_string()));
    }
    let call = require_active_call_device(
        &state,
        conversation_id,
        caller.user_id,
        device,
        Some(body.call_id),
    )
    .await?;
    rate_limit::check(
        &state.redis,
        &format!(
            "rl:call-sound:{}:{}:{}",
            body.call_id, caller.user_id, device
        ),
        60,
        state.config.call_media.sound_triggers_per_minute,
    )
    .await?;
    if !call_state::register_media_event(&state.redis, body.call_id, body.event_id, 600).await? {
        return Ok(Json(json!({ "status": "duplicate", "server_now_ms": now })));
    }
    if let Some(blob_id) = body.blob_id
        && !call_sound_asset_repo::touch(&state.db, conversation_id, blob_id).await?
    {
        return Err(ApiError::Forbidden(
            "sound blob is not owned by this conversation".to_string(),
        ));
    }
    let event = ServerEvent::CallSoundTrigger {
        conversation_id,
        call_id: body.call_id,
        event_id: body.event_id,
        scheduled_at_ms: body.scheduled_at_ms,
        blob_id: body.blob_id,
        ciphertext: body.ciphertext,
        nonce: body.nonce,
    };
    fan_to_call_participants(&state, &call.participants, &event).await;
    tracing::info!(conversation_id = %conversation_id, custom = body.blob_id.is_some(), "call sound triggered");
    Ok(Json(json!({ "status": "scheduled", "server_now_ms": now })))
}

const YOUTUBE_BRIDGE_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#player{width:100%;height:100%;min-width:200px;min-height:200px;margin:0;background:#090b10;overflow:hidden}body{position:relative}#enable{position:absolute;inset:auto 50% 18px auto;transform:translateX(50%);z-index:2;max-width:calc(100% - 24px);padding:10px 14px;border:1px solid rgba(255,255,255,.35);border-radius:10px;background:rgba(9,11,16,.92);color:#fff;font:600 13px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}#enable[hidden]{display:none}</style>
</head><body><div id="player"></div><button id="enable" type="button" hidden>Activer la lecture sur cet appareil</button>
<script nonce="__NONCE__" src="https://www.youtube.com/iframe_api"></script>
<script nonce="__NONCE__">
(() => {
  'use strict';
  const channel = new URLSearchParams(location.search).get('channel') || '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(channel)) return;
  let player = null;
  let parentOrigin = null;
  let suppressUntil = 0;
  let observedAt = 0;
  let observedPosition = 0;
  const enable = document.getElementById('enable');
  const send = (type, detail = {}) => {
    if (parentOrigin) parent.postMessage({source:'accord-youtube-bridge', channel, type, ...detail}, parentOrigin);
  };
  const verifyPlayback = () => setTimeout(() => {
    if (!player || player.getPlayerState() === 1) return;
    enable.hidden = false;
    send('AUTOPLAY_BLOCKED');
  }, 900);
  enable.addEventListener('click', () => {
    if (!player) return;
    suppressUntil = Date.now() + 1800;
    enable.hidden = true;
    player.playVideo();
    verifyPlayback();
  });
  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      width: '100%', height: '100%',
      playerVars: {origin: location.origin, playsinline: 1, enablejsapi: 1},
      events: {
        onReady: () => send('READY'),
        onStateChange: (event) => {
          if (event.data === 1) enable.hidden = true;
          send('STATE_CHANGE', {
            state: event.data,
            positionSeconds: Number(player.getCurrentTime()) || 0,
            remotelyApplied: Date.now() < suppressUntil
          });
        },
        onError: (event) => send('ERROR', {code: event.data})
      }
    });
  };
  setInterval(() => {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    const now = Date.now();
    const position = Number(player.getCurrentTime()) || 0;
    const playing = player.getPlayerState() === 1;
    const predicted = observedPosition + (playing && observedAt ? (now - observedAt) / 1000 : 0);
    if (observedAt && now >= suppressUntil && Math.abs(position - predicted) > 1.5) {
      send('USER_SEEK', {positionSeconds: position});
    }
    observedAt = now;
    observedPosition = position;
  }, 500);
  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.source !== 'accord-parent' || data.channel !== channel) return;
    if (parentOrigin && event.origin !== parentOrigin) return;
    parentOrigin ||= event.origin;
    if (data.type === 'HELLO') { send('HELLO_ACK'); return; }
    if (!player) return;
    if (data.type === 'LOAD' && /^[A-Za-z0-9_-]{11}$/.test(data.videoId || '')) {
      const request = {videoId: data.videoId, startSeconds: Math.max(0, Number(data.positionSeconds) || 0)};
      const shouldPlay = data.playing !== false;
      suppressUntil = Date.now() + 1800;
      enable.hidden = true;
      if (shouldPlay) { player.loadVideoById(request); verifyPlayback(); }
      else player.cueVideoById(request);
    } else if (data.type === 'PLAY') {
      suppressUntil = Date.now() + 1800; player.playVideo(); verifyPlayback();
    } else if (data.type === 'PAUSE') { suppressUntil = Date.now() + 1800; enable.hidden = true; player.pauseVideo(); }
    else if (data.type === 'SEEK') { suppressUntil = Date.now() + 1800; player.seekTo(Math.max(0, Number(data.positionSeconds) || 0), true); }
    else if (data.type === 'VOLUME') player.setVolume(Math.max(0, Math.min(100, Number(data.volume) || 0)));
    else if (data.type === 'MUTE') player.mute();
    else if (data.type === 'UNMUTE') player.unMute();
    else if (data.type === 'GET_STATE') send('STATE', {state: player.getPlayerState(), positionSeconds: Number(player.getCurrentTime()) || 0});
  });
})();
</script></body></html>"#;

/// Public instance-origin YouTube IFrame bridge. It carries no authentication or
/// call data and is intentionally isolated from the main Tauri webview.
pub async fn youtube_bridge(State(state): State<AppState>) -> Result<Response, ApiError> {
    require_call_media(&state)?;
    let nonce = Uuid::new_v4().simple().to_string();
    let mut headers = HeaderMap::new();
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{nonce}' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src https://www.youtube.com https://*.youtube.com https://*.googlevideo.com; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors *"
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&csp)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("bridge CSP: {e}")))?,
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "autoplay=(self \"https://www.youtube.com\"), fullscreen=(self \"https://www.youtube.com\")",
        ),
    );
    Ok((
        headers,
        Html(YOUTUBE_BRIDGE_HTML.replace("__NONCE__", &nonce)),
    )
        .into_response())
}

#[cfg(test)]
mod youtube_bridge_tests {
    use super::YOUTUBE_BRIDGE_HTML;

    #[test]
    fn shared_video_load_starts_playback_and_exposes_a_local_recovery_action() {
        assert!(YOUTUBE_BRIDGE_HTML.contains("player.loadVideoById(request)"));
        assert!(YOUTUBE_BRIDGE_HTML.contains("data.playing !== false"));
        assert!(YOUTUBE_BRIDGE_HTML.contains("Activer la lecture sur cet appareil"));
        assert!(!YOUTUBE_BRIDGE_HTML.contains("Authorization"));
    }
}
