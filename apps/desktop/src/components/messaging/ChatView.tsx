/** The chat pane (shell `main` region): message history, composer, live typing.
 *  Clay look: Discord-style grouped messages (coloured author + surface bubbles),
 *  header with quick actions, pill composer. */

import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixPopover from "@radix-ui/react-popover";
import {
  type ChangeEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { isTauri } from "../../lib/isTauri";
import type { AttachmentRef } from "../../lib/messaging";
import { startVoiceRecording, type VoiceRecording } from "../../lib/voiceRecorder";
import {
  deleteMessage,
  moderateDeleteMessage,
  downloadAttachment,
  editMessage,
  loadOlder,
  type MemberProfile,
  memberProfiles,
  openConversation,
  pinMessage,
  retryMessage,
  sendMessage,
  sendThreadMessage,
  sendTyping,
  toggleReaction,
} from "../../stores/messagingActions";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { canModerate, usePermissionsStore } from "../../stores/usePermissionsStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { useCallStore } from "../../stores/useCallStore";
import { useOngoingCallsStore } from "../../stores/useOngoingCallsStore";
import { CallBanner } from "../call/CallBanner";
import { EmojiPicker } from "./EmojiPicker";
import { KeyVerification } from "./KeyVerification";
import { type DecryptedMessage, TYPING_TTL_MS, useMessagesStore } from "../../stores/useMessagesStore";
import { useDraftsStore } from "../../stores/useDraftsStore";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useUiStore } from "../../stores/useUiStore";
import { Button, Icon, IconButton, Popover, Skeleton, TextArea, useToast } from "../ui";
import { Avatar, hueFor } from "./Avatar";
import { GroupSettings } from "./GroupSettings";
import { ProfileDialog } from "./ProfileDialog";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const GROUP_GAP_MS = 5 * 60 * 1000;

/** Curated quick-reaction emojis (a picker with search is a later step). The
 * emoji here is reaction *content*, which the user opted into — the SVG-only rule
 * governs UI chrome (icons), not message content. */
const QUICK_EMOJIS = [
  "👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥",
  "👀", "💯", "😍", "😅", "🤔", "👏", "✅", "🚀",
  "😎", "🥳", "😭", "🙌", "💜", "😡", "🤝", "⭐",
];

