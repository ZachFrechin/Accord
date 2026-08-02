//! Push FCM silencieux.
//!
//! Le serveur n'envoie JAMAIS de contenu. La charge utile se limite aux
//! identifiants de conversation et de message : le téléphone se réveille, va
//! chercher le message, le déchiffre localement via MLS et affiche le vrai texte.
//! Google et le serveur voient passer un signal, jamais une donnée. C'est ce qui
//! permet d'avoir des notifications sans renoncer au chiffrement de bout en bout.
//!
//! L'authentification suit le protocole « compte de service » de Google : un JWT
//! signé RS256 avec la clé privée, échangé contre un jeton d'accès valable une
//! heure. Ce jeton est gardé en cache — le redemander à chaque message coûterait
//! un aller-retour réseau par notification, pour rien.
//!
//! La clé appartient à l'instance : quiconque déploie une API Accord fournit la
//! sienne, exactement comme pour les clés de jeu. Absente, le push se tait et
//! tout le reste fonctionne.

use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config::PushConfig;
use crate::error::ApiError;

/// Portée OAuth2 minimale : envoyer des messages, rien d'autre.
const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Le jeton vaut une heure ; on le renouvelle un peu avant pour ne jamais
/// présenter un jeton expiré à cause d'une horloge qui dérive.
const TOKEN_TTL: Duration = Duration::from_secs(55 * 60);

/// Identité du compte de service, telle que Google la distribue.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccount {
    pub project_id: String,
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

#[derive(Debug, Serialize)]
struct Assertion<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

struct CachedToken {
    value: String,
    fetched_at: Instant,
}

/// Ce qu'il faut faire du jeton d'appareil après un envoi.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Remis à Google.
    Sent,
    /// L'appareil ne veut plus rien recevoir : application désinstallée, jeton
    /// périmé. Il faut le retirer de la base, sinon on paie éternellement des
    /// envois vers le vide.
    Gone,
}

/// Client FCM d'une instance.
pub struct Fcm {
    account: ServiceAccount,
    http: reqwest::Client,
    token: Mutex<Option<CachedToken>>,
}

impl Fcm {
    /// Construit le client si l'instance est configurée. `Ok(None)` signifie
    /// « pas de push ici », ce qui est un déploiement valable, pas une panne.
    pub fn from_config(config: &PushConfig) -> anyhow::Result<Option<Arc<Self>>> {
        let raw = config.fcm_credentials.trim();
        if raw.is_empty() {
            return Ok(None);
        }
        // Le réglage accepte les deux formes utiles : le JSON lui-même (pratique
        // dans une variable d'environnement) ou un chemin vers le fichier
        // (pratique avec un secret monté).
        let json = if raw.starts_with('{') {
            raw.to_string()
        } else {
            std::fs::read_to_string(raw)
                .map_err(|e| anyhow::anyhow!("lecture du compte de service FCM ({raw}) : {e}"))?
        };
        let account: ServiceAccount = serde_json::from_str(&json)
            .map_err(|e| anyhow::anyhow!("compte de service FCM illisible : {e}"))?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("accord2-backend")
            .build()?;
        tracing::info!(project = %account.project_id, "push FCM actif");
        Ok(Some(Arc::new(Self {
            account,
            http,
            token: Mutex::new(None),
        })))
    }

