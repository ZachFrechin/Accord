import { create } from 'zustand';
import type { ChannelId, UserId } from '@discord2/shared';
import { isThemeName, type ThemeName } from '../lib/themes';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';
const VOICE_PROCESSING_VERSION = 2;

export interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  inputVolume: number;
  outputVolume: number;
  enableRnnoise: boolean;
  noiseGateThreshold: number;
  enableEchoCancellation: boolean;
  enableNoiseSuppression: boolean;
  enableAutoGainControl: boolean;
}

function getDefaultVoiceSettings(): VoiceSettings {
  return {
    inputDeviceId: null,
    outputDeviceId: null,
    inputVolume: 100,
    outputVolume: 100,
    enableRnnoise: true,
    noiseGateThreshold: 42,
    enableEchoCancellation: true,
    enableNoiseSuppression: true,
    enableAutoGainControl: false,
  };
}

function parseVoiceSettings(raw: string | null): VoiceSettings {
  const defaults = getDefaultVoiceSettings();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return defaults;
    const p = parsed as Record<string, unknown>;
    const storedProcessingVersion =
      typeof p.voiceProcessingVersion === 'number' ? p.voiceProcessingVersion : 1;
    const storedGateThreshold =
      typeof p.noiseGateThreshold === 'number'
        ? clamp(p.noiseGateThreshold, 0, 100)
        : defaults.noiseGateThreshold;
    return {
      inputDeviceId: typeof p.inputDeviceId === 'string' ? p.inputDeviceId : defaults.inputDeviceId,
      outputDeviceId:
        typeof p.outputDeviceId === 'string' ? p.outputDeviceId : defaults.outputDeviceId,
      inputVolume:
        typeof p.inputVolume === 'number' ? clamp(p.inputVolume, 0, 200) : defaults.inputVolume,
      outputVolume:
        typeof p.outputVolume === 'number' ? clamp(p.outputVolume, 0, 200) : defaults.outputVolume,
      enableRnnoise:
        typeof p.enableRnnoise === 'boolean' ? p.enableRnnoise : defaults.enableRnnoise,
      noiseGateThreshold:
        storedProcessingVersion >= VOICE_PROCESSING_VERSION
          ? storedGateThreshold
          : Math.max(storedGateThreshold, defaults.noiseGateThreshold),
      enableEchoCancellation:
        typeof p.enableEchoCancellation === 'boolean'
          ? p.enableEchoCancellation
          : defaults.enableEchoCancellation,
      enableNoiseSuppression:
        typeof p.enableNoiseSuppression === 'boolean'
          ? p.enableNoiseSuppression
          : defaults.enableNoiseSuppression,
      enableAutoGainControl:
        storedProcessingVersion >= VOICE_PROCESSING_VERSION &&
        typeof p.enableAutoGainControl === 'boolean'
          ? p.enableAutoGainControl
          : defaults.enableAutoGainControl,
    };
  } catch {
    return defaults;
  }
}

function getInitialVoiceSettings(): VoiceSettings {
  const stored =
    typeof window !== 'undefined' ? localStorage.getItem('discord2-voice-settings') : null;
  return parseVoiceSettings(stored);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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
  voiceSettings: VoiceSettings;
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
  setVoiceSettings: (patch: Partial<VoiceSettings>) => void;
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
  voiceSettings: getInitialVoiceSettings(),
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
  setVoiceSettings: (patch) =>
    set((state) => {
      const next = { ...state.voiceSettings, ...patch };
      localStorage.setItem(
        'discord2-voice-settings',
        JSON.stringify({ ...next, voiceProcessingVersion: VOICE_PROCESSING_VERSION }),
      );
      return { voiceSettings: next };
    }),
}));
