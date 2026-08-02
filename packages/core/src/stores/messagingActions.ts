/**
 * Messaging orchestration: the imperative glue between the REST/crypto layers and
 * the zustand stores. The MessagingProvider installs a runtime (the active
 * instance's ApiClient + device identity + socket) and wires the realtime
 * handlers below; components call the action functions.
 *
 * All encryption/decryption happens here (via lib/messaging) before anything
 * enters the stores, so the stores only ever hold plaintext this device could
 * open — never keys or ciphertext.
 */

import type { ApiClient, MessageDto } from "../api/ApiClient";
import type { DeviceIdentity } from "../lib/deviceIdentity";
import * as messaging from "../lib/messaging";
import { type AddTarget, type SyncedMessage, MlsDivergenceError } from "../lib/mls/mlsGroup";
import { mlsEngine } from "../lib/mls/MlsEngine";
import { isTauri } from "../lib/isTauri";
import { appendMlsMessages, loadMlsHistory, markMlsDeleted } from "../lib/mls/mlsHistory";
import { VIEWER_MARK } from "../lib/popout";
import * as mls from "../lib/mls/mlsRuntime";
import { showNotification } from "../lib/notifications";
import type { PresenceStatus } from "../realtime/wireSchema";
import type { WsClient } from "../realtime/wsClient";
import { useConversationsStore } from "./useConversationsStore";
import { useOngoingCallsStore } from "./useOngoingCallsStore";
import { useFriendsStore } from "./useFriendsStore";
import {
  type DecryptedMessage,
  type LinkPreview,
  type Reaction,
  useMessagesStore,
} from "./useMessagesStore";
import { notifyModeOf, useNotificationStore } from "./useNotificationStore";
import { usePresenceStore } from "./usePresenceStore";

interface Runtime {
  client: ApiClient;
  identity: DeviceIdentity;
  ws: WsClient;
  myUserId: string;
  instanceId: string;
}

let rt: Runtime | null = null;
const PAGE = 30;
const memberCache = new Map<string, string[]>();

/** A conversation member's resolved profile bits for rendering. */
export interface MemberProfile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
const profileCache = new Map<string, Record<string, MemberProfile>>();

/** Resolve a conversation's user-id → username map (cached), for labelling
 * messages with real, coloured author names like the design. */
export async function memberProfiles(
  conversationId: string,
): Promise<Record<string, MemberProfile>> {
  if (!rt) return {};
  const cached = profileCache.get(conversationId);
  if (cached) return cached;
  const { members } = await rt.client.conversationMembers(conversationId);
  const map: Record<string, MemberProfile> = {};
  for (const m of members) {
    map[m.user_id] = {
      username: m.username,
      displayName: m.display_name?.trim() || m.username,
      avatarUrl: m.avatar_url ?? null,
    };
  }
  profileCache.set(conversationId, map);
  return map;
}

/** user_id → username (for @mention matching); derived from the profile fetch. */
export async function memberNames(conversationId: string): Promise<Record<string, string>> {
  const profiles = await memberProfiles(conversationId);
  const map: Record<string, string> = {};
  for (const [id, p] of Object.entries(profiles)) map[id] = p.username;
  return map;
}

/** Waiters resolved the moment the runtime lands (pop-out windows race it). */
let rtWaiters: (() => void)[] = [];
export function setMessagingRuntime(runtime: Runtime): void {
  rt = runtime;
  rtWaiters.forEach((resolve) => resolve());
  rtWaiters = [];
  sweepStatusTextExpiry(); // an expiry may have passed while we were offline
}

/** Resolves true once the messaging runtime exists (false on timeout). A
 * secondary window (call viewer) mounts BEFORE MessagingProvider finishes its
 * async init — calling rt-dependent actions immediately would fail. */
export function messagingReady(timeoutMs = 10_000): Promise<boolean> {
  if (rt) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(rt !== null), timeoutMs);
    rtWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
export function clearMessagingRuntime(): void {
  rt = null;
  memberCache.clear();
  profileCache.clear();
  messaging.clearBundleCache();
}

async function memberIds(conversationId: string): Promise<string[]> {
  if (!rt) return [];
  const cached = memberCache.get(conversationId);
  if (cached) return cached;
  const { members } = await rt.client.conversationMembers(conversationId);
  const ids = members.map((m) => m.user_id);
  memberCache.set(conversationId, ids);
  return ids;
}
function invalidateMembers(conversationId: string): void {
  memberCache.delete(conversationId);
  profileCache.delete(conversationId);
}

function toDecrypted(msg: MessageDto, content: messaging.MessageContent | null): DecryptedMessage {
  return {
    id: msg.id,
    senderId: msg.sender_id,
    senderDevice: msg.sender_device,
    createdAt: msg.created_at,
    editedAt: msg.edited_at,
    deleted: msg.deleted,
    content,
    replyTo: msg.reply_to ?? null,
    reactions: msg.reactions ?? [],
  };
}

async function decryptPage(conversationId: string, msgs: MessageDto[]): Promise<DecryptedMessage[]> {
  if (!rt) return [];
  const out: DecryptedMessage[] = [];
  for (const m of msgs) {
    const content = await messaging.decryptMessage(rt.client, rt.identity, conversationId, m);
    out.push(toDecrypted(m, content));
  }
  return out;
}

// ── Loads ─────────────────────────────────────────────────────────────────────
export async function refreshFriends(): Promise<void> {
  if (!rt) return;
  useFriendsStore.getState().setFriends(await rt.client.friends());
}
export async function refreshConversations(): Promise<void> {
  if (!rt) return;
  const { conversations } = await rt.client.conversations();
  useConversationsStore.getState().setAll(conversations);
  void resolveTitles();
}

/** Fills in display titles: group name, or (for a DM) the peer's username.
 * Non-blocking; DM titles need one members fetch each, so only resolve missing. */
async function resolveTitles(): Promise<void> {
  if (!rt) return;
  const state = useConversationsStore.getState();
  for (const conv of state.conversations) {
    if (state.titles[conv.id]) continue;
    if (conv.kind === "group") {
      useConversationsStore.getState().setTitle(conv.id, conv.name?.trim() || "Groupe");
      continue;
    }
    try {
      const { members } = await rt.client.conversationMembers(conv.id);
      const peer = members.find((m) => m.user_id !== rt?.myUserId);
      useConversationsStore.getState().setTitle(conv.id, peer?.username ?? "Conversation");
      if (peer) {
        useConversationsStore.getState().setPeer(conv.id, {
          userId: peer.user_id,
          displayName: peer.display_name?.trim() || peer.username,
          avatarUrl: peer.avatar_url ?? null,
        });
      }
    } catch {
      /* leave untitled; a later refresh retries */
    }
  }
}
/** Fetch + decrypt one page of server-stored (legacy X25519) messages, ascending.
 * Used both by the legacy load and by MLS conversations to surface pre-cutover
 * history (the server kept those rows; only new messages moved to the MLS log). */
async function legacyPageAscending(
  conversationId: string,
  opts: { limit: number; before?: string },
): Promise<{ messages: DecryptedMessage[]; cursor: string | null }> {
  if (!rt) return { messages: [], cursor: null };
  const page = await rt.client.messages(conversationId, rt.identity.deviceId, opts);
  const ascending = (await decryptPage(conversationId, page.messages)).reverse();
  return { messages: ascending, cursor: page.next_cursor };
}
export async function loadMessages(conversationId: string): Promise<void> {
  if (!rt) return;
  try {
    const { messages, cursor } = await legacyPageAscending(conversationId, { limit: PAGE });
    useMessagesStore.getState().setInitial(conversationId, messages, cursor);
  } catch (e) {
    // Otherwise the view is stranded on a perpetual skeleton (loaded stays false).
    useMessagesStore.getState().setLoadError(conversationId, true);
    throw e;
  }
}
export async function loadOlder(conversationId: string): Promise<void> {
  if (!rt) return;
  const cursor = useMessagesStore.getState().cursor[conversationId];
  if (!cursor) return;
  const page = await rt.client.messages(conversationId, rt.identity.deviceId, {
    before: cursor,
    limit: PAGE,
  });
  const older = (await decryptPage(conversationId, page.messages)).reverse();
  useMessagesStore.getState().prependOlder(conversationId, older, page.next_cursor);
}

