import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  MessageId,
  MessageMention,
  Permission,
  RoleId,
  ServerId,
  ServerMember,
  ServerMemberProfile,
  ServerRole,
  UserId,
} from '@discord2/shared';

interface ServerRoleRow {
  id: string;
  server_id: string;
  name: string;
  color: string;
  mentionable: boolean;
  permissions: Permission[];
  position: number;
  created_at: string;
}

interface ServerMemberRow {
  server_id: string;
  user_id: string;
  role: ServerMember['role'];
  profiles?: {
    display_name: string;
    avatar_url: string | null;
  } | null;
}

interface MemberRoleRow {
  user_id: string;
  role_id: string;
}

interface MessageMentionRow {
  message_id: string;
  mentioned_user_id: string | null;
  mentioned_role_id: string | null;
  profiles?: {
    display_name: string;
    avatar_url: string | null;
  } | null;
  server_roles?: {
    name: string;
    color: string;
  } | null;
}

export class RolesRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async listRoles(serverId: ServerId): Promise<ServerRole[]> {
    const { data, error } = await this.supabase
      .from('server_roles')
      .select('id, server_id, name, color, mentionable, permissions, position, created_at')
      .eq('server_id', serverId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .returns<ServerRoleRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapRoleRow);
  }

  async createRole(input: {
    serverId: ServerId;
    name: string;
    color: string;
    mentionable: boolean;
    permissions?: Permission[];
  }): Promise<ServerRole> {
    const roles = await this.listRoles(input.serverId);
    const nextPosition = roles.reduce((max, role) => Math.max(max, role.position), 0) + 1;
    const { data, error } = await this.supabase
      .from('server_roles')
      .insert({
        server_id: input.serverId,
        name: input.name,
        color: input.color,
        mentionable: input.mentionable,
        permissions: input.permissions ?? [],
        position: nextPosition,
      })
      .select('id, server_id, name, color, mentionable, permissions, position, created_at')
      .single<ServerRoleRow>();

    if (error) {
      throw error;
    }

    return mapRoleRow(data);
  }

  async updateRole(
    serverId: ServerId,
    roleId: RoleId,
    input: Partial<Pick<ServerRole, 'name' | 'color' | 'mentionable' | 'permissions'>>,
  ): Promise<ServerRole> {
    const patch: Record<string, string | boolean | Permission[]> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.color !== undefined) patch.color = input.color;
    if (input.mentionable !== undefined) patch.mentionable = input.mentionable;
    if (input.permissions !== undefined) patch.permissions = input.permissions;

    const { data, error } = await this.supabase
      .from('server_roles')
      .update(patch)
      .eq('server_id', serverId)
      .eq('id', roleId)
      .select('id, server_id, name, color, mentionable, permissions, position, created_at')
      .single<ServerRoleRow>();

    if (error) {
      throw error;
    }

    return mapRoleRow(data);
  }

  async reorderRoles(serverId: ServerId, roleIds: RoleId[]): Promise<ServerRole[]> {
    for (const [index, roleId] of roleIds.entries()) {
      const { error } = await this.supabase
        .from('server_roles')
        .update({ position: index + 1 })
        .eq('server_id', serverId)
        .eq('id', roleId);

      if (error) throw error;
    }

    return this.listRoles(serverId);
  }

  async deleteRole(serverId: ServerId, roleId: RoleId): Promise<void> {
    const { error } = await this.supabase
      .from('server_roles')
      .delete()
      .eq('server_id', serverId)
      .eq('id', roleId);

    if (error) {
      throw error;
    }
  }

  async listMembers(serverId: ServerId): Promise<ServerMemberProfile[]> {
    const { data: members, error: membersError } = await this.supabase
      .from('server_members')
      .select('server_id, user_id, role, profiles:user_id(display_name, avatar_url)')
      .eq('server_id', serverId)
      .returns<ServerMemberRow[]>();

    if (membersError) {
      throw membersError;
    }

    const { data: memberRoles, error: rolesError } = await this.supabase
      .from('server_member_roles')
      .select('user_id, role_id')
      .eq('server_id', serverId)
      .returns<MemberRoleRow[]>();

    if (rolesError) {
      throw rolesError;
    }

    const roleIdsByUser = new Map<UserId, RoleId[]>();
    for (const row of memberRoles) {
      const current = roleIdsByUser.get(row.user_id) ?? [];
      current.push(row.role_id);
      roleIdsByUser.set(row.user_id, current);
    }

    return members.map((member) => ({
      serverId: member.server_id,
      userId: member.user_id,
      role: member.role,
      roleIds: roleIdsByUser.get(member.user_id) ?? [],
      profile: {
        id: member.user_id,
        displayName: member.profiles?.display_name ?? 'Unknown user',
        avatarUrl: member.profiles?.avatar_url ?? null,
      },
    }));
  }

  async setMemberRoles(input: {
    serverId: ServerId;
    userId: UserId;
    roleIds: RoleId[];
  }): Promise<void> {
    const { error: deleteError } = await this.supabase
      .from('server_member_roles')
      .delete()
      .eq('server_id', input.serverId)
      .eq('user_id', input.userId);

    if (deleteError) {
      throw deleteError;
    }

    if (input.roleIds.length === 0) {
      return;
    }

    const { error: insertError } = await this.supabase.from('server_member_roles').insert(
      input.roleIds.map((roleId) => ({
        server_id: input.serverId,
        user_id: input.userId,
        role_id: roleId,
      })),
    );

    if (insertError) {
      throw insertError;
    }
  }

  async insertMessageMentions(messageId: MessageId, mentions: MessageMention[]): Promise<void> {
    if (mentions.length === 0) {
      return;
    }

    const { error } = await this.supabase.from('message_mentions').insert(
      mentions.map((mention) => ({
        message_id: messageId,
        mentioned_user_id: mention.type === 'user' ? mention.userId : null,
        mentioned_role_id: mention.type === 'role' ? mention.roleId : null,
      })),
    );

    if (error) {
      throw error;
    }
  }

  async listMentionsForMessages(
    messageIds: MessageId[],
  ): Promise<Map<MessageId, MessageMention[]>> {
    const mentionsByMessage = new Map<MessageId, MessageMention[]>();
    if (messageIds.length === 0) {
      return mentionsByMessage;
    }

    const { data, error } = await this.supabase
      .from('message_mentions')
      .select(
        'message_id, mentioned_user_id, mentioned_role_id, profiles:mentioned_user_id(display_name, avatar_url), server_roles:mentioned_role_id(name, color)',
      )
      .in('message_id', messageIds)
      .returns<MessageMentionRow[]>();

    if (error) {
      throw error;
    }

    for (const row of data) {
      const mention = mapMentionRow(row);
      if (!mention) {
        continue;
      }

      const current = mentionsByMessage.get(row.message_id) ?? [];
      current.push(mention);
      mentionsByMessage.set(row.message_id, current);
    }

    return mentionsByMessage;
  }
}

function mapRoleRow(row: ServerRoleRow): ServerRole {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    color: row.color,
    mentionable: row.mentionable,
    permissions: row.permissions ?? [],
    position: row.position,
    createdAt: row.created_at,
  };
}

function mapMentionRow(row: MessageMentionRow): MessageMention | null {
  if (row.mentioned_user_id) {
    return {
      type: 'user',
      userId: row.mentioned_user_id,
      displayName: row.profiles?.display_name ?? 'Unknown user',
      avatarUrl: row.profiles?.avatar_url ?? null,
    };
  }

  if (row.mentioned_role_id) {
    return {
      type: 'role',
      roleId: row.mentioned_role_id,
      name: row.server_roles?.name ?? 'Role',
      color: row.server_roles?.color ?? '#8b9cff',
    };
  }

  return null;
}
