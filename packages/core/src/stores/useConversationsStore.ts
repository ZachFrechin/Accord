/**
 * The active instance's conversation list + which one is open. Populated from
 * GET /conversations and kept live by MESSAGE_CREATED / CONVERSATION_MEMBER_*
 * events. `activeId` is shared state so the (non-routed) list and details panels
 * both react to the open conversation. Reset on instance switch.
 */

import { create } from "zustand";

import type { ConversationDto } from "../api/ApiClient";

/** The other participant of a DM, resolved once alongside its title, so the
 * conversation list can show their avatar (and know whose profile it is). */
export interface ConvPeer {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

interface ConversationsState {
  conversations: ConversationDto[];
  activeId: string | null;
  loaded: boolean;
  /** The last load failed — show an error+retry instead of the empty state. */
  error: boolean;
  /** Display title per conversation (group name, or the DM peer's username). */
  titles: Record<string, string>;
  /** The DM peer per conversation id (groups have no entry). */
  peers: Record<string, ConvPeer>;
  setAll: (conversations: ConversationDto[]) => void;
  setError: (error: boolean) => void;
  upsert: (conversation: ConversationDto) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  setTitle: (id: string, title: string) => void;
  setPeer: (id: string, peer: ConvPeer) => void;
  bumpUnread: (id: string) => void;
  clearUnread: (id: string) => void;
  reset: () => void;
}

/** Most-recently-created first (UUIDv7 created_at is time-sortable). */
function sortConversations(list: ConversationDto[]): ConversationDto[] {
  return [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const useConversationsStore = create<ConversationsState>((set) => ({
  conversations: [],
  activeId: null,
  loaded: false,
  error: false,
  titles: {},
  peers: {},
  setAll: (conversations) =>
    set({ conversations: sortConversations(conversations), loaded: true, error: false }),
  setError: (error) => set({ error, loaded: true }),
  setTitle: (id, title) => set((s) => ({ titles: { ...s.titles, [id]: title } })),
  setPeer: (id, peer) => set((s) => ({ peers: { ...s.peers, [id]: peer } })),
  upsert: (conversation) =>
    set((s) => ({
      conversations: sortConversations([
        conversation,
        ...s.conversations.filter((c) => c.id !== conversation.id),
      ]),
    })),
  remove: (id) =>
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    })),
  setActive: (id) => set({ activeId: id }),
  bumpUnread: (id) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, unread: c.unread + 1 } : c,
      ),
    })),
  clearUnread: (id) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, unread: 0 } : c)),
    })),
  reset: () =>
    set({ conversations: [], activeId: null, loaded: false, error: false, titles: {}, peers: {} }),
}));
