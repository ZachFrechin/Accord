/**
 * AdministrationSection — instance administration.
 *
 * Access = root admin OR any custom role with permissions (the backend gates
 * each action; the UI attempts and surfaces a clear toast on a 403). The
 * overview is a single quiet summary line — no KPI boxes. Users are grouped
 * by role (Administrateurs, then each custom role by position, then Membres),
 * with per-user role assignment and a full role manager (create/edit/delete,
 * permission bits, color).
 */

import { GroupsCard } from "./GroupsCard";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  AdminPermission,
  type AdminRole,
  type AdminStats,
  type AdminUserDto,
  type AuditEntry,
} from "../../api/ApiClient";
import { ApiError } from "../../api/http";
import { useConnection } from "../../realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import {
  Button,
  Field,
  Icon,
  Popover,
  useConfirm,
  useToast,
  type ConfirmOptions,
} from "../ui";
import "./admin.css";

const PER_PAGE = 25;

/** Onglets du panel. Tout tenait sur une seule page qui s'allongeait à chaque
 * ajout ; passé trois sujets, on ne trouve plus rien sans faire défiler. */
const TABS = [
  { id: "users", label: "Utilisateurs" },
  { id: "groups", label: "Groupes" },
  { id: "roles", label: "Rôles" },
  { id: "audit", label: "Journal" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const PERMISSION_LABELS: { bit: number; label: string; hint: string }[] = [
  { bit: AdminPermission.PANEL, label: "Voir le panel", hint: "Statistiques et liste des membres" },
  { bit: AdminPermission.MANAGE_USERS, label: "Gérer les utilisateurs", hint: "Suspendre / réactiver des comptes" },
  { bit: AdminPermission.MANAGE_ROLES, label: "Gérer les rôles", hint: "Créer, modifier et assigner les rôles" },
  { bit: AdminPermission.MODERATE, label: "Supprimer les messages", hint: "Supprimer n'importe quel message, dans toutes les conversations" },
  { bit: AdminPermission.EDIT_PROFILES, label: "Modifier les profils", hint: "Renommer le pseudo et le nom d'affichage des membres" },
  { bit: AdminPermission.VIEW_AUDIT, label: "Journal d'audit", hint: "Consulter l'historique des actions d'administration" },
  { bit: AdminPermission.MANAGE_GROUPS, label: "Gérer les groupes", hint: "Créer, renommer et supprimer des conversations de groupe" },
  { bit: AdminPermission.MANAGE_LEVELS, label: "Gérer les niveaux", hint: "Fixer ou remettre à zéro l'expérience d'un compte" },
  {
    bit: AdminPermission.RESET_PASSWORDS,
    label: "Réinitialiser les mots de passe",
    // Distincte de « gérer les utilisateurs » à dessein : suspendre est
    // réversible et visible, reprendre la main sur un mot de passe ouvre l'accès
    // au compte. Le libellé doit le dire, sinon la case se coche sans y penser.
    hint: "Donne accès au compte : à réserver. Le contenu reste chiffré.",
  },
];

function formatCount(n: number): string {
  return n.toLocaleString("fr-FR");
}

export function AdministrationSection() {
  const { client } = useConnection();
  const myUserId = useInstanceStore(activeInstance)?.account?.userId ?? null;
  const { toast } = useToast();
  const confirm = useConfirm();

  const [tab, setTab] = useState<TabId>("users");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [roles, setRoles] = useState<AdminRole[]>([]);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadStats = useCallback(() => {
    client
      .adminStats()
      .then(setStats)
      .catch(() => {});
  }, [client]);
  const loadRoles = useCallback(() => {
    client
      .adminRoles()
      .then((r) => setRoles(r.roles))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    loadStats();
    loadRoles();
  }, [loadStats, loadRoles]);

  // Debounce the search field; a new search restarts from page 1.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setListError(false);
    client
      .adminUsers({ q: search || undefined, page, perPage: PER_PAGE })
      .then((res) => {
        if (!alive) return;
        setUsers(res.items);
        setTotal(res.total);
      })
      .catch(() => alive && setListError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [client, search, page]);

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const roleById = new Map(roles.map((r) => [r.id, r]));

  async function apply(
    user: AdminUserDto,
    patch: { role?: "member" | "admin"; disabled?: boolean },
    options: ConfirmOptions,
  ): Promise<void> {
    if (!(await confirm(options))) return;
    setBusyId(user.id);
    try {
      const updated = await client.adminUpdateUser(user.id, patch);
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? { ...updated, role_ids: u.role_ids } : u)));
      loadStats();
    } catch (err) {
      toast({
        title: "Action impossible",
        description: err instanceof ApiError ? err.message : "Réessayez dans un instant.",
      });
    } finally {
      setBusyId(null);
    }
  }

  function promote(u: AdminUserDto): void {
    void apply(u, { role: "admin" }, {
      title: `Promouvoir @${u.username} ?`,
      description: "Ce compte aura TOUTES les permissions, y compris nommer d'autres admins.",
      confirmLabel: "Promouvoir",
    });
  }
  function demote(u: AdminUserDto): void {
    void apply(u, { role: "member" }, {
      title: `Retirer les droits d'administration de @${u.username} ?`,
      description: "Le compte garde uniquement les permissions de ses rôles.",
      confirmLabel: "Rétrograder",
      danger: true,
    });
  }
  function suspend(u: AdminUserDto): void {
    void apply(u, { disabled: true }, {
      title: `Suspendre @${u.username} ?`,
      description:
        "Toutes ses sessions sont révoquées immédiatement et la connexion lui est refusée jusqu'à réactivation.",
      confirmLabel: "Suspendre",
      danger: true,
    });
  }
  function reinstate(u: AdminUserDto): void {
    void apply(u, { disabled: false }, {
      title: `Réactiver @${u.username} ?`,
      description: "Le compte pourra de nouveau se connecter.",
      confirmLabel: "Réactiver",
    });
  }

  async function toggleUserRole(u: AdminUserDto, roleId: string): Promise<void> {
    const next = u.role_ids.includes(roleId)
      ? u.role_ids.filter((id) => id !== roleId)
      : [...u.role_ids, roleId];
    // Optimistic; revert on failure.
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role_ids: next } : x)));
    try {
      await client.adminSetUserRoles(u.id, next);
    } catch (err) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role_ids: u.role_ids } : x)));
      toast({
        title: "Assignation impossible",
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  }

  // Group the page's users: admins, then each custom role (by position — a
  // user shows in their highest-ranked role's group), then plain members.
  const grouped: { key: string; title: string; color?: string | null; users: AdminUserDto[] }[] =
    [];
  const admins = users.filter((u) => u.role === "admin");
  if (admins.length) grouped.push({ key: "admins", title: "Administrateurs", users: admins });
  const claimed = new Set(admins.map((u) => u.id));
  for (const role of roles) {
    const members = users.filter((u) => !claimed.has(u.id) && u.role_ids.includes(role.id));
    members.forEach((u) => claimed.add(u.id));
    if (members.length)
      grouped.push({ key: role.id, title: role.name, color: role.color, users: members });
  }
  const rest = users.filter((u) => !claimed.has(u.id));
  if (rest.length) grouped.push({ key: "members", title: "Membres", users: rest });

  const userRow = (u: AdminUserDto) => {
    const isMe = u.id === myUserId;
    const busy = busyId === u.id;
    return (
      <li key={u.id} className="admin__user" data-disabled={u.disabled}>
        <div className="admin__user-info">
          <span className="admin__user-name">
            {u.display_name?.trim() || `@${u.username}`}
            {u.role === "admin" && (
              <span className="admin__badge admin__badge--role">
                <Icon name="crown-simple" size={12} /> admin
              </span>
            )}
            {u.role_ids.map((id) => {
              const role = roleById.get(id);
              return role ? (
                <span
                  key={id}
                  className="admin__badge admin__badge--custom"
                  style={role.color ? { ["--role-c" as string]: role.color } : undefined}
                >
                  <span className="admin__role-dot" /> {role.name}
                </span>
              ) : null;
            })}
            {u.disabled && <span className="admin__badge admin__badge--danger">suspendu</span>}
            {!u.email_verified && !u.disabled && (
              <span className="admin__badge admin__badge--muted">non vérifié</span>
            )}
            {isMe && <span className="admin__badge admin__badge--muted">vous</span>}
          </span>
          <span className="admin__user-meta">
            @{u.username} · {u.email} · inscrit le{" "}
            {new Date(u.created_at).toLocaleDateString("fr-FR")}
          </span>
        </div>
        <div className="admin__user-actions">
          <RenamePopover
            user={u}
            disabled={busy}
            onSave={async (patch) => {
              setBusyId(u.id);
              try {
                const updated = await client.adminUpdateUser(u.id, patch);
                setUsers((prev) =>
                  prev.map((x) => (x.id === updated.id ? { ...updated, role_ids: x.role_ids } : x)),
                );
              } catch (err) {
                toast({
                  title: "Renommage impossible",
                  description: err instanceof ApiError ? err.message : undefined,
                });
              } finally {
                setBusyId(null);
              }
            }}
          />
          {roles.length > 0 && (
            <Popover
              align="end"
              trigger={
                <Button variant="ghost" size="sm" disabled={busy}>
                  Rôles
                </Button>
              }
            >
              <div className="admin__assign">
                {roles.map((r) => (
                  <label key={r.id} className="admin__assign-row">
                    <input
                      type="checkbox"
                      checked={u.role_ids.includes(r.id)}
                      onChange={() => void toggleUserRole(u, r.id)}
                    />
                    <span
                      className="admin__role-dot"
                      style={r.color ? { ["--role-c" as string]: r.color } : undefined}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
            </Popover>
          )}
          {!isMe && (
            <>
              {u.role === "admin" ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => demote(u)}>
                  Rétrograder
                </Button>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => promote(u)}>
                  <Icon name="crown-simple" size={14} /> Promouvoir
                </Button>
              )}
              {u.disabled ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => reinstate(u)}>
                  <Icon name="check" size={14} /> Réactiver
                </Button>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => suspend(u)}>
                  <Icon name="x" size={14} /> Suspendre
                </Button>
              )}
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="admin">
      {stats && (
        <p className="admin__summary">
          {formatCount(stats.users_total)} utilisateurs · {formatCount(stats.users_online)} en
          ligne · {formatCount(stats.users_disabled)} suspendus ·{" "}
          {formatCount(stats.conversations)} conversations · serveur v{stats.version}
        </p>
      )}

      <div className="admin__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "groups" && <GroupsCard />}

      {tab === "users" && (
      <section className="admin__card" aria-label="Utilisateurs">
        <div className="admin__users-head">
          <h2 className="admin__card-title">
            Utilisateurs
            {total > 0 && <span className="admin__count">{formatCount(total)}</span>}
          </h2>
          <label className="admin__search">
            <Icon name="magnifying-glass" size={16} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un nom, un pseudo, un e-mail…"
              aria-label="Rechercher un utilisateur"
            />
          </label>
        </div>

        {loading ? (
          <p className="admin__hint">Chargement…</p>
        ) : listError ? (
          <p className="admin__hint">Impossible de charger les utilisateurs.</p>
        ) : users.length === 0 ? (
          <p className="admin__hint">
            {search ? "Aucun utilisateur ne correspond à cette recherche." : "Aucun utilisateur."}
          </p>
        ) : (
          grouped.map((g) => (
            <div key={g.key} className="admin__group">
              <h3
                className="admin__group-title"
                style={g.color ? { ["--role-c" as string]: g.color } : undefined}
              >
                {g.key !== "admins" && g.key !== "members" && (
                  <span className="admin__role-dot" />
                )}
                {g.title} — {g.users.length}
              </h3>
              <ul className="admin__users">{g.users.map(userRow)}</ul>
            </div>
          ))
        )}

        {pageCount > 1 && (
          <div className="admin__pager">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Précédent
            </Button>
            <span className="admin__pager-info">
              Page {page} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Suivant
            </Button>
          </div>
        )}
      </section>
      )}

      {tab === "roles" && <RolesCard client={client} roles={roles} onChanged={loadRoles} />}
      {tab === "audit" && <AuditCard client={client} />}
    </div>
  );
}

