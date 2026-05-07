import { MessagePrivacy, type EncryptedPayload } from '@discord2/shared';
import { ValidationAppError } from '@discord2/shared';

export interface CreateMessageInput {
  privacy: MessagePrivacy;
  content?: string | null;
  encrypted?: EncryptedPayload | null;
  attachments?: unknown[];
}

export function normalizeMessageInput(input: CreateMessageInput): CreateMessageInput {
  if (input.privacy === MessagePrivacy.Public) {
    const content = input.content?.trim();
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (!content && !hasAttachments) {
      throw new ValidationAppError('Public messages require plaintext content.');
    }

    return {
      privacy: MessagePrivacy.Public,
      content: content || null,
      encrypted: null,
      attachments: input.attachments ?? [],
    };
  }

  if (input.content) {
    throw new ValidationAppError('Encrypted messages must not include plaintext content.');
  }

  if (!input.encrypted) {
    throw new ValidationAppError('Encrypted messages require an encrypted payload.');
  }

  return {
    privacy: MessagePrivacy.EndToEndEncrypted,
    content: null,
    encrypted: input.encrypted,
  };
}
