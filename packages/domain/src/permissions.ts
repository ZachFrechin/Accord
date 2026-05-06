import { ChannelType, type ChannelSummary, type ServerMember } from '@discord2/shared';

export function canCreateInvite(member: ServerMember): boolean {
  return member.role === 'owner' || member.role === 'admin';
}

export function canWriteChannel(channel: ChannelSummary, member: ServerMember | null): boolean {
  if (channel.type === ChannelType.DirectMessage) {
    return true;
  }

  return member !== null && member.serverId === channel.serverId;
}

export function canManageServer(member: ServerMember): boolean {
  return member.role === 'owner' || member.role === 'admin';
}
