import { create } from "zustand";

import type { CallMediaWireState } from "@accord/core/api/ApiClient";
import { ApiError } from "@accord/core/api/http";
import {
  CALL_CUSTOM_SOUND_LEAD_MS,
  EventDeduplicator,
  decryptCallMediaJson,
  emptySharedMediaState,
  encryptCallMediaJson,
  estimateServerClockOffsetMs,
  expectedMediaPositionSeconds,
  remainingSoundDelayMs,
  reduceSharedMedia,
  shouldDropSoundEvent,
  validateSharedMediaState,
  type SharedMediaAction,
  type SharedMediaStateV1,
} from "@accord/core/lib/callMedia";
import type { AttachmentRef } from "@accord/core/lib/messaging";
import {
  cachePersonalSoundAttachment,
  type PersonalSoundClip,
} from "@accord/core/lib/soundboard";
import {
  callMediaContext,
  downloadAttachment,
  getCallMediaState,
  putCallMediaState,
  sendCallSoundTrigger,
  uploadCallSound,
} from "@accord/core/stores/messagingActions";

export const BUILTIN_SOUNDS = [
  { id: "pop", label: "Pop" },
  { id: "chime", label: "Carillon" },
  { id: "laser", label: "Laser" },
  { id: "bass-drop", label: "Bass drop" },
  { id: "buzzer", label: "Buzzer" },
  { id: "rimshot", label: "Rimshot" },
  { id: "victory", label: "Victoire" },
  { id: "fail", label: "Échec" },
] as const;

interface MediaCryptoContext {
  key: CryptoKey;
  epoch: number;
  deviceId: string;
  userId: string;
  baseUrl: string;
}

export interface IncomingMediaState {
  conversationId: string;
  callId: string;
  revision: number;
  ciphertext: string;
  nonce: string;
  updatedAtMs: number;
}

export interface IncomingSoundTrigger {
  conversationId: string;
  callId: string;
  eventId: string;
  scheduledAtMs: number;
  blobId?: string;
  ciphertext: string;
  nonce: string;
}

interface SoundPayloadBuiltin {
  v: 1;
  kind: "builtin";
  soundId: (typeof BUILTIN_SOUNDS)[number]["id"];
}
interface SoundPayloadCustom {
  v: 1;
  kind: "custom";
  attachment: AttachmentRef;
  label: string;
}
type SoundPayload = SoundPayloadBuiltin | SoundPayloadCustom;

interface CallMediaState {
  active: boolean;
  available: boolean;
  conversationId: string | null;
  callId: string | null;
  bridgeUrl: string | null;
  revision: number;
  shared: SharedMediaStateV1 | null;
  serverClockOffsetMs: number;
  musicVolume: number;
  musicMuted: boolean;
  effectsVolume: number;
  effectsMuted: boolean;
  audioBlocked: boolean;
  youtubeError: number | null;
  playerHidden: boolean;
  error: string | null;
  start: (conversationId: string, callId: string) => Promise<void>;
  stop: () => void;
  reconcile: () => Promise<void>;
  applyMediaState: (event: IncomingMediaState) => void;
  applySoundTrigger: (event: IncomingSoundTrigger) => void;
  mutate: (action: SharedMediaAction) => Promise<void>;
  triggerBuiltin: (soundId: SoundPayloadBuiltin["soundId"]) => Promise<void>;
  prepareCustom: (clip: PersonalSoundClip) => Promise<PersonalSoundClip | null>;
  triggerCustom: (clip: PersonalSoundClip) => Promise<void>;
  setMusicVolume: (volume: number) => void;
  setMusicMuted: (muted: boolean) => void;
  setEffectsVolume: (volume: number) => void;
  setEffectsMuted: (muted: boolean) => void;
  setAudioBlocked: (blocked: boolean) => void;
  setYoutubeError: (code: number | null) => void;
  setPlayerHidden: (hidden: boolean) => void;
  enableAudio: () => Promise<void>;
}

