import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ChannelsModule } from '../channels/channels.module';
import { RolesModule } from '../roles/roles.module';
import { ServersModule } from '../servers/servers.module';
import { UsersModule } from '../users/users.module';
import { EmbedsService } from './embeds.service';
import { MessageEventsPublisher } from './message-events.publisher';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [ChannelsModule, ServersModule, UsersModule, RolesModule],
  controllers: [MessagesController],
  providers: [supabaseProvider, EmbedsService, MessageEventsPublisher, MessagesService],
})
export class MessagesModule {}
