import { create } from 'zustand';
import { isThemeName, type ThemeName } from '../lib/themes';

interface UiState {
  activeServerId: string | null;
  activeChannelId: string | null;
  realtimeStatus: 'disconnected' | 'connecting' | 'connected';
  theme: ThemeName;
  setActiveServerId: (serverId: string | null) => void;
  setActiveChannelId: (channelId: string | null) => void;
  setRealtimeStatus: (status: UiState['realtimeStatus']) => void;
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
  realtimeStatus: 'disconnected',
  theme: getInitialTheme(),
  setActiveServerId: (activeServerId) => set({ activeServerId, activeChannelId: null }),
  setActiveChannelId: (activeChannelId) => set({ activeChannelId }),
  setRealtimeStatus: (realtimeStatus) => set({ realtimeStatus }),
  setTheme: (theme) =>
    set(() => {
      localStorage.setItem('discord2-theme', theme);
      return { theme };
    }),
}));
