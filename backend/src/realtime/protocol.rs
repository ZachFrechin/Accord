//! The WebSocket wire protocol.
//!
//! Internally-tagged JSON (`{"type":"ECHO", ...}`) so a client-side zod
//! discriminatedUnion can mirror it exactly. Phase 1 carries only connection
//! lifecycle + a diagnostic echo; message/presence variants are added by their
//! own lots without changing the envelope.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::realtime::presence::PresenceStatus;

/// Server → client frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ServerEvent {
    /// Sent once on connect: confirms the session and the current sequence head.
    Ready { session_id: Uuid, seq: u64 },
    /// Diagnostic echo (proves cross-node fan-out); also useful for connectivity.
    Echo { payload: Value },
    /// The client fell too far behind; it should reconnect and resync via REST.
    Reset { reason: String },
    /// Acknowledges a client `HEARTBEAT`.
    HeartbeatAck,
    /// A user's presence changed (in P1, delivered to that user's own devices).
    /// `status_text` is an optional custom free-text status; omitted on the wire
    /// when unset, so no-text frames stay byte-identical for older clients.
    PresenceUpdate {
        user_id: Uuid,
        status: PresenceStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status_text: Option<String>,
    },
    /// An incoming friend request (delivered to the addressee). `user_id` is the
    /// requester.
    FriendRequest { user_id: Uuid },
    /// A friend request you sent was accepted (delivered to the requester).
    /// `user_id` is the party who accepted.
    FriendAccepted { user_id: Uuid },
    /// A friendship ended — declined, unfriended, or blocked (delivered to the
    /// other party). `user_id` is that other party.
    FriendRemoved { user_id: Uuid },
    /// A new message landed in a conversation (delivered to every member). A
    /// lightweight signal: the client fetches the ciphertext + its own wrapped
    /// key via REST (`GET /conversations/{id}/messages`) and decrypts locally.
    MessageCreated {
        conversation_id: Uuid,
        message_id: Uuid,
    },
    /// An MLS frame (commit/proposal/application) was appended to a group's
    /// ordered log (Phase 3). Signal-only: the client fetches frames after its
    /// cursor via REST (`GET /mls/groups/{id}/frames?after=`) and applies them
    /// in order, so every device performs epoch transitions identically.
    MlsFrame {
        conversation_id: Uuid,
        epoch: u64,
        order_seq: u64,
    },
    /// A member joined a conversation (delivered to every member, incl. the new
    /// one). The client refreshes the member list and their key bundles.
    ConversationMemberAdded {
        conversation_id: Uuid,
        user_id: Uuid,
    },
    /// A member left or was removed (delivered to the remaining members and the
    /// removed one).
    ConversationMemberRemoved {
        conversation_id: Uuid,
        user_id: Uuid,
    },
    /// A message's ciphertext was edited (delivered to members). Re-fetch as for
    /// `MessageCreated`.
    MessageUpdated {
        conversation_id: Uuid,
        message_id: Uuid,
    },
    /// A message was deleted/tombstoned (delivered to members). The id is a
    /// string: a server row uuid for legacy messages, or the client-local
    /// "mls:<seq>" ref for an MLS moderation tombstone (the server holds no
    /// addressable row for E2EE frames).
    MessageDeleted {
        conversation_id: Uuid,
        message_id: String,
    },
    /// A message's reactions changed (delivered to members). Signal-only: the
    /// client re-fetches that message's aggregated reactions via REST
    /// (`GET /conversations/{id}/messages/{mid}/reactions`).
    MessageReacted {
        conversation_id: Uuid,
        message_id: Uuid,
    },
    /// A member is typing (delivered to the other members; not persisted).
    Typing {
        conversation_id: Uuid,
        user_id: Uuid,
    },
    /// A member advanced their read marker (delivered to the other members as a
    /// read receipt).
    ConversationRead {
        conversation_id: Uuid,
        user_id: Uuid,
    },
    /// An incoming call (Phase 4): a member started a call in a conversation.
    /// Delivered to the OTHER members so they can ring/answer. Signal-only — the
    /// media itself flows through LiveKit (the SFU), keyed E2EE from MLS.
    CallRing {
        conversation_id: Uuid,
        /// The caller.
        from: Uuid,
        /// Correlates ring/end for one call session.
        call_id: Uuid,
        /// "audio" or "video".
        media: String,
    },
    /// A call ended / was cancelled / declined (delivered to the other members),
    /// so a still-ringing incoming-call prompt dismisses. Emitted when the LAST
    /// participant leaves (the whole call is over), not when any one member leaves.
    CallEnd {
        conversation_id: Uuid,
        call_id: Uuid,
    },
    /// A participant joined the conversation's call (Phase 4 · Lot 5c). Delivered
    /// to the other members so they can show an authoritative roster and a
    /// "call in progress — join" affordance without waiting on the SFU.
    CallParticipantJoined {
        conversation_id: Uuid,
        call_id: Uuid,
        user_id: Uuid,
    },
    /// A participant left the call but it is still going (others remain). Distinct
    /// from `CallEnd`, so a group call is not torn down when one member hangs up.
    CallParticipantLeft {
        conversation_id: Uuid,
        call_id: Uuid,
        user_id: Uuid,
    },
}

/// Client → server frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClientCommand {
    /// Keepalive; refreshes this device's presence TTL.
    Heartbeat,
    /// Sets the caller's manual presence status (ONLINE/AWAY/DND) and, optionally,
    /// a custom free-text status. An ABSENT `status_text` leaves the current text
    /// unchanged; an empty string clears it.
    UpdatePresence {
        status: PresenceStatus,
        #[serde(default)]
        status_text: Option<String>,
    },
    /// Request replay since a sequence cursor. Acknowledged now; durable replay
    /// arrives with persistent message content (later phase).
    Resume { since: u64 },
    /// The caller is typing in a conversation; fanned out to the other members.
    Typing { conversation_id: Uuid },
}
