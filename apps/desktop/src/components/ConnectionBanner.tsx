/**
 * Slim connection-status banner. The realtime socket reconnects with backoff on
 * its own, but a dropped connection used to be completely invisible — typing,
 * presence and delivery silently stalled. This surfaces the state so the user
 * knows why things paused.
 */

import { useEffect, useState } from "react";

import { useConnection } from "../realtime/ConnectionProvider";
import type { WsStatus } from "../realtime/wsClient";
import "./ConnectionBanner.css";

export function ConnectionBanner() {
  const { ws } = useConnection();
  const [status, setStatus] = useState<WsStatus>("connecting");
  useEffect(() => ws.onStatus(setStatus), [ws]);

  if (status === "open") return null;
  return (
    <div className="conn-banner" role="status" aria-live="polite" data-status={status}>
      <span className="conn-banner__dot" aria-hidden />
      {status === "reconnecting" ? "Connexion perdue — reconnexion…" : "Connexion…"}
    </div>
  );
}
