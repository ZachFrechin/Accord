import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { UserProfile } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { Dialog } from '../../components/Dialog';
import { uploadPublicImage } from '../../lib/storage-upload';
import { supabase } from '../../lib/supabase';

interface ProfileSettingsDialogProps {
  profile: UserProfile;
  session: Session;
  isSavingProfile: boolean;
  onClose: () => void;
  onSaveProfile: (input: { displayName: string; avatarUrl: string | null }) => Promise<void>;
}

export function ProfileSettingsDialog({
  profile,
  session,
  isSavingProfile,
  onClose,
  onSaveProfile,
}: ProfileSettingsDialogProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile.avatarUrl);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (!avatarFile) {
      setPreviewUrl(null);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(avatarFile);
    setPreviewUrl(nextPreviewUrl);

    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [avatarFile]);

  async function submitProfile(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setProfileError(null);

    try {
      const uploadedAvatarUrl = avatarFile
        ? await uploadPublicImage('profile-avatars', profile.id, avatarFile)
        : avatarUrl;
      await onSaveProfile({
        displayName: displayName.trim(),
        avatarUrl: uploadedAvatarUrl,
      });
      setAvatarUrl(uploadedAvatarUrl);
      setAvatarFile(null);
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : 'Impossible de sauvegarder le profil.',
      );
    }
  }

  async function submitPassword(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!session.user.email) {
      setPasswordError('Aucun email de connexion disponible pour revalider la session.');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('Le nouveau mot de passe doit contenir au moins 8 caractères.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('La confirmation ne correspond pas au nouveau mot de passe.');
      return;
    }

    setIsSavingPassword(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: session.user.email,
        password: currentPassword,
      });
      if (signInError) {
        throw new Error('Mot de passe actuel invalide.');
      }

      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        throw new Error(updateError.message);
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('Mot de passe mis à jour.');
    } catch (error) {
      setPasswordError(
        error instanceof Error ? error.message : 'Impossible de changer le mot de passe.',
      );
    } finally {
      setIsSavingPassword(false);
    }
  }

  return (
    <Dialog title="Paramètres profil" onClose={onClose}>
      <div className="settings-dialog">
        <form className="settings-section" onSubmit={(event) => void submitProfile(event)}>
          <div className="avatar-field">
            <AvatarImage
              className="settings-avatar"
              label={displayName}
              src={previewUrl ?? avatarUrl}
            />
            <label className="file-field">
              <span>Photo de profil</span>
              <span className="file-picker">
                <span className="file-picker-button">Choisir une image</span>
                <span className="file-picker-name">
                  {avatarFile?.name ?? 'Aucune image choisie'}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}
                />
              </span>
            </label>
          </div>
          <label>
            Pseudo
            <input
              value={displayName}
              minLength={1}
              maxLength={40}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          {profileError ? <div className="form-error">{profileError}</div> : null}
          <div className="form-actions">
            <button type="submit" disabled={isSavingProfile || !displayName.trim()}>
              Sauvegarder le profil
            </button>
          </div>
        </form>

        <form className="settings-section" onSubmit={(event) => void submitPassword(event)}>
          <h3>Mot de passe</h3>
          <input
            className="visually-hidden"
            type="email"
            autoComplete="username"
            value={session.user.email ?? ''}
            readOnly
            tabIndex={-1}
          />
          <label>
            Mot de passe actuel
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            Nouveau mot de passe
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label>
            Confirmer le nouveau mot de passe
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          {passwordError ? <div className="form-error">{passwordError}</div> : null}
          {passwordSuccess ? <div className="form-success">{passwordSuccess}</div> : null}
          <div className="form-actions">
            <button
              type="submit"
              disabled={isSavingPassword || !currentPassword || !newPassword || !confirmPassword}
            >
              Changer le mot de passe
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