    /// Jeton d'accès Google, renouvelé seulement quand il approche de sa fin.
    async fn access_token(&self) -> Result<String, ApiError> {
        let mut slot = self.token.lock().await;
        if let Some(cached) = slot.as_ref() {
            if cached.fetched_at.elapsed() < TOKEN_TTL {
                return Ok(cached.value.clone());
            }
        }

        let now = chrono::Utc::now().timestamp();
        let claims = Assertion {
            iss: &self.account.client_email,
            scope: SCOPE,
            aud: &self.account.token_uri,
            iat: now,
            exp: now + 3600,
        };
        let key = EncodingKey::from_rsa_pem(self.account.private_key.as_bytes())
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("clé FCM invalide : {e}")))?;
        let assertion = jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("signature FCM : {e}")))?;

        let body = format!(
            "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={}",
            urlencoding_minimal(&assertion)
        );
        let res = self
            .http
            .post(&self.account.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| ApiError::ServiceUnavailable(format!("Google injoignable : {e}")))?;
        let status = res.status();
        let text = res
            .text()
            .await
            .map_err(|e| ApiError::ServiceUnavailable(format!("réponse Google illisible : {e}")))?;
        if !status.is_success() {
            return Err(ApiError::ServiceUnavailable(format!(
                "jeton FCM refusé ({status})"
            )));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("jeton FCM illisible : {e}")))?;
        let token = value["access_token"]
            .as_str()
            .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("jeton FCM absent de la réponse")))?
            .to_string();
        *slot = Some(CachedToken {
            value: token.clone(),
            fetched_at: Instant::now(),
        });
        Ok(token)
    }

    /// Réveille un appareil. Aucun contenu ne quitte le serveur.
    pub async fn wake(
        &self,
        device_token: &str,
        conversation_id: Uuid,
        message_id: &str,
    ) -> Result<Delivery, ApiError> {
        let access = self.access_token().await?;
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.account.project_id
        );
        // Message de DONNÉES uniquement : pas de bloc `notification`, sinon
        // Android afficherait lui-même un texte — que nous n'avons pas, et que
        // nous ne voulons pas lui confier.
        let payload = json!({
            "message": {
                "token": device_token,
                "data": {
                    "conversation_id": conversation_id.to_string(),
                    "message_id": message_id,
                },
                "android": { "priority": "high" },
            }
        });
        let res = self
            .http
            .post(url)
            .header("authorization", format!("Bearer {access}"))
            .header("content-type", "application/json")
            .body(payload.to_string())
            .send()
            .await
            .map_err(|e| ApiError::ServiceUnavailable(format!("FCM injoignable : {e}")))?;

        let status = res.status();
        if status.is_success() {
            return Ok(Delivery::Sent);
        }
        // 404 et 403 signalent un jeton mort ou révoqué : il ne servira plus
        // jamais, autant le retirer que le réessayer indéfiniment.
        if status.as_u16() == 404 || status.as_u16() == 403 {
            return Ok(Delivery::Gone);
        }
        let detail = res.text().await.unwrap_or_default();
        Err(ApiError::ServiceUnavailable(format!(
            "envoi FCM refusé ({status}) : {}",
            detail.chars().take(200).collect::<String>()
        )))
    }
}

/// Encodage de formulaire limité à ce qu'un JWT peut contenir.
///
/// Un JWT est du base64url — `A-Z a-z 0-9 - _` et des points. Seul le `=` de
/// remplissage doit être échappé pour survivre au format `x-www-form-urlencoded`,
/// ce qui évite de tirer une dépendance entière pour trois caractères.
fn urlencoding_minimal(token: &str) -> String {
    token.replace('=', "%3D")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_sans_cle_ne_pousse_rien() {
        let config = PushConfig {
            fcm_credentials: "   ".to_string(),
        };
        assert!(Fcm::from_config(&config).unwrap().is_none());
    }

    #[test]
    fn compte_de_service_illisible_est_une_erreur_franche() {
        // Mieux vaut refuser de démarrer que pousser dans le vide en silence.
        let config = PushConfig {
            fcm_credentials: "{\"project_id\":".to_string(),
        };
        assert!(Fcm::from_config(&config).is_err());
    }

    /// Vérifie la chaîne complète contre Google : lecture du compte de service,
    /// signature RS256, échange contre un jeton d'accès.
    ///
    /// Ignoré par défaut — il exige un vrai compte de service et le réseau. À
    /// lancer après avoir changé de clé, pour distinguer « clé refusée » de
    /// « code cassé », les deux se ressemblant beaucoup vus depuis un téléphone
    /// qui ne sonne pas :
    ///
    /// ```sh
    /// PUSH__FCM_CREDENTIALS=/chemin/compte.json \
    ///   cargo test jeton_google -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "réseau + compte de service réel"]
    async fn jeton_google_obtenu_avec_la_vraie_cle() {
        let credentials = std::env::var("PUSH__FCM_CREDENTIALS")
            .expect("PUSH__FCM_CREDENTIALS doit pointer le compte de service");
        let fcm = Fcm::from_config(&PushConfig {
            fcm_credentials: credentials,
        })
        .expect("compte de service lisible")
        .expect("compte de service non vide");
        let token = fcm.access_token().await.expect("jeton refusé par Google");
        assert!(!token.is_empty());
        println!("jeton obtenu ({} caractères)", token.len());
    }

    #[test]
    fn le_remplissage_base64_survit_au_formulaire() {
        assert_eq!(urlencoding_minimal("aGVsbG8="), "aGVsbG8%3D");
        assert_eq!(urlencoding_minimal("a.b.c"), "a.b.c");
    }
}
