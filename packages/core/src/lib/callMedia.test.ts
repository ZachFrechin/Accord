import { describe, expect, it } from "vitest";

import {
  EventDeduplicator,
  decryptCallMediaJson,
  deriveCallMediaSyncKey,
  driftCorrectionSeconds,
  emptySharedMediaState,
  encryptCallMediaJson,
  estimateServerClockOffsetMs,
  expectedMediaPositionSeconds,
  isYoutubeBridgeMessage,
  parseYouTubeVideoId,
  reduceSharedMedia,
  shouldDropSoundEvent,
  validateSharedMediaState,
} from "./callMedia";

describe("YouTube URL parsing", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=2", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("accepts %s", (input, expected) => expect(parseYouTubeVideoId(input)).toBe(expected));

  it.each([
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/playlist?list=PL123",
    "javascript:alert(1)",
    "too-short",
  ])("rejects %s", (input) => expect(parseYouTubeVideoId(input)).toBeNull());
});

describe("shared media state", () => {
  it("reduces queue and transport changes without losing contributor ids", () => {
    let state = emptySharedMediaState(7, 1_000);
    state = reduceSharedMedia(state, {
      type: "enqueue",
      item: { id: "a", videoId: "dQw4w9WgXcQ", contributedBy: "user-a" },
      serverNowMs: 1_500,
    });
    expect(state.currentItemId).toBe("a");
    expect(state.status).toBe("playing");
    expect(state.anchorServerTimeMs).toBe(1_500);
    expect(state.queue[0].contributedBy).toBe("user-a");

    state = reduceSharedMedia(state, { type: "play", positionSeconds: 4, serverNowMs: 2_000 });
    expect(expectedMediaPositionSeconds(state, 3_000, 0)).toBe(5);
    expect(validateSharedMediaState(state)).toEqual(state);
  });

  it("computes request-midpoint clock offset and hard-seek threshold", () => {
    expect(estimateServerClockOffsetMs(1_000, 1_200, 1_600)).toBe(500);
    expect(driftCorrectionSeconds(10, 11.49)).toBeNull();
    expect(driftCorrectionSeconds(10, 11.51)).toBe(11.51);
  });
});

describe("encrypted call media", () => {
  it("round-trips and rejects changed authenticated context", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveCallMediaSyncKey(raw, "conv", "call", 3);
    const payload = await encryptCallMediaJson(key, { secret: "state" }, {
      conversationId: "conv", callId: "call", epoch: 3, purpose: "state",
    });
    await expect(decryptCallMediaJson(key, payload, {
      conversationId: "conv", callId: "call", epoch: 3, purpose: "state",
    })).resolves.toEqual({ secret: "state" });
    await expect(decryptCallMediaJson(key, payload, {
      conversationId: "conv", callId: "other", epoch: 3, purpose: "state",
    })).rejects.toBeTruthy();
  });
});

describe("event validation", () => {
  it("binds postMessage to origin, source and channel", () => {
    const source = {} as MessageEventSource;
    const event = { origin: "https://accord.test", source, data: {
      source: "accord-youtube-bridge", channel: "abc", type: "READY",
    }} as MessageEvent;
    expect(isYoutubeBridgeMessage(event, { origin: event.origin, source, channel: "abc" })).toBe(true);
    expect(isYoutubeBridgeMessage(event, { origin: "https://evil.test", source, channel: "abc" })).toBe(false);
  });

  it("deduplicates triggers and drops events over two seconds late", () => {
    const dedupe = new EventDeduplicator();
    expect(dedupe.accept("event", 1_000)).toBe(true);
    expect(dedupe.accept("event", 1_001)).toBe(false);
    expect(shouldDropSoundEvent(1_000, 3_001)).toBe(true);
    expect(shouldDropSoundEvent(1_000, 3_000)).toBe(false);
  });
});
