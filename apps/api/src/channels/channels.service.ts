import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository } from '@discord2/db';
import { ChannelType, type AuthUser, type ChannelSummary, type ServerId } from '@discord2/shared';
import { ServersService } from '../servers/servers.service';
import type { CreateChannelDto } from './dto';

@Injectable()
export class ChannelsService {
  private readonly repository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly serversService: ServersService,
  ) {
    this.repository = new ChannelsRepository(supabase);
  }

  async listChannels(user: AuthUser, serverId: ServerId): Promise<ChannelSummary[]> {
    await this.serversService.requireMembership(user, serverId);
    return this.repository.listByServer(serverId);
  }

  async createChannel(
    user: AuthUser,
    serverId: ServerId,
    dto: CreateChannelDto,
  ): Promise<ChannelSummary> {
    await this.serversService.requireMembership(user, serverId);

    if (dto.type !== ChannelType.Text) {
      throw new BadRequestException('Only public text channels are supported in this iteration.');
    }

    return this.repository.createTextChannel({
      serverId,
      name: dto.name.trim(),
    });
  }
}
