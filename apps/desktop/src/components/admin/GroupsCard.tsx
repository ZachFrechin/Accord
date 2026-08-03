/** Onglet « Groupes » du panel : conversations, création, suppression, et le
 *  détail des messages d'une conversation.
 *
 *  Une limite structure tout cet écran : le contenu des messages est chiffré de
 *  bout en bout et le serveur n'en détient aucune clé. On liste donc des
 *  ENVELOPPES — qui a écrit, quand, quelle taille — de quoi retrouver un message
 *  signalé et le supprimer, jamais de quoi le lire. L'écran le dit franchement
 *  plutôt que de laisser croire à un contenu qui ne viendra pas.
 */

import { useCallback, useEffect, useState } from "react";

import type { AdminConversation, AdminConversationSort, AdminMessage } from "../../api/ApiClient";
import { useConnection } from "../../realtime/ConnectionProvider";
import { Button, EmptyState, Field, Icon, IconButton, useConfirm, useToast } from "../ui";

const PER_PAGE = 25;

const SORTS: { value: AdminConversationSort; label: string }[] = [
  { value: "recent", label: "Plus récentes" },
  { value: "oldest", label: "Plus anciennes" },
  { value: "name_asc", label: "Nom (A→Z)" },
  { value: "members_desc", label: "Plus de membres" },
  { value: "busiest", label: "Plus actives" },
];

const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

export function GroupsCard() {
  const { client } = useConnection();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "dm" | "group">("all");
  const [sort, setSort] = useState<AdminConversationSort>("recent");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AdminConversation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [openConv, setOpenConv] = useState<AdminConversation | null>(null);

  // Un champ de recherche interrogé à chaque frappe enverrait une requête par
  // lettre ; toute nouvelle recherche repart de la première page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    client
      .adminConversations({
        q: search || undefined,
        kind: kind === "all" ? undefined : kind,
        sort,
        page,
        perPage: PER_PAGE,
      })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [client, search, kind, sort, page]);

  useEffect(load, [load]);

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  async function create(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    try {
      await client.adminCreateGroup({ name });
      setNewName("");
      setCreating(false);
      toast({ title: "Groupe créé", description: `« ${name} » vous a pour responsable.` });
      load();
    } catch (e) {
      toast({ title: "Création impossible", description: e instanceof Error ? e.message : undefined });
    }
  }

  async function remove(conv: AdminConversation): Promise<void> {
    const label = conv.name?.trim() || (conv.kind === "dm" ? "cette conversation directe" : "ce groupe");
    if (
      !(await confirm({
        title: `Supprimer ${label} ?`,
        description: `${conv.messages} message(s) et ${conv.members} membre(s) seront effacés. Rien ne pourra être récupéré.`,
        confirmLabel: "Supprimer",
        danger: true,
      }))
    )
      return;
    try {
      await client.adminDeleteConversation(conv.id);
      toast({ title: "Conversation supprimée" });
      if (openConv?.id === conv.id) setOpenConv(null);
      load();
    } catch (e) {
      toast({ title: "Suppression impossible", description: e instanceof Error ? e.message : undefined });
    }
  }

  if (openConv) {
    return <MessagesView conversation={openConv} onBack={() => setOpenConv(null)} />;
  }

  return (
    <section className="admin__card">
      <header className="admin__card-head">
        <h2 className="admin__card-title">Conversations</h2>
        <Button size="sm" onClick={() => setCreating((c) => !c)}>
          <Icon name="plus" size={16} /> Nouveau groupe
        </Button>
      </header>

      {creating && (
        <div className="admin__create">
          <Field
            label="Nom du groupe"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <Button size="sm" disabled={!newName.trim()} onClick={() => void create()}>
            Créer
          </Button>
          <p className="admin__hint">
            Vous en serez membre et responsable — un groupe sans administrateur ne
            pourrait plus jamais être modifié depuis l'application.
          </p>
        </div>
      )}

      <div className="admin__filters">
        <div className="admin__search">
          <Icon name="magnifying-glass" size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un groupe"
          />
        </div>
        <select
          className="admin__select"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setPage(1);
          }}
          aria-label="Type de conversation"
        >
          <option value="all">Toutes</option>
          <option value="group">Groupes</option>
          <option value="dm">Messages directs</option>
        </select>
        <select
          className="admin__select"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as AdminConversationSort);
            setPage(1);
          }}
          aria-label="Trier"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {failed && (
        <p className="admin__hint">
          Impossible de charger les conversations.{" "}
          <button type="button" className="admin__link" onClick={load}>
            Réessayer
          </button>
        </p>
      )}
      {!failed && !loading && items.length === 0 && (
        <EmptyState
          title="Aucune conversation"
          description={search ? "Aucun résultat pour cette recherche." : "Rien à afficher pour l'instant."}
        />
      )}

      {items.length > 0 && (
        <table className="admin__table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Type</th>
              <th>Membres</th>
              <th>Messages</th>
              <th>Créée</th>
              <th>Dernier message</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} data-busy={loading || undefined}>
                <td>{c.name?.trim() || <span className="admin__muted">sans nom</span>}</td>
                <td>{c.kind === "group" ? "Groupe" : "Direct"}</td>
                <td className="admin__num">{c.members}</td>
                <td className="admin__num">{c.messages}</td>
                <td>{dateTime(c.created_at)}</td>
                <td>{c.last_message_at ? dateTime(c.last_message_at) : <span className="admin__muted">—</span>}</td>
                <td className="admin__row-actions">
                  <IconButton aria-label="Voir les messages" onClick={() => setOpenConv(c)}>
                    <Icon name="chat-circle-dots" size={17} />
                  </IconButton>
                  <IconButton aria-label="Supprimer" onClick={() => void remove(c)}>
                    <Icon name="trash" size={17} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pageCount > 1 && (
        <div className="admin__pager">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </Button>
          <span>
            Page {page} / {pageCount} — {total} au total
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Suivant
          </Button>
        </div>
      )}
    </section>
  );
}

