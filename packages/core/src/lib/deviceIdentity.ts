/**
 * Per-instance device identity for E2EE.
 *
 * Each account (instance) has an X25519 device keypair. The PRIVATE half is kept
 * in the OS keychain on desktop (via the Tauri `secure_*_device_key` commands)
 * and localStorage in a plain browser — it NEVER leaves the device or reaches the
 * server. The PUBLIC half is published to the backend so peers can wrap message
 * keys to this device. The `device_id` is a non-secret stable id kept locally.
 *
 * Mirrors `secureStore`'s backend abstraction, but the first key write is
 * AWAITED (losing the private key would make history undecryptable).
 */

import {
  fromBase64,
  generateIdentityKeyPair,
  type KeyPair,
  keyPairFromPrivate,
  toBase64,
} from "./crypto";
import { isTauri } from "./isTauri";

export interface DeviceIdentity {
  deviceId: string;
  keyPair: KeyPair;
}

/** Persistent backend for the device PRIVATE key (base64), keyed by instance. */
interface DeviceKeyBackend {
  get(instanceId: string): Promise<string | null>;
  set(instanceId: string, privateKeyB64: string): Promise<void>;
  clear(instanceId: string): Promise<void>;
}

const privKeyLsKey = (instanceId: string): string => `accord.dk.${instanceId}`;

const browserBackend: DeviceKeyBackend = {
  async get(instanceId) {
    try {
      return localStorage.getItem(privKeyLsKey(instanceId));
    } catch {
      return null;
    }
  },
  async set(instanceId, value) {
    try {
      localStorage.setItem(privKeyLsKey(instanceId), value);
    } catch {
      /* ignore */
    }
  },
  async clear(instanceId) {
    try {
      localStorage.removeItem(privKeyLsKey(instanceId));
    } catch {
      /* ignore */
    }
  },
};

const tauriBackend: DeviceKeyBackend = {
  async get(instanceId) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("secure_get_device_key", { instanceId })) ?? null;
  },
  async set(instanceId, value) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secure_set_device_key", { instanceId, privateKey: value });
  },
  async clear(instanceId) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secure_delete_device_key", { instanceId });
  },
};

const backend: DeviceKeyBackend = isTauri() ? tauriBackend : browserBackend;

const deviceIdLsKey = (instanceId: string): string => `accord.device.${instanceId}`;

function randomDeviceId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `dev_${uuid.slice(0, 24)}`;
}

/** Loads (or creates + persists) the non-secret device id for an instance. */
function loadOrCreateDeviceId(instanceId: string): string {
  try {
    const existing = localStorage.getItem(deviceIdLsKey(instanceId));
    if (existing) return existing;
    const created = randomDeviceId();
    localStorage.setItem(deviceIdLsKey(instanceId), created);
    return created;
  } catch {
    return randomDeviceId();
  }
}

const cache = new Map<string, DeviceIdentity>();
const inFlight = new Map<string, Promise<DeviceIdentity>>();

/** The cached identity for an instance (after ensure/hydrate), or null. */
export function getIdentity(instanceId: string): DeviceIdentity | null {
  return cache.get(instanceId) ?? null;
}

/**
 * Ensures a device identity for an instance: loads the persisted private key or
 * generates + persists a new one. The first write is awaited — the key must not
 * be lost. Returns the identity (also cached).
 *
 * Concurrent calls share ONE in-flight generation (the cache check straddles an
 * await, so without this two mounts — e.g. React StrictMode's double-invoke —
 * would each generate a keypair and race the persisted key vs the published key).
 */
export function ensureIdentity(instanceId: string): Promise<DeviceIdentity> {
  const cached = cache.get(instanceId);
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(instanceId);
  if (existing) return existing;

  const promise = (async () => {
    const deviceId = loadOrCreateDeviceId(instanceId);
    const storedB64 = await backend.get(instanceId).catch(() => null);
    let keyPair: KeyPair;
    if (storedB64) {
      keyPair = keyPairFromPrivate(fromBase64(storedB64));
    } else {
      keyPair = generateIdentityKeyPair();
      await backend.set(instanceId, toBase64(keyPair.privateKey));
    }
    const identity: DeviceIdentity = { deviceId, keyPair };
    cache.set(instanceId, identity);
    return identity;
  })().finally(() => inFlight.delete(instanceId));

  inFlight.set(instanceId, promise);
  return promise;
}

/** Loads persisted identities into the cache at boot (does not generate). */
export async function hydrateDeviceIdentity(instanceIds: string[]): Promise<void> {
  await Promise.all(
    instanceIds.map(async (instanceId) => {
      const storedB64 = await backend.get(instanceId).catch(() => null);
      if (!storedB64) return;
      try {
        cache.set(instanceId, {
          deviceId: loadOrCreateDeviceId(instanceId),
          keyPair: keyPairFromPrivate(fromBase64(storedB64)),
        });
      } catch {
        /* corrupt key — ensureIdentity will regenerate on next connect */
      }
    }),
  );
}

/** Drops an instance's device identity (logout / instance removal). */
export async function clearIdentity(instanceId: string): Promise<void> {
  cache.delete(instanceId);
  await backend.clear(instanceId).catch(() => {});
  try {
    localStorage.removeItem(deviceIdLsKey(instanceId));
  } catch {
    /* ignore */
  }
}
