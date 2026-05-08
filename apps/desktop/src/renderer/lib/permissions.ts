import {
  AllPermissions,
  ChannelPermissionOverwriteTargetType,
  Permission,
  type ChannelPermissionOverwrite,
  type Permission as PermissionValue,
  type ServerMemberProfile,
  type ServerRole,
  type UserId,
} from '@discord2/shared';

const defaultMemberPermissions: PermissionValue[] = [
  Permission.CreateInvites,
  Permission.ViewChannel,
  Permission.SendMessages,
  Permission.AttachFiles,
  Permission.ConnectVoice,
  Permission.SpeakVoice,
];

export function getServerPermissions(
  userId: UserId,
  members: ServerMemberProfile[],
  roles: ServerRole[],
): PermissionValue[] {
  const member = members.find((item) => item.userId === userId);
  if (!member) return [];
  if (member.role === 'owner' || member.role === 'admin') return [...AllPermissions];

  const permissions = new Set(defaultMemberPermissions);
  for (const role of roles) {
    if (member.roleIds.includes(role.id)) {
      role.permissions.forEach((permission) => permissions.add(permission));
    }
  }
  return Array.from(permissions);
}

export function getChannelPermissions(
  userId: UserId,
  members: ServerMemberProfile[],
  roles: ServerRole[],
  overwrites: ChannelPermissionOverwrite[],
): PermissionValue[] {
  const serverPermissions = getServerPermissions(userId, members, roles);
  if (serverPermissions.includes(Permission.Administrator)) return [...AllPermissions];

  const member = members.find((item) => item.userId === userId);
  const roleIds = member?.roleIds ?? [];
  const permissions = new Set(serverPermissions);

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
    (item) =>
      item.targetType === ChannelPermissionOverwriteTargetType.Member && item.targetId === userId,
  )) {
    applyOverwrite(permissions, overwrite);
  }

  return Array.from(permissions);
}

export function hasPermission(
  permissions: PermissionValue[],
  permission: PermissionValue,
): boolean {
  return permissions.includes(Permission.Administrator) || permissions.includes(permission);
}

export function getPrimaryRole(
  userId: UserId,
  members: ServerMemberProfile[],
  roles: ServerRole[],
): ServerRole | null {
  const member = members.find((item) => item.userId === userId);
  if (!member) return null;
  const memberRoles = roles.filter((role) => member.roleIds.includes(role.id));
  return memberRoles.sort((a, b) => b.position - a.position)[0] ?? null;
}

function applyOverwrite(
  permissions: Set<PermissionValue>,
  overwrite: ChannelPermissionOverwrite,
): void {
  overwrite.denyPermissions.forEach((permission) => permissions.delete(permission));
  overwrite.allowPermissions.forEach((permission) => permissions.add(permission));
}
