//! Accord desktop shell (Tauri 2).
//!
//! Beyond the window runtime, this exposes a tiny secure-storage surface the
//! frontend uses to keep secrets in the OS keychain (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service) instead of the webview's
//! `localStorage`:
//!   - **refresh tokens** (`secure_*_refresh`) — re-minted from on launch;
//!   - **device identity private keys** (`secure_*_device_key`) — the X25519
//!     private half that must never leave the device (E2EE, Phase 2 · Lot 7).
//!
//! Access tokens and message plaintext are never persisted. Phase 3 adds the MLS
//! commands (`mls_*`, see `mls.rs`): the OpenMLS engine + private keys live here,
//! never in the webview.

mod link_preview;
mod mls;
mod notifications;

use keyring::{Entry, Error as KeyringError};

/// Keychain service for per-instance refresh tokens (account = instance id).
const REFRESH_SERVICE: &str = "app.accord.desktop.refresh-token";
/// Keychain service for per-instance device identity private keys.
const DEVICE_KEY_SERVICE: &str = "app.accord.desktop.device-key";

fn entry(service: &str, account: &str) -> Result<Entry, String> {
    Entry::new(service, account).map_err(|e| e.to_string())
}

/// Reads a secret from `service`/`account`, mapping a missing entry to `None`.
fn secure_get(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes (or replaces) a secret at `service`/`account`.
fn secure_set(service: &str, account: &str, secret: &str) -> Result<(), String> {
    entry(service, account)?
        .set_password(secret)
        .map_err(|e| e.to_string())
}

/// Deletes a secret (idempotent — a missing entry is fine).
fn secure_delete(service: &str, account: &str) -> Result<(), String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secure_get_refresh(instance_id: String) -> Result<Option<String>, String> {
    secure_get(REFRESH_SERVICE, &instance_id)
}

#[tauri::command]
fn secure_set_refresh(instance_id: String, refresh_token: String) -> Result<(), String> {
    secure_set(REFRESH_SERVICE, &instance_id, &refresh_token)
}

#[tauri::command]
fn secure_delete_refresh(instance_id: String) -> Result<(), String> {
    secure_delete(REFRESH_SERVICE, &instance_id)
}

/// Returns the base64-encoded device private key for an instance, or `None`.
#[tauri::command]
fn secure_get_device_key(instance_id: String) -> Result<Option<String>, String> {
    secure_get(DEVICE_KEY_SERVICE, &instance_id)
}

/// Stores (or replaces) the base64-encoded device private key for an instance.
#[tauri::command]
fn secure_set_device_key(instance_id: String, private_key: String) -> Result<(), String> {
    secure_set(DEVICE_KEY_SERVICE, &instance_id, &private_key)
}

/// Deletes the device private key for an instance (idempotent).
#[tauri::command]
fn secure_delete_device_key(instance_id: String) -> Result<(), String> {
    secure_delete(DEVICE_KEY_SERVICE, &instance_id)
}

// ── MLS (Phase 3) — thin wrappers over the native OpenMLS engine (`mls.rs`).
// Private keys + group ratchet state stay in Rust; JS exchanges only base64
// frames + the conversation id. The server never links any MLS library.
#[tauri::command]
fn mls_init_identity(instance_id: String, identity: String) -> Result<String, String> {
    mls::cmd_init_identity(&instance_id, &identity)
}
#[tauri::command]
fn mls_generate_key_package(instance_id: String) -> Result<(String, String), String> {
    mls::cmd_generate_key_package(&instance_id)
}
#[tauri::command]
fn mls_create_group(instance_id: String, group_id: String) -> Result<(), String> {
    mls::cmd_create_group(&instance_id, &group_id)
}
#[tauri::command]
fn mls_group_epoch(instance_id: String, group_id: String) -> Result<u64, String> {
    mls::cmd_group_epoch(&instance_id, &group_id)
}
#[tauri::command]
fn mls_export_call_key(instance_id: String, group_id: String) -> Result<String, String> {
    mls::cmd_export_call_key(&instance_id, &group_id)
}
#[tauri::command]
fn mls_merge_pending(instance_id: String, group_id: String) -> Result<(), String> {
    mls::cmd_merge_pending(&instance_id, &group_id)
}
#[tauri::command]
fn mls_clear_pending(instance_id: String, group_id: String) -> Result<(), String> {
    mls::cmd_clear_pending(&instance_id, &group_id)
}
#[tauri::command]
fn mls_add_member(
    instance_id: String,
    group_id: String,
    key_package: String,
) -> Result<(String, String), String> {
    mls::cmd_add_member(&instance_id, &group_id, &key_package)
}
#[tauri::command]
fn mls_remove_member(instance_id: String, group_id: String, leaf_index: u32) -> Result<String, String> {
    mls::cmd_remove_member(&instance_id, &group_id, leaf_index)
}
#[tauri::command]
fn mls_remove_members_by_prefix(
    instance_id: String,
    group_id: String,
    prefix: String,
) -> Result<Option<String>, String> {
    mls::cmd_remove_members_by_prefix(&instance_id, &group_id, &prefix)
}
#[tauri::command]
fn mls_self_update(instance_id: String, group_id: String) -> Result<String, String> {
    mls::cmd_self_update(&instance_id, &group_id)
}
#[tauri::command]
fn mls_join_from_welcome(
    instance_id: String,
    welcome: String,
    group_id_hint: Option<String>,
) -> Result<String, String> {
    mls::cmd_join_from_welcome(&instance_id, &welcome, group_id_hint.as_deref())
}
#[tauri::command]
fn mls_delete_group(instance_id: String, group_id: String) -> Result<(), String> {
    mls::cmd_delete_group(&instance_id, &group_id)
}
#[tauri::command]
fn mls_member_identities(instance_id: String, group_id: String) -> Result<Vec<String>, String> {
    mls::cmd_member_identities(&instance_id, &group_id)
}
#[tauri::command]
fn mls_process(instance_id: String, group_id: String, frame: String) -> Result<Option<String>, String> {
    mls::cmd_process(&instance_id, &group_id, &frame)
}
#[tauri::command]
fn mls_encrypt_app(instance_id: String, group_id: String, plaintext: String) -> Result<String, String> {
    mls::cmd_encrypt_app(&instance_id, &group_id, &plaintext)
}
#[tauri::command]
fn mls_decrypt_app(instance_id: String, group_id: String, frame: String) -> Result<String, String> {
    mls::cmd_decrypt_app(&instance_id, &group_id, &frame)
}

/// Builds and runs the desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    // Auto-updater: on macOS we ship ONE universal build, so pin the update
    // target to `darwin-universal` (the manifest carries that single entry
    // instead of per-arch ones). Other platforms keep their default target.
    let mut updater = tauri_plugin_updater::Builder::new();
    #[cfg(target_os = "macos")]
    {
        updater = updater.target("darwin-universal");
    }
    tauri::Builder::default()
        // Single-instance must be the FIRST plugin; its callback fires in the
        // surviving process when a second launch (e.g. an accord:// link on
        // Windows) gets forwarded — bring the window to front, the deep-link
        // feature re-emits the URL to the frontend listener.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(updater.build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Native notification machinery (delegate/click routing) — before
            // anything can emit a notification.
            notifications::init(app.handle());
            // Hand the shared MLS engine this platform's secret store (the OS
            // keychain) before any state is read or written — it guards the key
            // that wraps the on-disk group state.
            mls::init_platform_secret_store();
            // Point the MLS engine at this OS user's app-data dir: the encrypted
            // group-state files live there (too large for the keychain, esp. on
            // Windows). Fatal if unavailable — E2EE cannot persist without it.
            let dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("resolving app_local_data_dir: {e}"))?;
            mls::init_storage_dir(dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            link_preview::fetch_link_preview,
            notifications::notif_show,
            notifications::notif_request_permission,
            notifications::notif_permission_state,
            notifications::notif_take_pending_click,
            secure_get_refresh,
            secure_set_refresh,
            secure_delete_refresh,
            secure_get_device_key,
            secure_set_device_key,
            secure_delete_device_key,
            mls_init_identity,
            mls_generate_key_package,
            mls_create_group,
            mls_group_epoch,
            mls_export_call_key,
            mls_merge_pending,
            mls_clear_pending,
            mls_add_member,
            mls_remove_member,
            mls_remove_members_by_prefix,
            mls_self_update,
            mls_join_from_welcome,
            mls_delete_group,
            mls_member_identities,
            mls_process,
            mls_encrypt_app,
            mls_decrypt_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Accord desktop application");
}
