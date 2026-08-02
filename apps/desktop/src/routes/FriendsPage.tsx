/**
 * Friends — a full page (was a dialog). Add friends by username, act on incoming
 * and outgoing requests, start DMs, spin up a group, and manage blocked users.
 * All the friend actions are the same store calls the old dialog used; only the
 * surface changed from a popup to a routed page.
 */

import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "../api/http";
import type { FriendUser } from "../api/ApiClient";
import {
  acceptFriend,
  blockFriend,
  createGroup,
  declineFriend,
  openDmWith,
  refreshFriends,
  removeFriend,
  sendFriendRequest,
  unblockFriend,
} from "../stores/messagingActions";
import { useFriendsStore } from "../stores/useFriendsStore";
import { activeInstance, useInstanceStore } from "../stores/useInstanceStore";
import { Avatar } from "../components/messaging/Avatar";
import { Button, EmptyState, Icon, useConfirm, useToast } from "../components/ui";
import "./friends-page.css";

const describe = (e: unknown): string =>
  e instanceof ApiError ? e.message : "Une erreur est survenue";

export default function FriendsPage() {
  const { toast } = useToast();
  const instanceUrl = useInstanceStore((s) => activeInstance(s)?.url ?? null);

  const copyInviteLink = () => {
    if (!instanceUrl) return;
    const link = `accord://join?server=${encodeURIComponent(instanceUrl)}`;
    navigator.clipboard
      .writeText(link)
      .then(() =>
        toast({
          title: "Lien copié",
          description: "Quiconque a Accord peut l'ouvrir pour rejoindre ce serveur.",
        }),
      )
      .catch(() => toast({ title: "Impossible de copier le lien" }));
  };
  const confirm = useConfirm();
  const navigate = useNavigate();
  const friends = useFriendsStore((s) => s.friends);
  const incoming = useFriendsStore((s) => s.incoming);
  const outgoing = useFriendsStore((s) => s.outgoing);
  const blocked = useFriendsStore((s) => s.blocked);
  const friendsError = useFriendsStore((s) => s.error);

  const [username, setUsername] = useState("");
  const [groupMode, setGroupMode] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      toast({ title: "Action impossible", description: describe(err) });
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const value = username.trim();
    if (!value) return;
    try {
      await sendFriendRequest(value);
      setUsername(""); // clear only on success — keep the typed name if it failed
      toast({ title: "Demande envoyée", description: value });
    } catch (err) {
      toast({ title: "Échec de la demande", description: describe(err) });
    }
  };

  const startDm = async (userId: string) => {
    try {
      await openDmWith(userId);
      navigate("/");
    } catch {
      toast({ title: "Impossible d'ouvrir la conversation" });
    }
  };

  const doRemove = async (u: FriendUser) => {
    if (
      await confirm({
        title: `Retirer ${u.username} ?`,
        description: "Vous ne serez plus amis. Vous pourrez renvoyer une demande plus tard.",
        confirmLabel: "Retirer",
        danger: true,
      })
    )
      await run(() => removeFriend(u.user_id));
  };

  const doBlock = async (u: FriendUser) => {
    if (
      await confirm({
        title: `Bloquer ${u.username} ?`,
        description:
          "Il sera retiré de vos amis et ne pourra plus vous envoyer de demande ni de message.",
        confirmLabel: "Bloquer",
        danger: true,
      })
    )
      await run(() => blockFriend(u.user_id));
  };

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const makeGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!groupName.trim() || picked.size === 0) return;
    try {
      await createGroup(groupName.trim(), [...picked]);
      navigate("/");
    } catch {
      toast({ title: "Échec de la création du groupe" });
    }
    setGroupMode(false);
    setGroupName("");
    setPicked(new Set());
  };

  return (
    <div className="page friends-page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Amis</h1>
          <p className="page__sub">
            Gérez vos amis et démarrez des conversations chiffrées de bout en bout.
          </p>
        </div>
        <div className="friends-page__header-actions">
          <Button variant="ghost" onClick={copyInviteLink}>
            <Icon name="arrow-up-right" size={16} />
            Copier le lien d'invitation
          </Button>
          {friends.length > 0 && (
            <Button
              variant={groupMode ? "ghost" : "outline"}
              onClick={() => setGroupMode((m) => !m)}
            >
              <Icon name="users-three" size={16} />
              {groupMode ? "Annuler le groupe" : "Nouveau groupe"}
            </Button>
          )}
        </div>
      </header>

      {/* Add a friend — a prominent inline field, not buried in a form label. */}
      <form className="fr-add" onSubmit={add}>
        <span className="fr-add__icon" aria-hidden="true">
          <Icon name="user-plus" size={18} />
        </span>
        <input
          className="fr-add__input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Ajouter un ami par son pseudo"
          aria-label="Ajouter un ami par son pseudo"
        />
        <Button type="submit" disabled={!username.trim()}>
          Envoyer la demande
        </Button>
      </form>

      {/* Group-create bar — only while composing a group. */}
      {groupMode && (
        <form className="fr-groupbar" onSubmit={makeGroup}>
          <input
            className="fr-add__input"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Nom du groupe"
            aria-label="Nom du groupe"
          />
          <span className="fr-groupbar__hint">
            {picked.size === 0
              ? "Cochez des amis ci-dessous"
              : `${picked.size} sélectionné${picked.size > 1 ? "s" : ""}`}
          </span>
          <Button type="submit" disabled={!groupName.trim() || picked.size === 0}>
            Créer le groupe
          </Button>
        </form>
      )}

      {/* Incoming requests — highlighted, actionable. */}
      {incoming.length > 0 && (
        <section className="fr-section fr-section--accent">
          <h2 className="fr-section__title">
            Demandes reçues <span className="fr-count">{incoming.length}</span>
          </h2>
          <ul className="fr-list">
            {incoming.map((u) => (
              <li key={u.user_id} className="fr-row">
                <Avatar name={u.display_name?.trim() || u.username} size={40} src={u.avatar_url} />
                <div className="fr-row__id">
                  <span className="fr-row__name">{u.display_name?.trim() || u.username}</span>
                  <span className="fr-row__handle">@{u.username}</span>
                </div>
                <div className="fr-row__actions">
                  <Button size="sm" onClick={() => void acceptFriend(u.user_id)}>
                    Accepter
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void declineFriend(u.user_id)}>
                    Refuser
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Friends. */}
      <section className="fr-section">
        <h2 className="fr-section__title">
          Amis {friends.length > 0 && <span className="fr-count">{friends.length}</span>}
        </h2>
        {friendsError && friends.length === 0 ? (
          <EmptyState
            title="Impossible de charger vos amis"
            description="Vérifiez votre connexion, puis réessayez."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  useFriendsStore.setState({ error: false });
                  void refreshFriends().catch(() => useFriendsStore.getState().setError(true));
                }}
              >
                Réessayer
              </Button>
            }
          />
        ) : friends.length === 0 ? (
          <EmptyState
            title="Aucun ami pour l'instant"
            description="Ajoutez quelqu'un par son pseudo pour démarrer une conversation chiffrée."
          />
        ) : (
          <ul className="fr-list fr-list--grid">
            {friends.map((u) => (
              <li key={u.user_id} className="fr-row fr-row--card" data-picked={groupMode && picked.has(u.user_id)}>
                {groupMode && (
                  <input
                    className="fr-row__check"
                    type="checkbox"
                    checked={picked.has(u.user_id)}
                    onChange={() => togglePick(u.user_id)}
                    aria-label={`Ajouter ${u.username} au groupe`}
                  />
                )}
                <Avatar
                  name={u.display_name?.trim() || u.username}
                  size={40}
                  presence={u.presence}
                  src={u.avatar_url}
                />
                <div className="fr-row__id">
                  <span className="fr-row__name">{u.display_name?.trim() || u.username}</span>
                  <span className="fr-row__handle">
                    {u.status_text?.trim() ? u.status_text.trim() : `@${u.username}`}
                  </span>
                </div>
                {!groupMode && (
                  <div className="fr-row__actions">
                    <Button size="sm" onClick={() => void startDm(u.user_id)}>
                      <Icon name="chat-circle-dots" size={15} />
                      Message
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void doBlock(u)} aria-label={`Bloquer ${u.username}`}>
                      Bloquer
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void doRemove(u)} aria-label={`Retirer ${u.username}`}>
                      Retirer
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Outgoing requests — muted. */}
      {outgoing.length > 0 && (
        <section className="fr-section fr-section--muted">
          <h2 className="fr-section__title">
            Demandes envoyées <span className="fr-count">{outgoing.length}</span>
          </h2>
          <ul className="fr-list">
            {outgoing.map((u) => (
              <li key={u.user_id} className="fr-row">
                <Avatar name={u.display_name?.trim() || u.username} size={36} src={u.avatar_url} />
                <div className="fr-row__id">
                  <span className="fr-row__name">{u.display_name?.trim() || u.username}</span>
                  <span className="fr-row__handle">en attente</span>
                </div>
                <div className="fr-row__actions">
                  <Button size="sm" variant="ghost" onClick={() => void run(() => declineFriend(u.user_id))}>
                    Annuler
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Blocked — muted, at the bottom. */}
      {blocked.length > 0 && (
        <section className="fr-section fr-section--muted">
          <h2 className="fr-section__title">
            Bloqués <span className="fr-count">{blocked.length}</span>
          </h2>
          <ul className="fr-list">
            {blocked.map((u) => (
              <li key={u.user_id} className="fr-row">
                <Avatar name={u.display_name?.trim() || u.username} size={36} src={u.avatar_url} />
                <div className="fr-row__id">
                  <span className="fr-row__name">{u.display_name?.trim() || u.username}</span>
                  <span className="fr-row__handle">@{u.username}</span>
                </div>
                <div className="fr-row__actions">
                  <Button size="sm" variant="ghost" onClick={() => void run(() => unblockFriend(u.user_id))}>
                    Débloquer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
