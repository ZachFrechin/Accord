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
  TypingStarted: 'typing:started',
  TypingStopped: 'typing:stopped',
  PresenceUpdated: 'presence:updated',
  VoicePresenceUpdated: 'voice:presence-updated',
  MemberRemoved: 'member:removed',
  Error: 'error',
} as const;

export const InternalRealtimeEvent = {
  MessageCreated: 'message.created',
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

export interface MessageAck {
  accepted: boolean;
  messageId?: MessageId;
  error?: string;
}
