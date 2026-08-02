/**
 * Per-conversation composer drafts (persisted) — switching conversations or
 * restarting the app never loses a half-written message. Only non-empty drafts
 * are kept, so the map stays small.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface DraftsState {
  drafts: Record<string, string>;
  setDraft: (conversationId: string, text: string) => void;
  clearDraft: (conversationId: string) => void;
}

export const useDraftsStore = create<DraftsState>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (conversationId, text) =>
        set((s) => {
          if (text) return { drafts: { ...s.drafts, [conversationId]: text } };
          const { [conversationId]: _dropped, ...rest } = s.drafts;
          return { drafts: rest };
        }),
      clearDraft: (conversationId) =>
        set((s) => {
          const { [conversationId]: _dropped, ...rest } = s.drafts;
          return { drafts: rest };
        }),
    }),
    { name: "accord.drafts.v1" },
  ),
);
