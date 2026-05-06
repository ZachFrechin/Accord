import { Controller, Get } from '@nestjs/common';

@Controller('crypto-keys')
export class CryptoKeysController {
  @Get('policy')
  policy(): { deviceModel: 'single-device-v1'; textE2eeScope: 'dm-and-private-channels' } {
    return {
      deviceModel: 'single-device-v1',
      textE2eeScope: 'dm-and-private-channels',
    };
  }
}
