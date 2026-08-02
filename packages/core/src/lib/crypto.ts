/**
 * End-to-end encryption primitives (NaCl / X25519, via tweetnacl).
 *
 * Design (Phase 2 · Lot 2). Each device holds an X25519 identity keypair whose
 * PRIVATE half never leaves the device. To send a message:
 *   1. a fresh, single-use *message key* encrypts the body once
 *      (`secretbox` = XSalsa20-Poly1305);
 *   2. that message key is *wrapped* for each recipient device via an
 *      authenticated `box` (X25519 + XSalsa20-Poly1305) — only that device can
 *      unwrap it, and the unwrap authenticates the message against the sender's
 *      public key.
 * The server only ever sees ciphertext + wrapped keys; it never holds a private
 * key or any plaintext.
 *
 * TRUST MODEL (current): the sender's public key is taken from the server's key
 * directory with no client-side pinning, so a fully malicious server could still
 * substitute a key to impersonate a sender. End-to-end sender verification
 * (safety numbers / key transparency) and forward secrecy arrive with MLS in
 * Phase 3; the message envelope additionally binds the conversation + sender id
 * (see lib/messaging.ts) to block cross-conversation relocation/replay.
 */

import nacl from "tweetnacl";

/** An X25519 identity keypair. The private key never leaves the device. */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generates a device identity keypair (X25519). */
export function generateIdentityKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** Reconstructs a keypair from a persisted private key (the public half is
 * derivable, so only the private key needs to be stored). */
export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  const kp = nacl.box.keyPair.fromSecretKey(privateKey);
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

/** A body encrypted under a fresh, single-use message key. */
export interface EncryptedBody {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  messageKey: Uint8Array;
}

/** Encrypts a plaintext body once under a fresh message key (XSalsa20-Poly1305). */
export function encryptBody(plaintext: Uint8Array): EncryptedBody {
  const messageKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, messageKey);
  return { ciphertext, nonce, messageKey };
}

/** Decrypts a body given its message key + nonce. Throws if authentication fails. */
export function decryptBody(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  messageKey: Uint8Array,
): Uint8Array {
  const plaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);
  if (!plaintext) throw new Error("decryptBody: authentication failed");
  return plaintext;
}

/** A message key wrapped for one recipient device. */
export interface WrappedKey {
  wrapped: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Wraps a message key for one recipient device with an authenticated `box`:
 * confidential to that device AND authenticated as coming from the sender's
 * device.
 */
export function wrapKeyForDevice(
  messageKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array,
): WrappedKey {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const wrapped = nacl.box(messageKey, nonce, recipientPublicKey, senderPrivateKey);
  return { wrapped, nonce };
}

/**
 * Unwraps a message key wrapped for this device, verifying the sender. Throws if
 * authentication fails (tampering, wrong sender, or wrong recipient).
 */
export function unwrapKeyFromDevice(
  wrapped: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  const messageKey = nacl.box.open(wrapped, nonce, senderPublicKey, recipientPrivateKey);
  if (!messageKey) throw new Error("unwrapKeyFromDevice: authentication failed");
  return messageKey;
}

// ── wire helpers ─────────────────────────────────────────────────────────────
// Standard base64 (padding, `+/`), matching the backend's data_encoding::BASE64.
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export function utf8ToBytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}
export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}
