//! Auth core controller — registration, email verification, login, refresh
//! rotation (with reuse detection), logout, session management, and JWKS.
//!
//! Security posture: passwords are Argon2id-hashed off the async runtime and
//! screened against HIBP; responses are shaped to avoid account enumeration
//! (username collisions are explicit, email collisions are not); refresh tokens
//! rotate and a reused token revokes the whole session family (RFC 9700).

use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::header::USER_AGENT;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::password::{self, Argon2Params};
use crate::domain::{recovery, secrets, totp, validation};
use crate::error::ApiError;
use crate::middleware::auth::{self, AuthUser};
use crate::middleware::rate_limit;
use crate::repositories::session_repo::{self, RefreshOutcome};
use crate::repositories::user_repo::{self, User};
use crate::repositories::{totp_repo, verification_repo};
use crate::state::AppState;

/// Short-lived MFA challenge lifetime (between password success and 2FA code).
const MFA_CHALLENGE_TTL_SECS: i64 = 300;

/// Email-verification link lifetime.
const EMAIL_VERIFY_TTL_HOURS: i64 = 24;

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// Registration request.
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

/// Email-verification request (token from the emailed link).
#[derive(Debug, Deserialize)]
pub struct VerifyEmailRequest {
    pub token: String,
}

/// Login request — identifier may be a username or an email.
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username_or_email: String,
    pub password: String,
}

/// Refresh request.
#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

/// Public projection of a user (never exposes the password hash).
#[derive(Debug, Serialize)]
pub struct UserDto {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub email_verified: bool,
    /// Instance-level role: `member` or `admin` (gates the admin panel).
    pub role: String,
}

impl From<&User> for UserDto {
    fn from(u: &User) -> Self {
        Self {
            id: u.id,
            username: u.username.clone(),
            email: u.email.clone(),
            email_verified: u.email_verified_at.is_some(),
            role: u.role.clone(),
        }
    }
}

/// Token pair returned on login/refresh.
#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub user: UserDto,
}

/// A password-verified login that still needs a second factor. The client posts
/// `challenge` + the TOTP (or recovery) code to `/auth/login/totp` for the tokens.
#[derive(Debug, Serialize)]
pub struct MfaChallenge {
    pub status: &'static str, // "totp_required"
    pub challenge: String,
    pub expires_in: i64,
}

/// Login outcome — either the tokens, or a 2FA challenge. Untagged: the client
/// distinguishes on the presence of `access_token` vs `challenge`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum LoginResponse {
    Challenge(MfaChallenge),
    Tokens(Box<TokenResponse>),
}

/// Second-factor step of login.
#[derive(Debug, Deserialize)]
pub struct LoginTotpRequest {
    pub challenge: String,
    pub code: String,
}

/// TOTP enrollment secret (shown once, for the QR / manual entry).
#[derive(Debug, Serialize)]
pub struct TotpEnrollResponse {
    /// Base32 secret for manual entry.
    pub secret: String,
    /// `otpauth://` URI to render as a QR code.
    pub otpauth_uri: String,
}

/// Confirm a pending TOTP enrollment with a first code.
#[derive(Debug, Deserialize)]
pub struct TotpCodeRequest {
    pub code: String,
}

/// Result of enabling TOTP — the fresh recovery codes (shown once).
#[derive(Debug, Serialize)]
pub struct TotpEnabledResponse {
    pub status: &'static str, // "enabled"
    pub recovery_codes: Vec<String>,
}

/// Disable TOTP — re-authenticate with the password.
#[derive(Debug, Deserialize)]
pub struct TotpDisableRequest {
    pub password: String,
}

/// A session as shown to its owner.
#[derive(Debug, Serialize)]
pub struct SessionDto {
    pub id: Uuid,
    pub device_label: Option<String>,
    pub user_agent: Option<String>,
    pub ip: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    /// Whether this is the session the request authenticated with.
    pub current: bool,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// `POST /auth/register` — create an inactive account and send a verification
/// email. Recovery codes are issued later, at verification time.
pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<RegisterRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let rl = &state.config.rate_limit;
    rate_limit::check(
        &state.redis,
        &format!("rl:register:ip:{}", addr.ip()),
        rl.register_window_secs,
        rl.register_max,
    )
    .await?;

