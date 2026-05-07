import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository, RolesRepository, ServersRepository } from '@discord2/db';
import {
  AllPermissions,
  ChannelPermissionOverwriteTargetType,
  Permission,
  type AuthUser,
  type ChannelId,
  type ChannelPermissionOverwrite,
  type ChannelSummary,
  type EffectivePermissions,
  type Permission as PermissionValue,
  type RoleId,
  type ServerId,
  type ServerMember,
  type ServerRole,
  type UserId,
} from '@discord2/shared';

const DEFAULT_MEMBER_PERMISSIONS: PermissionValue[] = [
  Permission.CreateInvites,
  Permission.ViewChannel,
  Permission.SendMessages,
  Permission.AttachFiles,
  Permission.ConnectVoice,
  Permission.SpeakVoice,
];

@Injectable()
export class PermissionsService {
  private readonly channelsRepository: ChannelsRepository;
  private readonly rolesRepository: RolesRepository;
  private readonly serversRepository: ServersRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.channelsRepository = new ChannelsRepository(supabase);
    this.rolesRepository = new RolesRepository(supabase);
    this.serversRepository = new ServersRepository(supabase);
  }

  async getEffectiveServerPermissions(
    userId: UserId,
    serverId: ServerId,
  ): Promise<EffectivePermissions | null> {
    const membership = await this.serversRepository.findMembership(serverId, userId);
    if (!membership) return null;

    const [roles, members] = await Promise.all([
      this.rolesRepository.listRoles(serverId),
      this.rolesRepository.listMembers(serverId),
    ]);
    const member = members.find((item) => item.userId === userId);
    const memberRoleIds = member?.roleIds ?? [];
    const memberRoles = roles.filter((role) => memberRoleIds.includes(role.id));
    const permissions = this.resolveServerPermissions(membership, memberRoles);
    const isAdministrator = permissions.has(Permission.Administrator);

    return {
      serverId,
      permissions: Array.from(isAdministrator ? new Set(AllPermissions) : permissions),
      roleIds: memberRoleIds,
      highestRolePosition: getHighestRolePosition(membership, memberRoles),
      isOwner: membership.role === 'owner',
      isAdministrator,
    };
  }

  async getEffectiveChannelPermissions(
    userId: UserId,
    channel: ChannelSummary,
  ): Promise<EffectivePermissions | null> {
    if (!channel.serverId) return null;

    const serverPermissions = await this.getEffectiveServerPermissions(userId, channel.serverId);
    if (!serverPermissions) return null;
    if (serverPermissions.isAdministrator) {
      return { ...serverPermissions, channelId: channel.id, permissions: [...AllPermissions] };
    }

    const overwrites = await this.channelsRepository.listPermissionOverwrites(channel.id);
    const permissions = applyChannelOverwrites(
      new Set(serverPermissions.permissions),
      serverPermissions.roleIds,
      userId,
      overwrites,
    );

    return {
      ...serverPermissions,
      channelId: channel.id,
      permissions: Array.from(permissions),
      isAdministrator: permissions.has(Permission.Administrator),
    };
  }

  async listVisibleChannels(user: AuthUser, serverId: ServerId): Promise<ChannelSummary[]> {
    const [channels, serverPermissions] = await Promise.all([
      this.channelsRepository.listByServer(serverId),
      this.getEffectiveServerPermissions(user.id, serverId),
    ]);
    if (!serverPermissions) {
      throw new NotFoundException('Server not found.');
    }
    if (serverPermissions.isAdministrator) {
      return channels.map((channel) => ({ ...channel, permissions: [...AllPermissions] }));
    }

    const overwritesByChannel = await this.channelsRepository.listPermissionOverwritesForServer(serverId);
    return channels.flatMap((channel) => {
      const permissions = applyChannelOverwrites(
        new Set(serverPermissions.permissions),
        serverPermissions.roleIds,
        user.id,
        overwritesByChannel.get(channel.id) ?? [],
      );
      return permissions.has(Permission.ViewChannel)
        ? [{ ...channel, permissions: Array.from(permissions) }]
        : [];
    });
  }

  async assertServerPermission(
    user: AuthUser,
    serverId: ServerId,
    permission: PermissionValue,
  ): Promise<EffectivePermissions> {
    const effective = await this.getEffectiveServerPermissions(user.id, serverId);
    if (!effective) {
      throw new NotFoundException('Server not found.');
    }
    if (!hasPermission(effective.permissions, permission)) {
      throw new ForbiddenException('Missing server permission.');
    }
    return effective;
  }

  async assertChannelPermission(
    user: AuthUser,
    channelId: ChannelId,
    permission: PermissionValue,
  ): Promise<{ channel: ChannelSummary; effective: EffectivePermissions }> {
    const channel = await this.channelsRepository.findById(channelId);
    if (!channel || !channel.serverId) {
      throw new NotFoundException('Channel not found.');
    }

    const effective = await this.getEffectiveChannelPermissions(user.id, channel);
    if (!effective || !hasPermission(effective.permissions, permission)) {
      throw new ForbiddenException('Missing channel permission.');
    }

    return { channel, effective };
  }

  async assertCanManageTargetMember(
    user: AuthUser,
    serverId: ServerId,
    targetUserId: UserId,
    permission: PermissionValue,
  ): Promise<void> {
    const actor = await this.assertServerPermission(user, serverId, permission);
    const targetMembership = await this.serversRepository.findMembership(serverId, targetUserId);
    if (!targetMembership) {
      throw new NotFoundException('Member not found.');
    }
    if (targetMembership.role === 'owner') {
      throw new ForbiddenException('The server owner cannot be managed.');
    }
    if (actor.isOwner) return;

    const target = await this.getEffectiveServerPermissions(targetUserId, serverId);
    if (!target || actor.highestRolePosition <= target.highestRolePosition) {
      throw new ForbiddenException('You cannot manage this member.');
    }
  }

  async assertCanManageRole(user: AuthUser, serverId: ServerId, role: ServerRole): Promise<void> {
    const actor = await this.assertServerPermission(user, serverId, Permission.ManageRoles);
    if (actor.isOwner) return;
    if (actor.highestRolePosition <= role.position) {
      throw new ForbiddenException('You cannot manage this role.');
    }
  }

  private resolveServerPermissions(
    membership: ServerMember,
    roles: ServerRole[],
  ): Set<PermissionValue> {
    if (membership.role === 'owner' || membership.role === 'admin') {
      return new Set(AllPermissions);
    }

    const permissions = new Set(DEFAULT_MEMBER_PERMISSIONS);
    for (const role of roles) {
      for (const permission of role.permissions) {
        permissions.add(permission);
      }
    }
    return permissions;
  }
}

