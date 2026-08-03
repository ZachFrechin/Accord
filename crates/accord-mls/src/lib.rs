//! MLS (RFC 9420) engine — Phase 3 · Lot 1.
//!
//! OpenMLS runs HERE, in the Tauri-native Rust layer, not in the webview. Private
//! keys (signature + HPKE) and the ratchet group state never cross into JS — the
//! frontend only ever exchanges opaque base64 handshake/application frames through
//! the Tauri commands in `lib.rs`. The Accord server links no MLS library and stays
//! a blind Delivery Service.
//!
//! This module is the L1 crypto core: identity, KeyPackages, group lifecycle
//! (create / add / remove / update / commit / welcome) and application
//! encrypt/decrypt, plus keychain-backed persistence of per-device state. The
//! wire/relay + ordering live in later lots.

pub mod secrets;
pub use secrets::{init_secret_store, MemorySecretStore, SecretStore};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use tls_codec::Deserialize as _;

/// Default ciphersuite — aligns the existing X25519/Ed25519 identity material.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}
fn unb64(s: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(s).map_err(|e| format!("base64: {e}"))
}
fn ser<T: tls_codec::Serialize>(v: &T) -> Result<Vec<u8>, String> {
    v.tls_serialize_detached()
        .map_err(|e| format!("tls_serialize: {e}"))
}

/// Group config — ratchet-tree extension ON so a Welcome carries the tree and a
/// joiner needs no side-channel to reconstruct group state. `max_past_epochs(2)`
/// keeps a short decryption window for application frames encrypted just before
/// someone else's commit landed (matches the server's MAX_FRAME_EPOCH_LAG) — a
/// bounded, standard forward-secrecy trade-off.
fn group_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .max_past_epochs(2)
        .build()
}

/// A device's MLS identity + its OpenMLS storage. One per (instance) = one MLS
/// leaf per device. All groups this device is in live inside `provider`'s storage.
pub struct Device {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    identity: Vec<u8>,
}

