/**
 * Voice/video call state (Phase 4). Owns ONE LiveKit Room. The Room itself is a
 * large mutable object kept in module scope (non-reactive); the store exposes
 * only reactive slices (status, roster, mic, active speakers). Remote audio
 * elements attach into a hidden sink so peers are audible.
 *
 * Lot 4: media is E2EE. The key is derived from the conversation's MLS group
 * exporter (all members converge on the same key; the SFU relays frames it cannot
 * read — the same server-blind invariant as messages). Conversations without an
 * MLS group (legacy, or browser dev where the native engine is absent) fall back
 * to cleartext media (dev only), reflected by `encrypted`.
 */

import type {
  ExternalE2EEKeyProvider as LkKeyProvider,
  LocalTrackPublication,
  Participant,
  RemoteTrack,
  Room as LkRoom,
  Track as LkTrack,
} from "livekit-client";
import { create } from "zustand";

/** livekit-client is roughly a third of the main bundle and only matters during
 * a call — load it on demand and cache the module for the session. */
let lkModule: typeof import("livekit-client") | null = null;
async function livekit(): Promise<typeof import("livekit-client")> {
  lkModule ??= await import("livekit-client");
  return lkModule;
}

import { playJoinSound, playLeaveSound } from "../lib/ringtones";
import { useMessagesStore } from "./useMessagesStore";
import { isTauri } from "../lib/isTauri";
import { VIEWER_MARK } from "../lib/popout";
import { useMediaSettingsStore } from "./useMediaSettingsStore";
import { useCallMediaStore } from "./useCallMediaStore";
import {
  endCall,
  heartbeatCall,
  joinCall,
  leaveCallOnServer,
  memberNames,
  requestCallKey,
} from "./messagingActions";

/** The single active Room (non-reactive). */
let currentRoom: LkRoom | null = null;
/** The active call's E2EE worker (non-reactive). A dedicated Worker keeps its OS
 * thread + WASM crypto context alive independent of the Room, so it must be
 * explicitly terminated on every teardown path — LiveKit never terminates it. */
let currentWorker: Worker | null = null;
/** Keeps our server-side call-roster entry alive while in a call (Phase 4 · L5c);
 * a missed heartbeat lets the server prune us so the roster self-heals on a crash. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startHeartbeat(conversationId: string): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => void heartbeatCall(conversationId), 20_000);
}
function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** Hidden container that holds attached remote <audio> elements. */
let audioSink: HTMLDivElement | null = null;
/** identity → its live video track (local camera + remote cameras). Video is
 * visible, so — unlike audio — it can't live in the hidden sink; tiles read this
 * map (non-reactive) and attach the track to their own <video>. The reactive
 * `videoParticipants` slice tells tiles which identities to render. */
const videoTracks = new Map<string, LkTrack>();
/** Attached remote <audio> elements, keyed like the tiles: `identity` for the
 * voice, `identity#screen` for a screen share's audio — so per-person voice
 * volume and per-stream volume each reach exactly their elements. */
const audioEls = new Map<string, HTMLMediaElement[]>();

const isViewer = (identity: string): boolean => identity.includes(VIEWER_MARK);

/** Persisted per-user voice volume (0..1). */
function voiceVolumeFor(identity: string): number {
  const userId = identity.split(":")[0];
  return useMediaSettingsStore.getState().voiceVolumes[userId] ?? 1;
}

function ensureAudioSink(): HTMLDivElement {
  if (!audioSink) {
    audioSink = document.createElement("div");
    audioSink.style.display = "none";
    audioSink.setAttribute("data-call-audio", "");
    document.body.appendChild(audioSink);
  }
  return audioSink;
}

type CallStatus = "idle" | "connecting" | "in-call" | "error";

