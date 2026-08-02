/**
 * Presence state for the active instance.
 *
 * `myStatus` is the local user's chosen status; `statuses` maps user ids to their
 * live status as pushed over the WebSocket. `myStatusText`/`statusTexts` hold the
 * optional custom free-text status (own + peers). Reset when switching instances.
 */

import { create } from "zustand";

import type { PresenceStatus } from "../realtime/wireSchema";

interface PresenceState {
  myStatus: PresenceStatus;
  statuses: Record<string, PresenceStatus>;
  /** The local user's custom status text ("" = none). */
  myStatusText: string;
  /** Peers' custom status text as pushed over the WS ("" = none). */
  statusTexts: Record<string, string>;
  setMyStatus: (status: PresenceStatus) => void;
  setMyStatusText: (text: string) => void;
  setPresence: (userId: string, status: PresenceStatus, statusText?: string) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  myStatus: "ONLINE",
  statuses: {},
  myStatusText: "",
  statusTexts: {},
  setMyStatus: (myStatus) => set({ myStatus }),
  setMyStatusText: (myStatusText) => set({ myStatusText }),
  setPresence: (userId, status, statusText) =>
    set((s) => ({
      statuses: { ...s.statuses, [userId]: status },
      statusTexts: { ...s.statusTexts, [userId]: statusText ?? "" },
    })),
  reset: () => set({ myStatus: "ONLINE", statuses: {}, myStatusText: "", statusTexts: {} }),
}));
