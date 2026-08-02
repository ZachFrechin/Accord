//! Enregistrement des appareils pour les notifications push.
//!
//! Le téléphone annonce le jeton que Google lui a attribué, et le retire à la
//! déconnexion. Rien d'autre ne transite : ni contenu, ni titre, ni nom de
//! conversation. Ce jeton sert uniquement à réveiller l'appareil, qui ira
//! chercher et déchiffrer le message lui-même.

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::push::Delivery;
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::realtime::presence::{self, PresenceStatus};
use crate::repositories::push_device_repo;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RegisterBody {
    token: String,
    #[serde(default = "default_platform")]
    platform: String,
}

fn default_platform() -> String {
    "android".to_string()
}

/// `POST /push/devices` — enregistre ou rafraîchit un jeton.
pub async fn register(
    State(state): State<AppState>,
    caller: AuthUser,
    Json(body): Json<RegisterBody>,
) -> Result<Json<Value>, ApiError> {
    let token = body.token.trim();
    if token.is_empty() {
        return Err(ApiError::Validation("jeton d'appareil vide".into()));
    }
    // Un serveur sans push accepte quand même l'enregistrement : l'appareil n'a
    // pas à connaître la configuration de l'instance, et le jour où une clé est
    // ajoutée, les appareils déjà inscrits reçoivent sans avoir rien à refaire.
    let id = push_device_repo::upsert(&state.db, caller.user_id, token, &body.platform).await?;
    Ok(Json(json!({
        "device_id": id,
        "push_enabled": state.push.is_some(),
    })))
}

/// Réveille les appareils d'une personne qui n'a aucune connexion vive.
///
/// Détaché de la requête : un message est envoyé à tous les membres d'une
/// conversation, et faire attendre celui qui écrit pendant qu'on parle à Google
/// pour chacun d'eux rendrait l'envoi visiblement lent. Rien ici n'est critique
/// — un push perdu se rattrape à la réouverture de l'application.
///
/// Une connexion temps réel vive vaut refus : le message arrive déjà par le
/// socket, et doubler avec un push ferait sonner le téléphone posé à côté de
/// l'ordinateur sur lequel on est en train de lire.
pub fn wake_absent(state: AppState, user_id: Uuid, conversation_id: Uuid, message_id: String) {
    let Some(fcm) = state.push.clone() else {
        return;
    };
    tokio::spawn(async move {
        match presence::effective_status(&state.redis, user_id).await {
            Ok(seen) if seen.status != PresenceStatus::Offline => return,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = %e, "présence illisible avant push");
                return;
            }
        }
        let devices = match push_device_repo::for_user(&state.db, user_id).await {
            Ok(devices) => devices,
            Err(e) => {
                tracing::warn!(error = %e, "appareils illisibles avant push");
                return;
            }
        };
        for device in devices {
            match fcm.wake(&device.token, conversation_id, &message_id).await {
                Ok(Delivery::Sent) => {}
                Ok(Delivery::Gone) => {
                    // Application désinstallée ou jeton périmé : le garder
                    // reviendrait à payer un aller-retour par message, à vie.
                    if let Err(e) = push_device_repo::delete(&state.db, &device.token).await {
                        tracing::warn!(error = %e, "retrait d'un jeton mort impossible");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "réveil par push échoué"),
            }
        }
    });
}

#[derive(Debug, Deserialize)]
pub struct UnregisterBody {
    token: String,
}

/// `DELETE /push/devices` — retire un jeton (déconnexion).
pub async fn unregister(
    State(state): State<AppState>,
    _caller: AuthUser,
    Json(body): Json<UnregisterBody>,
) -> Result<Json<Value>, ApiError> {
    push_device_repo::delete(&state.db, body.token.trim()).await?;
    Ok(Json(json!({ "ok": true })))
}
