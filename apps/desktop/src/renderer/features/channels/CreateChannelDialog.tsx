import { useState } from 'react';
import { ChannelType } from '@discord2/shared';
import { Dialog } from '../../components/Dialog';

interface CreateChannelDialogProps {
  type: typeof ChannelType.Text | typeof ChannelType.Voice;
  isSubmitting: boolean;
  onClose: () => void;
  onCreate: (
    name: string,
    type: typeof ChannelType.Text | typeof ChannelType.Voice,
  ) => Promise<void>;
}

export function CreateChannelDialog({
  type,
  isSubmitting,
  onClose,
  onCreate,
}: CreateChannelDialogProps): React.JSX.Element {
  const [name, setName] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    await onCreate(name.trim(), type);
  }

  return (
    <Dialog
      title={type === ChannelType.Voice ? 'Créer un salon vocal' : 'Créer un salon texte'}
      onClose={onClose}
    >
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label>
          Nom du salon
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <input type="hidden" value={type} readOnly />
        <button type="submit" disabled={isSubmitting || !name.trim()}>
          Créer
        </button>
      </form>
    </Dialog>
  );
}
