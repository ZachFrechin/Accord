/**
 * MLS messaging runtime — Phase 3 · Lot 4.
 *
 * The single surface the app calls to run MLS over the Delivery Service: publish
 * KeyPackages on sign-in, join queued Welcomes, create groups, send, and apply
 * incoming frames. It owns the per-(instance, group) replay cursor (persisted so a
 * reconnect resumes rather than re-processing). All crypto is in the native engine;
 * the server only ever sees opaque frames.
 *
 * Integration status: composable runtime + sign-in bootstrap, wired into the chat
 * UI by the dual-path in `messagingActions` (MLS conversations route here; legacy
 * ones stay on the X25519 path). Decryption is destructive under MLS forward
 * secrecy — an application frame's key is consumed on `process`, so callers must
 * persist the recovered plaintext (the messages store) rather than re-read frames.
 */

import type { ApiClient } from "../../api/ApiClient";
import { isTauri } from "../isTauri";
import { mlsEngine } from "./MlsEngine";
import {
  type AddTarget,
  type SyncedMessage,
  addDevices,
  createMlsGroup,
  pullWelcomes,
  removeDevice,
  removeMemberDevices,
  selfUpdateCommit,
  sendAppMessage,
  syncFrames,
} from "./mlsGroup";
import { ensureMlsKeyPackages } from "./mlsKeyPackages";

const cursorKey = (instanceId: string, groupId: string) =>
  `accord.mls.cursor.${instanceId}.${groupId}`;

function readCursor(instanceId: string, groupId: string): { seq: number } {
  const raw = localStorage.getItem(cursorKey(instanceId, groupId));
  return { seq: raw ? Number(raw) || 0 : 0 };
}
function writeCursor(instanceId: string, groupId: string, cursor: { seq: number }): void {
  localStorage.setItem(cursorKey(instanceId, groupId), String(cursor.seq));
}

/**
 * Serialize every mutating operation on one (instance, group). A group's engine
 * state is a single object mutated across several `invoke` round-trips, and both
 * the ratchet and the replay cursor are shared; two logical operations (a sync, a
 * commit, a send) interleaving mid-sequence could corrupt them. A promise chain
 * per key enforces strict one-at-a-time ordering. Only top-level runtime entry
 * points take the lock — their inner helpers do not — so there is no re-entrancy.
 */
