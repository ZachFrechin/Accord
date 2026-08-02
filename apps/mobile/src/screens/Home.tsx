/**
 * Accueil : la liste des conversations, avec la barre d'onglets du bas.
 *
 * La navigation est une pile — la liste pousse la conversation — adossée à
 * l'historique du navigateur pour que le bouton retour d'Android fasse ce qu'on
 * en attend. Les onglets ne portent que des icônes, comme les apps de chat
 * mobiles : un libellé prend de la place et n'apprend rien de plus.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  getNotificationPermission,
  requestNotificationPermission,
} from "@accord/core/lib/notifications";
import { Icon } from "@accord/core/ui/Icon";
import { MessagingProvider } from "@accord/core/realtime/MessagingProvider";
import {
  acceptFriend,
  createGroup,
  declineFriend,
  openDmWith,
  refreshConversations,
  refreshFriends,
  sendFriendRequest,
} from "@accord/core/stores/messagingActions";
import { useConnection } from "@accord/core/realtime/ConnectionProvider";
import { useConversationsStore } from "@accord/core/stores/useConversationsStore";
import { useFriendsStore } from "@accord/core/stores/useFriendsStore";

import { Avatar } from "../ui/Avatar";
import { Conversation } from "./Conversation";
import { Profile } from "./Profile";
import { ProfileSheet } from "../ui/ProfileSheet";
import { Sheet } from "../ui/Sheet";
import { listenNotificationTaps, offerConversations } from "../lib/notificationTap";
import { pushBackHandler } from "../lib/backStack";

type Tab = "messages" | "friends" | "me";

function Messages({ onOpen }: { onOpen: (id: string) => void }) {
  const conversations = useConversationsStore((s) => s.conversations);
  const titles = useConversationsStore((s) => s.titles);
  const peers = useConversationsStore((s) => s.peers);
  const loaded = useConversationsStore((s) => s.loaded);
  const failed = useConversationsStore((s) => s.error);
  const [query, setQuery] = useState("");
  // Création de groupe : sélection d'amis puis nom.
  const [newOpen, setNewOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const friends = useFriendsStore((s) => s.friends);

  useEffect(() => {
    void refreshConversations();
    void refreshFriends();
  }, []);

  async function makeGroup(): Promise<void> {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const id = await createGroup(groupName.trim() || "Nouveau groupe", picked);
      setNewOpen(false);
      setPicked([]);
      setGroupName("");
      if (id) onOpen(id);
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => (titles[c.id] ?? "").toLowerCase().includes(q));
  }, [conversations, titles, query]);

  return (
    <div className="screen">
      <header className="topbar">
        <h1 className="topbar__title">Messages</h1>
        <button
          type="button"
          className="iconbtn"
          aria-label="Nouveau groupe"
          onClick={() => setNewOpen(true)}
        >
          <Icon name="plus" size={20} />
        </button>
      </header>

      <div className="search">
        <Icon name="magnifying-glass" size={17} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher"
          autoCapitalize="none"
          enterKeyHint="search"
        />
      </div>

      {!loaded && !failed && <p className="hint">Chargement…</p>}
      {failed && <p className="error">Impossible de charger vos conversations.</p>}
      {loaded && shown.length === 0 && (
        <p className="hint">
          {query ? "Aucune conversation ne correspond." : "Aucune conversation pour l'instant."}
        </p>
      )}

      <ul className="conv-list">
        {shown.map((c) => {
          const title = titles[c.id] ?? "Conversation";
          return (
            <li key={c.id}>
              <button type="button" className="conv" onClick={() => onOpen(c.id)}>
                <Avatar name={title} size={46} src={peers[c.id]?.avatarUrl} />
                <span className="conv__body">
                  <span className="conv__title">{title}</span>
                  <span className="conv__sub">
                    {c.kind === "group" ? "Groupe" : "Message direct"}
                  </span>
                </span>
                {c.unread > 0 && (
                  <span className="conv__badge">{c.unread > 99 ? "99+" : c.unread}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <Sheet open={newOpen} title="Nouveau groupe" onClose={() => setNewOpen(false)}>
        <div className="sheet__form">
          <input
            className="field__input"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Nom du groupe"
            enterKeyHint="done"
          />
          <div className="picker">
            {friends.length === 0 && <p className="hint">Ajoutez d'abord des amis.</p>}
            {friends.map((f) => {
              const name = f.display_name?.trim() || f.username;
              const on = picked.includes(f.user_id);
              return (
                <button
                  key={f.user_id}
                  type="button"
                  className="picker__row"
                  data-on={on}
                  onClick={() =>
                    setPicked((p) =>
                      on ? p.filter((x) => x !== f.user_id) : [...p, f.user_id],
                    )
                  }
                >
                  <Avatar name={name} size={36} src={f.avatar_url} />
                  <span className="picker__name">{name}</span>
                  {on && <Icon name="check" size={18} />}
                </button>
              );
            })}
          </div>
          <button
            className="btn"
            type="button"
            disabled={busy || picked.length === 0}
            onClick={() => void makeGroup()}
          >
            {busy ? "Création…" : `Créer le groupe (${picked.length})`}
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function Friends({ onOpen }: { onOpen: (id: string) => void }) {
  const friends = useFriendsStore((s) => s.friends);
  const incoming = useFriendsStore((s) => s.incoming);
  const [addOpen, setAddOpen] = useState(false);
  const [peek, setPeek] = useState<{ id: string; name: string } | null>(null);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    void refreshFriends();
  }, []);

  /** Ouvre (ou crée) la conversation directe avec cette personne. */
  async function message(userId: string): Promise<void> {
    const id = await openDmWith(userId);
    if (id) onOpen(id);
  }

  async function invite(): Promise<void> {
    const name = handle.trim().replace(/^@/, "");
    if (!name) return;
    setBusy(true);
    setNote("");
    try {
      await sendFriendRequest(name);
      setNote(`Invitation envoyée à @${name}.`);
      setHandle("");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Invitation impossible.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <h1 className="topbar__title">Amis</h1>
        <button
          type="button"
          className="iconbtn"
          aria-label="Ajouter un ami"
          onClick={() => setAddOpen(true)}
        >
          <Icon name="user-plus" size={20} />
        </button>
      </header>

      <ul className="conv-list">
        {incoming.length > 0 && <li className="list-label">Demandes reçues</li>}
        {incoming.map((f) => {
          const name = f.display_name?.trim() || f.username;
          return (
            <li key={f.user_id} className="conv conv--static">
              <Avatar name={name} size={46} src={f.avatar_url} />
              <span className="conv__body">
                <span className="conv__title">{name}</span>
                <span className="conv__sub">@{f.username}</span>
              </span>
              <button
                type="button"
                className="iconbtn iconbtn--accent"
                aria-label={`Accepter ${name}`}
                onClick={() => void acceptFriend(f.user_id)}
              >
                <Icon name="check" size={19} />
              </button>
              <button
                type="button"
                className="iconbtn"
                aria-label={`Refuser ${name}`}
                onClick={() => void declineFriend(f.user_id)}
              >
                <Icon name="x" size={18} />
              </button>
            </li>
          );
        })}

        {friends.length > 0 && <li className="list-label">Amis</li>}
        {friends.length === 0 && incoming.length === 0 && (
          <li><p className="hint">Aucun ami pour l'instant.</p></li>
        )}
        {friends.map((f) => {
          const name = f.display_name?.trim() || f.username;
          return (
            <li key={f.user_id}>
              <button type="button" className="conv" onClick={() => void message(f.user_id)}>
                <span
                  role="button"
                  tabIndex={0}
                  className="avatar-btn"
                  aria-label={`Profil de ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPeek({ id: f.user_id, name });
                  }}
                >
                  <Avatar name={name} size={46} src={f.avatar_url} />
                </span>
                <span className="conv__body">
                  <span className="conv__title">{name}</span>
                  <span className="conv__sub">@{f.username}</span>
                </span>
                <Icon name="chat-circle-dots" size={19} />
              </button>
            </li>
          );
        })}
      </ul>

      <ProfileSheet
        userId={peek?.id ?? null}
        fallbackName={peek?.name ?? ""}
        onClose={() => setPeek(null)}
        onOpenConversation={onOpen}
      />

      <Sheet open={addOpen} title="Ajouter un ami" onClose={() => setAddOpen(false)}>
        <div className="sheet__form">
          <input
            className="field__input"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@pseudo"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="send"
          />
          <button className="btn" type="button" disabled={busy || !handle.trim()} onClick={() => void invite()}>
            {busy ? "Envoi…" : "Envoyer l'invitation"}
          </button>
          {note && <p className="hint">{note}</p>}
        </div>
      </Sheet>
    </div>
  );
}

/** Bandeau discret quand la connexion temps réel n'est pas établie : sans lui,
 * un message qui ne part pas ressemble à un bug de l'application. */
function ConnectionBanner() {
  const { ws } = useConnection();
  const [status, setStatus] = useState<string>("open");
  useEffect(() => ws.onStatus(setStatus), [ws]);
  if (status === "open") return null;
  return (
    <p className="offline">
      {status === "connecting" ? "Connexion…" : "Hors ligne — reconnexion en cours"}
    </p>
  );
}

export function Home() {
  const [tab, setTab] = useState<Tab>("messages");
  const [openId, setOpenId] = useState<string | null>(null);
  const incoming = useFriendsStore((s) => s.incoming);
  const conversations = useConversationsStore((s) => s.conversations);

  // Taper une notification doit mener à la conversation concernée, pas à la
  // liste. L'écoute se branche une fois ; la liste des conversations est
  // proposée à chaque mise à jour, parce qu'un tap survenu au démarrage attend
  // justement qu'elle existe pour être résolu.
  useEffect(() => {
    void listenNotificationTaps(setOpenId);
    // Android 13 et suivants exigent une permission explicite pour notifier.
    // On la demande une fois, ici : un messager qui reste muet parce que le
    // réglage dort au fond des paramètres ne sert à rien. Si la personne a déjà
    // répondu — dans un sens ou dans l'autre — l'état n'est plus « default » et
    // rien ne s'affiche.
    void getNotificationPermission().then((state) => {
      if (state === "default") void requestNotificationPermission();
    });
  }, []);
  useEffect(() => {
    offerConversations(conversations.map((c) => c.id));
  }, [conversations]);

  // Le bouton retour d'Android referme la conversation avant de quitter l'app.
  const convBack = useRef<ReturnType<typeof pushBackHandler> | null>(null);
  useEffect(() => {
    if (!openId) return;
    convBack.current = pushBackHandler(() => setOpenId(null));
    return () => convBack.current?.detach();
  }, [openId]);

  const tabs: { id: Tab; icon: Parameters<typeof Icon>[0]["name"]; label: string }[] = [
    { id: "messages", icon: "chat-circle-dots", label: "Messages" },
    { id: "friends", icon: "users-three", label: "Amis" },
    { id: "me", icon: "gear", label: "Profil" },
  ];

  return (
    <MessagingProvider>
      <div className="app">
        <ConnectionBanner />
        {openId ? (
          <Conversation conversationId={openId} onBack={() => convBack.current?.close()} />
        ) : (
          <>
            {tab === "messages" && <Messages onOpen={setOpenId} />}
            {tab === "friends" && <Friends onOpen={setOpenId} />}
            {tab === "me" && <Profile />}
            <nav className="tabbar">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="tabbar__item"
                  data-active={tab === t.id}
                  aria-label={t.label}
                  onClick={() => setTab(t.id)}
                >
                  <Icon name={t.icon} size={24} />
                  {t.id === "friends" && incoming.length > 0 && (
                    <span className="tabbar__dot">
                      {incoming.length > 9 ? "9+" : incoming.length}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </>
        )}
      </div>
    </MessagingProvider>
  );
}
