import { LogOut, Mic, Palette, Settings } from 'lucide-react';
import type { UserProfile } from '@discord2/shared';
import { AvatarImage } from '../components/AvatarImage';
import { IconButton } from '../components/IconButton';

interface UserBarProps {
  profile: UserProfile | undefined;
  realtimeStatus: string;
  onOpenSettings: () => void;
  onOpenThemePicker: () => void;
  onOpenVoiceSettings: () => void;
  onLogout: () => void;
}

export function UserBar({
  profile,
  realtimeStatus,
  onOpenSettings,
  onOpenThemePicker,
  onOpenVoiceSettings,
  onLogout,
}: UserBarProps): React.JSX.Element {
  return (
    <footer className="user-bar">
      <AvatarImage
        className="avatar small"
        label={profile?.displayName ?? 'Utilisateur'}
        src={profile?.avatarUrl}
      />
      <div className="user-meta">
        <strong>{profile?.displayName ?? 'Utilisateur'}</strong>
        <span data-status={realtimeStatus}>{realtimeStatus}</span>
      </div>
      <div className="user-actions">
        <IconButton label="Paramètres profil" disabled={!profile} onClick={onOpenSettings}>
          <Settings size={18} />
        </IconButton>
        <IconButton label="Paramètres vocaux" onClick={onOpenVoiceSettings}>
          <Mic size={18} />
        </IconButton>
        <IconButton label="Changer de thème" onClick={onOpenThemePicker}>
          <Palette size={18} />
        </IconButton>
        <IconButton label="Déconnexion" onClick={onLogout}>
          <LogOut size={18} />
        </IconButton>
      </div>
    </footer>
  );
}
