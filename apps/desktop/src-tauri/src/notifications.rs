//! Native desktop notifications with click-to-open.
//!
//! macOS (bundled): the UserNotifications framework — real permission prompt,
//! the app appears in System Settings → Notifications, and a center delegate
//! receives clicks (the conversation id rides in `userInfo`). A bare
//! `tauri dev` binary cannot register with that framework, so dev falls back
//! to notify-rust (attributed to the terminal, no click).
//!
//! Windows: WinRT toasts via tauri-winrt-notification; `on_activated` delivers
//! the click. Dev builds toast under the PowerShell AUMID (an unregistered
//! AUMID does not toast); installed builds use the app identifier, which the
//! NSIS shortcut registers.
//!
//! Linux: notify-rust over DBus (no click wiring).
//!
//! Click delivery is two-pronged: the conversation id is emitted as an event
//! (running webview) AND stashed as a pending click that the frontend drains
//! once its router is up — covering a click that cold-started the app.

use std::sync::{Mutex, OnceLock};

use tauri::Emitter;

/// Event the frontend listens for; payload = conversation id.
pub const CLICK_EVENT: &str = "accord://notification-clicked";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static PENDING_CLICK: Mutex<Option<String>> = Mutex::new(None);

/// Route a click on a notification (any platform) to the webview.
fn deliver_click(conversation_id: String) {
    *PENDING_CLICK.lock().unwrap() = Some(conversation_id.clone());
    if let Some(app) = APP.get() {
        let _ = app.emit(CLICK_EVENT, conversation_id);
    }
}

/// Install the platform notification machinery. Call once at setup.
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    platform::init();
}

/// One-shot drain of a click that predates the webview's event listener.
#[tauri::command]
pub fn notif_take_pending_click() -> Option<String> {
    PENDING_CLICK.lock().unwrap().take()
}

/// "granted" | "denied" | "default" (macOS asks the framework; others are open).
#[tauri::command]
pub async fn notif_permission_state() -> Result<String, String> {
    platform::permission_state().await
}

/// Ask the OS for permission (macOS system prompt). Returns whether granted.
#[tauri::command]
pub async fn notif_request_permission() -> Result<bool, String> {
    platform::request_permission().await
}

/// Show a notification; `conversation_id` makes a click open that conversation.
#[tauri::command]
pub fn notif_show(
    title: String,
    body: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    platform::show(title, body, conversation_id)
}

// ── macOS ────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::{Block, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{
        ns_string, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSettings, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };

    use super::deliver_click;

    /// A bare `tauri dev` executable has a main bundle without an identifier —
    /// UserNotifications refuses to work for it (and would abort the process).
    fn bundled() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "AccordNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// Default action = the user clicked the notification.
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &Block<dyn Fn()>,
            ) {
                let content = response.notification().request().content();
                let user_info = content.userInfo();
                if let Some(value) = user_info.objectForKey(ns_string!("conversationId")) {
                    if let Ok(s) = value.downcast::<NSString>() {
                        deliver_click(s.to_string());
                    }
                }
                completion.call(());
            }

            /// Keep banners visible while the app is frontmost (maybeNotify has
            /// already filtered out the actively-read conversation).
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &Block<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
            }
        }
    );

    pub fn init() {
        if !bundled() {
            return;
        }
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // One delegate for the process lifetime; the center holds only a weak
        // reference, so deliberately leak our strong one.
        std::mem::forget(delegate);
    }

    pub async fn request_permission() -> Result<bool, String> {
        if !bundled() {
            return Ok(true); // dev fallback (notify-rust) has no permission gate
        }
        let (tx, rx) = mpsc::channel();
        // Scope the block so this future stays Send: the framework copies the
        // block internally, our reference must not live across the await.
        {
            let block = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
                let _ = tx.send(granted.as_bool());
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert
                        | UNAuthorizationOptions::Sound
                        | UNAuthorizationOptions::Badge,
                    &block,
                );
        }
        // The system prompt can sit unanswered for a while — wait generously,
        // off the async runtime.
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(300)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "authorization prompt timed out".to_string())
    }

    pub async fn permission_state() -> Result<String, String> {
        if !bundled() {
            return Ok("granted".to_string());
        }
        let (tx, rx) = mpsc::channel();
        // Same Send-future dance as request_permission: drop our block ref
        // before awaiting (the framework holds its own copy).
        {
            let block = RcBlock::new(
                move |settings: core::ptr::NonNull<UNNotificationSettings>| {
                    let status = unsafe { settings.as_ref() }.authorizationStatus();
                    let _ = tx.send(status);
                },
            );
            UNUserNotificationCenter::currentNotificationCenter()
                .getNotificationSettingsWithCompletionHandler(&block);
        }
        let status =
            tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|_| "notification settings query timed out".to_string())?;
        Ok(match status {
            UNAuthorizationStatus::Denied => "denied",
            UNAuthorizationStatus::NotDetermined => "default",
            // Authorized / Provisional / Ephemeral all deliver.
            _ => "granted",
        }
        .to_string())
    }

    pub fn show(
        title: String,
        body: String,
        conversation_id: Option<String>,
    ) -> Result<(), String> {
        if !bundled() {
            // Dev: deliver via the terminal's identity (no click support).
            let _ = notify_rust::set_application("com.apple.Terminal");
            return notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .show()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        unsafe {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&title));
            content.setBody(&NSString::from_str(&body));
            if let Some(cid) = conversation_id {
                let dict = NSDictionary::from_retained_objects(
                    &[ns_string!("conversationId")],
                    &[Retained::into_super(NSString::from_str(&cid))],
                );
                content.setUserInfo(&Retained::cast_unchecked(dict));
            }
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let id = NSString::from_str(&format!(
                "accord-notif-{}",
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let request =
                UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, None);
        }
        Ok(())
    }
}

// ── Windows ──────────────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use tauri_winrt_notification::Toast;

    use super::deliver_click;

    pub fn init() {}

    pub async fn request_permission() -> Result<bool, String> {
        Ok(true) // Windows has no app-level prompt; Settings governs per-AUMID
    }

    pub async fn permission_state() -> Result<String, String> {
        Ok("granted".to_string())
    }

    pub fn show(
        title: String,
        body: String,
        conversation_id: Option<String>,
    ) -> Result<(), String> {
        // Installed builds toast under the app identifier (the NSIS shortcut
        // registers that AUMID); dev builds ride PowerShell's, which exists on
        // every Windows box.
        let app_id = if tauri::is_dev() {
            Toast::POWERSHELL_APP_ID.to_string()
        } else {
            super::APP
                .get()
                .map(|app| app.config().identifier.clone())
                .unwrap_or_else(|| Toast::POWERSHELL_APP_ID.to_string())
        };
        let mut toast = Toast::new(&app_id).title(&title).text1(&body);
        if let Some(cid) = conversation_id {
            toast = toast.on_activated(move |_arg| {
                deliver_click(cid.clone());
                Ok(())
            });
        }
        toast.show().map_err(|e| e.to_string())
    }
}

// ── Linux ────────────────────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    pub fn init() {}

    pub async fn request_permission() -> Result<bool, String> {
        Ok(true)
    }

    pub async fn permission_state() -> Result<String, String> {
        Ok("granted".to_string())
    }

    pub fn show(
        title: String,
        body: String,
        _conversation_id: Option<String>,
    ) -> Result<(), String> {
        notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .show()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
