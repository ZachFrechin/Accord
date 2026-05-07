import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  controllers: [ServersController],
  providers: [supabaseProvider, ServersService, MessageEventsPublisher],
  exports: [ServersService],
})
export class ServersModule {}
