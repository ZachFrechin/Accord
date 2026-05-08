import { io, type Socket } from 'socket.io-client';
import type { InstanceConfig } from '@discord2/shared';

export function createRealtimeSocket(accessToken: string, instance: InstanceConfig): Socket {
  return io(instance.gatewayUrl, {
    autoConnect: false,
    forceNew: true,
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    timeout: 10_000,
    auth: {
      token: `Bearer ${accessToken}`,
    },
  });
}