/** An incoming call ring (Phase 4). */
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
  /** The active call's id (correlates ring/end). */
  callId: string | null;
  roomName: string | null;
  /** Participant identities present (including me). */
  participants: string[];
  /** This device's own participant identity ("userId:deviceId") — to identify the
   * self tile precisely (a same-account second device shares the userId prefix). */
  localIdentity: string | null;
  activeSpeakers: string[];
  /** user_id → username for the call's conversation (to label tiles). */
  names: Record<string, string>;
  micEnabled: boolean;
  /** Local camera is publishing. */
  cameraEnabled: boolean;
  /** Local screen share is publishing. */
  screenEnabled: boolean;
  /** Identities (local + remote) that currently have a video track to render.
   * Tiles read the track itself via `getVideoTrack`. */
  videoParticipants: string[];
  /** Media is end-to-end encrypted with the MLS-derived call key (false = the
   * conversation has no MLS group → cleartext media, dev only). */
  encrypted: boolean;
  /** Identities whose microphone is muted (remote mute badges). */
  mutedMics: string[];
  /** Per-stream audio volume (key `identity#screen`, 0..1, absent = 1). */
  screenVolumes: Record<string, number>;
  /** Tile shown large on the call stage (`identity` or `identity#screen`). */
  focusedTile: string | null;
  /** The browser blocked audio playback (needs a user gesture to resume). */
  audioBlocked: boolean;
  error: string | null;
  /** A ringing incoming call (raises the incoming-call prompt). */
  incoming: IncomingCall | null;
  /** Start a call. `existingCallId` (from an accepted ring) skips ringing. */
  startCall: (
    conversationId: string,
    opts?: { video?: boolean; existingCallId?: string },
  ) => Promise<void>;
  leaveCall: () => void;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  /** Start/stop sharing the screen (the OS picker prompts on start). */
  toggleScreenShare: () => Promise<void>;
  /** The live video track for an identity (local or remote), for a tile to attach. */
  getVideoTrack: (identity: string) => LkTrack | undefined;
  /** Per-person voice volume (persisted per user; applies live). */
  setVoiceVolume: (identity: string, v: number) => void;
  /** Per-stream audio volume (session; applies live). */
  setScreenVolume: (tile: string, v: number) => void;
  /** Show a tile large on the stage (null to close). */
  setFocusedTile: (tile: string | null) => void;
  resumeAudio: () => Promise<void>;
  setIncoming: (incoming: IncomingCall) => void;
  acceptIncoming: () => void;
  declineIncoming: () => void;
  /** Dismiss a ringing prompt if it matches the given call id (on CALL_END). */
  dismissIncoming: (callId: string) => void;
}

/** Pose un repère « appel manqué » dans le fil de la conversation.
 *
 * L'identifiant porte l'horodatage : deux appels manqués à la même seconde
 * seraient fusionnés, ce qui est un compromis acceptable là où deux repères
 * identiques n'apprendraient rien de plus. */
function noteMissedCall(conversationId: string, fromName: string): void {
  const now = new Date().toISOString();
  useMessagesStore.getState().upsert(conversationId, {
    id: `missed-call:${conversationId}:${now}`,
    senderId: null,
    senderDevice: "",
    createdAt: now,
    editedAt: null,
    deleted: false,
    content: null,
    replyTo: null,
    reactions: [],
    system: { kind: "missed_call", fromName },
  });
}

