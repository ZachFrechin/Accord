import type { Socket } from 'socket.io';
import type { AuthUser } from '@discord2/shared';

export interface AuthenticatedSocket extends Socket {
  data: {
    user?: AuthUser;
    voiceChannelId?: string | undefined;
  };
}
