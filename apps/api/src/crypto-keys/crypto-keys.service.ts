import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelsRepository, CryptoRepository } from '@discord2/db';
import {
  ChannelType,
  type AuthUser,
  type BootstrapConversationInput,
  type ChannelId,
  type ConversationId,
  type CryptoDevice,
  type E2eeConversationState,
  type PublishCryptoDeviceInput,
  type ServerId,
  type WrappedConversationKey,
} from '@discord2/shared';
import { ServersService } from '../servers/servers.service';

@Injectable()
export class CryptoKeysService {
  private readonly repository: CryptoRepository;
  private readonly channelsRepository: ChannelsRepository;

  constructor(
    @Inject('SUPABASE_SERVICE_CLIENT') supabase: SupabaseClient,
    private readonly serversService: ServersService,
  ) {
    this.repository = new CryptoRepository(supabase);
    this.channelsRepository = new ChannelsRepository(supabase);
  }

  publishDevice(user: AuthUser, input: PublishCryptoDeviceInput): Promise<CryptoDevice> {
    return this.repository.upsertDevice({
      deviceId: input.deviceId,
      userId: user.id,
      publicKey: input.publicKey,
    });
  }

  async listServerDevices(user: AuthUser, serverId: ServerId): Promise<CryptoDevice[]> {
    await this.serversService.requireMembership(user, serverId);
    return this.repository.listActiveDevicesForServer(serverId);
  }

  async getConversation(user: AuthUser, channelId: ChannelId): Promise<E2eeConversationState> {
    await this.requireTextChannelMembership(user, channelId);
    const state = await this.repository.findConversationByChannel(channelId);
    if (!state) {
      throw new NotFoundException('Conversation keys are not available.');
    }

    const allowedDeviceIds = new Set(
      (await this.repository.listActiveDevicesForUser(user.id)).map((device) => device.id),
    );

    return {
      ...state,
      keys: state.keys.filter((key) => allowedDeviceIds.has(key.deviceId)),
    };
  }

  async bootstrapConversation(
    user: AuthUser,
    channelId: ChannelId,
    input: BootstrapConversationInput,
  ): Promise<E2eeConversationState> {
    const serverId = await this.requireTextChannelMembership(user, channelId);
    const devices = await this.repository.listActiveDevicesForServer(serverId);
    assertWrappedKeysTargetKnownDevices(input.wrappedKeys, devices);
    await this.requireOwnDevice(user, input.deviceId);

    return this.repository.bootstrapConversation({
      channelId,
      currentKeyVersion: input.currentKeyVersion,
      wrappedKeys: input.wrappedKeys,
    });
  }

  async addConversationKeys(
    user: AuthUser,
    conversationId: ConversationId,
    wrappedKeys: WrappedConversationKey[],
  ): Promise<WrappedConversationKey[]> {
    if (wrappedKeys.length === 0) {
      throw new BadRequestException('At least one wrapped key is required.');
    }

    const conversation = await this.repository.findConversationById(conversationId);
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    const serverId = await this.requireTextChannelMembership(user, conversation.channelId);
    const devices = await this.repository.listActiveDevicesForServer(serverId);
    assertWrappedKeysTargetKnownDevices(
      wrappedKeys.map((k) => ({
        deviceId: k.deviceId,
        keyVersion: k.keyVersion,
        wrappedKey: k.wrappedKey,
      })),
      devices,
    );
    await this.requireAnyOwnDevice(user);
    return this.repository.insertConversationKeys(conversationId, wrappedKeys);
  }

  async revokeDevice(user: AuthUser, deviceId: string): Promise<void> {
    const devices = await this.repository.listActiveDevicesForUser(user.id);
    if (!devices.some((device) => device.id === deviceId)) {
      throw new ForbiddenException('Device is not registered for this user.');
    }

    await this.repository.revokeDevice(deviceId, user.id);
  }

  private async requireTextChannelMembership(
    user: AuthUser,
    channelId: ChannelId,
  ): Promise<ServerId> {
    const channel = await this.channelsRepository.findById(channelId);
    if (!channel || !channel.serverId) {
      throw new NotFoundException('Channel not found.');
    }

    if (channel.type !== ChannelType.Text) {
      throw new ForbiddenException('Only text channels use conversation keys.');
    }

    await this.serversService.requireMembership(user, channel.serverId);
    return channel.serverId;
  }

  private async requireOwnDevice(user: AuthUser, deviceId: string): Promise<void> {
    const devices = await this.repository.listActiveDevicesForUser(user.id);
    if (!devices.some((device) => device.id === deviceId)) {
      throw new ForbiddenException('Device is not registered for this user.');
    }
  }

  private async requireAnyOwnDevice(user: AuthUser): Promise<void> {
    const devices = await this.repository.listActiveDevicesForUser(user.id);
    if (devices.length === 0) {
      throw new ForbiddenException('No active device is registered for this user.');
    }
  }
}

function assertWrappedKeysTargetKnownDevices(
  wrappedKeys: BootstrapConversationInput['wrappedKeys'],
  devices: CryptoDevice[],
): void {
  if (wrappedKeys.length === 0) {
    throw new BadRequestException('At least one wrapped key is required.');
  }

  const knownDeviceIds = new Set(devices.map((device) => device.id));
  for (const key of wrappedKeys) {
    if (!knownDeviceIds.has(key.deviceId)) {
      throw new BadRequestException('Wrapped key targets an unknown device.');
    }
  }
}
