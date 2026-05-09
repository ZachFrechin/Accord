import { io, type Socket } from 'socket.io-client';
import type { InstanceConfig } from '@discord2/shared';

export type AccessTokenGetter = () => string;

export function createRealtimeSocket(
  getAccessToken: AccessTokenGetter,
  instance: InstanceConfig,
): Socket {
  return io(instance.gatewayUrl, {
    autoConnect: false,
    forceNew: true,
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 20_000,
    auth: (cb) => cb({ token: `Bearer ${getAccessToken()}` }),
  });
}
