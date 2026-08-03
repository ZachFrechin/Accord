/** The conversation list (shell `list` region): search, filters, conversations. */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { isTauri } from "../../lib/isTauri";
import { openConversationPopout } from "../../lib/popout";

import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Skeleton,
  Tooltip,
  useConfirm,
} from "../ui";
import {
  leaveConversation,
  markRead,
  openConversation,
  refreshConversations,
} from "../../stores/messagingActions";
import type { PresenceStatus } from "../../realtime/wireSchema";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { useNotificationStore } from "../../stores/useNotificationStore";
import { usePresenceStore } from "../../stores/usePresenceStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { useConnection } from "../../realtime/ConnectionProvider";
import { Avatar } from "./Avatar";

type Filter = "all" | "groups" | "dms";

const STATUS_LABEL: Record<PresenceStatus, string> = {
  ONLINE: "En ligne",
  AWAY: "Absent",
  DND: "Ne pas déranger",
  OFFLINE: "Hors ligne",
};

export function ConversationList() {
  const navigate = useNavigate();
  const conversations = useConversationsStore((s) => s.conversations);
  const titles = useConversationsStore((s) => s.titles);
  const peers = useConversationsStore((s) => s.peers);
  const activeId = useConversationsStore((s) => s.activeId);
  const loaded = useConversationsStore((s) => s.loaded);
  const error = useConversationsStore((s) => s.error);
  const retryConversations = () => {
    useConversationsStore.setState({ loaded: false, error: false });
    void refreshConversations().catch(() => useConversationsStore.getState().setError(true));
  };
  const incoming = useFriendsStore((s) => s.incoming);
  const friends = useFriendsStore((s) => s.friends);
  const presences = usePresenceStore((s) => s.statuses);
  const myStatus = usePresenceStore((s) => s.myStatus);
  const myId = useInstanceStore((st) => activeInstance(st)?.account?.userId ?? null);
  const { client } = useConnection();
  // Les membres d'un groupe ne sont pas dans la liste des conversations : on les
  // charge une fois, puis le compte des présents se recalcule tout seul à chaque
  // changement de présence, sans nouvelle requête.
  const [groupMembers, setGroupMembers] = useState<Record<string, string[]>>({});
  const muted = useNotificationStore((s) => s.muted);
  const setMuted = useNotificationStore((s) => s.setMuted);
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const open = (id: string) => {
    void openConversation(id);
    navigate("/");
  };

  const leave = async (id: string, kind: "group" | "dm") => {
    const isGroup = kind === "group";
    if (
      await confirm({
        title: isGroup ? "Quitter ce groupe ?" : "Supprimer cette conversation ?",
        description: isGroup
          ? "Vous ne recevrez plus ses messages ; un admin devra vous réinviter pour revenir."
          : "Elle sera retirée de votre liste. L'historique restera chez votre correspondant.",
        confirmLabel: isGroup ? "Quitter" : "Supprimer",
        danger: true,
      })
    )
      await leaveConversation(id);
  };

  const { groups, dms } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (id: string) => !q || (titles[id] ?? "").toLowerCase().includes(q);
    const visible = conversations.filter((c) => match(c.id));
    return {
      groups: filter === "dms" ? [] : visible.filter((c) => c.kind === "group"),
      dms: filter === "groups" ? [] : visible.filter((c) => c.kind === "dm"),
    };
  }, [conversations, titles, query, filter]);

  const total = groups.length + dms.length;

  // Un seul chargement par groupe, à l'arrivée de la conversation dans la liste.
  useEffect(() => {
    const missing = conversations.filter((c) => c.kind === "group" && !groupMembers[c.id]);
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(
      missing.map((c) =>
        client
          .conversationMembers(c.id)
          .then((r) => [c.id, r.members.map((m) => m.user_id)] as const)
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (!alive) return;
      const found = pairs.filter((p): p is readonly [string, string[]] => p !== null);
      if (found.length) setGroupMembers((prev) => ({ ...prev, ...Object.fromEntries(found) }));
    });
    return () => {
      alive = false;
    };
  }, [conversations, groupMembers, client]);

  // La présence d'un ami arrive avec la liste d'amis ; celle des autres membres
  // passe par le store temps réel. Sans ce repli, un membre de groupe qui n'est
  // pas notre ami paraîtrait toujours hors ligne.
  const presenceOf = (userId: string): PresenceStatus =>
    userId === myId
      ? myStatus
      : (friends.find((f) => f.user_id === userId)?.presence ?? presences[userId] ?? "OFFLINE");

  /** Sous-titre d'une ligne : l'état de l'interlocuteur, ou le nombre de présents. */
  const subtitleOf = (c: (typeof conversations)[number]): string => {
    if (c.kind === "dm") {
      const peer = peers[c.id];
      return peer ? STATUS_LABEL[presenceOf(peer.userId)] : "Message direct";
    }
    const ids = groupMembers[c.id];
    // Tant que les membres ne sont pas connus, mieux vaut ne rien affirmer qu'annoncer « 0 en ligne ».
    if (!ids) return "Groupe";
    const online = ids.filter((id) => presenceOf(id) !== "OFFLINE").length;
    return online === 0 ? "Personne en ligne" : `${online} en ligne`;
  };

  const row = (c: (typeof conversations)[number]) => (
    <li key={c.id} className="conv-row-wrap">
      <button
        type="button"
        className="conv-row"
        data-active={c.id === activeId}
        onClick={() => open(c.id)}
      >
        <Avatar
          name={titles[c.id] ?? "?"}
          size={40}
          src={c.kind === "dm" ? peers[c.id]?.avatarUrl : (c.avatar_url ?? null)}
          // Un groupe n'a pas d'état de présence : la pastille n'a de sens que
          // pour une personne.
          presence={c.kind === "dm" && peers[c.id] ? presenceOf(peers[c.id].userId) : undefined}
        />
        <span className="conv-row__body">
          <span className="conv-row__name">{titles[c.id] ?? "…"}</span>
          <span className="conv-row__meta">{subtitleOf(c)}</span>
        </span>
        {c.unread > 0 && (
          <span className="conv-badge">{c.unread > 99 ? "99+" : c.unread}</span>
        )}
      </button>
      <Menu
        align="end"
        trigger={
          <IconButton
            className="conv-row__menu no-drag"
            aria-label={`Actions pour ${titles[c.id] ?? "la conversation"}`}
          >
            <Icon name="dots-three" size={18} />
          </IconButton>
        }
      >
        {c.unread > 0 && (
          <MenuItem icon="check" onSelect={() => void markRead(c.id)}>
            Marquer comme lu
          </MenuItem>
        )}
        {isTauri() && (
          <MenuItem
            icon="arrow-up-right"
            onSelect={() =>
              void openConversationPopout(c.id, titles[c.id] ?? "Conversation")
            }
          >
            Ouvrir dans une fenêtre
          </MenuItem>
        )}
        <MenuItem icon="bell" onSelect={() => setMuted(c.id, !muted[c.id])}>
          {muted[c.id] ? "Activer les notifications" : "Couper les notifications"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="x" danger onSelect={() => void leave(c.id, c.kind)}>
          {c.kind === "group" ? "Quitter le groupe" : "Supprimer la conversation"}
        </MenuItem>
      </Menu>
    </li>
  );

  return (
    <div className="conv-list">
      <header className="conv-list__header">
        <span className="conv-list__title">Messages</span>
        <div className="conv-list__actions no-drag">
          <Tooltip label="Amis & nouvelle conversation">
            <button
              className="conv-add"
              type="button"
              aria-label="Amis & nouvelle conversation"
              onClick={() => navigate("/friends")}
            >
              {incoming.length > 0 ? (
                <span className="conv-badge">{incoming.length}</span>
              ) : (
                <Icon name="plus" size={18} />
              )}
            </button>
          </Tooltip>
        </div>
      </header>

      <label className="conv-search no-drag">
        <Icon name="magnifying-glass" size={17} />
        <input
          type="search"
          placeholder="Rechercher une conversation"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="conv-filter no-drag" role="group" aria-label="Filtrer les conversations">
        {(
          [
            ["all", "Tous"],
            ["groups", "Groupes"],
            ["dms", "Directs"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            data-active={filter === key}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <div className="conv-list__rows">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="conv-row conv-row--skeleton">
              <Skeleton width={40} height={40} radius="50%" />
              <Skeleton width="60%" />
            </div>
          ))}
        </div>
      ) : error && conversations.length === 0 ? (
        <EmptyState
          title="Chargement impossible"
          description="Vos conversations n'ont pas pu être chargées. Vérifiez votre connexion."
          action={<Button onClick={retryConversations}>Réessayer</Button>}
        />
      ) : conversations.length === 0 ? (
        <EmptyState
          title="Aucune conversation"
          description="Ajoutez un ami pour démarrer un message chiffré de bout en bout."
          action={<Button onClick={() => navigate("/friends")}>Trouver des amis</Button>}
        />
      ) : total === 0 ? (
        <p className="friends__empty" style={{ padding: "var(--space-3)" }}>
          Aucun résultat.
        </p>
      ) : (
        <div className="conv-list__scroll">
          {groups.length > 0 && (
            <>
              <div className="conv-section">Groupes</div>
              <ul className="conv-list__rows" role="list">
                {groups.map(row)}
              </ul>
            </>
          )}
          {dms.length > 0 && (
            <>
              <div className="conv-section">Messages directs</div>
              <ul className="conv-list__rows" role="list">
                {dms.map(row)}
              </ul>
            </>
          )}
        </div>
      )}

    </div>
  );
}
