import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository } from '@discord2/db';
import { canManageServer } from '@discord2/domain';
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
    const membership = await this.serversService.requireMembership(user, serverId);
    const name = dto.name.trim();

    if (!name) {
      throw new BadRequestException('Channel name is required.');
    }

    if (dto.type === ChannelType.Text) {
      return this.repository.createTextChannel({
        serverId,
        name,
      });
    }

    if (dto.type === ChannelType.Voice) {
      if (!canManageServer({ serverId, userId: user.id, role: membership.role })) {
        throw new ForbiddenException('You cannot manage voice channels for this server.');
      }

      return this.repository.createVoiceChannel({
        serverId,
        name,
      });
    }

    throw new BadRequestException('Unsupported channel type.');
  }
}
