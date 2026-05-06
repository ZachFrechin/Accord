import { create } from 'zustand';

interface UiState {
  activeServerId: string | null;
  activeChannelId: string | null;
  realtimeStatus: 'disconnected' | 'connecting' | 'connected';
  setActiveServerId: (serverId: string | null) => void;
  setActiveChannelId: (channelId: string | null) => void;
  setRealtimeStatus: (status: UiState['realtimeStatus']) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeServerId: null,
  activeChannelId: null,
  realtimeStatus: 'disconnected',
  setActiveServerId: (activeServerId) => set({ activeServerId, activeChannelId: null }),
  setActiveChannelId: (activeChannelId) => set({ activeChannelId }),
  setRealtimeStatus: (realtimeStatus) => set({ realtimeStatus }),
}));
