import { LogIn, Plus } from 'lucide-react';
import type { ServerSummary } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { IconButton } from '../../components/IconButton';

interface ServerRailProps {
  servers: ServerSummary[];
  activeServerId: string | null;
  onSelect: (serverId: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}

export function ServerRail({
  servers,
  activeServerId,
  onSelect,
  onCreate,
  onJoin,
}: ServerRailProps): React.JSX.Element {
  return (
    <aside className="server-rail" aria-label="Serveurs">
      <div className="server-list">
        {servers.map((server) => (
          <button
            className={`server-dot${server.id === activeServerId ? ' active' : ''}`}
            key={server.id}
            type="button"
            title={server.name}
            onClick={() => onSelect(server.id)}
          >
            <AvatarImage className="server-avatar" label={server.name} src={server.avatarUrl} />
          </button>
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
