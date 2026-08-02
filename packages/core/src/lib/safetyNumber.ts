/**
 * Safety numbers (key verification, Phase 3 L6).
 *
 * A safety number is a stable fingerprint derived from BOTH parties' published
 * public keys. Two people compare it out-of-band (in person, a trusted call): if
 * the numbers match, no one is sitting in the middle swapping keys — because a
 * MITM would have to show each side a different key, yielding a different number.
 *
 * Derivation is symmetric (the two per-user fingerprints are sorted before
 * combining) so both devices compute the identical number, and it is expressed as
 * 12 groups of 5 digits (Signal-style) for easy human comparison.
 */

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** A user's key fingerprint: hex SHA-256 over their sorted public keys. */
async function fingerprint(publicKeys: string[]): Promise<string> {
  const digest = await sha256(publicKeys.slice().sort().join("|"));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute the shared safety number for a conversation from each side's published
 * public keys. Returns null when either side has no keys yet (nothing to verify).
 */
export async function computeSafetyNumber(
  myKeys: string[],
  peerKeys: string[],
): Promise<string | null> {
  if (myKeys.length === 0 || peerKeys.length === 0) return null;
  const combined = [await fingerprint(myKeys), await fingerprint(peerKeys)].sort().join("|");
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const h = await sha256(`${combined}:${i}`);
    const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 100000;
    groups.push(String(n).padStart(5, "0"));
  }
  return groups.join(" ");
}
