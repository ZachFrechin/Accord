/** Le câblage temps réel, côté téléphone.
 *
 *  Le fournisseur partagé ne connaît ni LiveKit ni les notifications système :
 *  il reçoit les quelques gestes dont il a besoin. Sans cet adaptateur, le
 *  téléphone ne pouvait pas recevoir d'appel — seulement en passer.
 */

import { useMemo, type ReactNode } from "react";

import {
  type CallSink,
  MessagingProvider as CoreMessagingProvider,
} from "@accord/core/realtime/MessagingProvider";
import { showNotification } from "@accord/core/lib/notifications";

import { useCallStore } from "../stores/useCallStore";

export function MessagingProvider({ children }: { children: ReactNode }) {
  const call = useMemo<CallSink>(
    () => ({
      activeCallId: () => useCallStore.getState().callId,
      isIdle: () => useCallStore.getState().status === "idle",
      leave: () => useCallStore.getState().leave(),
      setIncoming: (incoming) => useCallStore.getState().setIncoming(incoming),
      incomingCallId: () => useCallStore.getState().incoming?.callId ?? null,
      renameIncoming: (fromName) => {
        const cur = useCallStore.getState().incoming;
        if (cur) useCallStore.getState().setIncoming({ ...cur, fromName });
      },
      dismissIncoming: (callId) => useCallStore.getState().dismissIncoming(callId),
    }),
    [],
  );

  // Les avis du câblage partagé (« nouveaux messages illisibles », etc.) passent
  // par une notification système : un téléphone n'a pas de coin d'écran pour
  // afficher un bandeau discret, et l'application est souvent en arrière-plan.
  const notice = useMemo(
    () => (n: { title: string; description?: string }) =>
      showNotification(n.title, n.description ?? ""),
    [],
  );

  return (
    <CoreMessagingProvider onNotice={notice} call={call}>
      {children}
    </CoreMessagingProvider>
  );
}
