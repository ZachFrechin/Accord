/**
 * Une conversation : en-tête, fil, zone de saisie.
 *
 * Les messages sont **groupés à plat** — avatar, auteur coloré, heure — comme
 * sur le bureau et comme Discord, plutôt qu'en bulles : c'est ce qui rend un
 * fil de discussion lisible quand les messages s'enchaînent.
 *
 * Le fil défile en colonne inversée : le bas est l'ancre naturelle, si bien que
 * l'ouverture du clavier ou l'arrivée d'un message ne bousculent pas la lecture.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@accord/core/ui/Icon";
import {
  deleteMessage,
  editMessage,
  loadOlder,
  markRead,
  memberNames,
  memberProfiles,
  openConversation,
  sendMessage,
  leaveConversation,
  pinMessage,
  renameGroup,
  sendTyping,
  toggleReaction,
  type MemberProfile,
} from "@accord/core/stores/messagingActions";
import { useConnection } from "@accord/core/realtime/ConnectionProvider";
import { useConversationsStore } from "@accord/core/stores/useConversationsStore";
import { presenceOf as presenceFrom, usePresenceStore } from "@accord/core/stores/usePresenceStore";

import { useCallStore } from "../stores/useCallStore";
import { activeInstance, useInstanceStore } from "@accord/core/stores/useInstanceStore";
import { useMessagesStore } from "@accord/core/stores/useMessagesStore";

import { Avatar, hueFor } from "../ui/Avatar";
import { Attachment } from "../ui/Attachment";
import { computeSafetyNumber } from "@accord/core/lib/safetyNumber";
import { searchNormalize } from "@accord/core/lib/searchText";
import { notifyModeOf, useNotificationStore } from "@accord/core/stores/useNotificationStore";
import { startVoiceRecording, type VoiceRecording } from "@accord/core/lib/voiceRecorder";

import { ProfileSheet } from "../ui/ProfileSheet";
import { Sheet } from "../ui/Sheet";

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
}

export function Conversation({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const { client } = useConnection();
  const title = useConversationsStore((s) => s.titles[conversationId] ?? "Conversation");
  const dmPeer = useConversationsStore((s) => s.peers[conversationId]);
  const groupAvatar = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.avatar_url ?? null,
  );
  const presenceState = usePresenceStore();
  const startCall = useCallStore((st) => st.start);
  const kind = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.kind,
  );
  const messages = useMessagesStore((s) => s.byConversation[conversationId]);
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Record<string, MemberProfile>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Message maintenu sous le doigt : ouvre la feuille d'actions.
  const [held, setHeld] = useState<{ id: string; text: string; mine: boolean } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Message auquel on répond (affiché au-dessus de la saisie).
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; text: string } | null>(null);
  // Image ouverte en plein écran.
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typing = useMessagesStore((st) => st.typing[conversationId]);
  // Fiche ouverte en touchant un avatar ou un nom.
  const [peek, setPeek] = useState<{ id: string; name: string } | null>(null);
  // Message en cours de modification (la saisie bascule en mode édition).
  const [editing, setEditing] = useState<{ id: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Enregistrement vocal en cours (appui maintenu sur le micro).
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [details, setDetails] = useState(false);
  const [renaming, setRenaming] = useState("");
  // Recherche dans le fil de CETTE conversation (l'historique est local).
  const [finding, setFinding] = useState(false);
  const [needle, setNeedle] = useState("");
  // Transfert : message choisi, puis conversation de destination.
  const [forwarding, setForwarding] = useState<{ text: string } | null>(null);
  // Code de sécurité à comparer de vive voix avec son correspondant.
  const [safety, setSafety] = useState<string | null>(null);
  const [emojis, setEmojis] = useState(false);
  const notifyMode = useNotificationStore((st) => notifyModeOf(st, conversationId));
  const allConversations = useConversationsStore((st) => st.conversations);
  const allTitles = useConversationsStore((st) => st.titles);

  useEffect(() => {
    void openConversation(conversationId);
    void memberNames(conversationId).then(setNames).catch(() => {});
    void memberProfiles(conversationId).then(setProfiles).catch(() => {});
  }, [conversationId]);

  // Ouvrir une conversation, sur téléphone, c'est la lire.
  useEffect(() => {
    void markRead(conversationId);
  }, [conversationId, messages?.length]);

  /** Du plus récent au plus ancien : la colonne est inversée en CSS. */
  const rows = useMemo(() => {
    const list = [...(messages ?? [])].reverse();
    const q = searchNormalize(needle).trim();
    if (!q) return list;
    return list.filter((m) => searchNormalize(m.content?.text ?? "").includes(q));
  }, [messages, needle]);

  const nameOf = (id: string | null) => (id && names[id]) || "Membre";

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      if (editing) {
        await editMessage(conversationId, editing.id, text);
        setEditing(null);
      } else {
        await sendMessage(conversationId, text, [], replyTo?.id ?? null);
        setReplyTo(null);
      }
    } finally {
      setSending(false);
    }
  }

  async function sendFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setSending(true);
    try {
      await sendMessage(conversationId, "", files, replyTo?.id ?? null);
      setReplyTo(null);
    } finally {
      setSending(false);
    }
  }

  async function startVoice(): Promise<void> {
    try {
      setRecording(await startVoiceRecording());
      if (navigator.vibrate) navigator.vibrate(10);
    } catch {
      /* micro refusé : le bouton reste inerte plutôt que de mentir */
    }
  }

  /** Relâcher envoie ; un geste vers l'extérieur annule. */
  async function stopVoice(send: boolean): Promise<void> {
    const rec = recording;
    setRecording(null);
    if (!rec) return;
    const file = await rec.stop().catch(() => null);
    if (send && file) void sendMessage(conversationId, "", [file], replyTo?.id ?? null);
  }

  const typingNames = Object.keys(typing ?? {})
    .filter((id) => id !== myId)
    .map((id) => nameOf(id));

  return (
    <div className="screen">
      <header className="chatbar">
        <button type="button" className="iconbtn iconbtn--ghost" onClick={onBack} aria-label="Retour">
          <Icon name="arrow-left" size={22} />
        </button>
        <Avatar
          name={title}
          size={34}
          src={groupAvatar ?? dmPeer?.avatarUrl}
          // Un groupe n'a pas d'état de présence.
          presence={dmPeer ? presenceFrom(presenceState, dmPeer.userId) : undefined}
        />
        <button
          type="button"
          className="chatbar__id"
          onClick={() => {
            setRenaming(title);
            setDetails(true);
          }}
        >
          <span className="chatbar__title">{title}</span>
          <span className="chatbar__sub">
            {kind === "group" ? "Groupe · chiffré" : "Chiffré de bout en bout"}
          </span>
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--ghost"
          aria-label="Appel vocal"
          onClick={() => void startCall(conversationId)}
        >
          <Icon name="phone" size={19} />
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--ghost"
          aria-label="Appel vidéo"
          onClick={() => void startCall(conversationId, { video: true })}
        >
          <Icon name="video-camera" size={19} />
        </button>
        <button
          type="button"
          className="iconbtn iconbtn--ghost"
          aria-label="Rechercher dans la conversation"
          onClick={() => {
            setFinding((f) => !f);
            setNeedle("");
          }}
        >
          <Icon name="magnifying-glass" size={19} />
        </button>
      </header>

      {finding && (
        <div className="search">
          <Icon name="magnifying-glass" size={17} />
          <input
            type="search"
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="Rechercher dans cette conversation"
            autoCapitalize="none"
            enterKeyHint="search"
            autoFocus
          />
        </div>
      )}

      <div
        className="thread"
        onScroll={(e) => {
          const el = e.currentTarget;
          const nearTop = el.scrollHeight - el.clientHeight + el.scrollTop < 200;
          if (nearTop && !loadingOlder) {
            setLoadingOlder(true);
            void loadOlder(conversationId).finally(() => setLoadingOlder(false));
          }
        }}
      >
        {rows.length === 0 && (
          <p className="thread__empty">
            Début de la conversation — les messages sont chiffrés de bout en bout.
          </p>
        )}
        {rows.map((m, i) => {
          // « Précédent dans le temps » = l'élément suivant, la colonne est inversée.
          const older = rows[i + 1];
          const author = nameOf(m.senderId);
          const mine = m.senderId != null && m.senderId === myId;
          // Regroupement : même auteur à moins de 5 minutes → on masque l'en-tête.
          const grouped =
            !!older &&
            older.senderId === m.senderId &&
            new Date(m.createdAt).getTime() - new Date(older.createdAt).getTime() < 5 * 60_000 &&
            dayLabel(older.createdAt) === dayLabel(m.createdAt);
          const newDay = !older || dayLabel(older.createdAt) !== dayLabel(m.createdAt);

          return (
            <div key={m.id}>
              <div
                className="msg"
                onPointerDown={() => {
                  // 450 ms : assez long pour ne pas déclencher au défilement,
                  // assez court pour ne pas donner l'impression que ça bloque.
                  holdTimer.current = setTimeout(() => {
                    if (navigator.vibrate) navigator.vibrate(12);
                    setHeld({
                      id: m.id,
                      text: m.content?.text ?? "",
                      mine,
                    });
                  }, 450);
                }}
                onPointerUp={() => holdTimer.current && clearTimeout(holdTimer.current)}
                onPointerCancel={() => holdTimer.current && clearTimeout(holdTimer.current)}
                onPointerMove={() => holdTimer.current && clearTimeout(holdTimer.current)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className="msg__gutter">
                  {!grouped && (
                    <button
                      type="button"
                      className="avatar-btn"
                      aria-label={`Profil de ${author}`}
                      onClick={() => m.senderId && setPeek({ id: m.senderId, name: author })}
                    >
                      <Avatar
                        name={author}
                        size={34}
                        src={m.senderId ? (profiles[m.senderId]?.avatarUrl ?? null) : null}
                      />
                    </button>
                  )}
                </div>
                <div className="msg__body">
                  {!grouped && (
                    <div className="msg__head">
                      <button
                        type="button"
                        className="msg__author"
                        style={{ ["--author-h" as string]: mine ? 160 : hueFor(author) }}
                        onClick={() => m.senderId && setPeek({ id: m.senderId, name: author })}
                      >
                        {mine ? "Vous" : author}
                      </button>
                      <span className="msg__time">{time(m.createdAt)}</span>
                    </div>
                  )}
                  {m.replyTo && (
                    <span className="msg__quote">
                      <Icon name="arrow-left" size={12} />
                      {(() => {
                        const parent = (messages ?? []).find((x) => x.id === m.replyTo);
                        return parent
                          ? `${nameOf(parent.senderId)} · ${parent.content?.text?.slice(0, 60) ?? "…"}`
                          : "Message d'origine";
                      })()}
                    </span>
                  )}
                  {(m.deleted || m.content?.text || !m.content) && (
                    <span className={`msg__text${m.deleted || !m.content ? " msg__text--muted" : ""}`}>
                      {m.deleted
                        ? "Message supprimé"
                        : (m.content?.text ?? "Message illisible sur cet appareil")}
                      {m.editedAt && !m.deleted && <span className="msg__edited"> (modifié)</span>}
                      {m.pinned && (
                        <span className="msg__pin" title="Épinglé">
                          <Icon name="push-pin" size={11} />
                        </span>
                      )}
                    </span>
                  )}
                  {m.content?.attachments?.map((a) => (
                    <Attachment
                      key={a.blob_id}
                      attachment={a}
                      onOpenImage={(url, name) => setViewer({ url, name })}
                    />
                  ))}
                  {m.reactions.length > 0 && (
                    <span className="msg__reactions">
                      {m.reactions.map((r) => (
                        <button
                          key={r.emoji}
                          type="button"
                          className="reaction"
                          data-me={r.me}
                          onClick={() => void toggleReaction(conversationId, m.id, r.emoji)}
                        >
                          {r.emoji} {r.count}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              {newDay && <div className="thread__day">{dayLabel(m.createdAt)}</div>}
            </div>
          );
        })}
      </div>

      <Sheet
        open={held !== null}
        onClose={() => setHeld(null)}
        actions={[
          {
            label: "Répondre",
            onSelect: () => {
              if (held) {
                const src = (messages ?? []).find((x) => x.id === held.id);
                setReplyTo({
                  id: held.id,
                  author: nameOf(src?.senderId ?? null),
                  text: held.text,
                });
                inputRef.current?.focus();
              }
            },
          },
          ...["👍", "❤️", "😂"].map((emoji) => ({
            label: `Réagir ${emoji}`,
            onSelect: () => {
              if (held) void toggleReaction(conversationId, held.id, emoji);
            },
          })),
          {
            label: "Copier le texte",
            onSelect: () => {
              if (held?.text) void navigator.clipboard?.writeText(held.text).catch(() => {});
            },
          },
          {
            label: "Transférer",
            onSelect: () => held && setForwarding({ text: held.text }),
          },
          {
            label: "Épingler",
            onSelect: () => {
              if (held) void pinMessage(conversationId, held.id, true);
            },
          },
          ...(held?.mine
            ? [
                {
                  label: "Modifier",
                  onSelect: () => {
                    if (held) {
                      setEditing({ id: held.id });
                      setDraft(held.text);
                      setReplyTo(null);
                      inputRef.current?.focus();
                    }
                  },
                },
                {
                  label: "Supprimer",
                  danger: true,
                  onSelect: () => {
                    if (held) void deleteMessage(conversationId, held.id);
                  },
                },
              ]
            : []),
        ]}
      />

      {recording && (
        <p className="recording">
          <span className="recording__dot" /> Enregistrement… relâchez pour envoyer
        </p>
      )}

      {typingNames.length > 0 && (
        <p className="typing">
          {typingNames.join(", ")} {typingNames.length > 1 ? "écrivent" : "écrit"}…
        </p>
      )}

      {editing && (
        <div className="reply-bar">
          <span className="reply-bar__body">
            <span className="reply-bar__author">Modification du message</span>
            <span className="reply-bar__text">Envoyez pour valider</span>
          </span>
          <button
            type="button"
            className="iconbtn iconbtn--ghost"
            onClick={() => {
              setEditing(null);
              setDraft("");
            }}
            aria-label="Annuler la modification"
          >
            <Icon name="x" size={17} />
          </button>
        </div>
      )}

      {replyTo && (
        <div className="reply-bar">
          <span className="reply-bar__body">
            <span className="reply-bar__author">Réponse à {replyTo.author}</span>
            <span className="reply-bar__text">{replyTo.text || "pièce jointe"}</span>
          </span>
          <button
            type="button"
            className="iconbtn iconbtn--ghost"
            onClick={() => setReplyTo(null)}
            aria-label="Annuler la réponse"
          >
            <Icon name="x" size={17} />
          </button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <button
          type="button"
          className="iconbtn iconbtn--ghost"
          onClick={() => fileRef.current?.click()}
          aria-label="Joindre un fichier"
        >
          <Icon name="plus-circle" size={24} />
        </button>
        <div className="composer__field">
          <button
            type="button"
            className="composer__emoji"
            onClick={() => setEmojis(true)}
            aria-label="Emoji"
          >
            <Icon name="smiley" size={21} />
          </button>
          <textarea
            ref={inputRef}
            className="composer__input"
            value={draft}
            rows={1}
            placeholder="Message"
            onChange={(e) => {
              setDraft(e.target.value);
              sendTyping(conversationId);
              // Le champ grandit avec le texte, jusqu'à la limite fixée en CSS.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
            }}
          />
        </div>
        {draft.trim() ? (
          <button
            type="submit"
            className="iconbtn iconbtn--accent"
            disabled={sending}
            aria-label="Envoyer"
          >
            <Icon name="paper-plane-tilt" size={19} />
          </button>
        ) : (
          <button
            type="button"
            className="iconbtn iconbtn--accent"
            data-recording={recording !== null}
            aria-label="Maintenir pour enregistrer"
            onPointerDown={() => void startVoice()}
            onPointerUp={() => void stopVoice(true)}
            onPointerLeave={() => void stopVoice(false)}
            onPointerCancel={() => void stopVoice(false)}
          >
            <Icon name="microphone" size={19} />
          </button>
        )}
      </form>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*,application/pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void sendFiles(files);
        }}
      />

      <Sheet
        open={details}
        title={kind === "group" ? "Groupe" : "Conversation"}
        onClose={() => setDetails(false)}
      >
        <div className="sheet__form">
          {kind === "group" && (
            <>
              <input
                className="field__input"
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                placeholder="Nom du groupe"
                enterKeyHint="done"
              />
              <button
                className="btn"
                type="button"
                disabled={!renaming.trim() || renaming === title}
                onClick={() => void renameGroup(conversationId, renaming.trim())}
              >
                Renommer
              </button>
            </>
          )}
          <p className="sheet__title">Notifications</p>
          <div className="seg seg--inline">
            {([
              ["all", "Tout"],
              ["mentions", "Mentions"],
              ["none", "Rien"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-active={notifyMode === value}
                onClick={() => useNotificationStore.getState().setMode(conversationId, value)}
              >
                {label}
              </button>
            ))}
          </div>

          {kind !== "group" && (
            <>
              <p className="sheet__title">Code de sécurité</p>
              {safety ? (
                <p className="safety">{safety}</p>
              ) : (
                <button
                  className="btn btn--quiet"
                  type="button"
                  onClick={() => {
                    const peer = Object.keys(names).find((id) => id !== myId);
                    if (!peer) return;
                    void (async () => {
                      const [mine, theirs] = await Promise.all([
                        myId ? client.keyBundle(myId) : Promise.resolve({ devices: [] }),
                        client.keyBundle(peer),
                      ]);
                      setSafety(
                        await computeSafetyNumber(
                          mine.devices.map((d) => d.public_key),
                          theirs.devices.map((d) => d.public_key),
                        ),
                      );
                    })().catch(() => setSafety("indisponible"));
                  }}
                >
                  Afficher le code à comparer
                </button>
              )}
            </>
          )}

          <p className="sheet__title">Membres</p>
          <div className="picker">
            {Object.entries(names).map(([id, n]) => (
              <button
                key={id}
                type="button"
                className="picker__row"
                onClick={() => {
                  setDetails(false);
                  setPeek({ id, name: n });
                }}
              >
                <Avatar name={n} size={36} src={profiles[id]?.avatarUrl ?? null} />
                <span className="picker__name">{n}</span>
              </button>
            ))}
          </div>
          <button
            className="btn btn--quiet"
            type="button"
            onClick={() => {
              setDetails(false);
              void leaveConversation(conversationId).then(onBack);
            }}
          >
            {kind === "group" ? "Quitter le groupe" : "Supprimer la conversation"}
          </button>
        </div>
      </Sheet>

      <Sheet open={emojis} title="Emoji" onClose={() => setEmojis(false)}>
        <div className="emoji-grid">
          {[
            "😀","😂","🥲","😍","😎","🤔","😴","🙃",
            "👍","👎","🙏","👏","🔥","💯","🎉","✨",
            "❤️","💔","😭","😡","🤯","🥳","🤝","👀",
            "✅","❌","⚠️","💡","🚀","🍕","☕","🌙",
          ].map((e) => (
            <button
              key={e}
              type="button"
              className="emoji-grid__item"
              onClick={() => {
                setDraft((d) => d + e);
                inputRef.current?.focus();
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={forwarding !== null}
        title="Transférer vers"
        onClose={() => setForwarding(null)}
      >
        <div className="picker">
          {allConversations
            .filter((c) => c.id !== conversationId)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className="picker__row"
                onClick={() => {
                  if (forwarding?.text) void sendMessage(c.id, forwarding.text);
                  setForwarding(null);
                }}
              >
                <Avatar name={allTitles[c.id] ?? "Conversation"} size={36} />
                <span className="picker__name">{allTitles[c.id] ?? "Conversation"}</span>
              </button>
            ))}
        </div>
      </Sheet>

      <ProfileSheet
        userId={peek?.id ?? null}
        fallbackName={peek?.name ?? ""}
        onClose={() => setPeek(null)}
      />

      {viewer && (
        <div className="viewer" role="dialog" aria-label={viewer.name}>
          <button
            type="button"
            className="viewer__close"
            onClick={() => setViewer(null)}
            aria-label="Fermer"
          >
            <Icon name="x" size={22} />
          </button>
          <img src={viewer.url} alt={viewer.name} />
        </div>
      )}
    </div>
  );
}