let mediaContext: MediaCryptoContext | null = null;
let mutationChain: Promise<void> = Promise.resolve();
let audioContext: AudioContext | null = null;
let overlappingEffects = 0;
const decodedSounds = new Map<string, AudioBuffer>();
const decodedSoundPromises = new Map<string, Promise<AudioBuffer | null>>();
const soundPreparationPromises = new Map<string, Promise<AttachmentRef | null>>();
const soundEvents = new EventDeduplicator();

function localNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function contextForSound(): AudioContext {
  audioContext ??= new AudioContext();
  return audioContext;
}

function oscillator(
  context: AudioContext,
  at: number,
  frequency: number,
  duration: number,
  gainValue: number,
  endFrequency = frequency,
  type: OscillatorType = "sine",
): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), at + duration);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(context.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
  overlappingEffects += 1;
  osc.onended = () => {
    overlappingEffects = Math.max(0, overlappingEffects - 1);
    osc.disconnect();
    gain.disconnect();
  };
}

function playBuiltin(soundId: SoundPayloadBuiltin["soundId"], delayMs: number, volume: number): void {
  if (overlappingEffects >= 3) return;
  const context = contextForSound();
  const at = context.currentTime + Math.max(0, delayMs) / 1_000;
  const v = Math.max(0.0001, volume * 0.3);
  switch (soundId) {
    case "pop": oscillator(context, at, 520, 0.09, v, 220); break;
    case "chime":
      oscillator(context, at, 660, 0.35, v, 990);
      oscillator(context, at + 0.12, 880, 0.4, v * 0.8, 1_320);
      break;
    case "laser": oscillator(context, at, 1_800, 0.35, v, 110, "sawtooth"); break;
    case "bass-drop": oscillator(context, at, 180, 0.75, v * 1.2, 38, "sine"); break;
    case "buzzer": oscillator(context, at, 150, 0.45, v, 145, "square"); break;
    case "rimshot":
      oscillator(context, at, 280, 0.08, v, 100, "triangle");
      oscillator(context, at + 0.13, 1_000, 0.06, v * 0.7, 600, "square");
      break;
    case "victory":
      [523, 659, 784, 1_047].forEach((f, i) => oscillator(context, at + i * 0.13, f, 0.3, v, f));
      break;
    case "fail":
      [392, 370, 349, 294].forEach((f, i) => oscillator(context, at + i * 0.18, f, 0.32, v, f));
      break;
  }
}

async function playCustom(
  attachment: AttachmentRef,
  scheduledAtMs: number,
  serverClockOffsetMs: number,
  volume: number,
): Promise<void> {
  if (overlappingEffects >= 3) return;
  const context = contextForSound();
  let buffer = decodedSounds.get(attachment.blob_id);
  if (!buffer) {
    const bytes = await downloadAttachment(attachment);
    if (!bytes) return;
    buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    decodedSounds.set(attachment.blob_id, buffer);
  }
  if (overlappingEffects >= 3) return;
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  gain.gain.value = volume;
  source.connect(gain).connect(context.destination);
  overlappingEffects += 1;
  source.onended = () => {
    overlappingEffects = Math.max(0, overlappingEffects - 1);
    source.disconnect();
    gain.disconnect();
  };
  const delayMs = remainingSoundDelayMs(scheduledAtMs, Date.now(), serverClockOffsetMs);
  source.start(context.currentTime + Math.max(0, delayMs) / 1_000);
}

async function cacheLocalSoundBuffer(
  clip: PersonalSoundClip,
  attachment: AttachmentRef,
): Promise<AudioBuffer | null> {
  const blobId = attachment.blob_id;
  const cached = decodedSounds.get(blobId);
  if (cached) return cached;
  const existing = decodedSoundPromises.get(blobId);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const context = contextForSound();
      const buffer = await context.decodeAudioData(await clip.wav.arrayBuffer());
      decodedSounds.set(blobId, buffer);
      return buffer;
    } catch {
      return null;
    } finally {
      decodedSoundPromises.delete(blobId);
    }
  })();
  decodedSoundPromises.set(blobId, pending);
  return pending;
}

