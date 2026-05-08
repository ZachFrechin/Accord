import { createClient } from '@supabase/supabase-js';
import type { InstanceConfig } from '@discord2/shared';

export type SupabaseBrowserClient = ReturnType<typeof createClient<Record<string, never>>>;

const clients = new Map<string, SupabaseBrowserClient>();

export function createSupabaseClient(instance: InstanceConfig): SupabaseBrowserClient {
  const cacheKey = `${instance.instanceId}:${instance.supabaseUrl}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const client: SupabaseBrowserClient = createClient<Record<string, never>>(
    instance.supabaseUrl,
    instance.supabaseAnonKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: window.localStorage,
        storageKey: `accord:${instance.instanceId}:supabase-auth`,
      },
    },
  );
  clients.set(cacheKey, client);
  return client;
}
