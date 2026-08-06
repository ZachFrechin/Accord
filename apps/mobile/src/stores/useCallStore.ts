/**
 * Appels vocaux et vidéo sur téléphone.
 *
 * Volontairement plus simple que la version de bureau : pas de partage d'écran
 * (la WebView Android ne sait pas capturer l'écran), pas de fenêtres détachées,
 * pas de scène. Ce qu'un téléphone doit faire, il le fait bien : parler,
 * s'entendre, se voir, et basculer entre écouteur et haut-parleur.
 *
 * Le média est chiffré de bout en bout avec une clé dérivée du groupe MLS de la
 * conversation — le serveur relaie des paquets qu'il ne peut pas décoder, comme
 * pour les messages. Sans cette clé, l'appel est REFUSÉ : mieux vaut ne pas
 * appeler que de faire transiter une voix en clair alors que l'application
 * promet le contraire.
 */

import type {
  ExternalE2EEKeyProvider as LkKeyProvider,
  Participant,
  RemoteTrack,
  Room as LkRoom,
  Track as LkTrack,
} from "livekit-client";
import { create } from "zustand";

import {
  endCall,
  heartbeatCall,
  joinCall,
  leaveCallOnServer,
  memberNames,
  requestCallKey,
} from "@accord/core/stores/messagingActions";

/** LiveKit pèse lourd et ne sert qu'en appel : chargé à la demande. */
let lkModule: typeof import("livekit-client") | null = null;
async function livekit(): Promise<typeof import("livekit-client")> {
  lkModule ??= await import("livekit-client");
  return lkModule;
}

/** La salle active (objet mutable volumineux, hors du state réactif). */
let room: LkRoom | null = null;
/** Le worker de chiffrement : LiveKit ne le termine jamais lui-même, et un
 *  worker abandonné garde son fil et son contexte WASM vivants. */
let worker: Worker | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
/** Conteneur caché des éléments audio distants. */
let audioSink: HTMLDivElement | null = null;
/** identité → piste vidéo vivante ; les tuiles s'y branchent. */
const videoTracks = new Map<string, LkTrack>();

function sink(): HTMLDivElement {
  if (!audioSink) {
    audioSink = document.createElement("div");
    audioSink.style.display = "none";
    document.body.appendChild(audioSink);
  }
  return audioSink;
}

export type CallStatus = "idle" | "connecting" | "in-call" | "error";

/** Un appel entrant qui sonne. */
export interface IncomingCall {
  conversationId: string;
  from: string;
  fromName: string;
  callId: string;
  media: string;
}

interface CallState {
  status: CallStatus;
  conversationId: string | null;
  callId: string | null;
  /** Identités présentes, la nôtre comprise. */
  participants: string[];
  localIdentity: string | null;
  /** Qui parle en ce moment. */
  activeSpeakers: string[];
  /** user_id → nom, pour étiqueter les tuiles. */
  names: Record<string, string>;
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** Sortie sur le haut-parleur plutôt que l'écouteur. */
  speakerOn: boolean;
  /** Identités ayant une vidéo à afficher. */
  videoParticipants: string[];
  /** Micros coupés côté distant. */
  mutedMics: string[];
  error: string | null;
  /** Appel entrant en train de sonner (null = aucun). */
  incoming: IncomingCall | null;

  setIncoming: (call: IncomingCall) => void;
  acceptIncoming: () => void;
  declineIncoming: () => void;
  /** Écarte la sonnerie si elle correspond — l'appelant a raccroché. */
  dismissIncoming: (callId: string) => void;
  start: (conversationId: string, opts?: { video?: boolean }) => Promise<void>;
  leave: () => void;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleSpeaker: () => Promise<void>;
  videoTrack: (identity: string) => LkTrack | undefined;
}

