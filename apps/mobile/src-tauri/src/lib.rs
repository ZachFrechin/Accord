//! Accord mobile (Android) — coquille Tauri 2.
//!
//! Le moteur de chiffrement est exactement celui du desktop : la crate partagée
//! `accord-mls` (OpenMLS, RFC 9420). Ce module ne fournit que ce qui change
//! d'une plateforme à l'autre — le magasin de secrets — et expose au webview la
//! même surface de commandes, si bien que la logique TypeScript partagée
//! (`packages/core`) fonctionne sans savoir sur quoi elle tourne.
//!
//! Les clés privées et l'état des ratchets ne quittent jamais Rust : le webview
//! n'échange que des trames base64.

mod notifications;
mod secrets;

/// Fichier de secrets pour les jetons de rafraîchissement (compte = id d'instance).
const REFRESH_SERVICE: &str = "app.accord.mobile.refresh-token";
/// Fichier de secrets pour les clés privées d'identité d'appareil.
const DEVICE_KEY_SERVICE: &str = "app.accord.mobile.device-key";

fn store() -> Result<&'static dyn accord_mls::SecretStore, String> {
    accord_mls::secrets::secret_store()
}

#[tauri::command]
fn secure_get_refresh(instance_id: String) -> Result<Option<String>, String> {
    store()?.get(REFRESH_SERVICE, &instance_id)
}

#[tauri::command]
fn secure_set_refresh(instance_id: String, refresh_token: String) -> Result<(), String> {
    store()?.set(REFRESH_SERVICE, &instance_id, &refresh_token)
}

#[tauri::command]
fn secure_delete_refresh(instance_id: String) -> Result<(), String> {
    store()?.delete(REFRESH_SERVICE, &instance_id)
}

/// Renvoie la clé privée d'appareil (base64) pour une instance, ou `None`.
#[tauri::command]
fn secure_get_device_key(instance_id: String) -> Result<Option<String>, String> {
    store()?.get(DEVICE_KEY_SERVICE, &instance_id)
}

/// Enregistre (ou remplace) la clé privée d'appareil d'une instance.
#[tauri::command]
fn secure_set_device_key(instance_id: String, private_key: String) -> Result<(), String> {
    store()?.set(DEVICE_KEY_SERVICE, &instance_id, &private_key)
}

/// Supprime la clé privée d'appareil d'une instance (idempotent).
#[tauri::command]
fn secure_delete_device_key(instance_id: String) -> Result<(), String> {
    store()?.delete(DEVICE_KEY_SERVICE, &instance_id)
}

// ── MLS — enveloppes minces au-dessus du moteur partagé `accord-mls`.
// Mêmes noms et mêmes signatures que sur desktop : c'est ce qui permet à la
// façade TypeScript commune d'appeler l'un ou l'autre sans distinction.
#[tauri::command]
fn mls_init_identity(instance_id: String, identity: String) -> Result<String, String> {
    accord_mls::cmd_init_identity(&instance_id, &identity)
}
#[tauri::command]
fn mls_generate_key_package(instance_id: String) -> Result<(String, String), String> {
    accord_mls::cmd_generate_key_package(&instance_id)
}
#[tauri::command]
fn mls_create_group(instance_id: String, group_id: String) -> Result<(), String> {
    accord_mls::cmd_create_group(&instance_id, &group_id)
}
#[tauri::command]
fn mls_group_epoch(instance_id: String, group_id: String) -> Result<u64, String> {
    accord_mls::cmd_group_epoch(&instance_id, &group_id)
}
#[tauri::command]
fn mls_export_call_key(instance_id: String, group_id: String) -> Result<String, String> {
    accord_mls::cmd_export_call_key(&instance_id, &group_id)
}
#[tauri::command]
fn mls_merge_pending(instance_id: String, group_id: String) -> Result<(), String> {
    accord_mls::cmd_merge_pending(&instance_id, &group_id)
}
#[tauri::command]
fn mls_clear_pending(instance_id: String, group_id: String) -> Result<(), String> {
    accord_mls::cmd_clear_pending(&instance_id, &group_id)
}
#[tauri::command]
fn mls_add_member(
    instance_id: String,
    group_id: String,
    key_package: String,
) -> Result<(String, String), String> {
    accord_mls::cmd_add_member(&instance_id, &group_id, &key_package)
}
#[tauri::command]
fn mls_remove_member(
    instance_id: String,
    group_id: String,
    leaf_index: u32,
) -> Result<String, String> {
    accord_mls::cmd_remove_member(&instance_id, &group_id, leaf_index)
}
#[tauri::command]
fn mls_remove_members_by_prefix(
    instance_id: String,
    group_id: String,
    prefix: String,
) -> Result<Option<String>, String> {
    accord_mls::cmd_remove_members_by_prefix(&instance_id, &group_id, &prefix)
}
#[tauri::command]
fn mls_self_update(instance_id: String, group_id: String) -> Result<String, String> {
    accord_mls::cmd_self_update(&instance_id, &group_id)
}
#[tauri::command]
fn mls_join_from_welcome(
    instance_id: String,
    welcome: String,
    group_id_hint: Option<String>,
) -> Result<String, String> {
    accord_mls::cmd_join_from_welcome(&instance_id, &welcome, group_id_hint.as_deref())
}
#[tauri::command]
fn mls_delete_group(instance_id: String, group_id: String) -> Result<(), String> {
    accord_mls::cmd_delete_group(&instance_id, &group_id)
}
#[tauri::command]
fn mls_member_identities(instance_id: String, group_id: String) -> Result<Vec<String>, String> {
    accord_mls::cmd_member_identities(&instance_id, &group_id)
}
#[tauri::command]
fn mls_process(
    instance_id: String,
    group_id: String,
    frame: String,
) -> Result<Option<String>, String> {
    accord_mls::cmd_process(&instance_id, &group_id, &frame)
}
#[tauri::command]
fn mls_encrypt_app(
    instance_id: String,
    group_id: String,
    plaintext: String,
) -> Result<String, String> {
    accord_mls::cmd_encrypt_app(&instance_id, &group_id, &plaintext)
}
#[tauri::command]
fn mls_decrypt_app(
    instance_id: String,
    group_id: String,
    frame: String,
) -> Result<String, String> {
    accord_mls::cmd_decrypt_app(&instance_id, &group_id, &frame)
}

/// Construit et lance l'application mobile.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Le stockage privé de l'application : les secrets et l'état MLS
            // chiffré y vivent. Fatal s'il est introuvable — le chiffrement de
            // bout en bout ne peut rien persister sans lui.
            let dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("résolution du dossier de données : {e}"))?;
            accord_mls::init_secret_store(Box::new(secrets::PrivateFileStore::new(dir.clone())));
            accord_mls::init_storage_dir(dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notifications::notif_permission_state,
            notifications::notif_request_permission,
            notifications::notif_show,
            notifications::notif_conversation_for,
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
            mls_decrypt_app,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement d'Accord");
}
