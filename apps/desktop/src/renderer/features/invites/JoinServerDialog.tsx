import { useState } from 'react';
import { Dialog } from '../../components/Dialog';

interface JoinServerDialogProps {
  isSubmitting: boolean;
  error: string | null;
  onClose: () => void;
  onJoin: (code: string) => Promise<void>;
}

export function JoinServerDialog({
  isSubmitting,
  error,
  onClose,
  onJoin,
}: JoinServerDialogProps): React.JSX.Element {
  const [code, setCode] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    await onJoin(trimmed);
  }

  return (
    <Dialog title="Rejoindre un serveur" onClose={onClose}>
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label>
          Code d’invitation
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="ABCDEF1234567890"
            autoFocus
          />
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <button type="submit" disabled={isSubmitting || !code.trim()}>
          {isSubmitting ? 'Rejoignement...' : 'Rejoindre'}
        </button>
      </form>
    </Dialog>
  );
}