    let username = validation::validate_username(&req.username)?;
    let email = validation::validate_email(&req.email)?;
    validation::validate_password(&req.password, state.config.auth.min_password_len)?;

    // Username is a public identifier — a clear "taken" message is expected UX.
    if user_repo::find_by_username(&state.db, &username)
        .await?
        .is_some()
    {
        return Err(ApiError::Conflict("username is already taken".to_string()));
    }

    // HIBP screening. Fail open on a third-party outage — never block signup.
    if state.config.auth.hibp_enabled {
        match password::is_pwned(&req.password).await {
            Ok(true) => {
                return Err(ApiError::Validation(
                    "this password appears in known data breaches; please choose another"
                        .to_string(),
                ));
            }
            Ok(false) => {}
            Err(()) => tracing::warn!("HIBP screening unavailable; allowing registration"),
        }
    }

    let params: Argon2Params = (&state.config.auth).into();
    let hash = password::hash_password(req.password, params).await?;

    match user_repo::create(&state.db, &username, &email, &hash).await {
        Ok(user) => {
            // Bootstrap admin: an email listed in AUTH__BOOTSTRAP_ADMIN_EMAILS is
            // promoted the moment it registers — a fresh instance has no admin
            // who could promote it from the panel yet.
            let bootstrap_admin = state
                .config
                .auth
                .bootstrap_admin_emails
                .iter()
                .any(|e| e.trim().eq_ignore_ascii_case(&user.email));
            if bootstrap_admin {
                user_repo::set_role(&state.db, user.id, "admin").await?;
                tracing::info!(user_id = %user.id, "bootstrap admin email registered; role promoted");
            }
            let token = secrets::random_token();
            let token_hash = secrets::sha256(token.as_bytes());
            let expires = Utc::now() + Duration::hours(EMAIL_VERIFY_TTL_HOURS);
            verification_repo::create_email_verification(&state.db, user.id, &token_hash, expires)
                .await?;
            let link = format!(
                "{}/auth/verify-email?token={}",
                state.config.server.public_url.trim_end_matches('/'),
                token
            );
            verification_repo::enqueue_email(
                &state.db,
                &user.email,
                "verify_email",
                &json!({ "username": user.username, "verify_url": link }),
            )
            .await?;
            tracing::info!(user_id = %user.id, "registered; verification email enqueued");
        }
        // Email already registered — do NOT reveal it. Enqueue a notice and fall
        // through to the same generic response as a fresh registration.
        Err(ApiError::Conflict(_)) => {
            let _ = verification_repo::enqueue_email(
                &state.db,
                &email,
                "account_exists",
                &json!({ "email": email }),
            )
            .await;
            tracing::info!("registration for an existing email; generic response returned");
        }
        Err(other) => return Err(other),
    }

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "status": "verification_required" })),
    ))
}

/// `POST /auth/verify-email` — activate the account and return its one-time
/// recovery codes (shown exactly once).
pub async fn verify_email(
    State(state): State<AppState>,
    Json(req): Json<VerifyEmailRequest>,
) -> Result<Json<Value>, ApiError> {
    let token_hash = secrets::sha256(req.token.as_bytes());
    let user_id = verification_repo::consume_email_verification(&state.db, &token_hash)
        .await?
        .ok_or_else(|| ApiError::Validation("invalid or expired verification link".to_string()))?;

    user_repo::mark_email_verified(&state.db, user_id).await?;

    let params: Argon2Params = (&state.config.auth).into();
    let codes = recovery::generate_set(params).await?;
    verification_repo::insert_recovery_codes(&state.db, user_id, &codes.hashes).await?;
    tracing::info!(user_id = %user_id, "email verified; account activated");

    Ok(Json(
        json!({ "status": "verified", "recovery_codes": codes.plaintext }),
    ))
}

/// Verification-email resend request (identified by email).
#[derive(Debug, Deserialize)]
pub struct ResendVerificationRequest {
    pub email: String,
}

