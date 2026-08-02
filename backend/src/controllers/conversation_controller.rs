//! Conversations & messaging controller.
//!
//! The server is a blind relay: it stores and forwards CIPHERTEXT and per-device
//! wrapped keys, and never sees a plaintext body or a private key. It enforces
//! membership (who may post/read) and DM eligibility (friends only), routes a
//! lightweight `MESSAGE_CREATED` signal to members, and paginates history by
//! keyset per requesting device.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use data_encoding::{BASE64, BASE64URL_NOPAD};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::controllers::push_controller;
use crate::domain::{permissions, storage};
use crate::error::ApiError;
use crate::middleware::auth::{self, AuthUser};
use crate::realtime::protocol::ServerEvent;
use crate::repositories::message_repo::RecipientKey;
use crate::repositories::{
    admin_repo, conversation_repo, friend_repo, message_reaction_repo, message_repo, xp_repo,
};
use crate::state::AppState;

/// Guards against abusive payloads (real bodies are small; blobs are attachments).
const MAX_CIPHERTEXT: usize = 64 * 1024;
const MAX_RECIPIENTS: usize = 512;
const MAX_NONCE: usize = 64;
const MAX_WRAPPED_KEY: usize = 128;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
/// A single emoji reaction (ZWJ sequences fit; mirrors the DB CHECK).
const MAX_EMOJI_BYTES: usize = 32;

/// Body of `POST /conversations/dm`.
#[derive(Debug, Deserialize)]
pub struct OpenDm {
    user_id: Uuid,
}

/// `POST /conversations/dm` — open (or fetch) the DM with an accepted friend.
pub async fn open_dm(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<OpenDm>,
) -> Result<Json<Value>, ApiError> {
    let me = caller.user_id;
    if body.user_id == me {
        return Err(ApiError::Unprocessable("cannot DM yourself".to_string()));
    }
    let (lo, hi) = friend_repo::ordered(me, body.user_id);
    let accepted = friend_repo::get_pair(&state.db, lo, hi)
        .await?
        .is_some_and(|e| e.state == "accepted");
    if !accepted {
        return Err(ApiError::Forbidden("you can only DM friends".to_string()));
    }

    let conversation_id = conversation_repo::get_or_create_dm(&state.db, me, body.user_id).await?;
    Ok(Json(
        json!({ "conversation_id": conversation_id, "kind": "dm" }),
    ))
}

/// One recipient device's wrapped message key.
#[derive(Debug, Deserialize)]
pub struct RecipientKeyDto {
    user_id: Uuid,
    device_id: String,
    wrapped_key: String,
    wrap_nonce: String,
}

/// Body of `POST /conversations/{id}/messages`. All byte fields are base64; the
/// server never decodes the meaning, only stores it.
#[derive(Debug, Deserialize)]
pub struct SendMessage {
    sender_device: String,
    ciphertext: String,
    body_nonce: String,
    recipients: Vec<RecipientKeyDto>,
    /// Optional parent message this replies to (must be in the same conversation).
    #[serde(default)]
    reply_to: Option<Uuid>,
}

/// Body of `PATCH /conversations/{id}/messages/{message_id}` (a re-encrypted body).
#[derive(Debug, Deserialize)]
pub struct EditMessage {
    ciphertext: String,
    body_nonce: String,
    recipients: Vec<RecipientKeyDto>,
}

