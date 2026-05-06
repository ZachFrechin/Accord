declare module '@jitsi/rnnoise-wasm' {
  interface RNNoiseModule {
    _rnnoise_create(): number;
    _rnnoise_destroy(state: number): void;
    _rnnoise_process_frame(state: number, outputPtr: number, inputPtr: number): void;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPF32: Float32Array;
    ready: Promise<RNNoiseModule>;
  }

  export function createRNNWasmModule(): Promise<RNNoiseModule>;
  export function createRNNWasmModuleSync(): RNNoiseModule;
}
