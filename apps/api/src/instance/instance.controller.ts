import { Controller, Get, Req } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { loadServerEnv } from '@discord2/config';
import type { InstanceConfig } from '@discord2/shared';
import { Public } from '../auth/public.decorator';

@Controller('.well-known/accord')
export class InstanceController {
  @Public()
  @Get('client-config')
  getClientConfig(@Req() request: { protocol?: string; get?: (name: string) => string | undefined }): InstanceConfig {
    const env = loadServerEnv();
    const apiUrl = resolvePublicApiUrl(env.API_PUBLIC_URL, request);
    const instanceId =
      env.INSTANCE_ID ??
      stableInstanceId(`${apiUrl}|${env.SUPABASE_URL}|${env.GATEWAY_PUBLIC_URL ?? ''}`);

    return {
      instanceId,
      instanceName: env.INSTANCE_NAME ?? new URL(apiUrl).hostname,
      apiUrl,
      supabaseUrl: env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
      gatewayUrl:
        env.GATEWAY_PUBLIC_URL ??
        process.env.SERVICE_URL_GATEWAY ??
        process.env.SERVICE_FQDN_GATEWAY ??
        deriveGatewayUrl(apiUrl),
      livekitUrl:
        env.LIVEKIT_PUBLIC_URL ??
        process.env.SERVICE_URL_LIVEKIT ??
        process.env.SERVICE_FQDN_LIVEKIT ??
        env.LIVEKIT_URL,
      capabilities: ['messages:e2ee:v1', 'files:e2ee:v1', 'voice:livekit:v1'],
      minClientVersion: '0.1.0',
    };
  }
}

function resolvePublicApiUrl(
  explicitUrl: string | undefined,
  request: { protocol?: string; get?: (name: string) => string | undefined },
): string {
  if (explicitUrl) {
    return trimTrailingSlash(explicitUrl);
  }

  const host = request.get?.('x-forwarded-host') ?? request.get?.('host') ?? 'localhost:4000';
  const forwardedProto = request.get?.('x-forwarded-proto');
  const protocol = forwardedProto ?? request.protocol ?? 'http';

  return trimTrailingSlash(`${protocol}://${host}`);
}

function deriveGatewayUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.hostname.startsWith('api.')) {
    url.hostname = url.hostname.replace(/^api\./, 'gateway.');
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  return trimTrailingSlash(url.toString());
}

function stableInstanceId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
