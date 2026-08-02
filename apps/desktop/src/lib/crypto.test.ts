import { describe, expect, it } from "vitest";

import * as crypto from "./crypto";

describe("crypto E2EE primitives", () => {
  it("a body round-trips with its message key", () => {
    const plaintext = crypto.utf8ToBytes("hello E2EE 🔐");
    const enc = crypto.encryptBody(plaintext);
    const dec = crypto.decryptBody(enc.ciphertext, enc.nonce, enc.messageKey);
    expect(crypto.bytesToUtf8(dec)).toBe("hello E2EE 🔐");
  });

  it("full send → receive: sender wraps the message key to the recipient device", () => {
    const sender = crypto.generateIdentityKeyPair();
    const recipient = crypto.generateIdentityKeyPair();

    // Sender side.
    const { ciphertext, nonce, messageKey } = crypto.encryptBody(crypto.utf8ToBytes("secret"));
    const wrap = crypto.wrapKeyForDevice(messageKey, recipient.publicKey, sender.privateKey);

    // Recipient side: unwrap with its private key + the sender's public key.
    const mk = crypto.unwrapKeyFromDevice(wrap.wrapped, wrap.nonce, sender.publicKey, recipient.privateKey);
    const dec = crypto.decryptBody(ciphertext, nonce, mk);
    expect(crypto.bytesToUtf8(dec)).toBe("secret");
  });

  it("a different recipient cannot unwrap the key", () => {
    const sender = crypto.generateIdentityKeyPair();
    const recipient = crypto.generateIdentityKeyPair();
    const attacker = crypto.generateIdentityKeyPair();
    const { messageKey } = crypto.encryptBody(crypto.utf8ToBytes("x"));
    const wrap = crypto.wrapKeyForDevice(messageKey, recipient.publicKey, sender.privateKey);

    expect(() =>
      crypto.unwrapKeyFromDevice(wrap.wrapped, wrap.nonce, sender.publicKey, attacker.privateKey),
    ).toThrow();
  });

  it("tampering with the wrapped key is detected", () => {
    const sender = crypto.generateIdentityKeyPair();
    const recipient = crypto.generateIdentityKeyPair();
    const { messageKey } = crypto.encryptBody(crypto.utf8ToBytes("x"));
    const wrap = crypto.wrapKeyForDevice(messageKey, recipient.publicKey, sender.privateKey);
    wrap.wrapped[0] ^= 0xff;

    expect(() =>
      crypto.unwrapKeyFromDevice(wrap.wrapped, wrap.nonce, sender.publicKey, recipient.privateKey),
    ).toThrow();
  });

  it("tampering with the body ciphertext is detected", () => {
    const enc = crypto.encryptBody(crypto.utf8ToBytes("x"));
    enc.ciphertext[0] ^= 0xff;
    expect(() => crypto.decryptBody(enc.ciphertext, enc.nonce, enc.messageKey)).toThrow();
  });

  it("base64 wire round-trips a 32-byte public key", () => {
    const kp = crypto.generateIdentityKeyPair();
    expect(kp.publicKey.length).toBe(32);
    const b64 = crypto.toBase64(kp.publicKey);
    expect(crypto.fromBase64(b64)).toEqual(kp.publicKey);
  });
});
