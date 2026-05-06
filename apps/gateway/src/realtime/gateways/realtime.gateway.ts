import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server } from 'socket.io';
import { loadServerEnv, parseCorsOrigins } from '@discord2/config';
import {
  ClientToServerEvent,
  ServerToClientEvent,
  type ChannelJoinPayload,
  type PresenceUpdatePayload,
  type TypingPayload,
  type VoiceJoinPayload,
} from '@discord2/shared';
import { RedisIoAdapterService } from '../adapters/redis-io-adapter.service';
import { WsAuthService } from '../auth/ws-auth.service';
import { PresenceService } from '../presence/presence.service';
import { RoomService } from '../rooms/room.service';
import type { AuthenticatedSocket } from '../types/authenticated-socket';

const env = loadServerEnv();

@WebSocketGateway({
  cors: {
    origin: parseCorsOrigins(env.GATEWAY_CORS_ORIGINS),
    credentials: false,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly redisAdapter: RedisIoAdapterService,
    private readonly authService: WsAuthService,
    private readonly presenceService: PresenceService,
    private readonly roomService: RoomService,
  ) {}

  afterInit(server: Server): void {
    this.redisAdapter.attach(server);
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const user = await this.authService.authenticateSocket(client);
      this.roomService.joinUserRoom(client, user.id);
      this.presenceService.publishOnline(this.server, user);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    const user = client.data.user;
    if (!user) {
      return;
    }

    this.presenceService.publishOffline(this.server, user);
  }

  @SubscribeMessage(ClientToServerEvent.ChannelJoin)
  joinChannel(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ChannelJoinPayload,
  ): void {
    this.authService.requireUser(client);
    this.roomService.joinChannel(client, payload.channelId);
  }

  @SubscribeMessage(ClientToServerEvent.ChannelLeave)
  leaveChannel(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ChannelJoinPayload,
  ): void {
    this.authService.requireUser(client);
    this.roomService.leaveChannel(client, payload.channelId);
  }

  @SubscribeMessage(ClientToServerEvent.TypingStart)
  typingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: TypingPayload,
  ): void {
    const user = this.authService.requireUser(client);
    this.roomService.emitToChannel(client, payload.channelId, ServerToClientEvent.TypingStarted, {
      channelId: payload.channelId,
      userId: user.id,
    });
  }

  @SubscribeMessage(ClientToServerEvent.TypingStop)
  typingStop(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: TypingPayload,
  ): void {
    const user = this.authService.requireUser(client);
    this.roomService.emitToChannel(client, payload.channelId, ServerToClientEvent.TypingStopped, {
      channelId: payload.channelId,
      userId: user.id,
    });
  }

  @SubscribeMessage(ClientToServerEvent.PresenceUpdate)
  presenceUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: PresenceUpdatePayload,
  ): void {
    const user = this.authService.requireUser(client);
    this.presenceService.publish(this.server, user, payload.status);
  }

  @SubscribeMessage(ClientToServerEvent.VoiceJoin)
  voiceJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: VoiceJoinPayload,
  ): void {
    const user = this.authService.requireUser(client);
    this.roomService.joinVoice(client, payload.channelId);
    this.roomService.emitToVoice(
      this.server,
      payload.channelId,
      ServerToClientEvent.VoicePresenceUpdated,
      {
        channelId: payload.channelId,
        userIds: [user.id],
      },
    );
  }

  @SubscribeMessage(ClientToServerEvent.VoiceLeave)
  voiceLeave(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: VoiceJoinPayload,
  ): void {
    this.authService.requireUser(client);
    this.roomService.leaveVoice(client, payload.channelId);
    this.roomService.emitToVoice(
      this.server,
      payload.channelId,
      ServerToClientEvent.VoicePresenceUpdated,
      {
        channelId: payload.channelId,
        userIds: [],
      },
    );
  }
}
