import { Injectable } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import { loadServerEnv } from '@discord2/config';
import type { AuthUser, ChannelId } from '@discord2/shared';

@Injectable()
export class VoiceService {
  private readonly env = loadServerEnv();

  async createJoinToken(
    user: AuthUser,
    channelId: ChannelId,
  ): Promise<{ token: string; room: string }> {
    const room = `voice:${channelId}`;
    const accessToken = new AccessToken(this.env.LIVEKIT_API_KEY, this.env.LIVEKIT_API_SECRET, {
      identity: user.id,
      ttl: '10m',
    });

    accessToken.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    return {
      room,
      token: await accessToken.toJwt(),
    };
  }
}
