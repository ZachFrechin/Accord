//! Vivre en arrière-plan à la fermeture de la fenêtre.
//!
//! Fermer la fenêtre pendant un appel vocal coupait la communication. C'est le
//! comportement attendu d'un éditeur de texte, pas d'une messagerie : la croix
//! range la fenêtre, elle ne raccroche pas au nez de l'interlocuteur.
//!
//! La fenêtre se cache donc au lieu de se fermer, et une icône dans la zone de
//! notification la ramène. Cette icône est indispensable, pas décorative : une
//! application qui disparaît sans laisser de trace visible donne l'impression
//! d'être fermée alors qu'elle tourne toujours — et l'utilisateur n'a plus aucun
//! moyen de la retrouver ni de la quitter pour de bon.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// L'icône de la zone de notification a bien été créée.
///
/// Sans elle, cacher la fenêtre laisserait un processus fantôme : invisible,
/// introuvable et impossible à quitter. Dans ce cas la croix reprend son
/// comportement d'origine et ferme l'application — perdre un appel en cours est
/// désagréable, se retrouver avec une application qu'on ne peut plus atteindre
/// l'est beaucoup plus.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

/// Ramène la fenêtre au premier plan, qu'elle soit cachée ou simplement derrière.
pub fn show_main(app: &AppHandle) {
    // macOS masque l'APPLICATION quand sa dernière fenêtre visible disparaît.
    // Rendre la fenêtre visible ne suffit alors pas : tant que l'application
    // reste masquée, rien ne s'affiche. Il faut la démasquer d'abord.
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Installe l'icône de la zone de notification et son menu.
///
/// N'échoue jamais vers l'appelant : une icône de barre de menus absente est
/// une gêne, pas une raison de refuser de démarrer.
pub fn init(app: &AppHandle) {
    if let Err(e) = build(app) {
        eprintln!("accord: icône de zone de notification indisponible ({e}) — la croix quittera l'application");
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir Accord", true, None::<&str>)?;
    // « Quitter » doit exister ici : c'est le seul moyen d'arrêter vraiment
    // l'application une fois la fenêtre rangée.
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon().cloned().ok_or_else(|| {
                tauri::Error::AssetNotFound("icône d'application introuvable".into())
            })?,
        )
        .icon_as_template(true)
        .tooltip("Accord")
        .menu(&menu)
        // Le menu ne doit PAS s'ouvrir au clic gauche : ce clic sert à rouvrir la
        // fenêtre, geste attendu partout ailleurs.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(())
}

/// Intercepte la fermeture de la fenêtre pour la cacher.
///
/// Le processus survit — appel en cours, connexion temps réel et notifications
/// continuent. Quitter réellement passe par le menu de la zone de notification,
/// ou par le raccourci système habituel.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        // Pas d'icône dans la barre ? On ne cache rien : mieux vaut fermer que
        // laisser une application qu'on ne peut plus ni retrouver ni quitter.
        if !TRAY_READY.load(Ordering::Relaxed) {
            return;
        }
        api.prevent_close();
        let _ = window.hide();
    }
}
