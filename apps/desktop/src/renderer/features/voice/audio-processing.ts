import { LocalAudioTrack } from 'livekit-client';
import type { VoiceSettings } from '../../store/ui-store';

export interface ProcessedAudioResult {
  track: LocalAudioTrack;
  dispose: () => void;
}

export async function createProcessedAudioTrack(
  settings: VoiceSettings,
): Promise<ProcessedAudioResult> {
  const constraints: MediaTrackConstraints = {
    echoCancellation: settings.enableEchoCancellation,
    noiseSuppression: settings.enableNoiseSuppression,
    autoGainControl: settings.enableAutoGainControl,
  };
  if (settings.inputDeviceId) {
    constraints.deviceId = { exact: settings.inputDeviceId };
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const sourceTrack = stream.getAudioTracks()[0];
  if (!sourceTrack) {
    throw new Error('Aucune piste audio obtenue du micro.');
  }

  // Si aucun traitement custom n'est nécessaire, on retourne directement la track native
  const needsProcessing = settings.inputVolume !== 100;

  if (!needsProcessing) {
    const localTrack = new LocalAudioTrack(sourceTrack, undefined, true);
    return {
      track: localTrack,
      dispose: () => {
        localTrack.stop();
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  // Graph audio minimal : source -> gain -> destination
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = settings.inputVolume / 100;
  const destination = audioContext.createMediaStreamDestination();

  source.connect(gainNode);
  gainNode.connect(destination);

  const processedTrack = destination.stream.getAudioTracks()[0];
  if (!processedTrack) {
    throw new Error('Impossible de créer la piste audio traitée.');
  }

  const localTrack = new LocalAudioTrack(processedTrack, undefined, true);

  return {
    track: localTrack,
    dispose: () => {
      localTrack.stop();
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close();
    },
  };
}
