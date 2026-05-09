import {
  decryptMessage,
  encryptBytes,
  encryptMessage,
  generateConversationKey,
  generateDeviceIdentity,
  unwrapConversationKey,
  wrapConversationKey,
  type ConversationKey,
  type DeviceIdentity,
} from '@discord2/e2ee';
import type { MessageRecord } from '@discord2/shared';
import { MessagePrivacy, type InstanceConfig } from '@discord2/shared';
import type { ApiClient } from './api-client';
import { decryptString, encryptString, isSecureStorageAvailable } from './desktop';

export type { DeviceIdentity } from '@discord2/e2ee';

const identityPrefix = 'accord-e2ee-identity';
const keyPrefix = 'accord-e2ee-conversation-key';
const memoryKeys = new Map<string, ConversationKey>();
const inflightKeyFetches = new Map<string, Promise<ConversationKey>>();
const recentKeyFailures = new Map<string, number>();
const decryptedTextMemo = new Map<string, string>();
const KEY_FAILURE_TTL_MS = 5_000;

export async function getOrCreateDeviceIdentity(input: {
  api: ApiClient;
  instance: InstanceConfig;
  userId: string;
}): Promise<DeviceIdentity> {
  const storageKey = `${identityPrefix}:${input.instance.instanceId}:${input.userId}`;
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    const value = await readProtectedJson<DeviceIdentity>(stored);
    await input.api.crypto.publishDevice({
      deviceId: value.deviceId,
      publicKey: value.publicKey,
    });
    return value;
  }

  const identity = await generateDeviceIdentity(crypto.randomUUID());
  localStorage.setItem(storageKey, await writeProtectedJson(identity));
  await input.api.crypto.publishDevice({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
  });
  return identity;
}

export async function ensureConversationKey(input: {
  api: ApiClient;
  instance: InstanceConfig;
  userId: string;
  serverId: string;
  channelId: string;
  identity: DeviceIdentity;
  keyVersion?: number;
}): Promise<ConversationKey> {
  const cacheKey = `${input.instance.instanceId}:${input.userId}:${input.channelId}`;
  const requestedVersion = input.keyVersion;
  const cached = await readCachedConversationKey(cacheKey, requestedVersion);
  if (cached && requestedVersion) return cached;

  const fetchKey = `${cacheKey}:${requestedVersion ?? 'latest'}`;

  const failedAt = recentKeyFailures.get(fetchKey);
  if (failedAt && failedAt > Date.now()) {
    throw new Error('Clé locale absente pour ce salon.');
  }
  if (failedAt) recentKeyFailures.delete(fetchKey);

  const inflight = inflightKeyFetches.get(fetchKey);
  if (inflight) return inflight;

  const promise = fetchOrCreateConversationKey(input, cacheKey, requestedVersion);
  inflightKeyFetches.set(fetchKey, promise);
  promise
    .then(() => recentKeyFailures.delete(fetchKey))
    .catch(() => recentKeyFailures.set(fetchKey, Date.now() + KEY_FAILURE_TTL_MS))
    .finally(() => inflightKeyFetches.delete(fetchKey));
  return promise;
}

async function fetchOrCreateConversationKey(
  input: {
    api: ApiClient;
    instance: InstanceConfig;
    userId: string;
    serverId: string;
    channelId: string;
    identity: DeviceIdentity;
    keyVersion?: number;
  },
  cacheKey: string,
  requestedVersion: number | undefined,
): Promise<ConversationKey> {
  try {
    const state = await input.api.crypto.getConversation(input.channelId);
    const targetVersion = requestedVersion ?? state.currentKeyVersion;
    const wrapped = state.keys
      .filter((key) => key.deviceId === input.identity.deviceId && key.keyVersion === targetVersion)
      .sort((left, right) => right.keyVersion - left.keyVersion)[0];

    if (wrapped) {
      const key = await unwrapConversationKey(
        wrapped.wrappedKey,
        input.identity,
        wrapped.keyVersion,
      );
      await persistConversationKey(cacheKey, key);

      if (!requestedVersion && key.version === state.currentKeyVersion) {
        void distributeKeyToNewDevices(input, state.conversationId, key, state.keys);
      }

      return key;
    }

    if (requestedVersion) {
      throw new Error('Clé locale absente pour ce salon.');
    }

    const key = await createReplacementConversationKey(input, state.currentKeyVersion + 1);
    await persistConversationKey(cacheKey, key);
    return key;
  } catch (error) {
    if (
      error instanceof Error &&
      !/not available|introuvable|404|Clé locale absente/i.test(error.message)
    ) {
      const fallback = await readCachedConversationKey(cacheKey, requestedVersion);
      if (fallback) return fallback;
      throw error;
    }
  }

  if (requestedVersion) {
    throw new Error('Clé locale absente pour ce salon.');
  }

  const key = await createReplacementConversationKey(input, 1);
  await persistConversationKey(cacheKey, key);
  return key;
}