/// `POST /auth/resend-verification` — re-issue a verification link if the address
/// belongs to a still-unverified account (the verification email is otherwise only
/// sent once, at registration, so a lost link is a dead end). Always returns the
/// same generic 200 as `register`, revealing neither whether the account exists nor
/// whether it is already verified. Rate-limited per IP like registration; a fresh
/// token is inserted (prior tokens stay valid until they expire).
pub async fn resend_verification(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<ResendVerificationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let rl = &state.config.rate_limit;
    rate_limit::check(
        &state.redis,
        &format!("rl:resend-verify:ip:{}", addr.ip()),
        rl.register_window_secs,
        rl.register_max,
    )
    .await?;

    let email = req.email.trim().to_lowercase();
    if let Some(user) = user_repo::find_by_email(&state.db, &email).await?
        && user.email_verified_at.is_none()
    {
        let token = secrets::random_token();
        let token_hash = secrets::sha256(token.as_bytes());
        let expires = Utc::now() + Duration::hours(EMAIL_VERIFY_TTL_HOURS);
        verification_repo::create_email_verification(&state.db, user.id, &token_hash, expires)
            .await?;
        let link = format!(
            "{}/auth/verify-email?token={}",
            state.config.server.public_url.trim_end_matches('/'),
            token
        );
        verification_repo::enqueue_email(
            &state.db,
            &user.email,
            "verify_email",
            &json!({ "username": user.username, "verify_url": link }),
        )
        .await?;
        tracing::info!(user_id = %user.id, "verification email re-sent");
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "status": "verification_required" })),
    ))
}

/// Password-reset link lifetime.
const PASSWORD_RESET_TTL_HOURS: i64 = 1;

/// Password-reset request (identified by email).
#[derive(Debug, Deserialize)]
pub struct PasswordResetRequest {
    pub email: String,
}

/// Password-reset confirmation (token from the emailed link + new password).
#[derive(Debug, Deserialize)]
pub struct PasswordResetConfirm {
    pub token: String,
    pub new_password: String,
}

/// `POST /auth/password-reset/request` — email a reset link if the address is
/// known. Always returns a generic 200 so the response reveals nothing.
pub async fn password_reset_request(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<PasswordResetRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let rl = &state.config.rate_limit;
    rate_limit::check(
        &state.redis,
        &format!("rl:reset:ip:{}", addr.ip()),
        rl.reset_window_secs,
        rl.reset_max,
    )
    .await?;

    let email = req.email.trim().to_lowercase();
    if let Some(user) = user_repo::find_by_email(&state.db, &email).await? {
        let token = secrets::random_token();
        let token_hash = secrets::sha256(token.as_bytes());
        let expires = Utc::now() + Duration::hours(PASSWORD_RESET_TTL_HOURS);
        verification_repo::create_password_reset(&state.db, user.id, &token_hash, expires).await?;
        let link = format!(
            "{}/auth/password-reset/confirm?token={}",
            state.config.server.public_url.trim_end_matches('/'),
            token
        );
        verification_repo::enqueue_email(
            &state.db,
            &user.email,
            "password_reset",
            &json!({ "reset_url": link }),
        )
        .await?;
        tracing::info!(user_id = %user.id, "password reset requested; email enqueued");
    }
    Ok((
        StatusCode::OK,
        Json(json!({ "status": "reset_email_sent" })),
    ))
}

