/**
 * MLS group lifecycle — client half of Phase 3 · Lot 3.
 *
 * Composes the native engine (`MlsEngine`) with the Delivery Service (`ApiClient`):
 * create a group, add devices (claim KeyPackages → Add commit → submit), pull
 * frames in order to advance the epoch, and join from queued Welcomes.
 *
 * Concurrency is handled per RFC 9750: a commit is built but its local merge is
 * DEFERRED until the Delivery Service echoes it back; on a 409 the pending commit
 * is discarded, the winning frames are replayed, and the commit is rebuilt on the
 * new epoch (`submitCommit` below). The remaining Lot 4 work is wiring these into
 * `messagingActions` (send/receive + MLS_FRAME handling) and the sign-in bootstrap.
 */

import type { ApiClient, MlsWelcomeSend } from "../../api/ApiClient";
import { ApiError } from "../../api/http";
import { type MlsEngine, mlsEngine } from "./MlsEngine";
import { claimForMembers } from "./mlsKeyPackages";

/** A decrypted application message recovered from the ordered frame log. */
export interface SyncedMessage {
  senderId: string | null;
  plaintext: string;
  orderSeq: number;
}

/** Thrown when this device's local group provably cannot converge with the
 * server's log (split-brain / poisoned state): commits 409 without the local
 * epoch ever advancing. The caller should run the divergence repair (wipe the
 * local group and rejoin via Welcome) instead of retrying forever. */
export class MlsDivergenceError extends Error {
  constructor(public readonly groupId: string) {
    super("local MLS group diverged from the server log");
    this.name = "MlsDivergenceError";
  }
}

/** Register the group's ordering row on the server, then create it locally.
 * Server-first on purpose: a backend that can't serve MLS (e.g. 404) then fails
 * BEFORE we create engine state, so a failed enable leaves no stranded local group
 * that a retry would mistake for "already joined". */
export async function createMlsGroup(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  engine: MlsEngine = mlsEngine,
): Promise<void> {
  await client.createMlsGroup(groupId);
  await engine.createGroup(instanceId, groupId);
}

/** Pull + apply every frame after `cursor` in order (advancing the epoch on
 * commits), returning any application messages and the new cursor.
 *
 * `failures` counts frames that SHOULD have been processable but were not:
 * current-or-future-epoch frames our group state rejects. Old-epoch frames
 * (from before this device joined, or already superseded) are expected skips
 * and not counted. A non-zero count is the divergence signal — the log belongs
 * to a different group than ours. */
export async function syncFrames(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  cursor: number,
  engine: MlsEngine = mlsEngine,
): Promise<{ cursor: number; messages: SyncedMessage[]; failures: number }> {
  const { frames } = await client.mlsFrames(groupId, cursor);
  const messages: SyncedMessage[] = [];
  let next = cursor;
  let failures = 0;
  for (const f of frames) {
    try {
      // Own frames are reported as a benign `null` by the engine, so any throw
      // here is a real processing failure.
      const plaintext = await engine.process(instanceId, groupId, f.frame);
      if (plaintext !== null && f.content_type === "application") {
        messages.push({ senderId: f.sender_id, plaintext, orderSeq: f.order_seq });
      }
    } catch {
      const localEpoch = await engine.groupEpoch(instanceId, groupId).catch(() => null);
      // Only frames at/after our epoch should be processable; older ones are
      // pre-join history or already-superseded traffic (benign skips).
      if (localEpoch === null || f.epoch >= localEpoch) failures++;
    }
    next = f.order_seq;
  }
  return { cursor: next, messages, failures };
}

/** Join any groups this device was added to while offline. Returns joined ids.
 *
 * At-least-once: the server keeps each Welcome pending until we ACK it after
 * the join attempt — a crash between fetch and join no longer destroys it. The
 * group-id hint makes the join wipe any divergent local group first, which is
 * also how a split-brain device repairs itself from its still-pending Welcome. */
