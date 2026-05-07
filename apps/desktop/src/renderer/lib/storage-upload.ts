import { supabase } from './supabase';
import type { CreateAttachmentInput } from '@discord2/shared';

const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_MEDIA_SIZE_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MESSAGE_MEDIA_EXTENSIONS: Record<string, string> = {
  ...IMAGE_EXTENSIONS,
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export async function uploadPublicImage(
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

export async function uploadMessageMedia(
  channelId: string,
  userId: string,
  file: File,
): Promise<CreateAttachmentInput> {
  const extension = MESSAGE_MEDIA_EXTENSIONS[file.type];
  if (!extension) {
    throw new Error('Format accepté : PNG, JPEG, WebP, GIF, MP4, WebM ou MOV.');
  }

  if (file.size > MAX_MESSAGE_MEDIA_SIZE_BYTES) {
    throw new Error('Fichier trop lourd. Taille maximale : 25 MB.');
  }

  const path = `${channelId}/${userId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('message-media').upload(path, file, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    storagePath: path,
    mimeType: file.type,
    byteSize: file.size,
    fileName: file.name,
  };
}
