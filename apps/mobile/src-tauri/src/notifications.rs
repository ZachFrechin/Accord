//! Notifications système sur Android.
//!
//! Le bureau parle directement aux API natives de chaque plateforme (objc2 côté
//! macOS, WinRT côté Windows) ; ici le plugin officiel de Tauri fait ce travail.
//! Les trois commandes portent volontairement les mêmes noms que sur le bureau,
//! parce que la couche partagée (`lib/notifications.ts`) les appelle sans savoir
//! sur quelle plateforme elle tourne : c'est ce qui permet à toute la politique
//! de notification — silencieux par conversation, mentions seules, ne-pas-
//! déranger — de rester écrite une seule fois.
//!
//! Le texte affiché est déchiffré sur l'appareil. Il n'a jamais circulé en clair,
//! et le volet système est le seul endroit où il apparaît hors de l'application.

use tauri::plugin::PermissionState;
use tauri_plugin_notification::NotificationExt;

/// Traduit l'état natif dans le vocabulaire du web, qu'attend le code partagé.
fn state_str(state: PermissionState) -> String {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        // Rien n'a encore été demandé à l'utilisateur : côté web cela se dit
        // « default », et c'est ce mot que la couche partagée sait lire.
        _ => "default",
    }
    .to_string()
}

#[tauri::command]
pub fn notif_permission_state(app: tauri::AppHandle) -> String {
    app.notification()
        .permission_state()
        .map(state_str)
        .unwrap_or_else(|_| "denied".to_string())
}

#[tauri::command]
pub fn notif_request_permission(app: tauri::AppHandle) -> bool {
    matches!(
        app.notification().request_permission(),
        Ok(PermissionState::Granted)
    )
}

/// Un emplacement de notification par conversation.
///
/// Android remplace une notification quand une nouvelle porte le même
/// identifiant. En dérivant celui-ci de la conversation, une discussion animée
/// occupe une ligne qui se met à jour, au lieu d'empiler vingt lignes et de
/// noyer le reste du volet système.
fn slot(conversation_id: Option<&str>) -> i32 {
    let Some(id) = conversation_id else { return 0 };
    // FNV-1a : court, sans dépendance, et la qualité de dispersion demandée ici
    // se limite à « deux conversations se marchent rarement dessus ».
    let mut hash: u32 = 2_166_136_261;
    for byte in id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    // Le bit de signe est écarté : l'identifiant Android est un entier positif.
    (hash & 0x7fff_ffff) as i32
}

/// Retrouve la conversation derrière un emplacement tapé.
///
/// Android ne rend que l'identifiant numérique de la notification. Plutôt que
/// de réécrire le hachage en TypeScript — où il divergerait un jour de celui-ci
/// et casserait les taps sans bruit — l'appelant envoie les conversations qu'il
/// connaît et le calcul reste ici, en un seul exemplaire.
///
/// Une simple table en mémoire ne suffirait pas : le cas qui compte est
/// justement celui où le système a tué l'application, et où cette table serait
/// vide au réveil.
#[tauri::command]
pub fn notif_conversation_for(slot_id: i32, candidates: Vec<String>) -> Option<String> {
    candidates
        .into_iter()
        .find(|id| slot(Some(id.as_str())) == slot_id)
}

#[tauri::command]
pub fn notif_show(
    app: tauri::AppHandle,
    title: String,
    body: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    app.notification()
        .builder()
        .id(slot(conversation_id.as_deref()))
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
