//! The application error type and its HTTP representation.
//!
//! [`ApiError`] is the single error returned by handlers. Its [`IntoResponse`]
//! implementation enforces a strict boundary: internal causes (database,
//! configuration, unexpected failures) are logged server-side with full detail
//! but the client only ever sees a stable machine-readable `code` and a
//! sanitized human-readable `message`. Raw DB/internal strings are never leaked.

// Phase 0 scaffolding: this error surface is defined ahead of the handlers that
// will return it (auth, business routes land in later phases). Allow the unused
// variants/methods so the crate stays clean under CI's `clippy -D warnings`.
#![allow(dead_code)]

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

/// All errors the API can produce, tagged by client-facing category.
///
/// The `#[from]` variants (`Database`, `Config`, `Internal`) carry sensitive
/// causes and are always masked in the response body.
#[derive(Debug, Error)]
pub enum ApiError {
    /// A database/query failure. Cause is logged, never returned to the client.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// A configuration failure surfaced after boot. Masked from the client.
    #[error("configuration error: {0}")]
    Config(#[from] config::ConfigError),

    /// The requested resource does not exist. The message is client-safe.
    #[error("not found: {0}")]
    NotFound(String),

    /// The request failed validation. The message is client-safe.
    #[error("validation error: {0}")]
    Validation(String),

    /// Authentication is missing or invalid. The message is client-safe.
    #[error("unauthorized: {0}")]
    Unauthorized(String),

    /// The caller is authenticated but not permitted. The message is client-safe.
    #[error("forbidden: {0}")]
    Forbidden(String),

    /// The request conflicts with existing state (e.g. a uniqueness violation).
    /// The message is client-safe.
    #[error("conflict: {0}")]
    Conflict(String),

    /// The request was syntactically valid but semantically rejected. Client-safe.
    #[error("unprocessable: {0}")]
    Unprocessable(String),

    /// The caller has exceeded a rate limit. The message is client-safe.
    #[error("too many requests: {0}")]
    TooManyRequests(String),

    /// A dependency (e.g. the database) is temporarily unavailable. Maps to 503.
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),

    /// Any other unexpected failure. Cause is logged, never returned.
    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    /// Maps the variant to its HTTP status code.
    pub fn status_code(&self) -> StatusCode {
        match self {
            ApiError::Database(_) | ApiError::Config(_) | ApiError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Validation(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden(_) => StatusCode::FORBIDDEN,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            ApiError::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    /// Returns a stable, machine-readable error code for clients to branch on.
    /// These strings are part of the API contract and must not change casually.
    pub fn error_code(&self) -> &'static str {
        match self {
            ApiError::Database(_) => "DATABASE_ERROR",
            ApiError::Config(_) => "CONFIG_ERROR",
            ApiError::NotFound(_) => "NOT_FOUND",
            ApiError::Validation(_) => "VALIDATION_ERROR",
            ApiError::Unauthorized(_) => "UNAUTHORIZED",
            ApiError::Forbidden(_) => "FORBIDDEN",
            ApiError::Conflict(_) => "CONFLICT",
            ApiError::Unprocessable(_) => "UNPROCESSABLE",
            ApiError::TooManyRequests(_) => "RATE_LIMITED",
            ApiError::ServiceUnavailable(_) => "SERVICE_UNAVAILABLE",
            ApiError::Internal(_) => "INTERNAL_ERROR",
        }
    }

    /// Returns a message safe to expose to the client. Sensitive variants are
    /// replaced by a generic sentence; client-caused variants pass through.
    pub fn client_message(&self) -> String {
        match self {
            ApiError::Database(_) => "An internal database error occurred.".to_string(),
            ApiError::Config(_) => "A server configuration error occurred.".to_string(),
            ApiError::Internal(_) => "An internal server error occurred.".to_string(),
            ApiError::ServiceUnavailable(msg)
            | ApiError::NotFound(msg)
            | ApiError::Validation(msg)
            | ApiError::Unauthorized(msg)
            | ApiError::Forbidden(msg)
            | ApiError::Conflict(msg)
            | ApiError::Unprocessable(msg)
            | ApiError::TooManyRequests(msg) => msg.clone(),
        }
    }
}

impl IntoResponse for ApiError {
    /// Serializes the error to `{ "error": { "code", "message" } }`, logging the
    /// underlying cause server-side. Sensitive variants log at `error` level;
    /// client-caused variants log at `warn`.
    fn into_response(self) -> Response {
        let status = self.status_code();
        let code = self.error_code();
        let message = self.client_message();

        match &self {
            ApiError::Database(err) => tracing::error!(error = %err, "database error"),
            ApiError::Config(err) => tracing::error!(error = %err, "configuration error"),
            ApiError::Internal(err) => tracing::error!(error = ?err, "internal error"),
            other => tracing::warn!(error = %other, "client error"),
        }

        let body = Json(json!({
            "error": {
                "code": code,
                "message": message,
            }
        }));

        (status, body).into_response()
    }
}