/// `POST /conversations/{id}/messages` — post an encrypted message. The client
/// has already encrypted the body and wrapped the message key for every recipient
/// device (fetched via `GET /keys/users/{id}`).
pub async fn send_message(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<SendMessage>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden(
            "not a member of this conversation".to_string(),
        ));
    }
    if body.sender_device.trim().is_empty() || body.sender_device.len() > 128 {
        return Err(ApiError::Validation("invalid sender_device".to_string()));
    }
    // MLS-only (v0.7): an MLS conversation accepts application frames, never
    // legacy X25519 rows — a stale client must not fork the thread.
    if conversation_repo::protocol_of(&state.db, conversation_id)
        .await?
        .as_deref()
        == Some("mls")
    {
        return Err(ApiError::Validation(
            "this conversation is MLS — legacy sends are not accepted".to_string(),
        ));
    }
    let EncryptedPayload {
        ciphertext,
        body_nonce,
        keys,
    } = parse_message_payload(&body.ciphertext, &body.body_nonce, &body.recipients)?;

    // A reply pointer must reference a real message in THIS conversation.
    if let Some(parent) = body.reply_to
        && message_repo::get_meta(&state.db, conversation_id, parent)
            .await?
            .is_none()
    {
        return Err(ApiError::Validation(
            "reply_to is not a message in this conversation".to_string(),
        ));
    }

    let message_id = Uuid::now_v7();
    message_repo::insert_message(
        &state.db,
        message_repo::NewMessage {
            id: message_id,
            conversation_id,
            sender_id: caller.user_id,
            sender_device: &body.sender_device,
            ciphertext: &ciphertext,
            body_nonce: &body_nonce,
            reply_to: body.reply_to,
        },
        &keys,
    )
    .await?;

    // Leveling: a counted message (cooldown + daily cap inside). Best-effort.
    if let Err(e) = xp_repo::award_message_xp(&state.db, caller.user_id).await {
        tracing::warn!(error = %e, "message xp grant failed");
    }

    // Fan out a lightweight signal to every member (best-effort).
    let members = conversation_repo::member_ids(&state.db, conversation_id).await?;
    let event = ServerEvent::MessageCreated {
        conversation_id,
        message_id,
    };
    for member in members {
        if let Err(err) = state.realtime.deliver_to_user(member, &event).await {
            tracing::warn!(error = %err, "message event delivery failed");
        }
        // Qui n'a aucune connexion vive est réveillé par push — sans contenu,
        // l'appareil ira chercher et déchiffrer le message lui-même. L'auteur
        // est exclu : son propre message n'a pas à faire sonner ses appareils.
        if member != caller.user_id {
            push_controller::wake_absent(
                state.clone(),
                member,
                conversation_id,
                message_id.to_string(),
            );
        }
    }

    Ok(Json(json!({ "message_id": message_id })))
}

/// Query for `GET /conversations/{id}/messages`.
#[derive(Debug, Deserialize)]
pub struct ListMessagesQuery {
    device_id: String,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

/// `GET /conversations/{id}/messages` — a keyset page (newest first) of the
/// conversation, each message carrying the wrapped key for `device_id`.
pub async fn list_messages(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden(
            "not a member of this conversation".to_string(),
        ));
    }
    if query.device_id.trim().is_empty() {
        return Err(ApiError::Validation("device_id is required".to_string()));
    }
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let before = match query.before.as_deref() {
        Some(cursor) => Some(decode_cursor(cursor)?),
        None => None,
    };

    let rows = message_repo::list_page(
        &state.db,
        conversation_id,
        caller.user_id,
        &query.device_id,
        before,
        limit,
    )
    .await?;

    let next_cursor = (rows.len() as i64 == limit)
        .then(|| rows.last().map(|r| encode_cursor(r.created_at, r.id)))
        .flatten();

    // Fold the page's reactions (aggregated + "did I react") into a per-message map.
    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    let mut reactions_by_msg: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for agg in
        message_reaction_repo::aggregate_for_messages(&state.db, &ids, caller.user_id).await?
    {
        reactions_by_msg
            .entry(agg.message_id)
            .or_default()
            .push(json!({ "emoji": agg.emoji, "count": agg.count, "me": agg.me }));
    }

    let messages: Vec<Value> = rows
        .into_iter()
        .map(|m| {
            let deleted = m.deleted_at.is_some();
            json!({
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_device": m.sender_device,
                "ciphertext": (!deleted).then(|| BASE64.encode(&m.ciphertext)),
                "body_nonce": (!deleted).then(|| BASE64.encode(&m.body_nonce)),
                "wrapped_key": m.wrapped_key.map(|k| BASE64.encode(&k)),
                "wrap_nonce": m.wrap_nonce.map(|n| BASE64.encode(&n)),
                "created_at": m.created_at,
                "edited_at": m.edited_at,
                "deleted": deleted,
                "reply_to": m.reply_to,
                "reactions": reactions_by_msg.remove(&m.id).unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(
        json!({ "messages": messages, "next_cursor": next_cursor }),
    ))
}

/// `GET /conversations` — the caller's conversations, most-recent first.
pub async fn list_conversations(
    State(state): State<AppState>,
    caller: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let conversations: Vec<Value> = conversation_repo::list_for_user(&state.db, caller.user_id)
        .await?
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id,
                "kind": c.kind,
                "name": c.name,
                "protocol": c.protocol,
                "created_at": c.created_at,
                "unread": c.unread,
                "last_read_at": c.last_read_at,
                "description": c.description,
                "avatar_url": storage::avatar_public_url(
                    &state.config.storage,
                    &c.id,
                    c.avatar_version,
                ),
            })
        })
        .collect();
    Ok(Json(json!({ "conversations": conversations })))
}

