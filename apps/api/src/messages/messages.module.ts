import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ChannelsModule } from '../channels/channels.module';
import { ServersModule } from '../servers/servers.module';
import { UsersModule } from '../users/users.module';
import { MessageEventsPublisher } from './message-events.publisher';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [ChannelsModule, ServersModule, UsersModule],
  controllers: [MessagesController],
  providers: [supabaseProvider, MessageEventsPublisher, MessagesService],
})
export class MessagesModule {}
