import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ChannelId,
  ConversationId,
  CryptoDevice,
  DeviceId,
  E2eeConversationState,
  ServerId,
  UserId,
  WrappedConversationKey,
} from '@discord2/shared';

interface CryptoDeviceRow {
  id: string;
  user_id: string;
  public_key: string;
  created_at: string;
  revoked_at: string | null;
}

interface E2eeConversationRow {
  id: string;
  channel_id: string;
  current_key_version: number;
}

interface E2eeConversationKeyRow {
  conversation_id: string;
  device_id: string;
  key_version: number;
  wrapped_key: string;
}

export class CryptoRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async upsertDevice(input: {
    deviceId: DeviceId;
    userId: UserId;
    publicKey: string;
  }): Promise<CryptoDevice> {
    const { data, error } = await this.supabase
      .from('crypto_devices')
      .upsert(
        {
          id: input.deviceId,
          user_id: input.userId,
          public_key: input.publicKey,
          revoked_at: null,
        },
        { onConflict: 'id' },
      )
      .select('id, user_id, public_key, created_at, revoked_at')
      .single<CryptoDeviceRow>();

    if (error) throw error;
    return mapDeviceRow(data);
  }

  async listActiveDevicesForServer(serverId: ServerId): Promise<CryptoDevice[]> {
    const { data: members, error: membersError } = await this.supabase
      .from('server_members')
      .select('user_id')
      .eq('server_id', serverId)
      .returns<Array<{ user_id: string }>>();

    if (membersError) throw membersError;
    const userIds = members.map((member) => member.user_id);
    if (userIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('crypto_devices')
      .select('id, user_id, public_key, created_at, revoked_at')
      .in('user_id', userIds)
      .is('revoked_at', null)
      .returns<CryptoDeviceRow[]>();

    if (error) throw error;
    return data.map(mapDeviceRow);
  }

  async listActiveDevicesForUser(userId: UserId): Promise<CryptoDevice[]> {
    const { data, error } = await this.supabase
      .from('crypto_devices')
      .select('id, user_id, public_key, created_at, revoked_at')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .returns<CryptoDeviceRow[]>();

    if (error) throw error;
    return data.map(mapDeviceRow);
  }

  async findConversationByChannel(channelId: ChannelId): Promise<E2eeConversationState | null> {
    const { data, error } = await this.supabase
      .from('e2ee_conversations')
      .select('id, channel_id, current_key_version')
      .eq('channel_id', channelId)
      .maybeSingle<E2eeConversationRow>();

    if (error) throw error;
    if (!data) return null;

    const keys = await this.listKeys(data.id);
    return mapConversationRow(data, keys);
  }

  async bootstrapConversation(input: {
    channelId: ChannelId;
    currentKeyVersion: number;
    wrappedKeys: Array<{
      deviceId: DeviceId;
      keyVersion: number;
      wrappedKey: string;
    }>;
  }): Promise<E2eeConversationState> {
    const { data: conversation, error } = await this.supabase
      .from('e2ee_conversations')
      .upsert(
        {
          channel_id: input.channelId,
          current_key_version: input.currentKeyVersion,
        },
        { onConflict: 'channel_id' },
      )
      .select('id, channel_id, current_key_version')
      .single<E2eeConversationRow>();

    if (error) throw error;

    await this.insertConversationKeys(conversation.id, input.wrappedKeys);
    const keys = await this.listKeys(conversation.id);
    return mapConversationRow(conversation, keys);
  }

  async insertConversationKeys(
    conversationId: ConversationId,
    wrappedKeys: Array<{
      deviceId: DeviceId;
      keyVersion: number;
      wrappedKey: string;
    }>,
  ): Promise<WrappedConversationKey[]> {
    if (wrappedKeys.length === 0) return [];

    const { data, error } = await this.supabase
      .from('e2ee_conversation_keys')
      .upsert(
        wrappedKeys.map((key) => ({
          conversation_id: conversationId,
          device_id: key.deviceId,
          key_version: key.keyVersion,
          wrapped_key: key.wrappedKey,
        })),
        { onConflict: 'conversation_id,device_id,key_version' },
      )
      .select('conversation_id, device_id, key_version, wrapped_key')
      .returns<E2eeConversationKeyRow[]>();

    if (error) throw error;
    return data.map(mapKeyRow);
  }

  async findConversationById(
    conversationId: ConversationId,
  ): Promise<{ conversationId: ConversationId; channelId: ChannelId; currentKeyVersion: number } | null> {
    const { data, error } = await this.supabase
      .from('e2ee_conversations')
      .select('id, channel_id, current_key_version')
      .eq('id', conversationId)
      .maybeSingle<E2eeConversationRow>();

    if (error) throw error;
    if (!data) return null;
    return {
      conversationId: data.id,
      channelId: data.channel_id,
      currentKeyVersion: data.current_key_version,
    };
  }

  async revokeDevice(deviceId: DeviceId, userId: UserId): Promise<void> {
    const { error } = await this.supabase
      .from('crypto_devices')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', deviceId)
      .eq('user_id', userId);

    if (error) throw error;
  }

  private async listKeys(conversationId: ConversationId): Promise<WrappedConversationKey[]> {
    const { data, error } = await this.supabase
      .from('e2ee_conversation_keys')
      .select('conversation_id, device_id, key_version, wrapped_key')
      .eq('conversation_id', conversationId)
      .returns<E2eeConversationKeyRow[]>();

    if (error) throw error;
    return data.map(mapKeyRow);
  }
}

function mapDeviceRow(row: CryptoDeviceRow): CryptoDevice {
  return {
    id: row.id,
    userId: row.user_id,
    publicKey: row.public_key,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function mapConversationRow(
  row: E2eeConversationRow,
  keys: WrappedConversationKey[],
): E2eeConversationState {
  return {
    conversationId: row.id,
    channelId: row.channel_id,
    currentKeyVersion: row.current_key_version,
    keys,
  };
}

function mapKeyRow(row: E2eeConversationKeyRow): WrappedConversationKey {
  return {
    conversationId: row.conversation_id,
    deviceId: row.device_id,
    keyVersion: row.key_version,
    wrappedKey: row.wrapped_key,
  };
}
