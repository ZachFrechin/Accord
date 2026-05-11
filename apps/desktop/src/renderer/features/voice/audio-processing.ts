import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import { LocalAudioTrack as LiveKitLocalAudioTrack } from 'livekit-client';
import type { LocalAudioTrack } from 'livekit-client';
import type { VoiceSettings } from '../../store/ui-store';

export interface ProcessedAudioResult {
  track: LocalAudioTrack;
  dispose: () => void;
}

export async function createProcessedAudioTrack(
  settings: VoiceSettings,
): Promise<ProcessedAudioResult> {
  const constraints = createVoiceAudioConstraints(settings);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const sourceTrack = stream.getAudioTracks()[0];
  if (!sourceTrack) {
    throw new Error('Aucune piste audio obtenue du micro.');
  }

  const needsAudioGraph = settings.enableRnnoise || settings.inputVolume !== 100;
  if (!needsAudioGraph) {
    const localTrack = new LiveKitLocalAudioTrack(sourceTrack, undefined, true);
    return {
      track: localTrack,
      dispose: () => {
        localTrack.stop();
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  const audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  await audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);
  const destination = audioContext.createMediaStreamDestination();
  const cleanupNodes: Array<() => void> = [];

  let lastNode: AudioNode = source;

  if (settings.enableRnnoise) {
    try {
      const rnnoiseNode = await createRnnoiseNode(audioContext);
      lastNode.connect(rnnoiseNode);
      lastNode = rnnoiseNode;
      cleanupNodes.push(() => rnnoiseNode.destroy());
    } catch (error) {
      console.warn('RNNoise unavailable; falling back to browser noise suppression.', error);
    }
  }

  const gainNode = audioContext.createGain();
  gainNode.gain.value = settings.inputVolume / 100;
  lastNode.connect(gainNode);
  lastNode = gainNode;

  lastNode.connect(destination);

  const processedTrack = destination.stream.getAudioTracks()[0];
  if (!processedTrack) {
    throw new Error('Impossible de créer la piste audio traitée.');
  }

  const localTrack = new LiveKitLocalAudioTrack(processedTrack, undefined, true);

  return {
    track: localTrack,
    dispose: () => {
      localTrack.stop();
      stream.getTracks().forEach((t) => t.stop());
      cleanupNodes.forEach((cleanup) => cleanup());
      void audioContext.close();
    },
  };
}

export function createVoiceAudioConstraints(settings: VoiceSettings): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    echoCancellation: settings.enableEchoCancellation,
    // When RNNoise is active we run it instead of the browser's NS to avoid double-denoising,
    // which makes voices sound thin and pumpy.
    noiseSuppression: settings.enableRnnoise ? false : settings.enableNoiseSuppression,
    autoGainControl: settings.enableAutoGainControl,
  };

  if (settings.inputDeviceId) {
    constraints.deviceId = { exact: settings.inputDeviceId };
  }

  return constraints;
}

async function createRnnoiseNode(audioContext: AudioContext): Promise<RnnoiseWorkletNode> {
  const wasmBinary = await loadRnnoise({
    url: rnnoiseWasmPath,
    simdUrl: rnnoiseSimdWasmPath,
  });
  await audioContext.audioWorklet.addModule(rnnoiseWorkletPath);
  return new RnnoiseWorkletNode(audioContext, {
    maxChannels: 1,
    wasmBinary,
  });
}

