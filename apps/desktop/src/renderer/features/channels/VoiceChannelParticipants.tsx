import { useQueries } from '@tanstack/react-query';
import type { UserId } from '@discord2/shared';
import { Tooltip } from '../../components/Tooltip';
import type { ApiClient } from '../../lib/api-client';

interface VoiceChannelParticipantsProps {
  api: ApiClient;
  userIds: UserId[];
}

export function VoiceChannelParticipants({
  api,
  userIds,
}: VoiceChannelParticipantsProps): React.JSX.Element | null {
  const profileQueries = useQueries({
    queries: userIds.map((userId) => ({
      queryKey: ['users', userId],
      queryFn: () => api.users.getById(userId),
      staleTime: 60_000,
    })),
  });

  if (userIds.length === 0) {
    return null;
  }

  return (
    <div className="voice-channel-participants">
      <div className="voice-participant-avatars">
        {userIds.map((userId, index) => {
          const profile = profileQueries[index]?.data;
          const label = profile?.displayName ?? userId.slice(0, 8);
          return (
            <Tooltip key={userId} label={label}>
              {profile?.avatarUrl ? (
                <img
                  className="voice-participant-avatar"
                  src={profile.avatarUrl}
                  alt={label}
                  style={{ zIndex: userIds.length - index }}
                />
              ) : (
                <div className="voice-participant-avatar fallback" style={{ zIndex: userIds.length - index }}>
                  {label.charAt(0).toUpperCase()}
                </div>
              )}
            </Tooltip>
          );
        })}
      </div>
      <span className="voice-participant-count">
        {userIds.length} {userIds.length === 1 ? 'connecté' : 'connectés'}
      </span>
    </div>
  );
}
