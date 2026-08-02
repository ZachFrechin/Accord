/**
 * Persisted key-verification state (Phase 3 L6). Remembers the safety number a
 * user marked as verified for a peer, keyed by `${instanceId}:${peerUserId}`. If
 * the peer's key later changes, the freshly-computed number won't match the
 * stored one — that mismatch is how a key change (new device, or a MITM) surfaces.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface VerificationState {
  /** key → the safety number that was confirmed out-of-band. */
  verified: Record<string, string>;
  markVerified: (key: string, safetyNumber: string) => void;
  clearVerified: (key: string) => void;
}

/** Composite key for a peer within an instance. */
export const verificationKey = (instanceId: string, peerUserId: string): string =>
  `${instanceId}:${peerUserId}`;

export const useVerificationStore = create<VerificationState>()(
  persist(
    (set) => ({
      verified: {},
      markVerified: (key, safetyNumber) =>
        set((s) => ({ verified: { ...s.verified, [key]: safetyNumber } })),
      clearVerified: (key) =>
        set((s) => {
          const next = { ...s.verified };
          delete next[key];
          return { verified: next };
        }),
    }),
    { name: "accord.verification.v1" },
  ),
);
