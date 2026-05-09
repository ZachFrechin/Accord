import { useState } from 'react';
import { ImagePlus, Send, X } from 'lucide-react';
import type { ServerMemberProfile, ServerRole } from '@discord2/shared';

export interface ComposerMediaDraft {
  id: string;
  file: File;
  previewUrl: string;
}

interface MessageComposerProps {
  disabled: boolean;
  canAttachFiles: boolean;
  canMentionEveryone: boolean;
  error: string | null;
  members: ServerMemberProfile[];
  roles: ServerRole[];
  onSend: (content: string, media: ComposerMediaDraft[]) => Promise<void>;
}

export function MessageComposer({
  disabled,
  canAttachFiles,
  canMentionEveryone,
  error,
  members,
  roles,
  onSend,
}: MessageComposerProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [mediaDrafts, setMediaDrafts] = useState<ComposerMediaDraft[]>([]);
  const [isSending, setIsSending] = useState(false);
  const mentionQuery = getMentionQuery(content);
  const mentionSuggestions = mentionQuery
    ? [
        ...(canMentionEveryone && 'everyone'.includes(mentionQuery)
          ? [
              {
                id: 'everyone',
                label: 'everyone',
                token: '@everyone',
                kind: 'Annonce',
              },
            ]
          : []),
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

  const canSubmit = Boolean(content.trim() || mediaDrafts.length > 0);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = content.trim();
    if (!canSubmit || disabled || isSending) {
      return;
    }

    setIsSending(true);
    try {
      await onSend(trimmed, mediaDrafts);
      setContent('');
      mediaDrafts.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
      setMediaDrafts([]);
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

  function addFiles(files: FileList | null): void {
    if (!files || files.length === 0) {
      return;
    }

    setMediaDrafts((current) => [
      ...current,
      ...Array.from(files)
        .slice(0, Math.max(0, 10 - current.length))
        .map((file) => ({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
        })),
    ]);
  }

  function removeFile(id: string): void {
    setMediaDrafts((current) => {
      const removed = current.find((draft) => draft.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((draft) => draft.id !== id);
    });
  }

  return (
    <div className="composer-wrap">
      {error ? <div className="composer-error">{error}</div> : null}
      {mediaDrafts.length > 0 ? (
        <div className="composer-media-preview">
          {mediaDrafts.map((draft) => (
            <div className="composer-media-item" key={draft.id}>
              {draft.file.type.startsWith('image/') ? (
                <img alt={draft.file.name} src={draft.previewUrl} />
              ) : (
                <video src={draft.previewUrl} muted preload="metadata" />
              )}
              <span>{draft.file.name}</span>
              <button
                type="button"
                aria-label={`Retirer ${draft.file.name}`}
                disabled={isSending}
                onClick={() => removeFile(draft.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
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
        <label className="composer-upload" aria-label="Ajouter un média">
          <ImagePlus size={18} />
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
            multiple
            disabled={!canAttachFiles || disabled || isSending || mediaDrafts.length >= 10}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
        <input
          value={content}
          disabled={disabled || isSending}
          placeholder={
            disabled
              ? 'Sélectionne un salon'
              : isSending
                ? 'Envoi des médias...'
                : 'Écrire un message'
          }
          onChange={(event) => setContent(event.target.value)}
        />
        <button type="submit" disabled={disabled || isSending || !canSubmit} aria-label="Envoyer">
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