// ── MLS (Phase 3) dual-path ────────────────────────────────────────────────────
// Routing is server-authoritative (Lot 5): the conversation's `protocol` flag
// decides MLS vs legacy X25519. MLS messages live in the ordered frame log, not the
// `messages` table, and — under forward secrecy — cannot be re-decrypted once
// processed, so recovered plaintext is kept in the store rather than re-fetched.
// The server only ever sees opaque frames.

/** Whether a conversation runs over MLS — the server's protocol flag is truth. */
function isMls(conversationId: string): boolean {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === conversationId);
  return conv?.protocol === "mls";
}

/** Optimistically reflect a protocol cutover locally (the server call confirms it). */
function setLocalProtocol(conversationId: string, protocol: "x25519" | "mls"): void {
  const store = useConversationsStore.getState();
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (conv && conv.protocol !== protocol) store.upsert({ ...conv, protocol });
}

/** The plaintext carried inside an MLS application frame: a small versioned
 * envelope so recovered messages keep author + timestamp + attachments. A raw
 * (non-envelope) string — e.g. a console-sent test — is treated as plain text. */
interface MlsEnvelope {
  v: 1;
  sid: string; // sender user id, asserted inside the ciphertext
  ts: string; // ISO send time
  text?: string;
  attachments?: messaging.AttachmentRef[];
  reply?: string; // parent message id this replies to (E2EE: rides inside the ciphertext)
  /** Edit frame: the mls message id whose text this replaces (author-only; the
   * frame is NOT a new message — receivers patch the target in place). */
  edit?: string;
  /** Pin frame: the mls message id being (un)pinned; `pinOn` says which. Any
   * member may pin. Like edits, a pin frame never becomes a message row. */
  pin?: string;
  pinOn?: boolean;
  /** Reaction frame: toggle `emoji` by `sid` on message `id`. Aggregation is
   * client-side (the server sees only an opaque frame). */
  react?: { id: string; emoji: string; on: boolean };
  /** Link-preview frame: the SENDER fetched the page and attaches the metadata
   * to message `id` after the fact (sending is never blocked on the fetch). */
  prev?: { id: string; url: string; title: string; desc?: string; host: string };
  /** Side-thread parent: this message belongs to `thread`'s thread and is
   * hidden from the main flow (rendered in the thread panel instead). */
  thread?: string;
}

function decodeMlsEnvelope(plaintext: string): {
  content: messaging.MessageContent;
  senderId: string | null;
  ts: string | null;
  replyTo: string | null;
  threadOf: string | null;
  editOf: string | null;
  pinOf: { id: string; on: boolean } | null;
  reactOf: { id: string; emoji: string; on: boolean } | null;
  previewOf: { id: string; preview: LinkPreview } | null;
} {
  try {
    const e = JSON.parse(plaintext) as Partial<MlsEnvelope>;
    if (e && e.v === 1) {
      return {
        content: { text: e.text, attachments: e.attachments },
        senderId: e.sid ?? null,
        ts: e.ts ?? null,
        replyTo: e.reply ?? null,
        threadOf: e.thread ?? null,
        editOf: e.edit ?? null,
        pinOf: e.pin ? { id: e.pin, on: e.pinOn !== false } : null,
        reactOf:
          e.react && typeof e.react.id === "string" && typeof e.react.emoji === "string"
            ? { id: e.react.id, emoji: e.react.emoji, on: e.react.on !== false }
            : null,
        previewOf:
          e.prev && typeof e.prev.id === "string" && typeof e.prev.title === "string"
            ? {
                id: e.prev.id,
                preview: {
                  url: e.prev.url,
                  title: e.prev.title,
                  desc: e.prev.desc,
                  host: e.prev.host,
                },
              }
            : null,
      };
    }
  } catch {
    /* not JSON / not an envelope — treat as raw text below */
  }
  return {
    content: { text: plaintext },
    senderId: null,
    ts: null,
    replyTo: null,
    threadOf: null,
    editOf: null,
    pinOf: null,
    reactOf: null,
    previewOf: null,
  };
}

// ── MLS message edits ────────────────────────────────────────────────────────
// An edit is an ordinary application frame whose envelope carries `edit` (the
// target's mls id). It never becomes a new row: receivers patch the target's
// text + editedAt. Frames are server-ordered, so an edit always FOLLOWS its
// target in the log — but the target may live in a page (or a device history)
// we haven't loaded, so unmatched edits wait per conversation and are replayed
// after the history load.

interface MlsEdit {
  targetId: string;
  text?: string;
  ts: string | null;
  sid: string | null;
}

/** conversation → target id → newest pending (unmatched) edit. */
const pendingMlsEdits = new Map<string, Map<string, MlsEdit>>();

function applyMlsEdit(conversationId: string, edit: MlsEdit): void {
  if (!rt) return;
  const store = useMessagesStore.getState();
  const target = store.byConversation[conversationId]?.find((m) => m.id === edit.targetId);
  if (!target) {
    const perConv = pendingMlsEdits.get(conversationId) ?? new Map<string, MlsEdit>();
    const prev = perConv.get(edit.targetId);
    if (!prev || (edit.ts ?? "") >= (prev.ts ?? "")) perConv.set(edit.targetId, edit);
    pendingMlsEdits.set(conversationId, perConv);
    return;
  }
  if (target.deleted || !target.content) return;
  // Author-only: MLS authenticates the sender inside the ciphertext (sid).
  if (edit.sid && target.senderId && edit.sid !== target.senderId) return;
  // Newest edit wins (ts tiebreak protects replayed/parallel recovery paths).
  if (target.editedAt && edit.ts && edit.ts < target.editedAt) return;
  const patched: DecryptedMessage = {
    ...target,
    content: { ...target.content, text: edit.text },
    editedAt: edit.ts ?? new Date().toISOString(),
  };
  store.upsert(conversationId, patched);
  void appendMlsMessages(rt.instanceId, conversationId, [patched]); // history mirrors the patch
}

/** A pin/unpin op decoded from a frame (or applied locally as the echo). */
interface MlsPin {
  targetId: string;
  on: boolean;
  ts: string | null;
}

/** conversation → target id → newest pending (unmatched) pin op. */
const pendingMlsPins = new Map<string, Map<string, MlsPin>>();

function applyMlsPin(conversationId: string, pin: MlsPin): void {
  if (!rt) return;
  const store = useMessagesStore.getState();
  const target = store.byConversation[conversationId]?.find((m) => m.id === pin.targetId);
  if (!target) {
    const perConv = pendingMlsPins.get(conversationId) ?? new Map<string, MlsPin>();
    const prev = perConv.get(pin.targetId);
    if (!prev || (pin.ts ?? "") >= (prev.ts ?? "")) perConv.set(pin.targetId, pin);
    pendingMlsPins.set(conversationId, perConv);
    return;
  }
  if (target.deleted || Boolean(target.pinned) === pin.on) return;
  const patched: DecryptedMessage = { ...target, pinned: pin.on };
  store.upsert(conversationId, patched);
  void appendMlsMessages(rt.instanceId, conversationId, [patched]);
}

/** A reaction toggle decoded from a frame (or applied locally as the echo). */
interface MlsReaction {
  targetId: string;
  emoji: string;
  on: boolean;
  sid: string | null;
}

/** conversation → ORDERED unmatched reaction toggles (order matters: they are
 * toggles, so replay must preserve the log sequence, unlike edits/pins where
 * newest-wins suffices). */
const pendingMlsReactions = new Map<string, MlsReaction[]>();

