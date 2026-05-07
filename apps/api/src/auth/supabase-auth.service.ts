import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createSupabaseUserClient } from '@discord2/db';
import { loadServerEnv } from '@discord2/config';
import type { AuthUser } from '@discord2/shared';

@Injectable()
export class SupabaseAuthService {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private readonly env = loadServerEnv();

  async verifyBearerToken(accessToken: string): Promise<AuthUser> {
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
}