const groupLocks = new Map<string, Promise<unknown>>();
function withGroupLock<T>(
  instanceId: string,
  groupId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${instanceId}:${groupId}`;
  const prev = groupLocks.get(key) ?? Promise.resolve();
  // Run fn once `prev` settles, whether it fulfilled or rejected.
  const run = prev.then(fn, fn);
  // The next waiter chains on completion only — never inherits this op's rejection.
  groupLocks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

// ── Proactive re-key (post-compromise security heartbeat) ─────────────────────
// Add/remove already rekey the epoch, but a group with stable membership would
// otherwise never rotate — so a one-time compromise of a member device stays
// exploitable forever. We periodically self-update (rotate our own leaf key),
// throttled per group by a persisted timestamp.
const REKEY_INTERVAL_MS = 24 * 60 * 60 * 1000; // base cadence: once a day per group
// Per-(device, group) random jitter added to the interval, generated once and
// persisted. De-correlates re-keys so a client with many groups — and the several
// devices within one group — don't all rotate in the same daily burst (409 storms).
const REKEY_JITTER_MS = 12 * 60 * 60 * 1000; // up to +12h

const rekeyAtKey = (instanceId: string, groupId: string) =>
  `accord.mls.rekey.${instanceId}.${groupId}`;
const rekeyJitterKey = (instanceId: string, groupId: string) =>
  `accord.mls.rekeyjitter.${instanceId}.${groupId}`;

function readRekeyAt(instanceId: string, groupId: string): number | null {
  const raw = localStorage.getItem(rekeyAtKey(instanceId, groupId));
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function markRekeyed(instanceId: string, groupId: string): void {
  localStorage.setItem(rekeyAtKey(instanceId, groupId), String(Date.now()));
}
/** This device+group's stable random jitter, minted on first use. localStorage is
 * per-device, so every device draws its own — spreading a group's rotations out. */
function rekeyIntervalFor(instanceId: string, groupId: string): number {
  const k = rekeyJitterKey(instanceId, groupId);
  let raw = localStorage.getItem(k);
  if (raw == null) {
    raw = String(Math.floor(Math.random() * REKEY_JITTER_MS));
    localStorage.setItem(k, raw);
  }
  const jitter = Number(raw);
  return REKEY_INTERVAL_MS + (Number.isFinite(jitter) ? jitter : 0);
}
/** Guards against a second proactive re-key firing while one is already in flight
 * (both `onMlsFrame` events would otherwise see the same stale timestamp). */
const rekeyInFlight = new Set<string>();

/**
 * Call after sign-in / on (re)connect: ensure the device's MLS identity +
 * KeyPackage pool are published, then join any groups it was added to while
 * offline. Returns the (re)joined group ids. The caller must `receiveMls` each so
 * the recovered plaintext lands in the store BEFORE the ratchet key is consumed —
 * bootstrap deliberately does not sync here, to avoid dropping those messages.
 */
export async function bootstrapMls(
  client: ApiClient,
  instanceId: string,
  deviceId: string,
  identity: string,
): Promise<string[]> {
  await ensureMlsKeyPackages(client, instanceId, deviceId, identity);
  return joinPendingWelcomes(client, instanceId, deviceId);
}

/** Join any groups queued in the Welcome mailbox (a peer added this device while
 * offline, or just now). Returns the newly-joined group ids. */
export async function joinPendingWelcomes(
  client: ApiClient,
  instanceId: string,
  deviceId: string,
): Promise<string[]> {
  return pullWelcomes(client, instanceId, deviceId);
}

/** Whether this device already holds the group state (has joined/created it).
 *
 * Only "the group genuinely isn't there" maps to `false`. Any OTHER engine
 * failure (state decrypt error, keychain hiccup…) throws instead — treating a
 * transient storage failure as "never joined" is exactly how a device forks a
 * second group under the same id (split-brain). */
export async function isMlsGroupJoined(instanceId: string, groupId: string): Promise<boolean> {
  try {
    await mlsEngine.groupEpoch(instanceId, groupId);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("group not found") || msg.includes("identity not initialized")) {
      return false;
    }
    if (!isTauri()) return false; // browser dev has no engine at all
    throw e;
  }
}

/**
 * Derive the 32-byte E2EE media key for a call from the conversation's MLS group
 * exporter, or `null` when there is no MLS group for it (legacy conversation, or
 * browser dev where the native engine is absent). Every member of the group
 * derives the identical key, so the SFU can relay media it cannot decrypt.
 */
export async function callMediaKey(
  instanceId: string,
  conversationId: string,
): Promise<Uint8Array | null> {
  if (!(await isMlsGroupJoined(instanceId, conversationId).catch(() => false))) return null;
  try {
    const b64 = await mlsEngine.exportCallKey(instanceId, conversationId);
    const bin = atob(b64);
    const key = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) key[i] = bin.charCodeAt(i);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Create an MLS group for a conversation and add the given members' devices.
 * Peer messages an add commit sweeps up are handed to `onSwept` (deliver them). */
export async function startMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  members: AddTarget[],
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  return withGroupLock(instanceId, conversationId, async () => {
    await createMlsGroup(client, instanceId, conversationId);
    const cursor = readCursor(instanceId, conversationId);
    await addDevices(client, instanceId, conversationId, members, cursor, onSwept);
    writeCursor(instanceId, conversationId, cursor);
    markRekeyed(instanceId, conversationId); // fresh epoch — start the heartbeat clock
  });
}

/** Add more members' devices to an existing MLS group. Peer messages an add commit
 * sweeps up are handed to `onSwept` (deliver them). */
export async function addToMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  members: AddTarget[],
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  return withGroupLock(instanceId, conversationId, async () => {
    const cursor = readCursor(instanceId, conversationId);
    await addDevices(client, instanceId, conversationId, members, cursor, onSwept);
    writeCursor(instanceId, conversationId, cursor);
    markRekeyed(instanceId, conversationId); // add already rekeyed the epoch
  });
}

/** Remove a device (by leaf index) from an MLS group — rekeys the epoch (PCS).
 * Peer messages the commit sweeps up are handed to `onSwept` (deliver them). */
export async function removeFromMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  leafIndex: number,
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  return withGroupLock(instanceId, conversationId, async () => {
    const cursor = readCursor(instanceId, conversationId);
    await removeDevice(client, instanceId, conversationId, leafIndex, cursor, onSwept);
    writeCursor(instanceId, conversationId, cursor);
    markRekeyed(instanceId, conversationId); // remove already rekeyed the epoch
  });
}

/** Revoke a member from an MLS group: remove ALL of their devices in one commit,
 * rekeying so they lose forward access (PCS). Composes with removing them from the
 * conversation. No-op if they aren't in the group. Peer messages the commit sweeps
 * up are handed to `onSwept` (deliver them). */
export async function removeUserFromMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  userId: string,
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  return withGroupLock(instanceId, conversationId, async () => {
    const cursor = readCursor(instanceId, conversationId);
    await removeMemberDevices(client, instanceId, conversationId, `${userId}:`, cursor, onSwept);
    writeCursor(instanceId, conversationId, cursor);
    markRekeyed(instanceId, conversationId); // remove already rekeyed the epoch
  });
}

/**
 * Pull + apply new frames for a group (call on an MLS_FRAME event or on open).
 * Returns the newly-decrypted application messages, in order, plus the count of
 * frames that should have been processable but were not (`failures > 0` is the
 * caller's cue to run a divergence check / repair).
 */
export async function receiveMls(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
): Promise<{ messages: SyncedMessage[]; failures: number }> {
  return withGroupLock(instanceId, conversationId, async () => {
    const cursor = readCursor(instanceId, conversationId);
    const { cursor: next, messages, failures } = await syncFrames(
      client,
      instanceId,
      conversationId,
      cursor.seq,
    );
    writeCursor(instanceId, conversationId, { seq: next });
    return { messages, failures };
  });
}

// ── Divergence repair + membership sweep ─────────────────────────────────────

/** Min delay between repair attempts per group (avoid wipe/rejoin loops). */
const REPAIR_THROTTLE_MS = 60 * 1000;
const repairAtKey = (instanceId: string, groupId: string) =>
  `accord.mls.repair.${instanceId}.${groupId}`;

/**
 * Split-brain repair: wipe this device's (divergent) local group and rejoin the
 * REAL group from its still-pending Welcome. Returns whether the group is
 * usable again. When no Welcome is waiting (e.g. it was destroyed by an older
 * client), the wipe still clears the poison: an active member's sweep re-adds
 * this device, and the next welcome drain completes the repair.
 */
export async function repairMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  deviceId: string,
): Promise<boolean> {
  const throttleKey = repairAtKey(instanceId, conversationId);
  const last = Number(localStorage.getItem(throttleKey) ?? 0);
  if (Date.now() - last < REPAIR_THROTTLE_MS) return false;
  localStorage.setItem(throttleKey, String(Date.now()));

  return withGroupLock(instanceId, conversationId, async () => {
    await mlsEngine.deleteGroup(instanceId, conversationId).catch(() => {});
    // The skipped frames belonged to the real group; after rejoining we rescan
    // from the start — pre-join frames are benign skips under the epoch rule.
    writeCursor(instanceId, conversationId, { seq: 0 });
    const joined = await pullWelcomes(client, instanceId, deviceId);
    return joined.includes(conversationId);
  });
}

/** Min delay between membership sweeps per group. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const sweepAtKey = (instanceId: string, groupId: string) =>
  `accord.mls.sweep.${instanceId}.${groupId}`;

/** Whether this group's periodic membership sweep is due (throttle read). */
export function shouldSweepMembers(instanceId: string, conversationId: string): boolean {
  const last = Number(localStorage.getItem(sweepAtKey(instanceId, conversationId)) ?? 0);
  return Date.now() - last >= SWEEP_INTERVAL_MS;
}

/**
 * Add every expected conversation device that is missing from the MLS tree
 * (their Welcome was lost, they repaired themselves, or they joined the
 * conversation after the cutover). No-op when nothing is missing. Throttled by
 * {@link shouldSweepMembers}; concurrent sweeps from several members are safe —
 * the server CAS arbitrates and `addDevices` re-checks the tree per attempt.
 */
export async function sweepMissingDevices(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  expected: AddTarget[],
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  localStorage.setItem(sweepAtKey(instanceId, conversationId), String(Date.now()));
  const identities = await mlsEngine
    .memberIdentities(instanceId, conversationId)
    .catch(() => null);
  if (!identities) return;
  const missing = expected
    .map((m) => ({
      userId: m.userId,
      deviceIds: m.deviceIds.filter((d) => !identities.includes(`${m.userId}:${d}`)),
    }))
    .filter((m) => m.deviceIds.length > 0);
  if (missing.length === 0) return;
  await addToMlsGroup(client, instanceId, conversationId, missing, onSwept);
}

/** Encrypt + submit an application message. Our own frame is applied on the next
 * `receiveMls` (which the server's MLS_FRAME echo triggers). Returns its seq. */
export async function sendMls(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  plaintext: string,
): Promise<number> {
  return withGroupLock(instanceId, conversationId, () =>
    sendAppMessage(client, instanceId, conversationId, plaintext),
  );
}

/** Rotate this device's own leaf key (an MLS self-update Commit) so the epoch
 * advances with no membership change — the post-compromise-security heartbeat.
 * Records the time so {@link maybeRekeyMlsGroup} throttles the next one. */
export async function rekeyMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  return withGroupLock(instanceId, conversationId, async () => {
    const cursor = readCursor(instanceId, conversationId);
    await selfUpdateCommit(client, instanceId, conversationId, cursor, onSwept);
    writeCursor(instanceId, conversationId, cursor);
    markRekeyed(instanceId, conversationId);
  });
}

/** Fire a proactive re-key iff this group hasn't rotated within the heartbeat
 * window. Throttled + in-flight-guarded + best-effort, so it is safe to call on
 * every sync (open or MLS_FRAME). The first time a group is ever seen we only
 * start its clock — no rotation — to avoid a re-key burst right after upgrade.
 * Peer messages the re-key's commit sync sweeps up are handed to `onSwept`. */
export async function maybeRekeyMlsGroup(
  client: ApiClient,
  instanceId: string,
  conversationId: string,
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  const key = `${instanceId}:${conversationId}`;
  // Everything up to `rekeyInFlight.add` is synchronous, so the guard is claimed
  // before the first await — otherwise two concurrent callers could both pass it.
  if (rekeyInFlight.has(key)) return;
  const last = readRekeyAt(instanceId, conversationId);
  if (last == null) {
    markRekeyed(instanceId, conversationId); // start the clock; don't rotate now
    return;
  }
  if (Date.now() - last < rekeyIntervalFor(instanceId, conversationId)) return;

  rekeyInFlight.add(key);
  try {
    if (!(await isMlsGroupJoined(instanceId, conversationId).catch(() => false))) return;
    await rekeyMlsGroup(client, instanceId, conversationId, onSwept);
  } catch (e) {
    // A failed self-update must still advance the throttle, or it would re-fire on
    // every incoming frame (a full-commit retry storm). Back off a full window.
    markRekeyed(instanceId, conversationId);
    console.warn("MLS proactive rekey failed", e);
  } finally {
    rekeyInFlight.delete(key);
  }
}
