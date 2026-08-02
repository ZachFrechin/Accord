/**
 * The active instance's social graph (friends + pending requests + blocks).
 * Populated by the MessagingProvider from GET /friends and kept live by
 * FRIEND_* realtime events. Reset on instance switch.
 */

import { create } from "zustand";

import type { FriendsResponse, FriendUser } from "../api/ApiClient";

interface FriendsState {
  friends: FriendUser[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
  blocked: FriendUser[];
  loaded: boolean;
  /** The last /friends load failed — show an error+retry instead of "no friends". */
  error: boolean;
  setFriends: (data: FriendsResponse) => void;
  setError: (error: boolean) => void;
  reset: () => void;
}

const EMPTY = { friends: [], incoming: [], outgoing: [], blocked: [], loaded: false, error: false };

export const useFriendsStore = create<FriendsState>((set) => ({
  ...EMPTY,
  setFriends: (data) => set({ ...data, loaded: true, error: false }),
  setError: (error) => set({ error, loaded: true }),
  reset: () => set(EMPTY),
}));
