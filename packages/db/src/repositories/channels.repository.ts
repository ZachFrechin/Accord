import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelType, type ChannelId, type ChannelSummary, type ServerId } from '@discord2/shared';

interface ChannelRow {
  id: string;
  server_id: string | null;
  type: ChannelSummary['type'];
  name: string;
  is_private: boolean;
  created_at?: string;
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
