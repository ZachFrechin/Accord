/**
 * Ongoing calls the server knows about, per conversation (Phase 4 · Lot 5c).
 *
 * Fed by the authoritative call-state events (CALL_PARTICIPANT_JOINED / _LEFT /
 * CALL_END) and a GET /call sync when a conversation opens, so a member who is NOT
 * in a call can still see "a call is in progress here" and join it — the previous
 * client had no way to discover an ongoing call (you had to catch the live ring).
 */

import { create } from "zustand";

/** A live call in a conversation, from the server roster. */
export interface OngoingCall {
  callId: string;
  /** Distinct user ids currently in the call. */
  participants: string[];
}

/** Drop one key from a record without mutating it. */
function without(calls: Record<string, OngoingCall>, conversationId: string): Record<string, OngoingCall> {
  if (!(conversationId in calls)) return calls;
  const next = { ...calls };
  delete next[conversationId];
  return next;
}

interface OngoingCallsState {
  calls: Record<string, OngoingCall>;
  /** Replace a conversation's call from an authoritative snapshot (GET /call). */
  setCall: (conversationId: string, callId: string, participants: string[]) => void;
  participantJoined: (conversationId: string, callId: string, userId: string) => void;
  participantLeft: (conversationId: string, callId: string, userId: string) => void;
  /** The whole call ended. */
  clearCall: (conversationId: string, callId: string) => void;
  reset: () => void;
}

export const useOngoingCallsStore = create<OngoingCallsState>((set) => ({
  calls: {},

  setCall: (conversationId, callId, participants) =>
    set((s) => ({
      calls: participants.length
        ? { ...s.calls, [conversationId]: { callId, participants } }
        : without(s.calls, conversationId),
    })),

  participantJoined: (conversationId, callId, userId) =>
    set((s) => {
      const cur = s.calls[conversationId];
      // A join for a different call id supersedes (a fresh call replaced the old one).
      const base = cur && cur.callId === callId ? cur.participants : [];
      const participants = base.includes(userId) ? base : [...base, userId];
      return { calls: { ...s.calls, [conversationId]: { callId, participants } } };
    }),

  participantLeft: (conversationId, callId, userId) =>
    set((s) => {
      const cur = s.calls[conversationId];
      if (!cur || cur.callId !== callId) return s;
      const participants = cur.participants.filter((p) => p !== userId);
      return participants.length
        ? { calls: { ...s.calls, [conversationId]: { ...cur, participants } } }
        : { calls: without(s.calls, conversationId) };
    }),

  clearCall: (conversationId, callId) =>
    set((s) => {
      const cur = s.calls[conversationId];
      if (!cur || cur.callId !== callId) return s;
      return { calls: without(s.calls, conversationId) };
    }),

  reset: () => set({ calls: {} }),
}));
