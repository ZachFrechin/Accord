import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateMessageDto } from './dto';
import { MessagesService } from './messages.service';

@Controller('channels/:channelId/messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('channelId') channelId: string) {
    return this.messagesService.listMessages(user, channelId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Body() body: CreateMessageDto,
  ) {
    return this.messagesService.createMessage(user, channelId, body);
  }
}
