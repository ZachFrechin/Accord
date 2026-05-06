import { useState } from 'react';
import { LogIn, Plus } from 'lucide-react';
import type { ServerSummary } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { IconButton } from '../../components/IconButton';

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
  const [tooltip, setTooltip] = useState<{ label: string; top: number } | null>(null);

  function showTooltip(label: string, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    setTooltip({ label, top: rect.top + rect.height / 2 });
  }

  return (
    <aside className="server-rail" aria-label="Serveurs">
      <div className="server-list">
        {isLoading
          ? Array.from({ length: 4 }, (_, index) => (
              <div className="server-dot skeleton-dot" key={index} />
            ))
          : null}
        {servers.map((server) => (
          <div className="server-dot-wrap" key={server.id}>
            <button
              className={`server-dot${server.id === activeServerId ? ' active' : ''}`}
              type="button"
              aria-label={server.name}
              onBlur={() => setTooltip(null)}
              onFocus={(event) => showTooltip(server.name, event.currentTarget)}
              onMouseEnter={(event) => showTooltip(server.name, event.currentTarget)}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => onSelect(server.id)}
            >
              <AvatarImage className="server-avatar" label={server.name} src={server.avatarUrl} />
            </button>
          </div>
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
      {tooltip ? (
        <div className="server-tooltip-floating" role="tooltip" style={{ top: tooltip.top }}>
          {tooltip.label}
        </div>
      ) : null}
    </aside>
  );
}
