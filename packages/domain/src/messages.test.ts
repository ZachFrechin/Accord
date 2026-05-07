import { describe, expect, it } from 'vitest';
import { MessagePrivacy } from '@discord2/shared';
import { normalizeMessageInput } from './messages';

describe('normalizeMessageInput', () => {
  it('rejects encrypted messages that include plaintext', () => {
    expect(() =>
      normalizeMessageInput({
        privacy: MessagePrivacy.EndToEndEncrypted,
        content: 'secret',
        encrypted: {
          algorithm: 'xchacha20poly1305-ietf',
          ciphertext: 'abc',
          nonce: 'nonce',
          keyVersion: 1,
          senderDeviceId: 'device-id',
        },
      }),
    ).toThrow(/must not include plaintext/);
  });

  it('rejects non-E2EE messages', () => {
    expect(() =>
      normalizeMessageInput({
        privacy: MessagePrivacy.Public,
        content: 'hello',
      } as never),
    ).toThrow(/end-to-end encrypted/);
  });
});
