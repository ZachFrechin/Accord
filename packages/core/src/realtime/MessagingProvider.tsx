/**
 * Wires the active instance's messaging: ensures the device identity, publishes
 * its public key, loads the social graph + conversations, and routes every
 * messaging WS event into the stores. Mounted under ConnectionProvider (keyed by
 * instance), so it tears down and re-establishes on instance switch.
 */

import { type ReactNode, useEffect } from "react";

import { ensureIdentity } from "../lib/deviceIdentity";
import { isTauri } from "../lib/isTauri";
import { bootstrapMls } from "../lib/mls/mlsRuntime";
import { toBase64 } from "../lib/crypto";
import {
  callerName,
  clearMessagingRuntime,
  enableMlsForConversation,
  getCallState,
  onFriendEvent,
  onMemberChange,
  onMessageCreated,
  onMessageDeleted,
  onMessageReacted,
  onMessageUpdated,
  onMlsFrame,
  onTyping,
  refreshConversations,
  refreshFriends,
  resyncAll,
  setMessagingRuntime,
} from "../stores/messagingActions";
import { useOngoingCallsStore } from "../stores/useOngoingCallsStore";
import { monitorTransparency } from "../stores/useTransparencyStore";
import { activeInstance, useInstanceStore } from "../stores/useInstanceStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { useFriendsStore } from "../stores/useFriendsStore";
import { rankForLevel } from "../lib/levels";
import { useMessagesStore } from "../stores/useMessagesStore";
import { usePermissionsStore } from "../stores/usePermissionsStore";
import { useConnection } from "./ConnectionProvider";

/** On a peer leaving the call (CALL_PARTICIPANT_LEFT) or the call ending (CALL_END),
 * consult the server-authoritative roster and tear our own call down only if the
 * call is over or we're the last one left. This replaces the old client-side
 * `participants <= 1` LiveKit guess with server truth, so a group call survives one
 * member hanging up while a 1:1 still auto-leaves when the other party is gone. */
/** Ce dont le câblage a besoin d'un moteur d'appel. L'application qui en a un
 * (le desktop) le fournit ; celle qui n'en a pas encore (mobile V1) l'omet, et
 * les événements d'appel sont alors simplement ignorés. */
export interface CallSink {
  activeCallId(): string | null;
  isIdle(): boolean;
  leave(): void;
  setIncoming(call: {
    conversationId: string;
    from: string;
    fromName: string;
    callId: string;
    media: string;
  }): void;
  incomingCallId(): string | null;
  renameIncoming(fromName: string): void;
  dismissIncoming(callId: string): void;
}

let callSink: CallSink | null = null;

async function teardownIfCallDone(conversationId: string, callId: string): Promise<void> {
  if (!callSink) return;
  if (callSink.activeCallId() !== callId) return; // pas notre appel en cours
  const st = await getCallState(conversationId);
  // Re-read AFTER the async fetch: the user may have left/switched calls meanwhile.
  // Only tear down if we're still in *this* call and the server says it's over,
  // superseded by a newer call, or down to just us.
  if (callSink.isIdle() || callSink.activeCallId() !== callId) return;
  if (!st || !st.active || st.call_id !== callId || st.participants.length <= 1) {
    callSink.leave();
  }
}

