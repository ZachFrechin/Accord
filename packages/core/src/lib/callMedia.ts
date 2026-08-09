import { fromBase64, toBase64, utf8ToBytes } from "./crypto";

export const MAX_SHARED_MEDIA_QUEUE = 50;
export const CALL_MEDIA_DRIFT_SEEK_SECONDS = 1.5;
export const CALL_SOUND_LATE_DROP_MS = 2_000;
export const CALL_CUSTOM_SOUND_LEAD_MS = 1_000;

export interface SharedMediaItemV1 {
  id: string;
  videoId: string;
  contributedBy: string;
}

export interface SharedMediaStateV1 {
  v: 1;
  sessionId: string;
  epoch: number;
  queue: SharedMediaItemV1[];
  currentItemId: string | null;
  status: "playing" | "paused";
  anchorPositionSeconds: number;
  anchorServerTimeMs: number;
}

export type SharedMediaAction =
  | { type: "enqueue"; item: SharedMediaItemV1; serverNowMs: number }
  | { type: "remove"; itemId: string; serverNowMs: number }
  | { type: "reorder"; itemId: string; toIndex: number }
  | { type: "play"; positionSeconds: number; serverNowMs: number }
  | { type: "pause"; positionSeconds: number; serverNowMs: number }
  | { type: "seek"; positionSeconds: number; serverNowMs: number }
  | { type: "skip"; serverNowMs: number };

export interface EncryptedCallMediaPayload {
  ciphertext: string;
  nonce: string;
}

export function emptySharedMediaState(epoch: number, serverNowMs: number): SharedMediaStateV1 {
  return {
    v: 1,
    sessionId: crypto.randomUUID(),
    epoch,
    queue: [],
    currentItemId: null,
    status: "paused",
    anchorPositionSeconds: 0,
    anchorServerTimeMs: serverNowMs,
  };
}

export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else if (["shorts", "embed", "live"].includes(parts[0] ?? "")) candidate = parts[1] ?? null;
  }
  return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

export function reduceSharedMedia(
  state: SharedMediaStateV1,
  action: SharedMediaAction,
): SharedMediaStateV1 {
  switch (action.type) {
    case "enqueue": {
      if (state.queue.length >= MAX_SHARED_MEDIA_QUEUE) return state;
      if (state.queue.some((item) => item.id === action.item.id)) return state;
      const queue = [...state.queue, action.item];
      const startsPlayback = state.currentItemId === null;
      return {
        ...state,
        queue,
        currentItemId: state.currentItemId ?? action.item.id,
        status: startsPlayback ? "playing" : state.status,
        anchorPositionSeconds: startsPlayback ? 0 : state.anchorPositionSeconds,
        anchorServerTimeMs: startsPlayback ? action.serverNowMs : state.anchorServerTimeMs,
      };
    }
    case "remove": {
      const index = state.queue.findIndex((item) => item.id === action.itemId);
      if (index < 0) return state;
      const queue = state.queue.filter((item) => item.id !== action.itemId);
      const removedCurrent = state.currentItemId === action.itemId;
      const nextItemId = removedCurrent
        ? (queue[Math.min(index, queue.length - 1)]?.id ?? null)
        : state.currentItemId;
      return {
        ...state,
        queue,
        currentItemId: nextItemId,
        status: removedCurrent && !nextItemId ? "paused" : state.status,
        anchorPositionSeconds: removedCurrent ? 0 : state.anchorPositionSeconds,
        anchorServerTimeMs: removedCurrent ? action.serverNowMs : state.anchorServerTimeMs,
      };
    }
    case "reorder": {
      const from = state.queue.findIndex((item) => item.id === action.itemId);
      if (from < 0) return state;
      const queue = [...state.queue];
      const [item] = queue.splice(from, 1);
      queue.splice(Math.max(0, Math.min(action.toIndex, queue.length)), 0, item);
      return { ...state, queue };
    }
    case "play":
    case "pause":
    case "seek":
      return {
        ...state,
        status: action.type === "pause" ? "paused" : action.type === "play" ? "playing" : state.status,
        anchorPositionSeconds: Math.max(0, action.positionSeconds),
        anchorServerTimeMs: action.serverNowMs,
      };
    case "skip": {
      const current = state.queue.findIndex((item) => item.id === state.currentItemId);
      const next = current >= 0 ? state.queue[current + 1] : state.queue[0];
      return {
        ...state,
        currentItemId: next?.id ?? null,
        status: next ? "playing" : "paused",
        anchorPositionSeconds: 0,
        anchorServerTimeMs: action.serverNowMs,
      };
    }
  }
}

