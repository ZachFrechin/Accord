import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { loadServerEnv } from '@discord2/config';

@Injectable()
export class RedisIoAdapterService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisIoAdapterService.name);
  private readonly env = loadServerEnv();
  private clients: Redis[] = [];

  attach(server: Server): void {
    if (!this.env.REDIS_URL) {
      this.logger.log('Redis adapter disabled because REDIS_URL is not set.');
      return;
    }

    const pubClient = this.createClient('pub');
    const subClient = pubClient.duplicate();
    this.registerClient(subClient, 'sub');

    server.adapter(createAdapter(pubClient, subClient));
    this.logger.log(`Socket.IO Redis adapter attached to ${redactRedisUrl(this.env.REDIS_URL)}.`);
  }

  onApplicationShutdown(): void {
    for (const client of this.clients) {
      client.disconnect();
    }
  }

  private createClient(role: 'pub' | 'sub'): Redis {
    const client = new Redis(this.env.REDIS_URL!, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });

    return this.registerClient(client, role);
  }

  private registerClient(client: Redis, role: 'pub' | 'sub'): Redis {
    this.clients.push(client);

    client.on('connect', () => {
      this.logger.log(`Redis ${role} client connected.`);
    });

    client.on('ready', () => {
      this.logger.log(`Redis ${role} client ready.`);
    });

    client.on('error', (error: Error & { code?: string; address?: string; port?: number }) => {
      this.logger.warn(`Redis ${role} client error: ${formatRedisError(error)}`);
    });

    client.on('close', () => {
      this.logger.warn(`Redis ${role} client connection closed.`);
    });

    client.on('reconnecting', () => {
      this.logger.warn(`Redis ${role} client reconnecting.`);
    });

    return client;
  }
}

function formatRedisError(
  error: Error & { code?: string; address?: string; port?: number },
): string {
  const details = [error.code, error.address, error.port ? String(error.port) : undefined].filter(
    Boolean,
  );

  if (error.message && details.length > 0) {
    return `${error.message} (${details.join(', ')})`;
  }

  return error.message || details.join(', ') || 'Unknown Redis connection error';
}

function redactRedisUrl(redisUrl: string): string {
  try {
    const url = new URL(redisUrl);
    if (url.password) {
      url.password = '***';
    }

    return url.toString();
  } catch {
    return '<invalid redis url>';
  }
}
