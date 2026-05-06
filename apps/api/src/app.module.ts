import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { CryptoKeysModule } from './crypto-keys/crypto-keys.module';
import { FilesModule } from './files/files.module';
import { HealthModule } from './health/health.module';
import { InvitesModule } from './invites/invites.module';
import { MessagesModule } from './messages/messages.module';
import { ServersModule } from './servers/servers.module';
import { UsersModule } from './users/users.module';
import { VoiceModule } from './voice/voice.module';
import { SupabaseAuthGuard } from './auth/supabase-auth.guard';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    AuthModule,
    HealthModule,
    UsersModule,
    ServersModule,
    ChannelsModule,
    MessagesModule,
    InvitesModule,
    FilesModule,
    VoiceModule,
    CryptoKeysModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
