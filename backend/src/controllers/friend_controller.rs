//! Friendships controller — the social-graph state machine.
//!
//! Pairs are canonicalised (`lo < hi`) in the repository; here we own the
//! transitions (pending → accepted / declined / blocked) and fan out realtime
//! events to both parties. Responses are uniform where needed so a caller cannot
//! probe whether an account exists or whether they have been blocked.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::storage;
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::realtime::presence;
use crate::realtime::protocol::ServerEvent;
use crate::repositories::{friend_repo, user_repo};
use crate::state::AppState;

/// Body of `POST /friends/requests`.
#[derive(Debug, Deserialize)]
pub struct AddFriendRequest {
    username: String,
}

/// Best-effort realtime notification: a delivery failure never fails the request
/// (state is persisted; clients re-sync via `GET /friends` on reconnect).
async fn notify(state: &AppState, to: Uuid, event: ServerEvent) {
    if let Err(err) = state.realtime.deliver_to_user(to, &event).await {
        tracing::warn!(error = %err, "friend event delivery failed");
    }
}

/// `POST /friends/requests` — send (or auto-accept) a friend request by username.
///
/// Returns a uniform `{status}` and never reveals whether the target exists or
/// has blocked the caller.
pub async fn send_request(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<AddFriendRequest>,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    let username = body.username.trim().to_lowercase();
    if username.is_empty() {
        return Err(ApiError::Validation("username is required".to_string()));
    }

    let Some(target) = user_repo::find_by_username(&state.db, &username).await? else {
        // Anti-enumeration: respond as if sent even when no such account exists.
        return Ok(Json(json!({ "status": "sent" })));
    };
    if target.id == me {
        return Err(ApiError::Unprocessable(
            "cannot befriend yourself".to_string(),
        ));
    }

    let (lo, hi) = friend_repo::ordered(me, target.id);
    let status = match friend_repo::get_pair(&state.db, lo, hi).await? {
        None => {
            friend_repo::insert_pending(&state.db, lo, hi, me).await?;
            notify(
                &state,
                target.id,
                ServerEvent::FriendRequest { user_id: me },
            )
            .await;
            "sent"
        }
        Some(edge) => match edge.state.as_str() {
            "accepted" => "already_friends",
            // Blocked: only the blocker learns of it; the blocked side sees "sent".
            "blocked" if edge.requested_by == me => "blocked",
            "blocked" => "sent",
            // A pending request the *other* side already sent → auto-accept.
            "pending" if edge.requested_by == target.id => {
                friend_repo::set_state(&state.db, lo, hi, "accepted").await?;
                notify(
                    &state,
                    target.id,
                    ServerEvent::FriendAccepted { user_id: me },
                )
                .await;
                "accepted"
            }
            // Our own pending request (idempotent) or anything else.
            _ => "sent",
        },
    };
    Ok(Json(json!({ "status": status })))
}

/// `POST /friends/requests/{userId}/accept` — accept an incoming request.
pub async fn accept_request(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(other): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    let (lo, hi) = friend_repo::ordered(me, other);
    friend_repo::get_pair(&state.db, lo, hi)
        .await?
        .filter(|e| e.state == "pending" && e.requested_by == other)
        .ok_or_else(|| ApiError::NotFound("no pending request from this user".to_string()))?;

    friend_repo::set_state(&state.db, lo, hi, "accepted").await?;
    notify(&state, other, ServerEvent::FriendAccepted { user_id: me }).await;
    Ok(Json(json!({ "status": "accepted" })))
}

/// `POST /friends/requests/{userId}/decline` — decline an incoming request or
/// cancel an outgoing one. Deletes the pair silently (no leak either way).
pub async fn decline_request(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(other): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    let (lo, hi) = friend_repo::ordered(me, other);
    match friend_repo::get_pair(&state.db, lo, hi).await? {
        Some(edge) if edge.state == "pending" => {
            friend_repo::delete_pair(&state.db, lo, hi).await?;
        }
        _ => return Err(ApiError::NotFound("no pending request".to_string())),
    }
    Ok(Json(json!({ "status": "declined" })))
}

/// `POST /friends/{userId}/block` — block a user (removes any friendship).
pub async fn block_user(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(other): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    if other == me {
        return Err(ApiError::Unprocessable("cannot block yourself".to_string()));
    }
    let (lo, hi) = friend_repo::ordered(me, other);
    friend_repo::block(&state.db, lo, hi, me).await?;
    // Indistinguishable from an unfriend on the other side.
    notify(&state, other, ServerEvent::FriendRemoved { user_id: me }).await;
    Ok(Json(json!({ "status": "blocked" })))
}

/// `DELETE /friends/{userId}` — unfriend or withdraw. A block placed by the other
/// party is a silent no-op (never revealed).
pub async fn remove_friend(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(other): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    let (lo, hi) = friend_repo::ordered(me, other);
    if let Some(edge) = friend_repo::get_pair(&state.db, lo, hi).await? {
        // Don't let someone delete a block that was placed on them.
        if edge.state == "blocked" && edge.requested_by != me {
            return Ok(Json(json!({ "status": "removed" })));
        }
        if friend_repo::delete_pair(&state.db, lo, hi).await? {
            notify(&state, other, ServerEvent::FriendRemoved { user_id: me }).await;
        }
    }
    Ok(Json(json!({ "status": "removed" })))
}

/// `GET /friends` — the caller's friends (with presence), plus incoming/outgoing
/// requests and users they have blocked.
pub async fn list_friends(
    State(state): State<AppState>,
    caller: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    let rows = friend_repo::list_for_user(&state.db, me).await?;

    let accepted_ids: Vec<Uuid> = rows
        .iter()
        .filter(|r| r.state == "accepted")
        .map(|r| r.other_id)
        .collect();
    let presence_map: HashMap<Uuid, presence::EffectivePresence> =
        presence::snapshot(&state.redis, &accepted_ids)
            .await?
            .into_iter()
            .collect();

    let (mut friends, mut incoming, mut outgoing, mut blocked) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for row in rows {
        let avatar_url = storage::avatar_public_url(
            &state.config.storage,
            &row.other_id,
            row.avatar_version.unwrap_or(0),
        );
        // Built once (moves the row's fields); the accepted branch extends it.
        let mut obj = json!({
            "user_id": row.other_id,
            "username": row.username,
            "display_name": row.display_name,
            "avatar_url": avatar_url,
        });
        match row.state.as_str() {
            "accepted" => {
                let eff = presence_map.get(&row.other_id);
                // Keep `presence` a bare status STRING (unchanged client contract);
                // carry the custom text as a sibling (null when unset).
                obj["presence"] = eff.map(|e| json!(e.status)).unwrap_or_else(|| json!("OFFLINE"));
                obj["status_text"] = json!(eff.and_then(|e| e.status_text.clone()));
                friends.push(obj);
            }
            "pending" if row.requested_by == me => outgoing.push(obj),
            "pending" => incoming.push(obj),
            // Only surface blocks the caller placed; hide being blocked by others.
            "blocked" if row.requested_by == me => blocked.push(obj),
            _ => {}
        }
    }

    Ok(Json(json!({
        "friends": friends,
        "incoming": incoming,
        "outgoing": outgoing,
        "blocked": blocked,
    })))
}