export async function decryptMessages(input: {
  api: ApiClient;
  instance: InstanceConfig;
  userId: string;
  serverId: string | null;
  channelId: string | null;
  identity: DeviceIdentity | null;
  messages: MessageRecord[];
}): Promise<MessageRecord[]> {
  if (!input.serverId || !input.channelId || !input.identity) {
    return input.messages;
  }

  const e2eeMessages = input.messages.filter(
    (message) => message.privacy === MessagePrivacy.EndToEndEncrypted && message.encrypted,
  );
  if (e2eeMessages.length === 0) {
    return input.messages;
  }

  const { serverId, channelId, identity, userId, api, instance } = input;

  const neededVersions = new Set<number>();
  for (const message of e2eeMessages) {
    if (!message.encrypted) continue;
    const memoKey = `${userId}:${channelId}:${message.id}:${message.encrypted.keyVersion}:${message.encrypted.nonce}`;
    if (!decryptedTextMemo.has(memoKey)) {
      neededVersions.add(message.encrypted.keyVersion);
    }
  }

  const versionKeys = new Map<number, ConversationKey | null>();
  await Promise.all(
    Array.from(neededVersions).map(async (version) => {
      try {
        const key = await ensureConversationKey({
          api,
          instance,
          userId,
          serverId,
          channelId,
          identity,
          keyVersion: version,
        });
        versionKeys.set(version, key);
      } catch {
        versionKeys.set(version, null);
      }
    }),
  );

  return Promise.all(
    input.messages.map(async (message) => {
      if (message.privacy !== MessagePrivacy.EndToEndEncrypted || !message.encrypted) {
        return message;
      }
      const memoKey = `${userId}:${channelId}:${message.id}:${message.encrypted.keyVersion}:${message.encrypted.nonce}`;
      const memoed = decryptedTextMemo.get(memoKey);
      if (memoed !== undefined) {
        return { ...message, content: memoed };
      }
      const key = versionKeys.get(message.encrypted.keyVersion);
      if (!key) {
        return { ...message, content: '[Message chiffré illisible sur cet appareil]' };
      }
      try {
        const text = await decryptMessage(message.encrypted, key);
        decryptedTextMemo.set(memoKey, text);
        return { ...message, content: text };
      } catch {
        return { ...message, content: '[Message chiffré illisible sur cet appareil]' };
      }
    }),
  );
}

export async function encryptOutgoingMessage(input: {
  api: ApiClient;
  instance: InstanceConfig;
  userId: string;
  serverId: string;
  channelId: string;
  identity: DeviceIdentity;
  content: string;
}) {
  const key = await ensureConversationKey(input);
  return encryptMessage(input.content, key, input.identity.deviceId);
}

export async function encryptOutgoingBytes(input: {
  api: ApiClient;
  instance: InstanceConfig;
  userId: string;
  serverId: string;
  channelId: string;
  identity: DeviceIdentity;
  bytes: Uint8Array;
}) {
  const key = await ensureConversationKey(input);
  return encryptBytes(input.bytes, key, input.identity.deviceId);
}

export async function rotateConversationKey(input: {
  api: ApiClient;
  instance: InstanceConfig;
  userId: string;
  serverId: string;
  channelId: string;
  identity: DeviceIdentity;
  removedDeviceIds: string[];
}): Promise<void> {
  const allDevices = await input.api.crypto.listServerDevices(input.serverId);
  const removedSet = new Set(input.removedDeviceIds);
  const remainingDevices = allDevices.filter((device) => !removedSet.has(device.id));
  if (remainingDevices.length === 0) return;

  const state = await input.api.crypto.getConversation(input.channelId).catch(() => null);
  const nextVersion = state ? state.currentKeyVersion + 1 : 1;
  const newKey = await generateConversationKey(nextVersion);

  const wrappedKeys = await Promise.all(
    remainingDevices.map(async (device) => ({
      deviceId: device.id,
      keyVersion: nextVersion,
      wrappedKey: await wrapConversationKey(newKey, device.publicKey),
    })),
  );

  await input.api.crypto.bootstrapConversation(input.channelId, {
    deviceId: input.identity.deviceId,
    currentKeyVersion: nextVersion,
    wrappedKeys,
  });

  const cacheKey = `${input.instance.instanceId}:${input.userId}:${input.channelId}`;
  memoryKeys.delete(cacheKey);
  localStorage.removeItem(`${keyPrefix}:${cacheKey}`);
  for (const failureKey of recentKeyFailures.keys()) {
    if (failureKey.startsWith(`${cacheKey}:`)) recentKeyFailures.delete(failureKey);
  }
  await persistConversationKey(cacheKey, newKey);
}