export async function pullWelcomes(
  client: ApiClient,
  instanceId: string,
  deviceId: string,
  engine: MlsEngine = mlsEngine,
): Promise<string[]> {
  const { welcomes } = await client.mlsWelcomes(deviceId);
  const joined: string[] = [];
  for (const w of welcomes) {
    try {
      joined.push(await engine.joinFromWelcome(instanceId, w.welcome, w.group_id));
    } catch (e) {
      console.warn(`MLS welcome join failed for group ${w.group_id}`, e);
    }
    // Ack whether the join worked or deterministically failed — either way,
    // replaying it would not help. (Older servers have no ack route: they
    // already consumed the welcome on fetch, and `id` is absent.)
    if (w.id) await client.ackMlsWelcome(w.id).catch(() => {});
  }
  return joined;
}

/** A member and the device ids to add. */
export interface AddTarget {
  userId: string;
  deviceIds: string[];
}

/** What a commit build produced: the frame + any Welcomes to fan to new devices. */
interface BuiltCommit {
  commit: string;
  welcomes: MlsWelcomeSend[];
}

const MAX_COMMIT_RETRIES = 6;

/**
 * Submit a staged commit with the RFC 9750 flow: build → submit at the current
 * epoch → on accept MERGE the local pending commit; on 409 DISCARD it, replay the
 * winning frames (advancing our epoch), and rebuild on the new epoch. `build`
 * stages a fresh pending commit each call and returns its bytes; `cursor` is the
 * caller's per-group replay cursor, advanced here as frames are applied.
 */
async function submitCommit(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  engine: MlsEngine,
  cursor: { seq: number },
  build: () => Promise<BuiltCommit | null>,
  onSwept?: (messages: SyncedMessage[]) => void,
): Promise<void> {
  // Peer application frames can be interleaved with our commit in the ordered log;
  // the syncFrames below consume + decrypt them (destructive under forward secrecy).
  // We deliver each swept batch IMMEDIATELY via `onSwept` — never accumulate to the
  // end — because a later attempt can throw (non-409 error, or non-convergence) and
  // any messages held back would then be permanently, silently lost.
  const deliver = (messages: SyncedMessage[]) => {
    if (messages.length) onSwept?.(messages);
  };
  for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt++) {
    const built = await build();
    if (!built) return; // nothing to commit (e.g. a remove prefix that matched nobody)
    const { commit, welcomes } = built;
    const epoch = await engine.groupEpoch(instanceId, groupId); // the commit targets this
    try {
      await client.mlsCommit(groupId, epoch, commit, welcomes);
      await engine.mergePending(instanceId, groupId); // DS accepted → apply ours
      // Our own accepted commit also lands in the log; skip it on the next sync.
      const synced = await syncFrames(client, instanceId, groupId, cursor.seq, engine);
      cursor.seq = synced.cursor;
      deliver(synced.messages);
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await engine.clearPending(instanceId, groupId); // discard our stale commit
        const synced = await syncFrames(client, instanceId, groupId, cursor.seq, engine);
        cursor.seq = synced.cursor; // catch up to the winner, then rebuild
        deliver(synced.messages); // deliver NOW — the next attempt may throw
        // Progress check: losing a race means the winner's commit just advanced
        // our epoch. If it did NOT move, the log belongs to a different group
        // than ours (split-brain) — retrying the same epoch 409s forever, so
        // hand the caller the repair signal instead.
        const after = await engine.groupEpoch(instanceId, groupId);
        if (after === epoch) throw new MlsDivergenceError(groupId);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`MLS commit did not converge after ${MAX_COMMIT_RETRIES} attempts`);
}

/** Add members' devices to a group: one Add commit per device with the
 * deferred-merge / 409-rebase flow. The KeyPackage claim happens INSIDE each
 * build so a rebuild after a lost race claims a FRESH single-use package (the
 * previous one was consumed by the discarded commit), and a device that is
 * already in the tree — added concurrently by another member — is skipped.
 * Peer messages the commit syncs sweep up are handed to `onSwept` (never lost). */