function applyMlsReaction(conversationId: string, reaction: MlsReaction): void {
  if (!rt || !reaction.sid) return; // an anonymous reaction is meaningless
  const store = useMessagesStore.getState();
  const target = store.byConversation[conversationId]?.find((m) => m.id === reaction.targetId);
  if (!target) {
    const list = pendingMlsReactions.get(conversationId) ?? [];
    list.push(reaction);
    pendingMlsReactions.set(conversationId, list);
    return;
  }
  if (target.deleted) return;
  const users = { ...(target.reactionUsers ?? {}) };
  const current = new Set(users[reaction.emoji] ?? []);
  if (reaction.on) current.add(reaction.sid);
  else current.delete(reaction.sid);
  if (current.size > 0) users[reaction.emoji] = [...current];
  else delete users[reaction.emoji];
  const reactions: Reaction[] = Object.entries(users).map(([emoji, ids]) => ({
    emoji,
    count: ids.length,
    me: ids.includes(rt!.myUserId),
  }));
  const patched: DecryptedMessage = { ...target, reactionUsers: users, reactions };
  store.upsert(conversationId, patched);
  void appendMlsMessages(rt.instanceId, conversationId, [patched]);
}

/** conversation → target id → link preview waiting for its target. */
const pendingMlsPreviews = new Map<string, Map<string, LinkPreview>>();

function applyMlsPreview(conversationId: string, targetId: string, preview: LinkPreview): void {
  if (!rt) return;
  const store = useMessagesStore.getState();
  const target = store.byConversation[conversationId]?.find((m) => m.id === targetId);
  if (!target) {
    const perConv = pendingMlsPreviews.get(conversationId) ?? new Map<string, LinkPreview>();
    perConv.set(targetId, preview);
    pendingMlsPreviews.set(conversationId, perConv);
    return;
  }
  if (target.deleted || target.preview) return; // first preview wins
  const patched: DecryptedMessage = { ...target, preview };
  store.upsert(conversationId, patched);
  void appendMlsMessages(rt.instanceId, conversationId, [patched]);
}

/** Replay edits/pins/reactions that arrived before their target was loaded. */
function flushPendingMlsOps(conversationId: string): void {
  const edits = pendingMlsEdits.get(conversationId);
  if (edits) {
    pendingMlsEdits.delete(conversationId);
    for (const edit of edits.values()) applyMlsEdit(conversationId, edit);
  }
  const pins = pendingMlsPins.get(conversationId);
  if (pins) {
    pendingMlsPins.delete(conversationId);
    for (const pin of pins.values()) applyMlsPin(conversationId, pin);
  }
  const reactions = pendingMlsReactions.get(conversationId);
  if (reactions) {
    pendingMlsReactions.delete(conversationId);
    for (const reaction of reactions) applyMlsReaction(conversationId, reaction);
  }
  const previews = pendingMlsPreviews.get(conversationId);
  if (previews) {
    pendingMlsPreviews.delete(conversationId);
    for (const [targetId, preview] of previews) applyMlsPreview(conversationId, targetId, preview);
  }
}

/** order_seq → a stable, time-sortable message id (zero-padded so the store's id
 * tiebreak follows the server's frame ordering). */
const mlsMessageId = (orderSeq: number): string => `mls:${String(orderSeq).padStart(12, "0")}`;

function mlsToDecrypted(
  orderSeq: number,
  senderId: string | null,
  content: messaging.MessageContent | null,
  ts: string | null,
  replyTo: string | null = null,
  threadOf: string | null = null,
): DecryptedMessage {
  return {
    id: mlsMessageId(orderSeq),
    senderId,
    senderDevice: "mls", // MLS authenticates at the group level, not per wire-device
    createdAt: ts ?? new Date().toISOString(),
    editedAt: null,
    deleted: false,
    content,
    replyTo,
    threadOf,
    reactions: [], // filled client-side as encrypted reaction frames arrive
  };
}

/** Encrypt + submit an application message over MLS, then echo it locally: our own
 * frame is not re-decryptable (forward secrecy), so it is keyed by the
 * server-assigned order_seq for the store to dedupe against a later sync. */
async function sendMlsMessage(
  conversationId: string,
  content: messaging.MessageContent,
  replyTo?: string | null,
  ts: string = new Date().toISOString(),
  threadOf?: string | null,
): Promise<void> {
  if (!rt) return;
  const env: MlsEnvelope = {
    v: 1,
    sid: rt.myUserId,
    ts,
    text: content.text,
    attachments: content.attachments,
    reply: replyTo ?? undefined,
    thread: threadOf ?? undefined,
  };
  const orderSeq = await mls.sendMls(rt.client, rt.instanceId, conversationId, JSON.stringify(env));
  const msg = mlsToDecrypted(orderSeq, rt.myUserId, content, ts, replyTo ?? null, threadOf ?? null);
  useMessagesStore.getState().upsert(conversationId, msg);
  void appendMlsMessages(rt.instanceId, conversationId, [msg]); // survive reload (forward secrecy)
  // Link preview, detached: never delays the send; the metadata follows as an
  // op frame once (and if) the sender-side fetch succeeds.
  const firstUrl = content.text?.match(/https?:\/\/[^\s<>"')]+/i)?.[0];
  if (firstUrl) void generateMlsLinkPreview(conversationId, msg.id, firstUrl);
}

/** Sender-side preview: fetch natively (CORS-free), then attach via op frame. */
async function generateMlsLinkPreview(
  conversationId: string,
  messageId: string,
  url: string,
): Promise<void> {
  if (!rt || !isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const preview = await invoke<LinkPreview | null>("fetch_link_preview", { url });
    if (!rt || !preview) return;
    const env: MlsEnvelope = {
      v: 1,
      sid: rt.myUserId,
      ts: new Date().toISOString(),
      prev: { id: messageId, ...preview },
    };
    await mls.sendMls(rt.client, rt.instanceId, conversationId, JSON.stringify(env));
    applyMlsPreview(conversationId, messageId, preview); // our echo (FS)
  } catch {
    /* no preview is a perfectly fine outcome */
  }
}

/**
 * Send over MLS with an optimistic UI: insert a temporary "pending" row instantly,
 * then on success drop it (sendMlsMessage upserts the real, order_seq-keyed row) or
 * on failure flip it to "failed" so the user sees an inline retry instead of the
 * message silently vanishing for the MLS round-trip. Never throws.
 */
async function deliverMlsOptimistic(
  conversationId: string,
  content: messaging.MessageContent,
  replyTo: string | null,
): Promise<void> {
  if (!rt) return;
  const tempId = `pending-${crypto.randomUUID()}`;
  const ts = new Date().toISOString();
  useMessagesStore.getState().upsert(conversationId, {
    id: tempId,
    senderId: rt.myUserId,
    senderDevice: "mls",
    createdAt: ts,
    editedAt: null,
    deleted: false,
    content,
    replyTo,
    reactions: [],
    status: "pending",
  });
  try {
    // Reuse the optimistic timestamp so the confirmed row sorts in the same slot.
    await sendMlsMessage(conversationId, content, replyTo, ts);
    useMessagesStore.getState().removeMessage(conversationId, tempId);
  } catch (e) {
    // A diverged group can't send (the server 409s the stale epoch): kick the
    // self-repair in the background; the user retries once it has rejoined.
    if (e instanceof MlsDivergenceError && rt) {
      void mls
        .repairMlsGroup(rt.client, rt.instanceId, conversationId, rt.identity.deviceId)
        .then((ok) => ok && console.info("MLS group repaired; retry the message"))
        .catch(() => {});
    }
    useMessagesStore.getState().setStatus(conversationId, tempId, "failed");
  }
}

/** Retry a failed optimistic message: drop the failed row and re-deliver its content. */
export async function retryMessage(conversationId: string, messageId: string): Promise<void> {
  const list = useMessagesStore.getState().byConversation[conversationId] ?? [];
  const failed = list.find((m) => m.id === messageId);
  if (!failed || failed.status !== "failed" || !failed.content) return;
  useMessagesStore.getState().removeMessage(conversationId, messageId);
  await deliverMlsOptimistic(conversationId, failed.content, failed.replyTo);
}

/**
 * Opt a conversation into MLS: create its group, add every other member's devices
 * (they join via the Welcome mailbox), and route it through MLS from now on.
 * Requires the native engine (Tauri).
 */
export async function enableMlsForConversation(conversationId: string): Promise<void> {
  if (!rt) return;
  // 0. Drain the Welcome mailbox FIRST: if a peer already created the group and
  //    added this device, that join IS the enable — no second group is built.
  await mls
    .joinPendingWelcomes(rt.client, rt.instanceId, rt.identity.deviceId)
    .catch(() => [] as string[]);
  if (await mls.isMlsGroupJoined(rt.instanceId, conversationId)) {
    await rt.client.createMlsGroup(conversationId); // ensure the ordering row (no-op)
    await finishMlsEnable(conversationId);
    return;
  }

  // 1. Server-arbitrated creation: exactly ONE device ever gets `created: true`
  //    per group. Everyone else must be added by a member — never fork locally.
  const status = await rt.client.createMlsGroup(conversationId);
  if (status.created === false && (status.current_epoch ?? 0) > 0) {
    // The real group exists and we're not in it. Wait briefly for our Welcome
    // (the creator queues one as it adds us), then give up with a clear state.
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!rt) return;
      const joined = await mls
        .joinPendingWelcomes(rt.client, rt.instanceId, rt.identity.deviceId)
        .catch(() => [] as string[]);
      if (
        joined.includes(conversationId) ||
        (await mls.isMlsGroupJoined(rt.instanceId, conversationId).catch(() => false))
      ) {
        await finishMlsEnable(conversationId);
        return;
      }
    }
    // Not added yet (creator offline, or our original Welcome was destroyed by
    // an older client). The conversation may already be flagged MLS server-side;
    // reflect that, and let an active member's sweep re-add this device.
    await refreshConversations().catch(() => {});
    throw new Error(
      "Le chiffrement a déjà été activé depuis un autre appareil — en attente de l'invitation au groupe (elle arrive dès qu'un membre actif se reconnecte).",
    );
  }

  // 2. We are the arbitrated creator (or the row is virgin at epoch 0 — e.g. a
  //    leftover of a failed enable; the commit CAS still arbitrates the actual
  //    epoch-0 race, and the loser now REPAIRS instead of forking).
  const { members } = await rt.client.conversationMembers(conversationId);
  const targets: AddTarget[] = [];
  for (const m of members) {
    if (m.user_id === rt.myUserId) continue;
    const bundle = await rt.client.keyBundle(m.user_id).catch(() => null);
    const deviceIds = bundle?.devices.map((d) => d.device_id) ?? [];
    if (deviceIds.length) targets.push({ userId: m.user_id, deviceIds });
  }
  try {
    await mls.startMlsGroup(
      rt.client,
      rt.instanceId,
      conversationId,
      targets,
      deliverSwept(conversationId),
    );
  } catch (e) {
    if (e instanceof MlsDivergenceError && rt) {
      // Lost the epoch-0 creation race: wipe our fork and join the winner via
      // the Welcome it queued for us.
      const repaired = await mls.repairMlsGroup(
        rt.client,
        rt.instanceId,
        conversationId,
        rt.identity.deviceId,
      );
      if (!repaired) {
        throw new Error(
          "Resynchronisation du chiffrement en cours — réessayez dans un instant.",
        );
      }
    } else {
      throw e;
    }
  }
  await finishMlsEnable(conversationId);
}

