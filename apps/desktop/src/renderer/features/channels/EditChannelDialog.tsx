import { useState } from 'react';
import { ChannelType, type ChannelSummary } from '@discord2/shared';
import { Dialog } from '../../components/Dialog';

interface EditChannelDialogProps {
  channel: ChannelSummary;
  isSubmitting: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}

export function EditChannelDialog({
  channel,
  isSubmitting,
  onClose,
  onSave,
}: EditChannelDialogProps): React.JSX.Element {
  const [name, setName] = useState(channel.name);
  const normalizedName = name.trim();
  const title =
    channel.type === ChannelType.Voice ? 'Modifier le salon vocal' : 'Modifier le salon';

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!normalizedName) {
      return;
    }

    await onSave(normalizedName);
  }

  return (
    <Dialog title={title} onClose={onClose}>
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
      </form>
    </Dialog>
  );
}
