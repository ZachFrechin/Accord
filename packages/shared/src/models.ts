import type {
  ChannelId,
  ConversationId,
  DeviceId,
  InviteId,
  MessageId,
  RoleId,
  ServerId,
  UserId,
} from './ids';

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

export interface UserProfile {
  id: UserId;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface ServerSummary {
  id: ServerId;
  name: string;
  ownerId: UserId;
  avatarUrl: string | null;
  role: ServerMember['role'];
  createdAt: string;
}

export interface ServerMember {
  serverId: ServerId;
  userId: UserId;
  role: 'owner' | 'admin' | 'member';
}

export interface ServerRole {
  id: RoleId;
  serverId: ServerId;
  name: string;
  color: string;
  mentionable: boolean;
  position: number;
  createdAt: string;
}

export interface ServerMemberProfile extends ServerMember {
  profile: Pick<UserProfile, 'id' | 'displayName' | 'avatarUrl'>;
  roleIds: RoleId[];
}

export interface ChannelSummary {
  id: ChannelId;
  serverId: ServerId | null;
  type: ChannelType;
  name: string;
  isPrivate: boolean;
  createdAt: string | null;
}

export interface CreateServerInput {
  name: string;
}

export interface UpdateProfileInput {
  displayName: string;
  avatarUrl: string | null;
}

export interface UpdateServerInput {
  name?: string;
  avatarUrl?: string | null;
}

export interface CreateServerRoleInput {
  name: string;
  color: string;
  mentionable: boolean;
}

export interface UpdateServerRoleInput {
  name?: string;
  color?: string;
  mentionable?: boolean;
}

export interface UpdateMemberRolesInput {
  roleIds: RoleId[];
}

export interface CreateChannelInput {
  name: string;
  type: typeof ChannelType.Text | typeof ChannelType.Voice;
}

export interface UpdateChannelInput {
  name: string;
}

export interface DeleteChannelResult {
  channelId: ChannelId;
}

export interface VoiceTokenResponse {
  room: string;
  token: string;
}

export interface InviteRecord {
  id: InviteId;
  serverId: ServerId;
  code: string;
  createdBy: UserId;
  expiresAt: string | null;
  usedBy?: UserId | null;
  usedAt?: string | null;
  createdAt?: string;
}

export interface RedeemInviteResult {
  server: ServerSummary;
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
  author?: Pick<UserProfile, 'id' | 'displayName' | 'avatarUrl'>;
  mentions?: MessageMention[];
  privacy: MessagePrivacy;
  content: string | null;
  encrypted: EncryptedPayload | null;
  createdAt: string;
  editedAt: string | null;
}

export type MessageMention =
  | {
      type: 'user';
      userId: UserId;
      displayName: string;
      avatarUrl: string | null;
    }
  | {
      type: 'role';
      roleId: RoleId;
      name: string;
      color: string;
    };

export interface ConversationKeyRecord {
  conversationId: ConversationId;
  keyVersion: number;
  wrappedKey: string;
  deviceId: DeviceId;
}