/// `POST /auth/password-reset/confirm` — set a new password, revoke ALL sessions,
/// and send a security notice.
pub async fn password_reset_confirm(
    State(state): State<AppState>,
    Json(req): Json<PasswordResetConfirm>,
) -> Result<impl IntoResponse, ApiError> {
    validation::validate_password(&req.new_password, state.config.auth.min_password_len)?;
    if state.config.auth.hibp_enabled
        && let Ok(true) = password::is_pwned(&req.new_password).await
    {
        return Err(ApiError::Validation(
            "this password appears in known data breaches; please choose another".to_string(),
        ));
    }

    let token_hash = secrets::sha256(req.token.as_bytes());
    let user_id = verification_repo::consume_password_reset(&state.db, &token_hash)
        .await?
        .ok_or_else(|| ApiError::Validation("invalid or expired reset link".to_string()))?;

    let params: Argon2Params = (&state.config.auth).into();
    let hash = password::hash_password(req.new_password, params).await?;
    user_repo::set_password(&state.db, user_id, &hash).await?;

    // A reset invalidates every login: revoke all sessions and flip Redis flags.
    for id in session_repo::revoke_all_for_user(&state.db, user_id).await? {
        auth::mark_session_revoked(&state, id).await;
    }

    if let Some(user) = user_repo::find_by_id(&state.db, user_id).await? {
        let _ =
            verification_repo::enqueue_email(&state.db, &user.email, "security_alert", &json!({}))
                .await;
    }
    tracing::info!(user_id = %user_id, "password reset; all sessions revoked");
    Ok((StatusCode::OK, Json(json!({ "status": "password_reset" }))))
}

/// `POST /auth/login` — validate credentials and issue a session + token pair.
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let params: Argon2Params = (&state.config.auth).into();
    let rl = &state.config.rate_limit;
    let ip = addr.ip().to_string();
    let identifier = req.username_or_email.trim().to_lowercase();

    // Per-IP volume throttle (generous — does not lock out shared NAT addresses).
    rate_limit::check(
        &state.redis,
        &format!("rl:login:ip:{ip}"),
        rl.login_window_secs,
        rl.login_max,
    )
    .await?;

    let user = if identifier.contains('@') {
        user_repo::find_by_email(&state.db, &identifier).await?
    } else {
        user_repo::find_by_username(&state.db, &identifier).await?
    };

    // Lockout key = the account id when it exists (robust against alternating the
    // username/email form), otherwise the typed identifier.
    let lockout_key = user
        .as_ref()
        .map(|u| u.id.to_string())
        .unwrap_or_else(|| format!("id:{identifier}"));

    if rate_limit::is_account_locked(&state.redis, &lockout_key, rl.login_fail_threshold).await? {
        return Err(ApiError::TooManyRequests(
            "too many failed attempts; please try again later".to_string(),
        ));
    }

    let user = match user {
        Some(user) => user,
        None => {
            // Equalize timing against a real verify so absence is not observable.
            password::dummy_verify(params).await;
            let _ = rate_limit::record_login_failure(
                &state.redis,
                &lockout_key,
                rl.login_fail_window_secs,
            )
            .await;
            return Err(ApiError::Unauthorized("invalid credentials".to_string()));
        }
    };

    if !password::verify_password(req.password, user.password_hash.clone()).await? {
        let _ =
            rate_limit::record_login_failure(&state.redis, &lockout_key, rl.login_fail_window_secs)
                .await;
        return Err(ApiError::Unauthorized("invalid credentials".to_string()));
    }

    // Clear message when the account is not yet active (email unverified). Email
    // is mandatory, so guiding the user beats maximal enumeration resistance on
    // this particular signal (decided).
    if !user.is_active {
        return Err(ApiError::Forbidden(
            "please verify your email address before signing in".to_string(),
        ));
    }

    // Successful login clears the failed-attempt counter.
    let _ = rate_limit::clear_login_failures(&state.redis, &lockout_key).await;

    // Second factor: a CONFIRMED TOTP enrollment gates token issue behind a
    // short-lived challenge. Checked only after a correct password, so it reveals
    // 2FA status to no one who doesn't already hold valid credentials.
    if let Some(row) = totp_repo::get(&state.db, user.id).await?
        && row.confirmed_at.is_some()
    {
        let challenge = mint_mfa_challenge(&state, user.id).await?;
        return Ok(Json(LoginResponse::Challenge(MfaChallenge {
            status: "totp_required",
            challenge,
            expires_in: MFA_CHALLENGE_TTL_SECS,
        })));
    }

    let response = issue_session(&state, &user, device_context(&headers, addr)).await?;
    Ok(Json(LoginResponse::Tokens(Box::new(response))))
}

