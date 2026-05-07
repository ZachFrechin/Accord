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
    if (this.env.SUPABASE_JWT_SECRET) {
      return this.verifyLocally(accessToken);
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
        this.logger.warn(`Supabase rejected bearer token: ${error.message}`);
      }
      throw new UnauthorizedException('Invalid access token.');
    }

    return {
      id: data.user.id,
      email: data.user.email ?? null,
    };
  }

  private async verifyLocally(accessToken: string): Promise<AuthUser> {
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
        }`,
      );
      throw new UnauthorizedException('Invalid access token.');
    }
  }
}
