//! Pont MLS du client desktop.
//!
//! Le moteur lui-même vit dans la crate `accord-mls`, partagée avec l'application
//! mobile : identité, KeyPackages, cycle de vie des groupes et messages chiffrés
//! y sont implémentés une seule fois. Ce module ne fait que deux choses côté
//! desktop : fournir le magasin de secrets du système (trousseau macOS,
//! Credential Manager Windows, Secret Service Linux) et ré-exporter la surface
//! que les commandes Tauri de `lib.rs` appellent.

pub use accord_mls::*;

/// Magasin de secrets adossé au trousseau du système via la crate `keyring`,
/// qui choisit le backend natif de chaque plateforme desktop.
struct KeyringStore;

impl accord_mls::SecretStore for KeyringStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            // L'absence d'entrée est un état normal (premier lancement), pas une panne.
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(service, account)
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Branche le trousseau du système sur le moteur MLS. Appelé une fois au
/// démarrage, avant toute opération qui lit ou écrit l'état persistant.
pub fn init_platform_secret_store() {
    accord_mls::init_secret_store(Box::new(KeyringStore));
}
