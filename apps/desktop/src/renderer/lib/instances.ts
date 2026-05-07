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
  const instances = parseInstances(localStorage.getItem(instancesStorageKey));
  const activeInstanceId = localStorage.getItem(activeInstanceStorageKey);
  const devInstance = getDevInstance();
  const merged = devInstance ? upsertInstance(instances, devInstance) : instances;

  return {
    instances: merged,
    activeInstanceId:
      activeInstanceId && merged.some((instance) => instance.instanceId === activeInstanceId)
        ? activeInstanceId
        : (devInstance?.instanceId ?? merged[0]?.instanceId ?? null),
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
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
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

  return {
    instanceId: 'local-dev',
    instanceName: 'Local dev',
    apiUrl: trimTrailingSlash(env.VITE_API_URL),
    supabaseUrl: trimTrailingSlash(env.VITE_SUPABASE_URL),
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
    gatewayUrl: trimTrailingSlash(env.VITE_GATEWAY_URL),
    livekitUrl: trimTrailingSlash(env.VITE_LIVEKIT_URL),
    capabilities: ['messages:e2ee:v1', 'files:e2ee:v1', 'voice:livekit:v1'],
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