/** Rename a member (display name + @username) — gated server-side by EDIT_PROFILES. */
function RenamePopover({
  user,
  disabled,
  onSave,
}: {
  user: AdminUserDto;
  disabled: boolean;
  onSave: (patch: { display_name?: string; username?: string }) => Promise<void>;
}) {
  const [display, setDisplay] = useState(user.display_name ?? "");
  const [username, setUsername] = useState(user.username);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: { display_name?: string; username?: string } = {};
    if ((user.display_name ?? "") !== display.trim()) patch.display_name = display.trim();
    const nextUsername = username.trim();
    if (nextUsername && nextUsername !== user.username) patch.username = nextUsername;
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      align="end"
      trigger={
        <Button variant="ghost" size="sm" disabled={disabled}>
          Renommer
        </Button>
      }
    >
      <form className="admin__rename" onSubmit={(e) => void submit(e)}>
        <Field
          label="Nom d'affichage"
          value={display}
          onChange={(e) => setDisplay(e.target.value)}
          placeholder="Vide = utiliser @pseudo"
        />
        <Field
          label="Pseudo (@)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={saving}>
          Enregistrer
        </Button>
      </form>
    </Popover>
  );
}

/** Human phrasing of each audit action. */
const AUDIT_LABELS: Record<string, string> = {
  "user.role": "a changé le rôle de",
  "user.suspend": "a suspendu",
  "user.reinstate": "a réactivé",
  "user.rename": "a renommé",
  "user.roles": "a modifié les rôles de",
  "role.create": "a créé un rôle",
  "role.update": "a modifié un rôle",
  "role.delete": "a supprimé un rôle",
  "message.delete": "a supprimé un message de",
};