impl Device {
    /// Fresh identity: signature keypair (stored in the provider) + a BasicCredential
    /// bound to `identity` (e.g. "user_id:device_id").
    pub fn new(identity: &[u8]) -> Result<Self, String> {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(|e| format!("signature keypair: {e}"))?;
        signer
            .store(provider.storage())
            .map_err(|e| format!("store signer: {e:?}"))?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
            identity: identity.to_vec(),
        })
    }

    /// Public signature key (base64) — the AS attests its binding to the account.
    pub fn signature_public(&self) -> String {
        b64(self.signer.public())
    }

    /// Build a KeyPackage; its private halves are stored in the provider so this
    /// device can later join a group it was added to offline. Returns the public
    /// bytes plus the KeyPackageRef (the directory's single-use identifier).
    pub fn key_package(&self) -> Result<(Vec<u8>, Vec<u8>), String> {
        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(|e| format!("key package build: {e:?}"))?;
        let kp = bundle.key_package();
        let data = ser(kp)?;
        let kp_ref = kp
            .hash_ref(self.provider.crypto())
            .map_err(|e| format!("key package ref: {e:?}"))?;
        Ok((data, ser(&kp_ref)?))
    }

    /// Create a new MLS group whose group_id is the conversation id.
    ///
    /// Idempotent: if this device already holds a group under `group_id` (e.g. it
    /// joined via a peer's Welcome, or MLS is being re-enabled on a conversation
    /// after a toggle-off), keep the existing group instead of erroring with
    /// "group already exists" — the ratchet state and membership stay intact.
    pub fn create_group(&self, group_id: &[u8]) -> Result<(), String> {
        if MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(|e| format!("load group: {e:?}"))?
            .is_some()
        {
            return Ok(());
        }
        MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &group_config(),
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .map_err(|e| format!("create group: {e:?}"))?;
        Ok(())
    }

    fn load_group(&self, group_id: &[u8]) -> Result<MlsGroup, String> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(|e| format!("load group: {e:?}"))?
            .ok_or_else(|| "group not found in storage".to_string())
    }

    /// Wipe this device's local state for one group — the divergent-group repair
    /// primitive. The device identity (signature keypair) is untouched, so the
    /// device can immediately be re-added to the real group via a fresh Welcome.
    /// Idempotent: deleting an absent group is Ok.
    pub fn delete_group(&self, group_id: &[u8]) -> Result<(), String> {
        match MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(|e| format!("load group: {e:?}"))?
        {
            Some(mut group) => group
                .delete(self.provider.storage())
                .map_err(|e| format!("delete group: {e:?}")),
            None => Ok(()),
        }
    }

    /// Credential identities of the group's current leaves (e.g.
    /// "user_id:device_id") — lets the client compare tree membership against
    /// the conversation's expected devices and add the missing ones.
    pub fn member_identities(&self, group_id: &[u8]) -> Result<Vec<String>, String> {
        let group = self.load_group(group_id)?;
        Ok(group
            .members()
            .filter_map(|m| BasicCredential::try_from(m.credential.clone()).ok())
            .map(|bc| String::from_utf8_lossy(bc.identity()).into_owned())
            .collect())
    }

    /// Stage an Add of a device (from its published KeyPackage) → (commit, welcome).
    /// The commit is NOT merged locally: the caller submits it to the Delivery
    /// Service and calls `merge_pending` once the DS accepts it (RFC 9750), or
    /// `clear_pending` + rebase on a 409. The new device joins from the welcome.
    pub fn add_member(
        &self,
        group_id: &[u8],
        key_package: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>), String> {
        let kp_in = KeyPackageIn::tls_deserialize_exact(key_package)
            .map_err(|e| format!("kp decode: {e}"))?;
        let kp = kp_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| format!("kp validate: {e:?}"))?;
        let mut group = self.load_group(group_id)?;
        let (commit, welcome, _group_info) = group
            .add_members(&self.provider, &self.signer, &[kp])
            .map_err(|e| format!("add_members: {e:?}"))?;
        Ok((ser(&commit)?, ser(&welcome)?))
    }

    /// Stage a Remove of a device by leaf index → the commit. Not merged until the
    /// DS accepts it; on merge it advances the epoch, rekeying so the removed
    /// device cannot read subsequent messages (PCS).
    pub fn remove_member(&self, group_id: &[u8], leaf_index: u32) -> Result<Vec<u8>, String> {
        let mut group = self.load_group(group_id)?;
        let (commit, _welcome, _group_info) = group
            .remove_members(
                &self.provider,
                &self.signer,
                &[LeafNodeIndex::new(leaf_index)],
            )
            .map_err(|e| format!("remove_members: {e:?}"))?;
        ser(&commit)
    }

    /// Stage a Remove of EVERY leaf whose credential identity starts with `prefix`
    /// (e.g. `b"user_id:"` removes all of a member's devices in a single commit) →
    /// the commit, or None if the prefix matches no current member. Rekeys the epoch
    /// on merge, so the removed devices cannot read subsequent messages (PCS).
    pub fn remove_members_by_prefix(
        &self,
        group_id: &[u8],
        prefix: &[u8],
    ) -> Result<Option<Vec<u8>>, String> {
        let mut group = self.load_group(group_id)?;
        let targets: Vec<LeafNodeIndex> = group
            .members()
            .filter(|m| {
                BasicCredential::try_from(m.credential.clone())
                    .map(|bc| bc.identity().starts_with(prefix))
                    .unwrap_or(false)
            })
            .map(|m| m.index)
            .collect();
        if targets.is_empty() {
            return Ok(None);
        }
        let (commit, _welcome, _group_info) = group
            .remove_members(&self.provider, &self.signer, &targets)
            .map_err(|e| format!("remove_members: {e:?}"))?;
        Ok(Some(ser(&commit)?))
    }

    /// Stage a rotation of this device's own leaf key (PCS heartbeat) → the commit.
    /// Not merged until the DS accepts it.
    pub fn self_update(&self, group_id: &[u8]) -> Result<Vec<u8>, String> {
        let mut group = self.load_group(group_id)?;
        let commit = group
            .self_update(&self.provider, &self.signer, LeafNodeParameters::default())
            .map_err(|e| format!("self_update: {e:?}"))?;
        ser(&commit.into_commit())
    }

    /// Apply this device's own staged commit — ONLY after the Delivery Service
    /// echoes it back as the canonical epoch transition.
    pub fn merge_pending(&self, group_id: &[u8]) -> Result<(), String> {
        let mut group = self.load_group(group_id)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|e| format!("merge pending: {e:?}"))
    }

    /// Discard this device's own staged commit — on a 409 (another commit won the
    /// epoch); then process the winner and rebuild.
    pub fn clear_pending(&self, group_id: &[u8]) -> Result<(), String> {
        let mut group = self.load_group(group_id)?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(|e| format!("clear pending: {e:?}"))
    }

    /// Join a group from a Welcome (added offline). Returns the group id.
    ///
    /// `replace_group`: when the caller knows which group this Welcome is for
    /// (the Delivery Service tells it), any existing LOCAL group under that id
    /// is deleted first. A divergent group (split-brain) would otherwise only be
    /// partially overwritten by the join — stale pending proposals and epoch
    /// keys would survive as poison. The Welcome's own decryption keys are
    /// keyed by KeyPackage, not group id, so they are unaffected.
    pub fn join_from_welcome(
        &self,
        welcome: &[u8],
        replace_group: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        if let Some(group_id) = replace_group {
            self.delete_group(group_id)?;
        }
        let msg = MlsMessageIn::tls_deserialize_exact(welcome)
            .map_err(|e| format!("welcome decode: {e}"))?;
        let welcome = match msg.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err("not a welcome message".to_string()),
        };
        let staged = StagedWelcome::new_from_welcome(
            &self.provider,
            group_config().join_config(),
            welcome,
            None,
        )
        .map_err(|e| format!("staged welcome: {e:?}"))?;
        let group = staged
            .into_group(&self.provider)
            .map_err(|e| format!("join group: {e:?}"))?;
        Ok(group.group_id().as_slice().to_vec())
    }

    /// Process an incoming handshake or application frame. Returns Some(plaintext)
    /// for an application message, None for a commit/proposal (which is applied).
    pub fn process(&self, group_id: &[u8], frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let msg =
            MlsMessageIn::tls_deserialize_exact(frame).map_err(|e| format!("frame decode: {e}"))?;
        let protocol = msg
            .try_into_protocol_message()
            .map_err(|e| format!("not a protocol message: {e:?}"))?;
        let mut group = self.load_group(group_id)?;
        let processed = match group.process_message(&self.provider, protocol) {
            Ok(processed) => processed,
            Err(e) => {
                let detail = format!("{e:?}");
                // Our own frames come back in the ordered log; OpenMLS refuses
                // to decrypt them. That is a legitimate skip — NOT a failure —
                // so callers can treat every remaining error as real.
                if detail.contains("CannotDecryptOwnMessage") {
                    return Ok(None);
                }
                return Err(format!("process_message: {detail}"));
            }
        };
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => Ok(Some(app.into_bytes())),
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                group
                    .merge_staged_commit(&self.provider, *staged)
                    .map_err(|e| format!("merge staged commit: {e:?}"))?;
                Ok(None)
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(|e| format!("store proposal: {e:?}"))?;
                Ok(None)
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(_) => Ok(None),
        }
    }

    /// Encrypt an application message under the group's current epoch → one
    /// ciphertext for all members (no per-recipient fan-out).
    pub fn encrypt_app(&self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let mut group = self.load_group(group_id)?;
        let out = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|e| format!("create_message: {e:?}"))?;
        ser(&out)
    }

    /// Decrypt an application message; errors if the frame is not decryptable
    /// (wrong epoch, removed member, tampering).
    pub fn decrypt_app(&self, group_id: &[u8], frame: &[u8]) -> Result<Vec<u8>, String> {
        match self.process(group_id, frame)? {
            Some(plaintext) => Ok(plaintext),
            None => Err("frame was not an application message".to_string()),
        }
    }

    /// Current epoch of a group — the value to claim when submitting a Commit to
    /// the Delivery Service (the server's CAS rejects a stale one with 409).
    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, String> {
        Ok(self.load_group(group_id)?.epoch().as_u64())
    }

    /// Derive a 32-byte media key for E2EE calls from the group's MLS exporter
    /// secret (label `accord/call`). Every member at the same epoch derives the
    /// identical key, so the SFU can relay AES-GCM-encrypted media it cannot read
    /// — the same server-blind invariant as messages. The key rotates whenever
    /// the epoch advances (a member joins/leaves), so callers re-export on change.
    pub fn export_call_key(&self, group_id: &[u8]) -> Result<Vec<u8>, String> {
        let group = self.load_group(group_id)?;
        group
            .export_secret(self.provider.crypto(), "accord/call", &[], 32)
            .map_err(|e| format!("export_secret: {e:?}"))
    }

    /// Serialize the entire device state (all group ratchet state + the signer,
    /// which lives in the provider storage) to a JSON snapshot for durable
    /// persistence. Contains SECRETS — only ever stored in the OS keychain.
    pub fn snapshot(&self) -> Result<String, String> {
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| "storage lock poisoned".to_string())?;
        let storage: HashMap<String, String> =
            values.iter().map(|(k, v)| (b64(k), b64(v))).collect();
        let snap = DeviceSnapshot {
            storage,
            identity: b64(&self.identity),
            signature_public: b64(self.signer.public()),
        };
        serde_json::to_string(&snap).map_err(|e| format!("snapshot encode: {e}"))
    }

    /// Rebuild a device from a snapshot (after a process restart). Reloads the
    /// signer from the restored storage so groups remain usable.
    pub fn restore(snapshot: &str) -> Result<Self, String> {
        let snap: DeviceSnapshot =
            serde_json::from_str(snapshot).map_err(|e| format!("snapshot decode: {e}"))?;
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| "storage lock poisoned".to_string())?;
            for (k, v) in &snap.storage {
                values.insert(unb64(k)?, unb64(v)?);
            }
        }
        let signature_public = unb64(&snap.signature_public)?;
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &signature_public,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or_else(|| "signer not found in restored storage".to_string())?;
        let identity = unb64(&snap.identity)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.clone()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
            identity,
        })
    }
}

/// Persisted device state (secrets — keychain only).
#[derive(serde::Serialize, serde::Deserialize)]
struct DeviceSnapshot {
    /// OpenMLS storage key→value map (b64), holding the signer + all group state.
    storage: HashMap<String, String>,
    identity: String,
    signature_public: String,
}

// =============================================================================
// Command layer — in-process registry + OS-keychain persistence. The Tauri
// commands in lib.rs are thin wrappers over these. Secrets stay in the keychain
// (same store family as secure_*_device_key); JS only ever sees base64 frames.
// =============================================================================

/// Legacy keychain service that once held the WHOLE snapshot. Kept only so a
/// device that upgraded from that build migrates its state to the file format
/// (see [`migrate_legacy_keychain`]) — never written to any more.
const MLS_STATE_SERVICE: &str = "app.accord.desktop.mls-state";
/// Keychain service for the small (32-byte) key that wraps the on-disk state.
/// Small enough for every OS secret store — unlike the full snapshot, which
/// overflows the Windows Credential Manager blob limit (the bug this fixes).
const MLS_KEY_SERVICE: &str = "app.accord.desktop.mls-key";

