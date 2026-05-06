import { create } from 'zustand';
import type { ChannelId, UserId } from '@discord2/shared';
import { isThemeName, type ThemeName } from '../lib/themes';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

interface UiState {
  activeServerId: string | null;
  activeChannelId: string | null;
  activeVoiceChannelId: ChannelId | null;
  realtimeStatus: 'disconnected' | 'connecting' | 'connected';
  voiceStatus: VoiceStatus;
  voiceError: string | null;
  voiceParticipantIds: UserId[];
  voiceParticipantsByChannel: Record<ChannelId, UserId[]>;
  isMuted: boolean;
  isDeafened: boolean;
  theme: ThemeName;
  setActiveServerId: (serverId: string | null) => void;
  setActiveChannelId: (channelId: string | null) => void;
  setRealtimeStatus: (status: UiState['realtimeStatus']) => void;
  setVoiceState: (
    patch: Partial<
      Pick<
        UiState,
        | 'activeVoiceChannelId'
        | 'voiceStatus'
        | 'voiceError'
        | 'voiceParticipantIds'
        | 'voiceParticipantsByChannel'
        | 'isMuted'
        | 'isDeafened'
      >
    >,
  ) => void;
  setVoiceParticipantIds: (channelId: ChannelId, userIds: UserId[]) => void;
  setTheme: (theme: ThemeName) => void;
}

function getInitialTheme(): ThemeName {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('discord2-theme') : null;
  if (isThemeName(stored)) return stored;
  return 'dark';
}

export const useUiStore = create<UiState>((set) => ({
  activeServerId: null,
  activeChannelId: null,
  activeVoiceChannelId: null,
  realtimeStatus: 'disconnected',
  voiceStatus: 'idle',
  voiceError: null,
  voiceParticipantIds: [],
  voiceParticipantsByChannel: {},
  isMuted: false,
  isDeafened: false,
  theme: getInitialTheme(),
  setActiveServerId: (activeServerId) => set({ activeServerId, activeChannelId: null }),
  setActiveChannelId: (activeChannelId) => set({ activeChannelId }),
  setRealtimeStatus: (realtimeStatus) => set({ realtimeStatus }),
  setVoiceState: (patch) => set(patch),
  setVoiceParticipantIds: (channelId, userIds) =>
    set((state) => {
      const next = {
        ...state.voiceParticipantsByChannel,
        [channelId]: userIds,
      };
      if (state.activeVoiceChannelId === channelId) {
        return { voiceParticipantIds: userIds, voiceParticipantsByChannel: next };
      }
      return { voiceParticipantsByChannel: next };
    }),
  setTheme: (theme) =>
    set(() => {
      localStorage.setItem('discord2-theme', theme);
      return { theme };
    }),
}));
