import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { PermissionsModule } from '../permissions/permissions.module';
import { ServersModule } from '../servers/servers.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [ServersModule, PermissionsModule],
  controllers: [VoiceController],
  providers: [supabaseProvider, VoiceService],
})
export class VoiceModule {}
