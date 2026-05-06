import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelId, ChannelSummary } from '@discord2/shared';

interface ChannelRow {
  id: string;
  server_id: string | null;
  type: ChannelSummary['type'];
  name: string;
  is_private: boolean;
}

export class ChannelsRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async findById(channelId: ChannelId): Promise<ChannelSummary | null> {
    const { data, error } = await this.supabase
      .from('channels')
      .select('id, server_id, type, name, is_private')
      .eq('id', channelId)
      .maybeSingle<ChannelRow>();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    return {
      id: data.id,
      serverId: data.server_id,
      type: data.type,
      name: data.name,
      isPrivate: data.is_private,
    };
  }
}
