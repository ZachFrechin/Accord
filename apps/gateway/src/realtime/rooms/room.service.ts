import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { ChannelId, UserId } from '@discord2/shared';
import type { AuthenticatedSocket } from '../types/authenticated-socket';

@Injectable()
export class RoomService {
  joinUserRoom(client: AuthenticatedSocket, userId: UserId): void {
    void client.join(this.userRoom(userId));
  }

  joinChannel(client: AuthenticatedSocket, channelId: ChannelId): void {
    void client.join(this.channelRoom(channelId));
  }

  leaveChannel(client: AuthenticatedSocket, channelId: ChannelId): void {
    void client.leave(this.channelRoom(channelId));
  }

  emitToChannel<TPayload>(
    client: AuthenticatedSocket,
    channelId: ChannelId,
    eventName: string,
    payload: TPayload,
  ): void {
    client.to(this.channelRoom(channelId)).emit(eventName, payload);
  }

  emitToChannelFromServer<TPayload>(
    server: Server,
    channelId: ChannelId,
    eventName: string,
    payload: TPayload,
  ): void {
    server.to(this.channelRoom(channelId)).emit(eventName, payload);
  }

  joinVoice(client: AuthenticatedSocket, channelId: ChannelId): void {
    client.data.voiceChannelId = channelId;
    void client.join(this.voiceRoom(channelId));
  }

  leaveVoice(client: AuthenticatedSocket, channelId: ChannelId): void {
    client.data.voiceChannelId = undefined;
    void client.leave(this.voiceRoom(channelId));
  }

  emitToVoice<TPayload>(
    server: Server,
    channelId: ChannelId,
    eventName: string,
    payload: TPayload,
  ): void {
    server.to(this.voiceRoom(channelId)).emit(eventName, payload);
  }

  private userRoom(userId: UserId): string {
    return `user:${userId}`;
  }

  private channelRoom(channelId: ChannelId): string {
    return `channel:${channelId}`;
  }

  private voiceRoom(channelId: ChannelId): string {
    return `voice:${channelId}`;
  }
}
