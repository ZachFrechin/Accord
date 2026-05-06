import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository } from '@discord2/db';
import { canManageServer } from '@discord2/domain';
import {
  ChannelType,
  type AuthUser,
  type ChannelId,
  type ChannelSummary,
  type DeleteChannelResult,
  type ServerId,
} from '@discord2/shared';
import { ServersService } from '../servers/servers.service';
import type { CreateChannelDto, UpdateChannelDto } from './dto';

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

  async updateChannel(
    user: AuthUser,
    serverId: ServerId,
    channelId: ChannelId,
    dto: UpdateChannelDto,
  ): Promise<ChannelSummary> {
    await this.requireManageableServerChannel(user, serverId, channelId);
    const name = dto.name.trim();

    if (!name) {
      throw new BadRequestException('Channel name is required.');
    }

    return this.repository.update(channelId, { name });
  }

  async deleteChannel(
    user: AuthUser,
    serverId: ServerId,
    channelId: ChannelId,
  ): Promise<DeleteChannelResult> {
    await this.requireManageableServerChannel(user, serverId, channelId);
    await this.repository.delete(channelId);
    return { channelId };
  }

  private async requireManageableServerChannel(
    user: AuthUser,
    serverId: ServerId,
    channelId: ChannelId,
  ): Promise<ChannelSummary> {
    const channel = await this.repository.findById(channelId);
    if (
      !channel ||
      channel.serverId !== serverId ||
      (channel.type !== ChannelType.Text && channel.type !== ChannelType.Voice)
    ) {
      throw new NotFoundException('Channel not found.');
    }

    const membership = await this.serversService.requireMembership(user, serverId);
    if (!canManageServer({ serverId, userId: user.id, role: membership.role })) {
      throw new ForbiddenException('You cannot manage channels for this server.');
    }

    return channel;
  }
}
