//! Où vit le petit secret qui protège l'état MLS sur disque.
//!
//! L'état complet (signataire + ratchets de tous les groupes) est écrit dans un
//! fichier chiffré ; seule la clé de 32 octets qui l'enveloppe a besoin d'un
//! magasin sécurisé du système. Ce magasin diffère radicalement par plateforme
//! (trousseau macOS, Credential Manager Windows, Secret Service Linux, Keystore
//! Android), et chacun tire des dépendances incompatibles avec les autres.
//!
//! Cette crate reste donc **sans dépendance de plateforme** : l'application hôte
//! injecte son implémentation au démarrage. C'est aussi ce qui rend le moteur
//! testable sans toucher au trousseau de la machine.

use std::sync::OnceLock;

/// Magasin de secrets du système hôte. Les clés sont identifiées par un couple
/// (service, compte), la convention commune à tous les magasins natifs.
pub trait SecretStore: Send + Sync {
    /// Lit un secret ; `None` s'il n'existe pas (ce n'est pas une erreur).
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    /// Écrit (ou remplace) un secret.
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    /// Supprime un secret ; réussit même s'il n'existait pas.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

static STORE: OnceLock<Box<dyn SecretStore>> = OnceLock::new();

/// Branche le magasin de secrets de la plateforme. Appelé une fois au démarrage
/// de l'application ; les appels suivants sont ignorés (le premier gagne, comme
/// pour le répertoire de stockage).
pub fn init_secret_store(store: Box<dyn SecretStore>) {
    let _ = STORE.set(store);
}

/// Le magasin injecté, ou une erreur claire si l'hôte a oublié de le brancher —
/// mieux vaut échouer bruyamment que persister un état qu'on ne saura pas relire.
pub fn secret_store() -> Result<&'static dyn SecretStore, String> {
    STORE
        .get()
        .map(|b| b.as_ref())
        .ok_or_else(|| "secret store not initialized".to_string())
}

/// Magasin en mémoire, pour les tests : le moteur MLS se teste sans dépendre du
/// trousseau de la machine qui exécute la suite.
#[derive(Default)]
pub struct MemorySecretStore {
    entries: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .get(&(service.to_string(), account.to_string()))
            .cloned())
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .insert(
                (service.to_string(), account.to_string()),
                value.to_string(),
            );
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .remove(&(service.to_string(), account.to_string()));
        Ok(())
    }
}