function applyChannelOverwrites(
  permissions: Set<PermissionValue>,
  roleIds: RoleId[],
  userId: UserId,
  overwrites: ChannelPermissionOverwrite[],
): Set<PermissionValue> {
  const next = new Set(permissions);

  for (const overwrite of overwrites.filter(
    (item) => item.targetType === ChannelPermissionOverwriteTargetType.Everyone,
  )) {
    applyOverwrite(next, overwrite);
  }

  const roleOverwrites = overwrites.filter(
    (item) =>
      item.targetType === ChannelPermissionOverwriteTargetType.Role &&
      item.targetId !== null &&
      roleIds.includes(item.targetId),
  );
  const roleDeny = new Set<PermissionValue>();
  const roleAllow = new Set<PermissionValue>();
  for (const overwrite of roleOverwrites) {
    overwrite.denyPermissions.forEach((permission) => roleDeny.add(permission));
    overwrite.allowPermissions.forEach((permission) => roleAllow.add(permission));
  }
  roleDeny.forEach((permission) => next.delete(permission));
  roleAllow.forEach((permission) => next.add(permission));

  for (const overwrite of overwrites.filter(
    (item) =>
      item.targetType === ChannelPermissionOverwriteTargetType.Member && item.targetId === userId,
  )) {
    applyOverwrite(next, overwrite);
  }

  return next;
}

function applyOverwrite(
  permissions: Set<PermissionValue>,
  overwrite: ChannelPermissionOverwrite,
): void {
  overwrite.denyPermissions.forEach((permission) => permissions.delete(permission));
  overwrite.allowPermissions.forEach((permission) => permissions.add(permission));
}

function getHighestRolePosition(membership: ServerMember, roles: ServerRole[]): number {
  if (membership.role === 'owner') return Number.POSITIVE_INFINITY;
  if (membership.role === 'admin') return 1_000_000;
  return roles.reduce((max, role) => Math.max(max, role.position), 0);
}

function hasPermission(permissions: PermissionValue[], permission: PermissionValue): boolean {
  return permissions.includes(Permission.Administrator) || permissions.includes(permission);
}
