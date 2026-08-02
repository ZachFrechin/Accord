/**
 * Convergence hardening tests — the split-brain fixes. A mock engine + mock
 * Delivery Service drive the exact failure shapes seen cross-platform:
 * (a) a diverged device silently "succeeding" into a foreign log, and
 * (b) the 409-rebase loop spinning without the epoch ever advancing.
 */

import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/ApiClient";
import { ApiError } from "../../api/http";
import type { MlsEngine } from "./MlsEngine";
import {
  MlsDivergenceError,
  addDevices,
  pullWelcomes,
  selfUpdateCommit,
  sendAppMessage,
  syncFrames,
} from "./mlsGroup";

const conflict = () => new ApiError(409, "CONFLICT", "epoch already advanced");

/** A stub engine: only what each test drives is implemented. */
function stubEngine(overrides: Partial<MlsEngine>): MlsEngine {
  const die = (name: string) => () => Promise.reject(new Error(`unexpected engine call: ${name}`));
  const base = {
    initIdentity: die("initIdentity"),
    generateKeyPackage: die("generateKeyPackage"),
    createGroup: die("createGroup"),
    groupEpoch: die("groupEpoch"),
    exportCallKey: die("exportCallKey"),
    mergePending: die("mergePending"),
    clearPending: die("clearPending"),
    addMember: die("addMember"),
    removeMember: die("removeMember"),
    removeMembersByPrefix: die("removeMembersByPrefix"),
    selfUpdate: die("selfUpdate"),
    joinFromWelcome: die("joinFromWelcome"),
    deleteGroup: die("deleteGroup"),
    memberIdentities: die("memberIdentities"),
    process: die("process"),
    encryptApp: die("encryptApp"),
    decryptApp: die("decryptApp"),
  } as unknown as MlsEngine;
  return Object.assign(base, overrides);
}

describe("syncFrames — divergence signal", () => {
  it("counts unprocessable current-epoch frames as failures but advances the cursor", async () => {
    const client = {
      mlsFrames: vi.fn().mockResolvedValue({
        frames: [
          { order_seq: 1, epoch: 3, content_type: "commit", sender_id: "u1", frame: "x" },
          { order_seq: 2, epoch: 3, content_type: "application", sender_id: "u1", frame: "y" },
        ],
      }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      process: vi.fn().mockRejectedValue(new Error("process_message: foreign group")),
      groupEpoch: vi.fn().mockResolvedValue(0), // we sit at epoch 0 — frames are at 3
    });
    const { cursor, failures, messages } = await syncFrames(client, "i", "g", 0, engine);
    expect(cursor).toBe(2);
    expect(failures).toBe(2);
    expect(messages).toEqual([]);
  });

  it("treats pre-join (older-epoch) frames as benign skips", async () => {
    const client = {
      mlsFrames: vi.fn().mockResolvedValue({
        frames: [{ order_seq: 1, epoch: 1, content_type: "application", sender_id: "u1", frame: "x" }],
      }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      process: vi.fn().mockRejectedValue(new Error("process_message: too old")),
      groupEpoch: vi.fn().mockResolvedValue(5), // we joined at epoch 5; frame is history
    });
    const { failures } = await syncFrames(client, "i", "g", 0, engine);
    expect(failures).toBe(0);
  });
});

describe("submitCommit — progress check (via selfUpdateCommit)", () => {
  it("throws MlsDivergenceError when a 409 rebase does not advance the epoch", async () => {
    const client = {
      mlsCommit: vi.fn().mockRejectedValue(conflict()),
      mlsFrames: vi.fn().mockResolvedValue({ frames: [] }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      selfUpdate: vi.fn().mockResolvedValue("commit-b64"),
      groupEpoch: vi.fn().mockResolvedValue(0), // never moves — split-brain
      clearPending: vi.fn().mockResolvedValue(undefined),
    });
    await expect(
      selfUpdateCommit(client, "i", "g", { seq: 0 }, undefined, engine),
    ).rejects.toBeInstanceOf(MlsDivergenceError);
    // One submit, one rebase attempt — no blind 6-retry spin.
    expect(vi.mocked(client.mlsCommit).mock.calls.length).toBe(1);
  });

  it("retries and succeeds when the rebase actually advances the epoch", async () => {
    let epoch = 0;
    const client = {
      mlsCommit: vi
        .fn()
        .mockRejectedValueOnce(conflict())
        .mockResolvedValueOnce({ order_seq: 2 }),
      mlsFrames: vi.fn().mockImplementation(async () => {
        // The winner's commit is replayed: our epoch moves 0 → 1.
        epoch = 1;
        return { frames: [] };
      }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      selfUpdate: vi.fn().mockResolvedValue("commit-b64"),
      groupEpoch: vi.fn().mockImplementation(async () => epoch),
      clearPending: vi.fn().mockResolvedValue(undefined),
      mergePending: vi.fn().mockResolvedValue(undefined),
    });
    await selfUpdateCommit(client, "i", "g", { seq: 0 }, undefined, engine);
    expect(vi.mocked(client.mlsCommit).mock.calls.length).toBe(2);
  });
});

