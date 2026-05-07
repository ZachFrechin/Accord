import { io, type Socket } from 'socket.io-client';
import type { InstanceConfig } from '@discord2/shared';

export function createRealtimeSocket(accessToken: string, instance: InstanceConfig): Socket {
  return io(instance.gatewayUrl, {
    transports: ['websocket', 'polling'],
    auth: {
      token: `Bearer ${accessToken}`,
    },
  });
}
