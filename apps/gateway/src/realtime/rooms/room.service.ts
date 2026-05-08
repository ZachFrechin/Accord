import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { ChannelId, UserId } from '@discord2/shared';
import type { AuthenticatedSocket } from '../types/authenticated-socket';

@Injectable()
export class RoomService {
  async joinUserRoom(client: AuthenticatedSocket, userId: UserId): Promise<void> {
    await client.join(this.userRoom(userId));
  }

  async joinChannel(client: AuthenticatedSocket, channelId: ChannelId): Promise<void> {
    await client.join(this.channelRoom(channelId));
  }

  async leaveChannel(client: AuthenticatedSocket, channelId: ChannelId): Promise<void> {
    await client.leave(this.channelRoom(channelId));
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

  emitToUserFromServer<TPayload>(
    server: Server,
    userId: UserId,
    eventName: string,
    payload: TPayload,
  ): void {
    server.to(this.userRoom(userId)).emit(eventName, payload);
  }

  async joinVoice(client: AuthenticatedSocket, channelId: ChannelId): Promise<void> {
    client.data.voiceChannelId = channelId;
    await client.join(this.voiceRoom(channelId));
  }

  async leaveVoice(client: AuthenticatedSocket, channelId: ChannelId): Promise<void> {
    client.data.voiceChannelId = undefined;
    await client.leave(this.voiceRoom(channelId));
  }

  emitToVoice<TPayload>(
    server: Server,
    channelId: ChannelId,
    eventName: string,
    payload: TPayload,
  ): void {
    server.to(this.voiceRoomName(channelId)).emit(eventName, payload);
  }

  voiceRoomName(channelId: ChannelId): string {
    return `voice:${channelId}`;
  }

  userRoom(userId: UserId): string {
    return `user:${userId}`;
  }

  private channelRoom(channelId: ChannelId): string {
    return `channel:${channelId}`;
  }

  private voiceRoom(channelId: ChannelId): string {
    return this.voiceRoomName(channelId);
  }
}
