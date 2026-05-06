import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChannelsService } from './channels.service';
import { CreateChannelDto } from './dto';

@Controller('servers/:serverId/channels')
export class ChannelsController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('serverId') serverId: string) {
    return this.channelsService.listChannels(user, serverId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() body: CreateChannelDto,
  ) {
    return this.channelsService.createChannel(user, serverId, body);
  }
}
