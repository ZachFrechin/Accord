//! WebSocket gateway: ticket issuance, connection upgrade, and the socket loop.
//!
//! Auth uses a short-lived single-use ticket (not the JWT) so no long-lived
//! credential ever lands in a URL: an authenticated `POST /ws/ticket` mints one
//! in Redis, and `GET /ws?ticket=…` consumes it atomically (`GETDEL`).

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::secrets;
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::middleware::rate_limit;
use crate::realtime::presence;
use crate::realtime::protocol::{ClientCommand, ServerEvent};
use crate::repositories::conversation_repo;
use crate::state::AppState;

/// Ticket lifetime, seconds.
const TICKET_TTL_SECS: i64 = 30;
/// Server ping cadence to keep intermediaries from idling the socket out.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// `POST /ws/ticket` — mint a single-use ticket bound to the caller's session.
pub async fn issue_ticket(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<axum::Json<Value>, ApiError> {
    let rl = &state.config.rate_limit;
    rate_limit::check(
        &state.redis,
        &format!("rl:wsticket:user:{}", user.user_id),
        rl.ws_ticket_window_secs,
        rl.ws_ticket_max,
    )
    .await?;

    let ticket = secrets::random_token();
    let key = format!("ws:ticket:{ticket}");
    let value = format!("{}:{}", user.user_id, user.session_id);

    let mut conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(redis_unavailable)?;
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(&value)
        .arg("EX")
        .arg(TICKET_TTL_SECS)
        .query_async(&mut conn)
        .await
        .map_err(redis_unavailable)?;

    Ok(axum::Json(
        json!({ "ticket": ticket, "expires_in": TICKET_TTL_SECS }),
    ))
}

/// Query string for the upgrade request.
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    ticket: String,
}

/// `GET /ws?ticket=…` — validate the ticket and upgrade to a WebSocket.
pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let mut conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(redis_unavailable)?;

    // Consume the ticket atomically (single use).
    let value: Option<String> = redis::cmd("GETDEL")
        .arg(format!("ws:ticket:{}", query.ticket))
        .query_async(&mut conn)
        .await
        .map_err(redis_unavailable)?;
    let value =
        value.ok_or_else(|| ApiError::Unauthorized("invalid or expired ticket".to_string()))?;
    let (user_id, session_id) = parse_ticket(&value)
        .ok_or_else(|| ApiError::Unauthorized("malformed ticket".to_string()))?;

    // Reject a session that was revoked between ticket issuance and connect.
    let revoked: bool = redis::cmd("EXISTS")
        .arg(format!("session:revoked:{session_id}"))
        .query_async(&mut conn)
        .await
        .unwrap_or(false);
    if revoked {
        return Err(ApiError::Unauthorized("session revoked".to_string()));
    }

    Ok(upgrade.on_upgrade(move |socket| handle_socket(socket, state, user_id, session_id)))
}

/// `POST /realtime/echo` — deliver an `ECHO` to the caller's own sockets across
/// the fleet. Diagnostic, and the observable proof of cross-node fan-out.
pub async fn echo(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<axum::Json<Value>>,
) -> Result<StatusCode, ApiError> {
    let payload = body.map(|axum::Json(v)| v).unwrap_or_else(|| json!({}));
    state
        .realtime
        .deliver_to_user(user.user_id, &ServerEvent::Echo { payload })
        .await?;
    Ok(StatusCode::ACCEPTED)
}

