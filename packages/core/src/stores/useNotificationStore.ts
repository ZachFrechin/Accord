/**
 * Notification preferences (persisted): a global on/off and a per-conversation
 * mute set. Whether a message actually pops is also gated by OS permission and by
 * focus/active state — see messagingActions.maybeNotify.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Per-conversation notification behaviour. */
export type NotifyMode = "all" | "mentions" | "none";

interface NotificationState {
  /** Master switch for desktop notifications. */
  enabled: boolean;
  /** Legacy boolean mutes (kept for persisted data written before modes). */
  muted: Record<string, boolean>;
  /** Per-conversation mode; absent = "all" (or "none" if legacy-muted). */
  modes: Record<string, NotifyMode>;
  setEnabled: (enabled: boolean) => void;
  setMuted: (conversationId: string, muted: boolean) => void;
  setMode: (conversationId: string, mode: NotifyMode) => void;
}

/** Effective mode for a conversation (modes win; legacy mute maps to "none"). */
export function notifyModeOf(s: NotificationState, conversationId: string): NotifyMode {
  return s.modes[conversationId] ?? (s.muted[conversationId] ? "none" : "all");
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      enabled: true,
      muted: {},
      modes: {},
      setEnabled: (enabled) => set({ enabled }),
      setMuted: (conversationId, muted) =>
        set((s) => ({
          muted: { ...s.muted, [conversationId]: muted },
          modes: { ...s.modes, [conversationId]: muted ? "none" : "all" },
        })),
      setMode: (conversationId, mode) =>
        set((s) => ({
          modes: { ...s.modes, [conversationId]: mode },
          muted: { ...s.muted, [conversationId]: mode === "none" },
        })),
    }),
    { name: "accord.notifications.v1" },
  ),
);
