import { Plus } from 'lucide-react';
import type { ServerSummary } from '@discord2/shared';
import { IconButton } from '../../components/IconButton';

interface ServerRailProps {
  servers: ServerSummary[];
  activeServerId: string | null;
  onSelect: (serverId: string) => void;
  onCreate: () => void;
}

export function ServerRail({
  servers,
  activeServerId,
  onSelect,
  onCreate,
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
      <IconButton label="Créer un serveur" onClick={onCreate}>
        <Plus size={20} />
      </IconButton>
    </aside>
  );
}
