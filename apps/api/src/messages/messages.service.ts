import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository, MessagesRepository } from '@discord2/db';
import { normalizeMessageInput } from '@discord2/domain';
import {
  ChannelType,
  type AuthUser,
  type ChannelId,
  type CreateAttachmentInput,
  type MessageRecord,
} from '@discord2/shared';
import { RolesService } from '../roles/roles.service';
import { ServersService } from '../servers/servers.service';
import { UsersService } from '../users/users.service';
import type { CreateMessageDto } from './dto';
import { EmbedsService } from './embeds.service';
import { MessageEventsPublisher } from './message-events.publisher';

const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

@Injectable()
export class MessagesService {
  private readonly repository: MessagesRepository;
  private readonly channelsRepository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly serversService: ServersService,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
    private readonly embedsService: EmbedsService,
    private readonly eventsPublisher: MessageEventsPublisher,
  ) {
    this.repository = new MessagesRepository(supabase);
    this.channelsRepository = new ChannelsRepository(supabase);
  }

  async createMessage(
    user: AuthUser,
    channelId: ChannelId,
    dto: CreateMessageDto,
  ): Promise<MessageRecord> {
    const serverId = await this.requireChannelWriteAccess(user, channelId);
    const attachments = validateMessageAttachments(user.id, channelId, dto.attachments ?? []);
    const normalized = normalizeMessageInput({
      privacy: dto.privacy,
      content: dto.content ?? null,
      encrypted: dto.encrypted ?? null,
      attachments,
    });

    const message = await this.repository.insert({
      channelId,
      authorId: user.id,
      privacy: normalized.privacy,
      content: normalized.content ?? null,
      encrypted: normalized.encrypted ?? null,
    });
    const [storedAttachments, embedInputs] = await Promise.all([
      this.repository.insertAttachments(message.id, attachments),
      this.embedsService.createEmbeds(normalized.content ?? null),
    ]);
    const embeds = await this.repository.insertEmbeds(message.id, embedInputs);
    const mentions = await this.rolesService.resolveMentions(serverId, normalized.content ?? null);
    await this.rolesService.insertMessageMentions(message.id, mentions);

    const profile = await this.usersService.me(user);
    const messageWithAuthor: MessageRecord = {
      ...message,
      mentions,
      attachments: storedAttachments,
      embeds,
      author: {
        id: profile.id,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      },
    };

    await this.eventsPublisher.publishMessageCreated({
      channelId,
      message: messageWithAuthor,
    });

    return messageWithAuthor;
  }

  async listMessages(user: AuthUser, channelId: ChannelId): Promise<MessageRecord[]> {
    await this.requireChannelWriteAccess(user, channelId);
    const messages = await this.repository.listByChannel(channelId);
    const messageIds = messages.map((message) => message.id);
    const [mentionsByMessage, attachmentsByMessage, embedsByMessage] = await Promise.all([
      this.rolesService.listMentionsForMessages(messageIds),
      this.repository.listAttachmentsForMessages(messageIds),
      this.repository.listEmbedsForMessages(messageIds),
    ]);
    return messages.map((message) => ({
      ...message,
      mentions: mentionsByMessage.get(message.id) ?? [],
      attachments: attachmentsByMessage.get(message.id) ?? [],
      embeds: embedsByMessage.get(message.id) ?? [],
    }));
  }

  private async requireChannelWriteAccess(user: AuthUser, channelId: ChannelId): Promise<string> {
    const channel = await this.channelsRepository.findById(channelId);
    if (!channel) {
      throw new NotFoundException('Channel not found.');
    }

    if (channel.type !== ChannelType.Text) {
      throw new ForbiddenException('Only public text channels are supported in this iteration.');
    }

    if (!channel.serverId) {
      throw new ForbiddenException('Direct messages are not supported in this iteration.');
    }

    await this.serversService.requireMembership(user, channel.serverId);
    return channel.serverId;
  }
}

function validateMessageAttachments(
  userId: string,
  channelId: ChannelId,
  attachments: CreateAttachmentInput[],
): CreateAttachmentInput[] {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new BadRequestException('Too many attachments.');
  }

  return attachments.map((attachment) => {
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(attachment.mimeType)) {
      throw new BadRequestException('Attachment type is not allowed.');
    }

    if (attachment.byteSize > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Attachment is too large.');
    }

    const expectedPrefix = `${channelId}/${userId}/`;
    if (
      !attachment.storagePath.startsWith(expectedPrefix) ||
      attachment.storagePath.includes('..') ||
      attachment.storagePath.split('/').length !== 3
    ) {
      throw new BadRequestException('Attachment path is invalid.');
    }

    return {
      storagePath: attachment.storagePath,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      ...(attachment.fileName ? { fileName: attachment.fileName.trim().slice(0, 120) } : {}),
    };
  });
}
