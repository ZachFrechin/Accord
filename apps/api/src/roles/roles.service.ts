import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RolesRepository, ServersRepository } from '@discord2/db';
import { canManageServer } from '@discord2/domain';
import type {
  AuthUser,
  MessageMention,
  RoleId,
  ServerId,
  ServerMemberProfile,
  ServerRole,
  UserId,
} from '@discord2/shared';
import type { CreateServerRoleDto, UpdateMemberRolesDto, UpdateServerRoleDto } from './dto';

@Injectable()
export class RolesService {
  private readonly rolesRepository: RolesRepository;
  private readonly serversRepository: ServersRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.rolesRepository = new RolesRepository(supabase);
    this.serversRepository = new ServersRepository(supabase);
  }

  async listRoles(user: AuthUser, serverId: ServerId): Promise<ServerRole[]> {
    await this.requireServerMembership(user, serverId);
    return this.rolesRepository.listRoles(serverId);
  }

  async createRole(
    user: AuthUser,
    serverId: ServerId,
    dto: CreateServerRoleDto,
  ): Promise<ServerRole> {
    await this.requireManageRoles(user, serverId);
    return this.rolesRepository.createRole({
      serverId,
      name: this.normalizeRoleName(dto.name),
      color: dto.color,
      mentionable: dto.mentionable,
    });
  }

  async updateRole(
    user: AuthUser,
    serverId: ServerId,
    roleId: RoleId,
    dto: UpdateServerRoleDto,
  ): Promise<ServerRole> {
    await this.requireManageRoles(user, serverId);
    const input: Partial<Pick<ServerRole, 'name' | 'color' | 'mentionable'>> = {};

    if (dto.name !== undefined) {
      input.name = this.normalizeRoleName(dto.name);
    }

    if (dto.color !== undefined) {
      input.color = dto.color;
    }

    if (dto.mentionable !== undefined) {
      input.mentionable = dto.mentionable;
    }

    if (Object.keys(input).length === 0) {
      throw new BadRequestException('At least one role setting is required.');
    }

    return this.rolesRepository.updateRole(serverId, roleId, input);
  }

  async deleteRole(
    user: AuthUser,
    serverId: ServerId,
    roleId: RoleId,
  ): Promise<{ roleId: RoleId }> {
    await this.requireManageRoles(user, serverId);
    await this.rolesRepository.deleteRole(serverId, roleId);
    return { roleId };
  }

  async listMembers(user: AuthUser, serverId: ServerId): Promise<ServerMemberProfile[]> {
    await this.requireServerMembership(user, serverId);
    return this.rolesRepository.listMembers(serverId);
  }

  async updateMemberRoles(
    user: AuthUser,
    serverId: ServerId,
    targetUserId: UserId,
    dto: UpdateMemberRolesDto,
  ): Promise<ServerMemberProfile> {
    await this.requireManageRoles(user, serverId);
    const targetMembership = await this.serversRepository.findMembership(serverId, targetUserId);
    if (!targetMembership) {
      throw new NotFoundException('Member not found.');
    }

    const roles = await this.rolesRepository.listRoles(serverId);
    const validRoleIds = new Set(roles.map((role) => role.id));
    const uniqueRoleIds = Array.from(new Set(dto.roleIds));
    if (uniqueRoleIds.some((roleId) => !validRoleIds.has(roleId))) {
      throw new BadRequestException('Unknown server role.');
    }

    await this.rolesRepository.setMemberRoles({
      serverId,
      userId: targetUserId,
      roleIds: uniqueRoleIds,
    });

    const members = await this.rolesRepository.listMembers(serverId);
    const updated = members.find((member) => member.userId === targetUserId);
    if (!updated) {
      throw new NotFoundException('Member not found.');
    }

    return updated;
  }

  async resolveMentions(serverId: ServerId, content: string | null): Promise<MessageMention[]> {
    if (!content) {
      return [];
    }

    const [members, roles] = await Promise.all([
      this.rolesRepository.listMembers(serverId),
      this.rolesRepository.listRoles(serverId),
    ]);
    const mentions: MessageMention[] = [];
    const normalizedContent = content.toLocaleLowerCase();

    for (const member of members) {
      if (hasMention(normalizedContent, member.profile.displayName)) {
        mentions.push({
          type: 'user',
          userId: member.userId,
          displayName: member.profile.displayName,
          avatarUrl: member.profile.avatarUrl,
        });
      }
    }

    for (const role of roles) {
      if (role.mentionable && hasMention(normalizedContent, role.name)) {
        mentions.push({
          type: 'role',
          roleId: role.id,
          name: role.name,
          color: role.color,
        });
      }
    }

    return dedupeMentions(mentions);
  }

  insertMessageMentions(
    ...args: Parameters<RolesRepository['insertMessageMentions']>
  ): ReturnType<RolesRepository['insertMessageMentions']> {
    return this.rolesRepository.insertMessageMentions(...args);
  }

  listMentionsForMessages(
    ...args: Parameters<RolesRepository['listMentionsForMessages']>
  ): ReturnType<RolesRepository['listMentionsForMessages']> {
    return this.rolesRepository.listMentionsForMessages(...args);
  }

  private async requireServerMembership(user: AuthUser, serverId: ServerId): Promise<void> {
    const membership = await this.serversRepository.findMembership(serverId, user.id);
    if (!membership) {
      throw new NotFoundException('Server not found.');
    }
  }

  private async requireManageRoles(user: AuthUser, serverId: ServerId): Promise<void> {
    const membership = await this.serversRepository.findMembership(serverId, user.id);
    if (!membership) {
      throw new NotFoundException('Server not found.');
    }

    if (!canManageServer(membership)) {
      throw new ForbiddenException('You cannot manage roles for this server.');
    }
  }

  private normalizeRoleName(name: string): string {
    const normalized = name.trim().replace(/^@+/, '');
    if (!normalized) {
      throw new BadRequestException('Role name is required.');
    }

    return normalized;
  }
}

function hasMention(normalizedContent: string, name: string): boolean {
  const normalizedName = escapeRegExp(name.trim().toLocaleLowerCase());
  if (!normalizedName) {
    return false;
  }

  return new RegExp(`(^|\\s)@${normalizedName}(?=$|\\s|[,.!?;:])`, 'u').test(normalizedContent);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeMentions(mentions: MessageMention[]): MessageMention[] {
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = mention.type === 'user' ? `user:${mention.userId}` : `role:${mention.roleId}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