/// Body of `POST /conversations/{id}/protocol`.
#[derive(Debug, Deserialize)]
pub struct SetProtocolBody {
    protocol: String,
}

/// `POST /conversations/{id}/protocol` — set a conversation's E2EE protocol
/// (the cutover flag). Any member may flip it; forward-only in practice
/// (legacy → 'mls' once the MLS group exists). The server stays a blind relay —
/// this only records which envelope format clients should use.
pub async fn set_protocol(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<SetProtocolBody>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden(
            "not a member of this conversation".to_string(),
        ));
    }
    // MLS-only (v0.7): the cutover is forward-only — downgrading back to the
    // legacy protocol is gone for good.
    if body.protocol != "mls" {
        return Err(ApiError::Validation(
            "protocol can only be upgraded to 'mls'".to_string(),
        ));
    }
    conversation_repo::set_protocol(&state.db, conversation_id, &body.protocol).await?;
    Ok(Json(json!({ "status": "ok", "protocol": body.protocol })))
}

/// `PATCH /conversations/{id}/messages/{message_id}` — edit a message (sender
/// only). Replaces the ciphertext + wrapped keys with a freshly re-encrypted body.
pub async fn edit_message(
    State(state): State<AppState>,
    caller: AuthUser,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<EditMessage>,
) -> Result<Json<Value>, ApiError> {
    let meta = load_message_meta(&state, conversation_id, message_id).await?;
    if meta.sender_id != Some(caller.user_id) {
        return Err(ApiError::Forbidden("only the sender can edit".to_string()));
    }
    if meta.deleted_at.is_some() {
        return Err(ApiError::Unprocessable("message is deleted".to_string()));
    }
    let EncryptedPayload {
        ciphertext,
        body_nonce,
        keys,
    } = parse_message_payload(&body.ciphertext, &body.body_nonce, &body.recipients)?;

    message_repo::update_message(&state.db, message_id, &ciphertext, &body_nonce, &keys).await?;
    fanout(
        &state,
        &conversation_repo::member_ids(&state.db, conversation_id).await?,
        ServerEvent::MessageUpdated {
            conversation_id,
            message_id,
        },
    )
    .await;
    Ok(Json(json!({ "status": "updated" })))
}

