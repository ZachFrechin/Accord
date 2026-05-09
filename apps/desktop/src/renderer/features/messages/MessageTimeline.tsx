import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowDown, Check, Edit3, MoreHorizontal, SmilePlus, Trash2, X } from 'lucide-react';
import { MessageEmbedType, MessagePrivacy } from '@discord2/shared';
import type {
  MessageMention,
  MessageRecord,
  MessageAttachment,
  MessageEmbed,
  ServerMemberProfile,
  ServerRole,
} from '@discord2/shared';
import type { ConversationKey } from '@discord2/e2ee';
import { AvatarImage } from '../../components/AvatarImage';
import { ProfilePopup } from '../users/ProfilePopup';
import type { ApiClient } from '../../lib/api-client';
import {
  loadEncryptedAttachment,
  revokeDecryptedAttachment,
  type DecryptedAttachment,
} from '../../lib/encrypted-attachments';

interface MessageTimelineProps {
  messages: MessageRecord[];
  isLoading: boolean;
  session: Session;
  api: ApiClient;
  members: ServerMemberProfile[];
  roles: ServerRole[];
  conversationKey: ConversationKey | null;
  canManageMessages: boolean;
  hasMoreMessages: boolean;
  isLoadingMoreMessages: boolean;
  onLoadMoreMessages: () => void;
  onDeleteMessage: (messageId: string) => Promise<unknown>;
  onEditMessage: (messageId: string, content: string, channelId: string) => Promise<unknown>;
  onToggleReaction: (messageId: string, emoji: string) => Promise<unknown>;
}

