import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import type { Socket } from 'socket.io-client';
import { Hash, Link2, Plus } from 'lucide-react';
import {
  ChannelType,
  ClientToServerEvent,
  MessagePrivacy,
  Permission,
  ServerToClientEvent,
  type ChannelSummary,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageRecord,
  type ServerMemberProfile,
  type ServerRole,
  type ServerSummary,
  type VoicePresenceEvent,
  type InstanceConfig,
} from '@discord2/shared';
import type { ConversationKey } from '@discord2/e2ee';
import { CreateChannelDialog } from '../features/channels/CreateChannelDialog';
import { ChannelSidebar } from '../features/channels/ChannelSidebar';
import { EditChannelDialog } from '../features/channels/EditChannelDialog';
import { InviteDialog } from '../features/invites/InviteDialog';
import { JoinServerDialog } from '../features/invites/JoinServerDialog';
import { MessageComposer } from '../features/messages/MessageComposer';
import { MessageTimeline } from '../features/messages/MessageTimeline';
import { CreateServerDialog } from '../features/servers/CreateServerDialog';
import { ServerSettingsDialog } from '../features/servers/ServerSettingsDialog';
import { ServerRail } from '../features/servers/ServerRail';
import { ThemePickerDialog } from '../features/theme/ThemePickerDialog';
import { ProfileSettingsDialog } from '../features/users/ProfileSettingsDialog';
import { useVoiceRoom } from '../features/voice/useVoiceRoom';
import { VoicePanel } from '../features/voice/VoicePanel';
import { VoiceSettingsDialog } from '../features/voice/VoiceSettingsDialog';
import { ApiClient } from '../lib/api-client';
import {
  decryptMessages,
  encryptOutgoingBytes,
  encryptOutgoingMessage,
  ensureConversationKey,
  getOrCreateDeviceIdentity,
  rotateConversationKey,
  type DeviceIdentity,
} from '../lib/e2ee-client';
import { createRealtimeSocket } from '../lib/realtime';
import { getServerPermissions, hasPermission } from '../lib/permissions';
import type { SupabaseBrowserClient } from '../lib/supabase';
import { queryClient } from '../app/query-client';
import { useUiStore } from '../store/ui-store';
import { IconButton } from '../components/IconButton';
import { UserBar } from './UserBar';

interface WorkspaceProps {
  session: Session;
  instance: InstanceConfig;
  supabase: SupabaseBrowserClient;
}