export function MessagingProvider({
  children,
  onNotice,
  call,
}: {
  children: ReactNode;
  /** Prévenir l'utilisateur (montée de niveau, clé non publiée). Optionnel. */
  onNotice?: (notice: { title: string; description?: string }) => void;
  /** Moteur d'appel de l'application hôte ; absent = les appels sont ignorés. */
  call?: CallSink;
}) {
  const { client, ws } = useConnection();
  // L'application hôte décide comment prévenir l'utilisateur : bandeau sur
  // desktop, notification système sur mobile. Le câblage, lui, est commun.
  const toast = onNotice ?? (() => {});
  callSink = call ?? null;
  const instance = useInstanceStore(activeInstance);
  const account = instance?.account ?? null;

  useEffect(() => {
    if (!instance || !account) return;
    let cancelled = false;

    // Instance capabilities (moderation affordances) — once per session.
    usePermissionsStore.getState().load(client);

    // Level-up toast: poll the own level cheaply and announce increases (the
    // baseline fetch stays silent). New rank names come from lib/levels.
    let lastLevel: number | null = null;
    const checkLevel = () => {
      void client
        .levelsMe()
        .then(({ level }) => {
          if (lastLevel !== null && level > lastLevel) {
            const rank = rankForLevel(level);
            const prev = rankForLevel(lastLevel);
            toast({
              title: `Niveau ${level} !`,
              description:
                rank.name !== prev.name
                  ? `Nouveau rang : ${rank.name}`
                  : `Rang ${rank.name} — continuez comme ça.`,
            });
          }
          lastLevel = level;
        })
        .catch(() => {});
    };
    checkLevel();
    const levelTimer = setInterval(checkLevel, 120_000);

    void (async () => {
      const identity = await ensureIdentity(instance.id);
      // Publish the device public key (retry a few times): without it, peers
      // cannot wrap message keys to this device and inbound messages become
      // undecryptable.
      let published = false;
      for (let attempt = 0; attempt < 3 && !published && !cancelled; attempt++) {
        try {
          await client.publishDeviceKey(identity.deviceId, toBase64(identity.keyPair.publicKey));
          published = true;
        } catch {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (cancelled) return;
      if (!published) {
        toast({
          title: "Clé de cet appareil non publiée",
          description: "Les nouveaux messages pourraient être illisibles — reconnectez-vous.",
        });
      }
      setMessagingRuntime({ client, identity, ws, myUserId: account.userId, instanceId: instance.id });

      // Phase 3 · Lot 4 — publish MLS KeyPackages + join queued Welcomes so this
      // device is addable, then route every re-joined group into the store. Native
      // (Tauri) only; the MLS engine lives in the Rust layer. A dev handle exposes
      // the runtime + enable action for manual E2E.
      if (isTauri()) {
        const identityLabel = `${account.userId}:${identity.deviceId}`;
        try {
          const joined = await bootstrapMls(client, instance.id, identity.deviceId, identityLabel);
          if (cancelled) return;
          for (const groupId of joined) {
            // Drain each group's backlog into the store BEFORE the ratchet keys are
            // consumed elsewhere (MLS forward secrecy makes this one-shot). The
            // conversation's protocol flag is loaded by the refresh below.
            await onMlsFrame(groupId).catch(() => {});
            if (cancelled) return;
          }
        } catch (e) {
          console.warn("MLS bootstrap failed", e);
        }
        if (import.meta.env.DEV) {
          (window as unknown as { __mls?: unknown }).__mls = {
            client,
            instanceId: instance.id,
            deviceId: identity.deviceId,
            userId: account.userId,
            enableMls: (conversationId: string) => enableMlsForConversation(conversationId),
          };
        }
      }

      await Promise.all([
        refreshFriends().catch(() => useFriendsStore.getState().setError(true)),
        refreshConversations().catch(() => {
          // Surface a distinct error+retry state instead of stranding on skeletons
          // OR falling through to the "empty account" state on a network failure.
          useConversationsStore.getState().setError(true);
        }),
      ]);

      // Key-transparency watchdog (Phase 3 · Lot 6): confirm the current signed log
      // head extends the one we last trusted. It records a "tampered" status on a
      // rewritten log, which the persistent <TransparencyBanner> surfaces.
      void monitorTransparency(client, instance.id);
    })();

    const unsubs = [
      // The socket does not replay events missed while disconnected, so re-sync
      // from REST on every (re)connect.
      ws.on("READY", () => {
        void resyncAll();
      }),
      ws.on("MESSAGE_CREATED", (e) => {
        if (e.type === "MESSAGE_CREATED") void onMessageCreated(e.conversation_id, e.message_id);
      }),
      ws.on("MESSAGE_UPDATED", (e) => {
        if (e.type === "MESSAGE_UPDATED") void onMessageUpdated(e.conversation_id);
      }),
      ws.on("MESSAGE_DELETED", (e) => {
        if (e.type === "MESSAGE_DELETED") onMessageDeleted(e.conversation_id, e.message_id);
      }),
      ws.on("MESSAGE_REACTED", (e) => {
        if (e.type === "MESSAGE_REACTED") void onMessageReacted(e.conversation_id, e.message_id);
      }),
      // Phase 3 · Lot 4 — an MLS frame landed: join if just added, then pull +
      // decrypt it and merge the recovered messages into the store. Native only.
      ws.on("MLS_FRAME", (e) => {
        if (e.type === "MLS_FRAME" && isTauri()) {
          void onMlsFrame(e.conversation_id).catch(() => {});
        }
      }),
      ws.on("TYPING", (e) => {
        if (e.type === "TYPING") onTyping(e.conversation_id, e.user_id);
      }),
      ws.on("CONVERSATION_MEMBER_ADDED", (e) => {
        if (e.type === "CONVERSATION_MEMBER_ADDED")
          void onMemberChange(e.conversation_id, e.user_id, "added");
      }),
      ws.on("CONVERSATION_MEMBER_REMOVED", (e) => {
        if (e.type === "CONVERSATION_MEMBER_REMOVED")
          void onMemberChange(e.conversation_id, e.user_id, "removed");
      }),
      ws.on("FRIEND_REQUEST", (e) => {
        if (e.type === "FRIEND_REQUEST") void onFriendEvent(e.user_id);
      }),
      ws.on("FRIEND_ACCEPTED", (e) => {
        if (e.type === "FRIEND_ACCEPTED") void onFriendEvent(e.user_id);
      }),
      ws.on("FRIEND_REMOVED", (e) => {
        if (e.type === "FRIEND_REMOVED") void onFriendEvent(e.user_id);
      }),
      // Phase 4 — incoming call: raise the ring prompt IMMEDIATELY (placeholder name)
      // so a CALL_END racing the async name lookup can still dismiss it; fill in the
      // resolved caller name after, but only if this same ring is still showing.
      ws.on("CALL_RING", (e) => {
        if (e.type !== "CALL_RING") return;
        if (!callSink) return;
        callSink.setIncoming({
          conversationId: e.conversation_id,
          from: e.from,
          fromName: "Appel entrant",
          callId: e.call_id,
          media: e.media,
        });
        void callerName(e.conversation_id, e.from).then((fromName) => {
          if (callSink?.incomingCallId() === e.call_id) callSink.renameIncoming(fromName);
        });
      }),
      ws.on("CALL_END", (e) => {
        if (e.type !== "CALL_END") return;
        callSink?.dismissIncoming(e.call_id); // coupe une sonnerie encore affichée
        useOngoingCallsStore.getState().clearCall(e.conversation_id, e.call_id);
        void teardownIfCallDone(e.conversation_id, e.call_id);
      }),
      ws.on("CALL_PARTICIPANT_JOINED", (e) => {
        if (e.type !== "CALL_PARTICIPANT_JOINED") return;
        useOngoingCallsStore.getState().participantJoined(e.conversation_id, e.call_id, e.user_id);
      }),
      ws.on("CALL_PARTICIPANT_LEFT", (e) => {
        if (e.type !== "CALL_PARTICIPANT_LEFT") return;
        useOngoingCallsStore.getState().participantLeft(e.conversation_id, e.call_id, e.user_id);
        void teardownIfCallDone(e.conversation_id, e.call_id);
      }),
    ];

    return () => {
      cancelled = true;
      clearInterval(levelTimer);
      for (const off of unsubs) off();
      clearMessagingRuntime();
      useFriendsStore.getState().reset();
      useConversationsStore.getState().reset();
      useMessagesStore.getState().reset();
      useOngoingCallsStore.getState().reset();
    };
  }, [client, ws, instance, account]);

  return <>{children}</>;
}
