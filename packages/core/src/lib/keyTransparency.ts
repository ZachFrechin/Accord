/**
 * Key-transparency client verification (Phase 3 · Lot 6).
 *
 * The server publishes an append-only Merkle log of identity↔key bindings and
 * signs its head. This is the client half: re-implement the RFC 6962 hashing +
 * RFC 9162 inclusion/consistency verifiers (so the server is NOT trusted to verify
 * for us), check a Signed Tree Head's Ed25519 signature against the JWKS, and
 * confirm a peer's key is included in a head we've validated — and that each new
 * head is an append-only extension of the last one we trusted (catching a server
 * that rewrites history). Mirrors `backend/src/domain/transparency.rs` byte-for-byte.
 */

import nacl from "tweetnacl";

import { fromBase64, utf8ToBytes } from "./crypto";

/** A 32-byte hash. */
export type Hash = Uint8Array;

async function sha256(...chunks: Uint8Array[]): Promise<Hash> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

/** RFC 6962 leaf hash: SHA-256(0x00 || data). */
export function hashLeaf(data: Uint8Array): Promise<Hash> {
  return sha256(new Uint8Array([0x00]), data);
}
/** RFC 6962 node hash: SHA-256(0x01 || left || right). */
function hashNode(left: Hash, right: Hash): Promise<Hash> {
  return sha256(new Uint8Array([0x01]), left, right);
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** UUID string → its 16 canonical bytes (big-endian), matching `Uuid::as_bytes`. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("bad uuid");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Canonical leaf encoding: user_id(16) || len(device_id) as u32 BE || device_id ||
 * public_key. Byte-identical to the server's `binding_leaf`. */
export function bindingLeaf(userId: string, deviceId: string, publicKey: Uint8Array): Uint8Array {
  const uid = uuidToBytes(userId);
  const did = utf8ToBytes(deviceId);
  const out = new Uint8Array(16 + 4 + did.length + publicKey.length);
  out.set(uid, 0);
  new DataView(out.buffer).setUint32(16, did.length, false); // big-endian
  out.set(did, 20);
  out.set(publicKey, 20 + did.length);
  return out;
}

/** Recompute the tree root from a leaf + audit path and compare to `root`
 * (RFC 9162 §2.1.3.2). */
export async function verifyInclusion(
  leaf: Hash,
  index: number,
  size: number,
  root: Hash,
  proof: Hash[],
): Promise<boolean> {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false; // proof too long
    if ((fn & 1) === 1 || fn === sn) {
      r = await hashNode(p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = await hashNode(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && eq(r, root);
}

/** Verify the size-`second` tree (root `secondRoot`) is an append-only extension of
 * the size-`first` tree (root `firstRoot`) (RFC 9162 §2.1.4.2). */
export async function verifyConsistency(
  first: number,
  second: number,
  firstRoot: Hash,
  secondRoot: Hash,
  proof: Hash[],
): Promise<boolean> {
  if (first > second) return false;
  if (first === second) return proof.length === 0 && eq(firstRoot, secondRoot);
  if (first === 0) return proof.length === 0;

  const path: Hash[] = [];
  if ((first & (first - 1)) === 0) path.push(firstRoot); // power of two → implicit
  path.push(...proof);
  if (path.length === 0) return false;

  let fn = first - 1;
  let sn = second - 1;
  while ((fn & 1) === 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = await hashNode(c, fr);
      sr = await hashNode(c, sr);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      sr = await hashNode(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && eq(fr, firstRoot) && eq(sr, secondRoot);
}

/** base64url (no padding) → bytes. */
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return fromBase64(b64);
}

/** A JWKS document (as served at /.well-known/jwks.json). */
export interface Jwks {
  keys: { kty: string; crv?: string; x?: string; kid?: string }[];
}

/** A verified Signed Tree Head. */
export interface Sth {
  size: number;
  root: Hash;
}

/** Verify an STH JWT's Ed25519 signature against the JWKS and return its committed
 * (size, root). `null` if the signature or structure is invalid. */
export async function verifySth(sthJwt: string, jwks: Jwks): Promise<Sth | null> {
  const parts = sthJwt.split(".");
  if (parts.length !== 3) return null;
  const key = jwks.keys.find((k) => k.kty === "OKP" && k.crv === "Ed25519" && k.x);
  if (!key?.x) return null;
  const pub = b64urlToBytes(key.x);
  const signed = utf8ToBytes(`${parts[0]}.${parts[1]}`);
  const sig = b64urlToBytes(parts[2]);
  if (sig.length !== 64 || pub.length !== 32) return null;
  if (!nacl.sign.detached.verify(signed, sig, pub)) return null;
  let claims: { typ?: string; size?: number; root?: string };
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (claims.typ !== "kt-sth" || typeof claims.size !== "number" || typeof claims.root !== "string") {
    return null;
  }
  return { size: claims.size, root: hexToBytes(claims.root) };
}

/** The transparency endpoints this module needs (structural — avoids importing the
 * whole ApiClient here). */
export interface TransparencyClient {
  transparencySth(): Promise<{ tree_size: number; root: string; sth: string }>;
  transparencyInclusion(
    userId: string,
    deviceId: string,
  ): Promise<{ public_key: string; index: number; tree_size: number; root: string; proof: string[] }>;
  transparencyConsistency(
    first: number,
    second?: number,
  ): Promise<{ first: number; second: number; second_root: string; proof: string[] }>;
  jwks(): Promise<Jwks>;
}

/** Outcome of a peer-key transparency check. */
export interface TransparencyVerdict {
  ok: boolean;
  /** Why it failed (for logs / a UI badge); absent on success. */
  reason?: string;
  /** The signed head the proof was anchored to (on success). */
  head?: Sth;
}

/** Verify that `expectedKeyB64` really is the key the log commits to for
 * (userId, deviceId), anchored to a validly-signed tree head — fetching the proof,
 * the signed head, and (if the tree grew between the two) a consistency proof
 * linking the inclusion's root into the signed head. A failure means the server is
 * serving a key it can't prove it published — treat the peer's key as unverified. */
export async function verifyPeerKey(
  client: TransparencyClient,
  userId: string,
  deviceId: string,
  expectedKeyB64: string,
): Promise<TransparencyVerdict> {
  try {
    const [inc, sthRes, jwksDoc] = await Promise.all([
      client.transparencyInclusion(userId, deviceId),
      client.transparencySth(),
      client.jwks(),
    ]);
    if (inc.public_key !== expectedKeyB64) {
      return { ok: false, reason: "the logged key differs from the key received" };
    }
    const head = await verifySth(sthRes.sth, jwksDoc);
    if (!head) return { ok: false, reason: "the signed tree head's signature is invalid" };

    const incRoot = hexToBytes(inc.root);
    // Anchor the inclusion's root to the signed head.
    if (head.size === inc.tree_size) {
      if (!eq(head.root, incRoot)) {
        return { ok: false, reason: "the inclusion root does not match the signed head" };
      }
    } else if (head.size > inc.tree_size) {
      const cons = await client.transparencyConsistency(inc.tree_size, head.size);
      const linked = await verifyConsistency(
        inc.tree_size,
        head.size,
        incRoot,
        head.root,
        cons.proof.map(hexToBytes),
      );
      if (!linked) return { ok: false, reason: "the inclusion root is not a prefix of the signed head" };
    } else {
      return { ok: false, reason: "the signed head is older than the inclusion proof" };
    }

    const leaf = await hashLeaf(bindingLeaf(userId, deviceId, fromBase64(expectedKeyB64)));
    const ok = await verifyInclusion(leaf, inc.index, inc.tree_size, incRoot, inc.proof.map(hexToBytes));
    return ok ? { ok: true, head } : { ok: false, reason: "the inclusion proof failed to verify" };
  } catch (e) {
    return { ok: false, reason: `transparency check errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Lowercase hex → bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes → lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
