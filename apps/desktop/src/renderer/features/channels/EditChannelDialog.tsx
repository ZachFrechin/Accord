import { useState } from 'react';
import { ChannelType, type ChannelSummary } from '@discord2/shared';
import { Dialog } from '../../components/Dialog';

interface EditChannelDialogProps {
  channel: ChannelSummary;
  isSubmitting: boolean;
  isDeleting: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function EditChannelDialog({
  channel,
  isSubmitting,
  isDeleting,
  onClose,
  onSave,
  onDelete,
}: EditChannelDialogProps): React.JSX.Element {
  const [name, setName] = useState(channel.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const normalizedName = name.trim();
  const kind = channel.type === ChannelType.Voice ? 'vocal' : 'texte';
  const title =
    channel.type === ChannelType.Voice ? 'Modifier le salon vocal' : 'Modifier le salon';

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!normalizedName) {
      return;
    }

    await onSave(normalizedName);
  }

  async function handleDelete(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onDelete();
  }

  return (
    <Dialog title={title} onClose={onClose}>
      {!showDeleteConfirm ? (
        <form className="stack-form" onSubmit={(event) => void submit(event)}>
          <label>
            Nom du salon
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" disabled={isSubmitting || !normalizedName}>
            Sauvegarder
          </button>
          <button
            type="button"
            className="delete-link-btn"
            disabled={isSubmitting || isDeleting}
            onClick={() => setShowDeleteConfirm(true)}
          >
            Supprimer le salon
          </button>
        </form>
      ) : (
        <form className="stack-form" onSubmit={(event) => void handleDelete(event)}>
          <p className="muted">
            Le salon {kind} <strong>{channel.name}</strong> sera supprimé pour tous les membres.
            Cette action est définitive.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowDeleteConfirm(false)}
            >
              Annuler
            </button>
            <button type="submit" className="danger-button" disabled={isDeleting}>
              Supprimer
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