/** Cut the conversation over to MLS server-side (authoritative), reflect it
 * locally, and show the going-forward MLS thread rather than a skeleton. */
async function finishMlsEnable(conversationId: string): Promise<void> {
  if (!rt) return;
  await rt.client.setConversationProtocol(conversationId, "mls");
  setLocalProtocol(conversationId, "mls");
  const cur = useMessagesStore.getState().byConversation[conversationId] ?? [];
  useMessagesStore.getState().setInitial(conversationId, cur, null);
}

// MLS-only (v0.7): the downgrade path (disableMlsForConversation) is gone —
// the server refuses protocol downgrades and the UI no longer offers one.

/**
 * An MLS frame arrived (or an MLS conversation was opened): if a peer just added
 * this device, drain the Welcome mailbox; then pull + decrypt new frames and merge
 * the recovered messages into the store (advancing the persisted replay cursor).
 */
export async function onMlsFrame(conversationId: string): Promise<void> {
  if (!rt) return;
  if (!(await mls.isMlsGroupJoined(rt.instanceId, conversationId).catch(() => false))) {
    await mls.joinPendingWelcomes(rt.client, rt.instanceId, rt.identity.deviceId).catch(() => []);
    if (await mls.isMlsGroupJoined(rt.instanceId, conversationId).catch(() => false)) {
      // A peer added us + cut the conversation over — refresh so its protocol flag
      // (now 'mls') is known and future sends route through MLS.
      await refreshConversations().catch(() => {});
    } else {
      return; // no group state yet — nothing to sync
    }
  }
  const { messages: recovered, failures } = await mls
    .receiveMls(rt.client, rt.instanceId, conversationId)
    .catch(() => ({ messages: [] as SyncedMessage[], failures: 0 }));
  // Frames we should have been able to process but couldn't → divergence check
  // (and self-repair) in the background.
  if (failures > 0) void checkAndRepairDivergence(conversationId);
  // Proactive post-compromise-security heartbeat: rotate our own leaf key if this
  // group is overdue (throttled to once a day per group). Best-effort + detached
  // so it never blocks rendering the messages we just recovered — its commit sync
  // can sweep up peer frames, which the onSwept callback delivers (else lost).
  void mls
    .maybeRekeyMlsGroup(rt.client, rt.instanceId, conversationId, deliverSwept(conversationId))
    .catch(() => {});
  // Membership sweep (throttled): add any conversation device missing from the
  // tree — lost Welcomes, self-repaired peers, members added after the cutover.
  void sweepConversationDevices(conversationId).catch(() => {});
  await deliverMlsMessages(conversationId, recovered);
}

/**
 * Divergence check: we hold a group but could not process current-epoch frames.
 * If the server's epoch is ahead of ours, our local group is not THE group —
 * wipe it and rejoin from the (still-pending) Welcome, then drain what we can.
 * When we are the healthy side (a PEER is the diverged one), the epochs match
 * and this is a no-op.
 */
async function checkAndRepairDivergence(conversationId: string): Promise<void> {
  if (!rt) return;
  try {
    const status = await rt.client.createMlsGroup(conversationId); // idempotent server-epoch read
    const serverEpoch = status.current_epoch;
    const localEpoch = await mlsEngine.groupEpoch(rt.instanceId, conversationId).catch(() => null);
    if (serverEpoch === undefined || localEpoch === null || serverEpoch <= localEpoch) return;
    console.warn(
      `MLS divergence detected for ${conversationId} (local epoch ${localEpoch}, server ${serverEpoch}) — repairing`,
    );
    const repaired = await mls.repairMlsGroup(
      rt.client,
      rt.instanceId,
      conversationId,
      rt.identity.deviceId,
    );
    if (repaired && rt) {
      const { messages } = await mls
        .receiveMls(rt.client, rt.instanceId, conversationId)
        .catch(() => ({ messages: [] as SyncedMessage[], failures: 0 }));
      await deliverMlsMessages(conversationId, messages);
    }
  } catch (e) {
    console.warn("MLS divergence check failed", e);
  }
}

/** Collect the conversation's expected devices (peers' + our own others) and add
 * any missing from the MLS tree. Throttled per group unless `force`. */
async function sweepConversationDevices(conversationId: string, force = false): Promise<void> {
  if (!rt || !isMls(conversationId)) return;
  if (!force && !mls.shouldSweepMembers(rt.instanceId, conversationId)) return;
  if (!(await mls.isMlsGroupJoined(rt.instanceId, conversationId).catch(() => false))) return;
  try {
    const { members } = await rt.client.conversationMembers(conversationId);
    const expected: AddTarget[] = [];
    for (const m of members) {
      if (!rt) return;
      const bundle = await rt.client.keyBundle(m.user_id).catch(() => null);
      let deviceIds = bundle?.devices.map((d) => d.device_id) ?? [];
      if (m.user_id === rt.myUserId) {
        deviceIds = deviceIds.filter((d) => d !== rt!.identity.deviceId);
      }
      if (deviceIds.length) expected.push({ userId: m.user_id, deviceIds });
    }
    if (!rt) return;
    await mls.sweepMissingDevices(
      rt.client,
      rt.instanceId,
      conversationId,
      expected,
      deliverSwept(conversationId),
    );
  } catch (e) {
    console.warn("MLS device sweep failed", e);
  }
}

