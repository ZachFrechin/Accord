import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateMessageDto, ToggleMessageReactionDto, UpdateMessageDto } from './dto';
import { MessagesService } from './messages.service';

@Controller()
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get('channels/:channelId/messages')
  list(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const options: { limit?: number; before?: string } = {};
    if (limit !== undefined) {
      const parsed = Number(limit);
      if (Number.isFinite(parsed)) options.limit = parsed;
    }
    if (before) options.before = before;
    return this.messagesService.listMessages(user, channelId, options);
  }

  @Post('channels/:channelId/messages')
  create(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Body() body: CreateMessageDto,
  ) {
    return this.messagesService.createMessage(user, channelId, body);
  }

  @Get('messages/:messageId/attachments/:attachmentId/url')
  getAttachmentUrl(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.messagesService.getAttachmentUrl(user, messageId, attachmentId);
  }

  @Delete('messages/:messageId')
  delete(@CurrentUser() user: AuthUser, @Param('messageId') messageId: string) {
    return this.messagesService.deleteMessage(user, messageId);
  }

  @Patch('messages/:messageId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Body() body: UpdateMessageDto,
  ) {
    return this.messagesService.updateMessage(user, messageId, body);
  }

  @Post('messages/:messageId/reactions')
  toggleReaction(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Body() body: ToggleMessageReactionDto,
  ) {
    return this.messagesService.toggleReaction(user, messageId, body);
  }
}
