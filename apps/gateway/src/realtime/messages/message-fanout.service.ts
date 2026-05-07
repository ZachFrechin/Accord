import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { loadServerEnv } from '@discord2/config';
import {
  InternalRealtimeEvent,
  ServerToClientEvent,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
} from '@discord2/shared';
import { RoomService } from '../rooms/room.service';

@Injectable()
export class MessageFanoutService implements OnApplicationShutdown {
  private readonly logger = new Logger(MessageFanoutService.name);
  private readonly env = loadServerEnv();
  private redis: Redis | null = null;

  constructor(private readonly roomService: RoomService) {}

  subscribe(server: Server): void {
    if (!this.env.REDIS_URL) {
      this.logger.log('Message fanout disabled because REDIS_URL is not set.');
      return;
    }

    this.redis = new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });

    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis message subscriber error: ${error.message || 'Unknown Redis error'}`);
    });

    this.redis.on('message', (channel, payload) => {
      if (channel === InternalRealtimeEvent.MessageCreated) {
        this.forwardMessageCreated(server, payload);
      } else if (channel === InternalRealtimeEvent.MessageDeleted) {
        this.forwardMessageDeleted(server, payload);
      } else if (channel === InternalRealtimeEvent.MemberRemoved) {
        this.forwardMemberRemoved(server, payload);
      }
    });

    void this.redis.subscribe(
      InternalRealtimeEvent.MessageCreated,
      InternalRealtimeEvent.MessageDeleted,
      InternalRealtimeEvent.MemberRemoved,
    );
    this.logger.log('Subscribed to message.created, message.deleted and member.removed Redis events.');
  }

  private forwardMessageDeleted(server: Server, payload: string): void {
    try {
      const event = JSON.parse(payload) as MessageDeletedEvent;
      this.roomService.emitToChannelFromServer(
        server,
        event.channelId,
        ServerToClientEvent.MessageDeleted,
        event,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      this.logger.warn(`Invalid message.deleted payload: ${message}`);
    }
  }

  onApplicationShutdown(): void {
    this.redis?.disconnect();
  }

  private forwardMessageCreated(server: Server, payload: string): void {
    try {
      const event = JSON.parse(payload) as MessageCreatedEvent;
      this.roomService.emitToChannelFromServer(
        server,
        event.channelId,
        ServerToClientEvent.MessageCreated,
        event,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      this.logger.warn(`Invalid message.created payload: ${message}`);
    }
  }

  private forwardMemberRemoved(server: Server, payload: string): void {
    try {
      const event = JSON.parse(payload) as MemberRemovedEvent;
      this.roomService.emitToUserFromServer(
        server,
        event.userId,
        ServerToClientEvent.MemberRemoved,
        event,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      this.logger.warn(`Invalid member.removed payload: ${message}`);
    }
  }
}
