import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createSupabaseUserClient } from '@discord2/db';
import { loadServerEnv } from '@discord2/config';
import type { AuthUser } from '@discord2/shared';

@Injectable()
export class SupabaseWsAuthService {
  private readonly env = loadServerEnv();

  async verify(accessToken: string): Promise<AuthUser> {
    const supabase = createSupabaseUserClient(
      {
        url: this.env.SUPABASE_URL,
        anonKey: this.env.SUPABASE_ANON_KEY,
      },
      accessToken,
    );

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid access token.');
    }

    return {
      id: data.user.id,
      email: data.user.email ?? null,
    };
  }
}
