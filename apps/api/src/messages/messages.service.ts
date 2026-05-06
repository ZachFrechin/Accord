import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository, MessagesRepository } from '@discord2/db';
import { normalizeMessageInput } from '@discord2/domain';
import { ChannelType, type AuthUser, type ChannelId, type MessageRecord } from '@discord2/shared';
import { RolesService } from '../roles/roles.service';
import { ServersService } from '../servers/servers.service';
import { UsersService } from '../users/users.service';
import type { CreateMessageDto } from './dto';
import { MessageEventsPublisher } from './message-events.publisher';

@Injectable()
export class MessagesService {
  private readonly repository: MessagesRepository;
  private readonly channelsRepository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly serversService: ServersService,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
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
    const normalized = normalizeMessageInput({
      privacy: dto.privacy,
      content: dto.content ?? null,
      encrypted: dto.encrypted ?? null,
    });

    const message = await this.repository.insert({
      channelId,
      authorId: user.id,
      privacy: normalized.privacy,
      content: normalized.content ?? null,
      encrypted: normalized.encrypted ?? null,
    });
    const mentions = await this.rolesService.resolveMentions(serverId, normalized.content ?? null);
    await this.rolesService.insertMessageMentions(message.id, mentions);

    const profile = await this.usersService.me(user);
    const messageWithAuthor: MessageRecord = {
      ...message,
      mentions,
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
    const mentionsByMessage = await this.rolesService.listMentionsForMessages(
      messages.map((message) => message.id),
    );
    return messages.map((message) => ({
      ...message,
      mentions: mentionsByMessage.get(message.id) ?? [],
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
