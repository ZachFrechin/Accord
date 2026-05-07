import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { MessageEmbedType } from '@discord2/shared';
import type {
  MessageMention,
  MessageRecord,
  MessageAttachment,
  MessageEmbed,
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
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachment | null>(null);
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
                  {message.content ? (
                    <p>{renderMessageContent(message.content, message.mentions ?? [])}</p>
                  ) : null}
                  <MessageAttachments
                    attachments={message.attachments}
                    onPreview={setPreviewAttachment}
                  />
                  <MessageEmbeds embeds={message.embeds} />
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
      {previewAttachment ? (
        <div
          className="media-preview-backdrop"
          role="presentation"
          onMouseDown={() => setPreviewAttachment(null)}
        >
          <div className="media-preview-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="media-preview-close"
              aria-label="Fermer l’aperçu"
              onClick={() => setPreviewAttachment(null)}
            >
              ×
            </button>
            <img alt={previewAttachment.fileName ?? 'Média'} src={previewAttachment.url} />
          </div>
        </div>
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

function MessageAttachments({
  attachments,
  onPreview,
}: {
  attachments: MessageAttachment[];
  onPreview: (attachment: MessageAttachment) => void;
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="message-attachments">
      {attachments.map((attachment) => {
        if (attachment.mimeType.startsWith('image/')) {
          return (
            <button
              type="button"
              className="message-media image"
              key={attachment.id}
              onClick={() => onPreview(attachment)}
            >
              <img alt={attachment.fileName ?? 'Image'} src={attachment.url} loading="lazy" />
            </button>
          );
        }

        if (attachment.mimeType.startsWith('video/')) {
          return (
            <video
              className="message-media video"
              controls
              key={attachment.id}
              preload="metadata"
              src={attachment.url}
            />
          );
        }

        return (
          <a
            className="message-file-link"
            href={attachment.url}
            key={attachment.id}
            rel="noreferrer"
            target="_blank"
          >
            {attachment.fileName ?? 'Fichier'}
          </a>
        );
      })}
    </div>
  );
}

function MessageEmbeds({ embeds }: { embeds: MessageEmbed[] }): React.JSX.Element | null {
  if (embeds.length === 0) {
    return null;
  }

  return (
    <div className="message-embeds">
      {embeds.map((embed) => {
        if (embed.type === MessageEmbedType.YouTube && embed.embedUrl) {
          return (
            <div className="message-embed youtube" key={embed.id}>
              <iframe
                src={embed.embedUrl}
                title={embed.title ?? 'Vidéo YouTube'}
                loading="lazy"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          );
        }

        if (embed.type === MessageEmbedType.Image && embed.thumbnailUrl) {
          return (
            <a
              className="message-embed image"
              href={embed.url}
              key={embed.id}
              rel="noreferrer"
              target="_blank"
            >
              <img alt={embed.title ?? embed.url} src={embed.thumbnailUrl} loading="lazy" />
            </a>
          );
        }

        return (
          <a
            className="message-embed link"
            href={embed.url}
            key={embed.id}
            rel="noreferrer"
            target="_blank"
          >
            {embed.thumbnailUrl ? <img alt="" src={embed.thumbnailUrl} loading="lazy" /> : null}
            <span>
              <strong>{embed.title ?? embed.url}</strong>
              {embed.description ? <small>{embed.description}</small> : null}
              {embed.provider ? <em>{embed.provider}</em> : null}
            </span>
          </a>
        );
      })}
    </div>
  );
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
