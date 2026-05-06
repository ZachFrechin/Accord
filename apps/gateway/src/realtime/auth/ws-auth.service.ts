import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { SupabaseWsAuthService } from './supabase-ws-auth.service';
import type { AuthenticatedSocket } from '../types/authenticated-socket';

@Injectable()
export class WsAuthService {
  constructor(private readonly supabaseAuth: SupabaseWsAuthService) {}

  async authenticateSocket(client: AuthenticatedSocket): Promise<AuthUser> {
    const token = this.readBearerToken(client);
    const user = await this.supabaseAuth.verify(token);
    client.data.user = user;
    return user;
  }

  requireUser(client: AuthenticatedSocket): AuthUser {
    if (!client.data.user) {
      client.disconnect(true);
      throw new UnauthorizedException('Socket is not authenticated.');
    }

    return client.data.user;
  }

  private readBearerToken(client: AuthenticatedSocket): string {
    const auth = client.handshake.auth as Record<string, unknown>;
    const authToken = auth['token'];

    if (typeof authToken === 'string' && authToken.startsWith('Bearer ')) {
      return authToken.slice('Bearer '.length).trim();
    }

    if (typeof authToken === 'string') {
      return authToken;
    }

    throw new UnauthorizedException('Missing socket token.');
  }
}