/** An onSwept callback for the MLS commit ops: delivers, detached, whatever peer
 * messages a commit's catch-up sync swept out of the ordered log. */
const deliverSwept = (conversationId: string) => (swept: SyncedMessage[]) => {
  void deliverMlsMessages(conversationId, swept);
};

/** Decode → store → persist → notify → update-unread for MLS application messages
 * recovered from the ordered frame log — whether by a plain receive or swept up by
 * a commit's catch-up sync (add/remove/self-update). Idempotent per order_seq, so
 * it is safe to call from multiple recovery paths. */
async function deliverMlsMessages(
  conversationId: string,
  recovered: SyncedMessage[],
): Promise<void> {
  if (!rt || recovered.length === 0) return;

  const store = useMessagesStore.getState();
  const decrypted: DecryptedMessage[] = [];
  const edits: MlsEdit[] = [];
  const pins: MlsPin[] = [];
  const reactions: MlsReaction[] = [];
  const previews: { targetId: string; preview: LinkPreview }[] = [];
  for (const m of recovered) {
    const { content, senderId, ts, replyTo, threadOf, editOf, pinOf, reactOf, previewOf } =
      decodeMlsEnvelope(m.plaintext);
    if (editOf) {
      edits.push({ targetId: editOf, text: content.text, ts, sid: senderId ?? m.senderId });
    } else if (pinOf) {
      pins.push({ targetId: pinOf.id, on: pinOf.on, ts });
    } else if (previewOf) {
      previews.push({ targetId: previewOf.id, preview: previewOf.preview });
    } else if (reactOf) {
      reactions.push({
        targetId: reactOf.id,
        emoji: reactOf.emoji,
        on: reactOf.on,
        sid: senderId ?? m.senderId,
      });
    } else {
      decrypted.push(
        mlsToDecrypted(m.orderSeq, senderId ?? m.senderId, content, ts, replyTo, threadOf),
      );
    }
  }
  for (const msg of decrypted) store.upsert(conversationId, msg);
  void appendMlsMessages(rt.instanceId, conversationId, decrypted); // persist before FS consumes the key
  // Apply ops AFTER the inserts: an op and its (older) target can arrive in the
  // same catch-up batch. Ops alone are silent — no notify, no unread.
  for (const edit of edits) applyMlsEdit(conversationId, edit);
  for (const pin of pins) applyMlsPin(conversationId, pin);
  for (const reaction of reactions) applyMlsReaction(conversationId, reaction);
  for (const p of previews) applyMlsPreview(conversationId, p.targetId, p.preview);
  if (decrypted.length === 0) return;

  const last = decrypted[decrypted.length - 1];
  if (last) await maybeNotify(conversationId, last.id, last);

  const conversations = useConversationsStore.getState();
  if (conversations.activeId === conversationId) {
    await markRead(conversationId);
  } else if (!conversations.conversations.some((c) => c.id === conversationId)) {
    await refreshConversations();
  } else {
    conversations.bumpUnread(conversationId);
  }
}

// ── Sends ─────────────────────────────────────────────────────────────────────
export async function sendMessage(
  conversationId: string,
  text: string,
  files: File[] = [],
  replyTo?: string | null,
): Promise<void> {
  if (!rt) return;
  const trimmed = text.trim();
  if (!trimmed && files.length === 0) return;

  const attachments = [];
  for (const file of files) {
    attachments.push(await messaging.encryptAndUpload(rt.client, conversationId, file));
  }
  const content: messaging.MessageContent = {
    text: trimmed || undefined,
    attachments: attachments.length ? attachments : undefined,
  };
  // MLS-only (v0.7): there is no legacy send path anymore. A conversation that
  // somehow isn't MLS yet (bootstrap failed at open, e.g. offline) gets one
  // more upgrade attempt here; if that fails, the send fails loudly rather
  // than silently forking onto a dead protocol.
  if (!isMls(conversationId)) {
    mlsAutoBootstrapped.delete(conversationId);
    await ensureMlsBootstrap(conversationId);
    if (!isMls(conversationId)) {
      throw new Error("Chiffrement MLS indisponible pour cette conversation");
    }
  }
  // Optimistically echo the message as "pending" for instant feedback, then
  // confirm it (drop the temp row — the real echo is upserted) or mark it failed.
  await deliverMlsOptimistic(conversationId, content, replyTo ?? null);
}
export async function editMessage(
  conversationId: string,
  messageId: string,
  text: string,
): Promise<void> {
  if (!rt || !text.trim()) return;
  // Route by MESSAGE, not conversation: an MLS conversation still shows its
  // pre-cutover history as legacy rows (uuid ids, re-decrypted from the server
  // each open) — those edit through the legacy endpoint below.
  if (isMls(conversationId) && messageId.startsWith("mls:")) {
    // MLS: the edit is an application frame referencing the target id — the
    // server sees only an opaque frame. Our own frame won't re-decrypt
    // (forward secrecy), so apply the patch locally as the echo.
    const ts = new Date().toISOString();
    const env: MlsEnvelope = {
      v: 1,
      sid: rt.myUserId,
      ts,
      text: text.trim(),
      edit: messageId,
    };
    await mls.sendMls(rt.client, rt.instanceId, conversationId, JSON.stringify(env));
    applyMlsEdit(conversationId, { targetId: messageId, text: text.trim(), ts, sid: rt.myUserId });
    return;
  }
  const ids = await memberIds(conversationId);
  const payload = await messaging.encryptForMembers(
    rt.client,
    rt.identity,
    conversationId,
    rt.myUserId,
    ids,
    { text },
  );
  await rt.client.editMessage(conversationId, messageId, {
    ciphertext: payload.ciphertext,
    body_nonce: payload.body_nonce,
    recipients: payload.recipients,
  });
}
/** Send a message into a parent message's side-thread (MLS only). Thread
 * replies are ordinary messages carrying `thread` in the envelope — persisted
 * and notified normally, hidden from the main flow, shown in the panel. */
export async function sendThreadMessage(
  conversationId: string,
  parentId: string,
  text: string,
): Promise<void> {
  if (!rt || !isMls(conversationId) || !parentId.startsWith("mls:") || !text.trim()) return;
  await sendMlsMessage(
    conversationId,
    { text: text.trim() },
    null,
    new Date().toISOString(),
    parentId,
  );
}

/** Pin or unpin an MLS message: an application frame any member may send; the
 * local patch is our echo (our own frame won't re-decrypt under FS). */
export async function pinMessage(
  conversationId: string,
  messageId: string,
  on: boolean,
): Promise<void> {
  if (!rt || !isMls(conversationId) || !messageId.startsWith("mls:")) return;
  const ts = new Date().toISOString();
  const env: MlsEnvelope = { v: 1, sid: rt.myUserId, ts, pin: messageId, pinOn: on };
  await mls.sendMls(rt.client, rt.instanceId, conversationId, JSON.stringify(env));
  applyMlsPin(conversationId, { targetId: messageId, on, ts });
}

export async function deleteMessage(conversationId: string, messageId: string): Promise<void> {
  if (!rt) return;
  // MLS messages have no server-side row (they live in the opaque frame log); a
  // delete is local-only, and persisted so it survives a reload.
  if (isMls(conversationId)) {
    void markMlsDeleted(rt.instanceId, conversationId, messageId);
  } else {
    await rt.client.deleteMessage(conversationId, messageId);
  }
  useMessagesStore.getState().markDeleted(conversationId, messageId);
}

/** Instance moderation: delete SOMEONE ELSE's message everywhere. Legacy rows
 * die server-side; MLS messages (server-unaddressable E2EE frames) get a
 * moderation tombstone that is broadcast live and replayed to history loads. */
