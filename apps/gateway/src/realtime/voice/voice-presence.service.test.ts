import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import { RoomService } from '../rooms/room.service';
import { VoicePresenceService } from './voice-presence.service';

describe('VoicePresenceService', () => {
  it('lists unique users currently attached to a voice room', async () => {
    const fetchSockets = vi
      .fn()
      .mockResolvedValue([
        { data: { user: { id: 'user-1' }, voiceChannelId: 'channel-1' } },
        { data: { user: { id: 'user-1' }, voiceChannelId: 'channel-1' } },
        { data: { user: { id: 'user-2' }, voiceChannelId: 'channel-1' } },
        { data: { user: { id: 'user-3' }, voiceChannelId: 'channel-2' } },
        { data: {} },
      ]);
    const server = {
      in: vi.fn().mockReturnValue({ fetchSockets }),
    } as unknown as Server;
    const service = new VoicePresenceService(new RoomService());

    await expect(service.listVoiceUserIds(server, 'channel-1')).resolves.toEqual([
      'user-1',
      'user-2',
    ]);
    expect(server.in).toHaveBeenCalledWith('voice:channel-1');
  });
});
