/**
 * Decrypted messages per conversation + transient typing state. Decryption
 * happens before anything lands here (see messagingActions); this store holds
 * only plaintext content the current device could open. Reset on instance switch.
 */

import { create } from "zustand";

import type { MessageContent } from "../lib/messaging";

/** One aggregated emoji reaction on a message: the emoji, how many people used
 * it, and whether *this* device's user is one of them. */
export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
}

/** A link preview the SENDER generated and embedded in the encrypted envelope. */
export interface LinkPreview {
  url: string;
  title: string;
  desc?: string;
  host: string;
}

/** A message after this device has (attempted to) decrypt it. */
export interface DecryptedMessage {
  id: string;
  senderId: string | null;
  senderDevice: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Plaintext content, or null when deleted / undecryptable / not for this device. */
  content: MessageContent | null;
  /** Parent message id this replies to (legacy: server metadata; MLS: inside the
   * encrypted envelope), or null. The quoted preview renders from the parent. */
  replyTo: string | null;
  /** Aggregated emoji reactions. Legacy rows: server-side metadata. MLS rows:
   * derived client-side from `reactionUsers` (encrypted reaction frames). */
  reactions: Reaction[];
  /** MLS bookkeeping: emoji → user ids who currently react with it (the source
   * `reactions` is derived from; persisted with the local history). */
  reactionUsers?: Record<string, string[]>;
  /** Sender-generated link preview (rides the encrypted envelope as an op
   * frame; receivers render it with zero network access). */
  preview?: LinkPreview;
  /** Parent message id when this message lives in a side-thread (it is then
   * hidden from the main flow and rendered in the thread panel). */
  threadOf?: string | null;
  /** Pinned in this conversation (MLS: carried by pin frames in the envelope,
   * any member may pin/unpin; persisted with the local history). */
  pinned?: boolean;
  /** Optimistic send state (MLS path). Absent = confirmed/received; "pending" =
   * in flight; "failed" = send failed, offer a retry. */
  status?: "pending" | "failed";
  /** Repère local, jamais chiffré ni envoyé : un appel manqué laisse une trace
   * dans le fil pour qu'on sache qu'on a raté quelque chose. Il ne peut pas
   * venir du serveur — celui-ci ne saurait pas de quoi il parle — donc il vit
   * uniquement sur l'appareil qui a manqué l'appel. */
  system?: { kind: "missed_call"; fromName: string };
}

/** How long a TYPING signal is shown before it expires (ms). */
export const TYPING_TTL_MS = 6000;

interface MessagesState {
  byConversation: Record<string, DecryptedMessage[]>;
  cursor: Record<string, string | null>;
  loaded: Record<string, boolean>;
  /** Per-conversation: the initial history load failed (show error+retry, not a
   * perpetual skeleton). */
  loadError: Record<string, boolean>;
  typing: Record<string, Record<string, number>>;
  /** Per-conversation unread-divider boundary, captured on open (the read marker
   * at that moment). Key present = show a divider; null = everything is unread. */
  unreadAt: Record<string, string | null>;
  setUnreadAt: (conversationId: string, at: string | null) => void;
  setInitial: (conversationId: string, messages: DecryptedMessage[], cursor: string | null) => void;
  setLoadError: (conversationId: string, error: boolean) => void;
  prependOlder: (conversationId: string, messages: DecryptedMessage[], cursor: string | null) => void;
  upsert: (conversationId: string, message: DecryptedMessage) => void;
  /** Remove a message (used to drop an optimistic row once confirmed / retried). */
  removeMessage: (conversationId: string, messageId: string) => void;
  /** Set a message's optimistic send status (pending → failed). */
  setStatus: (conversationId: string, messageId: string, status: "pending" | "failed") => void;
  markDeleted: (conversationId: string, messageId: string) => void;
  setReactions: (conversationId: string, messageId: string, reactions: Reaction[]) => void;
  setTyping: (conversationId: string, userId: string) => void;
  /** Drop a user's TYPING state now (they sent → they stopped typing). */
  clearTyping: (conversationId: string, userId: string) => void;
  reset: () => void;
}

/** When a user's message was upserted, ignore their TYPING events for this long:
 * a typing signal emitted milliseconds before the send can be relayed after the
 * (faster-processed) message and would relight the indicator for a full TTL. */
