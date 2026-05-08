import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, MessagePrivacy, type AuthUser } from '@discord2/shared';

const repositoryMocks = vi.hoisted(() => ({
  channels: {
    createTextChannel: vi.fn(),
    createVoiceChannel: vi.fn(),
    delete: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  },
  invites: {
    create: vi.fn(),
    findActiveByCode: vi.fn(),
    markUsed: vi.fn(),
  },
  messages: {
    insert: vi.fn(),
    insertAttachments: vi.fn(),
    insertEmbeds: vi.fn(),
    listAttachmentsForMessages: vi.fn(),
    listByChannel: vi.fn(),
    listEmbedsForMessages: vi.fn(),
  },
  profiles: {
    findByUserId: vi.fn(),
    updateForUser: vi.fn(),
    upsertFromAuthUser: vi.fn(),
  },
  roles: {
    insertMessageMentions: vi.fn(),
    listMentionsForMessages: vi.fn(),
    listMembers: vi.fn(),
    listRoles: vi.fn(),
  },
  servers: {
    addMember: vi.fn(),
    create: vi.fn(),
    findBan: vi.fn(),
    findByIdForUser: vi.fn(),
    findMembership: vi.fn(),
    listForUser: vi.fn(),
    update: vi.fn(),
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
  ProfilesRepository: vi.fn(function ProfilesRepository() {
    return repositoryMocks.profiles;
  }),
  RolesRepository: vi.fn(function RolesRepository() {
    return repositoryMocks.roles;
  }),
  ServersRepository: vi.fn(function ServersRepository() {
    return repositoryMocks.servers;
  }),
}));

const supabase = {} as SupabaseClient;
const user: AuthUser = { id: 'user-1', email: 'user@example.com' };

const permissionsService = {
  assertServerPermission: vi.fn().mockResolvedValue({ permissions: [] }),
  assertChannelPermission: vi
    .fn()
    .mockResolvedValue({ channel: null, effective: { permissions: [] } }),
  assertCanManageTargetMember: vi.fn().mockResolvedValue(undefined),
  assertCanManageRole: vi.fn().mockResolvedValue(undefined),
  listVisibleChannels: vi.fn(),
};

const eventsPublisher = {
  publishServerStateChanged: vi.fn().mockResolvedValue(undefined),
};

describe('api service behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionsService.assertServerPermission.mockResolvedValue({ permissions: [] });
    permissionsService.assertChannelPermission.mockResolvedValue({
      channel: null,
      effective: { permissions: [] },
    });
    permissionsService.assertCanManageTargetMember.mockResolvedValue(undefined);
    permissionsService.assertCanManageRole.mockResolvedValue(undefined);
    permissionsService.listVisibleChannels.mockReset();
    repositoryMocks.roles.listMembers.mockResolvedValue([]);
    repositoryMocks.servers.findBan.mockResolvedValue(null);
    eventsPublisher.publishServerStateChanged.mockResolvedValue(undefined);
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    process.env.LIVEKIT_URL = 'https://livekit.test';
    process.env.LIVEKIT_API_KEY = 'livekit-key';
    process.env.LIVEKIT_API_SECRET = 'livekit-secret';
  });

  it('creates a server owned by the authenticated user', async () => {
    const { ServersService } = await import('./servers/servers.service');
    const service = new ServersService(supabase, permissionsService as never);
    const server = {
      id: 'server-1',
      name: 'Core',
      ownerId: user.id,
      avatarUrl: null,
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

  it('updates only the authenticated user profile', async () => {
    const { UsersService } = await import('./users/users.service');
    const service = new UsersService(supabase);
    const profile = {
      id: user.id,
      email: user.email,
      displayName: 'New Name',
      avatarUrl: 'https://supabase.test/storage/v1/object/public/profile-avatars/user-1/a.png',
    };
    repositoryMocks.profiles.upsertFromAuthUser.mockResolvedValue(profile);
    repositoryMocks.profiles.updateForUser.mockResolvedValue(profile);

    await expect(
      service.updateMe(user, {
        displayName: ' New Name ',
        avatarUrl: profile.avatarUrl,
      }),
    ).resolves.toEqual(profile);
    expect(repositoryMocks.profiles.updateForUser).toHaveBeenCalledWith(user, {
      displayName: 'New Name',
      avatarUrl: profile.avatarUrl,
    });
  });

  it('allows owners and admins to create voice channels', async () => {
    const { ChannelsService } = await import('./channels/channels.service');
    const serversService = {
      requireMembership: vi.fn().mockResolvedValue({
        id: 'server-1',
        role: 'admin',
      }),
    };
    const service = new ChannelsService(
      supabase,
      permissionsService as never,
      eventsPublisher as never,
    );
    const channel = {
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Voice,
      name: 'Voice',
      isPrivate: false,
      createdAt: null,
    };
    repositoryMocks.channels.createVoiceChannel.mockResolvedValue(channel);

    await expect(
      service.createChannel(user, 'server-1', {
        name: ' Voice ',
        type: ChannelType.Voice,
      }),
    ).resolves.toEqual(channel);
    expect(repositoryMocks.channels.createVoiceChannel).toHaveBeenCalledWith({
      serverId: 'server-1',
      name: 'Voice',
    });
  });

  it('rejects voice channel creation from regular members', async () => {
    const { ChannelsService } = await import('./channels/channels.service');
    const serversService = {
      requireMembership: vi.fn().mockResolvedValue({
        id: 'server-1',
        role: 'member',
      }),
    };
    const service = new ChannelsService(
      supabase,
      permissionsService as never,
      eventsPublisher as never,
    );
    permissionsService.assertServerPermission.mockRejectedValue(
      new ForbiddenException('Missing server permission.'),
    );

    await expect(
      service.createChannel(user, 'server-1', {
        name: 'Voice',
        type: ChannelType.Voice,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repositoryMocks.channels.createVoiceChannel).not.toHaveBeenCalled();
  });

  it('allows owners and admins to rename server channels', async () => {
    const { ChannelsService } = await import('./channels/channels.service');
    const serversService = {
      requireMembership: vi.fn().mockResolvedValue({
        id: 'server-1',
        role: 'admin',
      }),
    };
    const service = new ChannelsService(
      supabase,
      permissionsService as never,
      eventsPublisher as never,
    );
    const channel = {
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Text,
      name: 'general',
      isPrivate: false,
      createdAt: null,
    };
    const updated = { ...channel, name: 'annonces' };
    repositoryMocks.channels.findById.mockResolvedValue(channel);
    repositoryMocks.channels.update.mockResolvedValue(updated);

    await expect(
      service.updateChannel(user, 'server-1', 'channel-1', { name: ' annonces ' }),
    ).resolves.toEqual(updated);
    expect(repositoryMocks.channels.update).toHaveBeenCalledWith('channel-1', {
      name: 'annonces',
    });
  });

  it('rejects channel updates from regular members', async () => {
    const { ChannelsService } = await import('./channels/channels.service');
    const serversService = {
      requireMembership: vi.fn().mockResolvedValue({
        id: 'server-1',
        role: 'member',
      }),
    };
    const service = new ChannelsService(
      supabase,
      permissionsService as never,
      eventsPublisher as never,
    );
    permissionsService.assertServerPermission.mockRejectedValue(
      new ForbiddenException('Missing server permission.'),
    );
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Text,
      name: 'general',
      isPrivate: false,
      createdAt: null,
    });

    await expect(
      service.updateChannel(user, 'server-1', 'channel-1', { name: 'annonces' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repositoryMocks.channels.update).not.toHaveBeenCalled();
  });

  it('deletes manageable server channels', async () => {
    const { ChannelsService } = await import('./channels/channels.service');
    const serversService = {
      requireMembership: vi.fn().mockResolvedValue({
        id: 'server-1',
        role: 'owner',
      }),
    };
    const service = new ChannelsService(
      supabase,
      permissionsService as never,
      eventsPublisher as never,
    );
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Voice,
      name: 'Vocal',
      isPrivate: false,
      createdAt: null,
    });
    repositoryMocks.channels.delete.mockResolvedValue(undefined);

    await expect(service.deleteChannel(user, 'server-1', 'channel-1')).resolves.toEqual({
      channelId: 'channel-1',
    });
    expect(repositoryMocks.channels.delete).toHaveBeenCalledWith('channel-1');
  });

  it('returns not found when a channel does not belong to the requested server', async () => {
    const { ChannelsService } = await import('./channels/channels.service');
    const serversService = {
      requireMembership: vi.fn(),
    };
    const service = new ChannelsService(
      supabase,
      permissionsService as never,
      eventsPublisher as never,
    );
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-2',
      type: ChannelType.Text,
      name: 'general',
      isPrivate: false,
      createdAt: null,
    });

    await expect(service.deleteChannel(user, 'server-1', 'channel-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repositoryMocks.channels.delete).not.toHaveBeenCalled();
  });

  it('allows owners and admins to update server settings', async () => {
    const { ServersService } = await import('./servers/servers.service');
    const service = new ServersService(supabase, permissionsService as never);
    const updated = {
      id: 'server-1',
      name: 'Core Team',
      ownerId: user.id,
      avatarUrl: 'https://supabase.test/storage/v1/object/public/server-icons/server-1/icon.webp',
      role: 'member',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    repositoryMocks.servers.findMembership.mockResolvedValue({
      serverId: 'server-1',
      userId: user.id,
      role: 'admin',
    });
    repositoryMocks.servers.update.mockResolvedValue(updated);

    await expect(
      service.updateServer(user, 'server-1', {
        name: ' Core Team ',
        avatarUrl: updated.avatarUrl,
      }),
    ).resolves.toEqual({ ...updated, role: 'admin' });
    expect(repositoryMocks.servers.update).toHaveBeenCalledWith('server-1', {
      name: 'Core Team',
      avatarUrl: updated.avatarUrl,
    });
  });

  it('rejects server settings updates from regular members', async () => {
    const { ServersService } = await import('./servers/servers.service');
    const service = new ServersService(supabase, permissionsService as never);
    permissionsService.assertServerPermission.mockRejectedValue(
      new ForbiddenException('Missing server permission.'),
    );
    repositoryMocks.servers.findMembership.mockResolvedValue({
      serverId: 'server-1',
      userId: user.id,
      role: 'member',
    });

    await expect(
      service.updateServer(user, 'server-1', { name: 'Blocked' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repositoryMocks.servers.update).not.toHaveBeenCalled();
  });

  it('rejects avatar URLs outside the expected Supabase Storage bucket', async () => {
    const { ServersService } = await import('./servers/servers.service');
    const service = new ServersService(supabase, permissionsService as never);
    repositoryMocks.servers.findMembership.mockResolvedValue({
      serverId: 'server-1',
      userId: user.id,
      role: 'owner',
    });

    await expect(
      service.updateServer(user, 'server-1', {
        avatarUrl: 'https://supabase.test/storage/v1/object/public/profile-avatars/user-1/a.png',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repositoryMocks.servers.update).not.toHaveBeenCalled();
  });

  it('publishes a message.created event after persisting an E2EE text message', async () => {
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
    const rolesService = {
      insertMessageMentions: vi.fn().mockResolvedValue(undefined),
      listMentionsForMessages: vi.fn(),
      resolveMentions: vi.fn().mockResolvedValue([]),
    };
    const service = new MessagesService(
      supabase,
      serversService as never,
      usersService as never,
      rolesService as never,
      permissionsService as never,
      eventsPublisher as never,
    );
    const encrypted = {
      algorithm: 'xchacha20poly1305-ietf' as const,
      ciphertext: 'abc',
      nonce: 'nonce',
      keyVersion: 1,
      senderDeviceId: 'device-1',
    };
    const message = {
      id: 'message-1',
      channelId: 'channel-1',
      authorId: user.id,
      privacy: MessagePrivacy.EndToEndEncrypted,
      content: null,
      encrypted,
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
    repositoryMocks.messages.insertAttachments.mockResolvedValue([]);

    await expect(
      service.createMessage(user, 'channel-1', {
        privacy: MessagePrivacy.EndToEndEncrypted,
        encrypted,
      }),
    ).resolves.toMatchObject({
      id: 'message-1',
      content: null,
      author: {
        id: user.id,
        displayName: 'User',
        avatarUrl: null,
      },
      mentions: [],
    });
    expect(permissionsService.assertChannelPermission).toHaveBeenCalled();
    expect(repositoryMocks.messages.insertAttachments).toHaveBeenCalledWith('message-1', []);
    expect(eventsPublisher.publishMessageCreated).toHaveBeenCalledWith({
      channelId: 'channel-1',
      message: expect.objectContaining({ id: 'message-1', content: null }),
    });
  });

  it('accepts media-only E2EE messages with validated attachments', async () => {
    const { MessagesService } = await import('./messages/messages.service');
    const serversService = { requireMembership: vi.fn().mockResolvedValue({ id: 'server-1' }) };
    const usersService = {
      me: vi.fn().mockResolvedValue({
        id: user.id,
        displayName: 'User',
        avatarUrl: null,
      }),
    };
    const rolesService = {
      insertMessageMentions: vi.fn().mockResolvedValue(undefined),
      resolveMentions: vi.fn().mockResolvedValue([]),
    };
    const eventsPublisher = { publishMessageCreated: vi.fn().mockResolvedValue(undefined) };
    const service = new MessagesService(
      supabase,
      serversService as never,
      usersService as never,
      rolesService as never,
      permissionsService as never,
      eventsPublisher as never,
    );
    const encrypted = {
      algorithm: 'xchacha20poly1305-ietf' as const,
      ciphertext: 'abc',
      nonce: 'nonce',
      keyVersion: 1,
      senderDeviceId: 'device-1',
    };
    const message = {
      id: 'message-1',
      channelId: 'channel-1',
      authorId: user.id,
      privacy: MessagePrivacy.EndToEndEncrypted,
      content: null,
      encrypted,
      createdAt: '2026-05-06T00:00:00.000Z',
      editedAt: null,
    };
    const attachment = {
      storagePath: 'channel-1/user-1/file.bin',
      mimeType: 'application/octet-stream',
      byteSize: 1024,
      isE2ee: true,
      encrypted,
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
    repositoryMocks.messages.insertAttachments.mockResolvedValue([{ id: 'attachment-1' }]);

    await expect(
      service.createMessage(user, 'channel-1', {
        privacy: MessagePrivacy.EndToEndEncrypted,
        encrypted,
        attachments: [attachment],
      }),
    ).resolves.toMatchObject({
      id: 'message-1',
      content: null,
      attachments: [{ id: 'attachment-1' }],
    });
    expect(repositoryMocks.messages.insertAttachments).toHaveBeenCalledWith('message-1', [
      attachment,
    ]);
  });

  it('rejects attachments outside the expected message-media path', async () => {
    const { MessagesService } = await import('./messages/messages.service');
    const service = new MessagesService(
      supabase,
      { requireMembership: vi.fn().mockResolvedValue({ id: 'server-1' }) } as never,
      { me: vi.fn() } as never,
      { insertMessageMentions: vi.fn(), resolveMentions: vi.fn() } as never,
      permissionsService as never,
      { publishMessageCreated: vi.fn() } as never,
    );
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Text,
      name: 'general',
      isPrivate: false,
      createdAt: null,
    });
    const encrypted = {
      algorithm: 'xchacha20poly1305-ietf' as const,
      ciphertext: 'abc',
      nonce: 'nonce',
      keyVersion: 1,
      senderDeviceId: 'device-1',
    };

    await expect(
      service.createMessage(user, 'channel-1', {
        privacy: MessagePrivacy.EndToEndEncrypted,
        encrypted,
        attachments: [
          {
            storagePath: 'other-channel/user-1/file.bin',
            mimeType: 'application/octet-stream',
            byteSize: 1024,
            isE2ee: true,
            encrypted,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repositoryMocks.messages.insert).not.toHaveBeenCalled();
  });

  it('rejects messages to voice channels', async () => {
    const { MessagesService } = await import('./messages/messages.service');
    const service = new MessagesService(
      supabase,
      { requireMembership: vi.fn() } as never,
      { me: vi.fn() } as never,
      { insertMessageMentions: vi.fn(), resolveMentions: vi.fn() } as never,
      permissionsService as never,
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
    const encrypted = {
      algorithm: 'xchacha20poly1305-ietf' as const,
      ciphertext: 'abc',
      nonce: 'nonce',
      keyVersion: 1,
      senderDeviceId: 'device-1',
    };

    await expect(
      service.createMessage(user, 'channel-1', {
        privacy: MessagePrivacy.EndToEndEncrypted,
        encrypted,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repositoryMocks.messages.insert).not.toHaveBeenCalled();
  });

  it('creates a short LiveKit token only for accessible voice channels', async () => {
    const { VoiceService } = await import('./voice/voice.service');
    const serversService = {
      requireMembership: vi.fn().mockResolvedValue({ id: 'server-1', role: 'member' }),
    };
    const service = new VoiceService(supabase, permissionsService as never);
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Voice,
      name: 'voice',
      isPrivate: false,
      createdAt: null,
    });

    await expect(service.createJoinToken(user, 'channel-1')).resolves.toMatchObject({
      room: 'voice:channel-1',
      token: expect.any(String),
    });
    expect(permissionsService.assertChannelPermission).toHaveBeenCalled();
  });

  it('rejects LiveKit tokens for non-voice channels', async () => {
    const { VoiceService } = await import('./voice/voice.service');
    const serversService = { requireMembership: vi.fn() };
    const service = new VoiceService(supabase, permissionsService as never);
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Text,
      name: 'general',
      isPrivate: false,
      createdAt: null,
    });

    await expect(service.createJoinToken(user, 'channel-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(permissionsService.assertChannelPermission).not.toHaveBeenCalled();
  });

  it('rejects LiveKit tokens when the user is not a server member', async () => {
    const { VoiceService } = await import('./voice/voice.service');
    const serversService = {
      requireMembership: vi.fn().mockRejectedValue(new NotFoundException('Server not found.')),
    };
    const service = new VoiceService(supabase, permissionsService as never);
    permissionsService.assertChannelPermission.mockRejectedValue(
      new NotFoundException('Server not found.'),
    );
    repositoryMocks.channels.findById.mockResolvedValue({
      id: 'channel-1',
      serverId: 'server-1',
      type: ChannelType.Voice,
      name: 'voice',
      isPrivate: false,
      createdAt: null,
    });

    await expect(service.createJoinToken(user, 'channel-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('redeems active invitations by adding membership and marking the invite used', async () => {
    const { InvitesService } = await import('./invites/invites.service');
    const service = new InvitesService(supabase, permissionsService as never);
    const server = {
      id: 'server-1',
      name: 'Core',
      ownerId: 'owner-1',
      avatarUrl: null,
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
    const service = new InvitesService(supabase, permissionsService as never);
    repositoryMocks.invites.findActiveByCode.mockResolvedValue(null);

    await expect(service.redeemInvite(user, 'BAD')).rejects.toBeInstanceOf(NotFoundException);
  });
});
