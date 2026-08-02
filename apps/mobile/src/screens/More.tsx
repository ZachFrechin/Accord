/**
 * Les écrans secondaires des réglages : nouveautés, sauvegarde et
 * administration. Regroupés ici parce qu'ils partagent la même forme — une
 * page qui défile, des cartes — et qu'aucun ne justifie son propre onglet.
 */

import { useEffect, useState } from "react";

import type { AdminStats } from "@accord/core/api/ApiClient";
import { CHANGELOG } from "@accord/core/lib/changelog";
import { exportHistory, importHistory } from "@accord/core/lib/historyBackup";
import {
  getNotificationPermission,
  requestNotificationPermission,
} from "@accord/core/lib/notifications";
import { Icon } from "@accord/core/ui/Icon";
import { useConnection } from "@accord/core/realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "@accord/core/stores/useInstanceStore";
import { useNotificationStore } from "@accord/core/stores/useNotificationStore";

/** Notifications système : permission de l'appareil et interrupteur général.
 *
 * La politique fine (silencieux par conversation, mentions seules, ne-pas-
 * déranger) vit déjà dans le code partagé et s'applique telle quelle ici ; cet
 * écran ne gère que ce qui est propre à l'appareil. La permission est demandée
 * d'office au premier lancement ; ce bouton sert à ceux qui ont laissé passer
 * la question, puisque Android ne repose jamais la même deux fois. */
export function Notifications() {
  const [perm, setPerm] = useState<NotificationPermission | "loading">("loading");
  const enabled = useNotificationStore((s) => s.enabled);
  const setEnabled = useNotificationStore((s) => s.setEnabled);

  useEffect(() => {
    void getNotificationPermission().then(setPerm);
  }, []);

  async function ask(): Promise<void> {
    const granted = await requestNotificationPermission();
    setPerm(granted ? "granted" : "denied");
    // Accorder la permission puis rester coupé n'aurait aucun sens : c'est
    // exactement ce que l'utilisateur vient de demander.
    if (granted) setEnabled(true);
  }

  return (
    <div className="page">
      <div className="card">
        <span className="field__label">Notifications</span>
        <div className="seg seg--inline">
          {([
            [true, "Activées"],
            [false, "Coupées"],
          ] as const).map(([value, label]) => (
            <button
              key={label}
              type="button"
              data-active={enabled === value}
              onClick={() => setEnabled(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {perm === "granted" && (
          <p className="hint">
            L'appareil autorise Accord à notifier. L'aperçu affiché est déchiffré
            ici même : il n'a jamais circulé en clair.
          </p>
        )}
        {perm === "default" && (
          <>
            <p className="hint">Android n'a pas encore été sollicité pour cette application.</p>
            <button className="btn" type="button" onClick={() => void ask()}>
              <Icon name="bell" size={18} /> Autoriser les notifications
            </button>
          </>
        )}
        {perm === "denied" && (
          <p className="hint">
            L'appareil bloque les notifications d'Accord. Le réglage se trouve dans
            les paramètres Android de l'application — nous ne pouvons pas le
            rouvrir depuis ici.
          </p>
        )}
      </div>
    </div>
  );
}

/** Notes de version — la même source que le bureau. */
export function Changelog() {
  return (
    <div className="page">
      {CHANGELOG.map((entry) => (
        <div key={entry.version} className="card">
          <div className="row">
            <span className="row__value">Version {entry.version}</span>
            <span className="row__label">
              {new Date(entry.date).toLocaleDateString("fr-FR", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
          </div>
          <span className="note__title">{entry.title}</span>
          <ul className="note__list">
            {entry.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Sauvegarde chiffrée de l'historique local. */
export function Backup() {
  const instance = useInstanceStore(activeInstance);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function doExport(): Promise<void> {
    if (!instance || pass.length < 8) return;
    setBusy(true);
    setNote("");
    try {
      const { blob, messages, conversations } = await exportHistory(instance.id, pass);
      // Sur téléphone, « enregistrer un fichier » passe par le téléchargement
      // système : l'utilisateur choisit lui-même où l'archive atterrit.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `accord-sauvegarde-${new Date().toISOString().slice(0, 10)}.bin`;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`Sauvegarde générée : ${messages} message(s), ${conversations} conversation(s).`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Export impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function doImport(file: File): Promise<void> {
    if (!instance || pass.length < 8) return;
    setBusy(true);
    setNote("");
    try {
      const count = await importHistory(instance.id, file, pass);
      setNote(`${count} message(s) restauré(s).`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Import impossible.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="card">
        <p className="hint" style={{ textAlign: "left" }}>
          L'historique chiffré de cet appareil peut être exporté puis restauré
          ailleurs. L'archive est protégée par une phrase secrète — sans elle,
          elle est illisible, y compris pour nous.
        </p>
        <label className="field">
          <span className="field__label">Phrase secrète (8 caractères minimum)</span>
          <input
            className="field__input"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </label>
        <button className="btn" type="button" disabled={busy || pass.length < 8} onClick={() => void doExport()}>
          <Icon name="arrow-up-right" size={18} /> Exporter
        </button>
        <label className="btn btn--quiet" style={{ cursor: "pointer" }}>
          Importer une sauvegarde
          <input
            type="file"
            hidden
            disabled={busy || pass.length < 8}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void doImport(f);
            }}
          />
        </label>
        {note && <p className="hint">{note}</p>}
      </div>
    </div>
  );
}

/** Vue d'ensemble de l'instance, pour qui a les droits. */
export function Admin() {
  const { client } = useConnection();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let alive = true;
    void client
      .adminStats()
      .then((s) => alive && setStats(s))
      .catch(() => alive && setDenied(true));
    return () => {
      alive = false;
    };
  }, [client]);

  if (denied) {
    return (
      <div className="page">
        <p className="hint">Vous n'avez pas accès à l'administration de cette instance.</p>
      </div>
    );
  }

  const rows: [string, string][] = stats
    ? [
        ["Utilisateurs", stats.users_total.toLocaleString("fr-FR")],
        ["En ligne", stats.users_online.toLocaleString("fr-FR")],
        ["Suspendus", stats.users_disabled.toLocaleString("fr-FR")],
        ["Administrateurs", stats.admins.toLocaleString("fr-FR")],
        ["Conversations", stats.conversations.toLocaleString("fr-FR")],
        ["Messages", stats.messages.toLocaleString("fr-FR")],
        ["Version du serveur", stats.version],
      ]
    : [];

  return (
    <div className="page">
      {!stats && <p className="hint">Chargement…</p>}
      {stats && (
        <div className="card">
          {rows.map(([label, value]) => (
            <div key={label} className="row">
              <span className="row__label">{label}</span>
              <span className="row__value">{value}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint">
        La gestion fine des membres et des rôles reste sur l'application de bureau.
      </p>
    </div>
  );
}
