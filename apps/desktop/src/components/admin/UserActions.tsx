/** Actions avancées sur un compte : sanction à échéance, mots de passe, niveau.
 *
 *  Séparées de la ligne d'utilisateur parce qu'elles sont rares et lourdes de
 *  conséquences : les mettre au même rang que « Promouvoir » les rendrait
 *  cliquables par mégarde.
 */

import { useState } from "react";

import type { AdminUserDto } from "../../api/ApiClient";
import { useConnection } from "../../realtime/ConnectionProvider";
import { Button, Field, Icon, Popover, useConfirm, useToast } from "../ui";

/** Durées proposées. « Sans terme » reste possible, mais n'est plus le seul
 *  choix : la plupart des sanctions n'ont aucune raison d'être définitives. */
const DURATIONS: { label: string; hours: number | null }[] = [
  { label: "24 heures", hours: 24 },
  { label: "7 jours", hours: 24 * 7 },
  { label: "30 jours", hours: 24 * 30 },
  { label: "Sans terme", hours: null },
];

export function SanctionPopover({
  user,
  disabled,
  onDone,
}: {
  user: AdminUserDto;
  disabled?: boolean;
  onDone: (updated: AdminUserDto) => void;
}) {
  const { client } = useConnection();
  const { toast } = useToast();
  const [hours, setHours] = useState<number | null>(24);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function apply(): Promise<void> {
    setBusy(true);
    try {
      const until = hours === null ? null : new Date(Date.now() + hours * 3600_000).toISOString();
      const updated = await client.adminSuspendUser(user.id, {
        until,
        reason: reason.trim() || undefined,
      });
      onDone(updated);
      toast({
        title: "Compte suspendu",
        description: until
          ? `Jusqu'au ${new Date(until).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}.`
          : "Sans échéance — à lever à la main.",
      });
    } catch (e) {
      toast({ title: "Suspension impossible", description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover
      align="end"
      trigger={
        <Button variant="ghost" size="sm" disabled={disabled}>
          <Icon name="x" size={14} /> Suspendre
        </Button>
      }
    >
      <div className="admin__sanction">
        <div className="admin__sanction-title">Suspendre @{user.username}</div>
        <div className="admin__sanction-durations">
          {DURATIONS.map((d) => (
            <button
              key={d.label}
              type="button"
              data-active={hours === d.hours}
              onClick={() => setHours(d.hours)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <Field
          label="Motif (montré à la personne)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="admin__hint">
          Les sessions ouvertes sont fermées immédiatement. Une sanction à échéance
          se lève toute seule.
        </p>
        <Button size="sm" disabled={busy} onClick={() => void apply()}>
          {busy ? "Application…" : "Suspendre"}
        </Button>
      </div>
    </Popover>
  );
}

/** Mots de passe et niveau — les gestes rares, regroupés derrière un « … ». */
export function UserMoreMenu({
  user,
  disabled,
  onDone,
}: {
  user: AdminUserDto;
  disabled?: boolean;
  onDone: (updated: AdminUserDto) => void;
}) {
  const { client } = useConnection();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [generated, setGenerated] = useState<string | null>(null);
  const [xp, setXp] = useState("");

  async function temporaryPassword(): Promise<void> {
    if (
      !(await confirm({
        title: `Engendrer un mot de passe pour @${user.username} ?`,
        description:
          "Son mot de passe actuel cessera de fonctionner et ses sessions seront fermées. Le nouveau ne s'affichera qu'une fois : à vous de le lui transmettre.",
        confirmLabel: "Engendrer",
        danger: true,
      }))
    )
      return;
    try {
      const { password } = await client.adminTemporaryPassword(user.id);
      setGenerated(password);
    } catch (e) {
      toast({ title: "Échec", description: e instanceof Error ? e.message : undefined });
    }
  }

  async function resetLink(): Promise<void> {
    try {
      await client.adminSendResetLink(user.id);
      toast({
        title: "Lien envoyé",
        description: `Un code de réinitialisation part vers ${user.email}.`,
      });
    } catch (e) {
      toast({ title: "Envoi impossible", description: e instanceof Error ? e.message : undefined });
    }
  }

  async function setLevel(): Promise<void> {
    const value = Number(xp);
    if (!Number.isFinite(value) || value < 0) return;
    try {
      const updated = await client.adminSetLevel(user.id, Math.floor(value));
      onDone(updated);
      setXp("");
      toast({ title: "Expérience mise à jour" });
    } catch (e) {
      toast({ title: "Échec", description: e instanceof Error ? e.message : undefined });
    }
  }

  return (
    <Popover
      align="end"
      trigger={
        <Button variant="ghost" size="sm" disabled={disabled} aria-label="Plus d'actions">
          <Icon name="dots-three" size={16} />
        </Button>
      }
    >
      <div className="admin__more">
        <div className="admin__sanction-title">Mot de passe</div>
        <button type="button" className="admin__more-item" onClick={() => void resetLink()}>
          <Icon name="paper-plane-tilt" size={16} />
          <span>
            Envoyer un lien de réinitialisation
            <em>Le secret ne passe pas par vous — à préférer.</em>
          </span>
        </button>
        <button type="button" className="admin__more-item" onClick={() => void temporaryPassword()}>
          <Icon name="lock" size={16} />
          <span>
            Engendrer un mot de passe
            <em>Quand la boîte mail est justement inaccessible.</em>
          </span>
        </button>
        {generated && (
          <div className="admin__generated">
            <code>{generated}</code>
            <p>Affiché une seule fois : seule son empreinte est conservée.</p>
          </div>
        )}

        <div className="admin__sanction-title">Niveau</div>
        <p className="admin__hint">Expérience actuelle : {user.xp ?? 0}</p>
        <div className="admin__more-row">
          <Field
            label="Nouvelle expérience"
            type="number"
            value={xp}
            onChange={(e) => setXp(e.target.value)}
          />
          <Button size="sm" disabled={xp.trim() === ""} onClick={() => void setLevel()}>
            Fixer
          </Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => void client.adminSetLevel(user.id, 0).then(onDone)}>
          Remettre à zéro
        </Button>
      </div>
    </Popover>
  );
}
