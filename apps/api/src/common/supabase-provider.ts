import { createSupabaseServiceClient } from '@discord2/db';
import { loadServerEnv } from '@discord2/config';

export const supabaseProvider = {
  provide: 'SUPABASE_SERVICE_CLIENT',
  useFactory: () => {
    const env = loadServerEnv();
    return createSupabaseServiceClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
  },
};