export function validateSharedMediaState(value: unknown): SharedMediaStateV1 | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<SharedMediaStateV1>;
  if (
    state.v !== 1 ||
    typeof state.sessionId !== "string" ||
    !Number.isSafeInteger(state.epoch) ||
    !Array.isArray(state.queue) ||
    state.queue.length > MAX_SHARED_MEDIA_QUEUE ||
    (state.currentItemId !== null && typeof state.currentItemId !== "string") ||
    (state.status !== "playing" && state.status !== "paused") ||
    !Number.isFinite(state.anchorPositionSeconds) ||
    !Number.isFinite(state.anchorServerTimeMs)
  ) return null;
  const ids = new Set<string>();
  for (const item of state.queue) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Partial<SharedMediaItemV1>;
    if (
      typeof candidate.id !== "string" ||
      ids.has(candidate.id) ||
      typeof candidate.videoId !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(candidate.videoId) ||
      typeof candidate.contributedBy !== "string"
    ) return null;
    ids.add(candidate.id);
  }
  if (state.currentItemId !== null && !ids.has(state.currentItemId)) return null;
  return state as SharedMediaStateV1;
}

export function estimateServerClockOffsetMs(
  requestStartedAtMs: number,
  responseReceivedAtMs: number,
  serverNowMs: number,
): number {
  return serverNowMs - (requestStartedAtMs + responseReceivedAtMs) / 2;
}

export function expectedMediaPositionSeconds(
  state: SharedMediaStateV1,
  localNowMs: number,
  serverClockOffsetMs: number,
): number {
  if (state.status === "paused") return Math.max(0, state.anchorPositionSeconds);
  const elapsed = (localNowMs + serverClockOffsetMs - state.anchorServerTimeMs) / 1_000;
  return Math.max(0, state.anchorPositionSeconds + elapsed);
}

export function driftCorrectionSeconds(actual: number, expected: number): number | null {
  return Math.abs(actual - expected) > CALL_MEDIA_DRIFT_SEEK_SECONDS ? expected : null;
}

export async function deriveCallMediaSyncKey(
  callKey: Uint8Array,
  conversationId: string,
  callId: string,
  epoch: number,
): Promise<CryptoKey> {
  if (callKey.length !== 32) throw new Error("invalid MLS call key");
  const input = await crypto.subtle.importKey("raw", callKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8ToBytes(`accord:${conversationId}:${callId}:${epoch}`),
      info: utf8ToBytes("accord/call-media-sync/v1"),
    },
    input,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aad(conversationId: string, callId: string, epoch: number, purpose: string): Uint8Array {
  return utf8ToBytes(`accord-call-media-v1\n${conversationId}\n${callId}\n${epoch}\n${purpose}`);
}

export async function encryptCallMediaJson(
  key: CryptoKey,
  value: unknown,
  context: { conversationId: string; callId: string; epoch: number; purpose: "state" | "sound" },
): Promise<EncryptedCallMediaPayload> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(context.conversationId, context.callId, context.epoch, context.purpose) },
    key,
    utf8ToBytes(JSON.stringify(value)),
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), nonce: toBase64(nonce) };
}

export async function decryptCallMediaJson<T>(
  key: CryptoKey,
  payload: EncryptedCallMediaPayload,
  context: { conversationId: string; callId: string; epoch: number; purpose: "state" | "sound" },
): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.nonce), additionalData: aad(context.conversationId, context.callId, context.epoch, context.purpose) },
    key,
    fromBase64(payload.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export interface YoutubeBridgeMessage {
  source: "accord-youtube-bridge";
  channel: string;
  type: string;
  [key: string]: unknown;
}

export function isYoutubeBridgeMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  expected: { origin: string; source: MessageEventSource | null; channel: string },
): event is MessageEvent<YoutubeBridgeMessage> {
  const data = event.data as Partial<YoutubeBridgeMessage> | null;
  return (
    event.origin === expected.origin &&
    event.source === expected.source &&
    !!data &&
    data.source === "accord-youtube-bridge" &&
    data.channel === expected.channel &&
    typeof data.type === "string"
  );
}

export function shouldDropSoundEvent(scheduledAtMs: number, serverNowMs: number): boolean {
  return serverNowMs - scheduledAtMs > CALL_SOUND_LATE_DROP_MS;
}

export function remainingSoundDelayMs(
  scheduledAtMs: number,
  localNowMs: number,
  serverClockOffsetMs: number,
): number {
  return Math.max(0, scheduledAtMs - (localNowMs + serverClockOffsetMs));
}

export class EventDeduplicator {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 10 * 60_000) {}

  accept(id: string, nowMs = Date.now()): boolean {
    for (const [eventId, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) this.seen.delete(eventId);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, nowMs + this.ttlMs);
    return true;
  }
}
