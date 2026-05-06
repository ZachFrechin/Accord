import { ChannelType, type ChannelSummary } from '@discord2/shared';
import { Dialog } from '../../components/Dialog';

interface DeleteChannelDialogProps {
  channel: ChannelSummary;
  isDeleting: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
}

export function DeleteChannelDialog({
  channel,
  isDeleting,
  onClose,
  onDelete,
}: DeleteChannelDialogProps): React.JSX.Element {
  const kind = channel.type === ChannelType.Voice ? 'vocal' : 'texte';

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onDelete();
  }

  return (
    <Dialog title="Supprimer le salon" onClose={onClose}>
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <p className="muted">
          Le salon {kind} <strong>{channel.name}</strong> sera supprimé pour tous les membres. Cette
          action est définitive.
        </p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="danger-button" disabled={isDeleting}>
            Supprimer
          </button>
        </div>
      </form>
    </Dialog>
  );
}