async function prepareCustomAttachment(
  clip: PersonalSoundClip,
  conversationId: string,
): Promise<AttachmentRef | null> {
  const cached = clip.attachments[conversationId];
  if (cached) {
    await cacheLocalSoundBuffer(clip, cached);
    return cached;
  }
  const cacheKey = `${conversationId}:${clip.id}`;
  const existing = soundPreparationPromises.get(cacheKey);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const attachment = await uploadCallSound(conversationId, clip.wav, clip.label);
      if (!attachment) return null;
      await cachePersonalSoundAttachment(clip.id, conversationId, attachment);
      await cacheLocalSoundBuffer(clip, attachment);
      return attachment;
    } finally {
      soundPreparationPromises.delete(cacheKey);
    }
  })();
  soundPreparationPromises.set(cacheKey, pending);
  return pending;
}

function wireEvent(state: CallMediaWireState, conversationId: string): IncomingMediaState {
  return {
    conversationId,
    callId: state.call_id,
    revision: state.revision,
    ciphertext: state.ciphertext,
    nonce: state.nonce,
    updatedAtMs: state.updated_at_ms,
  };
}

async function decodeState(event: IncomingMediaState): Promise<SharedMediaStateV1 | null> {
  if (!mediaContext) return null;
  try {
    const value = await decryptCallMediaJson<unknown>(
      mediaContext.key,
      { ciphertext: event.ciphertext, nonce: event.nonce },
      {
        conversationId: event.conversationId,
        callId: event.callId,
        epoch: mediaContext.epoch,
        purpose: "state",
      },
    );
    return validateSharedMediaState(value);
  } catch {
    return null;
  }
}