describe("pullWelcomes — at-least-once with ack", () => {
  it("joins with the group-id hint and acks success AND deterministic failure", async () => {
    const acked: string[] = [];
    const client = {
      mlsWelcomes: vi.fn().mockResolvedValue({
        welcomes: [
          { id: "w1", group_id: "g1", welcome: "ok" },
          { id: "w2", group_id: "g2", welcome: "bad" },
        ],
      }),
      ackMlsWelcome: vi.fn().mockImplementation(async (id: string) => {
        acked.push(id);
        return { status: "ok" };
      }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      joinFromWelcome: vi
        .fn()
        .mockImplementation(async (_i: string, welcome: string, hint?: string) => {
          if (welcome === "bad") throw new Error("staged welcome: broken");
          return hint ?? "g1";
        }),
    });
    const joined = await pullWelcomes(client, "i", "dev", engine);
    expect(joined).toEqual(["g1"]);
    expect(acked).toEqual(["w1", "w2"]);
    // The hint (the wipe-divergent-group-first path) is forwarded.
    expect(vi.mocked(engine.joinFromWelcome).mock.calls[0]![2]).toBe("g1");
  });

  it("skips the ack on servers that don't send ids (legacy)", async () => {
    const client = {
      mlsWelcomes: vi.fn().mockResolvedValue({ welcomes: [{ group_id: "g1", welcome: "ok" }] }),
      ackMlsWelcome: vi.fn(),
    } as unknown as ApiClient;
    const engine = stubEngine({ joinFromWelcome: vi.fn().mockResolvedValue("g1") });
    await pullWelcomes(client, "i", "dev", engine);
    expect(vi.mocked(client.ackMlsWelcome).mock.calls.length).toBe(0);
  });
});

describe("addDevices — fresh claims + tree-aware skips", () => {
  it("skips a device that is already in the tree (no commit at all)", async () => {
    const client = {
      claimKeyPackages: vi.fn(),
      mlsCommit: vi.fn(),
      mlsFrames: vi.fn().mockResolvedValue({ frames: [] }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      memberIdentities: vi.fn().mockResolvedValue(["u1:dev1"]),
      groupEpoch: vi.fn().mockResolvedValue(1),
    });
    await addDevices(client, "i", "g", [{ userId: "u1", deviceIds: ["dev1"] }], { seq: 0 }, undefined, engine);
    expect(vi.mocked(client.claimKeyPackages).mock.calls.length).toBe(0);
    expect(vi.mocked(client.mlsCommit).mock.calls.length).toBe(0);
  });

  it("claims a FRESH KeyPackage on every rebuild after a lost race", async () => {
    let epoch = 0;
    const client = {
      claimKeyPackages: vi
        .fn()
        .mockResolvedValue({ packages: [{ device_id: "dev1", key_package: "kp" }] }),
      mlsCommit: vi
        .fn()
        .mockRejectedValueOnce(conflict())
        .mockResolvedValueOnce({ order_seq: 5 }),
      mlsFrames: vi.fn().mockImplementation(async () => {
        epoch += 1; // rebase applies the winner — epoch advances
        return { frames: [] };
      }),
    } as unknown as ApiClient;
    const engine = stubEngine({
      memberIdentities: vi.fn().mockResolvedValue([]),
      groupEpoch: vi.fn().mockImplementation(async () => epoch),
      addMember: vi.fn().mockResolvedValue({ commit: "c", welcome: "w" }),
      clearPending: vi.fn().mockResolvedValue(undefined),
      mergePending: vi.fn().mockResolvedValue(undefined),
    });
    await addDevices(client, "i", "g", [{ userId: "u1", deviceIds: ["dev1"] }], { seq: 0 }, undefined, engine);
    // One claim per build — the consumed single-use package is never reused.
    expect(vi.mocked(client.claimKeyPackages).mock.calls.length).toBe(2);
  });
});

describe("sendAppMessage — divergence surfaces at send time", () => {
  it("maps the server's stale-epoch 409 to MlsDivergenceError", async () => {
    const client = {
      mlsFrame: vi.fn().mockRejectedValue(conflict()),
    } as unknown as ApiClient;
    const engine = stubEngine({
      groupEpoch: vi.fn().mockResolvedValue(0),
      encryptApp: vi.fn().mockResolvedValue("frame-b64"),
    });
    await expect(sendAppMessage(client, "i", "g", "hello", engine)).rejects.toBeInstanceOf(
      MlsDivergenceError,
    );
    // The claimed epoch rides along so the server can arbitrate.
    expect(vi.mocked(client.mlsFrame).mock.calls[0]![3]).toBe(0);
  });
});
