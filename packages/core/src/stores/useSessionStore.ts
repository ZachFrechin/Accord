/**
 * Reactive "is this instance authenticated?" flags.
 *
 * `secureStore` is the token source of truth, but React needs a reactive signal
 * to gate onboarding vs the app. This store mirrors it (an instance is "authed"
 * once its refresh token is present in the secure store's cache).
 */

import { create } from "zustand";

import { secureStore } from "../lib/secureStore";

interface SessionState {
  authed: Record<string, boolean>;
  markAuthed: (instanceId: string) => void;
  markUnauthed: (instanceId: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  authed: {},
  markAuthed: (id) => set((s) => ({ authed: { ...s.authed, [id]: true } })),
  markUnauthed: (id) => set((s) => ({ authed: { ...s.authed, [id]: false } })),
}));

/** Seeds the authed flags from stored tokens (call once at boot). */
export function hydrateSessions(instanceIds: string[]): void {
  const authed: Record<string, boolean> = {};
  for (const id of instanceIds) authed[id] = secureStore.get(id) !== null;
  useSessionStore.setState({ authed });
}