export const useCallStore = create<CallState>((set, get) => {
  const roster = (): string[] => {
    if (!currentRoom) return [];
    const ids = [currentRoom.localParticipant.identity];
    currentRoom.remoteParticipants.forEach((p) => {
      // Pop-out viewer connections of any user are spectators, not tiles.
      if (!isViewer(p.identity)) ids.push(p.identity);
    });
    return ids;
  };

  return {
    status: "idle",
    conversationId: null,
    callId: null,
    roomName: null,
    participants: [],
    localIdentity: null,
    activeSpeakers: [],
    names: {},
    micEnabled: false,
    cameraEnabled: false,
    screenEnabled: false,
    videoParticipants: [],
    encrypted: false,
    mutedMics: [],
    screenVolumes: {},
    focusedTile: null,
    audioBlocked: false,
    error: null,
    incoming: null,

    startCall: async (conversationId, opts) => {
      const existingCallId = opts?.existingCallId;
      const withVideo = opts?.video ?? false;
      const s = get();
      if (s.status === "connecting" || s.status === "in-call") return; // already busy
      set({
        status: "connecting",
        conversationId,
        callId: existingCallId ?? null,
        error: null,
        audioBlocked: false,
      });

      // Resolve member names for the tiles (cached; best-effort).
      void memberNames(conversationId)
        .then((names) => get().status !== "idle" && set({ names }))
        .catch(() => {});

      // The LiveKit module loads on demand (local chunk — fast after first call).
      const { Room, RoomEvent, Track, ExternalE2EEKeyProvider, isE2EESupported } =
        await livekit();
      if (get().status === "idle") return; // hung up while the module loaded

      // E2EE: derive the shared media key from the conversation's MLS group BEFORE
      // ringing anyone. Every member converges on the same AES key (HKDF over the 32
      // exporter bytes), so the SFU relays frames it cannot read. Null when there's
      // no MLS group (legacy conversation, or browser dev with no native engine).
      const callKey = await requestCallKey(conversationId).catch(() => null);
      if (get().status === "idle") return; // hung up while deriving the key
      // Fail CLOSED in the native app: media E2EE is mandatory there. If the key
      // couldn't be derived (e.g. a malicious server withholding the group Welcome),
      // refuse rather than relay server-readable audio — never silently downgrade.
      // Browser dev has no native engine and may run cleartext for single-client
      // testing only. (An arming failure is caught by a second gate below.)
      if (!callKey && isTauri()) {
        console.warn("[call] refused (fail-closed): no MLS call key for", conversationId);
        set({ status: "error", error: "Appel chiffré indisponible pour cette conversation" });
        return;
      }

      // Join (or start) the call server-side: this records us in the authoritative
      // roster, mints the LiveKit token, and — for the first joiner — rings the
      // others. The server assigns the canonical call id (a callee joins the same
      // one), so `existingCallId` no longer gates ringing; the server does.
      const creds = await joinCall(conversationId, withVideo ? "video" : "audio").catch(
        () => null,
      );
      if (get().status === "idle") {
        // Hung up during the join round-trip: our leaveCall may have raced the join
        // (leaving before we were in the roster), so leave again to clear the strand.
        if (creds) void leaveCallOnServer(conversationId);
        return;
      }
      if (!creds) {
        set({ status: "error", error: "Impossible de rejoindre l'appel" });
        return;
      }
      set({ callId: creds.call_id });

      // Lazy-load the LiveKit E2EE worker when we have a key + browser support.
      const e2eeSupported = isE2EESupported();
      console.debug("[call] e2ee precheck", {
        hasKey: !!callKey,
        supported: e2eeSupported,
        tauri: isTauri(),
      });
      let keyProvider: LkKeyProvider | undefined;
      let worker: Worker | undefined;
      let e2ee: { keyProvider: LkKeyProvider; worker: Worker } | undefined;
      if (callKey && e2eeSupported) {
        try {
          keyProvider = new ExternalE2EEKeyProvider();
          const { default: E2EEWorker } = await import("livekit-client/e2ee-worker?worker");
          worker = new E2EEWorker();
          e2ee = { keyProvider, worker };
        } catch (err) {
          console.error("[call] E2EE worker import failed:", err);
          worker?.terminate();
          keyProvider = undefined;
          worker = undefined;
          e2ee = undefined;
        }
      }
      // Hung up while the worker module was importing: currentRoom is still null so
      // leaveCall couldn't tear anything down — abort and terminate the fresh worker.
      if (get().status === "idle") {
        void leaveCallOnServer(conversationId); // leave the roster we joined above
        worker?.terminate();
        return;
      }

      // Preferred capture devices (Réglages → Audio & vidéo); a vanished id
      // falls back to the system default inside LiveKit.
      const media = useMediaSettingsStore.getState();
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        e2ee,
        audioCaptureDefaults: media.micId ? { deviceId: media.micId } : undefined,
        videoCaptureDefaults: media.camId ? { deviceId: media.camId } : undefined,
      });
      currentRoom = room;
      currentWorker = worker ?? null;
      const sink = ensureAudioSink();

      const syncVideo = () => set({ videoParticipants: [...videoTracks.keys()] });

      // Screen shares coexist with the same participant's camera: they key the
      // tile map under `identity#screen` (the banner labels them as such).
      const videoKey = (identity: string, source: unknown) =>
        source === Track.Source.ScreenShare ? `${identity}#screen` : identity;

      // Audio keys mirror the tile keys: screen-share audio under `#screen` so
      // its volume slider reaches it, the voice under the bare identity.
      const audioKey = (identity: string, source: unknown) =>
        source === Track.Source.ScreenShareAudio ? `${identity}#screen` : identity;

      room
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: Participant) => {
          // Audio attaches to the hidden sink; video is surfaced to the tiles.
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach();
            const key = audioKey(participant.identity, track.source);
            el.volume =
              track.source === Track.Source.ScreenShareAudio
                ? (get().screenVolumes[key] ?? 1)
                : voiceVolumeFor(participant.identity);
            audioEls.set(key, [...(audioEls.get(key) ?? []), el]);
            sink.appendChild(el);
          } else if (track.kind === Track.Kind.Video) {
            videoTracks.set(videoKey(participant.identity, track.source), track);
            syncVideo();
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: Participant) => {
          if (track.kind === Track.Kind.Audio) {
            // Audio elements live in the hidden sink and are hand-managed here.
            const key = audioKey(participant.identity, track.source);
            const detached = track.detach();
            detached.forEach((el) => el.remove());
            audioEls.set(
              key,
              (audioEls.get(key) ?? []).filter((el) => !detached.includes(el)),
            );
          } else if (track.kind === Track.Kind.Video) {
            // The <video> is React-owned (VideoTile). Just drop the track from the
            // map: the tile re-renders to an avatar and VideoTile's own cleanup
            // detaches. Removing the element here would rip it out behind React and
            // crash the next commit (removeChild on a missing node).
            videoTracks.delete(videoKey(participant.identity, track.source));
            syncVideo();
          }
        })
        // Local camera track: TrackSubscribed never fires for our own tracks, so
        // mirror the local video into the same map for the self-tile.
        .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
          if (pub.kind === Track.Kind.Video && pub.track) {
            videoTracks.set(videoKey(room.localParticipant.identity, pub.source), pub.track);
            syncVideo();
          }
        })
        .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
          if (pub.kind === Track.Kind.Video) {
            videoTracks.delete(videoKey(room.localParticipant.identity, pub.source));
            syncVideo();
            // The browser's own "stop sharing" ends the track without us: keep
            // the toggle truthful.
            if (pub.source === Track.Source.ScreenShare) set({ screenEnabled: false });
          }
        })
        // Un son bref à chaque mouvement : on suit qui entre et qui sort sans
        // avoir à regarder l'écran, ce qui est justement l'intérêt quand on est
        // en train de faire autre chose.
        // Les fenêtres pop-out se connectent comme des participants sans en être :
        // elles n'ont pas de tuile, et elles ne doivent pas faire de bruit non
        // plus, sinon ouvrir un stream sonnerait comme une arrivée.
        .on(RoomEvent.ParticipantConnected, (p: Participant) => {
          set({ participants: roster() });
          if (!isViewer(p.identity)) playJoinSound();
        })
        .on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
          set({ participants: roster() });
          if (!isViewer(p.identity)) playLeaveSound();
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
          set({ activeSpeakers: speakers.map((p) => p.identity) }),
        )
        // Remote mute badges (their mic publication mutes/unmutes).
        .on(RoomEvent.TrackMuted, (pub, participant: Participant) => {
          if (pub.source === Track.Source.Microphone) {
            set((s) => ({ mutedMics: [...new Set([...s.mutedMics, participant.identity])] }));
          }
        })
        .on(RoomEvent.TrackUnmuted, (pub, participant: Participant) => {
          if (pub.source === Track.Source.Microphone) {
            set((s) => ({ mutedMics: s.mutedMics.filter((i) => i !== participant.identity) }));
          }
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () =>
          set({ audioBlocked: !room.canPlaybackAudio }),
        )
        .on(RoomEvent.Disconnected, () => get().leaveCall());

      // Arm E2EE before connecting so every published frame is encrypted from the
      // first packet. Non-fatal: if arming fails we proceed in cleartext (reflected
      // by `encrypted`) rather than dropping the call.
      let encrypted = false;
      if (keyProvider && callKey) {
        try {
          await keyProvider.setKey(callKey.buffer);
          await room.setE2EEEnabled(true);
          encrypted = true;
        } catch (err) {
          console.error("[call] E2EE arming failed:", err);
          encrypted = false;
        }
      }

      // Fail closed (backstop): in the native app the media MUST be encrypted, so if
      // we hold a key but E2EE is unsupported or failed to arm, refuse rather than
      // connect in cleartext. Runs before connect, so nothing has hit the SFU yet.
      if (!encrypted && isTauri()) {
        console.warn("[call] refused (fail-closed): E2EE not armed", {
          hasKey: !!callKey,
          supported: e2eeSupported,
        });
        void leaveCallOnServer(conversationId); // leave the server roster we joined
        if (currentRoom === room) currentRoom = null;
        if (currentWorker === worker) currentWorker = null;
        worker?.terminate();
        room.removeAllListeners();
        void room.disconnect();
        if (get().status !== "idle") {
          set({ status: "error", error: "Chiffrement de l'appel indisponible" });
        }
        return;
      }

      try {
        await room.connect(creds.url, creds.token);
      } catch (e) {
        console.error("[call] room.connect failed:", e);
        // We already joined the server roster (and may have rung the others) before
        // connecting, so leave it — otherwise we strand a phantom participant and the
        // peers keep ringing a call we can't join.
        void leaveCallOnServer(conversationId);
        stopHeartbeat();
        // Only reclaim currentRoom/worker if still ours (leaveCall may have nulled them).
        if (currentRoom === room) currentRoom = null;
        if (currentWorker === worker) currentWorker = null;
        worker?.terminate(); // a Worker outlives the Room — terminate it explicitly
        room.removeAllListeners(); // don't let the disconnect re-enter leaveCall
        void room.disconnect();
        // A hang-up during connect already reset us to idle — don't surface an error.
        if (get().status !== "idle") {
          set({ status: "error", error: e instanceof Error ? e.message : "Échec de connexion" });
        }
        return;
      }

      // Hung up (or superseded) while connecting: leaveCall already reset the store.
      // Tear this now-orphaned room + worker down and abort.
      if (currentRoom !== room || get().status === "idle") {
        if (currentRoom === room) currentRoom = null;
        if (currentWorker === worker) currentWorker = null;
        worker?.terminate();
        room.removeAllListeners();
        void room.disconnect();
        return;
      }

      // Preferred speaker (audio output routing for every attached element).
      if (media.speakerId) {
        await room.switchActiveDevice("audiooutput", media.speakerId).catch(() => {});
      }

      // Connected. Enabling the mic can fail (permission denied / no device) — that
      // must NOT drop the call: stay in-call, muted, so the user sees the call and
      // can retry the mic.
      let micOn = false;
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        micOn = true;
      } catch {
        /* mic unavailable — remain in the call, muted */
      }
      // A video call also enables the camera up front (same non-fatal contract:
      // a denied camera keeps the call alive, just without our video).
      let camOn = false;
      if (withVideo) {
        try {
          await room.localParticipant.setCameraEnabled(true);
          camOn = true;
        } catch {
          /* camera unavailable — stay in the call without publishing video */
        }
      }
      // Hung up (or superseded) during the mic/camera enable — a camera-permission
      // dialog can block for seconds, exactly when the user abandons. leaveCall
      // already tore this room down; don't resurrect a phantom call bound to it.
      if (currentRoom !== room || get().status === "idle") return;
      set({
        status: "in-call",
        roomName: creds.room,
        participants: roster(),
        localIdentity: room.localParticipant.identity,
        micEnabled: micOn,
        cameraEnabled: camOn,
        encrypted,
        audioBlocked: !room.canPlaybackAudio,
      });
      startHeartbeat(conversationId); // keep our server-roster entry alive
      void useCallMediaStore.getState().start(conversationId, creds.call_id);
    },

    leaveCall: () => {
      const { conversationId } = get();
      useCallMediaStore.getState().stop();
      stopHeartbeat();
      // Leave the server roster: peers get CALL_PARTICIPANT_LEFT, or CALL_END if we
      // were the last one (which also dismisses any still-ringing prompt).
      if (conversationId) void leaveCallOnServer(conversationId);

      const room = currentRoom;
      currentRoom = null;
      const worker = currentWorker;
      currentWorker = null;
      if (room) {
        room.removeAllListeners();
        void room.disconnect();
      }
      worker?.terminate(); // LiveKit never terminates the app-created E2EE worker
      audioSink?.replaceChildren();
      videoTracks.clear();
      audioEls.clear();
      set({
        status: "idle",
        conversationId: null,
        callId: null,
        roomName: null,
        participants: [],
        localIdentity: null,
        activeSpeakers: [],
        names: {},
        micEnabled: false,
        cameraEnabled: false,
        screenEnabled: false,
        videoParticipants: [],
        encrypted: false,
        mutedMics: [],
        screenVolumes: {},
        focusedTile: null,
        audioBlocked: false,
        error: null,
      });
    },

    toggleMic: async () => {
      const room = currentRoom;
      if (!room || get().status !== "in-call") return;
      const next = !get().micEnabled;
      try {
        await room.localParticipant.setMicrophoneEnabled(next);
        set({ micEnabled: next }); // reflect only the real, applied track state
      } catch {
        /* device/permission failure — leave the indicator on the real state */
      }
    },

    toggleCamera: async () => {
      const room = currentRoom;
      if (!room || get().status !== "in-call") return;
      const next = !get().cameraEnabled;
      try {
        await room.localParticipant.setCameraEnabled(next);
        set({ cameraEnabled: next }); // reflect only the real, applied track state
        // LocalTrackPublished/Unpublished keeps videoTracks + videoParticipants in sync.
      } catch {
        /* device/permission failure — leave the indicator on the real state */
      }
    },

    toggleScreenShare: async () => {
      const room = currentRoom;
      if (!room || get().status !== "in-call") return;
      const next = !get().screenEnabled;
      try {
        // Share WITH audio where the platform captures it (WebView2/Chromium);
        // WKWebView has no system-audio capture → retry video-only.
        try {
          await room.localParticipant.setScreenShareEnabled(next, { audio: true });
        } catch {
          if (!next) throw new Error("stop failed");
          await room.localParticipant.setScreenShareEnabled(next, { audio: false });
        }
        set({ screenEnabled: next });
      } catch {
        /* picker dismissed or unsupported — leave the state truthful */
      }
    },

    getVideoTrack: (identity) => videoTracks.get(identity),

    setVoiceVolume: (identity, v) => {
      const userId = identity.split(":")[0];
      useMediaSettingsStore.getState().setVoiceVolume(userId, v);
      // Applies to every mic element of every device of that user, live.
      for (const [key, els] of audioEls) {
        if (!key.endsWith("#screen") && key.split(":")[0] === userId) {
          els.forEach((el) => {
            el.volume = Math.min(1, Math.max(0, v));
          });
        }
      }
    },

    setScreenVolume: (tile, v) => {
      const vol = Math.min(1, Math.max(0, v));
      set((s) => ({ screenVolumes: { ...s.screenVolumes, [tile]: vol } }));
      (audioEls.get(tile) ?? []).forEach((el) => {
        el.volume = vol;
      });
    },

    setFocusedTile: (tile) => set({ focusedTile: tile }),

    resumeAudio: async () => {
      await currentRoom?.startAudio().catch(() => {});
      set({ audioBlocked: currentRoom ? !currentRoom.canPlaybackAudio : false });
    },

    setIncoming: (incoming) => set({ incoming }),

    acceptIncoming: () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      // Already in a call: we can't join a second one (startCall's busy-guard would
      // swallow it), so decline it — otherwise the new caller rings forever.
      if (get().status !== "idle") {
        void endCall(inc.conversationId, inc.callId);
        return;
      }
      // Match the caller's media: accepting a video ring turns our camera on too.
      void get().startCall(inc.conversationId, {
        video: inc.media === "video",
        existingCallId: inc.callId,
      });
    },

    declineIncoming: () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      void endCall(inc.conversationId, inc.callId); // tell the caller
    },

    dismissIncoming: (callId) => {
      const inc = get().incoming;
      // La sonnerie s'arrête alors qu'on n'a pas décroché : l'appelant a
      // raccroché. Sans trace dans le fil, un appel manqué disparaît sans
      // laisser le moindre indice — on ne sait même pas qu'on a raté quelque
      // chose. Le repère est purement local : le serveur ne voit pas passer les
      // conversations, il ne pourrait pas le poser à notre place.
      if (inc?.callId === callId) noteMissedCall(inc.conversationId, inc.fromName);
      set((s) => (s.incoming?.callId === callId ? { incoming: null } : s));
    },
  };
});

// Hot device switch: changing mic/camera/output in Réglages applies to the
// LIVE call immediately — no more leave-and-rejoin. `switchActiveDevice`
// replaces the captured track (or reroutes playback) in place.
useMediaSettingsStore.subscribe((state, prev) => {
  const room = currentRoom;
  if (!room || useCallStore.getState().status !== "in-call") return;
  if (state.micId !== prev.micId) {
    void room.switchActiveDevice("audioinput", state.micId ?? "default").catch(() => {});
  }
  if (state.camId !== prev.camId) {
    void room.switchActiveDevice("videoinput", state.camId ?? "default").catch(() => {});
  }
  if (state.speakerId !== prev.speakerId) {
    void room.switchActiveDevice("audiooutput", state.speakerId ?? "default").catch(() => {});
  }
});
