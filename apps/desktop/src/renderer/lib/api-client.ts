import type { Session } from '@supabase/supabase-js';
import type {
  ChannelSummary,
  CreateChannelInput,
  CreateServerInput,
  DeleteChannelResult,
  InviteRecord,
  MessagePrivacy,
  MessageRecord,
  RedeemInviteResult,
  ServerSummary,
  UpdateChannelInput,
  UpdateProfileInput,
  UpdateServerInput,
  UserProfile,
  VoiceTokenResponse,
} from '@discord2/shared';
import { env } from './env';

export class ApiClient {
  constructor(private readonly session: Session) {}

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
    create: (channelId: string, input: { content: string; privacy: MessagePrivacy }) =>
      this.request<MessageRecord>(`/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
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
    const response = await fetch(`${env.VITE_API_URL}${path}`, {
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
