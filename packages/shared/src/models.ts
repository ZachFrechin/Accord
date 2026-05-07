import type {
  AttachmentId,
  ChannelId,
  ConversationId,
  DeviceId,
  EmbedId,
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

export interface InstanceConfig {
  instanceId: string;
  instanceName: string;
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  gatewayUrl: string;
  livekitUrl: string;
  capabilities: string[];
  minClientVersion?: string;
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

export const MessageEmbedType = {
  YouTube: 'youtube',
  Image: 'image',
  Link: 'link',
} as const;

export type MessageEmbedType = (typeof MessageEmbedType)[keyof typeof MessageEmbedType];

export interface MessageAttachment {
  id: AttachmentId;
  url: string;
  storagePath: string;
  mimeType: string;
  byteSize: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  isE2ee: boolean;
  encrypted?: EncryptedPayload | null;
}

export interface MessageEmbed {
  id: EmbedId;
  type: MessageEmbedType;
  url: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  provider?: string;
  embedUrl?: string;
}

export interface CreateAttachmentInput {
  storagePath: string;
  mimeType: string;
  byteSize: number;
  fileName?: string;
  encrypted?: EncryptedPayload | null;
  isE2ee?: boolean;
}

export interface CreateMessageInput {
  content?: string;
  privacy: MessagePrivacy;
  encrypted?: EncryptedPayload | null;
  attachments?: CreateAttachmentInput[];
}

export interface MessageRecord {
  id: MessageId;
  channelId: ChannelId;
  authorId: UserId;
  author?: Pick<UserProfile, 'id' | 'displayName' | 'avatarUrl'>;
  mentions?: MessageMention[];
  attachments: MessageAttachment[];
  embeds: MessageEmbed[];
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

export interface CryptoDevice {
  id: DeviceId;
  userId: UserId;
  publicKey: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PublishCryptoDeviceInput {
  deviceId: DeviceId;
  publicKey: string;
}

export interface WrappedConversationKey {
  conversationId: ConversationId;
  deviceId: DeviceId;
  keyVersion: number;
  wrappedKey: string;
}

export interface BootstrapConversationInput {
  deviceId: DeviceId;
  currentKeyVersion: number;
  wrappedKeys: Array<{
    deviceId: DeviceId;
    keyVersion: number;
    wrappedKey: string;
  }>;
}

export interface ConversationBootstrapResult {
  conversationId: ConversationId;
  channelId: ChannelId;
  currentKeyVersion: number;
}

export interface E2eeConversationState extends ConversationBootstrapResult {
  keys: WrappedConversationKey[];
}

export interface SignedAttachmentUrl {
  url: string;
  expiresAt: string;
}
