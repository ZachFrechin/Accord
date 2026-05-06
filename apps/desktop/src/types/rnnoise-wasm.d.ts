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

  interface RNNoiseModuleOptions {
    wasmBinary?: ArrayBuffer;
    locateFile?: (path: string) => string;
    [key: string]: unknown;
  }

  export function createRNNWasmModule(options?: RNNoiseModuleOptions): Promise<RNNoiseModule>;
  export function createRNNWasmModuleSync(options?: RNNoiseModuleOptions): RNNoiseModule;
}
