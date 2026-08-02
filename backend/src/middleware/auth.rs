//! Authenticated-user extractor + session revocation.
//!
//! [`AuthUser`] verifies the Bearer access token against the JWKS keyring and
//! then checks a Redis flag for session revocation. Access tokens are short-lived
//! and asymmetric, so verification is a signature check plus a cheap Redis probe
//! — no per-request database hit.

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use uuid::Uuid;

use crate::error::ApiError;
use crate::repositories::{admin_repo, user_repo};
use crate::state::AppState;

/// The authenticated caller, resolved from a valid access token.
pub struct AuthUser {
    pub user_id: Uuid,
    pub session_id: Uuid,
}

/// Administration-panel access through EITHER the root admin role or any
/// custom role carrying permissions. Handlers gate specific actions with
/// [`PanelUser::require`]; the root admin implies every bit (present and
/// future) and is the only path that may grant/revoke admin itself.
pub struct PanelUser {
    pub user_id: Uuid,
    pub is_admin: bool,
    pub permissions: i64,
}

impl PanelUser {
    pub fn can(&self, bit: i64) -> bool {
        self.is_admin || (self.permissions & bit) != 0
    }

    pub fn require(&self, bit: i64, what: &str) -> Result<(), ApiError> {
        if self.can(bit) {
            Ok(())
        } else {
            Err(ApiError::Forbidden(format!("permission requise : {what}")))
        }
    }
}

impl FromRequestParts<AppState> for PanelUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth = AuthUser::from_request_parts(parts, state).await?;
        let user = user_repo::find_by_id(&state.db, auth.user_id)
            .await?
            .ok_or_else(|| ApiError::Unauthorized("unknown user".to_string()))?;
        if user.disabled_at.is_some() {
            return Err(ApiError::Forbidden("this account is suspended".to_string()));
        }
        let is_admin = user.role == "admin";
        let permissions = if is_admin {
            i64::MAX
        } else {
            admin_repo::permissions_of(&state.db, auth.user_id).await?
        };
        if !is_admin && permissions == 0 {
            return Err(ApiError::Forbidden(
                "administration access required".to_string(),
            ));
        }
        Ok(PanelUser {
            user_id: auth.user_id,
            is_admin,
            permissions,
        })
    }
}

/// (is_admin, permission bits) of any user — (false, 0) for a plain member.
/// Unlike the [`PanelUser`] extractor this never rejects, so it can gate inline
/// moderation (message deletion) and the /admin/me capability probe.
pub async fn instance_permissions(
    state: &AppState,
    user_id: Uuid,
) -> Result<(bool, i64), ApiError> {
    let Some(user) = user_repo::find_by_id(&state.db, user_id).await? else {
        return Ok((false, 0));
    };
    if user.role == "admin" {
        return Ok((true, i64::MAX));
    }
    Ok((false, admin_repo::permissions_of(&state.db, user_id).await?))
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    /// Extracts and validates the Bearer token, then rejects revoked sessions.
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError::Unauthorized("missing bearer token".to_string()))?;

        let claims = state.keyring.verify_access(token)?;
        let user_id = Uuid::parse_str(&claims.sub)
            .map_err(|_| ApiError::Unauthorized("invalid token subject".to_string()))?;
        let session_id = Uuid::parse_str(&claims.sid)
            .map_err(|_| ApiError::Unauthorized("invalid token session".to_string()))?;

        if is_session_revoked(state, session_id).await {
            return Err(ApiError::Unauthorized("session revoked".to_string()));
        }

        Ok(AuthUser {
            user_id,
            session_id,
        })
    }
}

/// Redis key flagging a revoked session.
fn revoked_key(session_id: Uuid) -> String {
    format!("session:revoked:{session_id}")
}

/// Flags a session revoked in Redis for the access-token lifetime.
///
/// Best-effort: a Redis error is logged, not surfaced. The database revocation
/// is authoritative; the short access-token TTL bounds how long a still-cached
/// token could be accepted if this write is lost.
pub async fn mark_session_revoked(state: &AppState, session_id: Uuid) {
    let ttl = state.config.auth.access_ttl_secs.max(1);
    match state.redis.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            let _: redis::RedisResult<()> = redis::cmd("SET")
                .arg(revoked_key(session_id))
                .arg(1)
                .arg("EX")
                .arg(ttl)
                .query_async(&mut conn)
                .await;
        }
        Err(err) => tracing::warn!(error = %err, "could not mark session revoked in redis"),
    }
}

/// Returns whether a session is flagged revoked. Fails **open** on a Redis error
/// (availability is preferred over a bounded, <= access-TTL revocation delay).
async fn is_session_revoked(state: &AppState, session_id: Uuid) -> bool {
    match state.redis.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            let exists: redis::RedisResult<bool> = redis::cmd("EXISTS")
                .arg(revoked_key(session_id))
                .query_async(&mut conn)
                .await;
            exists.unwrap_or(false)
        }
        Err(err) => {
            tracing::warn!(error = %err, "redis revocation check failed; failing open");
            false
        }
    }
}
