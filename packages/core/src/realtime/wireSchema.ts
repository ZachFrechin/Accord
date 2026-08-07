/**
 * The WebSocket wire protocol, validated at runtime.
 *
 * The network is untrusted input: every inbound frame is parsed against this
 * discriminatedUnion, and anything that does not match is dropped with a log
 * rather than silently mis-handled. Field names mirror the backend's
 * SCREAMING_SNAKE-tagged serde enum exactly.
 */

import { z } from "zod";

export const PresenceStatusSchema = z.enum(["ONLINE", "AWAY", "DND", "OFFLINE"]);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("READY"), session_id: z.string(), seq: z.number() }),
  z.object({ type: z.literal("ECHO"), payload: z.unknown() }),
  z.object({ type: z.literal("RESET"), reason: z.string() }),
  z.object({ type: z.literal("HEARTBEAT_ACK") }),
  z.object({
    type: z.literal("PRESENCE_UPDATE"),
    user_id: z.string(),
    status: PresenceStatusSchema,
    // Optional custom status text; nullish tolerates an absent key (old server)
    // and an explicit null alike.
    status_text: z.string().nullish(),
  }),
  // Social graph.
  z.object({ type: z.literal("FRIEND_REQUEST"), user_id: z.string() }),
  z.object({ type: z.literal("FRIEND_ACCEPTED"), user_id: z.string() }),
  z.object({ type: z.literal("FRIEND_REMOVED"), user_id: z.string() }),
  // Messaging (lightweight signals — the client re-fetches + decrypts via REST).
  z.object({ type: z.literal("MESSAGE_CREATED"), conversation_id: z.string(), message_id: z.string() }),
  z.object({ type: z.literal("MESSAGE_UPDATED"), conversation_id: z.string(), message_id: z.string() }),
  z.object({ type: z.literal("MESSAGE_DELETED"), conversation_id: z.string(), message_id: z.string() }),
  z.object({ type: z.literal("MESSAGE_REACTED"), conversation_id: z.string(), message_id: z.string() }),
  z.object({
    type: z.literal("MLS_FRAME"),
    conversation_id: z.string(),
    epoch: z.number(),
    order_seq: z.number(),
  }),
  z.object({ type: z.literal("TYPING"), conversation_id: z.string(), user_id: z.string() }),
  z.object({ type: z.literal("CONVERSATION_READ"), conversation_id: z.string(), user_id: z.string() }),
  // Calls (Phase 4).
  z.object({
    type: z.literal("CALL_RING"),
    conversation_id: z.string(),
    from: z.string(),
    call_id: z.string(),
    media: z.string(),
  }),
  z.object({ type: z.literal("CALL_END"), conversation_id: z.string(), call_id: z.string() }),
  z.object({
    type: z.literal("CALL_PARTICIPANT_JOINED"),
    conversation_id: z.string(),
    call_id: z.string(),
    user_id: z.string(),
  }),
  z.object({
    type: z.literal("CALL_PARTICIPANT_LEFT"),
    conversation_id: z.string(),
    call_id: z.string(),
    user_id: z.string(),
  }),
  z.object({
    type: z.literal("CALL_MEDIA_STATE"),
    conversation_id: z.string(),
    call_id: z.string(),
    revision: z.number().int().nonnegative(),
    ciphertext: z.string(),
    nonce: z.string(),
    updated_at_ms: z.number(),
  }),
  z.object({
    type: z.literal("CALL_SOUND_TRIGGER"),
    conversation_id: z.string(),
    call_id: z.string(),
    event_id: z.string(),
    scheduled_at_ms: z.number(),
    blob_id: z.string().nullish(),
    ciphertext: z.string(),
    nonce: z.string(),
  }),
  z.object({
    type: z.literal("CONVERSATION_MEMBER_ADDED"),
    conversation_id: z.string(),
    user_id: z.string(),
  }),
  z.object({
    type: z.literal("CONVERSATION_MEMBER_REMOVED"),
    conversation_id: z.string(),
    user_id: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["type"];

/** Client → server commands (serialized as-is). */
export type ClientCommand =
  | { type: "HEARTBEAT" }
  | { type: "UPDATE_PRESENCE"; status: PresenceStatus; status_text?: string }
  | { type: "RESUME"; since: number }
  | { type: "TYPING"; conversation_id: string };
