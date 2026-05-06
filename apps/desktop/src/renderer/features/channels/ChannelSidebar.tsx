import { Hash, Lock, Mic, Plus, Settings } from 'lucide-react';
import { ChannelType, type ChannelSummary, type ServerSummary } from '@discord2/shared';
import { IconButton } from '../../components/IconButton';

interface ChannelSidebarProps {
  server: ServerSummary | null;
  channels: ChannelSummary[];
  activeChannelId: string | null;
  isLoading: boolean;
  canManageServer: boolean;
  onSelect: (channelId: string) => void;
  onCreateChannel: () => void;
  onOpenServerSettings: () => void;
}

export function ChannelSidebar({
  server,
  channels,
  activeChannelId,
  isLoading,
  canManageServer,
  onSelect,
  onCreateChannel,
  onOpenServerSettings,
}: ChannelSidebarProps): React.JSX.Element {
  const textChannels = channels.filter((channel) => channel.type === ChannelType.Text);
  const voiceChannels = channels.filter((channel) => channel.type === ChannelType.Voice);

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
            <button
              className={`channel${channel.id === activeChannelId ? ' active' : ''}`}
              key={channel.id}
              type="button"
              onClick={() => onSelect(channel.id)}
            >
              {channel.isPrivate ? <Lock size={16} /> : <Hash size={16} />}
              <span>{channel.name}</span>
            </button>
          ))}
          {!isLoading && textChannels.length === 0 ? (
            <p className="muted">Aucun salon texte.</p>
          ) : null}
        </nav>
      </section>
      <section className="channel-section">
        <div className="section-title">
          <span>Vocal</span>
        </div>
        <nav className="channel-list" aria-label="Salons vocaux">
          {voiceChannels.map((channel) => (
            <button className="channel" key={channel.id} type="button" disabled>
              <Mic size={16} />
              <span>{channel.name}</span>
            </button>
          ))}
          <p className="muted">LiveKit arrive dans une prochaine itération.</p>
        </nav>
      </section>
    </aside>
  );
}
