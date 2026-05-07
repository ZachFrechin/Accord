import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository } from '@discord2/db';
import { ChannelType, Permission, type AuthUser, type CreateAttachmentInput } from '@discord2/shared';
import { loadServerEnv } from '@discord2/config';
import { PermissionsService } from '../permissions/permissions.service';

const maxAvatarBytes = 2 * 1024 * 1024;
const maxMessageMediaBytes = 25 * 1024 * 1024;

const avatarExtensions = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

@Injectable()
export class FilesService {
  private readonly channelsRepository: ChannelsRepository;
  private readonly env = loadServerEnv();

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly permissionsService: PermissionsService,
  ) {
    this.channelsRepository = new ChannelsRepository(supabase);
  }

  async uploadProfileAvatar(
    user: AuthUser,
    body: Buffer,
    mimeType: string,
  ): Promise<{ url: string }> {
    const extension = this.requireAvatarMimeType(mimeType);
    this.requireBodySize(body, maxAvatarBytes);
    const path = `${user.id}/${randomUUID()}.${extension}`;
    await this.upload('profile-avatars', path, body, mimeType);
    return { url: this.publicStorageUrl('profile-avatars', path) };
  }

  async uploadServerIcon(
    user: AuthUser,
    serverId: string,
    body: Buffer,
    mimeType: string,
  ): Promise<{ url: string }> {
    await this.permissionsService.assertServerPermission(user, serverId, Permission.ManageServer);

    const extension = this.requireAvatarMimeType(mimeType);
    this.requireBodySize(body, maxAvatarBytes);
    const path = `${serverId}/${randomUUID()}.${extension}`;
    await this.upload('server-icons', path, body, mimeType);
    return { url: this.publicStorageUrl('server-icons', path) };
  }

  async uploadEncryptedMessageMedia(
    user: AuthUser,
    channelId: string,
    body: Buffer,
  ): Promise<CreateAttachmentInput> {
    this.requireBodySize(body, maxMessageMediaBytes);
    const channel = await this.channelsRepository.findById(channelId);
    if (!channel) {
      throw new NotFoundException('Channel not found.');
    }
    if (channel.type !== ChannelType.Text || !channel.serverId) {
      throw new ForbiddenException('Only server text channel media uploads are supported.');
    }

    await this.permissionsService.assertChannelPermission(user, channelId, Permission.AttachFiles);
    const path = `${channelId}/${user.id}/${randomUUID()}.bin`;
    await this.upload('message-media', path, body, 'application/octet-stream');

    return {
      storagePath: path,
      mimeType: 'application/octet-stream',
      byteSize: body.byteLength,
      isE2ee: true,
    };
  }

  private requireAvatarMimeType(mimeType: string): string {
    const extension = avatarExtensions.get(mimeType);
    if (!extension) {
      throw new BadRequestException('Format accepté : PNG, JPEG ou WebP.');
    }

    return extension;
  }

  private requireBodySize(body: Buffer, maxBytes: number): void {
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new BadRequestException('File body is required.');
    }
    if (body.byteLength > maxBytes) {
      throw new BadRequestException('File is too large.');
    }
  }

  private async upload(
    bucket: 'profile-avatars' | 'server-icons' | 'message-media',
    path: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const { error } = await this.supabase.storage.from(bucket).upload(path, body, {
      contentType,
      upsert: false,
    });

    if (error) {
      throw new BadRequestException(error.message);
    }
  }

  private publicStorageUrl(bucket: 'profile-avatars' | 'server-icons', path: string): string {
    return `${new URL(this.env.SUPABASE_URL).origin}/storage/v1/object/public/${bucket}/${path}`;
  }
}
