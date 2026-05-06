import { useState } from 'react';
import { Send } from 'lucide-react';

interface MessageComposerProps {
  disabled: boolean;
  error: string | null;
  onSend: (content: string) => Promise<void>;
}

export function MessageComposer({
  disabled,
  error,
  onSend,
}: MessageComposerProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || disabled || isSending) {
      return;
    }

    setIsSending(true);
    try {
      await onSend(trimmed);
      setContent('');
    } catch {
      // The parent owns the visible error; keep the draft in place.
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="composer-wrap">
      {error ? <div className="composer-error">{error}</div> : null}
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <input
          value={content}
          disabled={disabled || isSending}
          placeholder={disabled ? 'Sélectionne un salon' : 'Écrire un message'}
          onChange={(event) => setContent(event.target.value)}
        />
        <button
          type="submit"
          disabled={disabled || isSending || !content.trim()}
          aria-label="Envoyer"
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
