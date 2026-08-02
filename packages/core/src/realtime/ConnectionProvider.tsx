/**
 * Owns the live connection (ApiClient + WsClient) for the active instance and
 * shares it via context. Recreating on instance change is how "switch without
 * logout" works: the old socket tears down, a new one connects for the new
 * instance, and presence resets.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { ApiClient } from "../api/ApiClient";
import { useInstanceStore, type Instance } from "../stores/useInstanceStore";
import { usePresenceStore } from "../stores/usePresenceStore";
import { useSessionStore } from "../stores/useSessionStore";
import { useConnectionLifecycle } from "./lifecycle";
import { WsClient } from "./wsClient";

interface Connection {
  client: ApiClient;
  ws: WsClient;
}

const ConnectionContext = createContext<Connection | null>(null);

/** Access the active instance's client + socket. */
export function useConnection(): Connection {
  const conn = useContext(ConnectionContext);
  if (!conn) throw new Error("useConnection must be used within ConnectionProvider");
  return conn;
}

export function ConnectionProvider({
  instance,
  children,
}: {
  instance: Instance;
  children: ReactNode;
}) {
  const [conn, setConn] = useState<Connection | null>(null);

  // Reprise après veille : indispensable sur téléphone, utile partout ailleurs
  // (un portable qu'on referme suspend la page de la même façon).
  useConnectionLifecycle(conn?.ws ?? null);

  useEffect(() => {
    const client = new ApiClient(
      instance.id,
      instance.url,
      () => {
        useSessionStore.getState().markUnauthed(instance.id);
      },
      // Every refresh returns the fresh user projection — mirror it into the
      // stored account so a role granted/revoked server-side shows up without
      // re-login (the Administration tab follows it).
      (user) => {
        useInstanceStore.getState().updateAccount(instance.id, {
          userId: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
        });
      },
    );
    const ws = new WsClient(client);
    ws.on("PRESENCE_UPDATE", (event) => {
      if (event.type !== "PRESENCE_UPDATE") return;
      const text = event.status_text ?? undefined;
      usePresenceStore.getState().setPresence(event.user_id, event.status, text);
      // My own echo (sent on connect) restores + cross-device-syncs my custom text.
      if (event.user_id === instance.account?.userId) {
        usePresenceStore.getState().setMyStatusText(text ?? "");
      }
    });
    setConn({ client, ws });
    void ws.connect();

    return () => {
      ws.disconnect();
      usePresenceStore.getState().reset();
    };
  }, [instance.id, instance.url]);

  if (!conn) return null;
  return <ConnectionContext.Provider value={conn}>{children}</ConnectionContext.Provider>;
}
