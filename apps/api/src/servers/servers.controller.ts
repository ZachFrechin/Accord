import { Body, Controller, Get, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateServerDto } from './dto';
import { ServersService } from './servers.service';

@Controller('servers')
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.serversService.listServers(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateServerDto) {
    return this.serversService.createServer(user, body);
  }
}
