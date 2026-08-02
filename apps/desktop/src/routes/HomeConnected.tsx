/**
 * HomeConnected — the Phase 1 app surface (no chat yet).
 *
 * Shows the signed-in account, a presence status selector (which syncs across
 * the user's devices over the WebSocket), and the list of active sessions with
 * revoke controls. This exercises the whole backend: auth, realtime, presence.
 */

import { useEffect, useState } from "react";

import type { SessionDto } from "../api/ApiClient";
import { Button, Switch, Tabs, useToast } from "../components/ui";
import { ProfileSection } from "../components/profile/ProfileSection";
import { BackupSection } from "../components/security/BackupSection";
import { GameAccountsSection } from "../components/settings/GameAccountsSection";
import { MediaSettingsSection } from "../components/settings/MediaSettingsSection";
import { TwoFactorSection } from "../components/security/TwoFactorSection";
import { clearInstanceMlsHistory } from "../lib/mls/mlsHistory";
import {
  getNotificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  showNotification,
} from "../lib/notifications";
import { useNotificationStore } from "../stores/useNotificationStore";
import { secureStore } from "../lib/secureStore";
import { useConnection } from "../realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "../stores/useInstanceStore";
import { useSessionStore } from "../stores/useSessionStore";
import "./HomeConnected.css";

export default function HomeConnected() {
  const { client } = useConnection();
  const instance = useInstanceStore(activeInstance);
  const account = instance?.account ?? null;

  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const notifEnabled = useNotificationStore((s) => s.enabled);
  const setNotifEnabled = useNotificationStore((s) => s.setEnabled);
  const [perm, setPerm] = useState<NotificationPermission>("default");
  useEffect(() => {
    void getNotificationPermission().then(setPerm);
  }, []);

  async function toggleNotifications(on: boolean): Promise<void> {
    if (on) {
      const granted = await requestNotificationPermission();
      setPerm(granted ? "granted" : await getNotificationPermission());
      setNotifEnabled(granted);
      if (granted) {
        // First real delivery: this is what registers Accord with the OS
        // notification center (and triggers the macOS system prompt), so the
        // app appears in the system settings from this moment on.
        showNotification("Notifications activées", "Vous serez prévenu à l'arrivée d'un message.");
      } else {
        toast({
          title: "Notifications bloquées",
          description: "Autorisez-les dans les réglages du système ou du navigateur.",
        });
      }
    } else {
      setNotifEnabled(false);
    }
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    client
      .sessions()
      .then((list) => alive && setSessions(list))
      .catch(() => alive && setError(true)) // don't let a failure masquerade as "no sessions"
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [client]);

  async function revoke(id: string): Promise<void> {
    try {
      await client.revokeSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id)); // remove only once it truly succeeded
    } catch {
      toast({ title: "Échec de la révocation", description: "La session est toujours active." });
    }
  }

  async function signOut(): Promise<void> {
    await client.logout().catch(() => {});
    if (instance) {
      secureStore.clear(instance.id);
      void clearInstanceMlsHistory(instance.id); // don't leave decrypted MLS plaintext at rest
      useSessionStore.getState().markUnauthed(instance.id);
    }
  }

  const sessionsTab = (
    <div className="home__panel">
      {loading ? (
        <p className="home__hint">Chargement…</p>
      ) : error ? (
        <p className="home__hint">Impossible de charger les sessions — reconnectez-vous.</p>
      ) : sessions.length === 0 ? (
        <p className="home__hint">Aucune session active.</p>
      ) : (
        <ul className="home__sessions">
          {sessions.map((s) => (
            <li key={s.id} className="home__session">
              <div className="home__session-info">
                <span className="home__session-ua">{s.user_agent ?? "Appareil inconnu"}</span>
                <span className="home__session-meta">
                  {s.ip ?? "—"} · dernière activité{" "}
                  {new Date(s.last_used_at).toLocaleString()}
                </span>
              </div>
              {s.current ? (
                <span className="home__badge">cet appareil</span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => revoke(s.id)}>
                  Révoquer
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const notificationsTab = (
    <div className="home__panel">
      <label className="home__toggle">
        <span className="home__toggle-text">
          <span className="home__toggle-label">Notifications de bureau</span>
          <span className="home__toggle-hint">
            Un rappel quand un message arrive et que vous n'êtes pas sur la conversation.
            En statut « Ne pas déranger », rien ne s'affiche.
          </span>
        </span>
        <Switch
          checked={notifEnabled && perm === "granted"}
          onCheckedChange={(v) => void toggleNotifications(v)}
          aria-label="Activer les notifications de bureau"
        />
      </label>
      {perm === "denied" && (
        <p className="home__hint">
          Les notifications sont bloquées par le système. Autorisez Accord pour les réactiver.
        </p>
      )}
      {!notificationsSupported() && (
        <p className="home__hint">Cet environnement ne gère pas les notifications.</p>
      )}
    </div>
  );

  // Profile renders its own floating hero + cards, so it is NOT wrapped in a
  // home__panel box (that would double-box it).
  const profileTab = <ProfileSection />;

  const securityTab = (
    <div className="home__panel">
      <TwoFactorSection />
    </div>
  );

  return (
    <div className="home">
      <header className="home__header">
        <div>
          <h1 className="home__title">
            {account ? `@${account.username}` : "Connecté"}
          </h1>
          <p className="home__sub">{instance?.url}</p>
        </div>
        <Button variant="outline" size="sm" onClick={signOut}>
          Se déconnecter
        </Button>
      </header>

      <Tabs
        aria-label="Réglages du compte"
        items={[
          { value: "profile", label: "Profil", content: profileTab },
          { value: "security", label: "Sécurité", content: securityTab },
          { value: "notifications", label: "Notifications", content: notificationsTab },
          {
            value: "media",
            label: "Audio & vidéo",
            content: (
              <div className="home__panel">
                <MediaSettingsSection />
              </div>
            ),
          },
          {
            value: "games",
            label: "Jeux",
            content: (
              <div className="home__panel">
                <GameAccountsSection />
              </div>
            ),
          },
          {
            value: "backup",
            label: "Sauvegarde",
            content: (
              <div className="home__panel">
                <BackupSection />
              </div>
            ),
          },
          { value: "sessions", label: "Appareils", content: sessionsTab },
        ]}
      />
    </div>
  );
}
