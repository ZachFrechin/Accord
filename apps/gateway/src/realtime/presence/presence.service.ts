import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PresenceStatus, ServerToClientEvent, type AuthUser } from '@discord2/shared';

@Injectable()
export class PresenceService {
  publishOnline(server: Server, user: AuthUser): void {
    this.publish(server, user, PresenceStatus.Online);
  }

  publishOffline(server: Server, user: AuthUser): void {
    this.publish(server, user, PresenceStatus.Offline);
  }

  publish(server: Server, user: AuthUser, status: PresenceStatus): void {
    server.emit(ServerToClientEvent.PresenceUpdated, {
      userId: user.id,
      status,
    });
  }
}
