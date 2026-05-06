import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, MessagePrivacy, type AuthUser } from '@discord2/shared';

const repositoryMocks = vi.hoisted(() => ({
  channels: {
    findById: vi.fn(),
  },
  invites: {
    create: vi.fn(),
    findActiveByCode: vi.fn(),
    markUsed: vi.fn(),
  },
  messages: {
    insert: vi.fn(),
    listByChannel: vi.fn(),
  },
  servers: {
    addMember: vi.fn(),
    create: vi.fn(),
    findByIdForUser: vi.fn(),
    findMembership: vi.fn(),
    listForUser: vi.fn(),
  },
}));

vi.mock('@discord2/db', () => ({
  ChannelsRepository: vi.fn(function ChannelsRepository() {
    return repositoryMocks.channels;
  }),
  InvitesRepository: vi.fn(function InvitesRepository() {
    return repositoryMocks.invites;
  }),
  MessagesRepository: vi.fn(function MessagesRepository() {
    return repositoryMocks.messages;
  }),
  ServersRepository: vi.fn(function ServersRepository() {
    return repositoryMocks.servers;
  }),
}));

const supabase = {} as SupabaseClient;
const user: AuthUser = { id: 'user-1', email: 'user@example.com' };

describe('api service behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a server owned by the authenticated user', async () => {
    const { ServersService } = await import('./servers/servers.service');
    const service = new ServersService(supabase);
    const server = {
      id: 'server-1',
      name: 'Core',
      ownerId: user.id,
      role: 'owner',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    repositoryMocks.servers.create.mockResolvedValue(server);

    await expect(service.createServer(user, { name: ' Core ' })).resolves.toEqual(server);
    expect(repositoryMocks.servers.create).toHaveBeenCalledWith({
      name: 'Core',
      ownerId: user.id,
    });
  });

  it('publishes a message.created event after persisting a public text message', async () => {
    const { MessagesService } = await import('./messages/messages.service');
    const serversService = { requireMembership: vi.fn().mockResolvedValue({ id: 'server-1' }) };
    const usersService = {
      me: vi.fn().mockResolvedValue({
        id: user.id,
        displayName: 'User',
        avatarUrl: null,
      }),
    };
    const eventsPublisher = { publishMessageCreated: vi.fn().mockResolvedValue(undefined) };
    const service = new MessagesService(
      supabase,
      serversService as never,
      usersService as never,
      eventsPublisher as never,
    );
    const message = {
      id: 'message-1',
      channelId: 'channel-1',
      authorId: user.id,
      privacy: MessagePrivacy.Public,
      content: 'hello',
      encrypted: null,
      createdAt: '2026-05-06T00:00:00.000Z',
      editedAt: null,
    };
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Text,
      name: 'general',
      isPrivate: false,
      createdAt: null,
    });
    repositoryMocks.messages.insert.mockResolvedValue(message);

    await expect(
      service.createMessage(user, 'channel-1', {
        privacy: MessagePrivacy.Public,
        content: ' hello ',
      }),
    ).resolves.toMatchObject({
      id: 'message-1',
      content: 'hello',
      author: {
        id: user.id,
        displayName: 'User',
        avatarUrl: null,
      },
    });
    expect(serversService.requireMembership).toHaveBeenCalledWith(user, 'server-1');
    expect(eventsPublisher.publishMessageCreated).toHaveBeenCalledWith({
      channelId: 'channel-1',
      message: expect.objectContaining({ id: 'message-1', content: 'hello' }),
    });
  });

  it('rejects messages outside public text server channels for this iteration', async () => {
    const { MessagesService } = await import('./messages/messages.service');
    const service = new MessagesService(
      supabase,
      { requireMembership: vi.fn() } as never,
      { me: vi.fn() } as never,
      { publishMessageCreated: vi.fn() } as never,
    );
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Voice,
      name: 'voice',
      isPrivate: false,
      createdAt: null,
    });

    await expect(
      service.createMessage(user, 'channel-1', {
        privacy: MessagePrivacy.Public,
        content: 'hello',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repositoryMocks.messages.insert).not.toHaveBeenCalled();
  });

  it('redeems active invitations by adding membership and marking the invite used', async () => {
    const { InvitesService } = await import('./invites/invites.service');
    const service = new InvitesService(supabase);
    const server = {
      id: 'server-1',
      name: 'Core',
      ownerId: 'owner-1',
      role: 'member',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    repositoryMocks.invites.findActiveByCode.mockResolvedValue({
      id: 'invite-1',
      serverId: server.id,
      code: 'CODE',
      createdBy: 'owner-1',
      expiresAt: null,
    });
    repositoryMocks.servers.findByIdForUser.mockResolvedValue(server);

    await expect(service.redeemInvite(user, 'CODE')).resolves.toEqual({ server });
    expect(repositoryMocks.servers.addMember).toHaveBeenCalledWith({
      serverId: server.id,
      userId: user.id,
    });
    expect(repositoryMocks.invites.markUsed).toHaveBeenCalledWith({
      inviteId: 'invite-1',
      userId: user.id,
    });
  });

  it('returns a public 404 for invalid invitation codes', async () => {
    const { InvitesService } = await import('./invites/invites.service');
    const service = new InvitesService(supabase);
    repositoryMocks.invites.findActiveByCode.mockResolvedValue(null);

    await expect(service.redeemInvite(user, 'BAD')).rejects.toBeInstanceOf(NotFoundException);
  });
});
