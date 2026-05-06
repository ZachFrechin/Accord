import type { ChannelId, ConversationId, DeviceId, MessageId, ServerId, UserId } from './ids';

export const ChannelType = {
  Text: 'text',
  PrivateText: 'private_text',
  Voice: 'voice',
  DirectMessage: 'direct_message',
} as const;

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

export const MessagePrivacy = {
  Public: 'public',
  EndToEndEncrypted: 'e2ee',
} as const;

export type MessagePrivacy = (typeof MessagePrivacy)[keyof typeof MessagePrivacy];

export const PresenceStatus = {
  Online: 'online',
  Idle: 'idle',
  Offline: 'offline',
} as const;

export type PresenceStatus = (typeof PresenceStatus)[keyof typeof PresenceStatus];

export interface AuthUser {
  id: UserId;
  email: string | null;
}

export interface ServerMember {
  serverId: ServerId;
  userId: UserId;
  role: 'owner' | 'admin' | 'member';
}

export interface ChannelSummary {
  id: ChannelId;
  serverId: ServerId | null;
  type: ChannelType;
  name: string;
  isPrivate: boolean;
}

export interface EncryptedPayload {
  algorithm: 'xchacha20poly1305-ietf';
  ciphertext: string;
  nonce: string;
  keyVersion: number;
  senderDeviceId: DeviceId;
}

export interface MessageRecord {
  id: MessageId;
  channelId: ChannelId;
  authorId: UserId;
  privacy: MessagePrivacy;
  content: string | null;
  encrypted: EncryptedPayload | null;
  createdAt: string;
  editedAt: string | null;
}

export interface ConversationKeyRecord {
  conversationId: ConversationId;
  keyVersion: number;
  wrappedKey: string;
  deviceId: DeviceId;
}
