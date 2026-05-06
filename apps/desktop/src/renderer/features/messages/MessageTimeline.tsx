import type { MessageRecord } from '@discord2/shared';

interface MessageTimelineProps {
  messages: MessageRecord[];
  isLoading: boolean;
}

export function MessageTimeline({ messages, isLoading }: MessageTimelineProps): React.JSX.Element {
  if (isLoading) {
    return <div className="center-state">Chargement des messages...</div>;
  }

  if (messages.length === 0) {
    return (
      <div className="center-state">
        <h2>Aucun message</h2>
        <p>Écris le premier message de ce salon.</p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((message) => (
        <article className="message-row" key={message.id}>
          <div className="avatar">
            {(message.author?.displayName ?? 'U').slice(0, 1).toUpperCase()}
          </div>
          <div className="message-body">
            <div className="message-meta">
              <strong>{message.author?.displayName ?? 'Utilisateur'}</strong>
              <span>{formatMessageTime(message.createdAt)}</span>
            </div>
            <p>{message.content}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
