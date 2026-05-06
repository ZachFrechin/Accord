import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConnectionOptions {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export function createSupabaseServiceClient(options: SupabaseConnectionOptions): SupabaseClient {
  return createClient(options.url, options.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function createSupabaseUserClient(
  options: Pick<SupabaseConnectionOptions, 'url' | 'anonKey'>,
  accessToken: string,
): SupabaseClient {
  return createClient(options.url, options.anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
