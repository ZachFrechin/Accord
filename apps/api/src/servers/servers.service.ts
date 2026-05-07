import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ServersRepository } from '@discord2/db';
import { canManageServer } from '@discord2/domain';
import type { AuthUser, ServerId, ServerSummary, UpdateServerInput, UserId } from '@discord2/shared';
import { assertPublicStorageUrl } from '../common/storage-url.validator';
import type { CreateServerDto, UpdateServerDto } from './dto';

@Injectable()
export class ServersService {
  private readonly repository: ServersRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
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
    const membership = await this.repository.findMembership(serverId, user.id);
    if (!membership) {
      throw new NotFoundException('Server not found.');
    }

    if (!canManageServer(membership)) {
      throw new ForbiddenException('You cannot manage this server.');
    }

    const targetMembership = await this.repository.findMembership(serverId, targetUserId);
    if (!targetMembership) {
      throw new NotFoundException('Member not found.');
    }

    if (targetMembership.role === 'owner') {
      throw new ForbiddenException('The server owner cannot be removed.');
    }

    await this.repository.removeMember(serverId, targetUserId);
    return { serverId, userId: targetUserId };
  }

  async updateServer(
    user: AuthUser,
    serverId: ServerId,
    dto: UpdateServerDto,
  ): Promise<ServerSummary> {
    const membership = await this.repository.findMembership(serverId, user.id);
    if (!membership) {
      throw new NotFoundException('Server not found.');
    }

    if (!canManageServer(membership)) {
      throw new ForbiddenException('You cannot manage this server.');
    }

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
