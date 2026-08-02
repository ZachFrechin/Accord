/**
 * Key verification for a DM (Phase 3 L6). Shows the shared safety number, lets you
 * mark it verified after comparing out-of-band, and flags when the peer's key has
 * changed since. Works on both the legacy X25519 and MLS paths — it only reads
 * published public keys, so it needs no native engine.
 */

import { useEffect, useState } from "react";

import { computeSafetyNumber } from "../../lib/safetyNumber";
import { useConnection } from "../../realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { useVerificationStore, verificationKey } from "../../stores/useVerificationStore";
import { Button, Dialog, Icon } from "../ui";

type Status = "pending" | "unverified" | "verified" | "changed";

export function KeyVerification({ peerId, peerName }: { peerId: string; peerName: string }) {
  const { client } = useConnection();
  const instanceId = useInstanceStore((s) => s.activeInstanceId);
  const myId = useInstanceStore((s) => activeInstance(s)?.account?.userId ?? null);
  const verified = useVerificationStore((s) => s.verified);
  const markVerified = useVerificationStore((s) => s.markVerified);
  const clearVerified = useVerificationStore((s) => s.clearVerified);

  const [number, setNumber] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!myId) return;
    let alive = true;
    setNumber(null);
    (async () => {
      const [mine, peer] = await Promise.all([client.keyBundle(myId), client.keyBundle(peerId)]);
      const n = await computeSafetyNumber(
        mine.devices.map((d) => d.public_key),
        peer.devices.map((d) => d.public_key),
      );
      if (alive) setNumber(n);
    })().catch(() => {
      if (alive) setNumber(null);
    });
    return () => {
      alive = false;
    };
  }, [client, myId, peerId]);

  const vkey = instanceId ? verificationKey(instanceId, peerId) : "";
  const verifiedNumber = verified[vkey];
  const status: Status = !number
    ? "pending"
    : !verifiedNumber
      ? "unverified"
      : verifiedNumber === number
        ? "verified"
        : "changed";

  const label =
    status === "verified"
      ? "Vérifié"
      : status === "changed"
        ? "La clé a changé"
        : status === "pending"
          ? "…"
          : "Non vérifié";

  return (
    <div className="keyverif">
      <div className="details__section-label">Vérification de clés</div>
      <button
        type="button"
        className="keyverif__badge"
        data-status={status}
        onClick={() => setOpen(true)}
      >
        <Icon name={status === "verified" ? "shield-check" : "lock"} size={16} />
        <span>{label}</span>
      </button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Vérification de clés"
        description={`Confirmez que vous parlez bien à ${peerName}, pas à un intermédiaire.`}
      >
        <div className="keyverif__panel">
          <p className="keyverif__hint">
            {`Comparez ce numéro avec ${peerName} par un canal de confiance (en personne, un appel). S'ils sont identiques des deux côtés, personne n'intercepte la conversation.`}
          </p>
          <div className="keyverif__number" aria-label="Numéro de sécurité">
            {number ?? "Numéro indisponible (clés manquantes)"}
          </div>
          {status === "changed" && (
            <p className="keyverif__warn">
              <Icon name="lock" size={14} />
              <span>
                {`La clé de ${peerName} a changé depuis votre dernière vérification. Re-vérifiez avant de faire confiance.`}
              </span>
            </p>
          )}
          <div className="keyverif__actions">
            {status === "verified" ? (
              <Button variant="ghost" onClick={() => clearVerified(vkey)}>
                Retirer la vérification
              </Button>
            ) : (
              <Button disabled={!number} onClick={() => number && markVerified(vkey, number)}>
                Marquer comme vérifié
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}
