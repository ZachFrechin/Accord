import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ServersModule } from '../servers/servers.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [ServersModule],
  controllers: [ChannelsController],
  providers: [supabaseProvider, ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
