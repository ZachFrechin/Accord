import { LogOut, Moon, Settings, Sun } from 'lucide-react';
import type { UserProfile } from '@discord2/shared';
import { AvatarImage } from '../components/AvatarImage';
import { IconButton } from '../components/IconButton';
import { supabase } from '../lib/supabase';
import { useUiStore } from '../store/ui-store';

interface UserBarProps {
  profile: UserProfile | undefined;
  realtimeStatus: string;
  onOpenSettings: () => void;
}

export function UserBar({
  profile,
  realtimeStatus,
  onOpenSettings,
}: UserBarProps): React.JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

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
        <IconButton label={theme === 'dark' ? 'Mode clair' : 'Mode sombre'} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
        <IconButton label="Déconnexion" onClick={() => void supabase.auth.signOut()}>
          <LogOut size={18} />
        </IconButton>
      </div>
    </footer>
  );
}
