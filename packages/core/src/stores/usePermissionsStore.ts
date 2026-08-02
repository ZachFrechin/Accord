/**
 * The local user's instance capabilities (root admin / permission bits),
 * fetched once per session from GET /admin/me (which never 403s — a plain
 * member simply gets zero bits). Powers inline moderation affordances; the
 * server re-checks every action regardless.
 */

import { create } from "zustand";

import { AdminPermission } from "../api/ApiClient";

interface AdminMeClient {
  adminMe(): Promise<{ is_admin: boolean; permissions: number }>;
}

interface PermissionsState {
  isAdmin: boolean;
  permissions: number;
  loaded: boolean;
  load: (client: AdminMeClient) => void;
  reset: () => void;
}

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
  isAdmin: false,
  permissions: 0,
  loaded: false,
  load: (client) => {
    if (get().loaded) return;
    void client
      .adminMe()
      .then((me) => set({ isAdmin: me.is_admin, permissions: me.permissions, loaded: true }))
      .catch(() => {});
  },
  reset: () => set({ isAdmin: false, permissions: 0, loaded: false }),
}));

/** May the local user delete anyone's message? */
export const canModerate = (s: Pick<PermissionsState, "isAdmin" | "permissions">): boolean =>
  s.isAdmin || (s.permissions & AdminPermission.MODERATE) !== 0;
