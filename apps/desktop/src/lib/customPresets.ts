/**
 * Personnalisations sauvegardées — plusieurs apparences nommées (réglages +
 * fond d'écran image/vidéo inclus), stockées en IndexedDB pour y revenir en
 * un clic. Les métadonnées et le média vivent dans deux stores séparés : la
 * liste ne charge jamais les blobs (un fond vidéo peut peser lourd).
 */

import { getBgMedia, putBgMedia, clearBgMedia } from "./bgStore";
import {
  snapshotCustomize,
  useCustomizeStore,
  type CustomizeSnapshot,
} from "../stores/useCustomizeStore";

export interface PresetMeta {
  id: string;
  name: string;
  createdAt: number;
  snapshot: CustomizeSnapshot;
  hasMedia: boolean;
}

const DB_NAME = "accord.custom-presets";
const META = "meta";
const MEDIA = "media";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META);
      req.result.createObjectStore(MEDIA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  run: (t: IDBTransaction) => void,
  result: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    run(t);
    t.oncomplete = () => resolve(result());
    t.onerror = () => reject(t.error);
  });
}

/** Sauvegarde l'apparence ACTUELLE (réglages + fond d'écran) sous un nom. */
export async function savePreset(name: string): Promise<PresetMeta> {
  const snapshot = snapshotCustomize(useCustomizeStore.getState());
  const wantsMedia = snapshot.bgKind === "image" || snapshot.bgKind === "video";
  const media = wantsMedia ? await getBgMedia().catch(() => null) : null;
  const meta: PresetMeta = {
    id: crypto.randomUUID(),
    name: name.trim() || "Sans nom",
    createdAt: Date.now(),
    snapshot,
    hasMedia: !!media,
  };
  const db = await open();
  await tx(
    db,
    [META, MEDIA],
    "readwrite",
    (t) => {
      t.objectStore(META).put(meta, meta.id);
      if (media) t.objectStore(MEDIA).put(media, meta.id);
    },
    () => undefined,
  );
  db.close();
  return meta;
}

/** Toutes les personnalisations, la plus récente d'abord (sans les blobs). */
export async function listPresets(): Promise<PresetMeta[]> {
  const db = await open();
  const metas = await new Promise<PresetMeta[]>((resolve, reject) => {
    const out: PresetMeta[] = [];
    const req = db.transaction(META, "readonly").objectStore(META).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        resolve(out);
        return;
      }
      out.push(c.value as PresetMeta);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

/** Restaure une personnalisation : fond d'écran (ou son absence) + réglages. */
export async function applyPreset(id: string): Promise<boolean> {
  const db = await open();
  const meta = await new Promise<PresetMeta | null>((resolve, reject) => {
    const req = db.transaction(META, "readonly").objectStore(META).get(id);
    req.onsuccess = () => resolve((req.result as PresetMeta | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!meta) {
    db.close();
    return false;
  }
  if (meta.hasMedia) {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const req = db.transaction(MEDIA, "readonly").objectStore(MEDIA).get(id);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (blob) await putBgMedia(blob);
  } else if (meta.snapshot.bgKind !== "image" && meta.snapshot.bgKind !== "video") {
    await clearBgMedia().catch(() => {});
  }
  db.close();
  useCustomizeStore.getState().applySnapshot(meta.snapshot);
  return true;
}

export async function deletePreset(id: string): Promise<void> {
  const db = await open();
  await tx(
    db,
    [META, MEDIA],
    "readwrite",
    (t) => {
      t.objectStore(META).delete(id);
      t.objectStore(MEDIA).delete(id);
    },
    () => undefined,
  );
  db.close();
}
