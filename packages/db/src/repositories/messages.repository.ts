import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ChannelId,
  CreateAttachmentInput,
  EncryptedPayload,
  MessageAttachment,
  MessageEmbed,
  MessageEmbedType,
  MessageRecord,
  UserId,
  UserProfile,
} from '@discord2/shared';
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
  profiles?: {
    display_name: string;
    avatar_url: string | null;
  } | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  file_name: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  is_e2ee: boolean;
  encrypted_payload: EncryptedPayload | null;
}

interface EmbedRow {
  id: string;
  message_id: string;
  type: MessageEmbedType;
  url: string;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  provider: string | null;
  embed_url: string | null;
}

export interface InsertEmbedInput {
  type: MessageEmbedType;
  url: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  provider?: string;
  embedUrl?: string;
}

export type MessageWithAuthor = MessageRecord & {
  author: Pick<UserProfile, 'id' | 'displayName' | 'avatarUrl'>;
};

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

  async insertAttachments(
    messageId: string,
    attachments: CreateAttachmentInput[],
  ): Promise<MessageAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase
      .from('attachments')
      .insert(
        attachments.map((attachment) => ({
          message_id: messageId,
          storage_path: attachment.storagePath,
          mime_type: attachment.mimeType,
          byte_size: attachment.byteSize,
          file_name: attachment.fileName ?? null,
          is_e2ee: false,
        })),
      )
      .select(
        'id, message_id, storage_path, mime_type, byte_size, file_name, width, height, duration_ms, is_e2ee, encrypted_payload',
      )
      .returns<AttachmentRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapAttachmentRow);
  }

  async insertEmbeds(messageId: string, embeds: InsertEmbedInput[]): Promise<MessageEmbed[]> {
    if (embeds.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase
      .from('message_embeds')
      .insert(
        embeds.map((embed) => ({
          message_id: messageId,
          type: embed.type,
          url: embed.url,
          title: embed.title ?? null,
          description: embed.description ?? null,
          thumbnail_url: embed.thumbnailUrl ?? null,
          provider: embed.provider ?? null,
          embed_url: embed.embedUrl ?? null,
        })),
      )
      .select(
        'id, message_id, type, url, title, description, thumbnail_url, provider, embed_url',
      )
      .returns<EmbedRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapEmbedRow);
  }

  async listByChannel(channelId: ChannelId, limit = 50): Promise<MessageWithAuthor[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select(
        'id, channel_id, author_id, privacy, content, encrypted_payload, created_at, edited_at, profiles:author_id(display_name, avatar_url)',
      )
      .eq('channel_id', channelId)
      .order('created_at', { ascending: true })
      .limit(limit)
      .returns<MessageRow[]>();

    if (error) {
      throw error;
    }

    return data.map(mapMessageWithAuthorRow);
  }

  async listAttachmentsForMessages(messageIds: string[]): Promise<Map<string, MessageAttachment[]>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const { data, error } = await this.supabase
      .from('attachments')
      .select(
        'id, message_id, storage_path, mime_type, byte_size, file_name, width, height, duration_ms, is_e2ee, encrypted_payload',
      )
      .in('message_id', messageIds)
      .order('created_at', { ascending: true })
      .returns<AttachmentRow[]>();

    if (error) {
      throw error;
    }

    const byMessage = new Map<string, MessageAttachment[]>();
    for (const row of data) {
      const current = byMessage.get(row.message_id) ?? [];
      current.push(mapAttachmentRow(row));
      byMessage.set(row.message_id, current);
    }

    return byMessage;
  }

  async listEmbedsForMessages(messageIds: string[]): Promise<Map<string, MessageEmbed[]>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const { data, error } = await this.supabase
      .from('message_embeds')
      .select('id, message_id, type, url, title, description, thumbnail_url, provider, embed_url')
      .in('message_id', messageIds)
      .order('created_at', { ascending: true })
      .returns<EmbedRow[]>();

    if (error) {
      throw error;
    }

    const byMessage = new Map<string, MessageEmbed[]>();
    for (const row of data) {
      const current = byMessage.get(row.message_id) ?? [];
      current.push(mapEmbedRow(row));
      byMessage.set(row.message_id, current);
    }

    return byMessage;
  }
}

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    attachments: [],
    embeds: [],
    privacy: row.privacy,
    content: row.content,
    encrypted: row.encrypted_payload,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

function mapAttachmentRow(row: AttachmentRow): MessageAttachment {
  const attachment: MessageAttachment = {
    id: row.id,
    url: toMessageMediaPublicUrl(row.storage_path),
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    isE2ee: row.is_e2ee,
  };

  if (row.file_name) attachment.fileName = row.file_name;
  if (row.width) attachment.width = row.width;
  if (row.height) attachment.height = row.height;
  if (row.duration_ms) attachment.durationMs = row.duration_ms;

  return attachment;
}

function mapEmbedRow(row: EmbedRow): MessageEmbed {
  const embed: MessageEmbed = {
    id: row.id,
    type: row.type,
    url: row.url,
  };

  if (row.title) embed.title = row.title;
  if (row.description) embed.description = row.description;
  if (row.thumbnail_url) embed.thumbnailUrl = row.thumbnail_url;
  if (row.provider) embed.provider = row.provider;
  if (row.embed_url) embed.embedUrl = row.embed_url;

  return embed;
}

function toMessageMediaPublicUrl(storagePath: string): string {
  const baseUrl = process.env.SUPABASE_URL;
  if (!baseUrl) {
    return storagePath;
  }

  return `${new URL(baseUrl).origin}/storage/v1/object/public/message-media/${storagePath}`;
}

function mapMessageWithAuthorRow(row: MessageRow): MessageWithAuthor {
  return {
    ...mapMessageRow(row),
    author: {
      id: row.author_id,
      displayName: row.profiles?.display_name ?? 'Unknown user',
      avatarUrl: row.profiles?.avatar_url ?? null,
    },
  };
}