export function Workspace({ session, instance, supabase }: WorkspaceProps): React.JSX.Element {
  const api = useMemo(() => new ApiClient(session, instance), [session, instance]);
  const [deviceIdentity, setDeviceIdentity] = useState<DeviceIdentity | null>(null);
  const [conversationKey, setConversationKey] = useState<ConversationKey | null>(null);
  const [decryptedMessages, setDecryptedMessages] = useState<MessageRecord[]>([]);
  const [isCreateServerOpen, setIsCreateServerOpen] = useState(false);
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false);
  const [createChannelType, setCreateChannelType] = useState<
    typeof ChannelType.Text | typeof ChannelType.Voice
  >(ChannelType.Text);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [isJoinServerOpen, setIsJoinServerOpen] = useState(false);
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = useState(false);
  const [isServerSettingsOpen, setIsServerSettingsOpen] = useState(false);
  const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
  const [isVoiceSettingsOpen, setIsVoiceSettingsOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<ChannelSummary | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [inviteCodeId, setInviteCodeId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const {
    activeServerId,
    activeChannelId,
    activeVoiceChannelId,
    realtimeStatus,
    voiceStatus,
    voiceError,
    voiceParticipantIds,
    voiceParticipantsByChannel,
    isMuted,
    isDeafened,
    setActiveServerId,
    setActiveChannelId,
    setRealtimeStatus,
    setVoiceParticipantIds,
    theme,
    setTheme,
    voiceSettings,
    setVoiceSettings,
  } = useUiStore();
  const voice = useVoiceRoom({ api, instance, socket: socketRef.current });

  const profileQuery = useQuery({
    queryKey: ['me'],
    queryFn: api.users.me,
  });
  const serversQuery = useQuery({
    queryKey: ['servers'],
    queryFn: api.servers.list,
  });
  const channelsQuery = useQuery({
    queryKey: ['channels', activeServerId],
    queryFn: () => api.channels.list(activeServerId!),
    enabled: Boolean(activeServerId),
  });
  const messagesQuery = useQuery({
    queryKey: ['messages', activeChannelId],
    queryFn: () => api.messages.list(activeChannelId!),
    enabled: Boolean(activeChannelId),
  });
  const rolesQuery = useQuery({
    queryKey: ['roles', activeServerId],
    queryFn: () => api.roles.list(activeServerId!),
    enabled: Boolean(activeServerId),
  });
  const membersQuery = useQuery({
    queryKey: ['members', activeServerId],
    queryFn: () => api.roles.members(activeServerId!),
    enabled: Boolean(activeServerId),
  });

  const servers = serversQuery.data ?? [];
  const channels = channelsQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const activeServer = servers.find((server) => server.id === activeServerId) ?? null;
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? null;
  const activeVoiceChannel =
    channels.find((channel) => channel.id === activeVoiceChannelId) ?? null;
  const serverPermissions = getServerPermissions(session.user.id, members, roles);
  const activeChannelPermissions = activeChannel?.permissions ?? serverPermissions;
  const canManageActiveServer =
    activeServer?.role === 'owner' ||
    hasPermission(serverPermissions, Permission.ManageServer) ||
    hasPermission(serverPermissions, Permission.ManageRoles) ||
    hasPermission(serverPermissions, Permission.ManageChannels);
  const canCreateInvite = hasPermission(serverPermissions, Permission.CreateInvites);
  const canManageChannels = hasPermission(serverPermissions, Permission.ManageChannels);
  const canSendMessages = hasPermission(activeChannelPermissions, Permission.SendMessages);
  const canAttachFiles = hasPermission(activeChannelPermissions, Permission.AttachFiles);
  const canManageMessages = hasPermission(activeChannelPermissions, Permission.ManageMessages);

  useEffect(() => {
    let cancelled = false;
    getOrCreateDeviceIdentity({ api, instance, userId: session.user.id })
      .then((identity) => {
        if (!cancelled) setDeviceIdentity(identity);
      })
      .catch((error: unknown) => {
        setComposerError(
          error instanceof Error ? error.message : 'Impossible d’initialiser les clés E2EE.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [api, instance, session.user.id]);

  useEffect(() => {
    setConversationKey(null);
    if (!activeServerId || !activeChannelId || !deviceIdentity) return;
    let cancelled = false;
    ensureConversationKey({
      api,
      instance,
      userId: session.user.id,
      serverId: activeServerId,
      channelId: activeChannelId,
      identity: deviceIdentity,
    })
      .then((key) => {
        if (!cancelled) setConversationKey(key);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeChannelId, activeServerId, api, deviceIdentity, instance, session.user.id]);

  useEffect(() => {
    let cancelled = false;
    decryptMessages({
      api,
      instance,
      userId: session.user.id,
      serverId: activeServerId,
      channelId: activeChannelId,
      identity: deviceIdentity,
      messages: messagesQuery.data ?? [],
    })
      .then((messages) => {
        if (!cancelled) setDecryptedMessages(messages);
      })
      .catch(() => {
        if (!cancelled) setDecryptedMessages(messagesQuery.data ?? []);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeChannelId,
    activeServerId,
    api,
    deviceIdentity,
    instance,
    messagesQuery.data,
    session.user.id,
  ]);

  useEffect(() => {
    if (!activeServerId && servers.length > 0) {
      const firstServer = servers[0];
      if (firstServer) {
        setActiveServerId(firstServer.id);
      }
    }
  }, [activeServerId, servers, setActiveServerId]);

  useEffect(() => {
    if (!activeChannelId && channels.length > 0) {
      const firstTextChannel = channels.find((channel) => channel.type === ChannelType.Text);
      const fallbackChannel = channels[0];
      const selectedChannel = firstTextChannel ?? fallbackChannel;
      if (selectedChannel) {
        setActiveChannelId(selectedChannel.id);
      }
    }
  }, [activeChannelId, channels, setActiveChannelId]);

  useEffect(() => {
    setRealtimeStatus('connecting');
    const socket = createRealtimeSocket(session.access_token, instance);
    socketRef.current = socket;

    socket.on('connect', () => setRealtimeStatus('connected'));
    socket.on('disconnect', () => setRealtimeStatus('disconnected'));
    socket.on('connect_error', () => setRealtimeStatus('disconnected'));
    socket.on(ServerToClientEvent.MessageCreated, (event: MessageCreatedEvent) => {
      queryClient.setQueryData<MessageRecord[]>(['messages', event.channelId], (current = []) => {
        if (current.some((message) => message.id === event.message.id)) {
          return current;
        }

        return [...current, event.message];
      });
    });
    socket.on(ServerToClientEvent.MessageDeleted, (event: MessageDeletedEvent) => {
      queryClient.setQueryData<MessageRecord[]>(['messages', event.channelId], (current = []) =>
        current.filter((message) => message.id !== event.messageId),
      );
    });
    socket.on(ServerToClientEvent.VoicePresenceUpdated, (event: VoicePresenceEvent) => {
      setVoiceParticipantIds(event.channelId, event.userIds);
    });

    socket.on(ServerToClientEvent.MemberRemoved, (event: MemberRemovedEvent) => {
      if (event.userId === session.user.id) {
        queryClient.setQueryData<ServerSummary[]>(['servers'], (current = []) =>
          current.filter((s) => s.id !== event.serverId),
        );
        queryClient.removeQueries({ queryKey: ['channels', event.serverId] });
        queryClient.removeQueries({ queryKey: ['members', event.serverId] });
      } else {
        queryClient.setQueryData<ServerMemberProfile[]>(
          ['members', event.serverId],
          (current = []) => current.filter((m) => m.userId !== event.userId),
        );
      }
    });

    return () => {
      socket.off(ServerToClientEvent.MessageCreated);
      socket.off(ServerToClientEvent.MessageDeleted);
      socket.off(ServerToClientEvent.VoicePresenceUpdated);
      socket.off(ServerToClientEvent.MemberRemoved);
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
        setRealtimeStatus('disconnected');
      }
    };
  }, [instance, session.access_token, session.user.id, setRealtimeStatus, setVoiceParticipantIds]);

  useEffect(() => {
    if (!activeChannelId) {
      return;
    }

    const socket = socketRef.current;
    socket?.emit(ClientToServerEvent.ChannelJoin, { channelId: activeChannelId });

    return () => {
      socket?.emit(ClientToServerEvent.ChannelLeave, { channelId: activeChannelId });
    };
  }, [activeChannelId]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !activeServerId) {
      return;
    }

    const voiceChannels = channels.filter((channel) => channel.type === ChannelType.Voice);
    for (const channel of voiceChannels) {
      socket.emit(ClientToServerEvent.ChannelJoin, { channelId: channel.id });
    }

    return () => {
      for (const channel of voiceChannels) {
        socket.emit(ClientToServerEvent.ChannelLeave, { channelId: channel.id });
      }
    };
  }, [activeServerId, channels]);

  const createServerMutation = useMutation({
    mutationFn: (name: string) => api.servers.create({ name }),
    onSuccess: (server) => {
      queryClient.setQueryData(['servers'], [...servers, server]);
      setActiveServerId(server.id);
      setIsCreateServerOpen(false);
    },
  });

  const createChannelMutation = useMutation({
    mutationFn: (input: {
      name: string;
      type: typeof ChannelType.Text | typeof ChannelType.Voice;
    }) =>
      api.channels.create(activeServerId!, {
        name: input.name,
        type: input.type,
      }),
    onSuccess: (channel) => {
      queryClient.setQueryData<ChannelSummary[]>(
        ['channels', activeServerId],
        [...channels, channel],
      );
      if (channel.type === ChannelType.Text) {
        setActiveChannelId(channel.id);
        if (activeServerId && deviceIdentity) {
          void ensureConversationKey({
            api,
            instance,
            userId: session.user.id,
            serverId: activeServerId,
            channelId: channel.id,
            identity: deviceIdentity,
          });
        }
      }
      setIsCreateChannelOpen(false);
    },
  });

  const updateChannelMutation = useMutation({
    mutationFn: (input: { serverId: string; channelId: string; name: string }) =>
      api.channels.update(input.serverId, input.channelId, { name: input.name }),
    onSuccess: (channel, input) => {
      queryClient.setQueryData<ChannelSummary[]>(['channels', input.serverId], (current = []) =>
        current.map((item) => (item.id === channel.id ? channel : item)),
      );
      setEditingChannel(null);
    },
  });

  const deleteChannelMutation = useMutation({
    mutationFn: async (channel: ChannelSummary) => {
      const serverId = channel.serverId ?? activeServerId!;
      if (channel.id === activeVoiceChannelId) {
        await voice.leaveVoiceChannel();
      }

      const result = await api.channels.delete(serverId, channel.id);
      return { ...result, channel, serverId };
    },
    onSuccess: ({ channel, channelId, serverId }) => {
      queryClient.setQueryData<ChannelSummary[]>(['channels', serverId], (current = []) => {
        const nextChannels = current.filter((item) => item.id !== channelId);
        if (channel.id === activeChannelId) {
          const nextTextChannel = nextChannels.find((item) => item.type === ChannelType.Text);
          setActiveChannelId(nextTextChannel?.id ?? null);
        }

        return nextChannels;
      });
      queryClient.removeQueries({ queryKey: ['messages', channelId] });
      setEditingChannel(null);
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: () => api.invites.create(activeServerId!),
    onSuccess: (invite) => setInviteCodeId(invite.id),
  });
  const currentInvite =
    createInviteMutation.data && createInviteMutation.data.id === inviteCodeId
      ? createInviteMutation.data
      : null;

  const redeemInviteMutation = useMutation({
    mutationFn: (code: string) => api.invites.redeem(code),
    onSuccess: (result) => {
      queryClient.setQueryData<ServerSummary[]>(['servers'], (current = []) => {
        if (current.some((s) => s.id === result.server.id)) return current;
        return [...current, result.server];
      });
      setActiveServerId(result.server.id);
      setJoinError(null);
      setIsJoinServerOpen(false);
    },
    onError: (error: Error) => setJoinError(error.message),
  });

  const updateProfileMutation = useMutation({
    mutationFn: api.users.updateMe,
    onSuccess: (profile) => {
      queryClient.setQueryData(['me'], profile);
      queryClient.setQueriesData<MessageRecord[]>({ queryKey: ['messages'] }, (current) => {
        if (!current) {
          return current;
        }

        return current.map((message) => {
          if (message.authorId !== profile.id) {
            return message;
          }

          return {
            ...message,
            author: {
              id: profile.id,
              displayName: profile.displayName,
              avatarUrl: profile.avatarUrl,
            },
          };
        });
      });
    },
  });

  const updateServerMutation = useMutation({
    mutationFn: (input: { name: string; avatarUrl: string | null }) =>
      api.servers.update(activeServerId!, input),
    onSuccess: (server) => {
      queryClient.setQueryData<ServerSummary[]>(['servers'], (current = []) =>
        current.map((item) => (item.id === server.id ? server : item)),
      );
      setIsServerSettingsOpen(false);
    },
  });

  const createRoleMutation = useMutation({
    mutationFn: (input: { name: string; color: string; mentionable: boolean }) =>
      api.roles.create(activeServerId!, input),
    onSuccess: (role) => {
      queryClient.setQueryData<ServerRole[]>(['roles', activeServerId], (current = []) => [
        ...current,
        role,
      ]);
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: (input: {
      roleId: string;
      name: string;
      color: string;
      mentionable: boolean;
      permissions: Permission[];
    }) =>
      api.roles.update(activeServerId!, input.roleId, {
        name: input.name,
        color: input.color,
        mentionable: input.mentionable,
        permissions: input.permissions,
      }),
    onSuccess: (role) => {
      queryClient.setQueryData<ServerRole[]>(['roles', activeServerId], (current = []) =>
        current.map((item) => (item.id === role.id ? role : item)),
      );
    },
  });

  const deleteRoleMutation = useMutation({
    mutationFn: (roleId: string) => api.roles.delete(activeServerId!, roleId),
    onSuccess: ({ roleId }) => {
      queryClient.setQueryData<ServerRole[]>(['roles', activeServerId], (current = []) =>
        current.filter((role) => role.id !== roleId),
      );
      queryClient.setQueryData<ServerMemberProfile[]>(['members', activeServerId], (current = []) =>
        current.map((member) => ({
          ...member,
          roleIds: member.roleIds.filter((id) => id !== roleId),
        })),
      );
    },
  });

  const updateMemberRolesMutation = useMutation({
    mutationFn: (input: { userId: string; roleIds: string[] }) =>
      api.roles.updateMemberRoles(activeServerId!, input.userId, { roleIds: input.roleIds }),
    onSuccess: (member) => {
      queryClient.setQueryData<ServerMemberProfile[]>(['members', activeServerId], (current = []) =>
        current.map((item) => (item.userId === member.userId ? member : item)),
      );
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.roles.removeMember(activeServerId!, userId),
    onSuccess: async (_, userId) => {
      queryClient.setQueryData<ServerMemberProfile[]>(['members', activeServerId], (current = []) =>
        current.filter((m) => m.userId !== userId),
      );
      if (activeServerId && deviceIdentity) {
        const textChannels = channels.filter((c) => c.type === ChannelType.Text);
        await Promise.all(
          textChannels.map((channel) =>
            rotateConversationKey({
              api,
              instance,
              userId: session.user.id,
              serverId: activeServerId,
              channelId: channel.id,
              identity: deviceIdentity,
              removedDeviceIds: [],
            }),
          ),
        );
      }
    },
  });

  const banMemberMutation = useMutation({
    mutationFn: (input: { userId: string; reason?: string | null }) =>
      api.servers.banMember(activeServerId!, input),
    onSuccess: (_, input) => {
      queryClient.setQueryData<ServerMemberProfile[]>(['members', activeServerId], (current = []) =>
        current.filter((member) => member.userId !== input.userId),
      );
    },
  });

  const deleteMessageMutation = useMutation({
    mutationFn: (messageId: string) => api.messages.delete(messageId),
    onSuccess: ({ messageId, channelId }) => {
      queryClient.setQueryData<MessageRecord[]>(['messages', channelId], (current = []) =>
        current.filter((message) => message.id !== messageId),
      );
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (input: {
      content: string;
      media: Array<{ file: File; previewUrl: string }>;
    }) => {
      if (!activeServerId || !activeChannelId || !deviceIdentity) {
        throw new Error('Clés E2EE pas encore prêtes.');
      }

      const encrypted = await encryptOutgoingMessage({
        api,
        instance,
        userId: session.user.id,
        serverId: activeServerId,
        channelId: activeChannelId,
        identity: deviceIdentity,
        content: input.content || '[media]',
      });
      const attachments = (
        await Promise.all(
          input.media.map(async (draft) => {
            const encryptedFile = await encryptOutgoingBytes({
              api,
              instance,
              userId: session.user.id,
              serverId: activeServerId,
              channelId: activeChannelId,
              identity: deviceIdentity,
              bytes: new Uint8Array(await draft.file.arrayBuffer()),
            });
            return api.files.uploadEncryptedMessageMedia(
              activeChannelId,
              base64ToBytes(encryptedFile.ciphertext),
              encryptedFile,
            );
          }),
        )
      ).map((attachment) => attachment);
      return api.messages.create(activeChannelId, {
        privacy: MessagePrivacy.EndToEndEncrypted,
        encrypted,
        attachments,
      });
    },
    onMutate: async (input) => {
      setComposerError(null);
      const channelId = activeChannelId!;
      await queryClient.cancelQueries({ queryKey: ['messages', channelId] });
      const previous = queryClient.getQueryData<MessageRecord[]>(['messages', channelId]) ?? [];
      const optimistic: MessageRecord = {
        id: `pending-${crypto.randomUUID()}`,
        channelId,
        authorId: profileQuery.data?.id ?? session.user.id,
        privacy: MessagePrivacy.EndToEndEncrypted,
        content: input.content || null,
        attachments: input.media.map((draft) => ({
          id: `pending-attachment-${draft.previewUrl}`,
          url: draft.previewUrl,
          storagePath: draft.previewUrl,
          mimeType: draft.file.type,
          byteSize: draft.file.size,
          fileName: draft.file.name,
          isE2ee: true,
        })),
        embeds: [],
        encrypted: null,
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
      if (profileQuery.data) {
        optimistic.author = {
          id: profileQuery.data.id,
          displayName: profileQuery.data.displayName,
          avatarUrl: profileQuery.data.avatarUrl,
        };
      }
      queryClient.setQueryData<MessageRecord[]>(['messages', channelId], [...previous, optimistic]);
      return { previous, channelId };
    },
    onError: (_error, _input, context) => {
      if (context) {
        queryClient.setQueryData(['messages', context.channelId], context.previous);
      }
    },
    onSuccess: (message, _input, context) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData<MessageRecord[]>(['messages', context.channelId], (current = []) => {
        const withoutPending = current.filter((item) => !item.id.startsWith('pending-'));
        if (withoutPending.some((item) => item.id === message.id)) {
          return withoutPending;
        }
        return [...withoutPending, message];
      });
    },
  });

  return (
    <main className="workspace-shell">
      <ServerRail
        servers={servers}
        activeServerId={activeServerId}
        isLoading={serversQuery.isLoading}
        onSelect={setActiveServerId}
        onCreate={() => setIsCreateServerOpen(true)}
        onJoin={() => setIsJoinServerOpen(true)}
      />
      <div className="workspace-sidebar">
        <ChannelSidebar
          api={api}
          server={activeServer}
          channels={channels}
          activeChannelId={activeChannelId}
          activeVoiceChannelId={activeVoiceChannelId}
          voiceStatus={voiceStatus}
          voiceParticipantsByChannel={voiceParticipantsByChannel}
          isLoading={channelsQuery.isLoading}
          canManageServer={canManageChannels}
          onSelect={setActiveChannelId}
          onCreateChannel={() => {
            setCreateChannelType(ChannelType.Text);
            setIsCreateChannelOpen(true);
          }}
          onCreateVoiceChannel={() => {
            setCreateChannelType(ChannelType.Voice);
            setIsCreateChannelOpen(true);
          }}
          onEditChannel={setEditingChannel}
          onJoinVoiceChannel={(channelId) => {
            void voice.joinVoiceChannel(channelId);
          }}
          onOpenServerSettings={() => setIsServerSettingsOpen(true)}
        />
        <VoicePanel
          api={api}
          channel={activeVoiceChannel}
          participantIds={voiceParticipantIds}
          status={voiceStatus}
          error={voiceError}
          isMuted={isMuted}
          isDeafened={isDeafened}
          onToggleMute={() => {
            void voice.setMuted(!isMuted);
          }}
          onToggleDeafen={() => voice.setDeafened(!isDeafened)}
          onLeave={() => {
            void voice.leaveVoiceChannel();
          }}
        />
        <UserBar
          profile={profileQuery.data}
          realtimeStatus={realtimeStatus}
          onOpenSettings={() => setIsProfileSettingsOpen(true)}
          onOpenThemePicker={() => setIsThemePickerOpen(true)}
          onOpenVoiceSettings={() => setIsVoiceSettingsOpen(true)}
          onLogout={() => void supabase.auth.signOut()}
        />
      </div>
      <section className="chat-panel">
        <header className="chat-topbar">
          <div className="chat-title">
            <Hash size={18} />
            <strong>{activeChannel?.name ?? 'Aucun salon'}</strong>
          </div>
          <div className="topbar-actions">
            <IconButton
              label="Invitation"
              disabled={!activeServerId || !canCreateInvite}
              onClick={() => setIsInviteOpen(true)}
            >
              <Link2 size={18} />
            </IconButton>
            <IconButton
              label="Nouveau salon"
              disabled={!activeServerId || !canManageChannels}
              onClick={() => {
                setCreateChannelType(ChannelType.Text);
                setIsCreateChannelOpen(true);
              }}
            >
              <Plus size={18} />
            </IconButton>
          </div>
        </header>
        {realtimeStatus !== 'connected' ? (
          <div className="realtime-banner" data-status={realtimeStatus}>
            {realtimeStatus === 'connecting'
              ? 'Connexion temps réel en cours...'
              : 'Temps réel déconnecté. Les nouveaux messages peuvent arriver en retard.'}
          </div>
        ) : null}
        {serversQuery.isLoading ? (
          <div className="messages-wrapper">
            <div className="message-list">
              {Array.from({ length: 6 }, (_, index) => (
                <div className="message-row skeleton-message" key={index}>
                  <div className="avatar skeleton-dot" />
                  <div className="message-body">
                    <div className="skeleton-line short" />
                    <div className="skeleton-line" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : servers.length === 0 ? (
          <div className="center-state">
            <h2>Crée ton premier serveur</h2>
            <p>Un serveur contient les salons texte de ta communauté.</p>
            <button type="button" onClick={() => setIsCreateServerOpen(true)}>
              Créer un serveur
            </button>
          </div>
        ) : (
          <>
            <MessageTimeline
              messages={decryptedMessages}
              isLoading={messagesQuery.isLoading}
              session={session}
              api={api}
              members={members}
              roles={roles}
              conversationKey={conversationKey}
              canManageMessages={canManageMessages}
              onDeleteMessage={(messageId) => deleteMessageMutation.mutateAsync(messageId)}
            />
            <MessageComposer
              disabled={!activeChannelId || !canSendMessages || sendMessageMutation.isPending}
              canAttachFiles={canAttachFiles}
              error={composerError}
              members={members}
              roles={roles}
              onSend={async (content, media) => {
                try {
                  await sendMessageMutation.mutateAsync({ content, media });
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : 'Impossible d’envoyer le message.';
                  setComposerError(message);
                  throw error;
                }
              }}
            />
          </>
        )}
      </section>
      {isCreateServerOpen ? (
        <CreateServerDialog
          isSubmitting={createServerMutation.isPending}
          onClose={() => setIsCreateServerOpen(false)}
          onCreate={async (name) => {
            await createServerMutation.mutateAsync(name);
          }}
        />
      ) : null}
      {isCreateChannelOpen ? (
        <CreateChannelDialog
          type={createChannelType}
          isSubmitting={createChannelMutation.isPending}
          onClose={() => setIsCreateChannelOpen(false)}
          onCreate={async (name, type) => {
            await createChannelMutation.mutateAsync({ name, type });
          }}
        />
      ) : null}
      {editingChannel ? (
        <EditChannelDialog
          channel={editingChannel}
          serverId={editingChannel.serverId ?? activeServerId!}
          api={api}
          roles={roles}
          isSubmitting={updateChannelMutation.isPending}
          isDeleting={deleteChannelMutation.isPending}
          onClose={() => setEditingChannel(null)}
          onSave={async (name) => {
            await updateChannelMutation.mutateAsync({
              serverId: editingChannel.serverId ?? activeServerId!,
              channelId: editingChannel.id,
              name,
            });
          }}
          onDelete={async () => {
            await deleteChannelMutation.mutateAsync(editingChannel);
          }}
        />
      ) : null}
      {isInviteOpen ? (
        <InviteDialog
          invite={currentInvite}
          isCreating={createInviteMutation.isPending}
          onCreate={() => createInviteMutation.mutate()}
          onClose={() => {
            setIsInviteOpen(false);
            setInviteCodeId(null);
            createInviteMutation.reset();
          }}
        />
      ) : null}
      {isJoinServerOpen ? (
        <JoinServerDialog
          isSubmitting={redeemInviteMutation.isPending}
          error={joinError}
          onClose={() => {
            setIsJoinServerOpen(false);
            setJoinError(null);
            redeemInviteMutation.reset();
          }}
          onJoin={async (code) => {
            setJoinError(null);
            await redeemInviteMutation.mutateAsync(code);
          }}
        />
      ) : null}
      {isProfileSettingsOpen && profileQuery.data ? (
        <ProfileSettingsDialog
          profile={profileQuery.data}
          session={session}
          api={api}
          supabase={supabase}
          isSavingProfile={updateProfileMutation.isPending}
          onClose={() => setIsProfileSettingsOpen(false)}
          onSaveProfile={async (input) => {
            await updateProfileMutation.mutateAsync(input);
          }}
        />
      ) : null}
      {isServerSettingsOpen && activeServer && canManageActiveServer ? (
        <ServerSettingsDialog
          server={activeServer}
          api={api}
          isSaving={updateServerMutation.isPending}
          roles={roles}
          channels={channels}
          members={members}
          isLoadingRoles={rolesQuery.isLoading || membersQuery.isLoading}
          isSavingRole={
            createRoleMutation.isPending ||
            updateRoleMutation.isPending ||
            deleteRoleMutation.isPending ||
            updateMemberRolesMutation.isPending
          }
          isRemovingMember={removeMemberMutation.isPending || banMemberMutation.isPending}
          onClose={() => setIsServerSettingsOpen(false)}
          onSave={async (input) => {
            await updateServerMutation.mutateAsync(input);
          }}
          onCreateRole={async (input) => {
            await createRoleMutation.mutateAsync(input);
          }}
          onUpdateRole={async (roleId, input) => {
            await updateRoleMutation.mutateAsync({
              roleId,
              name: input.name,
              color: input.color,
              mentionable: input.mentionable,
              permissions: input.permissions,
            });
          }}
          onDeleteRole={async (roleId) => {
            await deleteRoleMutation.mutateAsync(roleId);
          }}
          onUpdateMemberRoles={async (userId, roleIds) => {
            await updateMemberRolesMutation.mutateAsync({ userId, roleIds });
          }}
          onRemoveMember={async (userId) => {
            await removeMemberMutation.mutateAsync(userId);
          }}
          onBanMember={async (userId, reason) => {
            await banMemberMutation.mutateAsync({ userId, reason });
          }}
          onEditChannel={(channel) => {
            setIsServerSettingsOpen(false);
            setEditingChannel(channel);
          }}
        />
      ) : null}
      {isThemePickerOpen ? (
        <ThemePickerDialog
          currentTheme={theme}
          onClose={() => setIsThemePickerOpen(false)}
          onSelect={(nextTheme) => {
            setTheme(nextTheme);
            setIsThemePickerOpen(false);
          }}
        />
      ) : null}
      {isVoiceSettingsOpen ? (
        <VoiceSettingsDialog
          settings={voiceSettings}
          onSave={setVoiceSettings}
          onClose={() => setIsVoiceSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
