import { LogIn, Plus } from 'lucide-react';
import type { ServerSummary } from '@discord2/shared';
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
            {server.name.slice(0, 2).toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 10, padding: '0 10px' }}>
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
