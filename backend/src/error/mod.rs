//! Error handling surface for the API.
//!
//! Re-exports the single public error type so call sites use
//! `crate::error::ApiError` regardless of internal file layout.

pub mod api_error;

// Re-exported for ergonomic `crate::error::ApiError` call sites in later phases;
// unused in Phase 0, so silence the lint to keep `clippy -D warnings` green.
#[allow(unused_imports)]
pub use api_error::ApiError;
