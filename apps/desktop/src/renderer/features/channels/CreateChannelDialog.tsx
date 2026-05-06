import { useState } from 'react';
import { ChannelType } from '@discord2/shared';
import { Dialog } from '../../components/Dialog';

interface CreateChannelDialogProps {
  isSubmitting: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export function CreateChannelDialog({
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

    await onCreate(name.trim());
  }

  return (
    <Dialog title="Créer un salon texte" onClose={onClose}>
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label>
          Nom du salon
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <input type="hidden" value={ChannelType.Text} readOnly />
        <button type="submit" disabled={isSubmitting || !name.trim()}>
          Créer
        </button>
      </form>
    </Dialog>
  );
}
