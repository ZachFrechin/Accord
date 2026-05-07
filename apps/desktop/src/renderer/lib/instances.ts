import type { InstanceConfig } from '@discord2/shared';
import { env } from './env';

const instancesStorageKey = 'accord-instances-v1';
const activeInstanceStorageKey = 'accord-active-instance-id';
const manifestPath = '/.well-known/accord/client-config';

export interface SavedInstancesState {
  instances: InstanceConfig[];
  activeInstanceId: string | null;
}

export function loadSavedInstances(): SavedInstancesState {
  const devInstance = getDevInstance();
  const instances = sanitizeStoredInstances(
    parseInstances(localStorage.getItem(instancesStorageKey)),
    devInstance,
  );
  const activeInstanceId = localStorage.getItem(activeInstanceStorageKey);
  const merged = devInstance ? upsertInstance(instances, devInstance) : instances;
  const nextActiveInstanceId =
    activeInstanceId && merged.some((instance) => instance.instanceId === activeInstanceId)
      ? activeInstanceId
      : (merged[0]?.instanceId ?? null);

  persistSanitizedInstances(merged, nextActiveInstanceId);

  return {
    instances: merged,
    activeInstanceId: nextActiveInstanceId,
  };
}

export function saveInstance(instance: InstanceConfig): SavedInstancesState {
  const current = loadSavedInstances();
  const instances = upsertInstance(current.instances, instance);
  localStorage.setItem(instancesStorageKey, JSON.stringify(instances));
  localStorage.setItem(activeInstanceStorageKey, instance.instanceId);
  return { instances, activeInstanceId: instance.instanceId };
}

export function setActiveInstance(instanceId: string): SavedInstancesState {
  const current = loadSavedInstances();
  if (!current.instances.some((instance) => instance.instanceId === instanceId)) {
    throw new Error('Instance inconnue.');
  }

  localStorage.setItem(activeInstanceStorageKey, instanceId);
  return { ...current, activeInstanceId: instanceId };
}

export async function discoverInstance(apiUrlInput: string): Promise<InstanceConfig> {
  const apiUrl = normalizeApiUrl(apiUrlInput);
  assertTransportIsAllowed(apiUrl, 'API');

  const response = await fetch(`${apiUrl}${manifestPath}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Manifeste introuvable (${response.status}).`);
  }

  const config = normalizeManifest((await response.json()) as Partial<InstanceConfig>, apiUrl);
  validateInstanceConfig(config);
  return config;
}

export function validateInstanceConfig(config: InstanceConfig): void {
  assertTransportIsAllowed(config.apiUrl, 'API');
  assertTransportIsAllowed(config.supabaseUrl, 'Supabase');
  assertTransportIsAllowed(config.livekitUrl, 'LiveKit');
  assertTransportIsAllowed(config.gatewayUrl, 'Gateway');

  const gatewayProtocol = new URL(config.gatewayUrl).protocol;
  if (gatewayProtocol !== 'wss:' && !isLocalUrl(config.gatewayUrl)) {
    throw new Error('La gateway doit être exposée en WSS en production.');
  }
}

function normalizeManifest(config: Partial<InstanceConfig>, fallbackApiUrl: string): InstanceConfig {
  if (
    !config.instanceId ||
    !config.instanceName ||
    !config.supabaseUrl ||
    !config.supabaseAnonKey ||
    !config.gatewayUrl ||
    !config.livekitUrl
  ) {
    throw new Error('Manifeste instance invalide.');
  }

  return {
    instanceId: config.instanceId,
    instanceName: config.instanceName,
    apiUrl: trimTrailingSlash(config.apiUrl ?? fallbackApiUrl),
    supabaseUrl: trimTrailingSlash(config.supabaseUrl),
    supabaseAnonKey: config.supabaseAnonKey,
    gatewayUrl: trimTrailingSlash(config.gatewayUrl),
    livekitUrl: trimTrailingSlash(config.livekitUrl),
    capabilities: config.capabilities ?? [],
    ...(config.minClientVersion ? { minClientVersion: config.minClientVersion } : {}),
  };
}

function normalizeApiUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return trimTrailingSlash(new URL(withProtocol).toString());
}

function assertTransportIsAllowed(value: string, label: string): void {
  const url = new URL(value);
  if (url.protocol === 'https:' || url.protocol === 'wss:') {
    return;
  }

  if ((url.protocol === 'http:' || url.protocol === 'ws:') && isLocalHostname(url.hostname)) {
    return;
  }

  throw new Error(`${label} doit utiliser HTTPS/WSS hors localhost.`);
}

function isLocalUrl(value: string): boolean {
  return isLocalHostname(new URL(value).hostname);
}

function isLocalHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  // RFC 1918 private ranges
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }
  return false;
}

function parseInstances(value: string | null): InstanceConfig[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as InstanceConfig[];
    return Array.isArray(parsed) ? parsed.filter(isInstanceConfigShape) : [];
  } catch {
    return [];
  }
}

function isInstanceConfigShape(value: InstanceConfig): value is InstanceConfig {
  return Boolean(
    value?.instanceId &&
      value.instanceName &&
      value.apiUrl &&
      value.supabaseUrl &&
      value.supabaseAnonKey &&
      value.gatewayUrl &&
      value.livekitUrl,
  );
}

function upsertInstance(instances: InstanceConfig[], instance: InstanceConfig): InstanceConfig[] {
  return [
    ...instances.filter((candidate) => candidate.instanceId !== instance.instanceId),
    instance,
  ];
}

function getDevInstance(): InstanceConfig | null {
  if (
    !env.VITE_API_URL ||
    !env.VITE_SUPABASE_URL ||
    !env.VITE_SUPABASE_ANON_KEY ||
    !env.VITE_GATEWAY_URL ||
    !env.VITE_LIVEKIT_URL
  ) {
    return null;
  }

  const instance = {
    instanceId: 'local-dev',
    instanceName: 'Local dev',
    apiUrl: trimTrailingSlash(env.VITE_API_URL),
    supabaseUrl: trimTrailingSlash(env.VITE_SUPABASE_URL),
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
    gatewayUrl: trimTrailingSlash(env.VITE_GATEWAY_URL),
    livekitUrl: trimTrailingSlash(env.VITE_LIVEKIT_URL),
    capabilities: ['messages:e2ee:v1', 'files:e2ee:v1', 'voice:livekit:v1'],
  };

  return isLocalUrl(instance.apiUrl) ? instance : null;
}

function sanitizeStoredInstances(
  instances: InstanceConfig[],
  devInstance: InstanceConfig | null,
): InstanceConfig[] {
  if (devInstance) return instances;
  return instances.filter((instance) => instance.instanceId !== 'local-dev');
}

function persistSanitizedInstances(
  instances: InstanceConfig[],
  activeInstanceId: string | null,
): void {
  localStorage.setItem(instancesStorageKey, JSON.stringify(instances));
  if (activeInstanceId) {
    localStorage.setItem(activeInstanceStorageKey, activeInstanceId);
  } else {
    localStorage.removeItem(activeInstanceStorageKey);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
