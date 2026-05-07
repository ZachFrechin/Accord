import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ChannelPermissionOverwriteTargetType,
  ChannelType,
  type ChannelId,
  type ChannelPermissionOverwrite,
  type ChannelSummary,
  type Permission,
  type RoleId,
  type ServerId,
  type UpdateChannelPermissionOverwriteInput,
  type UserId,
} from '@discord2/shared';

interface ChannelRow {
  id: string;
  server_id: string | null;
  type: ChannelSummary['type'];
  name: string;
  is_private: boolean;
  created_at?: string;
}

interface ChannelPermissionOverwriteRow {
  id: string;
  channel_id: string;
  target_type: ChannelPermissionOverwrite['targetType'];
  target_id: string | null;
  allow_permissions: Permission[];
  deny_permissions: Permission[];
}

export class ChannelsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async findById(channelId: ChannelId): Promise<ChannelSummary | null> {
    const { data, error } = await this.supabase
      .from('channels')
      .select('id, server_id, type, name, is_private, created_at')
      .eq('id', channelId)
      .maybeSingle<ChannelRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    return mapChannelRow(data);
  }

  async listByServer(serverId: ServerId): Promise<ChannelSummary[]> {
    const { data, error } = await this.supabase
      .from('channels')
      .select('id, server_id, type, name, is_private, created_at')
      .eq('server_id', serverId)
      .order('created_at', { ascending: true })
      .returns<ChannelRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapChannelRow);
  }

  async listVisibleByServer(serverId: ServerId, channelIds: ChannelId[]): Promise<ChannelSummary[]> {
    if (channelIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('channels')
      .select('id, server_id, type, name, is_private, created_at')
      .eq('server_id', serverId)
      .in('id', channelIds)
      .order('created_at', { ascending: true })
      .returns<ChannelRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapChannelRow);
  }

  async listPermissionOverwrites(channelId: ChannelId): Promise<ChannelPermissionOverwrite[]> {
    const { data, error } = await this.supabase
      .from('channel_permission_overwrites')
      .select('id, channel_id, target_type, target_id, allow_permissions, deny_permissions')
      .eq('channel_id', channelId)
      .returns<ChannelPermissionOverwriteRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapOverwriteRow);
  }

  async listPermissionOverwritesForServer(
    serverId: ServerId,
  ): Promise<Map<ChannelId, ChannelPermissionOverwrite[]>> {
    const { data, error } = await this.supabase
      .from('channel_permission_overwrites')
      .select(
        'id, channel_id, target_type, target_id, allow_permissions, deny_permissions, channels!inner(server_id)',
      )
      .eq('channels.server_id', serverId)
      .returns<ChannelPermissionOverwriteRow[]>();

    if (error) {
      throw error;
    }

    const byChannel = new Map<ChannelId, ChannelPermissionOverwrite[]>();
    for (const row of data) {
      const current = byChannel.get(row.channel_id) ?? [];
      current.push(mapOverwriteRow(row));
      byChannel.set(row.channel_id, current);
    }

    return byChannel;
  }

  async replacePermissionOverwrites(
    channelId: ChannelId,
    overwrites: UpdateChannelPermissionOverwriteInput[],
  ): Promise<ChannelPermissionOverwrite[]> {
    const { error: deleteError } = await this.supabase
      .from('channel_permission_overwrites')
      .delete()
      .eq('channel_id', channelId);

    if (deleteError) throw deleteError;

    if (overwrites.length > 0) {
      const { error: insertError } = await this.supabase.from('channel_permission_overwrites').insert(
        overwrites.map((overwrite) => ({
          channel_id: channelId,
          target_type: overwrite.targetType,
          target_id:
            overwrite.targetType === ChannelPermissionOverwriteTargetType.Everyone
              ? null
              : overwrite.targetId,
          allow_permissions: overwrite.allowPermissions,
          deny_permissions: overwrite.denyPermissions,
        })),
      );

      if (insertError) throw insertError;
    }

    return this.listPermissionOverwrites(channelId);
  }

  async createTextChannel(input: { serverId: ServerId; name: string }): Promise<ChannelSummary> {
    return this.createServerChannel({
      ...input,
      type: ChannelType.Text,
    });
  }

  async createVoiceChannel(input: { serverId: ServerId; name: string }): Promise<ChannelSummary> {
    return this.createServerChannel({
      ...input,
      type: ChannelType.Voice,
    });
  }

  async update(channelId: ChannelId, input: { name: string }): Promise<ChannelSummary> {
    const { data, error } = await this.supabase
      .from('channels')
      .update({
        name: input.name,
      })
      .eq('id', channelId)
      .select('id, server_id, type, name, is_private, created_at')
      .single<ChannelRow>();

    if (error) {
      throw error;
    }

    return mapChannelRow(data);
  }

  async delete(channelId: ChannelId): Promise<void> {
    const { error } = await this.supabase.from('channels').delete().eq('id', channelId);

    if (error) {
      throw error;
    }
  }

  private async createServerChannel(input: {
    serverId: ServerId;
    name: string;
    type: typeof ChannelType.Text | typeof ChannelType.Voice;
  }): Promise<ChannelSummary> {
    const { data, error } = await this.supabase
      .from('channels')
      .insert({
        server_id: input.serverId,
        type: input.type,
        name: input.name,
        is_private: false,
      })
      .select('id, server_id, type, name, is_private, created_at')
      .single<ChannelRow>();

    if (error) {
      throw error;
    }

    return mapChannelRow(data);
  }
}

function mapOverwriteRow(row: ChannelPermissionOverwriteRow): ChannelPermissionOverwrite {
  return {
    id: row.id,
    channelId: row.channel_id,
    targetType: row.target_type,
    targetId: row.target_id as RoleId | UserId | null,
    allowPermissions: row.allow_permissions ?? [],
    denyPermissions: row.deny_permissions ?? [],
  };
}

function mapChannelRow(row: ChannelRow): ChannelSummary {
  return {
    id: row.id,
    serverId: row.server_id,
    type: row.type,
    name: row.name,
    isPrivate: row.is_private,
    createdAt: row.created_at ?? null,
  };
}
