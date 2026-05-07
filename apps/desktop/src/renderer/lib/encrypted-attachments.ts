import { decryptBytes } from '@discord2/e2ee';
import type { ConversationKey } from '@discord2/e2ee';
import type { MessageAttachment } from '@discord2/shared';

export interface DecryptedAttachment {
  attachmentId: string;
  objectUrl: string;
  mimeType: string;
}

const cache = new Map<string, DecryptedAttachment>();

export async function loadEncryptedAttachment(
  attachment: MessageAttachment,
  conversationKey: ConversationKey,
): Promise<DecryptedAttachment> {
  const cached = cache.get(attachment.id);
  if (cached) return cached;

  if (!attachment.encrypted) {
    throw new Error('Missing encrypted payload on attachment.');
  }

  const plainBytes = await decryptBytes(attachment.encrypted, conversationKey);
  const mimeType = detectMimeType(plainBytes);
  const blob = new Blob([new Uint8Array(plainBytes)], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);

  const result: DecryptedAttachment = { attachmentId: attachment.id, objectUrl, mimeType };
  cache.set(attachment.id, result);
  return result;
}

export function revokeDecryptedAttachment(attachmentId: string): void {
  const entry = cache.get(attachmentId);
  if (entry) {
    URL.revokeObjectURL(entry.objectUrl);
    cache.delete(attachmentId);
  }
}

function detectMimeType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)
    return 'image/webp';
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)
    return 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return 'video/webm';
  return 'application/octet-stream';
}
