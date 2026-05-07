import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateMessageDto } from './dto';
import { MessagesService } from './messages.service';

@Controller()
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get('channels/:channelId/messages')
  list(@CurrentUser() user: AuthUser, @Param('channelId') channelId: string) {
    return this.messagesService.listMessages(user, channelId);
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
}
