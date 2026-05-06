import { LogOut } from 'lucide-react';
import type { UserProfile } from '@discord2/shared';
import { IconButton } from '../components/IconButton';
import { supabase } from '../lib/supabase';

interface UserBarProps {
  profile: UserProfile | undefined;
  realtimeStatus: string;
}

export function UserBar({ profile, realtimeStatus }: UserBarProps): React.JSX.Element {
  return (
    <footer className="user-bar">
      <div className="avatar small">{(profile?.displayName ?? 'U').slice(0, 1).toUpperCase()}</div>
      <div className="user-meta">
        <strong>{profile?.displayName ?? 'Utilisateur'}</strong>
        <span>{realtimeStatus}</span>
      </div>
      <IconButton label="Déconnexion" onClick={() => void supabase.auth.signOut()}>
        <LogOut size={18} />
      </IconButton>
    </footer>
  );
}
