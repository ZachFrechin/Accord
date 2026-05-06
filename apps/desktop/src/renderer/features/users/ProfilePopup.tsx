import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { UserProfile } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { ApiClient } from '../../lib/api-client';
import type { Session } from '@supabase/supabase-js';

interface ProfilePopupProps {
  userId: string;
  session: Session;
  onClose: () => void;
}

export function ProfilePopup({ userId, session, onClose }: ProfilePopupProps): React.JSX.Element {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = new ApiClient(session);

    api.users
      .getById(userId)
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erreur inconnue');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId, session]);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.currentTarget === event.target) {
      onClose();
    }
  }

  return (
    <div className="profile-popup-backdrop" onClick={handleBackdropClick} role="presentation">
      <section
        className="profile-popup"
        role="dialog"
        aria-modal="true"
        aria-label="Profil utilisateur"
      >
        <div className="profile-popup-banner" />
        <div className="profile-popup-avatar-wrap">
          <AvatarImage
            className="profile-popup-avatar"
            label={profile?.displayName ?? 'Utilisateur'}
            src={profile?.avatarUrl}
          />
        </div>
        <div className="profile-popup-body">
          <header
            style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}
          >
            <div>
              {loading ? (
                <p className="profile-popup-name">Chargement…</p>
              ) : error ? (
                <p className="profile-popup-name" style={{ color: '#ff9999' }}>
                  {error}
                </p>
              ) : (
                <>
                  <p className="profile-popup-name">{profile?.displayName}</p>
                  <p className="profile-popup-id">ID : {profile?.id}</p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer"
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 32,
                height: 32,
                borderRadius: 8,
                color: '#505050',
                background: 'transparent',
                flexShrink: 0,
                marginTop: 2,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#e8e8e8';
                e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#505050';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <X size={18} />
            </button>
          </header>

          {!loading && !error && profile ? (
            <>
              <div className="profile-popup-divider" />
              <div className="profile-popup-section">
                <h4>Email</h4>
                <p>{profile.email ?? 'Non renseigné'}</p>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
