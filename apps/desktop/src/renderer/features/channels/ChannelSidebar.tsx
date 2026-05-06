import { Hash, Lock, Mic, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import {
  ChannelType,
  type ChannelId,
  type ChannelSummary,
  type ServerSummary,
  type UserId,
} from '@discord2/shared';
import { IconButton } from '../../components/IconButton';
import type { ApiClient } from '../../lib/api-client';
import { VoiceChannelParticipants } from './VoiceChannelParticipants';

interface ChannelSidebarProps {
  api: ApiClient;
  server: ServerSummary | null;
  channels: ChannelSummary[];
  activeChannelId: string | null;
  activeVoiceChannelId: string | null;
  voiceStatus: string;
  voiceParticipantsByChannel: Record<ChannelId, UserId[]>;
  isLoading: boolean;
  canManageServer: boolean;
  onSelect: (channelId: string) => void;
  onCreateChannel: () => void;
  onCreateVoiceChannel: () => void;
  onEditChannel: (channel: ChannelSummary) => void;
  onDeleteChannel: (channel: ChannelSummary) => void;
  onJoinVoiceChannel: (channelId: string) => void;
  onOpenServerSettings: () => void;
}

export function ChannelSidebar({
  api,
  server,
  channels,
  activeChannelId,
  activeVoiceChannelId,
  voiceStatus,
  voiceParticipantsByChannel,
  isLoading,
  canManageServer,
  onSelect,
  onCreateChannel,
  onCreateVoiceChannel,
  onEditChannel,
  onDeleteChannel,
  onJoinVoiceChannel,
  onOpenServerSettings,
}: ChannelSidebarProps): React.JSX.Element {
  const textChannels = channels.filter((channel) => channel.type === ChannelType.Text);
  const voiceChannels = channels.filter((channel) => channel.type === ChannelType.Voice);
  const renderChannelActions = (channel: ChannelSummary) =>
    canManageServer ? (
      <div className="channel-actions" aria-label={`Actions du salon ${channel.name}`}>
        <IconButton label="Modifier le salon" onClick={() => onEditChannel(channel)}>
          <Pencil size={14} />
        </IconButton>
        <IconButton label="Supprimer le salon" onClick={() => onDeleteChannel(channel)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    ) : null;

  return (
    <aside className="channel-sidebar">
      <header className="server-header">
        <div>
          <span className="eyebrow">Serveur</span>
          <h1>{server?.name ?? 'Aucun serveur'}</h1>
        </div>
        {canManageServer ? (
          <IconButton label="Paramètres serveur" onClick={onOpenServerSettings}>
            <Settings size={17} />
          </IconButton>
        ) : null}
      </header>
      <section className="channel-section">
        <div className="section-title">
          <span>Salons texte</span>
          <IconButton label="Créer un salon" disabled={!server} onClick={onCreateChannel}>
            <Plus size={16} />
          </IconButton>
        </div>
        <nav className="channel-list" aria-label="Salons texte">
          {isLoading
            ? Array.from({ length: 5 }, (_, index) => (
                <div className="channel skeleton-line" key={index} />
              ))
            : null}
          {textChannels.map((channel) => (
            <div className="channel-row" key={channel.id}>
              <button
                className={`channel${channel.id === activeChannelId ? ' active' : ''}`}
                type="button"
                onClick={() => onSelect(channel.id)}
              >
                {channel.isPrivate ? <Lock size={16} /> : <Hash size={16} />}
                <span>{channel.name}</span>
              </button>
              {renderChannelActions(channel)}
            </div>
          ))}
          {!isLoading && textChannels.length === 0 ? (
            <p className="muted">Aucun salon texte.</p>
          ) : null}
        </nav>
      </section>
      <section className="channel-section">
        <div className="section-title">
          <span>Vocal</span>
          {canManageServer ? (
            <IconButton
              label="Créer un salon vocal"
              disabled={!server}
              onClick={onCreateVoiceChannel}
            >
              <Plus size={16} />
            </IconButton>
          ) : null}
        </div>
        <nav className="channel-list" aria-label="Salons vocaux">
          {voiceChannels.map((channel) => (
            <div key={channel.id} className="voice-channel-wrapper">
              <div className="channel-row">
                <button
                  className={`channel voice-channel${channel.id === activeVoiceChannelId ? ' active' : ''}`}
                  type="button"
                  onClick={() => onJoinVoiceChannel(channel.id)}
                >
                  <Mic size={16} />
                  <span>{channel.name}</span>
                  {channel.id === activeVoiceChannelId ? (
                    <small>{voiceStatus === 'connected' ? 'live' : voiceStatus}</small>
                  ) : null}
                </button>
                {renderChannelActions(channel)}
              </div>
              <VoiceChannelParticipants
                api={api}
                userIds={voiceParticipantsByChannel[channel.id] ?? []}
              />
            </div>
          ))}
          {voiceChannels.length === 0 ? <p className="muted">Aucun salon vocal.</p> : null}
        </nav>
      </section>
    </aside>
  );
}
