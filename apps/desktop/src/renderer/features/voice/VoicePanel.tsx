import { useQueries } from '@tanstack/react-query';
import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import type { ChannelSummary, UserId } from '@discord2/shared';
import { IconButton } from '../../components/IconButton';
import type { ApiClient } from '../../lib/api-client';
import type { VoiceStatus } from '../../store/ui-store';

interface VoicePanelProps {
  api: ApiClient;
  channel: ChannelSummary | null;
  participantIds: UserId[];
  status: VoiceStatus;
  error: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
}

export function VoicePanel({
  api,
  channel,
  participantIds,
  status,
  error,
  isMuted,
  isDeafened,
  onToggleMute,
  onToggleDeafen,
  onLeave,
}: VoicePanelProps): React.JSX.Element | null {
  const profileQueries = useQueries({
    queries: participantIds.map((userId) => ({
      queryKey: ['users', userId],
      queryFn: () => api.users.getById(userId),
      staleTime: 60_000,
    })),
  });

  if (!channel && !error) {
    return null;
  }

  const isConnected = status === 'connected';
  const isBusy = status === 'connecting' || status === 'disconnecting';

  return (
    <section className="voice-panel" aria-label="Salon vocal actif">
      <div className="voice-panel-header">
        <div>
          <span>{getStatusLabel(status)}</span>
          <strong>{channel?.name ?? 'Vocal'}</strong>
        </div>
        <IconButton label="Quitter le vocal" disabled={!channel || isBusy} onClick={onLeave}>
          <PhoneOff size={17} />
        </IconButton>
      </div>
      {error ? <p className="voice-error">{error}</p> : null}
      {participantIds.length > 0 ? (
        <div className="voice-participants">
          {participantIds.map((userId, index) => {
            const profile = profileQueries[index]?.data;
            return <span key={userId}>{profile?.displayName ?? userId.slice(0, 8)}</span>;
          })}
        </div>
      ) : (
        <p className="voice-empty">Aucun participant synchronisé.</p>
      )}
      <div className="voice-controls">
        <IconButton
          label={isMuted ? 'Réactiver le micro' : 'Couper le micro'}
          disabled={!isConnected}
          onClick={onToggleMute}
        >
          {isMuted ? <MicOff size={17} /> : <Mic size={17} />}
        </IconButton>
        <IconButton
          label={isDeafened ? 'Réactiver le son' : 'Couper le son'}
          disabled={!isConnected}
          onClick={onToggleDeafen}
        >
          {isDeafened ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </IconButton>
      </div>
    </section>
  );
}

function getStatusLabel(status: VoiceStatus): string {
  if (status === 'connecting') return 'Connexion';
  if (status === 'disconnecting') return 'Déconnexion';
  if (status === 'connected') return 'Connecté';
  if (status === 'error') return 'Erreur vocal';
  return 'Vocal';
}
