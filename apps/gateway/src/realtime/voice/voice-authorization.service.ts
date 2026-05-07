import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ChannelsRepository,
  RolesRepository,
  ServersRepository,
  createSupabaseServiceClient,
} from '@discord2/db';
import { loadServerEnv } from '@discord2/config';
import {
  ChannelPermissionOverwriteTargetType,
  ChannelType,
  Permission,
  type AuthUser,
  type ChannelId,
  type ChannelPermissionOverwrite,
  type Permission as PermissionValue,
  type RoleId,
} from '@discord2/shared';

@Injectable()
export class VoiceAuthorizationService {
  private readonly channelsRepository: ChannelsRepository;
  private readonly rolesRepository: RolesRepository;
  private readonly serversRepository: ServersRepository;

  constructor() {
    const env = loadServerEnv();
    const supabase = createSupabaseServiceClient({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });

    this.channelsRepository = new ChannelsRepository(supabase);
    this.rolesRepository = new RolesRepository(supabase);
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

    if (membership.role === 'owner' || membership.role === 'admin') {
      return;
    }

    const [members, roles, overwrites] = await Promise.all([
      this.rolesRepository.listMembers(channel.serverId),
      this.rolesRepository.listRoles(channel.serverId),
      this.channelsRepository.listPermissionOverwrites(channel.id),
    ]);
    const member = members.find((item) => item.userId === user.id);
    const roleIds = member?.roleIds ?? [];
    const permissions = new Set<PermissionValue>([
      Permission.CreateInvites,
      Permission.ViewChannel,
      Permission.SendMessages,
      Permission.AttachFiles,
      Permission.ConnectVoice,
      Permission.SpeakVoice,
    ]);

    for (const role of roles) {
      if (roleIds.includes(role.id)) {
        role.permissions.forEach((permission) => permissions.add(permission));
      }
    }

    applyChannelOverwrites(permissions, roleIds, user.id, overwrites);
    if (!permissions.has(Permission.ViewChannel) || !permissions.has(Permission.ConnectVoice)) {
      throw new ForbiddenException('Voice channel access denied.');
    }
  }
}

function applyChannelOverwrites(
  permissions: Set<PermissionValue>,
  roleIds: RoleId[],
  userId: string,
  overwrites: ChannelPermissionOverwrite[],
): void {
  for (const overwrite of overwrites.filter(
    (item) => item.targetType === ChannelPermissionOverwriteTargetType.Everyone,
  )) {
    applyOverwrite(permissions, overwrite);
  }

  const roleDeny = new Set<PermissionValue>();
  const roleAllow = new Set<PermissionValue>();
  for (const overwrite of overwrites.filter(
    (item) =>
      item.targetType === ChannelPermissionOverwriteTargetType.Role &&
      item.targetId !== null &&
      roleIds.includes(item.targetId),
  )) {
    overwrite.denyPermissions.forEach((permission) => roleDeny.add(permission));
    overwrite.allowPermissions.forEach((permission) => roleAllow.add(permission));
  }
  roleDeny.forEach((permission) => permissions.delete(permission));
  roleAllow.forEach((permission) => permissions.add(permission));

  for (const overwrite of overwrites.filter(
    (item) => item.targetType === ChannelPermissionOverwriteTargetType.Member && item.targetId === userId,
  )) {
    applyOverwrite(permissions, overwrite);
  }
}

function applyOverwrite(
  permissions: Set<PermissionValue>,
  overwrite: ChannelPermissionOverwrite,
): void {
  overwrite.denyPermissions.forEach((permission) => permissions.delete(permission));
  overwrite.allowPermissions.forEach((permission) => permissions.add(permission));
}