/// `DELETE /conversations/{id}/messages/{message_id}` — delete a message (its
/// sender, or a group admin). Tombstones it and drops the ciphertext + keys.
pub async fn delete_message(
    State(state): State<AppState>,
    caller: AuthUser,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    let meta = load_message_meta(&state, conversation_id, message_id).await?;
    let is_sender = meta.sender_id == Some(caller.user_id);
    let is_conv_admin = conversation_repo::get_role(&state.db, conversation_id, caller.user_id)
        .await?
        .is_some_and(|r| r == "admin");
    // Instance moderators (MODERATE bit / root admin) may delete any message.
    let is_moderator = if is_sender || is_conv_admin {
        false
    } else {
        let (root, perms) = auth::instance_permissions(&state, caller.user_id).await?;
        root || (perms & permissions::MODERATE) != 0
    };
    if !is_sender && !is_conv_admin && !is_moderator {
        return Err(ApiError::Forbidden("not permitted".to_string()));
    }
    if meta.deleted_at.is_none() {
        message_repo::delete_message(&state.db, message_id).await?;
        if is_moderator {
            if let Err(e) = admin_repo::record_audit(
                &state.db,
                caller.user_id,
                "message.delete",
                meta.sender_id,
                json!({ "conversation_id": conversation_id, "message_id": message_id }),
            )
            .await
            {
                tracing::warn!(error = %e, "audit write failed");
            }
        }
        fanout(
            &state,
            &conversation_repo::member_ids(&state.db, conversation_id).await?,
            ServerEvent::MessageDeleted {
                conversation_id,
                message_id: message_id.to_string(),
            },
        )
        .await;
    }
    Ok(Json(json!({ "status": "deleted" })))
}

/// Body of `POST /conversations/{id}/read`. `message_id` is optional: MLS
/// clients only hold ciphertext-local ids, so "no id" means "read up to now".
#[derive(Debug, Deserialize)]
pub struct MarkRead {
    message_id: Option<Uuid>,
}

/// `POST /conversations/{id}/read` — advance the caller's read marker to a
/// message (or to now), and post a read receipt to the other members.
pub async fn mark_read(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<MarkRead>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let up_to = match body.message_id {
        Some(message_id) => {
            message_repo::get_meta(&state.db, conversation_id, message_id)
                .await?
                .ok_or_else(|| ApiError::NotFound("no such message".to_string()))?
                .created_at
        }
        None => Utc::now(),
    };
    conversation_repo::set_last_read(&state.db, conversation_id, caller.user_id, up_to).await?;

    let others: Vec<Uuid> = conversation_repo::member_ids(&state.db, conversation_id)
        .await?
        .into_iter()
        .filter(|m| *m != caller.user_id)
        .collect();
    fanout(
        &state,
        &others,
        ServerEvent::ConversationRead {
            conversation_id,
            user_id: caller.user_id,
        },
    )
    .await;
    Ok(Json(json!({ "status": "read" })))
}

/// Body of `POST /conversations/{id}/messages/{message_id}/reactions`.
#[derive(Debug, Deserialize)]
pub struct ReactBody {
    emoji: String,
}

/// `POST /conversations/{id}/messages/{message_id}/reactions` — toggle the
/// caller's emoji reaction (add if absent, remove if present). Members only.
pub async fn toggle_reaction(
    State(state): State<AppState>,
    caller: AuthUser,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ReactBody>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let meta = load_message_meta(&state, conversation_id, message_id).await?;
    if meta.deleted_at.is_some() {
        return Err(ApiError::Unprocessable("message is deleted".to_string()));
    }
    let emoji = validate_emoji(&body.emoji)?;

    let added =
        message_reaction_repo::toggle(&state.db, message_id, caller.user_id, &emoji).await?;
    fanout(
        &state,
        &conversation_repo::member_ids(&state.db, conversation_id).await?,
        ServerEvent::MessageReacted {
            conversation_id,
            message_id,
        },
    )
    .await;
    Ok(Json(json!({ "added": added })))
}

