import { describe, expect, it } from 'vitest';
import { decryptMessage, encryptMessage, generateConversationKey } from './crypto';

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
});