const TYPING_SUPPRESS_MS = 1500;
/** `${conversationId}:${userId}` → time of their latest upserted message.
 * Module-level on purpose: bookkeeping, not render state. */
const lastMessageFrom = new Map<string, number>();

/** Remove a user's entry from a conversation's typing map (immutably), or return
 * the map unchanged when there is nothing to clear. */
function withoutTyping(
  typing: Record<string, Record<string, number>>,
  conversationId: string,
  userId: string,
): Record<string, Record<string, number>> {
  const conv = typing[conversationId];
  if (!conv || !(userId in conv)) return typing;
  const { [userId]: _dropped, ...rest } = conv;
  return { ...typing, [conversationId]: rest };
}

/** Insert/replace by id, keeping ascending created_at (UUIDv7 is time-sortable). */
function merge(existing: DecryptedMessage[], incoming: DecryptedMessage): DecryptedMessage[] {
  const without = existing.filter((m) => m.id !== incoming.id);
  const next = [...without, incoming];
  next.sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );
  return next;
}

export const useMessagesStore = create<MessagesState>((set) => ({
  byConversation: {},
  cursor: {},
  loaded: {},
  loadError: {},
  typing: {},
  unreadAt: {},
  setUnreadAt: (conversationId, at) =>
    set((s) => ({ unreadAt: { ...s.unreadAt, [conversationId]: at } })),
  setInitial: (conversationId, messages, cursor) =>
    set((s) => ({
      byConversation: { ...s.byConversation, [conversationId]: messages },
      cursor: { ...s.cursor, [conversationId]: cursor },
      loaded: { ...s.loaded, [conversationId]: true },
      loadError: { ...s.loadError, [conversationId]: false },
    })),
  setLoadError: (conversationId, error) =>
    set((s) => ({ loadError: { ...s.loadError, [conversationId]: error } })),
  prependOlder: (conversationId, messages, cursor) =>
    set((s) => {
      const existing = s.byConversation[conversationId] ?? [];
      const seen = new Set(existing.map((m) => m.id));
      const fresh = messages.filter((m) => !seen.has(m.id));
      return {
        byConversation: { ...s.byConversation, [conversationId]: [...fresh, ...existing] },
        cursor: { ...s.cursor, [conversationId]: cursor },
      };
    }),
  upsert: (conversationId, message) =>
    set((s) => {
      if (message.senderId) {
        lastMessageFrom.set(`${conversationId}:${message.senderId}`, Date.now());
      }
      return {
        byConversation: {
          ...s.byConversation,
          [conversationId]: merge(s.byConversation[conversationId] ?? [], message),
        },
        // A message from someone means they just stopped typing — hide their
        // indicator immediately instead of waiting out the TTL. If they keep
        // going, the next TYPING signal brings it right back.
        typing: message.senderId
          ? withoutTyping(s.typing, conversationId, message.senderId)
          : s.typing,
      };
    }),
  removeMessage: (conversationId, messageId) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).filter((m) => m.id !== messageId),
      },
    })),
  setStatus: (conversationId, messageId, status) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, status } : m,
        ),
      },
    })),
  markDeleted: (conversationId, messageId) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, deleted: true, content: null, reactions: [] } : m,
        ),
      },
    })),
  setReactions: (conversationId, messageId, reactions) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, reactions } : m,
        ),
      },
    })),
  setTyping: (conversationId, userId) =>
    set((s) => {
      // A TYPING relayed after the very message it preceded would relight the
      // indicator for a full TTL — drop signals that closely trail a message.
      const lastMsg = lastMessageFrom.get(`${conversationId}:${userId}`) ?? 0;
      if (Date.now() - lastMsg < TYPING_SUPPRESS_MS) return s;
      return {
        typing: {
          ...s.typing,
          [conversationId]: {
            ...(s.typing[conversationId] ?? {}),
            [userId]: Date.now() + TYPING_TTL_MS,
          },
        },
      };
    }),
  clearTyping: (conversationId, userId) =>
    set((s) => ({ typing: withoutTyping(s.typing, conversationId, userId) })),
  reset: () =>
    set({ byConversation: {}, cursor: {}, loaded: {}, loadError: {}, typing: {}, unreadAt: {} }),
}));