/// `POST /auth/login/totp` — second step of a 2FA login: verify the TOTP (or a
/// one-time recovery) code against the challenge, then issue the token pair.
pub async fn login_totp(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginTotpRequest>,
) -> Result<Json<TokenResponse>, ApiError> {
    let rl = &state.config.rate_limit;

    // Per-IP volume throttle (like /auth/login) so one challenge can't drive a
    // burst of concurrent guesses that outruns the per-user lockout.
    let ip = addr.ip().to_string();
    rate_limit::check(
        &state.redis,
        &format!("rl:mfa:ip:{ip}"),
        rl.login_window_secs,
        rl.login_max,
    )
    .await?;

    // Resolve the challenge WITHOUT consuming it yet, so a mistyped digit doesn't
    // force a fresh password login (the per-user rate limit below bounds guesses).
    let user_id = match peek_mfa_challenge(&state, &req.challenge).await? {
        Some(id) => id,
        None => {
            return Err(ApiError::Unauthorized(
                "invalid or expired challenge".to_string(),
            ));
        }
    };

    let lockout_key = format!("mfa:{user_id}");
    if rate_limit::is_account_locked(&state.redis, &lockout_key, rl.login_fail_threshold).await? {
        return Err(ApiError::TooManyRequests(
            "too many attempts; please try again later".to_string(),
        ));
    }

    let user = user_repo::find_by_id(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::Unauthorized("invalid or expired challenge".to_string()))?;

    if !verify_second_factor(&state, &user, &req.code).await? {
        if let Err(err) =
            rate_limit::record_login_failure(&state.redis, &lockout_key, rl.login_fail_window_secs)
                .await
        {
            tracing::warn!(error = %err, "failed to record MFA login failure (lockout may not advance)");
        }
        return Err(ApiError::Unauthorized("invalid code".to_string()));
    }

    // Success: consume the challenge single-use (a concurrent request loses the
    // GETDEL race and is rejected).
    if consume_mfa_challenge(&state, &req.challenge)
        .await?
        .is_none()
    {
        return Err(ApiError::Unauthorized(
            "invalid or expired challenge".to_string(),
        ));
    }
    let _ = rate_limit::clear_login_failures(&state.redis, &lockout_key).await;

    let response = issue_session(&state, &user, device_context(&headers, addr)).await?;
    Ok(Json(response))
}

/// `POST /auth/refresh` — rotate the refresh token; a reused token revokes the
/// whole session family.
pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<TokenResponse>, ApiError> {
    let old_hash = secrets::sha256(req.refresh_token.as_bytes());
    let new_plain = secrets::random_token();
    let new_hash = secrets::sha256(new_plain.as_bytes());
    let new_expires = Utc::now() + Duration::days(state.config.auth.refresh_ttl_days);

    match session_repo::rotate_refresh(&state.db, &old_hash, &new_hash, new_expires).await? {
        RefreshOutcome::NotFound => {
            Err(ApiError::Unauthorized("invalid refresh token".to_string()))
        }
        RefreshOutcome::Reuse { session_id } => {
            session_repo::revoke_session(&state.db, session_id).await?;
            auth::mark_session_revoked(&state, session_id).await;
            tracing::warn!(%session_id, "refresh token reuse detected; session family revoked");
            Err(ApiError::Unauthorized("invalid refresh token".to_string()))
        }
        RefreshOutcome::Rotated {
            session_id,
            user_id,
        } => {
            let user = user_repo::find_by_id(&state.db, user_id)
                .await?
                .ok_or_else(|| ApiError::Unauthorized("invalid refresh token".to_string()))?;
            if user.disabled_at.is_some() {
                return Err(ApiError::Forbidden(
                    "this account has been suspended".to_string(),
                ));
            }
            let access = mint_access(&state, user_id, session_id)?;
            Ok(Json(TokenResponse {
                access_token: access,
                refresh_token: new_plain,
                token_type: "Bearer",
                expires_in: state.config.auth.access_ttl_secs,
                user: UserDto::from(&user),
            }))
        }
    }
}