static REGISTRY: OnceLock<Mutex<HashMap<String, Device>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Device>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// App-local data directory, set once at startup from Tauri's `app_local_data_dir`.
/// Encrypted MLS state files live under `<dir>/mls-state/`.
static STORAGE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Wire the on-disk state directory. Called once from the Tauri setup hook; the
/// first value wins, later calls are ignored.
pub fn init_storage_dir(dir: PathBuf) {
    let _ = STORAGE_DIR.set(dir);
}

fn state_dir() -> Result<PathBuf, String> {
    let base = STORAGE_DIR
        .get()
        .ok_or_else(|| "mls storage dir not initialized".to_string())?;
    let dir = base.join("mls-state");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create mls state dir: {e}"))?;
    Ok(dir)
}

/// Path of an instance's encrypted state file. The instance id is app-generated
/// (`inst_<hash>`); still, sanitize defensively so it can only ever be a filename.
fn state_path(instance_id: &str) -> Result<PathBuf, String> {
    let safe: String = instance_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(state_dir()?.join(format!("{safe}.bin")))
}

/// Load (or mint) the instance's 32-byte data-encryption key from the host's
/// secret store (OS keychain on desktop, Android Keystore on mobile).
fn load_or_create_dek(instance_id: &str) -> Result<[u8; 32], String> {
    let store = secrets::secret_store()?;
    match store.get(MLS_KEY_SERVICE, instance_id)? {
        Some(b64_key) => unb64(&b64_key)?
            .try_into()
            .map_err(|_| "mls key: unexpected length".to_string()),
        None => {
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key).map_err(|e| format!("rng: {e}"))?;
            store.set(MLS_KEY_SERVICE, instance_id, &b64(&key))?;
            Ok(key)
        }
    }
}

fn cipher_for(instance_id: &str) -> Result<XChaCha20Poly1305, String> {
    let dek = load_or_create_dek(instance_id)?;
    Ok(XChaCha20Poly1305::new(Key::from_slice(&dek)))
}

