import { Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, CreateAttachmentInput } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get('limits')
  limits(): { maxBytes: number; encryptedUploads: true } {
    return {
      maxBytes: 25 * 1024 * 1024,
      encryptedUploads: true,
    };
  }

  @Post('upload/profile-avatar')
  uploadProfileAvatar(
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Headers('content-type') contentType = 'application/octet-stream',
  ): Promise<{ url: string }> {
    return this.filesService.uploadProfileAvatar(user, request.body as Buffer, contentType);
  }

  @Post('upload/server-icons/:serverId')
  uploadServerIcon(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Req() request: Request,
    @Headers('content-type') contentType = 'application/octet-stream',
  ): Promise<{ url: string }> {
    return this.filesService.uploadServerIcon(user, serverId, request.body as Buffer, contentType);
  }

  @Post('upload/message-media/:channelId')
  uploadMessageMedia(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Req() request: Request,
  ): Promise<CreateAttachmentInput> {
    return this.filesService.uploadEncryptedMessageMedia(user, channelId, request.body as Buffer);
  }
}
