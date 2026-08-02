/**
 * MlsEngine — the frontend surface of the native MLS (RFC 9420) engine.
 *
 * The actual cryptography runs in the Tauri-native Rust layer (OpenMLS, see
 * `src-tauri/src/mls.rs`): private keys and group ratchet state live there and
 * NEVER cross into JS. This module only marshals **opaque base64 frames** + the
 * conversation id across the Tauri IPC boundary. The Accord server links no MLS
 * library and stays a blind Delivery Service.
 *
 * Phase 3 · Lot 1 surface. The messaging layer wires these calls in Lot 4; here
 * they are just typed wrappers over the `mls_*` Tauri commands.
 */

import { isTauri } from "../isTauri";

/** All payloads are base64 unless noted; ids are plain strings. */
export interface MlsEngine {
  /** Create (or load, idempotent) this device's MLS identity for an instance.
   * `identity` binds the credential (e.g. "userId:deviceId"). Returns the base64
   * signature public key to publish to the Authentication Service. */
  initIdentity(instanceId: string, identity: string): Promise<string>;
  /** Build one KeyPackage (its private halves stay in Rust). Returns the public
   * bytes + its KeyPackageRef (the directory's single-use id), both base64. */
  generateKeyPackage(instanceId: string): Promise<GeneratedKeyPackage>;
  /** Create a new group whose id is the conversation id. */
  createGroup(instanceId: string, groupId: string): Promise<void>;
  /** Current epoch of a group — the value to send when submitting a Commit. */
  groupEpoch(instanceId: string, groupId: string): Promise<number>;
  /** Derive the 32-byte E2EE call media key (base64) from the group's MLS
   * exporter at its current epoch. Every member derives the same key. */
  exportCallKey(instanceId: string, groupId: string): Promise<string>;
  /** Apply this device's own staged commit — only after the DS accepted it. */
  mergePending(instanceId: string, groupId: string): Promise<void>;
  /** Discard this device's own staged commit — on a 409 (someone else won). */
  clearPending(instanceId: string, groupId: string): Promise<void>;
  /** Add a member from its published KeyPackage → { commit, welcome } (b64). */
  addMember(instanceId: string, groupId: string, keyPackage: string): Promise<AddResult>;
  /** Remove a member by leaf index → commit (b64). Advances the epoch (PCS). */
  removeMember(instanceId: string, groupId: string, leafIndex: number): Promise<string>;
  /** Remove EVERY leaf whose credential identity starts with `prefix` (e.g.
   * `"userId:"` drops all of a member's devices) → commit (b64), or null if the
   * prefix matched no current member. Advances the epoch (PCS). */
  removeMembersByPrefix(instanceId: string, groupId: string, prefix: string): Promise<string | null>;
  /** Rotate this device's own leaf key → commit (b64). */
  selfUpdate(instanceId: string, groupId: string): Promise<string>;
  /** Join a group from a Welcome (b64) → the joined group id. When
   * `groupIdHint` is given (the DS says which group the Welcome is for), any
   * divergent LOCAL group under that id is wiped first so the Welcome's state
   * fully replaces it (split-brain repair). */
  joinFromWelcome(instanceId: string, welcome: string, groupIdHint?: string): Promise<string>;
  /** Wipe this device's local state for one group (divergent-group repair).
   * The device identity survives; idempotent when the group is absent. */
  deleteGroup(instanceId: string, groupId: string): Promise<void>;
  /** Credential identities of the group's current leaves ("userId:deviceId") —
   * for comparing tree membership against the conversation's devices. */
  memberIdentities(instanceId: string, groupId: string): Promise<string[]>;
  /** Process an incoming handshake/application frame (b64). Returns the plaintext
   * for an application message, or null for a commit/proposal (which is applied). */
  process(instanceId: string, groupId: string, frame: string): Promise<string | null>;
  /** Encrypt an application message → one ciphertext frame (b64) for all members. */
  encryptApp(instanceId: string, groupId: string, plaintext: string): Promise<string>;
  /** Decrypt an application frame (b64) → plaintext. Throws if not decryptable. */
  decryptApp(instanceId: string, groupId: string, frame: string): Promise<string>;
}

export interface AddResult {
  commit: string;
  welcome: string;
}

export interface GeneratedKeyPackage {
  /** Opaque public KeyPackage bytes (base64) — publish as `key_package`. */
  keyPackage: string;
  /** KeyPackageRef (base64) — the directory's single-use identifier `kp_ref`. */
  kpRef: string;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    // MLS runs only in the native layer; browser-only dev has no engine.
    throw new Error("MLS engine unavailable: run the desktop app (tauri dev).");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** The Tauri-backed engine (the only implementation in L1). */
export const mlsEngine: MlsEngine = {
  initIdentity: (instanceId, identity) =>
    invoke<string>("mls_init_identity", { instanceId, identity }),
  generateKeyPackage: async (instanceId) => {
    const [keyPackage, kpRef] = await invoke<[string, string]>("mls_generate_key_package", {
      instanceId,
    });
    return { keyPackage, kpRef };
  },
  createGroup: (instanceId, groupId) =>
    invoke<void>("mls_create_group", { instanceId, groupId }),
  groupEpoch: (instanceId, groupId) =>
    invoke<number>("mls_group_epoch", { instanceId, groupId }),
  exportCallKey: (instanceId, groupId) =>
    invoke<string>("mls_export_call_key", { instanceId, groupId }),
  mergePending: (instanceId, groupId) =>
    invoke<void>("mls_merge_pending", { instanceId, groupId }),
  clearPending: (instanceId, groupId) =>
    invoke<void>("mls_clear_pending", { instanceId, groupId }),
  addMember: async (instanceId, groupId, keyPackage) => {
    const [commit, welcome] = await invoke<[string, string]>("mls_add_member", {
      instanceId,
      groupId,
      keyPackage,
    });
    return { commit, welcome };
  },
  removeMember: (instanceId, groupId, leafIndex) =>
    invoke<string>("mls_remove_member", { instanceId, groupId, leafIndex }),
  removeMembersByPrefix: (instanceId, groupId, prefix) =>
    invoke<string | null>("mls_remove_members_by_prefix", { instanceId, groupId, prefix }),
  selfUpdate: (instanceId, groupId) =>
    invoke<string>("mls_self_update", { instanceId, groupId }),
  joinFromWelcome: (instanceId, welcome, groupIdHint) =>
    invoke<string>("mls_join_from_welcome", {
      instanceId,
      welcome,
      groupIdHint: groupIdHint ?? null,
    }),
  deleteGroup: (instanceId, groupId) =>
    invoke<void>("mls_delete_group", { instanceId, groupId }),
  memberIdentities: (instanceId, groupId) =>
    invoke<string[]>("mls_member_identities", { instanceId, groupId }),
  process: (instanceId, groupId, frame) =>
    invoke<string | null>("mls_process", { instanceId, groupId, frame }),
  encryptApp: (instanceId, groupId, plaintext) =>
    invoke<string>("mls_encrypt_app", { instanceId, groupId, plaintext }),
  decryptApp: (instanceId, groupId, frame) =>
    invoke<string>("mls_decrypt_app", { instanceId, groupId, frame }),
};
