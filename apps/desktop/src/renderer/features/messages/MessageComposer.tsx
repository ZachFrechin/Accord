import { useState } from 'react';
import { Send } from 'lucide-react';

interface MessageComposerProps {
  disabled: boolean;
  onSend: (content: string) => Promise<void>;
}

export function MessageComposer({ disabled, onSend }: MessageComposerProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || disabled || isSending) {
      return;
    }

    setIsSending(true);
    await onSend(trimmed);
    setContent('');
    setIsSending(false);
  }

  return (
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
  );
}
