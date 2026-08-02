/**
 * Reprise après veille, rattrapage de l'historique et renvoi des messages restés
 * en échec.
 *
 * Le problème est propre au téléphone : dès que l'application passe en
 * arrière-plan, le système gèle la WebView. Les minuteurs s'arrêtent, `onclose`
 * n'arrive jamais, et au retour le client croit tenir un socket vivant alors que
 * le serveur a coupé depuis longtemps — l'utilisateur regarde un écran qui ne
 * recevra plus rien, sans le moindre signe que quelque chose ne va pas. Le
 * backoff existant ne sauve pas la mise : lui aussi était gelé.
 *
 * D'où trois gestes au réveil : rouvrir une connexion neuve, recharger ce qui a
 * été manqué pendant l'absence, et repousser les envois qui avaient échoué faute
 * de réseau.
 */

import { useEffect } from "react";

import {
  loadMessages,
  messagingReady,
  refreshConversations,
  refreshFriends,
  retryMessage,
} from "../stores/messagingActions";
import { useMessagesStore } from "../stores/useMessagesStore";
import type { WsClient } from "./wsClient";

/** Au-delà d'une courte absence, le socket est considéré comme perdu. En deçà
 * (l'utilisateur bascule deux secondes vers une autre application) reconnecter
 * coûterait plus cher que ça ne rapporte. */
const STALE_AFTER_MS = 3_000;

/** Nombre de conversations rechargées au retour. Les autres se rafraîchissent
 * à leur ouverture — `openConversation` recharge toujours — donc ce plafond ne
 * cache rien à l'utilisateur, il évite juste une rafale de requêtes sur un
 * réseau qui vient à peine de revenir. */
const CATCHUP_LIMIT = 8;

/** Renvoie les messages laissés en échec, du plus ancien au plus récent pour ne
 * pas inverser l'ordre d'une conversation. */
async function flushFailed(): Promise<void> {
  const { byConversation } = useMessagesStore.getState();
  for (const [conversationId, messages] of Object.entries(byConversation)) {
    for (const message of messages) {
      if (message.status !== "failed") continue;
      try {
        await retryMessage(conversationId, message.id);
      } catch {
        // Toujours pas de réseau : le message garde son état d'échec et sa
        // chance au prochain retour. Insister ici ne ferait que vider la
        // batterie.
        return;
      }
    }
  }
}

/** Recharge ce qui a pu changer pendant l'absence. */
export async function catchUp(): Promise<void> {
  if (!(await messagingReady())) return;
  await Promise.allSettled([refreshConversations(), refreshFriends()]);
  const open = Object.keys(useMessagesStore.getState().byConversation).slice(0, CATCHUP_LIMIT);
  await Promise.allSettled(open.map((id) => loadMessages(id)));
  await flushFailed();
}

/** Branche la reprise sur le cycle de vie de l'application. Accepte `null` le
 * temps que la connexion se crée : un hook ne peut pas être appelé
 * conditionnellement. */
export function useConnectionLifecycle(ws: WsClient | null): void {
  useEffect(() => {
    if (!ws) return;
    let hiddenAt: number | null = null;

    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away >= STALE_AFTER_MS) ws.wake();
    };

    // Le retour du réseau mérite le même traitement que le retour au premier
    // plan : le socket d'avant la coupure est mort de la même façon.
    const onOnline = (): void => ws.wake();

    // Le rattrapage suit la RECONNEXION, pas la première connexion : au premier
    // démarrage l'application charge déjà tout, le refaire serait du gâchis.
    let seenOpen = false;
    const offStatus = ws.onStatus((status) => {
      if (status !== "open") return;
      if (seenOpen) void catchUp();
      seenOpen = true;
    });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      offStatus();
    };
  }, [ws]);
}
