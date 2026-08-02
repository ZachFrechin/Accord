//! Request-context middleware: correlation id + per-request tracing span.
//!
//! Every request is stamped with an `x-request-id` (generated as a UUID v4 when
//! the client did not supply one) and gets a tracing span carrying that id, the
//! method and the path. The id is propagated back on the response so clients and
//! logs can be correlated across the stateless fleet.
//!
//! The layers must be composed in the right order (see [`crate::routes`]):
//! `SetRequestId` runs *before* the trace layer so the span can read the header.

use axum::body::Body;
use axum::http::{HeaderName, Request};
use tracing::Span;

/// The header used to carry the request correlation id, both inbound and out.
pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

/// Builds the tracing span for an incoming request.
///
/// Reads the `x-request-id` header (populated upstream by the `SetRequestId`
/// layer) and records it on the span alongside the HTTP method and path, so all
/// events emitted while handling the request inherit the correlation id.
pub fn make_request_span(request: &Request<Body>) -> Span {
    let request_id = request
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");

    tracing::info_span!(
        "http_request",
        method = %request.method(),
        path = %request.uri().path(),
        request_id = %request_id,
    )
}
