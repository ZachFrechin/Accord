//! HTTP middleware building blocks.
//!
//! Request-context propagation (request id + tracing span) and the
//! authenticated-user extractor. Future phases (rate limiting) add siblings here.

pub mod auth;
pub mod rate_limit;
pub mod request_context;
