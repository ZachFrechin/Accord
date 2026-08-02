//! Graceful-shutdown signal handling.
//!
//! [`shutdown_signal`] resolves when the process is asked to terminate — either
//! `SIGTERM` (how Kubernetes stops a pod) or `SIGINT` (Ctrl-C in a terminal).
//! Wiring it into `axum::serve(...).with_graceful_shutdown(...)` lets in-flight
//! requests drain before the listener closes, which is what makes rolling
//! deploys of the stateless fleet seamless.

/// Completes on the first received termination signal.
///
/// On Unix it awaits both `SIGINT` and `SIGTERM`; on non-Unix platforms it falls
/// back to Ctrl-C only. Returns as soon as either fires so the caller can begin
/// draining connections.
pub async fn shutdown_signal() {
    // Ctrl-C handler (all platforms).
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    // SIGTERM handler (Unix only — this is the signal orchestrators send).
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    // On non-Unix targets there is no SIGTERM; never resolve this branch.
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("received SIGINT, starting graceful shutdown"),
        _ = terminate => tracing::info!("received SIGTERM, starting graceful shutdown"),
    }
}
