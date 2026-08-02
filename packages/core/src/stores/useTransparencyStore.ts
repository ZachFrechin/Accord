/**
 * Key-transparency head monitoring (Phase 3 · Lot 6).
 *
 * Persists the last signed tree head this client trusted, per instance. On each
 * connect we fetch the current head, verify its Ed25519 signature, and prove it is
 * an append-only *extension* of the stored one — so a server that quietly rewrote
 * the log (equivocating on a key) is caught the next time this client looks, even
 * without cross-client gossip. A failure raises a loud, sticky alert.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  type TransparencyClient,
  bytesToHex,
  hexToBytes,
  verifyConsistency,
  verifySth,
} from "../lib/keyTransparency";

/** A trusted head: the size + hex root this client last accepted for an instance. */
interface Head {
  size: number;
  root: string;
}

export type TransparencyStatus = "ok" | "tampered" | "unknown";

interface TransparencyState {
  /** instanceId → last trusted head (persisted). */
  heads: Record<string, Head>;
  /** instanceId → latest check outcome (transient, recomputed each session). */
  status: Record<string, TransparencyStatus>;
  setHead: (instanceId: string, head: Head) => void;
  setStatus: (instanceId: string, status: TransparencyStatus) => void;
  reset: (instanceId: string) => void;
}

export const useTransparencyStore = create<TransparencyState>()(
  persist(
    (set) => ({
      heads: {},
      status: {},
      setHead: (instanceId, head) => set((s) => ({ heads: { ...s.heads, [instanceId]: head } })),
      setStatus: (instanceId, status) =>
        set((s) => ({ status: { ...s.status, [instanceId]: status } })),
      reset: (instanceId) =>
        set((s) => {
          const heads = { ...s.heads };
          const status = { ...s.status };
          delete heads[instanceId];
          delete status[instanceId];
          return { heads, status };
        }),
    }),
    {
      name: "accord.transparency.v1",
      // Only the trusted head is durable; the live status is recomputed each session.
      partialize: (s) => ({ heads: s.heads }),
    },
  ),
);

/**
 * Fetch the current signed tree head, verify it, and check it extends the last one
 * we trusted for this instance. Records the (larger) head on success; flags
 * `"tampered"` on a bad signature, a non-extending head, or a head that went
 * backwards. Best-effort: a network/parse error yields `"unknown"` and changes
 * nothing. Returns the outcome so the caller can alert.
 */
export async function monitorTransparency(
  client: TransparencyClient,
  instanceId: string,
): Promise<TransparencyStatus> {
  const store = useTransparencyStore.getState();

  let head;
  try {
    const [sthRes, jwksDoc] = await Promise.all([client.transparencySth(), client.jwks()]);
    head = await verifySth(sthRes.sth, jwksDoc);
  } catch {
    return "unknown"; // couldn't reach / parse — don't overwrite a good head
  }
  if (!head) {
    store.setStatus(instanceId, "tampered"); // an unsigned/forged head is an attack
    return "tampered";
  }

  const stored = store.heads[instanceId];
  if (stored) {
    let consistent = false;
    if (head.size > stored.size) {
      try {
        const cons = await client.transparencyConsistency(stored.size, head.size);
        consistent = await verifyConsistency(
          stored.size,
          head.size,
          hexToBytes(stored.root),
          head.root,
          cons.proof.map(hexToBytes),
        );
      } catch {
        return "unknown";
      }
    } else if (head.size === stored.size) {
      consistent = bytesToHex(head.root) === stored.root; // same size must be same root
    } // head.size < stored.size → the log shrank: consistent stays false

    if (!consistent) {
      store.setStatus(instanceId, "tampered");
      return "tampered";
    }
  }

  store.setHead(instanceId, { size: head.size, root: bytesToHex(head.root) });
  store.setStatus(instanceId, "ok");
  return "ok";
}
