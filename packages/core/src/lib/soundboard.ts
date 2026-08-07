import type { AttachmentRef } from "./messaging";

export const PERSONAL_SOUND_MAX_FILES = 100;
export const PERSONAL_SOUND_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const PERSONAL_SOUND_MAX_DURATION_SECONDS = 10;
export const PERSONAL_SOUND_MAX_WAV_BYTES = 1024 * 1024;
export const PERSONAL_SOUND_SAMPLE_RATE = 44_100;

const DB_NAME = "accord-personal-soundboard";
const DB_VERSION = 1;
const STORE = "clips";

export interface PersonalSoundClip {
  id: string;
  label: string;
  wav: Blob;
  durationSeconds: number;
  createdAtMs: number;
  attachments: Record<string, AttachmentRef>;
}

export interface MonoPcm {
  samples: Float32Array;
  sampleRate: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function listPersonalSounds(): Promise<PersonalSoundClip[]> {
  return withStore("readonly", (store) => store.getAll()).then((clips) =>
    clips.sort((a, b) => a.createdAtMs - b.createdAtMs),
  );
}

export async function savePersonalSound(clip: PersonalSoundClip): Promise<void> {
  const clips = await listPersonalSounds();
  if (!clips.some((item) => item.id === clip.id) && clips.length >= PERSONAL_SOUND_MAX_FILES) {
    throw new Error("personal soundboard limit reached");
  }
  await withStore("readwrite", (store) => store.put(clip));
}

export async function deletePersonalSound(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export async function cachePersonalSoundAttachment(
  id: string,
  conversationId: string,
  attachment: AttachmentRef,
): Promise<void> {
  const clip = await withStore<PersonalSoundClip | undefined>("readonly", (store) => store.get(id));
  if (!clip) return;
  await savePersonalSound({
    ...clip,
    attachments: { ...clip.attachments, [conversationId]: attachment },
  });
}

export function encodeMonoPcm16Wav(pcm: MonoPcm): Uint8Array {
  const dataBytes = pcm.samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) out[offset + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm.samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return out;
}

function downmixAndResample(buffer: AudioBuffer): MonoPcm {
  const length = Math.ceil(buffer.duration * PERSONAL_SOUND_SAMPLE_RATE);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const sourceIndex = Math.min(buffer.length - 1, Math.floor((i * buffer.sampleRate) / PERSONAL_SOUND_SAMPLE_RATE));
    let sum = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      sum += buffer.getChannelData(channel)[sourceIndex] ?? 0;
    }
    samples[i] = sum / Math.max(1, buffer.numberOfChannels);
  }
  return { samples, sampleRate: PERSONAL_SOUND_SAMPLE_RATE };
}

export async function normalizePersonalSound(file: File): Promise<PersonalSoundClip> {
  if (file.size <= 0 || file.size > PERSONAL_SOUND_MAX_SOURCE_BYTES) {
    throw new Error("sound file must be at most 10 MB");
  }
  const Context = globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("audio decoding is unavailable");
  const context = new Context();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } finally {
    await context.close();
  }
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > PERSONAL_SOUND_MAX_DURATION_SECONDS) {
    throw new Error("sound clip must be 10 seconds or shorter");
  }
  const wav = encodeMonoPcm16Wav(downmixAndResample(decoded));
  if (wav.byteLength > PERSONAL_SOUND_MAX_WAV_BYTES) throw new Error("normalized sound exceeds 1 MiB");
  return {
    id: crypto.randomUUID(),
    label: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Sound",
    wav: new Blob([wav], { type: "audio/wav" }),
    durationSeconds: decoded.duration,
    createdAtMs: Date.now(),
    attachments: {},
  };
}
