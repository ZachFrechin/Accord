import { Module } from '@nestjs/common';
import { RedisIoAdapterService } from './adapters/redis-io-adapter.service';
import { SupabaseWsAuthService } from './auth/supabase-ws-auth.service';
import { WsAuthService } from './auth/ws-auth.service';
import { RealtimeGateway } from './gateways/realtime.gateway';
import { PresenceService } from './presence/presence.service';
import { RoomService } from './rooms/room.service';

@Module({
  providers: [
    RedisIoAdapterService,
    SupabaseWsAuthService,
    WsAuthService,
    PresenceService,
    RoomService,
    RealtimeGateway,
  ],
})
export class RealtimeModule {}