/// `GET /conversations/{id}/messages/{message_id}/reactions` — the message's
/// aggregated reactions for the caller (used to refresh after a `MESSAGE_REACTED`).
pub async fn list_reactions(
    State(state): State<AppState>,
    caller: AuthUser,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let reactions: Vec<Value> =
        message_reaction_repo::aggregate_for_messages(&state.db, &[message_id], caller.user_id)
            .await?
            .into_iter()
            .map(|a| json!({ "emoji": a.emoji, "count": a.count, "me": a.me }))
            .collect();
    Ok(Json(json!({ "reactions": reactions })))
}

/// Validates a reaction emoji: non-empty, within the DB length cap, and free of
/// control characters. Returns the trimmed value.
fn validate_emoji(raw: &str) -> Result<String, ApiError> {
    let emoji = raw.trim();
    if emoji.is_empty() || emoji.len() > MAX_EMOJI_BYTES {
        return Err(ApiError::Validation("invalid emoji".to_string()));
    }
    if emoji.chars().any(|c| c.is_control()) {
        return Err(ApiError::Validation("invalid emoji".to_string()));
    }
    Ok(emoji.to_string())
}

/// Loads a message's metadata or returns a 404. Shared by edit/delete.
async fn load_message_meta(
    state: &AppState,
    conversation_id: Uuid,
    message_id: Uuid,
) -> Result<message_repo::MessageMeta, ApiError> {
    message_repo::get_meta(&state.db, conversation_id, message_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such message".to_string()))
}

/// A validated, decoded encrypted message payload (body + per-device keys).
struct EncryptedPayload {
    ciphertext: Vec<u8>,
    body_nonce: Vec<u8>,
    keys: Vec<RecipientKey>,
}

/// Validates + decodes an encrypted message payload (body + per-device keys).
fn parse_message_payload(
    ciphertext: &str,
    body_nonce: &str,
    recipients: &[RecipientKeyDto],
) -> Result<EncryptedPayload, ApiError> {
    if recipients.is_empty() || recipients.len() > MAX_RECIPIENTS {
        return Err(ApiError::Validation("invalid recipients".to_string()));
    }
    let ciphertext = decode_bounded("ciphertext", ciphertext, MAX_CIPHERTEXT)?;
    if ciphertext.is_empty() {
        return Err(ApiError::Validation("ciphertext is empty".to_string()));
    }
    let body_nonce = decode_bounded("body_nonce", body_nonce, MAX_NONCE)?;

    let mut keys = Vec::with_capacity(recipients.len());
    for r in recipients {
        if r.device_id.trim().is_empty() || r.device_id.len() > 128 {
            return Err(ApiError::Validation(
                "invalid recipient device_id".to_string(),
            ));
        }
        keys.push(RecipientKey {
            recipient_user_id: r.user_id,
            recipient_device: r.device_id.clone(),
            wrapped_key: decode_bounded("wrapped_key", &r.wrapped_key, MAX_WRAPPED_KEY)?,
            wrap_nonce: decode_bounded("wrap_nonce", &r.wrap_nonce, MAX_NONCE)?,
        });
    }
    Ok(EncryptedPayload {
        ciphertext,
        body_nonce,
        keys,
    })
}

/// Delivers an event to every listed member (best-effort).
async fn fanout(state: &AppState, members: &[Uuid], event: ServerEvent) {
    for member in members {
        if let Err(err) = state.realtime.deliver_to_user(*member, &event).await {
            tracing::warn!(error = %err, "conversation event delivery failed");
        }
    }
}

/// Requires the caller to be an admin of a group conversation. Returns an error
/// otherwise (masking DM/non-member/non-admin as the same forbidden result).
async fn require_group_admin(
    state: &AppState,
    conversation_id: Uuid,
    caller: Uuid,
) -> Result<(), ApiError> {
    let info = conversation_repo::get_info(&state.db, conversation_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such conversation".to_string()))?;
    if info.kind != "group" {
        return Err(ApiError::Unprocessable("not a group".to_string()));
    }
    let is_admin = conversation_repo::get_role(&state.db, conversation_id, caller)
        .await?
        .is_some_and(|r| r == "admin");
    if !is_admin {
        return Err(ApiError::Forbidden("admin only".to_string()));
    }
    Ok(())
}

/// Body of `POST /conversations/group`.
#[derive(Debug, Deserialize)]
pub struct CreateGroup {
    name: String,
    #[serde(default)]
    member_ids: Vec<Uuid>,
}

/// `POST /conversations/group` — create a group; the caller is its admin. Initial
/// members must be accepted friends of the caller (non-friends are skipped).
pub async fn create_group(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<CreateGroup>,
) -> Result<Json<Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::Validation("invalid group name".to_string()));
    }
    let conversation_id = conversation_repo::create_group(&state.db, caller.user_id, name).await?;

    let mut added = vec![caller.user_id];
    for uid in body.member_ids.into_iter().filter(|u| *u != caller.user_id) {
        let (lo, hi) = friend_repo::ordered(caller.user_id, uid);
        let accepted = friend_repo::get_pair(&state.db, lo, hi)
            .await?
            .is_some_and(|e| e.state == "accepted");
        if accepted
            && conversation_repo::add_member(&state.db, conversation_id, uid, "member").await?
        {
            added.push(uid);
        }
    }

    for user_id in &added {
        fanout(
            &state,
            &added,
            ServerEvent::ConversationMemberAdded {
                conversation_id,
                user_id: *user_id,
            },
        )
        .await;
    }
    Ok(Json(
        json!({ "conversation_id": conversation_id, "kind": "group" }),
    ))
}

