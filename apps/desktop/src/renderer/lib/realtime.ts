import { io, type Socket } from 'socket.io-client';
import { env } from './env';

export function createRealtimeSocket(accessToken: string): Socket {
  return io(env.VITE_GATEWAY_URL, {
    transports: ['websocket'],
    auth: {
      token: `Bearer ${accessToken}`,
    },
  });
}
