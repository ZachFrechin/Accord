import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { ServerToClientEvent, type ChannelId, type UserId } from '@discord2/shared';
import { RoomService } from '../rooms/room.service';
import type { AuthenticatedSocket } from '../types/authenticated-socket';

@Injectable()
export class VoicePresenceService {
  constructor(private readonly roomService: RoomService) {}

  async publishVoicePresence(server: Server, channelId: ChannelId): Promise<void> {
    const userIds = await this.listVoiceUserIds(server, channelId);
    this.roomService.emitToVoice(server, channelId, ServerToClientEvent.VoicePresenceUpdated, {
      channelId,
      userIds,
    });
  }

  async listVoiceUserIds(server: Server, channelId: ChannelId): Promise<UserId[]> {
    const sockets = await server.in(this.roomService.voiceRoomName(channelId)).fetchSockets();
    const userIds = new Set<UserId>();

    for (const socket of sockets) {
      const data = socket.data as AuthenticatedSocket['data'];
      if (data.user?.id && data.voiceChannelId === channelId) {
        userIds.add(data.user.id);
      }
    }

    return [...userIds];
  }
}
