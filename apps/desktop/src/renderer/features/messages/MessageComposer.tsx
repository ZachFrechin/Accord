import { useState } from 'react';
import { Send } from 'lucide-react';
import type { ServerMemberProfile, ServerRole } from '@discord2/shared';

interface MessageComposerProps {
  disabled: boolean;
  error: string | null;
  members: ServerMemberProfile[];
  roles: ServerRole[];
  onSend: (content: string) => Promise<void>;
}

export function MessageComposer({
  disabled,
  error,
  members,
  roles,
  onSend,
}: MessageComposerProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const mentionQuery = getMentionQuery(content);
  const mentionSuggestions = mentionQuery
    ? [
        ...members
          .filter((member) => member.profile.displayName.toLocaleLowerCase().includes(mentionQuery))
          .slice(0, 5)
          .map((member) => ({
            id: member.userId,
            label: member.profile.displayName,
            token: `@${member.profile.displayName}`,
            kind: 'Utilisateur',
          })),
        ...roles
          .filter(
            (role) => role.mentionable && role.name.toLocaleLowerCase().includes(mentionQuery),
          )
          .slice(0, 5)
          .map((role) => ({
            id: role.id,
            label: role.name,
            token: `@${role.name}`,
            kind: 'Rôle',
          })),
      ].slice(0, 8)
    : [];

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

  function insertMention(token: string): void {
    const match = content.match(/(?:^|\s)@([\p{L}\p{N}_. -]{0,40})$/u);
    if (!match || match.index === undefined) {
      setContent(`${content}${content.endsWith(' ') ? '' : ' '}${token} `);
      return;
    }

    const prefix = content.slice(0, match.index);
    const spacing = match[0].startsWith(' ') ? ' ' : '';
    setContent(`${prefix}${spacing}${token} `);
  }

  return (
    <div className="composer-wrap">
      {error ? <div className="composer-error">{error}</div> : null}
      {mentionSuggestions.length > 0 ? (
        <div className="mention-suggestions">
          {mentionSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.kind}:${suggestion.id}`}
              type="button"
              onClick={() => insertMention(suggestion.token)}
            >
              <span>@{suggestion.label}</span>
              <small>{suggestion.kind}</small>
            </button>
          ))}
        </div>
      ) : null}
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

function getMentionQuery(content: string): string | null {
  const match = content.match(/(?:^|\s)@([\p{L}\p{N}_. -]{0,40})$/u);
  const query = match?.[1]?.trim().toLocaleLowerCase();
  if (query === undefined) {
    return null;
  }

  return query;
}
