import { create } from 'zustand';

type Theme = 'dark' | 'light';

interface UiState {
  activeServerId: string | null;
  activeChannelId: string | null;
  realtimeStatus: 'disconnected' | 'connecting' | 'connected';
  theme: Theme;
  setActiveServerId: (serverId: string | null) => void;
  setActiveChannelId: (channelId: string | null) => void;
  setRealtimeStatus: (status: UiState['realtimeStatus']) => void;
  toggleTheme: () => void;
}

function getInitialTheme(): Theme {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('discord2-theme') : null;
  if (stored === 'light' || stored === 'dark') return stored;
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
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('discord2-theme', next);
      return { theme: next };
    }),
}));