export function ChatView({ conversationId }: { conversationId: string }) {
  const messages = useMessagesStore((s) => s.byConversation[conversationId]);
  const { toast } = useToast();
  const loaded = useMessagesStore((s) => s.loaded[conversationId]);
  const loadError = useMessagesStore((s) => s.loadError[conversationId]);
  const retryLoad = () => {
    useMessagesStore.setState((s) => ({
      loadError: { ...s.loadError, [conversationId]: false },
      loaded: { ...s.loaded, [conversationId]: false },
    }));
    void openConversation(conversationId);
  };
  const hasOlder = useMessagesStore((s) => Boolean(s.cursor[conversationId]));
  const typing = useMessagesStore((s) => s.typing[conversationId]);
  const title = useConversationsStore((s) => s.titles[conversationId]);
  const kind = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.kind,
  );
  // DM peer (for the header's key-verification shield).
  const dmPeer = useConversationsStore((s) => s.peers[conversationId]);
  // La photo affichée en tête et sur l'écran d'ouverture : celle du groupe s'il
  // en a une, sinon celle de l'interlocuteur. Sans elle on retombe sur les
  // initiales, ce qui donne la même vignette à deux personnes aux mêmes lettres.
  const groupAvatar = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.avatar_url ?? null,
  );
  const convAvatar = groupAvatar ?? dmPeer?.avatarUrl ?? undefined;
  // Reactions are stored server-side (aggregatable metadata) and so ride the
  // Legacy conversations: every row has a server reaction row. MLS: native
  // messages react via encrypted frames (per-row check at the call site).
  const legacyConv = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.protocol !== "mls",
  );
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);
  const unreadAt = useMessagesStore((s) => s.unreadAt[conversationId]);
  // A call in THIS conversation replaces the header with the call banner.
  const callActiveHere = useCallStore(
    (s) => s.status !== "idle" && s.conversationId === conversationId,
  );
  // A focused tile expands the call to the WHOLE pane (messages fold away).
  const stageOpen = useCallStore((s) => !!s.focusedTile);
  // A server-known call in progress here that we're not already in → offer to join.
  const ongoingCall = useOngoingCallsStore((s) => s.calls[conversationId]);

  const [profiles, setProfiles] = useState<Record<string, MemberProfile>>({});
  const [replyTarget, setReplyTarget] = useState<DecryptedMessage | null>(null);
  // The single row whose action bar is shown. Set by onMouseOver on the scroll
  // container (movement-based → reliable in the macOS WebView, unlike leave/:hover
  // which don't clear on a layout shift under a still pointer). Being one value,
  // it can never reveal two bars at once — the accumulation bug is impossible.
  const [activeMsgId, setActiveMsgId] = useState<string | null>(null);
  const [forwardMsg, setForwardMsg] = useState<DecryptedMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevConvRef = useRef(conversationId);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const all = messages ?? [];
  // Side-thread replies never render in the main flow — they live in the panel.
  const list = useMemo(() => all.filter((m) => !m.threadOf), [all]);
  /** parent id → reply count (drives the « N réponses » chip). */
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of all) {
      if (m.threadOf && !m.deleted) counts.set(m.threadOf, (counts.get(m.threadOf) ?? 0) + 1);
    }
    return counts;
  }, [all]);
  const [threadParentId, setThreadParentId] = useState<string | null>(null);
  const lastId = list.length ? list[list.length - 1].id : null;

  // The message the "Nouveaux messages" divider renders before: the first one from
  // someone else that lands after the boundary captured on open. undefined boundary
  // (never opened) → no divider.
  const dividerBeforeId = useMemo(() => {
    if (unreadAt == null) return null; // never opened → no divider ("" = read nothing)
    const first = list.find((m) => !m.deleted && m.senderId !== myId && m.createdAt > unreadAt);
    return first?.id ?? null;
  }, [list, unreadAt, myId]);

  // Mention data derived from the member list: a lowercased set for highlighting,
  // my own username (to accent mentions of me), and the @-autocomplete candidates.
  const mentionSet = useMemo(
    () => new Set(Object.values(profiles).map((p) => p.username.toLowerCase())),
    [profiles],
  );
  const myUsername = myId && profiles[myId] ? profiles[myId].username.toLowerCase() : null;
  const mentionNames = useMemo(
    () => Object.entries(profiles).filter(([id]) => id !== myId).map(([, p]) => p.username),
    [profiles, myId],
  );

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    let live = true;
    void memberProfiles(conversationId).then((m) => live && setProfiles(m));
    setReplyTarget(null); // don't carry a reply draft across conversations
    return () => {
      live = false;
    };
  }, [conversationId]);

  // Jump to a quoted parent when its reply preview is clicked (briefly flashes it).
  const scrollToMessage = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.dataset.flash = "true";
    window.setTimeout(() => el.removeAttribute("data-flash"), 1200);
  };

  // Jump to a message opened from global search (⌘K). Clear the target only once
  // its row is ACTUALLY in the DOM — a not-yet-loaded conversation can hold the
  // message in the store while a skeleton is rendered, so retry (via list/loaded
  // deps) rather than clearing into the void and losing the jump.
  const searchScrollTo = useUiStore((s) => s.searchScrollTo);
  const setSearchScrollTo = useUiStore((s) => s.setSearchScrollTo);
  const togglePalette = useUiStore((s) => s.togglePalette);
  const asideVisible = useLayoutStore((s) => s.asideVisible);
  const toggleAside = useLayoutStore((s) => s.toggleAside);
  useEffect(() => {
    if (!searchScrollTo) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${searchScrollTo}"]`);
    if (!el) return; // target not rendered yet — wait for the next list/loaded change
    requestAnimationFrame(() => scrollToMessage(searchScrollTo));
    setSearchScrollTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchScrollTo, list, loaded]);

  // Stick to the bottom on a new message ONLY if the user is already there (or the
  // conversation just changed) — never yank someone who scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const convChanged = prevConvRef.current !== conversationId;
    prevConvRef.current = conversationId;
    if (convChanged || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    }
  }, [lastId, conversationId]);

  const loadOlderMessages = async () => {
    setLoadingOlder(true);
    const el = scrollRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      await loadOlder(conversationId);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch {
      toast({
        title: "Impossible de charger les anciens messages",
        description: "Vérifiez votre connexion et réessayez.",
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  const someoneTyping =
    typing && Object.values(typing).some((expiry) => expiry > Date.now());

  // A TYPING signal has a TTL but no explicit "stopped" event, so when it lapses
  // nothing re-renders to hide the indicator. Re-render once the latest one expires.
  const [, bumpTyping] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!someoneTyping || !typing) return;
    const delay = Math.max(...Object.values(typing)) - Date.now();
    if (delay <= 0) return;
    const t = window.setTimeout(bumpTyping, delay + 50);
    return () => window.clearTimeout(t);
  }, [typing, someoneTyping]);

  const nameOf = (senderId: string | null) =>
    senderId && senderId === myId
      ? "Vous"
      : (senderId && profiles[senderId]?.displayName) || "Membre";
  const avatarOf = (senderId: string | null) =>
    (senderId && profiles[senderId]?.avatarUrl) || null;
  const memberCount = Object.keys(profiles).length;
  const subtitle =
    kind === "group"
      ? `${memberCount || "?"} membres`
      : "Message direct · chiffré de bout en bout";

  return (
    <div className="chat" data-call-stage={callActiveHere && stageOpen ? "true" : undefined}>
      {callActiveHere ? (
        <CallBanner />
      ) : (
        <header className="chat__header">
        <div className="chat__head-main">
          <Avatar name={title ?? "Conversation"} size={40} src={convAvatar} />
          <div className="chat__head-text">
            <span className="chat__title">{title ?? "Conversation"}</span>
            <span className="chat__subtitle">{subtitle}</span>
          </div>
        </div>
        <div className="chat__actions no-drag">
          {ongoingCall && !callActiveHere ? (
            <button
              className="chat__join-call"
              type="button"
              title="Rejoindre l'appel en cours"
              aria-label="Rejoindre l'appel en cours"
              onClick={() =>
                void useCallStore
                  .getState()
                  .startCall(conversationId, { existingCallId: ongoingCall.callId })
              }
            >
              <Icon name="phone" size={16} />
              Rejoindre · {ongoingCall.participants.length}
            </button>
          ) : (
            <>
              <button
                className="chat__action"
                type="button"
                title="Appel vocal"
                aria-label="Appel vocal"
                onClick={() => void useCallStore.getState().startCall(conversationId)}
              >
                <Icon name="phone" size={19} />
              </button>
              <button
                className="chat__action"
                type="button"
                title="Appel vidéo"
                aria-label="Appel vidéo"
                onClick={() =>
                  void useCallStore.getState().startCall(conversationId, { video: true })
                }
              >
                <Icon name="video-camera" size={19} />
              </button>
            </>
          )}
          {kind === "dm" && dmPeer && (
            <Popover
              align="end"
              trigger={
                <button
                  className="chat__action"
                  type="button"
                  title="Vérification des clés"
                  aria-label="Vérification des clés"
                >
                  <Icon name="shield-check" size={19} />
                </button>
              }
            >
              <div className="chat__keys-pop">
                <KeyVerification peerId={dmPeer.userId} peerName={dmPeer.displayName} />
              </div>
            </Popover>
          )}
          {kind === "group" && <GroupSettings conversationId={conversationId} />}
          <button
            className="chat__action"
            type="button"
            title="Rechercher (⌘K)"
            aria-label="Rechercher"
            onClick={() => togglePalette()}
          >
            <Icon name="magnifying-glass" size={19} />
          </button>
          <button
            className="chat__action"
            type="button"
            title={asideVisible ? "Masquer les détails" : "Afficher les détails"}
            aria-label="Détails de la conversation"
            aria-pressed={asideVisible}
            data-active={asideVisible}
            onClick={() => toggleAside()}
          >
            <Icon name="users-three" size={19} />
          </button>
        </div>
        </header>
      )}

      <div
        className="chat__scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        // Event delegation: fires on pointer movement into any row's subtree, so
        // the active row tracks the cursor without depending on per-row leave.
        onMouseOver={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>(".msg")?.dataset.msgId ?? null;
          setActiveMsgId((cur) => (cur === id ? cur : id));
        }}
        onMouseLeave={() => setActiveMsgId(null)}
      >
        {loadError ? (
          <div className="chat__load-error">
            <p>Impossible de charger les messages de cette conversation.</p>
            <Button size="sm" variant="outline" onClick={retryLoad}>
              Réessayer
            </Button>
          </div>
        ) : !loaded ? (
          <div className="chat__loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="msg">
                <Skeleton width={40} height={40} radius="50%" />
                <Skeleton width={`${40 + i * 15}%`} height="2.4em" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {!hasOlder && (
              <div className="chat__hero">
                <Avatar name={title ?? "Conversation"} size={64} src={convAvatar} />
                <span className="chat__hero-title">{title ?? "Conversation"}</span>
                <span className="chat__hero-sub">
                  Début de la conversation — les messages sont chiffrés de bout en bout, le
                  serveur ne peut pas les lire.
                </span>
              </div>
            )}
            {hasOlder && (
              <div className="chat__older">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loadingOlder}
                  onClick={() => void loadOlderMessages()}
                >
                  {loadingOlder ? "Chargement…" : "Charger les messages plus anciens"}
                </Button>
              </div>
            )}
            {list.map((m, i) => {
              const prev = list[i - 1];
              const isDivider = m.id === dividerBeforeId;
              const grouped =
                !isDivider &&
                Boolean(prev) &&
                prev.senderId === m.senderId &&
                new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() <
                  GROUP_GAP_MS;
              const replyParent = m.replyTo
                ? (list.find((p) => p.id === m.replyTo) ?? null)
                : null;
              return (
                <Fragment key={m.id}>
                  {isDivider && (
                    <div className="chat__unread" role="separator" aria-label="Nouveaux messages">
                      <span>Nouveaux messages</span>
                    </div>
                  )}
                  <MessageRow
                    msg={m}
                    active={m.id === activeMsgId}
                    isMe={m.senderId != null && m.senderId === myId}
                    authorName={nameOf(m.senderId)}
                    authorAvatar={avatarOf(m.senderId)}
                    grouped={grouped}
                    conversationId={conversationId}
                    reactable={legacyConv || m.id.startsWith("mls:")}
                    replyParent={replyParent}
                    replyAuthor={replyParent ? nameOf(replyParent.senderId) : null}
                    onReply={() => setReplyTarget(m)}
                    onForward={() => setForwardMsg(m)}
                    onOpenThread={() => setThreadParentId(m.id)}
                    threadCount={threadCounts.get(m.id) ?? 0}
                    onJumpTo={scrollToMessage}
                    mentionSet={mentionSet}
                    myUsername={myUsername}
                  />
                </Fragment>
              );
            })}
          </>
        )}
        {someoneTyping && (
          <div className="chat__typing">
            <i /><i /><i /> En train d'écrire…
          </div>
        )}
      </div>

      <Composer
        conversationId={conversationId}
        title={title ?? ""}
        replyTarget={replyTarget}
        replyAuthor={replyTarget ? nameOf(replyTarget.senderId) : null}
        onCancelReply={() => setReplyTarget(null)}
        mentionNames={mentionNames}
      />
      {forwardMsg && (
        <ForwardDialog
          message={forwardMsg}
          currentConversationId={conversationId}
          onClose={() => setForwardMsg(null)}
        />
      )}
      {threadParentId && (
        <ThreadPanel
          conversationId={conversationId}
          parent={all.find((m) => m.id === threadParentId) ?? null}
          replies={all.filter((m) => m.threadOf === threadParentId)}
          authorName={nameOf}
          onClose={() => setThreadParentId(null)}
        />
      )}
    </div>
  );
}

