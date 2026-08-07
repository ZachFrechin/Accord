import { describe, expect, it } from "vitest";

import { encodeMonoPcm16Wav, PERSONAL_SOUND_SAMPLE_RATE } from "./soundboard";

describe("sound normalization WAV encoder", () => {
  it("writes mono 44.1 kHz PCM16 and clamps samples", () => {
    const wav = encodeMonoPcm16Wav({
      sampleRate: PERSONAL_SOUND_SAMPLE_RATE,
      samples: new Float32Array([-2, -1, 0, 1, 2]),
    });
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(52, true)).toBe(32_767);
  });
});
