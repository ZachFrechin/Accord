/**
 * Custom ringtone audio files (per contact), stored locally in IndexedDB —
 * an .mp3 (or any audio the webview can decode) picked by the user is worth
 * more than any synth. Keyed by the contact's userId.
 *
 * A file is DECODED before being accepted (probeAudioBlob): an unreadable file
 * is refused at import time with a clear error instead of being saved and
 * failing silently at ring time. The measured duration is stored alongside so
 * the settings UI can show "nom · 0:42" without re-decoding.
 */

export interface RingtoneFile {
  name: string;
  mime: string;
  blob: Blob;
  /** Seconds, measured at import. Absent on records saved by older builds. */
  duration?: number;
}

export interface RingtoneFileMeta {
  userId: string;
  name: string;
  duration?: number;
}

export const RINGTONE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Some files carry no MIME type — fall back to the extension. */
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba|webm)$/i;

const DB_NAME = "accord.ringtones";
const STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve the blob's playable duration in seconds; reject if the webview
 * cannot decode it (bad format, corrupt file) or metadata never arrives. */
export function probeAudioBlob(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    let settled = false;
    const finish = (ok: boolean, duration = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      if (ok) resolve(duration);
      else reject(new Error("audio non décodable"));
    };
    const timer = setTimeout(() => finish(false), 8000);
    audio.onloadedmetadata = () =>
      finish(true, Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(false);
    audio.preload = "metadata";
    audio.src = url;
  });
}

/** Validate (type, size, decodability), then persist. Returns the saved record. */
export async function saveRingtoneFile(userId: string, file: File): Promise<RingtoneFile> {
  const looksAudio = file.type.startsWith("audio/") || AUDIO_EXT.test(file.name);
  if (!looksAudio) {
    throw new Error("Choisissez un fichier audio (.mp3, .ogg, .wav…).");
  }
  if (file.size > RINGTONE_FILE_MAX_BYTES) {
    throw new Error("Le fichier dépasse 10 Mo.");
  }
  const duration = await probeAudioBlob(file).catch(() => {
    throw new Error("Ce fichier audio est illisible sur cet appareil.");
  });
  const record: RingtoneFile = { name: file.name, mime: file.type, blob: file, duration };
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return record;
}

export async function getRingtoneFile(userId: string): Promise<RingtoneFile | null> {
  const db = await open();
  const out = await new Promise<RingtoneFile | null>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(userId);
    req.onsuccess = () => resolve((req.result as RingtoneFile | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

export async function deleteRingtoneFile(userId: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Every stored file's metadata (no blobs leave IndexedDB's row read). */
export async function listRingtoneFiles(): Promise<RingtoneFileMeta[]> {
  const db = await open();
  const out = await new Promise<RingtoneFileMeta[]>((resolve, reject) => {
    const metas: RingtoneFileMeta[] = [];
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(metas);
        return;
      }
      const v = cursor.value as RingtoneFile;
      metas.push({ userId: String(cursor.key), name: v.name, duration: v.duration });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

/** Backfill `duration` on a record saved by an older build. Returns the
 * measured duration, or undefined if the file cannot be decoded. */
export async function ensureRingtoneDuration(userId: string): Promise<number | undefined> {
  const f = await getRingtoneFile(userId).catch(() => null);
  if (!f) return undefined;
  if (f.duration !== undefined) return f.duration;
  const duration = await probeAudioBlob(f.blob).catch(() => undefined);
  if (duration === undefined) return undefined;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...f, duration }, userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return duration;
}
