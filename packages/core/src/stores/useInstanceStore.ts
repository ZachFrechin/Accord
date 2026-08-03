/**
 * The instance registry — the heart of the multi-instance client.
 *
 * Each instance is one Accord backend (URL) the user has connected to. Exactly
 * one is active at a time; switching does NOT log out (tokens for every instance
 * are preserved in `secureStore`). This store holds only non-secret metadata.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The signed-in account on a given instance. */
export interface Account {
  userId: string;
  username: string;
  email: string;
  /** Instance-level role. Optional: accounts persisted before roles existed
   * lack it until the next login/refresh backfills it. */
  role?: "member" | "admin";
}

/** One connected backend. */
export interface Instance {
  id: string;
  url: string;
  displayName: string;
  account: Account | null;
  addedAt: number;
}

interface InstanceState {
  instances: Instance[];
  activeInstanceId: string | null;
  addInstance: (input: { url: string; displayName?: string }) => Instance;
  updateAccount: (id: string, account: Account) => void;
  removeInstance: (id: string) => void;
  setActive: (id: string | null) => void;
}

/** Normalizes a base URL (trim, strip trailing slash). */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** A stable, collision-resistant id for an instance derived from its URL
 * (FNV-1a 32-bit — distinct hosts/ports never collide). */
function instanceId(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `inst_${(hash >>> 0).toString(36)}`;
}

export const useInstanceStore = create<InstanceState>()(
  persist(
    (set, get) => ({
      instances: [],
      activeInstanceId: null,

      addInstance: ({ url, displayName }) => {
        const normalized = normalizeUrl(url);
        const id = instanceId(normalized);
        const existing = get().instances.find((i) => i.id === id);
        if (existing) {
          set({ activeInstanceId: id });
          return existing;
        }
        const instance: Instance = {
          id,
          url: normalized,
          displayName: displayName?.trim() || hostLabel(normalized),
          account: null,
          addedAt: Date.now(),
        };
        set((s) => ({
          instances: [...s.instances, instance],
          activeInstanceId: id,
        }));
        return instance;
      },

      // Appelé à CHAQUE rafraîchissement de jeton, avec presque toujours les
      // mêmes valeurs. Écrire quand même reconstruisait un objet neuf toutes les
      // dix minutes, et tout ce qui en dépendait se croyait face à un nouveau
      // compte — jusqu'à vider la liste des conversations et renvoyer
      // l'utilisateur au menu en plein appel. On ne touche donc au state que si
      // quelque chose a réellement changé.
      updateAccount: (id, account) =>
        set((s) => {
          const current = s.instances.find((i) => i.id === id)?.account;
          if (
            current &&
            current.userId === account.userId &&
            current.username === account.username &&
            current.email === account.email &&
            current.role === account.role
          ) {
            return s;
          }
          return {
            instances: s.instances.map((i) => (i.id === id ? { ...i, account } : i)),
          };
        }),

      removeInstance: (id) =>
        set((s) => {
          const instances = s.instances.filter((i) => i.id !== id);
          const activeInstanceId =
            s.activeInstanceId === id
              ? (instances[0]?.id ?? null)
              : s.activeInstanceId;
          return { instances, activeInstanceId };
        }),

      setActive: (id) => set({ activeInstanceId: id }),
    }),
    { name: "accord.instances.v1" },
  ),
);

/** A short human label from a URL's host (e.g. "accord.example.com"). */
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Selector: the currently active instance, or null. */
export function activeInstance(state: InstanceState): Instance | null {
  return (
    state.instances.find((i) => i.id === state.activeInstanceId) ?? null
  );
}
