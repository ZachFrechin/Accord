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

  // 3. Compresseur : écrête les pics et monte le niveau global
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.1;
  lastNode.connect(compressor);
  lastNode = compressor;

  // 4. Noise gate (AudioWorklet) : coupe tout ce qui passe sous le seuil
  const gateThreshold = (settings.noiseGateThreshold / 100) * 0.03;
  if (gateThreshold > 0.0005) {
    await ensureNoiseGateWorklet(audioContext);
    const gateNode = new AudioWorkletNode(audioContext, 'noise-gate', {
      processorOptions: { threshold: gateThreshold },
    });
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

/* ── AudioWorklet Noise Gate ─────────────────────────── */

let workletRegistered = false;

async function ensureNoiseGateWorklet(ctx: AudioContext): Promise<void> {
  if (workletRegistered) return;

  const code = `
class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.threshold = options.processorOptions?.threshold ?? 0.006;
    this.gain = 0;
    this.holdSamples = Math.round(0.15 * sampleRate); // 150 ms hold
    this.holdCounter = 0;
    this.attackCoef = Math.exp(-1 / (0.005 * sampleRate));   // 5 ms
    this.releaseCoef = Math.exp(-1 / (0.05 * sampleRate));   // 50 ms
    this.rmsWindow = Math.round(0.01 * sampleRate);          // 10 ms RMS
    this.rmsBuffer = new Float32Array(this.rmsWindow);
    this.rmsIndex = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const inCh = input[0];
    const outCh = output[0] ?? inCh;

    for (let i = 0; i < inCh.length; i++) {
      const sample = inCh[i];

      // RMS circulaire
      this.rmsBuffer[this.rmsIndex] = sample * sample;
      this.rmsIndex = (this.rmsIndex + 1) % this.rmsWindow;
      let sum = 0;
      for (let j = 0; j < this.rmsWindow; j++) sum += this.rmsBuffer[j];
      const rms = Math.sqrt(sum / this.rmsWindow);

      // Enveloppe avec hold
      if (rms > this.threshold) {
        this.holdCounter = this.holdSamples;
        this.gain = this.attackCoef * this.gain + (1 - this.attackCoef) * 1;
      } else if (this.holdCounter > 0) {
        this.holdCounter--;
        this.gain = this.attackCoef * this.gain + (1 - this.attackCoef) * 1;
      } else {
        this.gain = this.releaseCoef * this.gain + (1 - this.releaseCoef) * 0;
      }

      const out = sample * this.gain;
      if (outCh !== inCh) outCh[i] = out;
      else inCh[i] = out;
    }
    return true;
  }
}
registerProcessor('noise-gate', NoiseGateProcessor);
`;

  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
    workletRegistered = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
