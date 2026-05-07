import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { createSupabaseUserClient } from '@discord2/db';
import { loadServerEnv } from '@discord2/config';
import type { AuthUser } from '@discord2/shared';

@Injectable()
export class SupabaseAuthService {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private readonly env = loadServerEnv();

  async verifyBearerToken(accessToken: string): Promise<AuthUser> {
    const decoded = decodeJwtWithoutVerification(accessToken);
    if (this.env.SUPABASE_JWT_SECRET) {
      return this.verifyLocally(accessToken, decoded);
    }

    const supabase = createSupabaseUserClient(
      {
        url: this.env.SUPABASE_INTERNAL_URL ?? this.env.SUPABASE_URL,
        anonKey: this.env.SUPABASE_ANON_KEY,
      },
      accessToken,
    );

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      if (error) {
        this.logger.warn(
          `Supabase rejected bearer token: ${error.message}; ${formatAuthDebugContext(
            this.env.SUPABASE_URL,
            this.env.SUPABASE_INTERNAL_URL,
            decoded,
          )}`,
        );
      }
      throw new UnauthorizedException('Invalid access token.');
    }

    return {
      id: data.user.id,
      email: data.user.email ?? null,
    };
  }

  private async verifyLocally(
    accessToken: string,
    decoded: DecodedJwtPayload | null,
  ): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(
        accessToken,
        new TextEncoder().encode(this.env.SUPABASE_JWT_SECRET),
        {
          algorithms: ['HS256'],
        },
      );
      if (!payload.sub) {
        throw new Error('Missing JWT subject.');
      }

      return {
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
      };
    } catch (error) {
      this.logger.warn(
        `Supabase JWT local verification failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }; ${formatAuthDebugContext(this.env.SUPABASE_URL, this.env.SUPABASE_INTERNAL_URL, decoded)}`,
      );
      throw new UnauthorizedException('Invalid access token.');
    }
  }
}

interface DecodedJwtPayload {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  role?: unknown;
  exp?: unknown;
}

function decodeJwtWithoutVerification(accessToken: string): DecodedJwtPayload | null {
  try {
    const [, payload] = accessToken.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DecodedJwtPayload;
  } catch {
    return null;
  }
}

function formatAuthDebugContext(
  supabaseUrl: string,
  supabaseInternalUrl: string | undefined,
  decoded: DecodedJwtPayload | null,
): string {
  return [
    `SUPABASE_URL=${redactUrl(supabaseUrl)}`,
    `SUPABASE_INTERNAL_URL=${supabaseInternalUrl ? redactUrl(supabaseInternalUrl) : 'unset'}`,
    `jwt.iss=${typeof decoded?.iss === 'string' ? decoded.iss : 'unknown'}`,
    `jwt.aud=${typeof decoded?.aud === 'string' ? decoded.aud : 'unknown'}`,
    `jwt.role=${typeof decoded?.role === 'string' ? decoded.role : 'unknown'}`,
    `jwt.sub=${typeof decoded?.sub === 'string' ? decoded.sub : 'unknown'}`,
  ].join(', ');
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid-url';
  }
}
