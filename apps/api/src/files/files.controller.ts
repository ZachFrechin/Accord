import { Controller, Get } from '@nestjs/common';

@Controller('files')
export class FilesController {
  @Get('limits')
  limits(): { maxBytes: number; encryptedUploads: true } {
    return {
      maxBytes: 25 * 1024 * 1024,
      encryptedUploads: true,
    };
  }
}