const AUDIT_PER_PAGE = 25;

/** Administration journal — every sensitive action, newest first. */
function AuditCard({ client }: { client: ReturnType<typeof useConnection>["client"] }) {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let alive = true;
    client
      .adminAudit({ page, perPage: AUDIT_PER_PAGE })
      .then((res) => {
        if (!alive) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        if (alive && err instanceof ApiError && err.status === 403) setDenied(true);
      });
    return () => {
      alive = false;
    };
  }, [client, page]);

  // No VIEW_AUDIT bit → the card simply doesn't render.
  if (denied) return null;

  const pageCount = Math.max(1, Math.ceil(total / AUDIT_PER_PAGE));
  const detailSummary = (e: AuditEntry): string => {
    const d = e.detail as { role?: string; username?: string; display_name?: string | null; name?: string; count?: number };
    if (e.action === "user.role" && d.role) return `→ ${d.role}`;
    if (e.action === "user.rename" && d.username) return `→ @${d.username}`;
    if (e.action === "user.rename" && d.display_name !== undefined)
      return d.display_name ? `→ « ${d.display_name} »` : "(nom d'affichage effacé)";
    if (e.action.startsWith("role.") && d.name) return `« ${d.name} »`;
    if (e.action === "user.roles" && d.count !== undefined) return `(${d.count} rôle${d.count > 1 ? "s" : ""})`;
    return "";
  };

  return (
    <section className="admin__card" aria-label="Journal">
      <div className="admin__users-head">
        <h2 className="admin__card-title">
          Journal
          {total > 0 && <span className="admin__count">{formatCount(total)}</span>}
        </h2>
      </div>
      {items === null ? (
        <p className="admin__hint">Chargement…</p>
      ) : items.length === 0 ? (
        <p className="admin__hint">Aucune action enregistrée pour le moment.</p>
      ) : (
        <ul className="admin__audit">
          {items.map((e) => (
            <li key={e.id} className="admin__audit-row">
              <span className="admin__audit-text">
                <strong>@{e.actor_username ?? "?"}</strong>{" "}
                {AUDIT_LABELS[e.action] ?? e.action}
                {e.target_username && <strong> @{e.target_username}</strong>}
                {detailSummary(e) && <span className="admin__audit-detail"> {detailSummary(e)}</span>}
              </span>
              <span className="admin__audit-time">
                {new Date(e.created_at).toLocaleString("fr-FR", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 && (
        <div className="admin__pager">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Précédent
          </Button>
          <span className="admin__pager-info">
            Page {page} / {pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
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

/** Role manager: list, create, edit, delete — permission bits as checkboxes. */
function RolesCard({
  client,
  roles,
  onChanged,
}: {
  client: ReturnType<typeof useConnection>["client"];
  roles: AdminRole[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<AdminRole | "new" | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7ee0b8");
  const [perms, setPerms] = useState<number>(AdminPermission.PANEL);
  const [busy, setBusy] = useState(false);

  const startCreate = () => {
    setEditing("new");
    setName("");
    setColor("#7ee0b8");
    setPerms(AdminPermission.PANEL);
  };
  const startEdit = (r: AdminRole) => {
    setEditing(r);
    setName(r.name);
    setColor(r.color ?? "#7ee0b8");
    setPerms(r.permissions);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (editing === "new") {
        await client.adminCreateRole({ name: name.trim(), color, permissions: perms });
      } else if (editing) {
        await client.adminUpdateRole(editing.id, {
          name: name.trim(),
          color,
          position: editing.position,
          permissions: perms,
        });
      }
      setEditing(null);
      onChanged();
    } catch (err) {
      toast({
        title: "Enregistrement impossible",
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: AdminRole) => {
    if (
      !(await confirm({
        title: `Supprimer le rôle « ${r.name} » ?`,
        description: "Les membres qui l'avaient le perdent immédiatement.",
        confirmLabel: "Supprimer",
        danger: true,
      }))
    )
      return;
    try {
      await client.adminDeleteRole(r.id);
      onChanged();
    } catch (err) {
      toast({
        title: "Suppression impossible",
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  const permsSummary = (p: number) =>
    PERMISSION_LABELS.filter((x) => p & x.bit)
      .map((x) => x.label)
      .join(" · ") || "Aucune permission";

  return (
    <section className="admin__card" aria-label="Rôles">
      <div className="admin__users-head">
        <h2 className="admin__card-title">
          Rôles
          {roles.length > 0 && <span className="admin__count">{roles.length}</span>}
        </h2>
        <Button size="sm" variant="outline" onClick={startCreate}>
          Nouveau rôle
        </Button>
      </div>

      {roles.length === 0 && !editing && (
        <p className="admin__hint">
          Aucun rôle personnalisé. Créez-en pour déléguer des permissions sans donner admin.
        </p>
      )}

      <ul className="admin__roles">
        {roles.map((r) => (
          <li key={r.id} className="admin__role">
            <span
              className="admin__role-dot admin__role-dot--lg"
              style={r.color ? { ["--role-c" as string]: r.color } : undefined}
            />
            <div className="admin__role-body">
              <span className="admin__role-name">{r.name}</span>
              <span className="admin__role-perms">{permsSummary(r.permissions)}</span>
            </div>
            <div className="admin__user-actions">
              <Button variant="ghost" size="sm" onClick={() => startEdit(r)}>
                Modifier
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void remove(r)}>
                Supprimer
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <form className="admin__role-form" onSubmit={(e) => void submit(e)}>
          <div className="admin__role-form-row">
            <Field
              label="Nom du rôle"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Modérateur, Support…"
            />
            <label className="admin__color">
              <span>Couleur</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
          <div className="admin__perms">
            {PERMISSION_LABELS.map((p) => (
              <label key={p.bit} className="admin__perm" title={p.hint}>
                <input
                  type="checkbox"
                  checked={(perms & p.bit) !== 0}
                  onChange={() => setPerms((v) => v ^ p.bit)}
                />
                {p.label}
              </label>
            ))}
          </div>
          <div className="admin__role-form-actions">
            <Button size="sm" type="submit" disabled={busy || !name.trim()}>
              {editing === "new" ? "Créer le rôle" : "Enregistrer"}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>
              Annuler
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
