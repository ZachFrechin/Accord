import { useState } from 'react';
import { Dialog } from '../../components/Dialog';

interface CreateServerDialogProps {
  isSubmitting: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export function CreateServerDialog({
  isSubmitting,
  onClose,
  onCreate,
}: CreateServerDialogProps): React.JSX.Element {
  const [name, setName] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    await onCreate(name.trim());
  }

  return (
    <Dialog title="Créer un serveur" onClose={onClose}>
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label>
          Nom du serveur
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <button type="submit" disabled={isSubmitting || !name.trim()}>
          Créer
        </button>
      </form>
    </Dialog>
  );
}
