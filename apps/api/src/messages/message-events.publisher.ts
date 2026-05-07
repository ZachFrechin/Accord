import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { loadServerEnv } from '@discord2/config';
import {
  InternalRealtimeEvent,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
} from '@discord2/shared';

@Injectable()
export class MessageEventsPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(MessageEventsPublisher.name);
  private readonly env = loadServerEnv();
  private readonly redis: Redis | null;

  constructor() {
    if (!this.env.REDIS_URL) {
      this.redis = null;
      return;
    }

    this.redis = new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });

    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis publisher error: ${error.message || 'Unknown Redis error'}`);
    });
  }

  async publishMessageCreated(event: MessageCreatedEvent): Promise<void> {
    await this.publish(InternalRealtimeEvent.MessageCreated, event);
  }

  async publishMemberRemoved(event: MemberRemovedEvent): Promise<void> {
    await this.publish(InternalRealtimeEvent.MemberRemoved, event);
  }

  private async publish(channel: string, event: unknown): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      await this.redis.publish(channel, JSON.stringify(event));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown publish error';
      this.logger.warn(`Unable to publish ${channel} event: ${message}`);
    }
  }

  onApplicationShutdown(): void {
    this.redis?.disconnect();
  }
}
