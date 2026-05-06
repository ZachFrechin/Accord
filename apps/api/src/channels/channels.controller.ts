import { Controller, Get, Param } from '@nestjs/common';

@Controller('servers/:serverId/channels')
export class ChannelsController {
  @Get()
  list(@Param('serverId') serverId: string): { serverId: string; items: [] } {
    return { serverId, items: [] };
  }
}
