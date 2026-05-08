import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { BanServerMemberDto, CreateServerDto, UpdateServerDto } from './dto';
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

  @Get(':serverId/bans')
  listBans(@CurrentUser() user: AuthUser, @Param('serverId') serverId: string) {
    return this.serversService.listBans(user, serverId);
  }

  @Post(':serverId/bans')
  async banMember(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() body: BanServerMemberDto,
  ) {
    const ban = await this.serversService.banMember(user, serverId, body);
    await this.eventsPublisher.publishMemberRemoved({ serverId, userId: body.userId });
    return ban;
  }

  @Delete(':serverId/bans/:userId')
  unbanMember(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Param('userId') userId: string,
  ) {
    return this.serversService.unbanMember(user, serverId, userId);
  }
}