export async function moderateDeleteMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  if (!rt) return;
  if (messageId.startsWith("mls:")) {
    await rt.client.moderateTombstone(conversationId, messageId);
    void markMlsDeleted(rt.instanceId, conversationId, messageId);
  } else {
    await rt.client.deleteMessage(conversationId, messageId);
  }
  useMessagesStore.getState().markDeleted(conversationId, messageId);
}
/**
 * Toggle the local user's emoji reaction on a message. MLS-native messages
 * (mls: ids) send an encrypted reaction frame and aggregate client-side; the
 * local apply is our echo (FS), and a failed send applies the inverse. Legacy
 * rows (uuid ids — including pre-cutover history inside MLS conversations) keep
 * the optimistic server path, reconciled via MESSAGE_REACTED.
 */
export async function toggleReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  if (!rt) return;
  if (isMls(conversationId) && messageId.startsWith("mls:")) {
    const msg = (useMessagesStore.getState().byConversation[conversationId] ?? []).find(
      (m) => m.id === messageId,
    );
    if (!msg || msg.deleted) return;
    const on = !(msg.reactionUsers?.[emoji] ?? []).includes(rt.myUserId);
    const me = rt.myUserId;
    applyMlsReaction(conversationId, { targetId: messageId, emoji, on, sid: me }); // echo
    const env: MlsEnvelope = {
      v: 1,
      sid: me,
      ts: new Date().toISOString(),
      react: { id: messageId, emoji, on },
    };
    try {
      await mls.sendMls(rt.client, rt.instanceId, conversationId, JSON.stringify(env));
    } catch {
      // The frame never left — undo the echo so the chip reflects reality.
      applyMlsReaction(conversationId, { targetId: messageId, emoji, on: !on, sid: me });
    }
    return;
  }
  // Legacy rows (uuid ids) — including inside MLS conversations — use the
  // server path below.
  const store = useMessagesStore.getState();
  const msg = (store.byConversation[conversationId] ?? []).find((m) => m.id === messageId);
  if (!msg || msg.deleted) return;

  const current = msg.reactions;
  const existing = current.find((r) => r.emoji === emoji);
  let optimistic: Reaction[];
  if (!existing) {
    optimistic = [...current, { emoji, count: 1, me: true }];
  } else if (!existing.me) {
    optimistic = current.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, me: true } : r));
  } else if (existing.count > 1) {
    optimistic = current.map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, me: false } : r));
  } else {
    optimistic = current.filter((r) => r.emoji !== emoji);
  }
  store.setReactions(conversationId, messageId, optimistic);

  try {
    await rt.client.toggleReaction(conversationId, messageId, emoji);
  } catch {
    // Reconcile to the server's truth on failure (reverts the optimistic change).
    await onMessageReacted(conversationId, messageId).catch(() => {});
  }
}

/** A message's reactions changed (own action echo or a peer's): re-fetch the
 * aggregated buckets and reconcile. Ignores messages this device doesn't hold. */
export async function onMessageReacted(conversationId: string, messageId: string): Promise<void> {
  if (!rt) return;
  const held = (useMessagesStore.getState().byConversation[conversationId] ?? []).some(
    (m) => m.id === messageId,
  );
  if (!held) return;
  const { reactions } = await rt.client
    .messageReactions(conversationId, messageId)
    .catch(() => ({ reactions: [] as Reaction[] }));
  useMessagesStore.getState().setReactions(conversationId, messageId, reactions);
}

export async function markRead(conversationId: string): Promise<void> {
  if (!rt) return;
  if (isMls(conversationId)) {
    // Local mls: ids are order numbers, not server rows — no id means "read up
    // to now" server-side. Skipping the call entirely (the old behavior) left
    // the server's last_read_at frozen, so the unread badge and the divider
    // resurrected on every reload.
    await rt.client.markRead(conversationId).catch(() => {});
  } else {
    const msgs = useMessagesStore.getState().byConversation[conversationId] ?? [];
    const last = msgs[msgs.length - 1];
    if (last) await rt.client.markRead(conversationId, last.id).catch(() => {});
  }
  useConversationsStore.getState().clearUnread(conversationId);
}
export function sendTyping(conversationId: string): void {
  rt?.ws.send({ type: "TYPING", conversation_id: conversationId });
}
/** Set the local user's presence and broadcast it to the server (other devices +
 * peers). Local state updates even when offline; the socket send is best-effort. */
export function setPresenceStatus(status: PresenceStatus): void {
  usePresenceStore.getState().setMyStatus(status);
  rt?.ws.send({ type: "UPDATE_PRESENCE", status });
}
/** Set (or clear, with "") the local user's custom status text and broadcast it.
 * Sends the CURRENT status so the required field is present; the server treats an
 * empty string as "clear" and a present status alone never wipes existing text.
 * An optional expiry auto-clears the text later (per instance, survives restarts;
 * swept at connect + every minute). */