export const useCallMediaStore = create<CallMediaState>((set, get) => ({
  active: false,
  available: false,
  conversationId: null,
  callId: null,
  bridgeUrl: null,
  revision: 0,
  shared: null,
  serverClockOffsetMs: 0,
  musicVolume: localNumber("accord.call-media.music-volume", 0.8),
  musicMuted: localStorage.getItem("accord.call-media.music-muted") === "true",
  effectsVolume: localNumber("accord.call-media.effects-volume", 0.8),
  effectsMuted: localStorage.getItem("accord.call-media.effects-muted") === "true",
  audioBlocked: false,
  youtubeError: null,
  playerHidden: false,
  error: null,

  start: async (conversationId, callId) => {
    get().stop();
    set({ active: true, conversationId, callId, error: null });
    const context = await callMediaContext(conversationId, callId).catch(() => null);
    if (!context || get().conversationId !== conversationId || get().callId !== callId) {
      set({ available: false, error: "Média partagé chiffré indisponible" });
      return;
    }
    mediaContext = context;
    set({
      available: true,
      bridgeUrl: `${context.baseUrl}/integrations/youtube/player`,
    });
    try {
      const audio = contextForSound();
      await audio.resume();
      set({ audioBlocked: audio.state !== "running" });
    } catch {
      set({ audioBlocked: true });
    }
    await get().reconcile();
  },

  stop: () => {
    mediaContext = null;
    mutationChain = Promise.resolve();
    set({
      active: false,
      available: false,
      conversationId: null,
      callId: null,
      bridgeUrl: null,
      revision: 0,
      shared: null,
      serverClockOffsetMs: 0,
      audioBlocked: false,
      youtubeError: null,
      error: null,
    });
  },

  reconcile: async () => {
    const { conversationId, callId } = get();
    if (!conversationId || !callId || !mediaContext) return;
    const refreshedContext = await callMediaContext(conversationId, callId).catch(() => null);
    if (!refreshedContext) return;
    mediaContext = refreshedContext;
    const started = Date.now();
    const response = await getCallMediaState(conversationId).catch(() => null);
    const received = Date.now();
    if (!response) {
      set({ available: false });
      return;
    }
    if (response.call_id !== callId || get().callId !== callId) return;
    set({ available: true });
    const offset = estimateServerClockOffsetMs(started, received, response.server_now_ms);
    set({ serverClockOffsetMs: offset });
    if (response.state) {
      const decoded = await decodeState(wireEvent(response.state, conversationId));
      if (decoded && decoded.epoch === refreshedContext.epoch) {
        set({ revision: response.state.revision, shared: decoded, error: null });
        return;
      }
      // Membership/epoch changed: old ciphertext is intentionally unreadable.
      // Replace it with an empty state under the new domain-separated key.
      const fresh = emptySharedMediaState(refreshedContext.epoch, response.server_now_ms);
      set({ revision: response.state.revision, shared: fresh });
      await get().mutate({ type: "seek", positionSeconds: 0, serverNowMs: response.server_now_ms });
      return;
    }
    const fresh = emptySharedMediaState(refreshedContext.epoch, response.server_now_ms);
    set({ revision: 0, shared: fresh });
    await get().mutate({ type: "seek", positionSeconds: 0, serverNowMs: response.server_now_ms });
  },

  applyMediaState: (event) => {
    const current = get();
    if (
      event.conversationId !== current.conversationId ||
      event.callId !== current.callId ||
      event.revision <= current.revision
    ) return;
    if (event.revision > current.revision + 1) {
      void get().reconcile();
      return;
    }
    void decodeState(event).then((decoded) => {
      if (!decoded || decoded.epoch !== mediaContext?.epoch) {
        void get().reconcile();
        return;
      }
      if (get().callId === event.callId && event.revision > get().revision) {
        set({ revision: event.revision, shared: decoded, error: null });
      }
    });
  },

  applySoundTrigger: (event) => {
    const current = get();
    if (
      event.conversationId !== current.conversationId ||
      event.callId !== current.callId ||
      !mediaContext ||
      !soundEvents.accept(event.eventId)
    ) return;
    const estimatedServerNow = Date.now() + current.serverClockOffsetMs;
    if (shouldDropSoundEvent(event.scheduledAtMs, estimatedServerNow)) return;
    void decryptCallMediaJson<SoundPayload>(
      mediaContext.key,
      { ciphertext: event.ciphertext, nonce: event.nonce },
      {
        conversationId: event.conversationId,
        callId: event.callId,
        epoch: mediaContext.epoch,
        purpose: "sound",
      },
    ).then((payload) => {
      if (payload.v !== 1 || get().effectsMuted) return;
      const delay = event.scheduledAtMs - (Date.now() + get().serverClockOffsetMs);
      if (payload.kind === "builtin") playBuiltin(payload.soundId, delay, get().effectsVolume);
      else void playCustom(
        payload.attachment,
        event.scheduledAtMs,
        get().serverClockOffsetMs,
        get().effectsVolume,
      );
    }).catch(() => {});
  },

  mutate: async (action) => {
    mutationChain = mutationChain.then(async () => {
      const current = get();
      if (!current.shared || !current.conversationId || !current.callId || !mediaContext) return;
      const next = reduceSharedMedia(current.shared, action);
      if (next === current.shared) return;
      const expectedRevision = current.revision;
      set({ shared: next });
      const encrypted = await encryptCallMediaJson(mediaContext.key, next, {
        conversationId: current.conversationId,
        callId: current.callId,
        epoch: mediaContext.epoch,
        purpose: "state",
      });
      try {
        const response = await putCallMediaState(current.conversationId, {
          call_id: current.callId,
          expected_revision: expectedRevision,
          ...encrypted,
        });
        if (response?.state && get().callId === current.callId) {
          set({ revision: response.state.revision, shared: next, error: null });
        }
      } catch {
        await get().reconcile();
      }
    });
    await mutationChain;
  },

  triggerBuiltin: async (soundId) => {
    const current = get();
    if (!current.conversationId || !current.callId || !mediaContext) return;
    const scheduledAtMs = Date.now() + current.serverClockOffsetMs + 400;
    const encrypted = await encryptCallMediaJson(
      mediaContext.key,
      { v: 1, kind: "builtin", soundId } satisfies SoundPayloadBuiltin,
      {
        conversationId: current.conversationId,
        callId: current.callId,
        epoch: mediaContext.epoch,
        purpose: "sound",
      },
    );
    await sendCallSoundTrigger(current.conversationId, {
      call_id: current.callId,
      event_id: crypto.randomUUID(),
      scheduled_at_ms: scheduledAtMs,
      ...encrypted,
    });
  },

  prepareCustom: async (clip) => {
    const current = get();
    if (!current.conversationId || !current.callId || !mediaContext) return null;
    const attachment = await prepareCustomAttachment(clip, current.conversationId);
    if (!attachment || get().conversationId !== current.conversationId) return null;
    return {
      ...clip,
      attachments: { ...clip.attachments, [current.conversationId]: attachment },
    };
  },

  triggerCustom: async (clip) => {
    const current = get();
    if (!current.conversationId || !current.callId || !mediaContext) return;
    const usedCachedAttachment = !!clip.attachments[current.conversationId];
    const attachment = await prepareCustomAttachment(clip, current.conversationId);
    if (!attachment) return;
    const transmit = async (ref: AttachmentRef) => {
      const scheduledAtMs = Date.now() + current.serverClockOffsetMs + CALL_CUSTOM_SOUND_LEAD_MS;
      const encrypted = await encryptCallMediaJson(
        mediaContext!.key,
        { v: 1, kind: "custom", attachment: ref, label: clip.label } satisfies SoundPayloadCustom,
        {
          conversationId: current.conversationId!,
          callId: current.callId!,
          epoch: mediaContext!.epoch,
          purpose: "sound",
        },
      );
      await sendCallSoundTrigger(current.conversationId!, {
        call_id: current.callId!,
        event_id: crypto.randomUUID(),
        scheduled_at_ms: scheduledAtMs,
        blob_id: ref.blob_id,
        ...encrypted,
      });
    };
    try {
      await transmit(attachment);
    } catch (error) {
      // A 30-day-expired object leaves a stale local conversation cache. Refresh
      // that scoped copy once; rate limits/network failures are not upload cues.
      if (!usedCachedAttachment || !(error instanceof ApiError) || ![403, 404].includes(error.status)) {
        throw error;
      }
      const fresh = await uploadCallSound(current.conversationId, clip.wav, clip.label);
      if (!fresh) return;
      await cachePersonalSoundAttachment(clip.id, current.conversationId, fresh);
      await cacheLocalSoundBuffer(clip, fresh);
      await transmit(fresh);
    }
  },

  setMusicVolume: (musicVolume) => {
    const value = Math.max(0, Math.min(1, musicVolume));
    localStorage.setItem("accord.call-media.music-volume", String(value));
    set({ musicVolume: value });
  },
  setMusicMuted: (musicMuted) => {
    localStorage.setItem("accord.call-media.music-muted", String(musicMuted));
    set({ musicMuted });
  },
  setEffectsVolume: (effectsVolume) => {
    const value = Math.max(0, Math.min(1, effectsVolume));
    localStorage.setItem("accord.call-media.effects-volume", String(value));
    set({ effectsVolume: value });
  },
  setEffectsMuted: (effectsMuted) => {
    localStorage.setItem("accord.call-media.effects-muted", String(effectsMuted));
    set({ effectsMuted });
  },
  setAudioBlocked: (audioBlocked) => set({ audioBlocked }),
  setYoutubeError: (youtubeError) => set({ youtubeError }),
  setPlayerHidden: (playerHidden) => set({ playerHidden }),
  enableAudio: async () => {
    try {
      await contextForSound().resume();
      set({ audioBlocked: false });
    } catch {
      set({ audioBlocked: true });
    }
  },
}));

export function currentExpectedPositionSeconds(): number {
  const state = useCallMediaStore.getState();
  if (!state.shared) return 0;
  return expectedMediaPositionSeconds(state.shared, Date.now(), state.serverClockOffsetMs);
}