/// Drives one connected socket until it closes, drains, or the node shuts down.
///
/// A single task owns the socket: each `select!` arm either reads one inbound
/// frame or sends one outbound frame, so there is never a concurrent borrow.
async fn handle_socket(mut socket: WebSocket, state: AppState, user_id: Uuid, session_id: Uuid) {
    let conn_id = Uuid::new_v4();
    let ttl = state.config.presence.device_ttl_secs;

    // Subscribe to this user's cross-node stream; the guard tears it down on drop.
    let (mut rx, _guard) = match state.realtime.subscribe_local(user_id).await {
        Ok(pair) => pair,
        Err(err) => {
            tracing::warn!(%user_id, error = %err, "ws: could not subscribe to realtime bus");
            return;
        }
    };

    // Register this device, then broadcast presence on EVERY connect (not only the
    // first device): a newly connected socket must receive the current presence —
    // including any custom status text — so it can restore/sync it.
    match presence::device_online(&state.redis, user_id, conn_id, ttl).await {
        Ok(_) => broadcast_presence(&state, user_id).await,
        Err(err) => tracing::warn!(%user_id, error = %err, "ws: presence device_online failed"),
    }

    // Announce readiness (seq 0: durable sequencing arrives with content later).
    let ready = serde_json::to_string(&ServerEvent::Ready { session_id, seq: 0 })
        .unwrap_or_else(|_| "{}".to_string());
    let started = socket.send(Message::Text(ready.into())).await.is_ok();

    if started {
        let shutdown = state.shutdown.clone();
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                biased;

                // Shutting down: close cleanly so the client reconnects elsewhere.
                _ = shutdown.cancelled() => {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }

                // An event addressed to this user arrived (from any node).
                received = rx.recv() => match received {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Never drop silently: tell the client to reconnect and resync.
                        let reset = serde_json::to_string(&ServerEvent::Reset {
                            reason: "lagged".to_string(),
                        })
                        .unwrap_or_default();
                        let _ = socket.send(Message::Text(reset.into())).await;
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },

                // Inbound frame from the client.
                inbound = socket.recv() => match inbound {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(command) = serde_json::from_str::<ClientCommand>(text.as_str()) {
                            match command {
                                ClientCommand::Heartbeat => {
                                    let _ = presence::heartbeat(&state.redis, user_id, conn_id, ttl)
                                        .await;
                                    let ack = serde_json::to_string(&ServerEvent::HeartbeatAck)
                                        .unwrap_or_default();
                                    if socket.send(Message::Text(ack.into())).await.is_err() {
                                        break;
                                    }
                                }
                                ClientCommand::UpdatePresence {
                                    status,
                                    status_text,
                                } => {
                                    let _ =
                                        presence::set_status(&state.redis, user_id, status, ttl)
                                            .await;
                                    // Absent field => leave the custom text unchanged; an empty
                                    // string clears it (validate_status_text returns None).
                                    if let Some(raw) = status_text
                                        && let Ok(norm) =
                                            crate::domain::validation::validate_status_text(&raw)
                                    {
                                        let _ = presence::set_status_text(
                                            &state.redis,
                                            user_id,
                                            norm.as_deref(),
                                            ttl,
                                        )
                                        .await;
                                    }
                                    broadcast_presence(&state, user_id).await;
                                }
                                // `Resume` is acknowledged implicitly (replay is a later phase).
                                ClientCommand::Resume { .. } => {}
                                ClientCommand::Typing { conversation_id } => {
                                    // Notify the other members (best-effort; the
                                    // client throttles how often this is sent).
                                    if conversation_repo::is_member(
                                        &state.db,
                                        conversation_id,
                                        user_id,
                                    )
                                    .await
                                    .unwrap_or(false)
                                        && let Ok(members) = conversation_repo::member_ids(
                                            &state.db,
                                            conversation_id,
                                        )
                                        .await
                                    {
                                        let event = ServerEvent::Typing {
                                            conversation_id,
                                            user_id,
                                        };
                                        for member in members {
                                            if member != user_id {
                                                let _ = state
                                                    .realtime
                                                    .deliver_to_user(member, &event)
                                                    .await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {} // Ping/Pong/Binary — nothing to do.
                    Some(Err(_)) => break,
                },

                // Keepalive ping.
                _ = ping.tick() => {
                    if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    // Device gone: if it was the user's last one, broadcast OFFLINE.
    match presence::device_offline(&state.redis, user_id, conn_id).await {
        Ok(true) => broadcast_presence(&state, user_id).await,
        Ok(false) => {}
        Err(err) => tracing::warn!(%user_id, error = %err, "ws: presence device_offline failed"),
    }
}

/// Recomputes a user's effective presence and delivers it to their own sockets.
/// (Peers pull presence + status text from `GET /friends`, so — as in Phase 1 —
/// this stays self-delivery; a live peer fan-out is a separate presence lot.)
async fn broadcast_presence(state: &AppState, user_id: Uuid) {
    match presence::effective_status(&state.redis, user_id).await {
        Ok(eff) => {
            let event = ServerEvent::PresenceUpdate {
                user_id,
                status: eff.status,
                status_text: eff.status_text,
            };
            let _ = state.realtime.deliver_to_user(user_id, &event).await;
        }
        Err(err) => tracing::warn!(%user_id, error = %err, "ws: presence broadcast failed"),
    }
}

/// Parses a `"user_id:session_id"` ticket value into its two UUIDs.
fn parse_ticket(value: &str) -> Option<(Uuid, Uuid)> {
    let (user, session) = value.split_once(':')?;
    Some((Uuid::parse_str(user).ok()?, Uuid::parse_str(session).ok()?))
}

/// Maps a Redis connection/command failure to a masked 503.
fn redis_unavailable<E: std::fmt::Display>(err: E) -> ApiError {
    tracing::warn!(error = %err, "ws: redis unavailable");
    ApiError::ServiceUnavailable("realtime backend temporarily unavailable".to_string())
}