/// `GET /conversations/{id}/members` — the conversation's members (member-gated).
pub async fn list_members(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let members: Vec<Value> = conversation_repo::list_members(&state.db, conversation_id)
        .await?
        .into_iter()
        .map(|m| {
            let avatar_url = storage::avatar_public_url(
                &state.config.storage,
                &m.user_id,
                m.avatar_version.unwrap_or(0),
            );
            json!({
                "user_id": m.user_id,
                "username": m.username,
                "display_name": m.display_name,
                "avatar_url": avatar_url,
                "role": m.role,
            })
        })
        .collect();
    Ok(Json(json!({ "members": members })))
}

/// Body of `POST /conversations/{id}/members`.
#[derive(Debug, Deserialize)]
pub struct AddMember {
    user_id: Uuid,
}

/// `POST /conversations/{id}/members` — add a friend to a group (admin only).
pub async fn add_member(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<AddMember>,
) -> Result<Json<Value>, ApiError> {
    require_group_admin(&state, conversation_id, caller.user_id).await?;
    let (lo, hi) = friend_repo::ordered(caller.user_id, body.user_id);
    let accepted = friend_repo::get_pair(&state.db, lo, hi)
        .await?
        .is_some_and(|e| e.state == "accepted");
    if !accepted {
        return Err(ApiError::Forbidden("you can only add friends".to_string()));
    }

    if conversation_repo::add_member(&state.db, conversation_id, body.user_id, "member").await? {
        let members = conversation_repo::member_ids(&state.db, conversation_id).await?;
        fanout(
            &state,
            &members,
            ServerEvent::ConversationMemberAdded {
                conversation_id,
                user_id: body.user_id,
            },
        )
        .await;
    }
    Ok(Json(json!({ "status": "added" })))
}

/// `DELETE /conversations/{id}/members/{user_id}` — remove a member (admin) or
/// leave (removing yourself).
pub async fn remove_member(
    State(state): State<AppState>,
    caller: AuthUser,
    Path((conversation_id, target)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    if target != caller.user_id {
        require_group_admin(&state, conversation_id, caller.user_id).await?;
    } else if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }

    // Snapshot members before removal so the removed user is also notified.
    let members = conversation_repo::member_ids(&state.db, conversation_id).await?;
    if conversation_repo::remove_member(&state.db, conversation_id, target).await? {
        fanout(
            &state,
            &members,
            ServerEvent::ConversationMemberRemoved {
                conversation_id,
                user_id: target,
            },
        )
        .await;
    }
    Ok(Json(json!({ "status": "removed" })))
}

