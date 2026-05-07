import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreateAttachmentInput, EncryptedPayload } from '@discord2/shared';

const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export async function uploadPublicImage(
  supabase: SupabaseClient,
  bucket: 'profile-avatars' | 'server-icons',
  ownerId: string,
  file: File,
): Promise<string> {
  const extension = IMAGE_EXTENSIONS[file.type];
  if (!extension) {
    throw new Error('Format accepté : PNG, JPEG ou WebP.');
  }

  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error('Image trop lourde. Taille maximale : 2 MB.');
  }

  const path = `${ownerId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    throw new Error(error.message);
  }

  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export async function uploadEncryptedMessageMedia(
  supabase: SupabaseClient,
  channelId: string,
  userId: string,
  encryptedFile: EncryptedPayload,
): Promise<CreateAttachmentInput> {
  const path = `${channelId}/${userId}/${crypto.randomUUID()}.bin`;
  const encryptedBytes = base64ToBytes(encryptedFile.ciphertext);
  const body = new Blob([new Uint8Array(encryptedBytes)], {
    type: 'application/octet-stream',
  });
  const { error } = await supabase.storage.from('message-media').upload(path, body, {
    contentType: 'application/octet-stream',
    upsert: false,
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    storagePath: path,
    mimeType: 'application/octet-stream',
    byteSize: body.size,
    isE2ee: true,
    encrypted: encryptedFile,
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
