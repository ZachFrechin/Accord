import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MessagesRepository } from '@discord2/db';
import { normalizeMessageInput } from '@discord2/domain';
import type { AuthUser, ChannelId, MessageRecord } from '@discord2/shared';
import type { CreateMessageDto } from './dto';

@Injectable()
export class MessagesService {
  private readonly repository: MessagesRepository;

  constructor(@Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient) {
    this.repository = new MessagesRepository(supabase);
  }

  async createMessage(
    user: AuthUser,
    channelId: ChannelId,
    dto: CreateMessageDto,
  ): Promise<MessageRecord> {
    const normalized = normalizeMessageInput({
      privacy: dto.privacy,
      content: dto.content ?? null,
      encrypted: dto.encrypted ?? null,
    });

    return this.repository.insert({
      channelId,
      authorId: user.id,
      privacy: normalized.privacy,
      content: normalized.content ?? null,
      encrypted: normalized.encrypted ?? null,
    });
  }

  async listMessages(channelId: ChannelId): Promise<MessageRecord[]> {
    return this.repository.listByChannel(channelId);
  }
}
