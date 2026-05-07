import { Module } from '@nestjs/common';
import { supabaseProvider } from '../common/supabase-provider';
import { ServersModule } from '../servers/servers.module';
import { CryptoKeysController } from './crypto-keys.controller';
import { CryptoKeysService } from './crypto-keys.service';

@Module({
  imports: [ServersModule],
  controllers: [CryptoKeysController],
  providers: [supabaseProvider, CryptoKeysService],
})
export class CryptoKeysModule {}
