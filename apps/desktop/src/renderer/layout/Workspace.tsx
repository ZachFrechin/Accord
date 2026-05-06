import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import type { Socket } from 'socket.io-client';
import { Hash, Link2, Plus } from 'lucide-react';
import {
  ChannelType,
  ClientToServerEvent,
  MessagePrivacy,
  ServerToClientEvent,
  type ChannelSummary,
  type MessageCreatedEvent,
  type MessageRecord,
} from '@discord2/shared';
import { CreateChannelDialog } from '../features/channels/CreateChannelDialog';
import { ChannelSidebar } from '../features/channels/ChannelSidebar';
import { InviteDialog } from '../features/invites/InviteDialog';
import { MessageComposer } from '../features/messages/MessageComposer';
import { MessageTimeline } from '../features/messages/MessageTimeline';
import { CreateServerDialog } from '../features/servers/CreateServerDialog';
import { ServerRail } from '../features/servers/ServerRail';
import { ApiClient } from '../lib/api-client';
import { createRealtimeSocket } from '../lib/realtime';
import { queryClient } from '../app/query-client';
import { useUiStore } from '../store/ui-store';
import { IconButton } from '../components/IconButton';
import { UserBar } from './UserBar';

interface WorkspaceProps {
  session: Session;
}

export function Workspace({ session }: WorkspaceProps): React.JSX.Element {
  const api = useMemo(() => new ApiClient(session), [session]);
  const [isCreateServerOpen, setIsCreateServerOpen] = useState(false);
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteCodeId, setInviteCodeId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const {
    activeServerId,
    activeChannelId,
    realtimeStatus,
    setActiveServerId,
    setActiveChannelId,
    setRealtimeStatus,
  } = useUiStore();

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

  const servers = serversQuery.data ?? [];
  const channels = channelsQuery.data ?? [];
  const activeServer = servers.find((server) => server.id === activeServerId) ?? null;
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? null;

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
    const socket = createRealtimeSocket(session.access_token);
    socketRef.current = socket;

    socket.on('connect', () => setRealtimeStatus('connected'));
    socket.on('disconnect', () => setRealtimeStatus('disconnected'));
    socket.on(ServerToClientEvent.MessageCreated, (event: MessageCreatedEvent) => {
      queryClient.setQueryData<MessageRecord[]>(['messages', event.channelId], (current = []) => {
        if (current.some((message) => message.id === event.message.id)) {
          return current;
        }

        return [...current, event.message];
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setRealtimeStatus('disconnected');
    };
  }, [session.access_token, setRealtimeStatus]);

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

  const createServerMutation = useMutation({
    mutationFn: (name: string) => api.servers.create({ name }),
    onSuccess: (server) => {
      queryClient.setQueryData(['servers'], [...servers, server]);
      setActiveServerId(server.id);
      setIsCreateServerOpen(false);
    },
  });

  const createChannelMutation = useMutation({
    mutationFn: (name: string) =>
      api.channels.create(activeServerId!, {
        name,
        type: ChannelType.Text,
      }),
    onSuccess: (channel) => {
      queryClient.setQueryData<ChannelSummary[]>(
        ['channels', activeServerId],
        [...channels, channel],
      );
      setActiveChannelId(channel.id);
      setIsCreateChannelOpen(false);
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

  const sendMessageMutation = useMutation({
    mutationFn: (content: string) =>
      api.messages.create(activeChannelId!, {
        content,
        privacy: MessagePrivacy.Public,
      }),
    onMutate: async (content) => {
      const channelId = activeChannelId!;
      await queryClient.cancelQueries({ queryKey: ['messages', channelId] });
      const previous = queryClient.getQueryData<MessageRecord[]>(['messages', channelId]) ?? [];
      const optimistic: MessageRecord = {
        id: `pending-${crypto.randomUUID()}`,
        channelId,
        authorId: profileQuery.data?.id ?? session.user.id,
        privacy: MessagePrivacy.Public,
        content,
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
    onError: (_error, _content, context) => {
      if (context) {
        queryClient.setQueryData(['messages', context.channelId], context.previous);
      }
    },
    onSuccess: (message, _content, context) => {
      if (!context) {
        return;
      }

      queryClient.setQueryData<MessageRecord[]>(['messages', context.channelId], (current = []) => [
        ...current.filter((item) => !item.id.startsWith('pending-')),
        message,
      ]);
    },
  });

  return (
    <main className="workspace-shell">
      <ServerRail
        servers={servers}
        activeServerId={activeServerId}
        onSelect={setActiveServerId}
        onCreate={() => setIsCreateServerOpen(true)}
      />
      <div className="workspace-sidebar">
        <ChannelSidebar
          server={activeServer}
          channels={channels}
          activeChannelId={activeChannelId}
          onSelect={setActiveChannelId}
          onCreateChannel={() => setIsCreateChannelOpen(true)}
        />
        <UserBar profile={profileQuery.data} realtimeStatus={realtimeStatus} />
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
              disabled={!activeServerId}
              onClick={() => setIsInviteOpen(true)}
            >
              <Link2 size={18} />
            </IconButton>
            <IconButton
              label="Nouveau salon"
              disabled={!activeServerId}
              onClick={() => setIsCreateChannelOpen(true)}
            >
              <Plus size={18} />
            </IconButton>
          </div>
        </header>
        {serversQuery.isLoading ? (
          <div className="center-state">Chargement de l’espace...</div>
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
              messages={messagesQuery.data ?? []}
              isLoading={messagesQuery.isLoading}
            />
            <MessageComposer
              disabled={!activeChannelId || sendMessageMutation.isPending}
              onSend={async (content) => {
                await sendMessageMutation.mutateAsync(content);
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
          isSubmitting={createChannelMutation.isPending}
          onClose={() => setIsCreateChannelOpen(false)}
          onCreate={async (name) => {
            await createChannelMutation.mutateAsync(name);
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
    </main>
  );
}
