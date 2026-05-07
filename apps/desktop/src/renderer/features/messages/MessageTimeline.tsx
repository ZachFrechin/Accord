import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type {
  MessageMention,
  MessageRecord,
  ServerMemberProfile,
  ServerRole,
} from '@discord2/shared';
import { AvatarImage } from '../../components/AvatarImage';
import { ProfilePopup } from '../users/ProfilePopup';

interface MessageTimelineProps {
  messages: MessageRecord[];
  isLoading: boolean;
  session: Session;
  members: ServerMemberProfile[];
  roles: ServerRole[];
}

export function MessageTimeline({
  messages,
  isLoading,
  session,
  members,
  roles,
}: MessageTimelineProps): React.JSX.Element {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);
  const currentMember = members.find((member) => member.userId === session.user.id);
  const currentRoleIds = new Set(currentMember?.roleIds ?? []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (messages.length > prevCountRef.current) {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages.length]);

  if (isLoading) {
    return (
      <div className="messages-wrapper">
        <div className="message-list">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="message-row skeleton-message" key={index}>
              <div className="avatar skeleton-dot" />
              <div className="message-body">
                <div className="skeleton-line short" />
                <div className="skeleton-line" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
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
      <div className="messages-wrapper">
        <div className="message-list" ref={listRef}>
          {messages.map((message) => {
            const authorRole = getPrimaryRole(message.authorId, members, roles);
            const isMentioningCurrentUser = isMessageMentioningCurrentUser(
              message.mentions ?? [],
              session.user.id,
              currentRoleIds,
            );

            return (
              <article
                className={`message-row${message.id.startsWith('pending-') ? ' pending' : ''}${
                  isMentioningCurrentUser ? ' mentioned-current-user' : ''
                }`}
                key={message.id}
              >
                <AvatarImage
                  label={message.author?.displayName ?? 'Utilisateur'}
                  src={message.author?.avatarUrl}
                />
                <div className="message-body">
                  <div className="message-meta">
                    <strong
                      className="author-name"
                      role="button"
                      tabIndex={0}
                      style={
                        authorRole
                          ? ({ '--author-role-color': authorRole.color } as React.CSSProperties)
                          : undefined
                      }
                      onClick={() => setSelectedUserId(message.authorId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setSelectedUserId(message.authorId);
                        }
                      }}
                    >
                      {message.author?.displayName ?? 'Utilisateur'}
                    </strong>
                    <span>
                      {message.id.startsWith('pending-')
                        ? 'Envoi...'
                        : formatMessageTime(message.createdAt)}
                    </span>
                  </div>
                  <p>{renderMessageContent(message.content, message.mentions ?? [])}</p>
                </div>
              </article>
            );
          })}
        </div>
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

function getPrimaryRole(
  userId: string,
  members: ServerMemberProfile[],
  roles: ServerRole[],
): ServerRole | null {
  const member = members.find((candidate) => candidate.userId === userId);
  if (!member) {
    return null;
  }

  const roleById = new Map(roles.map((role) => [role.id, role]));
  return (
    member.roleIds
      .map((roleId) => roleById.get(roleId))
      .filter((role): role is ServerRole => Boolean(role))
      .sort((left, right) => left.position - right.position)[0] ?? null
  );
}

function isMessageMentioningCurrentUser(
  mentions: MessageMention[],
  userId: string,
  roleIds: Set<string>,
): boolean {
  return mentions.some((mention) => {
    if (mention.type === 'user') {
      return mention.userId === userId;
    }

    return roleIds.has(mention.roleId);
  });
}

function renderMessageContent(
  content: string | null,
  mentions: MessageMention[],
): React.ReactNode[] | string {
  if (!content || mentions.length === 0) {
    return content ?? '';
  }

  const mentionPatterns = mentions
    .map((mention) => ({
      mention,
      label: mention.type === 'user' ? mention.displayName : mention.name,
    }))
    .sort((a, b) => b.label.length - a.label.length);
  const pattern = new RegExp(
    `@(${mentionPatterns.map((item) => escapeRegExp(item.label)).join('|')})(?=$|\\s|[,.!?;:])`,
    'giu',
  );
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    const name = match[1]?.trim() ?? '';
    const mention = mentionPatterns.find(
      (item) => item.label.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )?.mention;
    if (!mention || match.index === undefined) {
      continue;
    }

    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }

    parts.push(
      <span
        className={`message-mention ${mention.type === 'role' ? 'role' : 'user'}`}
        key={`${mention.type}:${mention.type === 'user' ? mention.userId : mention.roleId}:${match.index}`}
        style={
          mention.type === 'role'
            ? ({ '--mention-color': mention.color } as React.CSSProperties)
            : undefined
        }
      >
        @{name}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
