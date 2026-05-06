import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Socket } from 'socket.io-client';
import { LocalAudioTrack, LocalTrack, Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { ClientToServerEvent, type ChannelId } from '@discord2/shared';
import type { ApiClient } from '../../lib/api-client';
import { env } from '../../lib/env';
import { useUiStore } from '../../store/ui-store';
import { createProcessedAudioTrack } from './audio-processing';

interface UseVoiceRoomInput {
  api: ApiClient;
  socket: Socket | null;
}

export interface VoiceRoomControls {
  joinVoiceChannel: (channelId: ChannelId) => Promise<void>;
  leaveVoiceChannel: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  setDeafened: (deafened: boolean) => void;
}

export function useVoiceRoom({ api, socket }: UseVoiceRoomInput): VoiceRoomControls {
  const roomRef = useRef<Room | null>(null);
  const activeChannelRef = useRef<ChannelId | null>(null);
  const audioRootRef = useRef<HTMLDivElement | null>(null);
  const attachedElementsRef = useRef<Set<HTMLMediaElement>>(new Set());
  const isLeavingRef = useRef(false);
  const localTrackRef = useRef<LocalAudioTrack | null>(null);
  const disposeTrackRef = useRef<(() => void) | null>(null);

  const applyOutputSettings = (): void => {
    const { voiceSettings } = useUiStore.getState();
    const outputVolume = voiceSettings.outputVolume / 100;
    attachedElementsRef.current.forEach((element) => {
      element.volume = outputVolume;
      element.muted = useUiStore.getState().isDeafened;
      if (voiceSettings.outputDeviceId && 'setSinkId' in element) {
        try {
          void (element as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(voiceSettings.outputDeviceId);
        } catch {
          // ignore
        }
      }
    });
  };

  const applyDeafen = (deafened: boolean): void => {
    const room = roomRef.current;
    room?.remoteParticipants.forEach((participant) => participant.setVolume(deafened ? 0 : 1));
    attachedElementsRef.current.forEach((element) => {
      element.muted = deafened;
    });
  };

  const attachRemoteAudio = (track: RemoteTrack): void => {
    if (track.kind !== Track.Kind.Audio) {
      return;
    }

    const audioRoot = ensureAudioRoot(audioRootRef);
    const element = track.attach();
    element.autoplay = true;
    element.muted = useUiStore.getState().isDeafened;
    element.dataset.livekitVoice = 'true';
    attachedElementsRef.current.add(element);
    audioRoot.appendChild(element);
    applyOutputSettings();
  };

  const detachRemoteAudio = (track: RemoteTrack): void => {
    for (const element of track.detach()) {
      element.remove();
      attachedElementsRef.current.delete(element);
    }
  };

  async function cleanupRoom(stopTracks: boolean): Promise<void> {
    const room = roomRef.current;
    if (room) {
      await room.disconnect(stopTracks);
      room.removeAllListeners();
    }

    roomRef.current = null;
    attachedElementsRef.current.forEach((element) => element.remove());
    attachedElementsRef.current.clear();
    audioRootRef.current?.remove();
    audioRootRef.current = null;

    disposeTrackRef.current?.();
    disposeTrackRef.current = null;
    localTrackRef.current = null;
  }

  const leaveVoiceChannel = async (): Promise<void> => {
    const channelId = activeChannelRef.current;
    if (!channelId) {
      return;
    }

    isLeavingRef.current = true;
    useUiStore.getState().setVoiceState({ voiceStatus: 'disconnecting', voiceError: null });
    socket?.emit(ClientToServerEvent.VoiceLeave, { channelId });
    await cleanupRoom(true);
    activeChannelRef.current = null;
    isLeavingRef.current = false;
    useUiStore.getState().setVoiceState({
      activeVoiceChannelId: null,
      voiceStatus: 'idle',
      voiceParticipantIds: [],
      isMuted: false,
      isDeafened: false,
      voiceError: null,
    });
  };

  const joinVoiceChannel = async (channelId: ChannelId): Promise<void> => {
    if (
      activeChannelRef.current === channelId &&
      useUiStore.getState().voiceStatus === 'connected'
    ) {
      return;
    }

    if (activeChannelRef.current) {
      await leaveVoiceChannel();
    }

    activeChannelRef.current = channelId;
    useUiStore.getState().setVoiceState({
      activeVoiceChannelId: channelId,
      voiceStatus: 'connecting',
      voiceError: null,
      voiceParticipantIds: [],
      isMuted: false,
      isDeafened: false,
    });

    const room = new Room({
      audioCaptureDefaults: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });
    roomRef.current = room;
    room.on(RoomEvent.TrackSubscribed, attachRemoteAudio);
    room.on(RoomEvent.TrackUnsubscribed, detachRemoteAudio);
    room.on(RoomEvent.Reconnecting, () => {
      useUiStore.getState().setVoiceState({ voiceStatus: 'connecting' });
    });
    room.on(RoomEvent.Reconnected, () => {
      useUiStore.getState().setVoiceState({ voiceStatus: 'connected', voiceError: null });
    });
    room.on(RoomEvent.Disconnected, () => {
      if (isLeavingRef.current) {
        return;
      }

      activeChannelRef.current = null;
      useUiStore.getState().setVoiceState({
        activeVoiceChannelId: null,
        voiceStatus: 'error',
        voiceError: 'Connexion vocale interrompue.',
        voiceParticipantIds: [],
      });
    });

    try {
      const { token } = await api.voice.createToken(channelId);
      await room.connect(env.VITE_LIVEKIT_URL, token);
      await room.startAudio();

      const settings = useUiStore.getState().voiceSettings;
      const { track, dispose } = await createProcessedAudioTrack(settings);
      localTrackRef.current = track;
      disposeTrackRef.current = dispose;

      await room.localParticipant.publishTrack(track as LocalTrack);
      socket?.emit(ClientToServerEvent.VoiceJoin, { channelId });
      useUiStore.getState().setVoiceState({ voiceStatus: 'connected', voiceError: null });
    } catch (error) {
      await cleanupRoom(true);
      activeChannelRef.current = null;
      useUiStore.getState().setVoiceState({
        activeVoiceChannelId: null,
        voiceStatus: 'error',
        voiceError: getVoiceErrorMessage(error),
        voiceParticipantIds: [],
      });
    }
  };

  const setMuted = async (muted: boolean): Promise<void> => {
    const track = localTrackRef.current;
    if (!track) {
      return;
    }

    if (muted) {
      await track.mute();
    } else {
      await track.unmute();
    }
    useUiStore.getState().setVoiceState({ isMuted: muted });
  };

  const setDeafened = (deafened: boolean): void => {
    applyDeafen(deafened);
    useUiStore.getState().setVoiceState({
      isDeafened: deafened,
      isMuted: deafened ? true : useUiStore.getState().isMuted,
    });
    if (deafened) {
      void setMuted(true);
    }
  };

  useEffect(() => {
    return () => {
      const channelId = activeChannelRef.current;
      if (channelId) {
        socket?.emit(ClientToServerEvent.VoiceLeave, { channelId });
      }
      void cleanupRoom(true);
    };
  }, [socket]);

  useEffect(() => {
    // Appliquer les réglages de sortie en temps réel quand ils changent
    const unsubscribe = useUiStore.subscribe((state, prev) => {
      if (
        state.voiceSettings.outputVolume !== prev.voiceSettings.outputVolume ||
        state.voiceSettings.outputDeviceId !== prev.voiceSettings.outputDeviceId
      ) {
        applyOutputSettings();
      }
    });
    return unsubscribe;
  }, []);

  return {
    joinVoiceChannel,
    leaveVoiceChannel,
    setMuted,
    setDeafened,
  };
}

function ensureAudioRoot(ref: MutableRefObject<HTMLDivElement | null>): HTMLDivElement {
  if (ref.current) {
    return ref.current;
  }

  const root = document.createElement('div');
  root.className = 'voice-audio-root';
  root.setAttribute('aria-hidden', 'true');
  document.body.appendChild(root);
  ref.current = root;
  return root;
}

function getVoiceErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Permission micro refusée.';
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Impossible de rejoindre le salon vocal.';
}
