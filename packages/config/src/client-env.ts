import { z } from 'zod';

const clientEnvSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  VITE_API_URL: z.string().url(),
  VITE_GATEWAY_URL: z.string().url(),
  VITE_LIVEKIT_URL: z.string().url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function loadClientEnv(source: Record<string, string | undefined>): ClientEnv {
  return clientEnvSchema.parse(source);
}