export function MessageTimeline({
  messages,
  isLoading,
  session,
  api,
  members,
  roles,
  conversationKey,
  canManageMessages,
  hasMoreMessages,
  isLoadingMoreMessages,
  onLoadMoreMessages,
  onDeleteMessage,
  onEditMessage,
  onToggleReaction,
}: MessageTimelineProps): React.JSX.Element {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachment | null>(null);
  const [openActionsMessageId, setOpenActionsMessageId] = useState<string | null>(null);
  const [actionMenuDirection, setActionMenuDirection] = useState<'down' | 'up'>('down');

  function toggleActionMenu(messageId: string, trigger: HTMLElement): void {
    if (openActionsMessageId === messageId) {
      setOpenActionsMessageId(null);
      return;
    }
    const list = listRef.current;
    if (list) {
      const triggerRect = trigger.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const spaceBelow = listRect.bottom - triggerRect.bottom;
      setActionMenuDirection(spaceBelow < 220 ? 'up' : 'down');
    } else {
      setActionMenuDirection('down');
    }
    setOpenActionsMessageId(messageId);
  }
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const pendingScrollAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const currentMember = members.find((member) => member.userId === session.user.id);
  const currentRoleIds = new Set(currentMember?.roleIds ?? []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (pendingScrollAnchorRef.current) {
      const { height, top } = pendingScrollAnchorRef.current;
      list.scrollTop = list.scrollHeight - height + top;
      pendingScrollAnchorRef.current = null;
      return;
    }

    if (isNearBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  function handleScroll(event: React.UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = distanceFromBottom < 100;
    isNearBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);

    if (
      hasMoreMessages &&
      !isLoadingMoreMessages &&
      list.scrollTop <= 80 &&
      !pendingScrollAnchorRef.current
    ) {
      pendingScrollAnchorRef.current = {
        height: list.scrollHeight,
        top: list.scrollTop,
      };
      onLoadMoreMessages();
    }
  }

  function jumpToBottom(): void {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    isNearBottomRef.current = true;
    setShowJumpToBottom(false);
  }

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
        {showJumpToBottom ? (
          <button
            type="button"
            className="jump-to-bottom"
            aria-label="Aller au dernier message"
            onClick={jumpToBottom}
          >
            <ArrowDown size={16} />
            Récents
          </button>
        ) : null}
        <div className="message-list" ref={listRef} onScroll={handleScroll}>
          {isLoadingMoreMessages ? (
            <div className="messages-loading-more">Chargement…</div>
          ) : !hasMoreMessages && messages.length >= 30 ? (
            <div className="messages-history-end">Début de l’historique</div>
          ) : null}
          {messages.map((message) => {
            const authorRole = getPrimaryRole(message.authorId, members, roles);
            const isE2ee = message.privacy === MessagePrivacy.EndToEndEncrypted;
            const displayMentions = isE2ee
              ? detectClientMentions(message.content, members, roles)
              : message.mentions && message.mentions.length > 0
                ? message.mentions
                : detectClientMentions(message.content, members, roles);
            const isMentioningCurrentUser = isMessageMentioningCurrentUser(
              displayMentions,
              session.user.id,
              currentRoleIds,
            );
            const clientEmbeds = createClientOnlyEmbeds(message.content);
            const canDeleteMessage =
              !message.id.startsWith('pending-') &&
              (message.authorId === session.user.id || canManageMessages);
            const canEditMessage =
              !message.id.startsWith('pending-') && message.authorId === session.user.id;
            const canReactToMessage = !message.id.startsWith('pending-');
            const isEditing = editingMessageId === message.id;
            const reactions = message.reactions ?? [];

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
                    {authorRole ? (
                      <span
                        className="message-role-tag"
                        style={{ '--role-color': authorRole.color } as React.CSSProperties}
                      >
                        {authorRole.name}
                      </span>
                    ) : null}
                    {message.editedAt ? <span className="message-edited">modifié</span> : null}
                    {canEditMessage || canDeleteMessage || canReactToMessage ? (
                      <div className="message-actions">
                        <button
                          type="button"
                          aria-label="Actions du message"
                          onClick={(event) => toggleActionMenu(message.id, event.currentTarget)}
                        >
                          <MoreHorizontal size={15} />
                        </button>
                        {openActionsMessageId === message.id ? (
                          <div
                            className={`message-action-menu${actionMenuDirection === 'up' ? ' open-up' : ''}`}
                          >
                            {canReactToMessage ? (
                              <div className="message-reaction-picker" aria-label="Réactions">
                                {COMMON_REACTIONS.map((emoji) => (
                                  <button
                                    type="button"
                                    key={emoji}
                                    aria-label={`Réagir avec ${emoji}`}
                                    onClick={() => {
                                      setOpenActionsMessageId(null);
                                      void onToggleReaction(message.id, emoji);
                                    }}
                                  >
                                    {emoji}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            {canEditMessage ? (
                              <button
                                type="button"
                                className="message-action-item"
                                onClick={() => {
                                  setEditingMessageId(message.id);
                                  setEditingContent(message.content ?? '');
                                  setOpenActionsMessageId(null);
                                }}
                              >
                                <Edit3 size={14} />
                                Modifier
                              </button>
                            ) : null}
                            {canDeleteMessage ? (
                              <button
                                type="button"
                                className="message-action-item danger"
                                onClick={() => {
                                  setOpenActionsMessageId(null);
                                  void onDeleteMessage(message.id);
                                }}
                              >
                                <Trash2 size={14} />
                                Supprimer
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {isEditing ? (
                    <form
                      className="message-edit-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const trimmed = editingContent.trim();
                        if (!trimmed || isSavingEdit) return;
                        setIsSavingEdit(true);
                        void onEditMessage(message.id, trimmed, message.channelId)
                          .then(() => {
                            setEditingMessageId(null);
                            setEditingContent('');
                          })
                          .finally(() => setIsSavingEdit(false));
                      }}
                    >
                      <textarea
                        value={editingContent}
                        disabled={isSavingEdit}
                        rows={2}
                        onChange={(event) => setEditingContent(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            setEditingMessageId(null);
                            setEditingContent('');
                          }
                          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                      />
                      <div className="message-edit-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={isSavingEdit}
                          onClick={() => {
                            setEditingMessageId(null);
                            setEditingContent('');
                          }}
                        >
                          <X size={14} />
                          Annuler
                        </button>
                        <button type="submit" disabled={isSavingEdit || !editingContent.trim()}>
                          <Check size={14} />
                          Enregistrer
                        </button>
                      </div>
                    </form>
                  ) : message.content ? (
                    <p>{renderMessageContent(message.content, displayMentions)}</p>
                  ) : null}
                  {reactions.length > 0 ? (
                    <div className="message-reactions" aria-label="Réactions au message">
                      {reactions.map((reaction) => (
                        <button
                          type="button"
                          key={reaction.emoji}
                          className="message-reaction"
                          data-active={reaction.reactedByCurrentUser}
                          onClick={() => void onToggleReaction(message.id, reaction.emoji)}
                        >
                          <span>{reaction.emoji}</span>
                          <strong>{reaction.count}</strong>
                        </button>
                      ))}
                      {canReactToMessage ? (
                        <button
                          type="button"
                          className="message-reaction add"
                          aria-label="Ajouter une réaction"
                          onClick={(event) => toggleActionMenu(message.id, event.currentTarget)}
                        >
                          <SmilePlus size={14} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <MessageAttachments
                    attachments={message.attachments}
                    conversationKey={conversationKey}
                    onPreview={setPreviewAttachment}
                  />
                  <MessageEmbeds
                    embeds={isE2ee ? clientEmbeds : [...message.embeds, ...clientEmbeds]}
                  />
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {selectedUserId ? (
        <ProfilePopup userId={selectedUserId} api={api} onClose={() => setSelectedUserId(null)} />
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

function detectClientMentions(
  content: string | null,
  members: ServerMemberProfile[],
  roles: ServerRole[],
): MessageMention[] {
  if (!content) return [];
  const mentions: MessageMention[] = [];
  if (hasMention(content, 'everyone')) {
    mentions.push({ type: 'everyone' });
  }

  for (const member of members) {
    if (hasMention(content, member.profile.displayName)) {
      mentions.push({
        type: 'user',
        userId: member.userId,
        displayName: member.profile.displayName,
        avatarUrl: member.profile.avatarUrl,
      });
    }
  }

  for (const role of roles) {
    if (role.mentionable && hasMention(content, role.name)) {
      mentions.push({
        type: 'role',
        roleId: role.id,
        name: role.name,
        color: role.color,
      });
    }
  }

  return mentions;
}

function hasMention(content: string, label: string): boolean {
  return new RegExp(`@${escapeRegExp(label)}(?=$|\\s|[,.!?;:])`, 'iu').test(content);
}

function createClientOnlyEmbeds(content: string | null): MessageEmbed[] {
  if (!content) return [];
  return extractUrls(content)
    .slice(0, 4)
    .map((url, index) => {
      const youtubeId = getYouTubeId(url);
      if (youtubeId) {
        return {
          id: `client-youtube-${index}-${url}`,
          type: MessageEmbedType.YouTube,
          url,
          title: 'YouTube',
          provider: 'YouTube',
          embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
        };
      }

      if (/\.(png|jpe?g|webp|gif)(\?.*)?$/iu.test(url)) {
        return {
          id: `client-image-${index}-${url}`,
          type: MessageEmbedType.Image,
          url,
          title: new URL(url).hostname,
          thumbnailUrl: url,
        };
      }

      return {
        id: `client-link-${index}-${url}`,
        type: MessageEmbedType.Link,
        url,
        title: new URL(url).hostname,
        provider: new URL(url).hostname,
      };
    });
}

function extractUrls(content: string): string[] {
  const matches = content.match(/https?:\/\/[^\s<>"']+/giu);
  return matches ?? [];
}

function getYouTubeId(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.hostname === 'youtu.be') {
    return parsed.pathname.slice(1) || null;
  }

  if (parsed.hostname.endsWith('youtube.com')) {
    return parsed.searchParams.get('v');
  }

  return null;
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
      .sort((left, right) => right.position - left.position)[0] ?? null
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

    if (mention.type === 'role') {
      return roleIds.has(mention.roleId);
    }

    return mention.type === 'everyone';
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
      label:
        mention.type === 'user'
          ? mention.displayName
          : mention.type === 'role'
            ? mention.name
            : 'everyone',
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
        className={`message-mention ${mention.type}`}
        key={`${mention.type}:${getMentionKey(mention)}:${match.index}`}
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

function getMentionKey(mention: MessageMention): string {
  if (mention.type === 'user') return mention.userId;
  if (mention.type === 'role') return mention.roleId;
  return 'everyone';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMMON_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

function EncryptedAttachmentItem({
  attachment,
  conversationKey,
  onPreview,
}: {
  attachment: MessageAttachment;
  conversationKey: ConversationKey | null;
  onPreview: (attachment: MessageAttachment) => void;
}): React.JSX.Element {
  const [decrypted, setDecrypted] = useState<DecryptedAttachment | null>(null);
  const [failed, setFailed] = useState(false);
  const isLocalPreview =
    attachment.url.startsWith('blob:') || attachment.storagePath.startsWith('blob:');

  useEffect(() => {
    if (!conversationKey || !attachment.encrypted) return;
    let cancelled = false;
    loadEncryptedAttachment(attachment, conversationKey)
      .then((result) => {
        if (!cancelled) setDecrypted(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      revokeDecryptedAttachment(attachment.id);
    };
  }, [attachment, conversationKey]);

  if (isLocalPreview) {
    if (attachment.mimeType.startsWith('image/')) {
      return (
        <button
          type="button"
          className="message-media image"
          key={attachment.id}
          onClick={() => onPreview(attachment)}
        >
          <img
            alt={attachment.fileName ?? 'Image en attente'}
            src={attachment.url}
            loading="lazy"
          />
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
  }

  if (failed || !conversationKey) {
    return (
      <div className="message-file-link encrypted" key={attachment.id}>
        Fichier chiffré illisible
      </div>
    );
  }

  if (!attachment.encrypted) {
    return (
      <div className="message-file-link encrypted" key={attachment.id}>
        Métadonnées de chiffrement absentes
      </div>
    );
  }

  if (!decrypted) {
    return (
      <div className="message-file-link encrypted loading" key={attachment.id}>
        Fichier chiffré (déchiffrement…)
      </div>
    );
  }

  if (decrypted.mimeType.startsWith('image/')) {
    return (
      <button
        type="button"
        className="message-media image"
        key={attachment.id}
        onClick={() => onPreview({ ...attachment, url: decrypted.objectUrl })}
      >
        <img alt="Image chiffrée" src={decrypted.objectUrl} loading="lazy" />
      </button>
    );
  }

  if (decrypted.mimeType.startsWith('video/')) {
    return (
      <video className="message-media video" controls key={attachment.id} preload="metadata">
        <source src={decrypted.objectUrl} type={decrypted.mimeType} />
      </video>
    );
  }

  return (
    <a
      className="message-file-link"
      key={attachment.id}
      href={decrypted.objectUrl}
      download="fichier-chiffré"
    >
      Télécharger le fichier
    </a>
  );
}

function MessageAttachments({
  attachments,
  conversationKey,
  onPreview,
}: {
  attachments: MessageAttachment[];
  conversationKey: ConversationKey | null;
  onPreview: (attachment: MessageAttachment) => void;
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="message-attachments">
      {attachments.map((attachment) => {
        if (attachment.isE2ee) {
          return (
            <EncryptedAttachmentItem
              key={attachment.id}
              attachment={attachment}
              conversationKey={conversationKey}
              onPreview={onPreview}
            />
          );
        }

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
