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
  Permission,
  type AuthUser,
  type ChannelId,
  type CreateAttachmentInput,
  type MessageRecord,
  type MessageReaction,
  type SignedAttachmentUrl,
} from '@discord2/shared';
import { RolesService } from '../roles/roles.service';
import { ServersService } from '../servers/servers.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { CreateMessageDto, ToggleMessageReactionDto, UpdateMessageDto } from './dto';
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
  'application/octet-stream',
]);

@Injectable()
export class MessagesService {
  private readonly repository: MessagesRepository;
  private readonly channelsRepository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly serversService: ServersService,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
    private readonly permissionsService: PermissionsService,
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
    await this.requireChannelPermission(user, channelId, Permission.SendMessages);
    const attachments = validateMessageAttachments(user.id, channelId, dto.attachments ?? []);
    if (attachments.length > 0) {
      await this.requireChannelPermission(user, channelId, Permission.AttachFiles);
    }
    const normalized = normalizeMessageInput({
      privacy: dto.privacy,
      content: null,
      encrypted: dto.encrypted,
      attachments,
    });

    const message = await this.repository.insert({
      channelId,
      authorId: user.id,
      privacy: normalized.privacy,
      content: null,
      encrypted: normalized.encrypted ?? null,
    });
    const storedAttachments = await this.repository.insertAttachments(message.id, attachments);

    const profile = await this.usersService.me(user);
    const messageWithAuthor: MessageRecord = {
      ...message,
      mentions: [],
      attachments: storedAttachments,
      embeds: [],
      reactions: [],
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

  async getAttachmentUrl(
    user: AuthUser,
    messageId: string,
    attachmentId: string,
  ): Promise<SignedAttachmentUrl> {
    const attachment = await this.repository.findAttachment(messageId, attachmentId);
    if (!attachment) {
      throw new NotFoundException('Attachment not found.');
    }

    await this.requireChannelPermission(user, attachment.channelId, Permission.ViewChannel);

    if (!attachment.isE2ee) {
      throw new ForbiddenException('Signed URLs are only available for encrypted attachments.');
    }

    const { data, error } = await this.supabase.storage
      .from('message-media')
      .createSignedUrl(attachment.storagePath, 3600);

    if (error || !data) {
      throw new Error('Failed to generate signed URL.');
    }

    return {
      url: data.signedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
  }

  async listMessages(user: AuthUser, channelId: ChannelId): Promise<MessageRecord[]> {
    await this.requireChannelPermission(user, channelId, Permission.ViewChannel);
    const messages = await this.repository.listByChannel(channelId);
    const messageIds = messages.map((message) => message.id);
    const [mentionsByMessage, attachmentsByMessage, embedsByMessage, reactionsByMessage] =
      await Promise.all([
        this.rolesService.listMentionsForMessages(messageIds),
        this.repository.listAttachmentsForMessages(messageIds),
        this.repository.listEmbedsForMessages(messageIds),
        this.repository.listReactionsForMessages(messageIds, user.id),
      ]);
    return messages.map((message) => ({
      ...message,
      mentions: mentionsByMessage.get(message.id) ?? [],
      attachments: attachmentsByMessage.get(message.id) ?? [],
      embeds: embedsByMessage.get(message.id) ?? [],
      reactions: reactionsByMessage.get(message.id) ?? [],
    }));
  }

  async updateMessage(
    user: AuthUser,
    messageId: string,
    dto: UpdateMessageDto,
  ): Promise<MessageRecord> {
    const message = await this.repository.findById(messageId);
    if (!message) {
      throw new NotFoundException('Message not found.');
    }

    if (message.authorId !== user.id) {
      throw new ForbiddenException('Only the message author can edit this message.');
    }

    await this.requireChannelPermission(user, message.channelId, Permission.ViewChannel);
    const updated = await this.repository.updateEncrypted(messageId, dto.encrypted);
    const enriched = await this.enrichMessageForUser(updated, user);

    await this.eventsPublisher.publishMessageUpdated({
      channelId: updated.channelId,
      message: enriched,
    });

    return enriched;
  }

  async toggleReaction(
    user: AuthUser,
    messageId: string,
    dto: ToggleMessageReactionDto,
  ): Promise<{ messageId: string; channelId: string; reactions: MessageReaction[] }> {
    const message = await this.repository.findById(messageId);
    if (!message) {
      throw new NotFoundException('Message not found.');
    }

    await this.requireChannelPermission(user, message.channelId, Permission.ViewChannel);
    const reactions = await this.repository.toggleReaction(
      messageId,
      user.id,
      normalizeEmoji(dto.emoji),
    );
    const event = {
      messageId,
      channelId: message.channelId,
      userId: user.id,
      reactions,
    };

    await this.eventsPublisher.publishMessageReactionUpdated(event);
    return event;
  }

  async deleteMessage(
    user: AuthUser,
    messageId: string,
  ): Promise<{ messageId: string; channelId: string }> {
    const message = await this.repository.findById(messageId);
    if (!message) {
      throw new NotFoundException('Message not found.');
    }

    if (message.authorId !== user.id) {
      await this.requireChannelPermission(user, message.channelId, Permission.ManageMessages);
    } else {
      await this.requireChannelPermission(user, message.channelId, Permission.ViewChannel);
    }

    await this.repository.delete(messageId);
    await this.eventsPublisher.publishMessageDeleted({
      channelId: message.channelId,
      messageId,
    });

    return { messageId, channelId: message.channelId };
  }

  private async enrichMessageForUser(
    message: MessageRecord,
    user: AuthUser,
  ): Promise<MessageRecord> {
    const [profile, mentionsByMessage, attachmentsByMessage, embedsByMessage, reactionsByMessage] =
      await Promise.all([
        this.usersService.me(user),
        this.rolesService.listMentionsForMessages([message.id]),
        this.repository.listAttachmentsForMessages([message.id]),
        this.repository.listEmbedsForMessages([message.id]),
        this.repository.listReactionsForMessages([message.id], user.id),
      ]);

    return {
      ...message,
      mentions: mentionsByMessage.get(message.id) ?? [],
      attachments: attachmentsByMessage.get(message.id) ?? [],
      embeds: embedsByMessage.get(message.id) ?? [],
      reactions: reactionsByMessage.get(message.id) ?? [],
      author: {
        id: profile.id,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      },
    };
  }

  private async requireChannelPermission(
    user: AuthUser,
    channelId: ChannelId,
    permission: Permission,
  ): Promise<string> {
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

    if (permission !== Permission.SendMessages) {
      await this.permissionsService.assertChannelPermission(user, channelId, permission);
      return channel.serverId;
    }

    await this.permissionsService.assertChannelPermission(user, channelId, Permission.ViewChannel);
    await this.permissionsService.assertChannelPermission(user, channelId, Permission.SendMessages);
    return channel.serverId;
  }
}

function normalizeEmoji(emoji: string): string {
  return emoji.trim().slice(0, 16);
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

    if (attachment.isE2ee && !attachment.encrypted) {
      throw new BadRequestException('Encrypted attachment metadata is required.');
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
      isE2ee: attachment.isE2ee ?? false,
      encrypted: attachment.encrypted ?? null,
      ...(attachment.isE2ee
        ? {}
        : attachment.fileName
          ? { fileName: attachment.fileName.trim().slice(0, 120) }
          : {}),
    };
  });
}
