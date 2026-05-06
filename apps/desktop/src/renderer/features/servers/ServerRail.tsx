import { LogIn, Plus } from 'lucide-react';
import type { ServerSummary } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';

interface ServerRailProps {
  servers: ServerSummary[];
  activeServerId: string | null;
  isLoading: boolean;
  onSelect: (serverId: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}

export function ServerRail({
  servers,
  activeServerId,
  isLoading,
  onSelect,
  onCreate,
  onJoin,
}: ServerRailProps): React.JSX.Element {
  return (
    <aside className="server-rail" aria-label="Serveurs">
      <div className="server-list">
        {isLoading
          ? Array.from({ length: 4 }, (_, index) => (
              <div className="server-dot skeleton-dot" key={index} />
            ))
          : null}
        {servers.map((server) => (
          <Tooltip key={server.id} label={server.name}>
            <button
              className={`server-dot${server.id === activeServerId ? ' active' : ''}`}
              type="button"
              aria-label={server.name}
              onClick={() => onSelect(server.id)}
            >
              <AvatarImage className="server-avatar" label={server.name} src={server.avatarUrl} />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="server-actions">
        <IconButton label="Créer un serveur" onClick={onCreate}>
          <Plus size={20} />
        </IconButton>
        <IconButton label="Rejoindre un serveur" onClick={onJoin}>
          <LogIn size={20} />
        </IconButton>
      </div>
    </aside>
  );
}
