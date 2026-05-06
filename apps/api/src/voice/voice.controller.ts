import { Controller, Param, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { VoiceService } from './voice.service';

@Controller('voice')
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  @Post('channels/:channelId/token')
  createToken(@CurrentUser() user: AuthUser, @Param('channelId') channelId: string) {
    return this.voiceService.createJoinToken(user, channelId);
  }
}