/// Body of `PATCH /conversations/{id}`.
#[derive(Debug, Deserialize)]
pub struct RenameGroup {
    name: Option<String>,
    /// Optional; an empty string clears the description.
    description: Option<String>,
}

/// `PATCH /conversations/{id}` — update a group's name and/or description
/// (admin only). Both fields optional; absent = untouched.
pub async fn rename_group(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<RenameGroup>,
) -> Result<Json<Value>, ApiError> {
    require_group_admin(&state, conversation_id, caller.user_id).await?;
    if let Some(name) = &body.name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(ApiError::Validation("invalid group name".to_string()));
        }
        conversation_repo::rename(&state.db, conversation_id, name).await?;
    }
    if let Some(description) = &body.description {
        let description = description.trim();
        if description.chars().count() > 500 {
            return Err(ApiError::Validation("description is too long".to_string()));
        }
        conversation_repo::set_description(
            &state.db,
            conversation_id,
            (!description.is_empty()).then_some(description),
        )
        .await?;
    }
    Ok(Json(json!({ "status": "updated" })))
}

/// Body of `POST /conversations/{id}/avatar`.
#[derive(Debug, Deserialize)]
pub struct GroupAvatarUploadRequest {
    pub size_bytes: i64,
}

/// Max group-avatar object size — same budget as user avatars.
const GROUP_AVATAR_MAX_BYTES: i64 = 8 * 1024 * 1024;
const GROUP_AVATAR_URL_EXPIRY_SECS: u64 = 300;

/// `POST /conversations/{id}/avatar` — reserve the next avatar version for a
/// group and return a presigned PUT (public avatars bucket; the conversation
/// UUID namespaces the key exactly like a user id does). Admin only.
pub async fn request_group_avatar_upload(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(req): Json<GroupAvatarUploadRequest>,
) -> Result<Json<Value>, ApiError> {
    require_group_admin(&state, conversation_id, caller.user_id).await?;
    if req.size_bytes <= 0 || req.size_bytes > GROUP_AVATAR_MAX_BYTES {
        return Err(ApiError::Validation(format!(
            "avatar must be between 1 and {GROUP_AVATAR_MAX_BYTES} bytes"
        )));
    }
    let version = conversation_repo::group_avatar_version(&state.db, conversation_id).await? + 1;
    let key = storage::avatar_key(&conversation_id, version);
    let upload_url = storage::presign(
        &state.config.storage,
        &state.config.storage.avatars_bucket,
        "PUT",
        &key,
        GROUP_AVATAR_URL_EXPIRY_SECS,
    );
    Ok(Json(json!({
        "upload_url": upload_url,
        "version": version,
        "expires_in": GROUP_AVATAR_URL_EXPIRY_SECS,
    })))
}

/// Body of `POST /conversations/{id}/avatar/commit`.
#[derive(Debug, Deserialize)]
pub struct GroupAvatarCommitRequest {
    pub version: i32,
}

/// `POST /conversations/{id}/avatar/commit` — after a successful upload, point
/// the group at the new version. Admin only.
pub async fn commit_group_avatar(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(req): Json<GroupAvatarCommitRequest>,
) -> Result<Json<Value>, ApiError> {
    require_group_admin(&state, conversation_id, caller.user_id).await?;
    if req.version <= 0 {
        return Err(ApiError::Validation("invalid avatar version".to_string()));
    }
    conversation_repo::set_group_avatar_version(&state.db, conversation_id, req.version).await?;
    let avatar_url =
        storage::avatar_public_url(&state.config.storage, &conversation_id, req.version);
    Ok(Json(
        json!({ "status": "updated", "avatar_url": avatar_url }),
    ))
}

