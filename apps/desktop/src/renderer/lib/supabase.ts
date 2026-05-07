import { createClient } from '@supabase/supabase-js';
import type { InstanceConfig } from '@discord2/shared';

export type SupabaseBrowserClient = ReturnType<typeof createClient>;

export function createSupabaseClient(instance: InstanceConfig): SupabaseBrowserClient {
  return createClient(instance.supabaseUrl, instance.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.localStorage,
      storageKey: `accord:${instance.instanceId}:supabase-auth`,
    },
  });
}
