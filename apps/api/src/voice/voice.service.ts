import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository } from '@discord2/db';
import { loadServerEnv } from '@discord2/config';
import {
  ChannelType,
  type AuthUser,
  type ChannelId,
  type VoiceTokenResponse,
} from '@discord2/shared';
import { ServersService } from '../servers/servers.service';

@Injectable()
export class VoiceService {
  private readonly env = loadServerEnv();
  private readonly channelsRepository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly serversService: ServersService,
  ) {
    this.channelsRepository = new ChannelsRepository(supabase);
  }

  async createJoinToken(user: AuthUser, channelId: ChannelId): Promise<VoiceTokenResponse> {
    const channel = await this.channelsRepository.findById(channelId);
    if (!channel || channel.type !== ChannelType.Voice || !channel.serverId) {
      throw new NotFoundException('Voice channel not found.');
    }

    await this.serversService.requireMembership(user, channel.serverId);

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
