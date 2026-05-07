import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { CreateServerDto, UpdateServerDto } from './dto';
import { ServersService } from './servers.service';

@Controller('servers')
export class ServersController {
  constructor(
    private readonly serversService: ServersService,
    private readonly eventsPublisher: MessageEventsPublisher,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.serversService.listServers(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateServerDto) {
    return this.serversService.createServer(user, body);
  }

  @Patch(':serverId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() body: UpdateServerDto,
  ) {
    return this.serversService.updateServer(user, serverId, body);
  }

  @Delete(':serverId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    const result = await this.serversService.removeMember(user, serverId, userId);
    await this.eventsPublisher.publishMemberRemoved(result);
  }
}