/// Decodes a base64 byte field, rejecting anything over `max` bytes.
fn decode_bounded(field: &str, value: &str, max: usize) -> Result<Vec<u8>, ApiError> {
    let bytes = BASE64
        .decode(value.as_bytes())
        .map_err(|_| ApiError::Validation(format!("{field} must be base64")))?;
    if bytes.len() > max {
        return Err(ApiError::Validation(format!("{field} is too large")));
    }
    Ok(bytes)
}

/// Encodes a keyset cursor as `base64url(rfc3339 "|" uuid)`.
fn encode_cursor(created_at: DateTime<Utc>, id: Uuid) -> String {
    BASE64URL_NOPAD.encode(format!("{}|{}", created_at.to_rfc3339(), id).as_bytes())
}

/// Decodes a keyset cursor. A malformed cursor is a client (validation) error.
fn decode_cursor(cursor: &str) -> Result<(DateTime<Utc>, Uuid), ApiError> {
    let raw = BASE64URL_NOPAD
        .decode(cursor.as_bytes())
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| ApiError::Validation("invalid cursor".to_string()))?;
    let (ts, id) = raw
        .split_once('|')
        .ok_or_else(|| ApiError::Validation("invalid cursor".to_string()))?;
    let created_at = DateTime::parse_from_rfc3339(ts)
        .map_err(|_| ApiError::Validation("invalid cursor".to_string()))?
        .with_timezone(&Utc);
    let id = Uuid::parse_str(id).map_err(|_| ApiError::Validation("invalid cursor".to_string()))?;
    Ok((created_at, id))
}

// ── MLS moderation tombstones ────────────────────────────────────────────────

/// Body of `POST /conversations/{id}/moderation/tombstone`.
#[derive(Debug, Deserialize)]
pub struct TombstoneBody {
    /// Client-local MLS message id, e.g. "mls:000000000042".
    pub message_ref: String,
}

/// `POST /conversations/{id}/moderation/tombstone` — an instance moderator
/// "deletes" an E2EE message. The server cannot address (or read) the frame,
/// so it records the client-local ref, broadcasts the hide order, and replays
/// it to clients loading history.
pub async fn moderate_tombstone(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<TombstoneBody>,
) -> Result<Json<Value>, ApiError> {
    let (root, perms) = auth::instance_permissions(&state, caller.user_id).await?;
    if !root && (perms & permissions::MODERATE) == 0 {
        return Err(ApiError::Forbidden(
            "permission requise : modération".to_string(),
        ));
    }
    let message_ref = body.message_ref.trim();
    if !message_ref.starts_with("mls:") || message_ref.len() > 64 {
        return Err(ApiError::Validation("invalid message ref".to_string()));
    }
    admin_repo::add_mls_tombstone(&state.db, conversation_id, message_ref, caller.user_id).await?;
    if let Err(e) = admin_repo::record_audit(
        &state.db,
        caller.user_id,
        "message.delete",
        None,
        json!({ "conversation_id": conversation_id, "message_ref": message_ref }),
    )
    .await
    {
        tracing::warn!(error = %e, "audit write failed");
    }
    fanout(
        &state,
        &conversation_repo::member_ids(&state.db, conversation_id).await?,
        ServerEvent::MessageDeleted {
            conversation_id,
            message_id: message_ref.to_string(),
        },
    )
    .await;
    Ok(Json(json!({ "status": "deleted" })))
}

/// `GET /conversations/{id}/mls/tombstones` — moderation tombstones to replay
/// after loading local MLS history (members only).
pub async fn list_mls_tombstones(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if !conversation_repo::is_member(&state.db, conversation_id, caller.user_id).await? {
        return Err(ApiError::Forbidden("not a member".to_string()));
    }
    let refs = admin_repo::list_mls_tombstones(&state.db, conversation_id).await?;
    Ok(Json(json!({ "refs": refs })))
}
