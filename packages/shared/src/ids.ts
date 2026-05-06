export type UserId = string;
export type ServerId = string;
export type ChannelId = string;
export type MessageId = string;
export type InviteId = string;
export type DeviceId = string;
export type ConversationId = string;

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
