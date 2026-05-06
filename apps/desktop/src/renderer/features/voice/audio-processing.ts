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

  const audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  await audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);
  const destination = audioContext.createMediaStreamDestination();
  const cleanupNodes: Array<() => void> = [];

  let lastNode: AudioNode = source;

  // Coupe les graves continus avant toute amplification de la voix.
  const highPass = audioContext.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 120;
  highPass.Q.value = 0.7;
  lastNode.connect(highPass);
  lastNode = highPass;

  if (settings.enableRnnoise) {
    try {
      const rnnoiseNode = await createRnnoiseNode(audioContext);
      lastNode.connect(rnnoiseNode);
      lastNode = rnnoiseNode;
      cleanupNodes.push(() => rnnoiseNode.destroy());
    } catch (error) {
      console.warn('RNNoise unavailable, falling back to local voice gate.', error);
    }
  }

  const gateThreshold = getGateThreshold(settings.noiseGateThreshold);
  if (gateThreshold > 0) {
    const gateNode = createNoiseGateNode(audioContext, gateThreshold);
    lastNode.connect(gateNode);
    lastNode = gateNode;
  }

  // Compression légère après le gate : elle stabilise la voix sans remonter le bruit ambiant.
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.knee.value = 14;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.16;
  lastNode.connect(compressor);
  lastNode = compressor;

  // Limite les hautes fréquences où clavier et souffle sont très présents.
  const lowPass = audioContext.createBiquadFilter();
  lowPass.type = 'lowpass';
  lowPass.frequency.value = 7600;
  lowPass.Q.value = 0.7;
  lastNode.connect(lowPass);
  lastNode = lowPass;

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
    noiseSuppression: settings.enableNoiseSuppression,
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

function getGateThreshold(thresholdPercent: number): number {
  if (thresholdPercent <= 0) {
    return 0;
  }

  const normalized = Math.min(100, Math.max(0, thresholdPercent)) / 100;
  const thresholdDb = -62 + normalized * 34;
  return 10 ** (thresholdDb / 20);
}

function createNoiseGateNode(audioContext: AudioContext, threshold = 0.006): ScriptProcessorNode {
  const processor = audioContext.createScriptProcessor(512, 1, 1);

  const sampleRate = audioContext.sampleRate;
  const openThreshold = threshold;
  const closeThreshold = threshold * 0.58;
  const closedGain = 0.035;
  const attackMs = 0.008;
  const releaseMs = 0.12;
  const holdMs = 0.16;
  const attackStep = 1 - Math.exp(-processor.bufferSize / (attackMs * sampleRate));
  const releaseStep = 1 - Math.exp(-processor.bufferSize / (releaseMs * sampleRate));
  const holdBlocks = Math.ceil((holdMs * sampleRate) / processor.bufferSize);
  let gateOpen = false;
  let gain = closedGain;
  let holdBlocksLeft = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    let sum = 0;

    for (let i = 0; i < input.length; i++) {
      const sample = input[i]!;
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / input.length);
    if (rms >= openThreshold) {
      gateOpen = true;
      holdBlocksLeft = holdBlocks;
    } else if (rms <= closeThreshold && holdBlocksLeft > 0) {
      holdBlocksLeft--;
    } else if (rms <= closeThreshold) {
      gateOpen = false;
    }

    const targetGain = gateOpen ? 1 : closedGain;
    const step = gateOpen ? attackStep : releaseStep;

    for (let i = 0; i < input.length; i++) {
      gain += (targetGain - gain) * step;
      output[i] = input[i]! * gain;
    }
  };

  return processor;
}
