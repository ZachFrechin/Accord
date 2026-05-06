import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { MessageRecord } from '@discord2/shared';
import { ProfilePopup } from '../users/ProfilePopup';

interface MessageTimelineProps {
  messages: MessageRecord[];
  isLoading: boolean;
  session: Session;
}

export function MessageTimeline({ messages, isLoading, session }: MessageTimelineProps): React.JSX.Element {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (messages.length > prevCountRef.current) {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages.length]);

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
    <>
      <div className="message-list" ref={listRef}>
        {messages.map((message) => (
          <article className="message-row" key={message.id}>
            <div className="avatar">
              {(message.author?.displayName ?? 'U').slice(0, 1).toUpperCase()}
            </div>
            <div className="message-body">
              <div className="message-meta">
                <strong
                  className="author-name"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedUserId(message.authorId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setSelectedUserId(message.authorId);
                    }
                  }}
                >
                  {message.author?.displayName ?? 'Utilisateur'}
                </strong>
                <span>{formatMessageTime(message.createdAt)}</span>
              </div>
              <p>{message.content}</p>
            </div>
          </article>
        ))}
      </div>
      {selectedUserId ? (
        <ProfilePopup
          userId={selectedUserId}
          session={session}
          onClose={() => setSelectedUserId(null)}
        />
      ) : null}
    </>
  );
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
