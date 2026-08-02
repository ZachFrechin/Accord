import { describe, expect, it } from "vitest";

import type { ApiClient, MessageDto } from "../api/ApiClient";
import * as crypto from "./crypto";
import type { DeviceIdentity } from "./deviceIdentity";
import { decryptMessage, encryptForMembers } from "./messaging";

type Registry = Record<string, { device_id: string; public_key: string }[]>;

/** A minimal ApiClient stub that only serves device-key bundles from a registry. */
function fakeClient(registry: Registry): ApiClient {
  return {
    keyBundle: async (userId: string) => ({ user_id: userId, devices: registry[userId] ?? [] }),
  } as unknown as ApiClient;
}

function identity(deviceId: string): DeviceIdentity {
  return { deviceId, keyPair: crypto.generateIdentityKeyPair() };
}

function dtoFor(
  payload: Awaited<ReturnType<typeof encryptForMembers>>,
  deviceId: string,
): MessageDto {
  const key = payload.recipients.find((r) => r.device_id === deviceId);
  return {
    id: "m1",
    sender_id: "u_alice",
    sender_device: "devA",
    ciphertext: payload.ciphertext,
    body_nonce: payload.body_nonce,
    wrapped_key: key?.wrapped_key ?? null,
    wrap_nonce: key?.wrap_nonce ?? null,
    created_at: "2026-01-01T00:00:00Z",
    edited_at: null,
    deleted: false,
  };
}

const CONV = "conv_1";

describe("message E2EE orchestration", () => {
  it("encrypts to every member device; recipients decrypt to the original", async () => {
    const alice = identity("devA");
    const bob = identity("devB");
    const client = fakeClient({
      u_alice: [{ device_id: "devA", public_key: crypto.toBase64(alice.keyPair.publicKey) }],
      u_bob: [{ device_id: "devB", public_key: crypto.toBase64(bob.keyPair.publicKey) }],
    });

    const payload = await encryptForMembers(client, alice, CONV, "u_alice", ["u_alice", "u_bob"], {
      text: "hello 🔐",
    });

    expect(new Set(payload.recipients.map((r) => r.device_id))).toEqual(new Set(["devA", "devB"]));
    expect((await decryptMessage(client, bob, CONV, dtoFor(payload, "devB")))?.text).toBe("hello 🔐");
    expect((await decryptMessage(client, alice, CONV, dtoFor(payload, "devA")))?.text).toBe("hello 🔐");
  });

  it("a non-recipient device cannot decrypt", async () => {
    const alice = identity("devA");
    const bob = identity("devB");
    const mallory = identity("devM");
    const client = fakeClient({
      u_alice: [{ device_id: "devA", public_key: crypto.toBase64(alice.keyPair.publicKey) }],
      u_bob: [{ device_id: "devB", public_key: crypto.toBase64(bob.keyPair.publicKey) }],
    });

    const payload = await encryptForMembers(client, alice, CONV, "u_alice", ["u_alice", "u_bob"], {
      text: "secret",
    });
    expect(await decryptMessage(client, mallory, CONV, dtoFor(payload, "devB"))).toBeNull();
  });

  it("rejects a ciphertext relocated to another conversation (context binding)", async () => {
    const alice = identity("devA");
    const bob = identity("devB");
    const client = fakeClient({
      u_alice: [{ device_id: "devA", public_key: crypto.toBase64(alice.keyPair.publicKey) }],
      u_bob: [{ device_id: "devB", public_key: crypto.toBase64(bob.keyPair.publicKey) }],
    });

    const payload = await encryptForMembers(client, alice, CONV, "u_alice", ["u_alice", "u_bob"], {
      text: "private DM",
    });
    // Same authenticated ciphertext, served under a DIFFERENT conversation id → rejected.
    expect(await decryptMessage(client, bob, "other_conv", dtoFor(payload, "devB"))).toBeNull();
  });

  it("a deleted message yields null content", async () => {
    const alice = identity("devA");
    const client = fakeClient({});
    const deleted: MessageDto = {
      id: "m2",
      sender_id: "u_alice",
      sender_device: "devA",
      ciphertext: null,
      body_nonce: null,
      wrapped_key: null,
      wrap_nonce: null,
      created_at: "2026-01-01T00:00:00Z",
      edited_at: null,
      deleted: true,
    };
    expect(await decryptMessage(client, alice, CONV, deleted)).toBeNull();
  });
});
