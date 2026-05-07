import { describe, expect, it } from 'vitest';
import {
  decryptBytes,
  decryptMessage,
  encryptBytes,
  encryptMessage,
  exportConversationKey,
  generateConversationKey,
  generateDeviceIdentity,
  importConversationKey,
  unwrapConversationKey,
  wrapConversationKey,
} from './crypto';

describe('e2ee crypto', () => {
  it('round-trips messages without exposing plaintext in the payload', async () => {
    const key = await generateConversationKey();
    const encrypted = await encryptMessage('private hello', key, 'device-1');

    expect(encrypted.ciphertext).not.toContain('private hello');
    await expect(decryptMessage(encrypted, key)).resolves.toBe('private hello');
  });

  it('fails to decrypt with the wrong key', async () => {
    const key = await generateConversationKey();
    const wrongKey = await generateConversationKey();
    const encrypted = await encryptMessage('private hello', key, 'device-1');

    await expect(decryptMessage(encrypted, wrongKey)).rejects.toThrow();
  });

  it('wraps a conversation key for a device without exposing the raw key', async () => {
    const key = await generateConversationKey();
    const identity = await generateDeviceIdentity('device-1');
    const wrapped = await wrapConversationKey(key, identity.publicKey);
    const unwrapped = await unwrapConversationKey(wrapped, identity, key.version);

    expect(wrapped).not.toContain(Buffer.from(key.bytes).toString('base64'));
    await expect(
      decryptMessage(await encryptMessage('hello', key, identity.deviceId), unwrapped),
    ).resolves.toBe('hello');
  });

  it('round-trips binary bytes without exposing plaintext in the payload', async () => {
    const key = await generateConversationKey();
    const original = new TextEncoder().encode('binary payload');
    const encrypted = await encryptBytes(original, key, 'device-1');

    expect(encrypted.ciphertext).not.toContain('binary payload');
    expect(encrypted.senderDeviceId).toBe('device-1');
    const decrypted = await decryptBytes(encrypted, key);
    expect(decrypted).toEqual(original);
  });

  it('fails to decrypt bytes with the wrong key', async () => {
    const key = await generateConversationKey();
    const wrongKey = await generateConversationKey();
    const encrypted = await encryptBytes(new TextEncoder().encode('secret'), key, 'device-1');

    await expect(decryptBytes(encrypted, wrongKey)).rejects.toThrow();
  });

  it('round-trips a conversation key through export/import', async () => {
    const key = await generateConversationKey(3);
    const exported = await exportConversationKey(key);
    const imported = await importConversationKey(exported, 3);

    expect(imported.version).toBe(3);
    expect(imported.bytes).toEqual(key.bytes);
  });
});
