import { LocalAudioTrack } from 'livekit-client';
import { createRNNWasmModule } from '@jitsi/rnnoise-wasm';
import rnnoiseWasmUrl from '../../assets/rnnoise.wasm?url';
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

  const audioContext = new AudioContext({ sampleRate: 48000 });
  const source = audioContext.createMediaStreamSource(stream);
  const destination = audioContext.createMediaStreamDestination();

  let lastNode: AudioNode = source;
  const cleanupFns: Array<() => void> = [];

  // Gain d'entrée
  const inputGain = audioContext.createGain();
  inputGain.gain.value = settings.inputVolume / 100;
  lastNode.connect(inputGain);
  lastNode = inputGain;

  if (settings.enableRnnoise) {
    const { processor: rnnoiseNode, cleanup } = await createRnnoiseNode(audioContext);
    cleanupFns.push(cleanup);
    lastNode.connect(rnnoiseNode);
    lastNode = rnnoiseNode;
  }

  const gateThreshold = (settings.noiseGateThreshold / 100) * 0.02;
  const gateNode = createNoiseGateNode(audioContext, gateThreshold);
  lastNode.connect(gateNode);
  lastNode = gateNode;

  lastNode.connect(destination);

  const processedTrack = destination.stream.getAudioTracks()[0];
  if (!processedTrack) {
    throw new Error('Failed to create processed audio track.');
  }

  const localTrack = new LocalAudioTrack(processedTrack, undefined, true);

  return {
    track: localTrack,
    dispose: () => {
      localTrack.stop();
      stream.getTracks().forEach((t) => t.stop());
      cleanupFns.forEach((fn) => fn());
      void audioContext.close();
    },
  };
}

/* ── Noise Gate (ScriptProcessorNode) ─────────────────── */

function createNoiseGateNode(audioContext: AudioContext, threshold = 0.006): ScriptProcessorNode {
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  let gain = 0;
  const attack = 0.02;
  const release = 0.005;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    for (let i = 0; i < input.length; i++) {
      const sample = input[i]!;
      const abs = Math.abs(sample);

      if (abs > threshold) {
        gain = Math.min(gain + attack, 1);
      } else {
        gain = Math.max(gain - release, 0);
      }

      output[i] = sample * gain;
    }
  };

  return processor;
}

/* ── RNNoise WASM (ScriptProcessorNode + ring buffer) ─── */

interface RNNoiseState {
  state: number;
  inputPtr: number;
  outputPtr: number;
  module: Awaited<ReturnType<typeof createRNNWasmModule>>;
}

const RNNOISE_FRAME_SIZE = 480;

async function loadWasmBinary(): Promise<ArrayBuffer> {
  const response = await fetch(rnnoiseWasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to load rnnoise.wasm: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function createRnnoiseNode(
  audioContext: AudioContext,
): Promise<{ processor: ScriptProcessorNode; cleanup: () => void }> {
  const wasmBinary = await loadWasmBinary();
  const wasmModule = await createRNNWasmModule({ wasmBinary });
  const statePtr = wasmModule._rnnoise_create();
  const inputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);
  const outputPtr = wasmModule._malloc(RNNOISE_FRAME_SIZE * 4);

  const state: RNNoiseState = {
    state: statePtr,
    inputPtr,
    outputPtr,
    module: wasmModule,
  };

  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  // Ring buffers pour gérer le découpage en frames de 480
  const inputRing = new Float32Array(RNNOISE_FRAME_SIZE * 4);
  const outputRing = new Float32Array(RNNOISE_FRAME_SIZE * 4);
  let inputWrite = 0;
  let inputRead = 0;
  let outputWrite = 0;
  let outputRead = 0;
  let inputCount = 0;
  let outputCount = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    // 1. Écrire les nouveaux échantillons dans le ring buffer d'entrée
    for (let i = 0; i < input.length; i++) {
      inputRing[inputWrite] = input[i]!;
      inputWrite = (inputWrite + 1) % inputRing.length;
      inputCount++;
    }

    // 2. Traiter les frames de 480 dès que possible
    while (inputCount >= RNNOISE_FRAME_SIZE) {
      const frame = new Float32Array(RNNOISE_FRAME_SIZE);
      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        frame[i] = inputRing[inputRead]!;
        inputRead = (inputRead + 1) % inputRing.length;
      }
      inputCount -= RNNOISE_FRAME_SIZE;

      const processed = processRnnoiseFrame(state, frame);

      for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
        outputRing[outputWrite] = processed[i]!;
        outputWrite = (outputWrite + 1) % outputRing.length;
        outputCount++;
      }
    }

    // 3. Lire le ring buffer de sortie pour remplir le output
    for (let i = 0; i < output.length; i++) {
      if (outputCount > 0) {
        output[i] = outputRing[outputRead]!;
        outputRead = (outputRead + 1) % outputRing.length;
        outputCount--;
      } else {
        output[i] = 0;
      }
    }
  };

  return { processor, cleanup: () => {
    wasmModule._rnnoise_destroy(statePtr);
    wasmModule._free(inputPtr);
    wasmModule._free(outputPtr);
  }};
}

function processRnnoiseFrame(state: RNNoiseState, input: Float32Array): Float32Array {
  const wasm = state.module;

  // Copier le frame dans la mémoire WASM
  wasm.HEAPF32.set(input, state.inputPtr / 4);

  // Appeler RNNoise
  wasm._rnnoise_process_frame(state.state, state.outputPtr, state.inputPtr);

  // Lire le résultat
  const output = new Float32Array(RNNOISE_FRAME_SIZE);
  output.set(wasm.HEAPF32.subarray(state.outputPtr / 4, state.outputPtr / 4 + RNNOISE_FRAME_SIZE));

  return output;
}