async function createReplacementConversationKey(
  input: {
    api: ApiClient;
    instance: InstanceConfig;
    userId: string;
    serverId: string;
    channelId: string;
    identity: DeviceIdentity;
  },
  version: number,
): Promise<ConversationKey> {
  const key = await generateConversationKey(version);
  const devices = await input.api.crypto.listServerDevices(input.serverId);
  const wrappedKeys = await Promise.all(
    devices.map(async (device) => ({
      deviceId: device.id,
      keyVersion: key.version,
      wrappedKey: await wrapConversationKey(key, device.publicKey),
    })),
  );
  await input.api.crypto.bootstrapConversation(input.channelId, {
    deviceId: input.identity.deviceId,
    currentKeyVersion: key.version,
    wrappedKeys,
  });
  return key;
}

async function distributeKeyToNewDevices(
  input: {
    api: ApiClient;
    instance: InstanceConfig;
    userId: string;
    serverId: string;
    channelId: string;
    identity: DeviceIdentity;
  },
  conversationId: string,
  key: ConversationKey,
  existingKeys: Array<{ deviceId: string; keyVersion: number }>,
): Promise<void> {
  try {
    const serverDevices = await input.api.crypto.listServerDevices(input.serverId);
    const coveredAtCurrentVersion = new Set(
      existingKeys.filter((k) => k.keyVersion === key.version).map((k) => k.deviceId),
    );
    const uncoveredDevices = serverDevices.filter(
      (device) => !coveredAtCurrentVersion.has(device.id),
    );
    if (uncoveredDevices.length === 0) return;

    const wrappedKeys = await Promise.all(
      uncoveredDevices.map(async (device) => ({
        deviceId: device.id,
        keyVersion: key.version,
        wrappedKey: await wrapConversationKey(key, device.publicKey),
      })),
    );
    await input.api.crypto.addConversationKeys(conversationId, wrappedKeys);
  } catch {
    // Non-blocking: distribute best-effort, don't fail message send.
  }
}

async function persistConversationKey(cacheKey: string, key: ConversationKey): Promise<void> {
  memoryKeys.set(versionedCacheKey(cacheKey, key.version), key);
  memoryKeys.set(cacheKey, key);
  localStorage.setItem(
    `${keyPrefix}:${cacheKey}:${key.version}`,
    await writeProtectedJson({
      version: key.version,
      bytes: bytesToBase64(key.bytes),
    }),
  );
  localStorage.setItem(`${keyPrefix}:${cacheKey}:latest`, String(key.version));
}

async function readCachedConversationKey(
  cacheKey: string,
  version?: number,
): Promise<ConversationKey | null> {
  if (version) {
    const memoryKey = versionedCacheKey(cacheKey, version);
    const cached = memoryKeys.get(memoryKey);
    if (cached) return cached;
    return readStoredConversationKey(cacheKey, version);
  }

  const cached = memoryKeys.get(cacheKey);
  if (cached) return cached;

  const latestVersion = Number(localStorage.getItem(`${keyPrefix}:${cacheKey}:latest`));
  if (!Number.isInteger(latestVersion) || latestVersion < 1) {
    const legacy = await readLegacyConversationKey(cacheKey);
    if (legacy) {
      await persistConversationKey(cacheKey, legacy);
      return legacy;
    }
    return null;
  }

  return (
    memoryKeys.get(versionedCacheKey(cacheKey, latestVersion)) ??
    readStoredConversationKey(cacheKey, latestVersion)
  );
}

function versionedCacheKey(cacheKey: string, version: number): string {
  return `${cacheKey}:${version}`;
}

async function readStoredConversationKey(
  cacheKey: string,
  version: number,
): Promise<ConversationKey | null> {
  const stored = localStorage.getItem(`${keyPrefix}:${cacheKey}:${version}`);
  if (!stored) return null;

  const key = await readProtectedJson<ConversationKeySnapshot>(stored);
  const conversationKey = { version: key.version, bytes: base64ToBytes(key.bytes) };
  memoryKeys.set(versionedCacheKey(cacheKey, key.version), conversationKey);
  return conversationKey;
}

async function readLegacyConversationKey(cacheKey: string): Promise<ConversationKey | null> {
  const stored = localStorage.getItem(`${keyPrefix}:${cacheKey}`);
  if (!stored) return null;

  const key = await readProtectedJson<ConversationKeySnapshot>(stored);
  return { version: key.version, bytes: base64ToBytes(key.bytes) };
}

async function writeProtectedJson(value: unknown): Promise<string> {
  const serialized = JSON.stringify(value);
  if (await isSecureStorageAvailable()) {
    return JSON.stringify({ protected: true, value: await encryptString(serialized) });
  }

  if (import.meta.env.DEV) {
    return JSON.stringify({ protected: false, value: serialized });
  }

  throw new Error('Le stockage sécurisé OS est requis pour les clés E2EE.');
}

async function readProtectedJson<T>(value: string): Promise<T> {
  const parsed = JSON.parse(value) as { protected: boolean; value: string };
  const serialized = parsed.protected ? await decryptString(parsed.value) : parsed.value;
  return JSON.parse(serialized) as T;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

interface ConversationKeySnapshot {
  version: number;
  bytes: string;
}
