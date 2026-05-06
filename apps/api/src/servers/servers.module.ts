import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  controllers: [ServersController],
  providers: [supabaseProvider, ServersService],
  exports: [ServersService],
})
export class ServersModule {}
