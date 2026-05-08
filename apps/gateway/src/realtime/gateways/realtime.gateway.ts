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
import { MessageFanoutService } from '../messages/message-fanout.service';
import { PresenceService } from '../presence/presence.service';
import { RoomService } from '../rooms/room.service';
import type { AuthenticatedSocket } from '../types/authenticated-socket';
import { VoiceAuthorizationService } from '../voice/voice-authorization.service';
import { VoicePresenceService } from '../voice/voice-presence.service';

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
    private readonly messageFanout: MessageFanoutService,
    private readonly presenceService: PresenceService,
    private readonly roomService: RoomService,
    private readonly voiceAuthorization: VoiceAuthorizationService,
    private readonly voicePresence: VoicePresenceService,
  ) {}

  afterInit(server: Server): void {
    this.redisAdapter.attach(server);
    this.messageFanout.subscribe(server);
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const user = await this.authService.authenticateSocket(client);
      await this.roomService.joinUserRoom(client, user.id);
      this.presenceService.publishOnline(this.server, user);
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthenticatedSocket): Promise<void> {
    const user = client.data.user;
    if (!user) {
      return;
    }

    const voiceChannelId = client.data.voiceChannelId;
    if (voiceChannelId) {
      client.data.voiceChannelId = undefined;
      await this.voicePresence.publishVoicePresence(this.server, voiceChannelId);
    }

    this.presenceService.publishOffline(this.server, user);
  }

  @SubscribeMessage(ClientToServerEvent.ChannelJoin)
  async joinChannel(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ChannelJoinPayload,
  ): Promise<void> {
    this.authService.requireUser(client);
    await this.roomService.joinChannel(client, payload.channelId);
  }

  @SubscribeMessage(ClientToServerEvent.ChannelLeave)
  async leaveChannel(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ChannelJoinPayload,
  ): Promise<void> {
    this.authService.requireUser(client);
    await this.roomService.leaveChannel(client, payload.channelId);
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
  async voiceJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: VoiceJoinPayload,
  ): Promise<void> {
    const user = this.authService.requireUser(client);
    try {
      await this.voiceAuthorization.requireVoiceAccess(user, payload.channelId);
    } catch {
      client.emit(ServerToClientEvent.Error, { message: 'Voice channel access denied.' });
      return;
    }

    const previousChannelId = client.data.voiceChannelId;
    if (previousChannelId && previousChannelId !== payload.channelId) {
      await this.roomService.leaveVoice(client, previousChannelId);
      await this.voicePresence.publishVoicePresence(this.server, previousChannelId);
    }

    await this.roomService.joinVoice(client, payload.channelId);
    await this.voicePresence.publishVoicePresence(this.server, payload.channelId);
  }

  @SubscribeMessage(ClientToServerEvent.VoiceLeave)
  async voiceLeave(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: VoiceJoinPayload,
  ): Promise<void> {
    this.authService.requireUser(client);
    if (client.data.voiceChannelId !== payload.channelId) {
      return;
    }

    await this.roomService.leaveVoice(client, payload.channelId);
    await this.voicePresence.publishVoicePresence(this.server, payload.channelId);
  }
}
