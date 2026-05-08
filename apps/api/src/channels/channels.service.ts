import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository } from '@discord2/db';
import {
  ChannelPermissionOverwriteTargetType,
  ChannelType,
  Permission,
  type AuthUser,
  type ChannelId,
  type ChannelPermissionOverwrite,
  type ChannelSummary,
  type DeleteChannelResult,
  type ServerId,
} from '@discord2/shared';
import { PermissionsService } from '../permissions/permissions.service';
import type { CreateChannelDto, UpdateChannelDto, UpdateChannelPermissionsDto } from './dto';

@Injectable()
export class ChannelsService {
  private readonly repository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly permissionsService: PermissionsService,
  ) {
    this.repository = new ChannelsRepository(supabase);
  }

  async listChannels(user: AuthUser, serverId: ServerId): Promise<ChannelSummary[]> {
    return this.permissionsService.listVisibleChannels(user, serverId);
  }

  async createChannel(
    user: AuthUser,
    serverId: ServerId,
    dto: CreateChannelDto,
  ): Promise<ChannelSummary> {
    await this.permissionsService.assertServerPermission(user, serverId, Permission.ManageChannels);
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

  async listChannelPermissions(
    user: AuthUser,
    serverId: ServerId,
    channelId: ChannelId,
  ): Promise<ChannelPermissionOverwrite[]> {
    await this.requireManageableServerChannel(user, serverId, channelId);
    return this.repository.listPermissionOverwrites(channelId);
  }

  async updateChannelPermissions(
    user: AuthUser,
    serverId: ServerId,
    channelId: ChannelId,
    dto: UpdateChannelPermissionsDto,
  ): Promise<ChannelPermissionOverwrite[]> {
    await this.requireManageableServerChannel(user, serverId, channelId);
    const normalized = dto.overwrites.map((overwrite) => ({
      targetType: overwrite.targetType,
      targetId:
        overwrite.targetType === ChannelPermissionOverwriteTargetType.Everyone
          ? null
          : overwrite.targetId,
      allowPermissions: Array.from(new Set(overwrite.allowPermissions)),
      denyPermissions: Array.from(new Set(overwrite.denyPermissions)),
    }));

    for (const overwrite of normalized) {
      if (
        overwrite.targetType !== ChannelPermissionOverwriteTargetType.Everyone &&
        !overwrite.targetId
      ) {
        throw new BadRequestException('Permission overwrite target is required.');
      }
    }

    return this.repository.replacePermissionOverwrites(channelId, normalized);
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

    await this.permissionsService.assertServerPermission(user, serverId, Permission.ManageChannels);

    return channel;
  }
}
