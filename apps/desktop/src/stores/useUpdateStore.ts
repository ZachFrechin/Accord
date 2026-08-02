/**
 * Auto-update state (Tauri only). Checks the vendor update manifest, exposes the
 * available version to the UpdateBanner, and drives download → install → relaunch.
 *
 * The plugin's `Update` object is kept in module scope (non-reactive), like the
 * LiveKit Room in useCallStore — the store only holds reactive display state.
 * Everything no-ops outside the Tauri shell (browser dev) — the plugin is only
 * ever loaded through dynamic import behind isTauri().
 */

import { create } from "zustand";

import { isTauri } from "../lib/isTauri";

type UpdatePhase = "idle" | "available" | "downloading" | "installing" | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** Version proposed by the manifest (e.g. "0.5.0"). */
  version: string | null;
  /** Release notes (manifest `notes`), shown as-is. */
  notes: string | null;
  /** Download progress 0..1, or null while the total size is unknown. */
  progress: number | null;
  error: string | null;
  /** The banner was dismissed for this session (re-shown on the next check that
   * finds a NEWER version than the dismissed one). */
  dismissedVersion: string | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

/** The live plugin Update handle (non-reactive; one at a time). */
let pending: import("@tauri-apps/plugin-updater").Update | null = null;
/** Single-flight guard for checks (StrictMode double-effects, interval overlap). */
let checking = false;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
  dismissedVersion: null,

  check: async () => {
    if (!isTauri() || checking) return;
    const { phase } = get();
    if (phase === "downloading" || phase === "installing") return;
    checking = true;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        pending = update;
        set({ phase: "available", version: update.version, notes: update.body ?? null, error: null });
      }
    } catch (err) {
      // A failed background check is not user-actionable noise — log only.
      console.warn("update check failed", err);
    } finally {
      checking = false;
    }
  },

  install: async () => {
    const update = pending;
    if (!update) return;
    set({ phase: "downloading", progress: null, error: null });
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            received = 0;
            set({ progress: total > 0 ? 0 : null });
            break;
          case "Progress":
            received += event.data.chunkLength;
            if (total > 0) set({ progress: Math.min(1, received / total) });
            break;
          case "Finished":
            set({ phase: "installing", progress: 1 });
            break;
        }
      });
      // On Windows the installer quits the app before we ever get here; on
      // macOS/Linux we relaunch into the new version explicitly.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      set({
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  dismiss: () => set((s) => ({ phase: "idle", dismissedVersion: s.version })),
}));