export function setPresenceStatusText(text: string, expiresAt?: string | null): void {
  usePresenceStore.getState().setMyStatusText(text);
  rt?.ws.send({
    type: "UPDATE_PRESENCE",
    status: usePresenceStore.getState().myStatus,
    status_text: text,
  });
  try {
    if (rt) {
      const key = `accord.statusText.expiresAt.${rt.instanceId}`;
      if (text && expiresAt) localStorage.setItem(key, expiresAt);
      else localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable — the status just won't auto-clear */
  }
}

/** Clear the custom status once its expiry passes. Runs at connect and on a
 * minute tick (module scope: survives provider remounts, no-ops without rt). */
export function sweepStatusTextExpiry(): void {
  if (!rt) return;
  try {
    const key = `accord.statusText.expiresAt.${rt.instanceId}`;
    const expiresAt = localStorage.getItem(key);
    if (expiresAt && Date.now() >= Date.parse(expiresAt)) {
      localStorage.removeItem(key);
      if (usePresenceStore.getState().myStatusText) setPresenceStatusText("");
    }
  } catch {
    /* ignore */
  }
}
setInterval(sweepStatusTextExpiry, 60_000);
/** Update a group's name and/or description, then refresh the list + title. */
export async function updateGroupProfile(
  conversationId: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  if (!rt) return;
  await rt.client.updateGroup(conversationId, patch);
  if (patch.name?.trim()) {
    useConversationsStore.getState().setTitle(conversationId, patch.name.trim());
  }
  await refreshConversations();
}

/** Upload + commit a group avatar (pre-processed blob), then refresh. */
export async function uploadGroupAvatar(
  conversationId: string,
  blob: Blob,
  mime: string,
): Promise<void> {
  if (!rt) return;
  const ticket = await rt.client.requestGroupAvatarUpload(conversationId, blob.size);
  const put = await fetch(ticket.upload_url, {
    method: "PUT",
    body: blob,
    headers: { "content-type": mime },
  });
  if (!put.ok) throw new Error(`upload failed (${put.status})`);
  await rt.client.commitGroupAvatar(conversationId, ticket.version);
  await refreshConversations();
}

export async function downloadAttachment(ref: messaging.AttachmentRef): Promise<Uint8Array | null> {
  if (!rt) return null;
  return messaging.downloadAndDecrypt(rt.client, ref);
}
/** Derive the E2EE call media key from the conversation's MLS group exporter
 * (Phase 4 · Lot 4), or null when there's no MLS group (legacy conversation or
 * browser dev) — the call then falls back to cleartext media (dev only). */
export async function requestCallKey(conversationId: string): Promise<Uint8Array | null> {
  if (!rt) return null;
  return mls.callMediaKey(rt.instanceId, conversationId);
}
/** Signal a call ended / declined (Phase 4, ring lifecycle). Best-effort. */
export async function endCall(conversationId: string, callId: string): Promise<void> {
  if (!rt) return;
  await rt.client.callEnd(conversationId, callId).catch(() => {});
}
/** Join (or start) the conversation's call — records us in the server-authoritative
 * roster, mints a LiveKit token, and (first joiner) rings the others (Phase 4 · L5c). */
export async function joinCall(
  conversationId: string,
  media: string,
): Promise<{
  call_id: string;
  is_new: boolean;
  url: string;
  room: string;
  token: string;
  participants: string[];
} | null> {
  if (!rt) return null;
  return rt.client.callJoin(conversationId, media, rt.identity.deviceId).catch(() => null);
}
/** Leave the conversation's call server-side (Phase 4 · L5c). Best-effort. The
 * server emits CALL_PARTICIPANT_LEFT, or CALL_END when we were the last one. */
export async function leaveCallOnServer(conversationId: string): Promise<void> {
  if (!rt) return;
  await rt.client.callLeave(conversationId, rt.identity.deviceId).catch(() => {});
}
/** Join an EXISTING call as a pop-out spectator (video-only viewer window):
 * a dedicated device id (marked) so the main device isn't evicted and the
 * roster filter hides it. No heartbeat — a dead viewer is TTL-pruned. */
export async function joinCallAsViewer(conversationId: string): Promise<{
  viewerDevice: string;
  creds: { url: string; token: string };
} | null> {
  if (!rt) return null;
  const viewerDevice = `${rt.identity.deviceId}${VIEWER_MARK}${Math.random().toString(36).slice(2, 8)}`;
  const creds = await rt.client.callJoin(conversationId, "audio", viewerDevice).catch(() => null);
  return creds ? { viewerDevice, creds: { url: creds.url, token: creds.token } } : null;
}
export async function leaveCallAsViewer(
  conversationId: string,
  viewerDevice: string,
): Promise<void> {
  if (!rt) return;
  await rt.client.callLeave(conversationId, viewerDevice).catch(() => {});
}
/** Refresh our call-roster liveness while in a call (Phase 4 · L5c). Best-effort. */
export async function heartbeatCall(conversationId: string): Promise<void> {
  if (!rt) return;
  await rt.client.callHeartbeat(conversationId, rt.identity.deviceId).catch(() => {});
}
/** The conversation's live call from the server-authoritative roster (Phase 4 · L5c),
 * or null on error. Used to decide teardown on a peer leave/end. Carries `call_id`
 * so the caller can confirm the state still belongs to the call it's deciding on. */
export async function getCallState(
  conversationId: string,
): Promise<{ active: boolean; call_id?: string; participants: string[] } | null> {
  if (!rt) return null;
  return rt.client.callGetState(conversationId).catch(() => null);
}
/** Resolve a user's display name within a conversation (for the incoming-call UI). */
export async function callerName(conversationId: string, userId: string): Promise<string> {
  const names = await memberNames(conversationId).catch(() => ({}) as Record<string, string>);
  return names[userId] ?? "Quelqu'un";
}

// ── Navigation / conversation lifecycle ───────────────────────────────────────

/** Conversations this session already tried to auto-bootstrap into MLS (the
 * enable flow is heavy — welcomes, arbitrated create, device adds). */
const mlsAutoBootstrapped = new Set<string>();

/** MLS-only (v0.7): a legacy conversation upgrades the moment a native client
 * opens it, and an MLS-born conversation whose group doesn't exist yet gets
 * bootstrapped the same way — enableMlsForConversation is server-arbitrated
 * and idempotent, so concurrent openers cannot fork the group. */
async function ensureMlsBootstrap(conversationId: string): Promise<void> {
  if (!rt || !isTauri() || mlsAutoBootstrapped.has(conversationId)) return;
  mlsAutoBootstrapped.add(conversationId);
  try {
    if (!isMls(conversationId)) {
      await enableMlsForConversation(conversationId);
    } else if (!(await mls.isMlsGroupJoined(rt.instanceId, conversationId).catch(() => false))) {
      await enableMlsForConversation(conversationId);
    }
  } catch (e) {
    mlsAutoBootstrapped.delete(conversationId); // retry on the next open
    console.warn("MLS auto-bootstrap failed", e);
  }
}

export async function openConversation(conversationId: string): Promise<void> {
  useConversationsStore.getState().setActive(conversationId);
  await ensureMlsBootstrap(conversationId);
  // Sync any in-progress call here (server-authoritative) so the header can offer to
  // join it even if we weren't online for the live participant events. Detached.
  void getCallState(conversationId).then((st) => {
    if (!st) return; // error — leave whatever the live events gave us
    const calls = useOngoingCallsStore.getState();
    if (st.active && st.call_id) calls.setCall(conversationId, st.call_id, st.participants);
    else calls.setCall(conversationId, "", []); // no call → clear any stale entry
  });
  // Snapshot the unread-divider boundary BEFORE markRead advances the read marker.
  // Unread → the read marker at open (empty string = read nothing → divider at the
  // first message from someone else); caught up → "now" so no message beats it.
  const openedConv = useConversationsStore.getState().conversations.find((c) => c.id === conversationId);
  useMessagesStore
    .getState()
    .setUnreadAt(
      conversationId,
      openedConv && openedConv.unread > 0
        ? (openedConv.last_read_at ?? "")
        : new Date().toISOString(),
    );
  if (isMls(conversationId)) {
    // Dual-read: this device's persisted MLS history (forward-secret; not
    // re-derivable from the server) MERGED with any pre-cutover legacy X25519
    // messages the server still holds — so flipping a conversation to MLS never
    // hides its earlier thread. Then catch up on newer MLS frames. The legacy
    // cursor lets `loadOlder` paginate the (older, all-legacy) tail.
    if (rt && !useMessagesStore.getState().loaded[conversationId]) {
      let failed = false;
      const [history, legacy] = await Promise.all([
        loadMlsHistory(rt.instanceId, conversationId).catch(() => {
          failed = true;
          return [] as DecryptedMessage[];
        }),
        legacyPageAscending(conversationId, { limit: PAGE }).catch(() => {
          failed = true;
          return { messages: [] as DecryptedMessage[], cursor: null as string | null };
        }),
      ]);
      const merged = [...legacy.messages, ...history].sort((a, b) =>
        a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
      );
      useMessagesStore.getState().setInitial(conversationId, merged, legacy.cursor);
      flushPendingMlsOps(conversationId); // edits/pins that beat the history load
      // Replay moderation tombstones published while this device was away —
      // the server can't touch the local E2EE history, it can only ask.
      void rt.client
        .mlsTombstones(conversationId)
        .then(({ refs }) => {
          for (const ref of refs) {
            useMessagesStore.getState().markDeleted(conversationId, ref);
            void markMlsDeleted(rt!.instanceId, conversationId, ref);
          }
        })
        .catch(() => {});
      // A total failure with nothing to show would otherwise render the reassuring
      // "start of conversation" hero as if the thread were genuinely empty.
      if (failed && merged.length === 0) {
        useMessagesStore.getState().setLoadError(conversationId, true);
      }
    }
    await onMlsFrame(conversationId).catch(() => {});
    await markRead(conversationId);
    return;
  }
  if (!useMessagesStore.getState().loaded[conversationId]) await loadMessages(conversationId);
  await markRead(conversationId);
}
export async function openDmWith(userId: string): Promise<string | null> {
  if (!rt) return null;
  const { conversation_id } = await rt.client.openDm(userId);
  await refreshConversations();
  await openConversation(conversation_id);
  return conversation_id;
}
export async function createGroup(name: string, ids: string[]): Promise<string | null> {
  if (!rt) return null;
  const { conversation_id } = await rt.client.createGroup(name, ids);
  await refreshConversations();
  await openConversation(conversation_id);
  return conversation_id;
}
export async function renameGroup(conversationId: string, name: string): Promise<void> {
  if (!rt) return;
  await rt.client.renameGroup(conversationId, name);
  await refreshConversations();
}
export async function addMember(conversationId: string, userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.addMember(conversationId, userId);
  invalidateMembers(conversationId);
}
export async function removeMember(conversationId: string, userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.removeMember(conversationId, userId);
  // On an MLS conversation, also drop the member's device leaves so the epoch
  // rekeys and they lose forward access (PCS). The remove commit's sync can sweep
  // up peer messages that raced it — deliverSwept delivers them (else silently lost).
  if (isMls(conversationId)) {
    await mls
      .removeUserFromMlsGroup(
        rt.client,
        rt.instanceId,
        conversationId,
        userId,
        deliverSwept(conversationId),
      )
      .catch((e) => console.warn("MLS member remove failed", e));
  }
  invalidateMembers(conversationId);
}
export async function leaveConversation(conversationId: string): Promise<void> {
  if (!rt) return;
  await rt.client.removeMember(conversationId, rt.myUserId);
  invalidateMembers(conversationId);
  useConversationsStore.getState().remove(conversationId);
}

// ── Friend actions ────────────────────────────────────────────────────────────
export async function sendFriendRequest(username: string): Promise<void> {
  if (!rt) return;
  await rt.client.sendFriendRequest(username);
  await refreshFriends();
}
export async function acceptFriend(userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.acceptFriend(userId);
  await refreshFriends();
}
export async function declineFriend(userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.declineFriend(userId);
  await refreshFriends();
}
export async function blockFriend(userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.blockFriend(userId);
  await refreshFriends();
}
export async function removeFriend(userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.removeFriend(userId);
  await refreshFriends();
}
/**
 * Lift a block the caller placed. `DELETE /friends/{id}` deletes the edge when the
 * caller is the blocker (a block placed *on* you is left untouched by the server),
 * so unblocking reuses the same endpoint as removing a friend.
 */
export async function unblockFriend(userId: string): Promise<void> {
  if (!rt) return;
  await rt.client.removeFriend(userId);
  await refreshFriends();
}

// ── Realtime handlers (wired by the MessagingProvider) ────────────────────────

/** Pop a desktop notification for an incoming message when it's warranted:
 * notifications enabled, conversation not muted, not your own message, and you're
 * not already looking at it (active conversation + focused window). Falls back to
 * a light fetch for the preview when the conversation isn't loaded. */
async function maybeNotify(
  conversationId: string,
  messageId?: string,
  known?: DecryptedMessage,
): Promise<void> {
  if (!rt) return;
  const notif = useNotificationStore.getState();
  const mode = notifyModeOf(notif, conversationId);
  if (!notif.enabled || mode === "none") return;
  // Do Not Disturb is a promise: no desktop notifications while it's on.
  if (usePresenceStore.getState().myStatus === "DND") return;
  const conversations = useConversationsStore.getState();
  const focused = typeof document !== "undefined" && !document.hidden;
  if (conversations.activeId === conversationId && focused) return; // you're reading it

  let msg = known;
  if (!msg) {
    const page = await rt.client
      .messages(conversationId, rt.identity.deviceId, { limit: 1 })
      .catch(() => null);
    if (page?.messages.length) {
      const dec = await decryptPage(conversationId, page.messages);
      msg = (messageId && dec.find((m) => m.id === messageId)) || dec[dec.length - 1];
    }
  }
  if (!msg || msg.deleted || msg.senderId === rt.myUserId) return;

  const names = await memberNames(conversationId).catch(() => ({}) as Record<string, string>);
  // Mentions-only mode: notify only when the text @-mentions me.
  if (mode === "mentions") {
    const myName = names[rt.myUserId]?.toLowerCase();
    const text = (msg.content?.text ?? "").toLowerCase();
    if (!myName || !text.includes(`@${myName}`)) return;
  }
  const conv = conversations.conversations.find((c) => c.id === conversationId);
  const sender = (msg.senderId && names[msg.senderId]) || conversations.titles[conversationId] || "Nouveau message";
  const title = conv?.kind === "group" ? `${sender} · ${conversations.titles[conversationId] ?? "Groupe"}` : sender;
  const body =
    msg.content?.text?.slice(0, 140) ||
    (msg.content?.attachments?.length ? "Pièce jointe" : "Nouveau message");
  showNotification(title, body, {
    conversationId,
    onClick: () => void openConversation(conversationId),
  });
}

export async function onMessageCreated(conversationId: string, messageId?: string): Promise<void> {
  if (!rt) return;
  const messages = useMessagesStore.getState();
  const conversations = useConversationsStore.getState();
  const isActive = conversations.activeId === conversationId;
  const known = conversations.conversations.some((c) => c.id === conversationId);

  let newest: DecryptedMessage | undefined;
  if (messages.loaded[conversationId]) {
    const page = await rt.client.messages(conversationId, rt.identity.deviceId, { limit: PAGE });
    const decrypted = await decryptPage(conversationId, page.messages);
    for (const m of decrypted) messages.upsert(conversationId, m);
    newest = (messageId && decrypted.find((m) => m.id === messageId)) || decrypted[decrypted.length - 1];
  }

  await maybeNotify(conversationId, messageId, newest);

  if (isActive) {
    await markRead(conversationId);
  } else if (!known) {
    // Brand-new conversation: refresh loads the authoritative unread (do NOT also
    // bump — that would double-count the message the server already tallied).
    await refreshConversations();
  } else {
    useConversationsStore.getState().bumpUnread(conversationId);
  }
}

/** Full re-sync from REST — run on (re)connect (READY) since the socket does not
 * replay events missed while disconnected. */
export async function resyncAll(): Promise<void> {
  await Promise.all([refreshFriends().catch(() => {}), refreshConversations().catch(() => {})]);
  const activeId = useConversationsStore.getState().activeId;
  if (activeId) await loadMessages(activeId).catch(() => {});
}
export async function onMessageUpdated(conversationId: string): Promise<void> {
  if (!rt || !useMessagesStore.getState().loaded[conversationId]) return;
  // Re-fetch the newest page and merge the edited copy in. This covers recent
  // edits; an edit to a message scrolled beyond the newest page reconciles on the
  // next open (there is no single-message GET endpoint yet).
  const page = await rt.client.messages(conversationId, rt.identity.deviceId, { limit: PAGE });
  const store = useMessagesStore.getState();
  for (const m of await decryptPage(conversationId, page.messages)) store.upsert(conversationId, m);
}
export function onMessageDeleted(conversationId: string, messageId: string): void {
  useMessagesStore.getState().markDeleted(conversationId, messageId);
  // A moderation tombstone on an MLS message must survive reloads — the row
  // exists only in this device's local encrypted history.
  if (rt && messageId.startsWith("mls:")) {
    void markMlsDeleted(rt.instanceId, conversationId, messageId);
  }
}
export function onTyping(conversationId: string, userId: string): void {
  if (rt && userId !== rt.myUserId) useMessagesStore.getState().setTyping(conversationId, userId);
}
export async function onMemberChange(
  conversationId: string,
  userId: string,
  action: "added" | "removed" = "added",
): Promise<void> {
  if (!rt) return;
  invalidateMembers(conversationId);
  messaging.invalidateBundle(userId);
  await refreshConversations();

  // When a member LEAVES (or is removed from) an MLS group, the epoch must rotate
  // so they lose forward access (PCS) — but MLS forbids committing your own
  // removal, so the departing member cannot rekey the group for the others. Each
  // REMAINING member therefore drops the departed member's leaves: the Delivery
  // Service orders exactly one commit as the winner, and every other attempt
  // no-ops (removeMembersByPrefix returns null once the member is already gone,
  // and submitCommit rebases on the 409). Robust to any remaining member being
  // offline — whoever is online closes the epoch. A short random delay
  // de-correlates the attempts so most peers no-op instead of racing a commit.
  if (action === "removed" && userId !== rt.myUserId && isMls(conversationId)) {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 1500)));
    if (!rt) return;
    await mls
      .removeUserFromMlsGroup(
        rt.client,
        rt.instanceId,
        conversationId,
        userId,
        deliverSwept(conversationId),
      )
      .catch((e) => console.warn("MLS leave/removal rekey failed", e));
  }

  // A member ADDED to an MLS conversation must also enter the MLS tree, or they
  // can never read anything — force a sweep now (bypasses the hourly throttle).
  if (action === "added" && isMls(conversationId)) {
    await sweepConversationDevices(conversationId, true).catch(() => {});
  }
}
export async function onFriendEvent(userId: string): Promise<void> {
  messaging.invalidateBundle(userId);
  await refreshFriends();
}
