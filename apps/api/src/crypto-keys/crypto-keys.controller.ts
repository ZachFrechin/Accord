import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type {
  AuthUser,
  ConversationBootstrapResult,
  CryptoDevice,
  E2eeConversationState,
  WrappedConversationKey,
} from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { AddConversationKeysDto, BootstrapConversationDto, PublishCryptoDeviceDto } from './dto';
import { CryptoKeysService } from './crypto-keys.service';

@Controller('crypto')
export class CryptoKeysController {
  constructor(private readonly service: CryptoKeysService) {}

  @Get('policy')
  policy(): { deviceModel: 'single-device-v1'; textE2eeScope: 'all-new-messages' } {
    return {
      deviceModel: 'single-device-v1',
      textE2eeScope: 'all-new-messages',
    };
  }

  @Post('devices')
  publishDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto: PublishCryptoDeviceDto,
  ): Promise<CryptoDevice> {
    return this.service.publishDevice(user, dto);
  }

  @Get('devices/server/:serverId')
  listServerDevices(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
  ): Promise<CryptoDevice[]> {
    return this.service.listServerDevices(user, serverId);
  }

  @Get('conversations/:channelId')
  getConversation(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
  ): Promise<E2eeConversationState> {
    return this.service.getConversation(user, channelId);
  }

  @Post('conversations/:channelId/bootstrap')
  async bootstrapConversation(
    @CurrentUser() user: AuthUser,
    @Param('channelId') channelId: string,
    @Body() dto: BootstrapConversationDto,
  ): Promise<ConversationBootstrapResult> {
    const state = await this.service.bootstrapConversation(user, channelId, dto);
    return {
      conversationId: state.conversationId,
      channelId: state.channelId,
      currentKeyVersion: state.currentKeyVersion,
    };
  }

  @Delete('devices/:deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeDevice(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    return this.service.revokeDevice(user, deviceId);
  }

  @Post('conversations/:conversationId/keys')
  addConversationKeys(
    @CurrentUser() user: AuthUser,
    @Param('conversationId') conversationId: string,
    @Body() dto: AddConversationKeysDto,
  ): Promise<WrappedConversationKey[]> {
    return this.service.addConversationKeys(
      user,
      conversationId,
      dto.wrappedKeys.map((key) => ({
        conversationId,
        deviceId: key.deviceId,
        keyVersion: key.keyVersion,
        wrappedKey: key.wrappedKey,
      })),
    );
  }
}