export async function addDevices(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  members: AddTarget[],
  cursor: { seq: number },
  onSwept?: (messages: SyncedMessage[]) => void,
  engine: MlsEngine = mlsEngine,
): Promise<void> {
  for (const member of members) {
    for (const deviceId of member.deviceIds) {
      await submitCommit(
        client,
        instanceId,
        groupId,
        engine,
        cursor,
        async () => {
          const identity = `${member.userId}:${deviceId}`;
          const inTree = await engine
            .memberIdentities(instanceId, groupId)
            .then((ids) => ids.includes(identity))
            .catch(() => false);
          if (inTree) return null;
          const claimed = await claimForMembers(client, [
            { userId: member.userId, deviceIds: [deviceId] },
          ]);
          const c = claimed[0];
          if (!c) return null; // no KeyPackage published for this device — skip
          const { commit, welcome } = await engine.addMember(instanceId, groupId, c.keyPackage);
          return { commit, welcomes: [{ user_id: c.userId, device_id: c.deviceId, welcome }] };
        },
        onSwept,
      );
    }
  }
}

/** Remove a device (by leaf index) from a group — rekeys the epoch (PCS). Peer
 * messages the commit syncs sweep up are handed to `onSwept` as they arrive. */
export async function removeDevice(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  leafIndex: number,
  cursor: { seq: number },
  onSwept?: (messages: SyncedMessage[]) => void,
  engine: MlsEngine = mlsEngine,
): Promise<void> {
  await submitCommit(
    client,
    instanceId,
    groupId,
    engine,
    cursor,
    async () => {
      const commit = await engine.removeMember(instanceId, groupId, leafIndex);
      return { commit, welcomes: [] };
    },
    onSwept,
  );
}

/** Remove EVERY device of a member (by credential identity prefix, e.g. `userId:`)
 * from a group in one commit — rekeys the epoch so they lose forward access (PCS).
 * A no-op if the prefix matches no current member. Peer messages the commit syncs
 * sweep up are handed to `onSwept` as they arrive. */
export async function removeMemberDevices(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  identityPrefix: string,
  cursor: { seq: number },
  onSwept?: (messages: SyncedMessage[]) => void,
  engine: MlsEngine = mlsEngine,
): Promise<void> {
  await submitCommit(
    client,
    instanceId,
    groupId,
    engine,
    cursor,
    async () => {
      const commit = await engine.removeMembersByPrefix(instanceId, groupId, identityPrefix);
      return commit ? { commit, welcomes: [] } : null;
    },
    onSwept,
  );
}

/** Proactively rotate this device's own leaf key (an MLS self-update Commit) —
 * advances the epoch with no membership change, so a past compromise of this
 * device's key material stops yielding future plaintext (post-compromise
 * security). Distributed to the group like any other commit. Peer messages the
 * commit syncs sweep up are handed to `onSwept` as they arrive. */
export async function selfUpdateCommit(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  cursor: { seq: number },
  onSwept?: (messages: SyncedMessage[]) => void,
  engine: MlsEngine = mlsEngine,
): Promise<void> {
  await submitCommit(
    client,
    instanceId,
    groupId,
    engine,
    cursor,
    async () => {
      const commit = await engine.selfUpdate(instanceId, groupId);
      return { commit, welcomes: [] };
    },
    onSwept,
  );
}

/** Encrypt + submit an application message to a group. Claims our epoch so a
 * diverged/stale sender gets a 409 (surfaced as [`MlsDivergenceError`]) instead
 * of "successfully" appending frames nobody can decrypt. */
export async function sendAppMessage(
  client: ApiClient,
  instanceId: string,
  groupId: string,
  plaintext: string,
  engine: MlsEngine = mlsEngine,
): Promise<number> {
  const epoch = await engine.groupEpoch(instanceId, groupId);
  const frame = await engine.encryptApp(instanceId, groupId, plaintext);
  try {
    const { order_seq } = await client.mlsFrame(groupId, "application", frame, epoch);
    return order_seq;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new MlsDivergenceError(groupId);
    throw e;
  }
}