/** Side panel of a message's thread: the parent, its replies, a mini composer. */
function ThreadPanel({
  conversationId,
  parent,
  replies,
  authorName,
  onClose,
}: {
  conversationId: string;
  parent: DecryptedMessage | null;
  replies: DecryptedMessage[];
  authorName: (senderId: string | null) => string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [replies.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !parent || sending) return;
    setSending(true);
    setDraft("");
    try {
      await sendThreadMessage(conversationId, parent.id, text);
    } catch {
      setDraft(text);
      toast({ title: "Échec de l'envoi dans le fil" });
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="thread" aria-label="Fil de discussion">
      <header className="thread__header">
        <span className="thread__title">Fil de discussion</span>
        <IconButton aria-label="Fermer le fil" onClick={onClose}>
          <Icon name="x" size={15} />
        </IconButton>
      </header>
      {parent && (
        <div className="thread__parent">
          <span className="thread__parent-author">{authorName(parent.senderId)}</span>
          <span className="thread__parent-text">
            {parent.content?.text ?? "Pièce jointe"}
          </span>
        </div>
      )}
      <div className="thread__scroll" ref={scrollRef}>
        {replies.length === 0 && (
          <p className="thread__empty">Personne n'a encore répondu dans ce fil.</p>
        )}
        {replies.map((m) =>
          m.deleted ? null : (
            <div key={m.id} className="thread__msg">
              <span className="thread__msg-author">{authorName(m.senderId)}</span>
              <span className="thread__msg-text">{m.content?.text}</span>
            </div>
          ),
        )}
      </div>
      <div className="thread__composer">
        <TextArea
          value={draft}
          rows={1}
          placeholder="Répondre dans le fil…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <IconButton aria-label="Envoyer dans le fil" onClick={() => void send()}>
          <Icon name="paper-plane-tilt" size={16} />
        </IconButton>
      </div>
    </aside>
  );
}

/** Pick a conversation and re-send a message's content there. Attachments are
 * re-downloaded, decrypted and re-encrypted for the target (blobs are
 * authorized per conversation — a bare ref would not be fetchable there). */
function ForwardDialog({
  message,
  currentConversationId,
  onClose,
}: {
  message: DecryptedMessage;
  currentConversationId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const conversations = useConversationsStore((s) => s.conversations);
  const titles = useConversationsStore((s) => s.titles);
  const [busy, setBusy] = useState(false);

  const forward = async (targetId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const files: File[] = [];
      for (const a of message.content?.attachments ?? []) {
        const bytes = await downloadAttachment(a);
        if (bytes) files.push(new File([bytes as BlobPart], a.name, { type: a.mime }));
      }
      await sendMessage(targetId, message.content?.text ?? "", files, null);
      toast({ title: "Message transféré" });
      onClose();
    } catch {
      toast({ title: "Échec du transfert" });
      setBusy(false);
    }
  };

  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="lightbox__overlay" />
        <RadixDialog.Content className="forward-dialog" aria-describedby={undefined}>
          <RadixDialog.Title className="forward-dialog__title">
            Transférer vers…
          </RadixDialog.Title>
          <div className="forward-dialog__list">
            {conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                className="forward-dialog__row"
                disabled={busy || c.id === currentConversationId}
                onClick={() => void forward(c.id)}
              >
                <Avatar name={titles[c.id] ?? "Conversation"} size={28} />
                <span className="forward-dialog__name">{titles[c.id] ?? "Conversation"}</span>
                {c.id === currentConversationId && (
                  <span className="forward-dialog__hint">actuelle</span>
                )}
              </button>
            ))}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Open a message link in the system browser (Tauri) or a new tab (browser dev). */