/// Encrypt `plaintext` with the instance DEK and write it atomically to the state
/// file (`24-byte XNonce ‖ ciphertext`).
fn write_encrypted(instance_id: &str, plaintext: &str) -> Result<(), String> {
    let cipher = cipher_for(instance_id)?;
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("rng: {e}"))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|_| "mls state encrypt failed".to_string())?;
    let mut out = Vec::with_capacity(nonce.len() + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);

    let path = state_path(instance_id)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &out).map_err(|e| format!("write mls state: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("commit mls state: {e}"))?;
    Ok(())
}

fn persist(instance_id: &str, device: &Device) -> Result<(), String> {
    write_encrypted(instance_id, &device.snapshot()?)
}

/// Read + decrypt the instance's persisted snapshot, or `None` when there is
/// none. Transparently migrates a legacy keychain snapshot on first load.
fn load_snapshot(instance_id: &str) -> Result<Option<String>, String> {
    let path = state_path(instance_id)?;
    match std::fs::read(&path) {
        Ok(data) => {
            if data.len() < 24 {
                return Err("mls state file truncated".to_string());
            }
            let cipher = cipher_for(instance_id)?;
            let (nonce, ciphertext) = data.split_at(24);
            let plaintext = cipher
                .decrypt(XNonce::from_slice(nonce), ciphertext)
                .map_err(|_| "mls state decrypt failed".to_string())?;
            Ok(Some(
                String::from_utf8(plaintext).map_err(|e| format!("mls state utf8: {e}"))?,
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => migrate_legacy_keychain(instance_id),
        Err(e) => Err(format!("read mls state: {e}")),
    }
}

/// One-time migration for devices upgraded from the build that stored the whole
/// snapshot in the keychain: re-persist it to the encrypted file and drop the
/// legacy entry. Returns the migrated snapshot, or `None` if there is nothing.
fn migrate_legacy_keychain(instance_id: &str) -> Result<Option<String>, String> {
    let store = secrets::secret_store()?;
    match store.get(MLS_STATE_SERVICE, instance_id)? {
        Some(snapshot) => {
            write_encrypted(instance_id, &snapshot)?;
            let _ = store.delete(MLS_STATE_SERVICE, instance_id);
            Ok(Some(snapshot))
        }
        None => Ok(None),
    }
}

/// Run `f` against the device for `instance_id` (loaded from the registry, else
/// restored from disk), then re-persist (any op may mutate ratchet state).
/// All `Device` methods take `&self` (interior mutability via the provider), so a
/// shared borrow is enough.
fn with_device<T>(
    instance_id: &str,
    f: impl FnOnce(&Device) -> Result<T, String>,
) -> Result<T, String> {
    let mut reg = registry()
        .lock()
        .map_err(|_| "mls registry poisoned".to_string())?;
    if !reg.contains_key(instance_id) {
        match load_snapshot(instance_id)? {
            Some(snap) => {
                reg.insert(instance_id.to_string(), Device::restore(&snap)?);
            }
            None => return Err("mls identity not initialized".to_string()),
        }
    }
    let device = reg.get(instance_id).expect("device present after load");
    let out = f(device)?;
    persist(instance_id, device)?;
    Ok(out)
}

/// Create (or load, idempotent) this device's MLS identity. Returns its base64
/// signature public key (the AS attests its binding to the account).
pub fn cmd_init_identity(instance_id: &str, identity: &str) -> Result<String, String> {
    let mut reg = registry()
        .lock()
        .map_err(|_| "mls registry poisoned".to_string())?;
    if let Some(snap) = load_snapshot(instance_id)? {
        let device = Device::restore(&snap)?;
        let public = device.signature_public();
        reg.insert(instance_id.to_string(), device);
        return Ok(public);
    }
    let device = Device::new(identity.as_bytes())?;
    let public = device.signature_public();
    persist(instance_id, &device)?;
    reg.insert(instance_id.to_string(), device);
    Ok(public)
}

pub fn cmd_generate_key_package(instance_id: &str) -> Result<(String, String), String> {
    with_device(instance_id, |d| {
        let (data, kp_ref) = d.key_package()?;
        Ok((b64(&data), b64(&kp_ref)))
    })
}
pub fn cmd_create_group(instance_id: &str, group_id: &str) -> Result<(), String> {
    with_device(instance_id, |d| d.create_group(group_id.as_bytes()))
}
pub fn cmd_group_epoch(instance_id: &str, group_id: &str) -> Result<u64, String> {
    with_device(instance_id, |d| d.epoch(group_id.as_bytes()))
}
/// Base64 of the 32-byte E2EE call key derived from the group's MLS exporter.
pub fn cmd_export_call_key(instance_id: &str, group_id: &str) -> Result<String, String> {
    with_device(instance_id, |d| {
        d.export_call_key(group_id.as_bytes()).map(|k| b64(&k))
    })
}
pub fn cmd_merge_pending(instance_id: &str, group_id: &str) -> Result<(), String> {
    with_device(instance_id, |d| d.merge_pending(group_id.as_bytes()))
}
pub fn cmd_clear_pending(instance_id: &str, group_id: &str) -> Result<(), String> {
    with_device(instance_id, |d| d.clear_pending(group_id.as_bytes()))
}
pub fn cmd_add_member(
    instance_id: &str,
    group_id: &str,
    key_package_b64: &str,
) -> Result<(String, String), String> {
    let kp = unb64(key_package_b64)?;
    with_device(instance_id, |d| {
        let (commit, welcome) = d.add_member(group_id.as_bytes(), &kp)?;
        Ok((b64(&commit), b64(&welcome)))
    })
}
pub fn cmd_remove_member(
    instance_id: &str,
    group_id: &str,
    leaf_index: u32,
) -> Result<String, String> {
    with_device(instance_id, |d| {
        d.remove_member(group_id.as_bytes(), leaf_index)
            .map(|c| b64(&c))
    })
}

pub fn cmd_remove_members_by_prefix(
    instance_id: &str,
    group_id: &str,
    prefix: &str,
) -> Result<Option<String>, String> {
    with_device(instance_id, |d| {
        d.remove_members_by_prefix(group_id.as_bytes(), prefix.as_bytes())
            .map(|opt| opt.map(|c| b64(&c)))
    })
}
pub fn cmd_self_update(instance_id: &str, group_id: &str) -> Result<String, String> {
    with_device(instance_id, |d| {
        d.self_update(group_id.as_bytes()).map(|c| b64(&c))
    })
}
/// `group_id_hint`: the group this Welcome is for (the DS knows) — any divergent
/// local group under that id is wiped before joining, so the Welcome's state
/// fully replaces it instead of overlaying poisoned leftovers.
pub fn cmd_join_from_welcome(
    instance_id: &str,
    welcome_b64: &str,
    group_id_hint: Option<&str>,
) -> Result<String, String> {
    let welcome = unb64(welcome_b64)?;
    with_device(instance_id, |d| {
        d.join_from_welcome(&welcome, group_id_hint.map(str::as_bytes))
            .map(|gid| String::from_utf8_lossy(&gid).into_owned())
    })
}
pub fn cmd_delete_group(instance_id: &str, group_id: &str) -> Result<(), String> {
    with_device(instance_id, |d| d.delete_group(group_id.as_bytes()))
}
pub fn cmd_member_identities(instance_id: &str, group_id: &str) -> Result<Vec<String>, String> {
    with_device(instance_id, |d| d.member_identities(group_id.as_bytes()))
}
pub fn cmd_process(
    instance_id: &str,
    group_id: &str,
    frame_b64: &str,
) -> Result<Option<String>, String> {
    let frame = unb64(frame_b64)?;
    with_device(instance_id, |d| {
        d.process(group_id.as_bytes(), &frame)
            .map(|opt| opt.map(|pt| String::from_utf8_lossy(&pt).into_owned()))
    })
}
pub fn cmd_encrypt_app(
    instance_id: &str,
    group_id: &str,
    plaintext: &str,
) -> Result<String, String> {
    with_device(instance_id, |d| {
        d.encrypt_app(group_id.as_bytes(), plaintext.as_bytes())
            .map(|c| b64(&c))
    })
}
pub fn cmd_decrypt_app(
    instance_id: &str,
    group_id: &str,
    frame_b64: &str,
) -> Result<String, String> {
    let frame = unb64(frame_b64)?;
    with_device(instance_id, |d| {
        d.decrypt_app(group_id.as_bytes(), &frame)
            .map(|pt| String::from_utf8_lossy(&pt).into_owned())
    })
}

// =============================================================================
// Tests — pure in-memory, no OS keychain. Prove the L1 acceptance criteria.
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    const GID: &[u8] = b"conversation-uuid-1";

    #[test]
    fn round_trip_two_devices() {
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();

        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_commit, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap(); // DS accepted → apply our own commit
        let joined = bob.join_from_welcome(&welcome, None).unwrap();
        assert_eq!(joined, GID, "bob joined the same group id");

        // Alice → Bob
        let ct = alice.encrypt_app(GID, b"hi bob").unwrap();
        let pt = bob.decrypt_app(GID, &ct).unwrap();
        assert_eq!(pt, b"hi bob");

        // Bob → Alice
        let ct = bob.encrypt_app(GID, b"hi alice").unwrap();
        let pt = alice.decrypt_app(GID, &ct).unwrap();
        assert_eq!(pt, b"hi alice");
    }

    #[test]
    fn create_group_is_idempotent() {
        // Re-enabling MLS on a conversation re-calls create_group on a group we
        // already hold; it must succeed (not "already exists") and keep the state.
        let alice = Device::new(b"alice:dev1").unwrap();
        alice.create_group(GID).unwrap();
        // Second create on the same id must be a no-op (not error).
        alice.create_group(GID).unwrap();

        // The group is intact and usable: add Bob and exchange a message.
        let bob = Device::new(b"bob:dev1").unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_commit, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap();
        bob.join_from_welcome(&welcome, None).unwrap();

        // Redundant create after membership exists must still be a no-op.
        alice.create_group(GID).unwrap();
        let ct = alice.encrypt_app(GID, b"still works").unwrap();
        assert_eq!(bob.decrypt_app(GID, &ct).unwrap(), b"still works");
    }

    #[test]
    fn delete_group_wipes_state_and_is_idempotent() {
        let alice = Device::new(b"alice:dev1").unwrap();
        alice.create_group(GID).unwrap();
        alice.delete_group(GID).unwrap();
        assert!(alice.epoch(GID).is_err(), "state must be gone after delete");
        alice.delete_group(GID).unwrap(); // absent → still Ok
                                          // A fresh create after a wipe starts over at epoch 0.
        alice.create_group(GID).unwrap();
        assert_eq!(alice.epoch(GID).unwrap(), 0);
    }

    #[test]
    fn join_over_divergent_group_replaces_it() {
        // The split-brain repair: bob forked his own group under the same id;
        // joining Alice's real group via a Welcome (with the group-id hint) must
        // fully replace the divergent state and leave a working member.
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();

        bob.create_group(GID).unwrap(); // bob's divergent fork (epoch 0)
        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_commit, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap();

        let joined = bob.join_from_welcome(&welcome, Some(GID)).unwrap();
        assert_eq!(joined, GID);
        assert_eq!(bob.epoch(GID).unwrap(), alice.epoch(GID).unwrap());

        let ct = alice.encrypt_app(GID, b"after repair").unwrap();
        assert_eq!(bob.decrypt_app(GID, &ct).unwrap(), b"after repair");
        let ct = bob.encrypt_app(GID, b"and back").unwrap();
        assert_eq!(alice.decrypt_app(GID, &ct).unwrap(), b"and back");
    }

    #[test]
    fn own_application_frame_processes_as_none() {
        // A device's own frames come back in the ordered log; process() must
        // report them as a benign skip (None), not an error — so real failures
        // (foreign-group frames) become detectable upstream.
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();
        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_c, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap();
        bob.join_from_welcome(&welcome, None).unwrap();

        let ct = alice.encrypt_app(GID, b"hello").unwrap();
        assert_eq!(
            alice.process(GID, &ct).unwrap(),
            None,
            "own frame → benign skip"
        );
        assert_eq!(bob.decrypt_app(GID, &ct).unwrap(), b"hello");
    }

    #[test]
    fn past_epoch_frame_still_decrypts_within_window() {
        // A message encrypted just before someone else's commit lands must still
        // decrypt (max_past_epochs window) — otherwise every commit races away
        // legitimate in-flight messages.
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();
        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_c, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap();
        bob.join_from_welcome(&welcome, None).unwrap();

        // Bob encrypts at epoch N…
        let in_flight = bob.encrypt_app(GID, b"racing the commit").unwrap();
        // …then Alice's self-update advances the group to N+1 on both sides.
        let commit = alice.self_update(GID).unwrap();
        alice.merge_pending(GID).unwrap();
        bob.process(GID, &commit).unwrap();
        // Alice must still decrypt the older-epoch frame.
        assert_eq!(
            alice.decrypt_app(GID, &in_flight).unwrap(),
            b"racing the commit"
        );
    }

    #[test]
    fn call_key_is_shared_across_members_and_rotates_on_epoch() {
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();

        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_commit, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap();
        bob.join_from_welcome(&welcome, None).unwrap();

        // Both members at the same epoch derive the IDENTICAL 32-byte media key —
        // the property that lets the SFU relay E2EE frames it cannot read.
        let ka = alice.export_call_key(GID).unwrap();
        let kb = bob.export_call_key(GID).unwrap();
        assert_eq!(ka.len(), 32, "call key is 32 bytes");
        assert_eq!(ka, kb, "all members derive the same call key");

        // A different group id yields a different key (keys are group-scoped).
        alice.create_group(b"other-conversation").unwrap();
        assert_ne!(
            ka,
            alice.export_call_key(b"other-conversation").unwrap(),
            "call key is bound to the group"
        );

        // Removing bob advances the epoch → the key must rotate (forward secrecy).
        let _ = alice.remove_member(GID, 1).unwrap();
        alice.merge_pending(GID).unwrap();
        assert_ne!(
            ka,
            alice.export_call_key(GID).unwrap(),
            "call key rotates when the epoch advances"
        );
    }

    #[test]
    fn post_compromise_removed_device_cannot_read() {
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();

        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_commit, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap(); // DS accepted → apply our own commit
        bob.join_from_welcome(&welcome, None).unwrap();

        // Sanity: bob can read at this epoch.
        let ct = alice.encrypt_app(GID, b"before removal").unwrap();
        assert_eq!(bob.decrypt_app(GID, &ct).unwrap(), b"before removal");

        // Alice removes bob (leaf 1) → epoch advances, group rekeys.
        let _remove_commit = alice.remove_member(GID, 1).unwrap();
        alice.merge_pending(GID).unwrap();

        // Alice sends in the NEW epoch; bob (retaining all his old state) must NOT
        // be able to decrypt it — that is post-compromise security.
        let ct_after = alice.encrypt_app(GID, b"after removal").unwrap();
        assert!(
            bob.decrypt_app(GID, &ct_after).is_err(),
            "removed device must not decrypt post-removal messages"
        );
    }

    #[test]
    fn state_survives_snapshot_restore() {
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();

        alice.create_group(GID).unwrap();
        let bob_kp = bob.key_package().unwrap().0;
        let (_commit, welcome) = alice.add_member(GID, &bob_kp).unwrap();
        alice.merge_pending(GID).unwrap(); // DS accepted → apply our own commit
        bob.join_from_welcome(&welcome, None).unwrap();

        // Snapshot bob, drop him entirely, rebuild from the serialized bytes.
        let snap = bob.snapshot().unwrap();
        drop(bob);
        let bob_restored = Device::restore(&snap).unwrap();

        // A message sent AFTER restore is still decryptable — group state (ratchet
        // tree + signer) survived the round-trip.
        let ct = alice.encrypt_app(GID, b"after restore").unwrap();
        assert_eq!(
            bob_restored.decrypt_app(GID, &ct).unwrap(),
            b"after restore"
        );
    }

    #[test]
    fn deferred_merge_rebases_after_conflict() {
        let alice = Device::new(b"alice:d").unwrap();
        let bob = Device::new(b"bob:d").unwrap();
        let carol = Device::new(b"carol:d").unwrap();

        alice.create_group(GID).unwrap();
        let (_c, welcome) = alice
            .add_member(GID, &bob.key_package().unwrap().0)
            .unwrap();
        alice.merge_pending(GID).unwrap();
        bob.join_from_welcome(&welcome, None).unwrap();
        // Alice + Bob both at epoch 1.

        // Alice STAGES adding Carol but does not merge (awaiting the DS).
        let carol_kp = carol.key_package().unwrap().0;
        let (_stale_commit, _stale_welcome) = alice.add_member(GID, &carol_kp).unwrap();

        // Concurrently, Bob's self-update Commit wins the epoch at the DS.
        let bob_commit = bob.self_update(GID).unwrap();
        bob.merge_pending(GID).unwrap();

        // Alice's add lost the race (409): discard it, apply Bob's winning Commit,
        // then rebuild the add on the new epoch.
        alice.clear_pending(GID).unwrap();
        assert!(alice.process(GID, &bob_commit).unwrap().is_none());
        let (readd_commit, welcome2) = alice.add_member(GID, &carol_kp).unwrap();
        alice.merge_pending(GID).unwrap();

        // Bob applies Alice's (accepted) re-add; Carol joins from the new welcome.
        assert!(bob.process(GID, &readd_commit).unwrap().is_none());
        carol.join_from_welcome(&welcome2, None).unwrap();

        // All three converge on the same epoch secret.
        let ct = alice.encrypt_app(GID, b"hi all").unwrap();
        assert_eq!(bob.decrypt_app(GID, &ct).unwrap(), b"hi all");
        assert_eq!(carol.decrypt_app(GID, &ct).unwrap(), b"hi all");
    }

    #[test]
    fn remove_by_prefix_revokes_all_of_a_members_devices() {
        let alice = Device::new(b"alice:d1").unwrap();
        let bob1 = Device::new(b"bob:d1").unwrap();
        let bob2 = Device::new(b"bob:d2").unwrap();

        alice.create_group(GID).unwrap();
        let (_c, w1) = alice
            .add_member(GID, &bob1.key_package().unwrap().0)
            .unwrap();
        alice.merge_pending(GID).unwrap();
        bob1.join_from_welcome(&w1, None).unwrap();
        // Add Bob's second device; the existing member (bob1) applies that commit.
        let (c2, w2) = alice
            .add_member(GID, &bob2.key_package().unwrap().0)
            .unwrap();
        alice.merge_pending(GID).unwrap();
        assert!(bob1.process(GID, &c2).unwrap().is_none());
        bob2.join_from_welcome(&w2, None).unwrap();

        // Sanity: both of Bob's devices can read at the current epoch.
        let ct = alice.encrypt_app(GID, b"before").unwrap();
        assert_eq!(bob1.decrypt_app(GID, &ct).unwrap(), b"before");
        assert_eq!(bob2.decrypt_app(GID, &ct).unwrap(), b"before");

        // Remove the whole member by identity prefix — one commit drops BOTH leaves.
        let commit = alice
            .remove_members_by_prefix(GID, b"bob:")
            .unwrap()
            .expect("prefix matched Bob's devices");
        alice.merge_pending(GID).unwrap();

        // After the rekey, neither of Bob's devices can read (PCS), and the prefix
        // now matches nobody.
        let ct_after = alice.encrypt_app(GID, b"after").unwrap();
        assert!(bob1.decrypt_app(GID, &ct_after).is_err());
        assert!(bob2.decrypt_app(GID, &ct_after).is_err());
        assert!(alice
            .remove_members_by_prefix(GID, b"bob:")
            .unwrap()
            .is_none());
        // The commit we produced is a real handshake frame (opaque).
        assert!(!commit.is_empty());
    }

    #[test]
    fn self_update_rekeys_epoch_without_changing_membership() {
        // The proactive PCS heartbeat: a member rotates their own leaf key with no
        // add/remove. The epoch must advance, the group secret must rotate, and both
        // members must stay in sync — so a past key compromise stops paying off.
        let alice = Device::new(b"alice:dev1").unwrap();
        let bob = Device::new(b"bob:dev1").unwrap();

        alice.create_group(GID).unwrap();
        let (_c, welcome) = alice
            .add_member(GID, &bob.key_package().unwrap().0)
            .unwrap();
        alice.merge_pending(GID).unwrap();
        bob.join_from_welcome(&welcome, None).unwrap();

        let epoch_before = alice.epoch(GID).unwrap();
        let secret_before = alice.export_call_key(GID).unwrap();

        // Alice self-updates; Bob applies her commit and follows to the new epoch.
        let commit = alice.self_update(GID).unwrap();
        alice.merge_pending(GID).unwrap();
        assert!(
            bob.process(GID, &commit).unwrap().is_none(),
            "a self-update is a handshake frame, not application plaintext"
        );

        // The epoch advanced and its secret rotated (forward secrecy / PCS).
        assert!(
            alice.epoch(GID).unwrap() > epoch_before,
            "self-update advances the epoch"
        );
        assert_ne!(
            secret_before,
            alice.export_call_key(GID).unwrap(),
            "the epoch secret rotates on a self-update"
        );

        // Membership is unchanged: both members still share one live epoch secret
        // and can still exchange application messages.
        assert_eq!(
            alice.export_call_key(GID).unwrap(),
            bob.export_call_key(GID).unwrap(),
            "both members converge on the new epoch secret"
        );
        let ct = bob.encrypt_app(GID, b"still here").unwrap();
        assert_eq!(alice.decrypt_app(GID, &ct).unwrap(), b"still here");
    }
}

// =============================================================================
// End-to-end test — two REAL devices through the LIVE backend Delivery Service.
//
// Proves the whole Phase 3 pipeline as the app runs it (crypto + HTTP + DS +
// Postgres), not just the in-process crypto above. Ignored by default; it needs
// the dev stack up. Run it with:
//
//     ACCORD_E2E=1 cargo test --lib --ignored mls_e2e -- --nocapture
//
// Requires: backend on :8090, the `sqlxpg` Postgres container (for one activation
// UPDATE, since login is gated on a verified email), and Redis/NATS reachable.
// =============================================================================
#[cfg(test)]
mod e2e {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use reqwest::blocking::Client;
    use serde_json::{json, Value};

    fn base() -> String {
        std::env::var("ACCORD_BACKEND").unwrap_or_else(|_| "http://localhost:8090".to_string())
    }

    /// A distinct suffix per run so re-runs don't collide on username/email.
    fn suffix() -> String {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{}", n % 100_000_000)
    }

    fn post(c: &Client, url: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = c.post(url).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let r = req.send().expect("request send");
        let status = r.status().as_u16();
        let v: Value = r.json().unwrap_or(Value::Null);
        (status, v)
    }

    fn get(c: &Client, url: &str, token: &str) -> (u16, Value) {
        let r = c.get(url).bearer_auth(token).send().expect("request send");
        let status = r.status().as_u16();
        let v: Value = r.json().unwrap_or(Value::Null);
        (status, v)
    }

    /// `sub` claim (= user id) out of a JWT access token, without verifying it.
    fn jwt_sub(token: &str) -> String {
        let payload = token.split('.').nth(1).expect("jwt has a payload");
        let bytes = URL_SAFE_NO_PAD.decode(payload).expect("jwt payload b64url");
        let v: Value = serde_json::from_slice(&bytes).expect("jwt payload json");
        v["sub"].as_str().expect("sub claim").to_string()
    }

    /// Register + activate (email-verify gate) + login → (access_token, user_id).
    fn make_user(
        c: &Client,
        base: &str,
        username: &str,
        email: &str,
        password: &str,
    ) -> (String, String) {
        let (st, body) = post(
            c,
            &format!("{base}/auth/register"),
            None,
            json!({ "username": username, "email": email, "password": password }),
        );
        // 200/201/202 (verification_required) on success; 409 if a re-run collided.
        assert!(
            (200..300).contains(&st) || st == 409,
            "register {username}: {st} {body}"
        );

        // Login is gated on a verified email; flip it directly in the dev DB.
        // Native psql first (ACCORD_E2E_DB, defaulting to the dev stack URL);
        // falls back to the legacy docker-exec path for the container setup.
        let sql = format!(
            "UPDATE users SET is_active = true, email_verified_at = now() WHERE email = '{email}';"
        );
        let db_url = std::env::var("ACCORD_E2E_DB")
            .unwrap_or_else(|_| "postgres://accord:accord@localhost:5439/accord".to_string());
        let native = std::process::Command::new("psql")
            .args([db_url.as_str(), "-tAc", sql.as_str()])
            .output();
        let activated = matches!(&native, Ok(out) if out.status.success());
        if !activated {
            let out = std::process::Command::new("docker")
                .args([
                    "exec",
                    "-e",
                    "PGPASSWORD=accord",
                    "sqlxpg",
                    "psql",
                    "-U",
                    "accord",
                    "-d",
                    "accord",
                    "-tAc",
                    &sql,
                ])
                .output()
                .expect("run psql (native or docker) to activate the test user");
            assert!(
                out.status.success(),
                "activate {email}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let (st, body) = post(
            c,
            &format!("{base}/auth/login"),
            None,
            json!({ "username_or_email": username, "password": password }),
        );
        assert_eq!(st, 200, "login {username}: {body}");
        let token = body["access_token"]
            .as_str()
            .expect("access_token")
            .to_string();
        let uid = jwt_sub(&token);
        (token, uid)
    }

    #[test]
    #[ignore = "needs the live dev stack; run with ACCORD_E2E=1 cargo test --lib --ignored mls_e2e -- --nocapture"]
    fn mls_e2e_two_parties_through_backend() {
        let base = base();
        let c = Client::new();
        let sfx = suffix();

        // 1) Two real accounts.
        let (a_user, b_user) = (format!("e2ea{sfx}"), format!("e2eb{sfx}"));
        let (a_mail, b_mail) = (format!("{a_user}@e2e.local"), format!("{b_user}@e2e.local"));
        let pw = format!("Zx9!e2e-{sfx}-Qw7r");
        let (a_tok, a_id) = make_user(&c, &base, &a_user, &a_mail, &pw);
        let (b_tok, b_id) = make_user(&c, &base, &b_user, &b_mail, &pw);
        println!("users: alice={a_id} bob={b_id}");

        // 2) Befriend (gates KeyPackage claim + DM membership), then open a DM.
        let (st, body) = post(
            &c,
            &format!("{base}/friends/requests"),
            Some(&a_tok),
            json!({ "username": b_user }),
        );
        assert_eq!(st, 200, "friend request: {body}");
        let (st, body) = post(
            &c,
            &format!("{base}/friends/requests/{a_id}/accept"),
            Some(&b_tok),
            json!({}),
        );
        assert_eq!(st, 200, "accept friend: {body}");
        let (st, body) = post(
            &c,
            &format!("{base}/conversations/dm"),
            Some(&a_tok),
            json!({ "user_id": b_id }),
        );
        assert_eq!(st, 200, "open dm: {body}");
        let conv = body["conversation_id"]
            .as_str()
            .expect("conversation_id")
            .to_string();
        let gid = conv.as_bytes();
        println!("conversation: {conv}");

        // L5-1: the DM starts legacy; the cutover endpoint flips protocol → 'mls',
        // and the flag is authoritative (visible to the peer via GET /conversations).
        let protocol_of = |tok: &str| -> String {
            let (_st, body) = get(&c, &format!("{base}/conversations"), tok);
            body["conversations"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .find(|v| v["id"].as_str() == Some(conv.as_str()))
                .and_then(|v| v["protocol"].as_str())
                .unwrap_or("?")
                .to_string()
        };
        assert_eq!(
            protocol_of(&a_tok),
            "mls",
            "a new DM is born MLS (v0.7 MLS-only)"
        );
        // Re-asserting the protocol must stay a 200 no-op (idempotent upgrade)…
        let (st, body) = post(
            &c,
            &format!("{base}/conversations/{conv}/protocol"),
            Some(&a_tok),
            json!({ "protocol": "mls" }),
        );
        assert_eq!(st, 200, "mls re-assert is idempotent: {body}");
        assert_eq!(
            protocol_of(&b_tok),
            "mls",
            "protocol is authoritative + visible to the peer"
        );
        // …while a downgrade back to the legacy protocol is refused outright.
        let (st, body) = post(
            &c,
            &format!("{base}/conversations/{conv}/protocol"),
            Some(&a_tok),
            json!({ "protocol": "x25519" }),
        );
        assert!(
            st >= 400,
            "downgrade to x25519 must be refused: {st} {body}"
        );

        // 3) Real MLS devices; both publish a KeyPackage to the directory.
        let (a_dev, b_dev) = ("e2edevA", "e2edevB");
        let alice = Device::new(format!("{a_id}:{a_dev}").as_bytes()).unwrap();
        let bob = Device::new(format!("{b_id}:{b_dev}").as_bytes()).unwrap();
        for (tok, dev, d) in [(&a_tok, a_dev, &alice), (&b_tok, b_dev, &bob)] {
            let (data, kp_ref) = d.key_package().unwrap();
            let (st, body) = post(
                &c,
                &format!("{base}/mls/key-packages"),
                Some(tok),
                json!({ "device_id": dev, "packages": [{ "kp_ref": b64(&kp_ref), "key_package": b64(&data) }] }),
            );
            assert_eq!(st, 200, "publish kp {dev}: {body}");
        }

        // 4) Alice creates the group and adds Bob (claim his KP → Add commit → submit).
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}"),
            Some(&a_tok),
            json!({}),
        );
        assert_eq!(st, 200, "create group: {body}");
        alice.create_group(gid).unwrap();

        let (st, body) = post(
            &c,
            &format!("{base}/mls/key-packages/claim"),
            Some(&a_tok),
            json!({ "user_id": b_id, "device_ids": [b_dev] }),
        );
        assert_eq!(st, 200, "claim bob kp: {body}");
        let bob_kp = unb64(
            body["packages"][0]["key_package"]
                .as_str()
                .expect("claimed kp"),
        )
        .unwrap();

        let (commit, welcome) = alice.add_member(gid, &bob_kp).unwrap();
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/commit"),
            Some(&a_tok),
            json!({
                "epoch": 0,
                "frame": b64(&commit),
                "welcomes": [{ "user_id": b_id, "device_id": b_dev, "welcome": b64(&welcome) }],
            }),
        );
        assert_eq!(st, 200, "submit commit: {body}");
        alice.merge_pending(gid).unwrap(); // DS accepted → apply our own commit

        // 5) Bob pulls his Welcome from the mailbox and joins.
        let (st, body) = get(
            &c,
            &format!("{base}/mls/welcomes?device_id={b_dev}"),
            &b_tok,
        );
        assert_eq!(st, 200, "pull welcomes: {body}");
        let w = body["welcomes"][0]["welcome"]
            .as_str()
            .expect("a queued welcome");
        let joined = bob.join_from_welcome(&unb64(w).unwrap(), None).unwrap();
        assert_eq!(joined, gid, "bob joined the conversation's group");

        // 6) Alice sends an application message; it lands as one opaque frame.
        let plaintext = b"hello mls e2e";
        let frame = alice.encrypt_app(gid, plaintext).unwrap();
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/frames"),
            Some(&a_tok),
            json!({ "content_type": "application", "frame": b64(&frame) }),
        );
        assert_eq!(st, 200, "submit frame: {body}");

        // 7) Bob replays the ordered log and decrypts it.
        let (st, body) = get(
            &c,
            &format!("{base}/mls/groups/{conv}/frames?after=0"),
            &b_tok,
        );
        assert_eq!(st, 200, "pull frames: {body}");
        let frames = body["frames"].as_array().expect("frames array");
        let mut recovered: Vec<Vec<u8>> = Vec::new();
        let mut server_saw_plaintext = false;
        let mut bob_seq = 0u64;
        for f in frames {
            bob_seq = f["order_seq"].as_u64().unwrap_or(bob_seq);
            let bytes = unb64(f["frame"].as_str().unwrap()).unwrap();
            if bytes.windows(plaintext.len()).any(|w| w == plaintext) {
                server_saw_plaintext = true;
            }
            if let Ok(Some(pt)) = bob.process(gid, &bytes) {
                recovered.push(pt);
            }
        }

        assert!(
            recovered.iter().any(|p| p.as_slice() == plaintext),
            "bob decrypted Alice's message end-to-end (got {:?})",
            recovered
                .iter()
                .map(|p| String::from_utf8_lossy(p).to_string())
                .collect::<Vec<_>>()
        );
        assert!(
            !server_saw_plaintext,
            "server-stored frames must be opaque ciphertext — plaintext leaked into the log"
        );
        println!(
            "OK — bob decrypted {:?} through the live DS; server stored only ciphertext",
            String::from_utf8_lossy(plaintext)
        );

        // 8) L5-4: Alice revokes Bob's whole membership (all his devices, one commit)
        //    through the DS → epoch rekeys. A message sent after must be unreadable to
        //    Bob (post-compromise security), proving revocation end-to-end.
        let epoch = alice.epoch(gid).unwrap();
        let revoke = alice
            .remove_members_by_prefix(gid, format!("{b_id}:").as_bytes())
            .unwrap()
            .expect("bob is a current member");
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/commit"),
            Some(&a_tok),
            json!({ "epoch": epoch as i64, "frame": b64(&revoke), "welcomes": [] }),
        );
        assert_eq!(st, 200, "submit revoke commit: {body}");
        alice.merge_pending(gid).unwrap();

        let secret = b"after revoke - bob is out";
        let frame2 = alice.encrypt_app(gid, secret).unwrap();
        let (st, _b) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/frames"),
            Some(&a_tok),
            json!({ "content_type": "application", "frame": b64(&frame2) }),
        );
        assert_eq!(st, 200, "submit post-revoke frame");

        // Bob replays what landed after his cursor: the revoke commit + the new
        // message. He must NOT recover the plaintext.
        let (st, body) = get(
            &c,
            &format!("{base}/mls/groups/{conv}/frames?after={bob_seq}"),
            &b_tok,
        );
        assert_eq!(st, 200, "pull post-revoke frames: {body}");
        let mut bob_read_after_revoke = false;
        for f in body["frames"].as_array().expect("frames") {
            let bytes = unb64(f["frame"].as_str().unwrap()).unwrap();
            if let Ok(Some(pt)) = bob.process(gid, &bytes) {
                if pt.as_slice() == secret {
                    bob_read_after_revoke = true;
                }
            }
        }
        assert!(
            !bob_read_after_revoke,
            "revoked member must not read post-removal messages (PCS)"
        );
        println!(
            "OK — Alice revoked Bob through the live DS; Bob cannot read post-revocation messages"
        );
    }

    /// The split-brain contract, end-to-end against the live DS: creation is
    /// arbitrated (one `created: true`), a forked device's commits AND stale
    /// application frames are refused, its Welcome survives until acked, and a
    /// wipe + welcome-rejoin fully repairs it.
    #[test]
    #[ignore = "needs the live dev stack; run with ACCORD_E2E=1 cargo test --lib --ignored mls_e2e -- --nocapture"]
    fn mls_e2e_creation_arbitration_ack_and_repair() {
        let base = base();
        let c = Client::new();
        let sfx = suffix();

        // Accounts + friendship + DM (same scaffolding as the main e2e).
        let (a_user, b_user) = (format!("arba{sfx}"), format!("arbb{sfx}"));
        let pw = format!("Zx9!e2e-{sfx}-Qw7r");
        let (a_tok, a_id) = make_user(&c, &base, &a_user, &format!("{a_user}@e2e.local"), &pw);
        let (b_tok, b_id) = make_user(&c, &base, &b_user, &format!("{b_user}@e2e.local"), &pw);
        let (st, body) = post(
            &c,
            &format!("{base}/friends/requests"),
            Some(&a_tok),
            json!({ "username": b_user }),
        );
        assert_eq!(st, 200, "friend request: {body}");
        let (st, body) = post(
            &c,
            &format!("{base}/friends/requests/{a_id}/accept"),
            Some(&b_tok),
            json!({}),
        );
        assert_eq!(st, 200, "accept friend: {body}");
        let (st, body) = post(
            &c,
            &format!("{base}/conversations/dm"),
            Some(&a_tok),
            json!({ "user_id": b_id }),
        );
        assert_eq!(st, 200, "open dm: {body}");
        let conv = body["conversation_id"]
            .as_str()
            .expect("conversation_id")
            .to_string();
        let gid = conv.as_bytes();

        // Devices + published KeyPackages.
        let (a_dev, b_dev) = ("arbDevA", "arbDevB");
        let alice = Device::new(format!("{a_id}:{a_dev}").as_bytes()).unwrap();
        let bob = Device::new(format!("{b_id}:{b_dev}").as_bytes()).unwrap();
        for (tok, dev, d) in [(&a_tok, a_dev, &alice), (&b_tok, b_dev, &bob)] {
            let (data, kp_ref) = d.key_package().unwrap();
            let (st, body) = post(
                &c,
                &format!("{base}/mls/key-packages"),
                Some(tok),
                json!({ "device_id": dev, "packages": [{ "kp_ref": b64(&kp_ref), "key_package": b64(&data) }] }),
            );
            assert_eq!(st, 200, "publish kp {dev}: {body}");
        }

        // ── Creation arbitration: exactly one caller is the creator ─────────
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}"),
            Some(&a_tok),
            json!({}),
        );
        assert_eq!(st, 200, "first create: {body}");
        assert_eq!(
            body["created"],
            json!(true),
            "first caller must be THE creator: {body}"
        );
        assert_eq!(body["current_epoch"], json!(0));
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}"),
            Some(&b_tok),
            json!({}),
        );
        assert_eq!(st, 200, "second create: {body}");
        assert_eq!(
            body["created"],
            json!(false),
            "second caller must NOT create: {body}"
        );

        // Alice (the arbitrated creator) builds the real group and adds Bob.
        alice.create_group(gid).unwrap();
        let (st, body) = post(
            &c,
            &format!("{base}/mls/key-packages/claim"),
            Some(&a_tok),
            json!({ "user_id": b_id, "device_ids": [b_dev] }),
        );
        assert_eq!(st, 200, "claim bob kp: {body}");
        let bob_kp = unb64(body["packages"][0]["key_package"].as_str().expect("kp")).unwrap();
        let (commit, welcome) = alice.add_member(gid, &bob_kp).unwrap();
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/commit"),
            Some(&a_tok),
            json!({
                "epoch": 0,
                "frame": b64(&commit),
                "welcomes": [{ "user_id": b_id, "device_id": b_dev, "welcome": b64(&welcome) }],
            }),
        );
        assert_eq!(st, 200, "alice's add commit: {body}");
        alice.merge_pending(gid).unwrap();

        // ── The old bug, replayed on purpose: Bob forks his own group ───────
        bob.create_group(gid).unwrap(); // divergent fork at epoch 0
        let (st, body) = post(
            &c,
            &format!("{base}/mls/key-packages/claim"),
            Some(&b_tok),
            json!({ "user_id": a_id, "device_ids": [a_dev] }),
        );
        assert_eq!(st, 200, "claim alice kp: {body}");
        let a_kp = unb64(body["packages"][0]["key_package"].as_str().expect("kp")).unwrap();
        let (fork_commit, _fork_welcome) = bob.add_member(gid, &a_kp).unwrap();
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/commit"),
            Some(&b_tok),
            json!({ "epoch": 0, "frame": b64(&fork_commit), "welcomes": [] }),
        );
        assert_eq!(
            st, 409,
            "a forked commit must 409, not fork the log: {body}"
        );
        bob.clear_pending(gid).unwrap();

        // Advance the real group to epoch 3 so the fork lags beyond the window.
        for _ in 0..2 {
            let commit = alice.self_update(gid).unwrap();
            let epoch = alice.epoch(gid).unwrap();
            let (st, body) = post(
                &c,
                &format!("{base}/mls/groups/{conv}/commit"),
                Some(&a_tok),
                json!({ "epoch": epoch, "frame": b64(&commit), "welcomes": [] }),
            );
            assert_eq!(st, 200, "self-update: {body}");
            alice.merge_pending(gid).unwrap();
        }

        // A diverged sender claiming its (stale) epoch is refused — the split
        // brain SURFACES instead of "succeeding" into an unreadable log…
        let stale = bob.encrypt_app(gid, b"from the fork").unwrap();
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/frames"),
            Some(&b_tok),
            json!({ "content_type": "application", "frame": b64(&stale), "epoch": 0 }),
        );
        assert_eq!(st, 409, "stale-epoch frame must 409: {body}");
        // …while legacy clients (no epoch claim) keep the old accept behavior.
        let (st, body) = post(
            &c,
            &format!("{base}/mls/groups/{conv}/frames"),
            Some(&b_tok),
            json!({ "content_type": "application", "frame": b64(&stale) }),
        );
        assert_eq!(st, 200, "claim-less frame keeps legacy behavior: {body}");

        // ── Welcome ACK (at-least-once) + repair ────────────────────────────
        let (st, body) = get(
            &c,
            &format!("{base}/mls/welcomes?device_id={b_dev}&ack=true"),
            &b_tok,
        );
        assert_eq!(st, 200, "pull welcomes (ack mode): {body}");
        let w_id = body["welcomes"][0]["id"]
            .as_str()
            .expect("welcome id")
            .to_string();
        assert_eq!(
            body["welcomes"][0]["group_id"].as_str(),
            Some(conv.as_str())
        );
        let w = unb64(body["welcomes"][0]["welcome"].as_str().expect("welcome")).unwrap();
        // Fetch again: still pending — an ack-mode fetch must not consume it.
        let (_st, body) = get(
            &c,
            &format!("{base}/mls/welcomes?device_id={b_dev}&ack=true"),
            &b_tok,
        );
        assert!(
            !body["welcomes"].as_array().expect("welcomes").is_empty(),
            "welcome must survive the fetch until acked"
        );

        // Repair: the join wipes the fork (group-id hint), replacing it with the
        // real group's state at the add epoch.
        let joined = bob.join_from_welcome(&w, Some(gid)).unwrap();
        assert_eq!(joined, gid, "rejoined the real group");
        let (st, body) = post(
            &c,
            &format!("{base}/mls/welcomes/{w_id}/ack"),
            Some(&b_tok),
            json!({}),
        );
        assert_eq!(st, 200, "ack welcome: {body}");
        let (_st, body) = get(
            &c,
            &format!("{base}/mls/welcomes?device_id={b_dev}&ack=true"),
            &b_tok,
        );
        assert!(
            body["welcomes"].as_array().expect("welcomes").is_empty(),
            "welcome consumed after the ack"
        );

        // Replay the whole log: pre-join / own / foreign frames are benign skips;
        // the two later self-updates must apply and converge the epochs.
        let (st, body) = get(
            &c,
            &format!("{base}/mls/groups/{conv}/frames?after=0"),
            &b_tok,
        );
        assert_eq!(st, 200, "replay: {body}");
        for f in body["frames"].as_array().expect("frames") {
            let bytes = unb64(f["frame"].as_str().unwrap()).unwrap();
            let _ = bob.process(gid, &bytes);
        }
        assert_eq!(
            bob.epoch(gid).unwrap(),
            alice.epoch(gid).unwrap(),
            "epochs converge after the repair"
        );

        // Both directions decrypt — the conversation is healthy again.
        let ct = alice.encrypt_app(gid, b"post-repair").unwrap();
        assert_eq!(bob.decrypt_app(gid, &ct).unwrap(), b"post-repair");
        let ct = bob.encrypt_app(gid, b"ack from bob").unwrap();
        assert_eq!(alice.decrypt_app(gid, &ct).unwrap(), b"ack from bob");
        println!("OK — arbitration + welcome ack + split-brain repair, live through the DS");
    }
}
