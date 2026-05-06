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

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const destination = audioContext.createMediaStreamDestination();

  let lastNode: AudioNode = source;

  // 1. High-pass filter : retire le ronronnement des ventilateurs (< 100 Hz)
  const highPass = audioContext.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 100;
  highPass.Q.value = 0.7;
  lastNode.connect(highPass);
  lastNode = highPass;

  // 2. Low-pass filter : adoucit le sifflement/hiss aigu (> 8 kHz)
  const lowPass = audioContext.createBiquadFilter();
  lowPass.type = 'lowpass';
  lowPass.frequency.value = 8000;
  lowPass.Q.value = 0.7;
  lastNode.connect(lowPass);
  lastNode = lowPass;

  // 3. Compresseur : écrête les pics et normalise le niveau
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.1;
  lastNode.connect(compressor);
  lastNode = compressor;

  // 4. Noise gate (ScriptProcessorNode, buffer 256 = 5ms, sans ring buffer)
  const gateThreshold = (settings.noiseGateThreshold / 100) * 0.03;
  if (gateThreshold > 0.0005) {
    const gateNode = createNoiseGateNode(audioContext, gateThreshold);
    lastNode.connect(gateNode);
    lastNode = gateNode;
  }

  // 5. Gain d'entrée
  const gainNode = audioContext.createGain();
  gainNode.gain.value = settings.inputVolume / 100;
  lastNode.connect(gainNode);
  lastNode = gainNode;

  lastNode.connect(destination);

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

/* ── Noise Gate (ScriptProcessorNode, buffer 256) ────── */

function createNoiseGateNode(audioContext: AudioContext, threshold = 0.006): ScriptProcessorNode {
  // Buffer 256 = ~5.3 ms @ 48 kHz — latence minimale
  const processor = audioContext.createScriptProcessor(256, 1, 1);

  // Enveloppe exponentielle avec hold
  let gain = 0;
  const sampleRate = audioContext.sampleRate;
  const attackCoef = Math.exp(-1 / (0.005 * sampleRate));   // 5 ms attack
  const releaseCoef = Math.exp(-1 / (0.08 * sampleRate));   // 80 ms release
  const holdSamples = Math.round(0.12 * sampleRate);        // 120 ms hold
  let holdCounter = 0;

  // RMS glissant sur 10 ms
  const rmsWindow = Math.round(0.01 * sampleRate);
  const rmsBuffer = new Float32Array(rmsWindow);
  let rmsIndex = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    for (let i = 0; i < input.length; i++) {
      const sample = input[i]!;

      // RMS circulaire
      rmsBuffer[rmsIndex] = sample * sample;
      rmsIndex = (rmsIndex + 1) % rmsWindow;
      let sum = 0;
      for (let j = 0; j < rmsWindow; j++) {
        sum += rmsBuffer[j]!;
      }
      const rms = Math.sqrt(sum / rmsWindow);

      // Enveloppe avec hold
      if (rms > threshold) {
        holdCounter = holdSamples;
        gain = attackCoef * gain + (1 - attackCoef) * 1;
      } else if (holdCounter > 0) {
        holdCounter--;
        gain = attackCoef * gain + (1 - attackCoef) * 1;
      } else {
        gain = releaseCoef * gain + (1 - releaseCoef) * 0;
      }

      output[i] = sample * gain;
    }
  };

  return processor;
}