async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** A quick-reaction emoji picker in a Popover; picking closes it (RadixPopover.Close).
 * Controlled so the owning message can keep its action bar shown while it's open,
 * and onCloseAutoFocus is prevented so a mouse pick leaves no lingering focus on
 * the trigger (which, in WebKit, kept the bar stuck visible). */
function ReactionPicker({
  trigger,
  onPick,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  onPick: (emoji: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="popover__content emoji-picker"
          side="top"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="emoji-picker__grid">
            {QUICK_EMOJIS.map((e) => (
              <RadixPopover.Close asChild key={e}>
                <button
                  type="button"
                  className="emoji-picker__btn"
                  onClick={() => onPick(e)}
                  aria-label={`Réagir avec ${e}`}
                >
                  {e}
                </button>
              </RadixPopover.Close>
            ))}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** Render message text with `@username` mentions highlighted. Only tokens that
 * match a real member are styled; the one addressing you is accented. Mentions are
 * plain text inside the (encrypted) body — this is purely client-side rendering. */
function renderMessageText(
  text: string,
  members: Set<string>,
  myUsername: string | null,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /@(\w+)/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const uname = m[1].toLowerCase();
    if (!members.has(uname)) continue; // not a real member → leave as plain text
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={`m${key++}`} className="mention" data-me={uname === myUsername}>
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

/** If the caret sits in an `@partial` token (at line start or after whitespace),
 * returns the token span + query for the mention autocomplete; else null. */
function detectMention(
  text: string,
  caret: number,
): { anchor: number; caret: number; query: string } | null {
  const m = /(?:^|\s)@(\w*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { anchor: caret - m[1].length - 1, caret, query: m[1] };
}

/** One-line preview of a quoted parent for a reply header. */
function quotePreview(parent: DecryptedMessage | null): string {
  if (!parent) return "Message indisponible";
  if (parent.deleted) return "Message supprimé";
  if (parent.content?.text) return parent.content.text;
  if (parent.content?.attachments?.length) return "Pièce jointe";
  return "Message";
}

function MessageRow({
  msg,
  active,
  isMe,
  authorName,
  authorAvatar,
  grouped,
  conversationId,
  reactable,
  replyParent,
  replyAuthor,
  onReply,
  onForward,
  onOpenThread,
  threadCount,
  onJumpTo,
  mentionSet,
  myUsername,
}: {
  msg: DecryptedMessage;
  active: boolean;
  isMe: boolean;
  authorName: string;
  authorAvatar: string | null;
  grouped: boolean;
  conversationId: string;
  reactable: boolean;
  replyParent: DecryptedMessage | null;
  replyAuthor: string | null;
  onReply: () => void;
  onForward: () => void;
  onOpenThread: () => void;
  threadCount: number;
  onJumpTo: (id: string) => void;
  mentionSet: Set<string>;
  myUsername: string | null;
}) {
  const { toast } = useToast();
  const moderator = usePermissionsStore(canModerate);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content?.text ?? "");
  // ↑-in-empty-composer requested an edit of this message.
  const editRequestId = useUiStore((s) => s.editRequestId);
  useEffect(() => {
    if (editRequestId !== msg.id || !isMe) return;
    useUiStore.getState().setEditRequestId(null);
    setDraft(msg.content?.text ?? "");
    setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequestId]);
  // The action bar shows when this row is the single `active` one (tracked by
  // ChatView via onMouseOver) OR while its reaction picker is open. We do NOT use
  // CSS :hover: in the macOS WebView it (like onMouseLeave) fails to clear when a
  // reaction grows the row under a still pointer, leaving two bars stuck at once.
  const [pickerOpen, setPickerOpen] = useState(false);

  if (msg.deleted) {
    return (
      <div className="msg msg--system" data-grouped={grouped} data-msg-id={msg.id}>
        <span className="msg__deleted">
          <Icon name="x" size={13} /> Message supprimé
        </span>
      </div>
    );
  }
  if (!msg.content) {
    return (
      <div className="msg msg--system" data-grouped={grouped} data-msg-id={msg.id}>
        <span className="msg__locked">
          <Icon name="lock" size={13} /> Message non déchiffrable sur cet appareil
        </span>
      </div>
    );
  }

  const saveEdit = async () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== msg.content?.text) {
      try {
        await editMessage(conversationId, msg.id, draft.trim());
      } catch {
        toast({ title: "Échec de la modification" });
      }
    }
  };

  // Repère d'appel manqué : une ligne centrée, sans avatar ni actions — ce n'est
  // pas un message, on ne peut ni y répondre, ni y réagir, ni le supprimer.
  if (msg.system?.kind === "missed_call") {
    return (
      <div className="msg-system" role="note">
        <Icon name="phone-x" size={16} />
        <span>
          Appel manqué de <strong>{msg.system.fromName}</strong>
        </span>
        <span className="msg-system__time">{time(msg.createdAt)}</span>
      </div>
    );
  }

  return (
    <div
      className="msg"
      data-me={isMe}
      data-grouped={grouped}
      data-msg-id={msg.id}
      data-status={msg.status}
    >
      {grouped ? (
        <span className="msg__time-gutter">{time(msg.createdAt)}</span>
      ) : (
        <div className="msg__gutter">
          <ProfileDialog userId={msg.senderId} name={authorName} isMe={isMe}>
            <Avatar name={authorName} size={40} src={authorAvatar} />
          </ProfileDialog>
        </div>
      )}
      <div className="msg__body">
        {msg.replyTo && (
          <button
            type="button"
            className="msg__reply-quote"
            onClick={() => msg.replyTo && onJumpTo(msg.replyTo)}
            title="Aller au message d'origine"
          >
            <Icon name="arrow-left" size={13} className="msg__reply-icon" />
            {replyAuthor && (
              <span
                className="msg__reply-author"
                style={{ ["--author-h" as string]: hueFor(replyAuthor) }}
              >
                {replyAuthor}
              </span>
            )}
            <span className="msg__reply-text">{quotePreview(replyParent)}</span>
          </button>
        )}
        {!grouped && (
          <div className="msg__head">
            <ProfileDialog
              userId={msg.senderId}
              name={authorName}
              isMe={isMe}
              triggerClassName="msg__author-btn"
            >
              <span
                className="msg__author"
                style={{ ["--author-h" as string]: hueFor(authorName) }}
              >
                {authorName}
              </span>
            </ProfileDialog>
            <span className="msg__time">{time(msg.createdAt)}</span>
          </div>
        )}
        {editing ? (
          <div className="msg__edit">
            <TextArea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} />
            <div className="msg__edit-actions">
              <Button size="sm" onClick={() => void saveEdit()}>
                Enregistrer
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <>
            {msg.content.text && (
              <p className="msg__bubble">
                {renderMessageText(msg.content.text, mentionSet, myUsername)}
                {msg.editedAt && <span className="msg__edited">(modifié)</span>}
                {msg.pinned && (
                  <span className="msg__pin-mark" title="Message épinglé">
                    <Icon name="push-pin" size={12} />
                  </span>
                )}
              </p>
            )}
            {msg.content.attachments?.map((a) => (
              <AttachmentChip key={a.blob_id} attachment={a} />
            ))}
            {msg.preview && (
              <button
                type="button"
                className="msg__link-card"
                title={msg.preview.url}
                onClick={() => void openExternal(msg.preview!.url)}
              >
                <span className="msg__link-host">{msg.preview.host}</span>
                <span className="msg__link-title">{msg.preview.title}</span>
                {msg.preview.desc && (
                  <span className="msg__link-desc">{msg.preview.desc}</span>
                )}
              </button>
            )}
          </>
        )}
        {msg.status === "failed" && (
          <div className="msg__failed" role="alert">
            <Icon name="x" size={12} />
            Échec de l'envoi
            <button
              type="button"
              className="msg__retry"
              onClick={() => void retryMessage(conversationId, msg.id)}
            >
              Réessayer
            </button>
          </div>
        )}
        {!editing && threadCount > 0 && (
          <button type="button" className="msg__thread-chip" onClick={onOpenThread}>
            <Icon name="chat-circle-dots" size={13} />
            {threadCount} réponse{threadCount > 1 ? "s" : ""} en fil
          </button>
        )}
        {!editing && msg.reactions.length > 0 && (
          <div className="msg__reactions">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className="msg__reaction"
                data-me={r.me}
                aria-pressed={r.me}
                disabled={!reactable}
                onClick={() => void toggleReaction(conversationId, msg.id, r.emoji)}
                title={`${r.count} réaction${r.count > 1 ? "s" : ""}`}
              >
                <span className="msg__reaction-emoji">{r.emoji}</span>
                <span className="msg__reaction-count">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!editing && !msg.status && (
        <div className="msg__actions" data-show={active || pickerOpen}>
          <IconButton aria-label="Répondre" className="msg__menu-btn" onClick={onReply}>
            <Icon name="arrow-left" />
          </IconButton>
          {reactable && (
            <ReactionPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onPick={(e) => void toggleReaction(conversationId, msg.id, e)}
              trigger={
                <IconButton aria-label="Ajouter une réaction" className="msg__menu-btn">
                  <Icon name="smiley" />
                </IconButton>
              }
            />
          )}
          {(
            <Popover
              trigger={
                <IconButton aria-label="Actions du message" className="msg__menu-btn">
                  <Icon name="dots-three" />
                </IconButton>
              }
              align="end"
            >
              <div className="msg__menu">
                <button type="button" onClick={onForward}>
                  Transférer
                </button>
                {msg.id.startsWith("mls:") && (
                  <button type="button" onClick={onOpenThread}>
                    Répondre en fil
                  </button>
                )}
                {msg.id.startsWith("mls:") && (
                  <button
                    type="button"
                    onClick={() => void pinMessage(conversationId, msg.id, !msg.pinned)}
                  >
                    {msg.pinned ? "Désépingler" : "Épingler"}
                  </button>
                )}
                {isMe && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(msg.content?.text ?? "");
                      setEditing(true);
                    }}
                  >
                    Modifier
                  </button>
                )}
                {isMe && (
                  <button
                    type="button"
                    className="msg__menu-danger"
                    onClick={() => void deleteMessage(conversationId, msg.id)}
                  >
                    Supprimer
                  </button>
                )}
                {!isMe && moderator && (
                  <button
                    type="button"
                    className="msg__menu-danger"
                    onClick={() => {
                      void moderateDeleteMessage(conversationId, msg.id).catch(() =>
                        toast({ title: "Suppression impossible" }),
                      );
                    }}
                  >
                    Supprimer (modération)
                  </button>
                )}
              </div>
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: AttachmentRef }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // Audio attachments (voice messages) play inline instead of downloading.
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Images embed inline: fetched + decrypted on mount, object URL revoked on
  // unmount. On failure the plain download chip takes over.
  const isImage = attachment.mime.startsWith("image/");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    let url: string | null = null;
    void (async () => {
      try {
        const bytes = await downloadAttachment(attachment);
        if (!bytes) throw new Error("indisponible");
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: attachment.mime }));
        setImgUrl(url);
      } catch {
        if (alive) setImgFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.blob_id, isImage]);

  const loadAudio = async () => {
    setBusy(true);
    try {
      const bytes = await downloadAttachment(attachment);
      if (!bytes) throw new Error("indisponible");
      setAudioUrl(URL.createObjectURL(new Blob([bytes as BlobPart], { type: attachment.mime })));
    } catch {
      toast({ title: "Échec du chargement du message vocal" });
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const bytes = await downloadAttachment(attachment);
      if (!bytes) throw new Error("indisponible");
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: attachment.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = attachment.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Échec du téléchargement" });
    } finally {
      setBusy(false);
    }
  };

  if (isImage && !imgFailed) {
    return (
      <>
        {imgUrl ? (
          <button
            type="button"
            className="attachment__image-btn"
            title={attachment.name}
            onClick={() => setLightbox(true)}
          >
            <img className="attachment__image" src={imgUrl} alt={attachment.name} />
          </button>
        ) : (
          <div className="attachment__image-loading" aria-label="Image en cours de chargement">
            <Skeleton width="240px" height="160px" radius="12px" />
          </div>
        )}
        {lightbox && imgUrl && (
          <RadixDialog.Root open onOpenChange={(o) => !o && setLightbox(false)}>
            <RadixDialog.Portal>
              <RadixDialog.Overlay className="lightbox__overlay" />
              <RadixDialog.Content
                className="lightbox__content"
                aria-describedby={undefined}
              >
                <RadixDialog.Title className="lightbox__title">
                  {attachment.name}
                </RadixDialog.Title>
                <img className="lightbox__img" src={imgUrl} alt={attachment.name} />
                <div className="lightbox__actions">
                  <Button size="sm" variant="outline" onClick={() => void download()}>
                    Télécharger
                  </Button>
                  <RadixDialog.Close asChild>
                    <Button size="sm" variant="ghost">
                      Fermer
                    </Button>
                  </RadixDialog.Close>
                </div>
              </RadixDialog.Content>
            </RadixDialog.Portal>
          </RadixDialog.Root>
        )}
      </>
    );
  }

  if (attachment.mime.startsWith("audio/")) {
    return audioUrl ? (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- voice message
      <audio className="attachment__player" controls autoPlay src={audioUrl} />
    ) : (
      <button
        type="button"
        className="attachment attachment--audio"
        onClick={() => void loadAudio()}
        disabled={busy}
      >
        <Icon name="microphone" size={16} className="attachment__icon" />
        <span className="attachment__name">
          {busy ? "Chargement…" : "Écouter le message vocal"}
        </span>
        <span className="attachment__size">
          {Math.max(1, Math.round(attachment.size / 1024))} Ko
        </span>
      </button>
    );
  }

  return (
    <button type="button" className="attachment" onClick={() => void download()} disabled={busy}>
      <Icon name="paperclip" size={16} className="attachment__icon" />
      <span className="attachment__name">{attachment.name}</span>
      <span className="attachment__size">{Math.max(1, Math.round(attachment.size / 1024))} Ko</span>
    </button>
  );
}

function Composer({
  conversationId,
  title,
  replyTarget,
  replyAuthor,
  onCancelReply,
  mentionNames,
}: {
  conversationId: string;
  title: string;
  replyTarget: DecryptedMessage | null;
  replyAuthor: string | null;
  onCancelReply: () => void;
  mentionNames: string[];
}) {
  const { toast } = useToast();
  const composerMlsConv = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.protocol === "mls",
  );
  const [draft, setDraft] = useState(
    () => useDraftsStore.getState().drafts[conversationId] ?? "",
  );
  // Per-conversation drafts: restore on switch, save as it changes. The save
  // effect depends on `draft` ONLY — with conversationId in its deps it would
  // fire on a switch while draft still holds the previous conversation's text.
  useEffect(() => {
    setDraft(useDraftsStore.getState().drafts[conversationId] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  useEffect(() => {
    useDraftsStore.getState().setDraft(conversationId, draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const [files, setFiles] = useState<File[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Voice message: active recorder + elapsed seconds (bar replaces the row).
  const [recorder, setRecorder] = useState<VoiceRecording | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  useEffect(() => {
    if (!recorder) {
      setRecSecs(0);
      return;
    }
    const timer = setInterval(() => setRecSecs((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recorder]);
  // Unmounting mid-recording discards it (and releases the mic). A ref, not the
  // effect above: finishing sets recorder to null while stop() is still
  // resolving, and a cleanup cancel() there would kill that very stop().
  const recorderRef = useRef<VoiceRecording | null>(null);
  recorderRef.current = recorder;
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const startRecording = async () => {
    try {
      setRecorder(await startVoiceRecording());
    } catch {
      toast({
        title: "Micro indisponible",
        description: "Vérifiez l'autorisation du microphone dans le système.",
      });
    }
  };
  const finishRecording = async () => {
    const rec = recorder;
    if (!rec) return;
    recorderRef.current = null; // the unmount guard must not cancel this stop
    setRecorder(null);
    const file = await rec.stop();
    if (file) setFiles((fs) => [...fs, file]);
  };
  const cancelRecording = () => {
    recorder?.cancel();
    setRecorder(null);
  };
  const [mention, setMention] = useState<{ anchor: number; caret: number; query: string } | null>(
    null,
  );
  const [mentionSel, setMentionSel] = useState(0);
  const lastTyping = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const candidates = mention
    ? mentionNames
        .filter((u) => u.toLowerCase().startsWith(mention.query.toLowerCase()))
        .slice(0, 6)
    : [];
  const menuOpen = mention !== null && candidates.length > 0;

  // Focus the input when a reply is armed, so you can type straight away.
  useEffect(() => {
    if (replyTarget) composerRef.current?.querySelector("textarea")?.focus();
  }, [replyTarget]);

  const submit = async () => {
    const text = draft;
    const attached = files;
    const replyTo = replyTarget?.id ?? null;
    if (!text.trim() && attached.length === 0) return;
    setDraft("");
    useDraftsStore.getState().clearDraft(conversationId);
    setFiles([]);
    setMention(null);
    // Re-arm the typing throttle: without this, a follow-up message typed
    // within the 3s window emits NO typing signal at all (the peer then only
    // sees « en train d'écrire » after the fact, never during).
    lastTyping.current = 0;
    onCancelReply(); // consume the reply target once sent
    try {
      await sendMessage(conversationId, text, attached, replyTo);
    } catch (e) {
      console.error("send failed", e);
      toast({
        title: "Échec de l'envoi",
        description: e instanceof Error ? e.message : String(e),
      });
      setDraft(text);
      setFiles(attached);
    }
  };

  /** Replace the active `@partial` with `@username ` and restore the caret. */
  const insertMention = (username: string) => {
    if (!mention) return;
    const before = draft.slice(0, mention.anchor);
    const after = draft.slice(mention.caret);
    const inserted = `${before}@${username} ${after}`;
    const caret = before.length + username.length + 2;
    setDraft(inserted);
    setMention(null);
    requestAnimationFrame(() => {
      const ta = composerRef.current?.querySelector("textarea");
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = caret;
      }
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // ↑ in an EMPTY composer edits my latest message (Discord muscle memory).
    if (e.key === "ArrowUp" && !menuOpen && draft === "") {
      const myId = useInstanceStore.getState().instances.length
        ? activeInstance(useInstanceStore.getState())?.account?.userId
        : null;
      const mine = (useMessagesStore.getState().byConversation[conversationId] ?? [])
        .filter((m) => m.senderId === myId && !m.deleted && !m.status && m.content?.text)
        .at(-1);
      if (mine) {
        e.preventDefault();
        useUiStore.getState().setSearchScrollTo(mine.id);
        useUiStore.getState().setEditRequestId(mine.id);
        return;
      }
    }
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSel((s) => (s + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSel((s) => (s - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(candidates[Math.min(mentionSel, candidates.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDraft(value);
    setMention(detectMention(value, e.target.selectionStart ?? value.length));
    setMentionSel(0);
    const now = Date.now();
    if (now - lastTyping.current > TYPING_TTL_MS / 2) {
      lastTyping.current = now;
      sendTyping(conversationId);
    }
  };

  /** Insert arbitrary text at the caret, keeping focus + caret position. */
  const insertAtCaret = (text: string) => {
    const ta = composerRef.current?.querySelector("textarea");
    const caret = ta?.selectionStart ?? draft.length;
    const next = draft.slice(0, caret) + text + draft.slice(caret);
    const newCaret = caret + text.length;
    setDraft(next);
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = newCaret;
      }
    });
  };

  /** The "Mentionner" button: drop an `@` at the caret and open the menu. */
  const triggerMention = () => {
    const ta = composerRef.current?.querySelector("textarea");
    const caret = ta?.selectionStart ?? draft.length;
    const needSpace = caret > 0 && !/\s$/.test(draft.slice(0, caret));
    const insert = needSpace ? " @" : "@";
    const next = draft.slice(0, caret) + insert + draft.slice(caret);
    const newCaret = caret + insert.length;
    setDraft(next);
    setMention(detectMention(next, newCaret));
    setMentionSel(0);
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = newCaret;
      }
    });
  };

  const empty = !draft.trim() && files.length === 0;

  // MLS-only (v0.7): the browser build has no native MLS engine — it stays a
  // development shell. Block the composer rather than let a send fail late.
  if (composerMlsConv && !isTauri()) {
    return (
      <div className="composer composer--web-blocked" role="note">
        <Icon name="lock" size={14} />
        Client web de développement — l'envoi chiffré (MLS) nécessite l'application de bureau.
      </div>
    );
  }

  return (
    <div className="composer" ref={composerRef}>
      {replyTarget && (
        <div className="composer__reply">
          <Icon name="arrow-left" size={14} className="composer__reply-icon" />
          <span className="composer__reply-label">
            Réponse à{" "}
            <span
              className="composer__reply-author"
              style={{ ["--author-h" as string]: hueFor(replyAuthor ?? "Membre") }}
            >
              {replyAuthor ?? "Membre"}
            </span>
          </span>
          <span className="composer__reply-preview">{quotePreview(replyTarget)}</span>
          <button
            type="button"
            className="composer__reply-close"
            aria-label="Annuler la réponse"
            onClick={onCancelReply}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {recorder && (
        <div className="composer__recording" role="status">
          <span className="composer__rec-dot" aria-hidden="true" />
          <span className="composer__rec-time">
            Enregistrement — {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, "0")}
          </span>
          <button type="button" className="composer__rec-cancel" onClick={cancelRecording}>
            Annuler
          </button>
          <Button size="sm" onClick={() => void finishRecording()}>
            Terminer
          </Button>
        </div>
      )}
      {files.length > 0 && (
        <div className="composer__files">
          {files.map((f, i) => (
            <span key={i} className="composer__file">
              <Icon name="paperclip" size={14} />
              {f.name}
              <button
                type="button"
                aria-label="Retirer le fichier"
                onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {menuOpen && (
        <div className="mention-menu" role="listbox" aria-label="Membres à mentionner">
          {candidates.map((u, i) => {
            const selected = i === Math.min(mentionSel, candidates.length - 1);
            return (
              <button
                key={u}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                className="mention-menu__row"
                onMouseMove={() => setMentionSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the textarea
                  insertMention(u);
                }}
              >
                <Avatar name={u} size={22} />
                <span>{u}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="composer__row">
        <button
          type="button"
          className="composer__btn"
          title="Joindre un fichier"
          aria-label="Joindre un fichier"
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="plus-circle" size={22} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <TextArea
          className="composer__input"
          placeholder={title ? `Message à ${title}` : "Écrire un message…"}
          value={draft}
          rows={1}
          onKeyDown={onKeyDown}
          onChange={onChange}
          onPaste={(e) => {
            // Pasting an image (screenshot, copied picture) attaches it.
            const pasted = Array.from(e.clipboardData?.files ?? []).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (pasted.length === 0) return;
            e.preventDefault();
            setFiles((fs) => [
              ...fs,
              ...pasted.map(
                (f, i) =>
                  new File([f], f.name || `image-collée-${Date.now()}-${i}.png`, {
                    type: f.type,
                  }),
              ),
            ]);
          }}
        />
        <button
          className="composer__btn"
          type="button"
          title="Mentionner"
          aria-label="Mentionner"
          onClick={triggerMention}
        >
          <Icon name="at" size={19} />
        </button>
        <EmojiPicker
          open={emojiOpen}
          onOpenChange={setEmojiOpen}
          onPick={insertAtCaret}
          trigger={
            <button className="composer__btn" type="button" title="Emoji" aria-label="Emoji">
              <Icon name="smiley" size={19} />
            </button>
          }
        />
        <button
          className="composer__btn"
          type="button"
          title={recorder ? "Terminer le message vocal" : "Message vocal"}
          aria-label={recorder ? "Terminer le message vocal" : "Message vocal"}
          data-recording={recorder ? "true" : undefined}
          onClick={() => (recorder ? void finishRecording() : void startRecording())}
        >
          <Icon name="microphone" size={19} />
        </button>
        <button
          className="composer__send"
          type="button"
          onClick={() => void submit()}
          disabled={empty}
          aria-label="Envoyer"
        >
          <Icon name="paper-plane-tilt" size={19} />
        </button>
      </div>
    </div>
  );
}
