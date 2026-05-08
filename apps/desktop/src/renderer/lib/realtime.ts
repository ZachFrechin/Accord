import { io, type Socket } from 'socket.io-client';
import type { InstanceConfig } from '@discord2/shared';

export function createRealtimeSocket(accessToken: string, instance: InstanceConfig): Socket {
  return io(instance.gatewayUrl, {
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    auth: {
      token: `Bearer ${accessToken}`,
    },
  });
}
