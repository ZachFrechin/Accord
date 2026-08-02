//! Magasin de secrets d'Android.
//!
//! Sur desktop, les secrets vont au trousseau du système via la crate `keyring`,
//! qui n'a **aucun backend Android** (et n'est même pas dans le graphe de
//! dépendances de cette cible). On s'appuie ici sur le stockage privé de
//! l'application : un dossier isolé par UID, que le chiffrement de l'appareil
//! (File-Based Encryption) protège au repos et qu'aucune autre application ne
//! peut lire.
//!
//! Ce que ça protège : un autre programme sur le téléphone, et un appareil
//! éteint ou verrouillé avant le premier déverrouillage.
//! Ce que ça ne protège pas encore : un appareil rooté et déverrouillé, où le
//! Keystore matériel ferait mieux. Adosser ces secrets au Keystore (clé AES-GCM
//! non exportable, via JNI) est le durcissement prévu ensuite — l'interface
//! `SecretStore` est justement là pour que ce remplacement ne touche à rien
//! d'autre.

use std::path::PathBuf;

use accord_mls::SecretStore;

/// Magasin adossé à un fichier par secret, dans le stockage privé de l'app.
pub struct PrivateFileStore {
    dir: PathBuf,
}

impl PrivateFileStore {
    /// `base` est le répertoire de données local de l'application (Tauri le
    /// résout vers le stockage privé sur Android).
    pub fn new(base: PathBuf) -> Self {
        Self {
            dir: base.join("secrets"),
        }
    }

    /// Chemin du fichier d'un secret. Le couple (service, compte) est assaini
    /// caractère par caractère : il ne peut jamais s'échapper du dossier.
    fn path(&self, service: &str, account: &str) -> PathBuf {
        let safe = |s: &str| -> String {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        };
        self.dir
            .join(format!("{}__{}.secret", safe(service), safe(account)))
    }
}

impl SecretStore for PrivateFileStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.path(service, account)) {
            Ok(v) => Ok(Some(v)),
            // L'absence est un état normal (premier lancement), pas une panne.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("lecture du secret : {e}")),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("création du dossier : {e}"))?;
        // Écriture atomique : un secret à moitié écrit rendrait l'état MLS
        // indéchiffrable, donc on ne publie le fichier qu'une fois complet.
        let path = self.path(service, account);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, value).map_err(|e| format!("écriture du secret : {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("publication du secret : {e}"))
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match std::fs::remove_file(self.path(service, account)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("suppression du secret : {e}")),
        }
    }
}