/** Les enveloppes d'une conversation. Aucun texte : voir l'en-tête du fichier. */
function MessagesView({
  conversation,
  onBack,
}: {
  conversation: AdminConversation;
  onBack: () => void;
}) {
  const { client } = useConnection();
  const [items, setItems] = useState<AdminMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    client
      .adminMessages(conversation.id, { page, perPage: PER_PAGE })
      .then((res) => {
        if (!alive) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [client, conversation.id, page]);

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <section className="admin__card">
      <header className="admin__card-head">
        <Button size="sm" variant="outline" onClick={onBack}>
          <Icon name="arrow-left" size={16} /> Conversations
        </Button>
        <h2 className="admin__card-title">{conversation.name?.trim() || "Conversation"}</h2>
      </header>

      <p className="admin__notice">
        <Icon name="lock" size={16} />
        Le texte des messages est chiffré de bout en bout : le serveur n'en détient
        aucune clé et ne peut donc rien en montrer ici. Cette page sert à retrouver
        un message signalé et à le supprimer.
      </p>

      {failed && <p className="admin__hint">Impossible de charger les messages.</p>}
      {!failed && !loading && items.length === 0 && (
        <EmptyState title="Aucun message" description="Cette conversation est vide." />
      )}

      {items.length > 0 && (
        <table className="admin__table">
          <thead>
            <tr>
              <th>Auteur</th>
              <th>Envoyé</th>
              <th>Modifié</th>
              <th>Taille</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.sender_username ?? <span className="admin__muted">compte supprimé</span>}</td>
                <td>{dateTime(m.created_at)}</td>
                <td>{m.edited_at ? dateTime(m.edited_at) : <span className="admin__muted">—</span>}</td>
                <td className="admin__num">{m.size_bytes} o</td>
                <td>
                  {m.deleted ? <span className="admin__muted">supprimé</span> : "présent"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pageCount > 1 && (
        <div className="admin__pager">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </Button>
          <span>
            Page {page} / {pageCount} — {total} au total
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Suivant
          </Button>
        </div>
      )}
    </section>
  );
}
