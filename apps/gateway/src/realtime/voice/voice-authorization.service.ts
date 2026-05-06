import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelsRepository, ServersRepository, createSupabaseServiceClient } from '@discord2/db';
import { loadServerEnv } from '@discord2/config';
import { ChannelType, type AuthUser, type ChannelId } from '@discord2/shared';

@Injectable()
export class VoiceAuthorizationService {
  private readonly channelsRepository: ChannelsRepository;
  private readonly serversRepository: ServersRepository;

  constructor() {
    const env = loadServerEnv();
    const supabase = createSupabaseServiceClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });

    this.channelsRepository = new ChannelsRepository(supabase);
    this.serversRepository = new ServersRepository(supabase);
  }

  async requireVoiceAccess(user: AuthUser, channelId: ChannelId): Promise<void> {
    const channel = await this.channelsRepository.findById(channelId);
    if (!channel || channel.type !== ChannelType.Voice || !channel.serverId) {
      throw new NotFoundException('Voice channel not found.');
    }

    const membership = await this.serversRepository.findMembership(channel.serverId, user.id);
    if (!membership) {
      throw new ForbiddenException('Voice channel access denied.');
    }
  }
}
