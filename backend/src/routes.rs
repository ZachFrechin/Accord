//! Router assembly and the global middleware stack.
//!
//! [`build_router`] mounts the health endpoints and wraps them in the shared
//! middleware: panic capture, request-id, tracing, CORS, and a request timeout.
//! Business routes get added here in later phases; Phase 0 exposes only health.

use std::time::Duration;

use axum::Router;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::routing::{delete, get, patch, post, put};
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::CorsLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::config::AppConfig;
use crate::controllers::{
    admin_controller, auth_controller, call_controller, conversation_controller, friend_controller,
    games_controller, keys_controller, levels_controller, mls_group_controller,
    mls_keys_controller, presence_controller, push_controller, transparency_controller,
    upload_controller, user_controller, ws_controller,
};
use crate::health;
use crate::middleware::request_context::{REQUEST_ID_HEADER, make_request_span};
use crate::state::AppState;

/// Hard ceiling on how long any single request may run before the server
/// returns `408`. Protects worker threads from hung handlers.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Builds the fully-wired application router from shared [`AppState`].
///
/// Layer order is significant. Reading outermost-inward: `CatchPanic` turns a
/// panicking handler into a `500` instead of dropping the connection;
/// `SetRequestId` stamps a correlation id *before* `Trace` so the span records
/// it; `PropagateRequestId` echoes it on the response; `Cors` enforces the
/// allowlist; `Timeout` bounds handler runtime.
pub fn build_router(state: AppState) -> Router {
    let cors = build_cors_layer(&state.config);

    let middleware = ServiceBuilder::new()
        .layer(CatchPanicLayer::new())
        .layer(SetRequestIdLayer::new(REQUEST_ID_HEADER, MakeRequestUuid))
        .layer(TraceLayer::new_for_http().make_span_with(make_request_span))
        .layer(PropagateRequestIdLayer::new(REQUEST_ID_HEADER))
        .layer(cors)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ));

    Router::new()
        .route("/health/live", get(health::live))
        .route("/health/ready", get(health::ready))
        .route(
            "/integrations/youtube/player",
            get(call_controller::youtube_bridge),
        )
        .route("/.well-known/jwks.json", get(auth_controller::jwks))
        .route("/auth/register", post(auth_controller::register))
        .route("/auth/verify-email", post(auth_controller::verify_email))
        .route(
            "/auth/resend-verification",
            post(auth_controller::resend_verification),
        )
        .route("/auth/login", post(auth_controller::login))
        .route("/auth/login/totp", post(auth_controller::login_totp))
        .route("/auth/refresh", post(auth_controller::refresh))
        .route("/auth/totp", get(auth_controller::totp_status))
        .route("/auth/totp/enroll", post(auth_controller::enroll_totp))
        .route(
            "/auth/totp/enroll/confirm",
            post(auth_controller::confirm_totp),
        )
        .route("/auth/totp/disable", post(auth_controller::disable_totp))
        .route(
            "/auth/password-reset/request",
            post(auth_controller::password_reset_request),
        )
        .route(
            "/auth/password-reset/confirm",
            post(auth_controller::password_reset_confirm),
        )
        .route("/auth/logout", post(auth_controller::logout))
        .route("/auth/sessions", get(auth_controller::list_sessions))
        .route(
            "/auth/sessions/revoke-all",
            post(auth_controller::revoke_all),
        )
        .route(
            "/auth/sessions/{id}",
            delete(auth_controller::revoke_session),
        )
        .route("/ws", get(ws_controller::ws_handler))
        .route("/ws/ticket", post(ws_controller::issue_ticket))
        .route("/realtime/echo", post(ws_controller::echo))
        .route("/presences", get(presence_controller::snapshot))
        .route("/me/profile", patch(user_controller::update_my_profile))
        .route(
            "/me/avatar",
            post(user_controller::request_avatar_upload).delete(user_controller::delete_avatar),
        )
        .route("/me/avatar/commit", post(user_controller::commit_avatar))
        .route(
            "/me/banner",
            post(user_controller::request_banner_upload).delete(user_controller::delete_banner),
        )
        .route("/me/banner/commit", post(user_controller::commit_banner))
        .route(
            "/users/{user_id}/profile",
            get(user_controller::get_profile),
        )
        .route("/friends", get(friend_controller::list_friends))
        .route("/friends/requests", post(friend_controller::send_request))
        .route(
            "/friends/requests/{user_id}/accept",
            post(friend_controller::accept_request),
        )
        .route(
            "/friends/requests/{user_id}/decline",
            post(friend_controller::decline_request),
        )
        .route(
            "/friends/{user_id}/block",
            post(friend_controller::block_user),
        )
        .route(
            "/friends/{user_id}",
            delete(friend_controller::remove_friend),
        )
        .route("/keys/devices", post(keys_controller::publish))
        .route("/keys/devices/{device_id}", delete(keys_controller::revoke))
        .route("/keys/users/{user_id}", get(keys_controller::bundle))
        .route("/transparency/sth", get(transparency_controller::sth))
        .route(
            "/transparency/inclusion/{user_id}/{device_id}",
            get(transparency_controller::inclusion),
        )
        .route(
            "/transparency/consistency",
            get(transparency_controller::consistency),
        )
        .route("/mls/key-packages", post(mls_keys_controller::publish))
        .route("/mls/key-packages/claim", post(mls_keys_controller::claim))
        .route(
            "/mls/key-packages/count/{device_id}",
            get(mls_keys_controller::count),
        )
        .route("/mls/groups/{group_id}", post(mls_group_controller::create))
        .route(
            "/mls/groups/{group_id}/commit",
            post(mls_group_controller::commit),
        )
        .route(
            "/mls/groups/{group_id}/frames",
            get(mls_group_controller::frames).post(mls_group_controller::frame),
        )
        .route("/mls/welcomes", get(mls_group_controller::welcomes))
        .route(
            "/mls/welcomes/{id}/ack",
            post(mls_group_controller::ack_welcome),
        )
        .route(
            "/conversations",
            get(conversation_controller::list_conversations),
        )
        .route("/conversations/dm", post(conversation_controller::open_dm))
        .route(
            "/conversations/group",
            post(conversation_controller::create_group),
        )
        .route(
            "/conversations/{conversation_id}",
            patch(conversation_controller::rename_group),
        )
        .route(
            "/conversations/{conversation_id}/avatar",
            post(conversation_controller::request_group_avatar_upload),
        )
        .route(
            "/conversations/{conversation_id}/avatar/commit",
            post(conversation_controller::commit_group_avatar),
        )
        .route(
            "/conversations/{conversation_id}/messages",
            get(conversation_controller::list_messages).post(conversation_controller::send_message),
        )
        .route(
            "/conversations/{conversation_id}/messages/{message_id}",
            patch(conversation_controller::edit_message)
                .delete(conversation_controller::delete_message),
        )
        .route(
            "/conversations/{conversation_id}/messages/{message_id}/reactions",
            get(conversation_controller::list_reactions)
                .post(conversation_controller::toggle_reaction),
        )
        .route(
            "/conversations/{conversation_id}/read",
            post(conversation_controller::mark_read),
        )
        .route(
            "/conversations/{conversation_id}/moderation/tombstone",
            post(conversation_controller::moderate_tombstone),
        )
        .route(
            "/conversations/{conversation_id}/mls/tombstones",
            get(conversation_controller::list_mls_tombstones),
        )
        .route(
            "/conversations/{conversation_id}/call/token",
            post(call_controller::mint_token),
        )
        .route(
            "/conversations/{conversation_id}/call/ring",
            post(call_controller::ring),
        )
        .route(
            "/conversations/{conversation_id}/call/end",
            post(call_controller::end),
        )
        .route(
            "/conversations/{conversation_id}/call/join",
            post(call_controller::join),
        )
        .route(
            "/conversations/{conversation_id}/call/leave",
            post(call_controller::leave),
        )
        .route(
            "/conversations/{conversation_id}/call/heartbeat",
            post(call_controller::heartbeat),
        )
        .route(
            "/conversations/{conversation_id}/call",
            get(call_controller::call_state_get),
        )
        .route(
            "/conversations/{conversation_id}/call/media",
            get(call_controller::media_get).put(call_controller::media_put),
        )
        .route(
            "/conversations/{conversation_id}/call/media/sounds",
            post(call_controller::sound_trigger),
        )
        .route(
            "/conversations/{conversation_id}/protocol",
            post(conversation_controller::set_protocol),
        )
        .route(
            "/conversations/{conversation_id}/members",
            get(conversation_controller::list_members).post(conversation_controller::add_member),
        )
        .route(
            "/conversations/{conversation_id}/members/{user_id}",
            delete(conversation_controller::remove_member),
        )
        .route(
            "/push/devices",
            post(push_controller::register).delete(push_controller::unregister),
        )
        .route("/games/accounts", get(games_controller::mine))
        .route(
            "/games/accounts/{game}",
            put(games_controller::link).delete(games_controller::unlink),
        )
        .route(
            "/games/accounts/{game}/refresh",
            post(games_controller::refresh),
        )
        .route("/users/{user_id}/games", get(games_controller::of_user))
        .route("/levels/me", get(levels_controller::me))
        .route("/levels/users/{user_id}", get(levels_controller::user))
        .route("/levels/leaderboard", get(levels_controller::leaderboard))
        .route("/admin/stats", get(admin_controller::stats))
        .route("/admin/me", get(admin_controller::my_permissions))
        .route("/admin/audit", get(admin_controller::audit_log))
        .route("/admin/users", get(admin_controller::list_users))
        .route(
            "/admin/conversations",
            get(admin_controller::list_conversations).post(admin_controller::create_group),
        )
        .route(
            "/admin/conversations/{conversation_id}",
            delete(admin_controller::delete_conversation),
        )
        .route(
            "/admin/conversations/{conversation_id}/messages",
            get(admin_controller::list_messages),
        )
        .route(
            "/admin/roles",
            get(admin_controller::list_roles).post(admin_controller::create_role),
        )
        .route(
            "/admin/roles/{role_id}",
            patch(admin_controller::update_role).delete(admin_controller::delete_role),
        )
        .route(
            "/admin/users/{user_id}/roles",
            put(admin_controller::set_user_roles),
        )
        .route(
            "/admin/users/{user_id}/suspend",
            post(admin_controller::suspend_user),
        )
        .route(
            "/admin/users/{user_id}/reinstate",
            post(admin_controller::reinstate_user),
        )
        .route(
            "/admin/users/{user_id}/password/temporary",
            post(admin_controller::temporary_password),
        )
        .route(
            "/admin/users/{user_id}/password/link",
            post(admin_controller::send_reset_link),
        )
        .route(
            "/admin/users/{user_id}/level",
            put(admin_controller::set_level),
        )
        .route(
            "/admin/roles/{role_id}/suspension",
            post(admin_controller::set_role_suspension),
        )
        .route(
            "/admin/users/{user_id}",
            patch(admin_controller::update_user),
        )
        .route("/uploads", post(upload_controller::request_upload))
        .route("/uploads/{blob_id}", get(upload_controller::download_url))
        .layer(middleware)
        .with_state(state)
}

/// Builds a CORS layer from the configured origin allowlist.
///
/// Origins are matched exactly — we **never** fall back to a permissive `*`
/// policy. An empty or fully-invalid allowlist yields a layer that rejects all
/// cross-origin browser requests, which is the safe default. Malformed entries
/// are skipped with a warning rather than aborting boot.
fn build_cors_layer(config: &AppConfig) -> CorsLayer {
    let origins: Vec<HeaderValue> = config
        .server
        .cors_allowed_origins
        .iter()
        .filter_map(|origin| match origin.parse::<HeaderValue>() {
            Ok(value) => Some(value),
            Err(err) => {
                tracing::warn!(%origin, error = %err, "ignoring invalid CORS origin");
                None
            }
        })
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            REQUEST_ID_HEADER,
        ])
}
