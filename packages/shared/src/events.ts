import type { ChannelId, MessageId, ServerId, UserId } from './ids';
import type { MessageRecord, PresenceStatus } from './models';

export const ClientToServerEvent = {
  ChannelJoin: 'channel:join',
  ChannelLeave: 'channel:leave',
  TypingStart: 'typing:start',
  TypingStop: 'typing:stop',
  PresenceUpdate: 'presence:update',
  VoiceJoin: 'voice:join',
  VoiceLeave: 'voice:leave',
} as const;

export const ServerToClientEvent = {
  MessageCreated: 'message:created',
  MessageUpdated: 'message:updated',
  MessageDeleted: 'message:deleted',
  MessageReactionUpdated: 'message:reaction-updated',
  ServerStateChanged: 'server:state-changed',
  TypingStarted: 'typing:started',
  TypingStopped: 'typing:stopped',
  PresenceUpdated: 'presence:updated',
  VoicePresenceUpdated: 'voice:presence-updated',
  MemberRemoved: 'member:removed',
  Error: 'error',
} as const;

export const InternalRealtimeEvent = {
  MessageCreated: 'message.created',
  MessageUpdated: 'message.updated',
  MessageDeleted: 'message.deleted',
  MessageReactionUpdated: 'message.reaction_updated',
  ServerStateChanged: 'server.state_changed',
  MemberRemoved: 'member.removed',
} as const;

export interface ChannelJoinPayload {
  channelId: ChannelId;
}

export interface TypingPayload {
  channelId: ChannelId;
}

export interface PresenceUpdatePayload {
  status: PresenceStatus;
}

export interface VoiceJoinPayload {
  channelId: ChannelId;
}

export interface MessageCreatedEvent {
  channelId: ChannelId;
  message: MessageRecord;
}

export interface MessageDeletedEvent {
  channelId: ChannelId;
  messageId: MessageId;
}

export interface MessageUpdatedEvent {
  channelId: ChannelId;
  message: MessageRecord;
}

export interface MessageReactionUpdatedEvent {
  channelId: ChannelId;
  messageId: MessageId;
  userId: UserId;
  reactions: MessageRecord['reactions'];
}

export interface TypingEvent {
  channelId: ChannelId;
  userId: UserId;
}

export interface PresenceEvent {
  userId: UserId;
  status: PresenceStatus;
}

export interface VoicePresenceEvent {
  channelId: ChannelId;
  userIds: UserId[];
}

export interface MemberRemovedEvent {
  serverId: ServerId;
  userId: UserId;
}

export interface ServerStateChangedEvent {
  serverId: ServerId;
  userIds: UserId[];
  reason: 'server' | 'roles' | 'members' | 'channels' | 'permissions' | 'bans';
  targetUserId?: UserId;
}

export interface MessageAck {
  accepted: boolean;
  messageId?: MessageId;
  error?: string;
}