export const useCallStore = create<CallState>((set, get) => {
  const roster = (): string[] => {
    if (!room) return [];
    const ids = [room.localParticipant.identity];
    room.remoteParticipants.forEach((p) => ids.push(p.identity));
    return ids;
  };

  const syncVideo = (): void => set({ videoParticipants: [...videoTracks.keys()] });

  /** Démonte tout. Appelé par `leave` ET par une déconnexion subie. */
  const teardown = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    videoTracks.clear();
    if (audioSink) audioSink.innerHTML = "";
    room?.disconnect();
    room = null;
    // Le worker survit à la salle : sans terminaison explicite, chaque appel en
    // laisse un derrière lui.
    worker?.terminate();
    worker = null;
    set({
      status: "idle",
      conversationId: null,
      callId: null,
      participants: [],
      localIdentity: null,
      activeSpeakers: [],
      micEnabled: false,
      cameraEnabled: false,
      videoParticipants: [],
      mutedMics: [],
    });
  };

  return {
    status: "idle",
    conversationId: null,
    callId: null,
    participants: [],
    localIdentity: null,
    activeSpeakers: [],
    names: {},
    micEnabled: false,
    cameraEnabled: false,
    speakerOn: true,
    videoParticipants: [],
    mutedMics: [],
    error: null,
    incoming: null,

    setIncoming: (incoming) => {
      // Déjà en ligne : on ne fait pas sonner par-dessus une conversation en
      // cours, ce serait la couvrir.
      if (get().status !== "idle") return;
      set({ incoming });
    },

    acceptIncoming: () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      void get().start(inc.conversationId, { video: inc.media === "video" });
    },

    declineIncoming: () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      // Prévenir l'appelant : sans ça il entend la tonalité jusqu'au délai.
      void endCall(inc.conversationId, inc.callId);
    },

    dismissIncoming: (callId) =>
      set((s) => (s.incoming?.callId === callId ? { incoming: null } : s)),

    start: async (conversationId, opts) => {
      const withVideo = opts?.video ?? false;
      if (get().status !== "idle") return; // déjà en ligne
      set({ status: "connecting", conversationId, error: null });

      void memberNames(conversationId)
        .then((names) => get().status !== "idle" && set({ names }))
        .catch(() => {});

      const { Room, RoomEvent, Track, ExternalE2EEKeyProvider, isE2EESupported } =
        await livekit();
      if (get().status === "idle") return; // raccroché pendant le chargement

      // La clé de média vient du groupe MLS : tous les membres convergent vers
      // la même, et le serveur relaie sans pouvoir décoder.
      const callKey = await requestCallKey(conversationId).catch(() => null);
      if (get().status === "idle") return;
      if (!callKey) {
        // Refus net plutôt qu'une voix en clair : l'application promet le
        // chiffrement de bout en bout, elle ne le retire pas en silence.
        set({
          status: "error",
          error: "Appel chiffré indisponible pour cette conversation",
        });
        return;
      }

      const creds = await joinCall(conversationId, withVideo ? "video" : "audio").catch(
        () => null,
      );
      if (get().status === "idle") {
        // Raccroché pendant l'aller-retour : notre départ a pu précéder notre
        // inscription, on repart donc une seconde fois pour ne pas rester
        // fantôme dans la liste des participants.
        if (creds) void leaveCallOnServer(conversationId);
        return;
      }
      if (!creds) {
        set({ status: "error", error: "Impossible de rejoindre l'appel" });
        return;
      }
      set({ callId: creds.call_id });

      let keyProvider: LkKeyProvider | undefined;
      if (isE2EESupported()) {
        try {
          keyProvider = new ExternalE2EEKeyProvider();
          const { default: E2EEWorker } = await import("livekit-client/e2ee-worker?worker");
          worker = new E2EEWorker();
          await keyProvider.setKey(callKey);
        } catch (e) {
          console.warn("[appel] chiffrement du média indisponible", e);
          keyProvider = undefined;
          worker?.terminate();
          worker = null;
        }
      }
      if (!keyProvider || !worker) {
        set({ status: "error", error: "Chiffrement du média indisponible sur cet appareil" });
        void leaveCallOnServer(conversationId);
        return;
      }

      const r = new Room({
        adaptiveStream: true,
        dynacast: true,
        e2ee: { keyProvider, worker },
      });
      room = r;

      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: Participant) => {
        if (track.kind === Track.Kind.Audio) {
          sink().appendChild(track.attach());
        } else if (track.kind === Track.Kind.Video) {
          videoTracks.set(participant.identity, track);
          syncVideo();
        }
      })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: Participant) => {
          track.detach().forEach((el) => el.remove());
          if (track.kind === Track.Kind.Video) {
            videoTracks.delete(participant.identity);
            syncVideo();
          }
        })
        .on(RoomEvent.ParticipantConnected, () => set({ participants: roster() }))
        .on(RoomEvent.ParticipantDisconnected, () => set({ participants: roster() }))
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
          set({ activeSpeakers: speakers.map((p) => p.identity) }),
        )
        .on(RoomEvent.TrackMuted, (_pub, p: Participant) =>
          set((s) => ({ mutedMics: [...new Set([...s.mutedMics, p.identity])] })),
        )
        .on(RoomEvent.TrackUnmuted, (_pub, p: Participant) =>
          set((s) => ({ mutedMics: s.mutedMics.filter((id) => id !== p.identity) })),
        )
        // Le serveur nous a lâchés (réseau coupé, mise en veille prolongée) :
        // on range tout, sans quoi l'interface montrerait un appel qui n'existe
        // plus et le bouton « raccrocher » n'aurait rien à raccrocher.
        .on(RoomEvent.Disconnected, () => teardown());

      try {
        await r.connect(creds.url, creds.token);
        await r.localParticipant.setMicrophoneEnabled(true);
        if (withVideo) await r.localParticipant.setCameraEnabled(true);
      } catch (e) {
        console.warn("[appel] connexion impossible", e);
        teardown();
        void leaveCallOnServer(conversationId);
        set({ status: "error", error: "Connexion à l'appel impossible" });
        return;
      }

      heartbeat = setInterval(() => void heartbeatCall(conversationId), 20_000);
      set({
        status: "in-call",
        participants: roster(),
        localIdentity: r.localParticipant.identity,
        micEnabled: true,
        cameraEnabled: withVideo,
      });
    },

    leave: () => {
      const conversationId = get().conversationId;
      teardown();
      if (conversationId) void leaveCallOnServer(conversationId);
    },

    toggleMic: async () => {
      if (!room) return;
      const next = !get().micEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      set({ micEnabled: next });
    },

    toggleCamera: async () => {
      if (!room) return;
      const next = !get().cameraEnabled;
      await room.localParticipant.setCameraEnabled(next);
      // La caméra locale s'affiche comme les autres : on se voit dans la grille.
      const pub = room.localParticipant.getTrackPublication(
        (await livekit()).Track.Source.Camera,
      );
      const track = pub?.track;
      if (next && track) videoTracks.set(room.localParticipant.identity, track);
      else videoTracks.delete(room.localParticipant.identity);
      syncVideo();
      set({ cameraEnabled: next });
    },

    toggleSpeaker: async () => {
      const next = !get().speakerOn;
      // Sur Android la WebView n'expose pas le routage audio natif : on bascule
      // la propriété des éléments <audio>, ce que Chrome traduit en choix
      // écouteur/haut-parleur. Imparfait mais sans code natif.
      const els = audioSink?.querySelectorAll("audio") ?? [];
      for (const el of els) {
        const media = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
        await media.setSinkId?.(next ? "speaker" : "earpiece").catch(() => {});
      }
      set({ speakerOn: next });
    },

    videoTrack: (identity) => videoTracks.get(identity),
  };
});
