/**
 * Per-instance token storage.
 *
 * Split by lifetime and sensitivity:
 *  - the **access token** lives in memory only and is NEVER persisted (it dies
 *    with the process; the client re-mints one from the refresh token at boot);
 *  - the **refresh token** is persisted in a secure backend — the OS keychain on
 *    desktop (Tauri: macOS Keychain / Windows Credential Manager / Linux Secret
 *    Service) and `localStorage` in a plain browser (the fallback).
 *
 * Callers keep a synchronous API: an in-memory cache mirrors the persistent
 * backend, hydrated once at boot by {@link hydrateSecureStore} and written
 * through asynchronously. Tokens are namespaced by instance id so switching
 * instances never crosses credentials.
 */

import { isTauri } from "./isTauri";

/** The token pair for one instance. `accessToken` may be "" right after a
 * restart (memory-only, not yet re-minted) — the ApiClient refreshes to get one. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Persistent backend for the long-lived refresh token only. */
interface RefreshBackend {
  get(instanceId: string): Promise<string | null>;
  set(instanceId: string, refreshToken: string): Promise<void>;
  clear(instanceId: string): Promise<void>;
}

// --- Browser backend: localStorage (the verifiable fallback). ----------------
const refreshKey = (instanceId: string): string => `accord.rt.${instanceId}`;

const browserBackend: RefreshBackend = {
  async get(instanceId) {
    try {
      return localStorage.getItem(refreshKey(instanceId));
    } catch {
      return null;
    }
  },
  async set(instanceId, refreshToken) {
    try {
      localStorage.setItem(refreshKey(instanceId), refreshToken);
    } catch {
      /* storage unavailable — the in-memory cache still serves this session */
    }
  },
  async clear(instanceId) {
    try {
      localStorage.removeItem(refreshKey(instanceId));
    } catch {
      /* ignore */
    }
  },
};

// --- Desktop backend: OS keychain via Tauri commands. ------------------------
// Round-trips to the Rust side (`keyring` crate). The `@tauri-apps/api` import
// is lazy so the browser bundle never eagerly loads the desktop runtime.
const tauriBackend: RefreshBackend = {
  async get(instanceId) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("secure_get_refresh", { instanceId })) ?? null;
  },
  async set(instanceId, refreshToken) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secure_set_refresh", { instanceId, refreshToken });
  },
  async clear(instanceId) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secure_delete_refresh", { instanceId });
  },
};

const backend: RefreshBackend = isTauri() ? tauriBackend : browserBackend;

// --- In-memory caches --------------------------------------------------------
// accessTokens: volatile, never persisted. refreshTokens: a mirror of `backend`
// so the caller-facing API can stay synchronous.
const accessTokens = new Map<string, string>();
const refreshTokens = new Map<string, string>();

export const secureStore = {
  /** Returns the tokens for an instance, or null when it has no refresh token
   * (i.e. no live session). */
  get(instanceId: string): Tokens | null {
    const refreshToken = refreshTokens.get(instanceId);
    if (!refreshToken) return null;
    return { accessToken: accessTokens.get(instanceId) ?? "", refreshToken };
  },
  /** Stores a freshly-issued pair: access in memory, refresh in the backend. */
  set(instanceId: string, tokens: Tokens): void {
    accessTokens.set(instanceId, tokens.accessToken);
    refreshTokens.set(instanceId, tokens.refreshToken);
    void backend.set(instanceId, tokens.refreshToken);
  },
  /** Drops an instance's tokens everywhere (logout / auth loss). */
  clear(instanceId: string): void {
    accessTokens.delete(instanceId);
    refreshTokens.delete(instanceId);
    void backend.clear(instanceId);
  },
};

/**
 * Loads persisted refresh tokens into the in-memory cache. Call once at boot,
 * and `await` it BEFORE reading session state so the auth gate sees the real
 * signed-in instances (not a flash of onboarding).
 */
export async function hydrateSecureStore(instanceIds: string[]): Promise<void> {
  await Promise.all(
    instanceIds.map(async (instanceId) => {
      const refreshToken = await backend.get(instanceId).catch(() => null);
      if (refreshToken) refreshTokens.set(instanceId, refreshToken);
    }),
  );
}
