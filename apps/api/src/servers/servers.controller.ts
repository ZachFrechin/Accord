import { Controller, Get } from '@nestjs/common';

@Controller('servers')
export class ServersController {
  @Get()
  list(): { items: [] } {
    return { items: [] };
  }
}
