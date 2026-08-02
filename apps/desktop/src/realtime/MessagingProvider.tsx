/**
 * Version desktop du fournisseur de messagerie : le câblage vit dans
 * @accord/core (partagé avec l'app mobile). Cette application y branche les
 * deux choses qui lui sont propres — sa façon de prévenir l'utilisateur (un
 * bandeau toast) et son moteur d'appel LiveKit.
 */

import { useMemo, type ReactNode } from "react";

import {
  MessagingProvider as CoreMessagingProvider,
  type CallSink,
} from "@accord/core/realtime/MessagingProvider";
import { useCallStore } from "../stores/useCallStore";
import { useToast } from "../components/ui";

export function MessagingProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();

  // Adaptateur figé : le câblage partagé ne connaît que ces quelques gestes,
  // pas le store LiveKit qui les réalise.
  const call = useMemo<CallSink>(
    () => ({
      activeCallId: () => useCallStore.getState().callId,
      isIdle: () => useCallStore.getState().status === "idle",
      leave: () => useCallStore.getState().leaveCall(),
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

  return (
    <CoreMessagingProvider onNotice={toast} call={call}>
      {children}
    </CoreMessagingProvider>
  );
}