/// `POST /auth/logout` — revoke the current session.
pub async fn logout(State(state): State<AppState>, user: AuthUser) -> Result<StatusCode, ApiError> {
    session_repo::revoke_session(&state.db, user.session_id).await?;
    auth::mark_session_revoked(&state, user.session_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /auth/sessions` — list the caller's active sessions.
pub async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<SessionDto>>, ApiError> {
    let sessions = session_repo::list_active(&state.db, user.user_id).await?;
    let dtos = sessions
        .into_iter()
        .map(|s| SessionDto {
            current: s.id == user.session_id,
            id: s.id,
            device_label: s.device_label,
            user_agent: s.user_agent,
            ip: s.ip,
            created_at: s.created_at,
            last_used_at: s.last_used_at,
        })
        .collect();
    Ok(Json(dtos))
}

/// `DELETE /auth/sessions/{id}` — revoke one of the caller's sessions.
pub async fn revoke_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    if !session_repo::revoke_owned(&state.db, user.user_id, id).await? {
        return Err(ApiError::NotFound("session not found".to_string()));
    }
    auth::mark_session_revoked(&state, id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /auth/sessions/revoke-all` — revoke every session of the caller.
pub async fn revoke_all(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<StatusCode, ApiError> {
    let revoked = session_repo::revoke_all_for_user(&state.db, user.user_id).await?;
    for id in revoked {
        auth::mark_session_revoked(&state, id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /.well-known/jwks.json` — the Ed25519 public key set for token verifiers.
pub async fn jwks(State(state): State<AppState>) -> Json<Value> {
    Json(state.keyring.jwks().clone())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Device metadata captured for a new session.
struct DeviceContext {
    user_agent: Option<String>,
    ip: Option<String>,
}

/// Extracts a (truncated) user-agent and the peer IP for session bookkeeping.
fn device_context(headers: &HeaderMap, addr: SocketAddr) -> DeviceContext {
    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(300).collect());
    DeviceContext {
        user_agent,
        ip: Some(addr.ip().to_string()),
    }
}

/// Creates a session, issues its first refresh token, and mints an access token.
async fn issue_session(
    state: &AppState,
    user: &User,
    device: DeviceContext,
) -> Result<TokenResponse, ApiError> {
    // Single chokepoint for token issue: a suspended account gets no session,
    // whichever login path (password or 2FA) led here.
    if user.disabled_at.is_some() {
        return Err(ApiError::Forbidden(
            "this account has been suspended".to_string(),
        ));
    }
    let now = Utc::now();
    let absolute_expiry = now + Duration::days(state.config.auth.session_absolute_ttl_days);
    let session = session_repo::create_session(
        &state.db,
        user.id,
        None,
        device.user_agent.as_deref(),
        device.ip.as_deref(),
        absolute_expiry,
    )
    .await?;

    let refresh_plain = secrets::random_token();
    let refresh_hash = secrets::sha256(refresh_plain.as_bytes());
    let refresh_expires = now + Duration::days(state.config.auth.refresh_ttl_days);
    session_repo::issue_refresh(&state.db, session.id, &refresh_hash, refresh_expires).await?;

    let access = mint_access(state, user.id, session.id)?;
    Ok(TokenResponse {
        access_token: access,
        refresh_token: refresh_plain,
        token_type: "Bearer",
        expires_in: state.config.auth.access_ttl_secs,
        user: UserDto::from(user),
    })
}

/// Mints a short-lived access token for `(user, session)`.
fn mint_access(state: &AppState, user_id: Uuid, session_id: Uuid) -> Result<String, ApiError> {
    let now = Utc::now();
    let exp = now + Duration::seconds(state.config.auth.access_ttl_secs);
    state.keyring.mint_access(
        &state.config.server.public_url,
        &user_id.to_string(),
        &session_id.to_string(),
        &Uuid::new_v4().to_string(),
        now.timestamp(),
        exp.timestamp(),
    )
}

// ── TOTP (two-factor) management ─────────────────────────────────────────────

/// `POST /auth/totp/enroll` — begin TOTP enrollment: generate a secret (stored
/// sealed, PENDING) and return it once for the QR / manual entry. The user must
/// confirm with a code before it takes effect.
pub async fn enroll_totp(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<TotpEnrollResponse>, ApiError> {
    let account = user_repo::find_by_id(&state.db, user.user_id)
        .await?
        .ok_or_else(|| ApiError::Unauthorized("unknown user".to_string()))?;
    if let Some(row) = totp_repo::get(&state.db, user.user_id).await?
        && row.confirmed_at.is_some()
    {
        return Err(ApiError::Conflict(
            "two-factor auth is already enabled".to_string(),
        ));
    }
    let secret = totp::generate_secret();
    let key = totp_enc_key(&state);
    let sealed = totp::seal(&key, user.user_id.as_bytes(), &secret)?;
    totp_repo::upsert_pending(&state.db, user.user_id, &sealed).await?;
    Ok(Json(TotpEnrollResponse {
        secret: totp::to_base32(&secret),
        otpauth_uri: totp::otpauth_uri(&state.config.auth.totp_issuer, &account.username, &secret),
    }))
}

/// `POST /auth/totp/enroll/confirm` — prove possession with a first code, enabling
/// 2FA and issuing a fresh set of recovery codes (shown once, replacing any prior).
pub async fn confirm_totp(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<TotpCodeRequest>,
) -> Result<Json<TotpEnabledResponse>, ApiError> {
    let row = totp_repo::get(&state.db, user.user_id)
        .await?
        .ok_or_else(|| ApiError::Unprocessable("no pending enrollment".to_string()))?;
    if row.confirmed_at.is_some() {
        return Err(ApiError::Conflict(
            "two-factor auth is already enabled".to_string(),
        ));
    }
    let key = totp_enc_key(&state);
    let secret = totp::open(&key, user.user_id.as_bytes(), &row.secret_enc)?;
    let now = Utc::now().timestamp().max(0) as u64;
    if totp::verify(&secret, &req.code, now, state.config.auth.totp_skew_steps).is_none() {
        return Err(ApiError::Unauthorized("invalid code".to_string()));
    }
    totp_repo::confirm(&state.db, user.user_id).await?;

    // Fresh recovery codes tied to enabling 2FA (backup if the device is lost).
    let params: Argon2Params = (&state.config.auth).into();
    let set = recovery::generate_set(params).await?;
    verification_repo::delete_recovery_codes(&state.db, user.user_id).await?;
    verification_repo::insert_recovery_codes(&state.db, user.user_id, &set.hashes).await?;
    Ok(Json(TotpEnabledResponse {
        status: "enabled",
        recovery_codes: set.plaintext,
    }))
}

/// `POST /auth/totp/disable` — turn off 2FA after re-authenticating with the password.
pub async fn disable_totp(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<TotpDisableRequest>,
) -> Result<Json<Value>, ApiError> {
    let account = user_repo::find_by_id(&state.db, user.user_id)
        .await?
        .ok_or_else(|| ApiError::Unauthorized("unknown user".to_string()))?;
    if !password::verify_password(req.password, account.password_hash.clone()).await? {
        return Err(ApiError::Unauthorized("invalid password".to_string()));
    }
    totp_repo::delete(&state.db, user.user_id).await?;
    Ok(Json(json!({ "status": "disabled" })))
}

/// `GET /auth/totp` — whether 2FA is enabled for the current user (for settings UI).
pub async fn totp_status(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let enabled = totp_repo::get(&state.db, user.user_id)
        .await?
        .is_some_and(|r| r.confirmed_at.is_some());
    Ok(Json(json!({ "enabled": enabled })))
}

// ── TOTP helpers ─────────────────────────────────────────────────────────────

/// The 32-byte AEAD key (SHA-256 of the configured passphrase) that seals TOTP
/// secrets at rest.
fn totp_enc_key(state: &AppState) -> Vec<u8> {
    secrets::sha256(state.config.auth.totp_enc_key.as_bytes())
}

/// Verify a second-factor code: a valid TOTP for the confirmed secret, OR a
/// one-time recovery code (consumed on match). Returns whether it passed.
async fn verify_second_factor(state: &AppState, user: &User, code: &str) -> Result<bool, ApiError> {
    // TOTP.
    if let Some(row) = totp_repo::get(&state.db, user.id).await?
        && row.confirmed_at.is_some()
    {
        let key = totp_enc_key(state);
        let secret = totp::open(&key, user.id.as_bytes(), &row.secret_enc)?;
        let now = Utc::now().timestamp().max(0) as u64;
        if let Some(step) = totp::verify(&secret, code, now, state.config.auth.totp_skew_steps) {
            // One-time use (RFC 6238 §5.2): reject a code already spent for this
            // (user, step) so a live code can't be replayed under a new challenge.
            return totp_mark_used(state, user.id, step).await;
        }
    }
    // Recovery-code fallback — but ONLY for inputs that are not a 6-digit TOTP, so a
    // mistyped TOTP never triggers the Argon2-heavy per-code verify loop (a CPU
    // amplification vector). Recovery codes are 16 base32 chars, never 6 digits.
    let normalized = code.trim().to_uppercase().replace([' ', '-'], "");
    let looks_like_totp = normalized.len() == 6 && normalized.bytes().all(|b| b.is_ascii_digit());
    if normalized.is_empty() || looks_like_totp {
        return Ok(false);
    }
    for candidate in verification_repo::unused_recovery_codes(&state.db, user.id).await? {
        if password::verify_password(normalized.clone(), candidate.code_hash).await?
            && verification_repo::consume_recovery_code(&state.db, candidate.id).await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Mark a TOTP step spent for a user (Redis SET NX, ~2-window TTL). Returns true
/// if it was newly marked (accept), false if it was already used (a replay).
async fn totp_mark_used(state: &AppState, user_id: Uuid, step: u64) -> Result<bool, ApiError> {
    let mut conn = mfa_conn(state).await?;
    let set: Option<String> = redis::cmd("SET")
        .arg(format!("totp:used:{user_id}:{step}"))
        .arg(1)
        .arg("NX")
        .arg("EX")
        .arg(90)
        .query_async(&mut conn)
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("mfa store unavailable: {e}")))?;
    Ok(set.is_some())
}

/// Redis key for an MFA challenge (keyed by the challenge's digest, never the
/// plaintext).
fn mfa_key(challenge: &str) -> String {
    format!(
        "mfa:chal:{}",
        hex::encode(secrets::sha256(challenge.as_bytes()))
    )
}

async fn mfa_conn(state: &AppState) -> Result<redis::aio::MultiplexedConnection, ApiError> {
    state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("mfa store unavailable: {e}")))
}

/// Mint a single-use challenge bound to `user_id`, stored with a short TTL.
async fn mint_mfa_challenge(state: &AppState, user_id: Uuid) -> Result<String, ApiError> {
    let challenge = secrets::random_token();
    let mut conn = mfa_conn(state).await?;
    let _: () = redis::cmd("SET")
        .arg(mfa_key(&challenge))
        .arg(user_id.to_string())
        .arg("EX")
        .arg(MFA_CHALLENGE_TTL_SECS)
        .query_async(&mut conn)
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("mfa store unavailable: {e}")))?;
    Ok(challenge)
}

/// Read the user a challenge belongs to WITHOUT consuming it (fails closed on a
/// Redis error — no 2FA bypass).
async fn peek_mfa_challenge(state: &AppState, challenge: &str) -> Result<Option<Uuid>, ApiError> {
    let mut conn = mfa_conn(state).await?;
    let val: Option<String> = redis::cmd("GET")
        .arg(mfa_key(challenge))
        .query_async(&mut conn)
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("mfa store unavailable: {e}")))?;
    Ok(val.and_then(|s| Uuid::parse_str(&s).ok()))
}

/// Atomically read-and-delete a challenge (single-use).
async fn consume_mfa_challenge(
    state: &AppState,
    challenge: &str,
) -> Result<Option<Uuid>, ApiError> {
    let mut conn = mfa_conn(state).await?;
    let val: Option<String> = redis::cmd("GETDEL")
        .arg(mfa_key(challenge))
        .query_async(&mut conn)
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("mfa store unavailable: {e}")))?;
    Ok(val.and_then(|s| Uuid::parse_str(&s).ok()))
}
