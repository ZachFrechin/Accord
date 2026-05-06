import sodium from 'libsodium-wrappers-sumo';
import type { DeviceId, EncryptedPayload } from '@discord2/shared';

export const conversationKeyBytes = 32;

export interface ConversationKey {
  version: number;
  bytes: Uint8Array;
}

export async function generateConversationKey(version = 1): Promise<ConversationKey> {
  await sodium.ready;
  return {
    version,
    bytes: sodium.randombytes_buf(conversationKeyBytes),
  };
}

export async function encryptMessage(
  plaintext: string,
  key: ConversationKey,
  senderDeviceId: DeviceId,
): Promise<EncryptedPayload> {
  await sodium.ready;

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    null,
    null,
    nonce,
    key.bytes,
  );

  return {
    algorithm: 'xchacha20poly1305-ietf',
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
    keyVersion: key.version,
    senderDeviceId,
  };
}

export async function decryptMessage(
  payload: EncryptedPayload,
  key: ConversationKey,
): Promise<string> {
  await sodium.ready;

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64(payload.ciphertext),
    null,
    fromBase64(payload.nonce),
    key.bytes,
  );

  return sodium.to_string(plaintext);
}

export async function encryptBytes(
  bytes: Uint8Array,
  key: ConversationKey,
): Promise<EncryptedPayload> {
  await sodium.ready;

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    bytes,
    null,
    null,
    nonce,
    key.bytes,
  );

  return {
    algorithm: 'xchacha20poly1305-ietf',
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
    keyVersion: key.version,
    senderDeviceId: 'file-encryption',
  };
}

export async function decryptBytes(
  payload: EncryptedPayload,
  key: ConversationKey,
): Promise<Uint8Array> {
  await sodium.ready;

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64(payload.ciphertext),
    null,
    fromBase64(payload.nonce),
    key.bytes,
  );
}

function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function fromBase64(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
}
