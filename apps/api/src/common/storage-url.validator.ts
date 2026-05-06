import { BadRequestException } from '@nestjs/common';
import { loadServerEnv } from '@discord2/config';

export function assertPublicStorageUrl(
  value: string | null | undefined,
  bucket: 'profile-avatars' | 'server-icons',
): void {
  if (value === null || value === undefined) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Avatar URL is invalid.');
  }

  const env = loadServerEnv();
  const supabaseOrigin = new URL(env.SUPABASE_URL).origin;
  const expectedPrefix = `/storage/v1/object/public/${bucket}/`;
  if (url.origin !== supabaseOrigin || !url.pathname.startsWith(expectedPrefix)) {
    throw new BadRequestException(
      'Avatar URL must come from the expected Supabase Storage bucket.',
    );
  }
}
