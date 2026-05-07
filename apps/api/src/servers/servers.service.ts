import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ServersRepository } from '@discord2/db';
import {
  Permission,
  type AuthUser,
  type BanServerMemberInput,
  type ServerBanRecord,
  type ServerId,
  type ServerSummary,
  type UpdateServerInput,
  type UserId,
} from '@discord2/shared';
import { assertPublicStorageUrl } from '../common/storage-url.validator';
import { PermissionsService } from '../permissions/permissions.service';
import type { CreateServerDto, UpdateServerDto } from './dto';

@Injectable()
export class ServersService {
  private readonly repository: ServersRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly permissionsService: PermissionsService,
  ) {
    this.repository = new ServersRepository(supabase);
  }

  listServers(user: AuthUser): Promise<ServerSummary[]> {
    return this.repository.listForUser(user.id);
  }

  createServer(user: AuthUser, dto: CreateServerDto): Promise<ServerSummary> {
    return this.repository.create({
      name: dto.name.trim(),
      ownerId: user.id,
    });
  }

  async requireMembership(user: AuthUser, serverId: ServerId): Promise<ServerSummary> {
    const server = await this.repository.findByIdForUser(serverId, user.id);
    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return server;
  }

  async removeMember(
    user: AuthUser,
    serverId: ServerId,
    targetUserId: UserId,
  ): Promise<{ serverId: ServerId; userId: UserId }> {
    await this.permissionsService.assertCanManageTargetMember(
      user,
      serverId,
      targetUserId,
      Permission.KickMembers,
    );

    await this.repository.removeMember(serverId, targetUserId);
    return { serverId, userId: targetUserId };
  }

  async listBans(user: AuthUser, serverId: ServerId): Promise<ServerBanRecord[]> {
    await this.permissionsService.assertServerPermission(user, serverId, Permission.BanMembers);
    return this.repository.listBans(serverId);
  }

  async banMember(
    user: AuthUser,
    serverId: ServerId,
    dto: BanServerMemberInput,
  ): Promise<ServerBanRecord> {
    await this.permissionsService.assertCanManageTargetMember(
      user,
      serverId,
      dto.userId,
      Permission.BanMembers,
    );

    return this.repository.banMember({
      serverId,
      userId: dto.userId,
      bannedBy: user.id,
      reason: dto.reason?.trim() || null,
    });
  }

  async unbanMember(
    user: AuthUser,
    serverId: ServerId,
    targetUserId: UserId,
  ): Promise<{ serverId: ServerId; userId: UserId }> {
    await this.permissionsService.assertServerPermission(user, serverId, Permission.BanMembers);
    return this.repository.unbanMember(serverId, targetUserId);
  }

  async updateServer(
    user: AuthUser,
    serverId: ServerId,
    dto: UpdateServerDto,
  ): Promise<ServerSummary> {
    await this.permissionsService.assertServerPermission(user, serverId, Permission.ManageServer);
    const membership = await this.repository.findMembership(serverId, user.id);
    if (!membership) throw new NotFoundException('Server not found.');

    const name = dto.name?.trim();
    if (name === undefined && dto.avatarUrl === undefined) {
      throw new BadRequestException('At least one server setting is required.');
    }

    if (name !== undefined && !name) {
      throw new BadRequestException('Server name is required.');
    }

    assertPublicStorageUrl(dto.avatarUrl, 'server-icons');
    const input: UpdateServerInput = {};
    if (name !== undefined) {
      input.name = name;
    }

    if (dto.avatarUrl !== undefined) {
      input.avatarUrl = dto.avatarUrl;
    }

    const updated = await this.repository.update(serverId, input);

    return {
      ...updated,
      role: membership.role,
    };
  }
}
