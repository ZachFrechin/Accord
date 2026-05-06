import { LogOut, Moon, Sun } from 'lucide-react';
import type { UserProfile } from '@discord2/shared';
import { IconButton } from '../components/IconButton';
import { supabase } from '../lib/supabase';
import { useUiStore } from '../store/ui-store';

interface UserBarProps {
  profile: UserProfile | undefined;
  realtimeStatus: string;
}

export function UserBar({ profile, realtimeStatus }: UserBarProps): React.JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  return (
    <footer className="user-bar">
      <div className="avatar small">{(profile?.displayName ?? 'U').slice(0, 1).toUpperCase()}</div>
      <div className="user-meta">
        <strong>{profile?.displayName ?? 'Utilisateur'}</strong>
        <span data-status={realtimeStatus}>{realtimeStatus}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
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
