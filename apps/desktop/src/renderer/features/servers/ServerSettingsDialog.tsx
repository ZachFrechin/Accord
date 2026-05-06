import { useEffect, useState } from 'react';
import type { ServerSummary } from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { Dialog } from '../../components/Dialog';
import { uploadPublicImage } from '../../lib/storage-upload';

interface ServerSettingsDialogProps {
  server: ServerSummary;
  isSaving: boolean;
  onClose: () => void;
  onSave: (input: { name: string; avatarUrl: string | null }) => Promise<void>;
}

export function ServerSettingsDialog({
  server,
  isSaving,
  onClose,
  onSave,
}: ServerSettingsDialogProps): React.JSX.Element {
  const [name, setName] = useState(server.name);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(server.avatarUrl);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!avatarFile) {
      setPreviewUrl(null);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(avatarFile);
    setPreviewUrl(nextPreviewUrl);

    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [avatarFile]);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      const uploadedAvatarUrl = avatarFile
        ? await uploadPublicImage('server-icons', server.id, avatarFile)
        : avatarUrl;
      await onSave({
        name: name.trim(),
        avatarUrl: uploadedAvatarUrl,
      });
      setAvatarUrl(uploadedAvatarUrl);
      setAvatarFile(null);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : 'Impossible de sauvegarder le serveur.',
      );
    }
  }

  return (
    <Dialog title="Paramètres serveur" onClose={onClose}>
      <form className="settings-section" onSubmit={(event) => void submit(event)}>
        <div className="avatar-field">
          <AvatarImage className="settings-avatar" label={name} src={previewUrl ?? avatarUrl} />
          <label className="file-field">
            <span>Photo du serveur</span>
            <span className="file-picker">
              <span className="file-picker-button">Choisir une image</span>
              <span className="file-picker-name">{avatarFile?.name ?? 'Aucune image choisie'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)}
              />
            </span>
          </label>
        </div>
        <label>
          Nom du serveur
          <input
            value={name}
            minLength={1}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="form-actions">
          <button type="submit" disabled={isSaving || !name.trim()}>
            Sauvegarder le serveur
          </button>
        </div>
      </form>
    </Dialog>
  );
}
