import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelId, EncryptedPayload, MessageRecord, UserId } from '@discord2/shared';
import { MessagePrivacy } from '@discord2/shared';

export interface InsertMessageInput {
  channelId: ChannelId;
  authorId: UserId;
  privacy: MessagePrivacy;
  content: string | null;
  encrypted: EncryptedPayload | null;
}

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  privacy: MessagePrivacy;
  content: string | null;
  encrypted_payload: EncryptedPayload | null;
  created_at: string;
  edited_at: string | null;
}

export class MessagesRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async insert(input: InsertMessageInput): Promise<MessageRecord> {
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        channel_id: input.channelId,
        author_id: input.authorId,
        privacy: input.privacy,
        content: input.privacy === MessagePrivacy.Public ? input.content : null,
        encrypted_payload: input.encrypted,
      })
      .select(
        'id, channel_id, author_id, privacy, content, encrypted_payload, created_at, edited_at',
      )
      .single<MessageRow>();

    if (error) {
      throw error;
    }

    return mapMessageRow(data);
  }

  async listByChannel(channelId: ChannelId, limit = 50): Promise<MessageRecord[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select(
        'id, channel_id, author_id, privacy, content, encrypted_payload, created_at, edited_at',
      )
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<MessageRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapMessageRow);
  }
}

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    privacy: row.privacy,
    content: row.content,
    encrypted: row.encrypted_payload,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}
