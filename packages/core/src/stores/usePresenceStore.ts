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

/** L'état de présence effectif d'une personne — la SEULE façon de le lire.
 *
 * Ce store est alimenté par le temps réel et par les instantanés ; il fait
 * autorité. La liste d'amis porte aussi un champ `presence`, mais figé à
 * l'instant de son chargement : le consulter en priorité gelait l'affichage,
 * et un ami qui se déconnectait restait indéfiniment en ligne — les événements
 * arrivaient bien, personne ne les regardait.
 *
 * Une entrée absente vaut « hors ligne » : la présence vit dans Redis côté
 * serveur, l'absence d'entrée EST l'information.
 */
export function presenceOf(
  state: PresenceState,
  userId: string,
  myId?: string | null,
): PresenceStatus {
  if (myId && userId === myId) return state.myStatus;
  return state.statuses[userId] ?? "OFFLINE";
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
