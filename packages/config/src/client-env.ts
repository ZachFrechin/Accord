import { z } from 'zod';

const clientEnvSchema = z.object({
  VITE_SUPABASE_URL: z.string().url().optional(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  VITE_API_URL: z.string().url().optional(),
  VITE_GATEWAY_URL: z.string().url().optional(),
  VITE_LIVEKIT_URL: z.string().url().optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function loadClientEnv(source: Record<string, string | undefined>): ClientEnv {
  return clientEnvSchema.parse(source);
}
