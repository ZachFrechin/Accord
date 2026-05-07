import type { Session } from '@supabase/supabase-js';
import type {
  ChannelSummary,
  CreateChannelInput,
  CreateMessageInput,
  CreateServerInput,
  CreateServerRoleInput,
  DeleteChannelResult,
  InviteRecord,
  MessageRecord,
  RedeemInviteResult,
  ServerSummary,
  ServerMemberProfile,
  ServerRole,
  SignedAttachmentUrl,
  UpdateChannelInput,
  UpdateMemberRolesInput,
  UpdateProfileInput,
  UpdateServerRoleInput,
  UpdateServerInput,
  UserProfile,
  VoiceTokenResponse,
  BootstrapConversationInput,
  ConversationBootstrapResult,
  CryptoDevice,
  E2eeConversationState,
  InstanceConfig,
  PublishCryptoDeviceInput,
} from '@discord2/shared';

export class ApiClient {
  constructor(
    private readonly session: Session,
    private readonly instance: InstanceConfig,
  ) {}

  readonly users = {
    me: () => this.request<UserProfile>('/users/me'),
    getById: (id: string) => this.request<UserProfile>(`/users/${encodeURIComponent(id)}`),
    updateMe: (input: UpdateProfileInput) =>
      this.request<UserProfile>('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  };

  readonly servers = {
    list: () => this.request<ServerSummary[]>('/servers'),
    create: (input: CreateServerInput) =>
      this.request<ServerSummary>('/servers', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (serverId: string, input: UpdateServerInput) =>
      this.request<ServerSummary>(`/servers/${serverId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  };

  readonly roles = {
    list: (serverId: string) => this.request<ServerRole[]>(`/servers/${serverId}/roles`),
    create: (serverId: string, input: CreateServerRoleInput) =>
      this.request<ServerRole>(`/servers/${serverId}/roles`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (serverId: string, roleId: string, input: UpdateServerRoleInput) =>
      this.request<ServerRole>(`/servers/${serverId}/roles/${roleId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    delete: (serverId: string, roleId: string) =>
      this.request<{ roleId: string }>(`/servers/${serverId}/roles/${roleId}`, {
        method: 'DELETE',
      }),
    members: (serverId: string) =>
      this.request<ServerMemberProfile[]>(`/servers/${serverId}/members`),
    updateMemberRoles: (serverId: string, userId: string, input: UpdateMemberRolesInput) =>
      this.request<ServerMemberProfile>(`/servers/${serverId}/members/${userId}/roles`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    removeMember: (serverId: string, userId: string) =>
      this.request<void>(`/servers/${serverId}/members/${userId}`, {
        method: 'DELETE',
      }),
  };

  readonly channels = {
    list: (serverId: string) => this.request<ChannelSummary[]>(`/servers/${serverId}/channels`),
    create: (serverId: string, input: CreateChannelInput) =>
      this.request<ChannelSummary>(`/servers/${serverId}/channels`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (serverId: string, channelId: string, input: UpdateChannelInput) =>
      this.request<ChannelSummary>(`/servers/${serverId}/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    delete: (serverId: string, channelId: string) =>
      this.request<DeleteChannelResult>(`/servers/${serverId}/channels/${channelId}`, {
        method: 'DELETE',
      }),
  };

  readonly messages = {
    list: (channelId: string) => this.request<MessageRecord[]>(`/channels/${channelId}/messages`),
    create: (channelId: string, input: CreateMessageInput) =>
      this.request<MessageRecord>(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getAttachmentUrl: (messageId: string, attachmentId: string) =>
      this.request<SignedAttachmentUrl>(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/url`,
      ),
  };

  readonly crypto = {
    publishDevice: (input: PublishCryptoDeviceInput) =>
      this.request<CryptoDevice>('/crypto/devices', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listServerDevices: (serverId: string) =>
      this.request<CryptoDevice[]>(`/crypto/devices/server/${serverId}`),
    getConversation: (channelId: string) =>
      this.request<E2eeConversationState>(`/crypto/conversations/${channelId}`),
    bootstrapConversation: (channelId: string, input: BootstrapConversationInput) =>
      this.request<ConversationBootstrapResult>(
        `/crypto/conversations/${channelId}/bootstrap`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    addConversationKeys: (
      conversationId: string,
      wrappedKeys: Array<{ conversationId: string; deviceId: string; keyVersion: number; wrappedKey: string }>,
    ) =>
      this.request<unknown>(`/crypto/conversations/${encodeURIComponent(conversationId)}/keys`, {
        method: 'POST',
        body: JSON.stringify({ wrappedKeys }),
      }),
  };

  readonly files = {
    limits: () => this.request<{ maxBytes: number; encryptedUploads: true }>('/files/limits'),
  };

  readonly invites = {
    create: (serverId: string) =>
      this.request<InviteRecord>(`/servers/${serverId}/invites`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    redeem: (code: string) =>
      this.request<RedeemInviteResult>(`/invites/${encodeURIComponent(code)}/redeem`, {
        method: 'POST',
      }),
  };

  readonly voice = {
    createToken: (channelId: string) =>
      this.request<VoiceTokenResponse>(`/voice/channels/${channelId}/token`, {
        method: 'POST',
      }),
  };

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.instance.apiUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new Error(message || `API request failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(payload.message)) {
      return payload.message.join(', ');
    }

    return payload.message ?? null;
  } catch {
    return null;
  }
}
