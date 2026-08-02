/**
 * Persistent key-transparency alert (Phase 3 · Lot 6).
 *
 * When the head watchdog ([`monitorTransparency`]) finds the server's key log is
 * no longer an append-only extension of the one this client trusted, it sets the
 * instance's status to "tampered". A rewritten log means the server may be
 * equivocating on someone's key — a serious, sticky condition, not a 4-second
 * toast — so this banner stays up until the log becomes consistent again.
 */

import { Icon } from "./ui";
import { activeInstance, useInstanceStore } from "../stores/useInstanceStore";
import { useTransparencyStore } from "../stores/useTransparencyStore";
import "./ConnectionBanner.css";

export function TransparencyBanner() {
  const instanceId = useInstanceStore((s) => activeInstance(s)?.id);
  const status = useTransparencyStore((s) => (instanceId ? s.status[instanceId] : undefined));

  if (status !== "tampered") return null;
  return (
    <div className="kt-banner" role="alert" aria-live="assertive">
      <Icon name="shield-check" size={16} className="kt-banner__icon" />
      <span>
        <strong>Alerte de sécurité :</strong> le journal de transparence des clés du serveur est
        incohérent (il a peut-être été réécrit). Vérifiez l'identité de vos contacts hors-bande avant
        de leur faire confiance.
      </span>
    </div>
  );
}
