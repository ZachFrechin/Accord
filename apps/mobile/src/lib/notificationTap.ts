/**
 * Ouvrir la bonne conversation quand l'utilisateur tape une notification.
 *
 * Android ne transmet que l'identifiant numérique de la notification tapée ;
 * c'est le Rust qui sait à quelle conversation il correspond (`notif_show`
 * dérive cet identifiant de la conversation, et lui seul détient le calcul).
 *
 * Le tap arrive à deux moments très différents. Application vivante : l'événement
 * tombe alors que tout est chargé, on ouvre immédiatement. Application tuée par
 * le système : l'événement tombe au tout début du démarrage, avant même que la
 * liste des conversations existe — d'où la mise en attente, rejouée dès que
 * l'application sait de quoi elle parle. C'est précisément le cas où une
 * notification sert à quelque chose, donc celui à ne pas rater.
 */

import { addPluginListener, invoke } from "@tauri-apps/api/core";

import { isTauri } from "@accord/core/lib/isTauri";

/** Emplacement tapé, en attente d'une liste de conversations pour être résolu. */
let pendingSlot: number | null = null;
let onResolved: ((conversationId: string) => void) | null = null;

/** Tente de convertir l'emplacement en attente en conversation ouvrable. */
async function resolvePending(candidates: string[]): Promise<void> {
  if (pendingSlot === null || !onResolved || candidates.length === 0) return;
  const slotId = pendingSlot;
  try {
    const conversationId = await invoke<string | null>("notif_conversation_for", {
      slotId,
      candidates,
    });
    if (conversationId) {
      // Consommé : un deuxième chargement de la liste ne doit pas rouvrir la
      // conversation dans le dos de l'utilisateur, qui a pu naviguer ailleurs.
      pendingSlot = null;
      onResolved(conversationId);
    }
  } catch {
    // Commande absente (hors Tauri) : il n'y a rien à ouvrir, et rien à dire.
  }
}

/** Branche l'écoute des taps. `open` reçoit la conversation à afficher. */
export async function listenNotificationTaps(
  open: (conversationId: string) => void,
): Promise<void> {
  onResolved = open;
  if (!isTauri()) return;
  try {
    await addPluginListener("notification", "actionPerformed", (payload: unknown) => {
      const slotId = (payload as { notification?: { id?: number } })?.notification?.id;
      if (typeof slotId !== "number") return;
      pendingSlot = slotId;
      void resolvePending(knownConversations);
    });
  } catch {
    // Plugin indisponible : l'application s'ouvre sans router, ce qui reste
    // correct — simplement moins direct.
  }
}

/** Dernière liste connue, tenue à jour par l'écran d'accueil. */
let knownConversations: string[] = [];

/** Signale les conversations disponibles ; rejoue un tap resté en attente. */
export function offerConversations(ids: string[]): void {
  knownConversations = ids;
  void resolvePending(ids);
}
