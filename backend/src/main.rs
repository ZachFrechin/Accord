//! Accord2 backend — Phase 0 entrypoint.
//!
//! A stateless Axum service designed to run as many interchangeable replicas.
//! `main` performs an ordered bootstrap — configuration, telemetry, state
//! (lazy DB pool), router, then serve with graceful shutdown — and holds the
//! telemetry guard for the whole process so spans flush on exit.

mod config;
mod controllers;
mod domain;
mod error;
mod health;
mod middleware;
mod realtime;
mod repositories;
mod routes;
mod shutdown;
mod state;
mod telemetry;

use std::net::SocketAddr;

use anyhow::Context;
use tracing::info;

use crate::config::AppConfig;
use crate::state::AppState;

/// Boots the service and runs until a termination signal drains it.
///
/// Order: load config first (telemetry is config-driven, so it must be parsed
/// before the subscriber is built), init telemetry, build shared state with a
/// lazy DB pool, assemble the router, bind the listener, and serve with
/// graceful shutdown. Returns `Err` only on a fatal bootstrap failure.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // One-shot subcommands (deploy/ops steps, separate from the serving replicas):
    //   `accord-backend migrate`                — apply the schema then exit.
    //   `accord-backend promote-admin <email>`  — grant the admin role then exit.
    // Both use an EAGER connection since the work must complete before success.
    let mut cli_args = std::env::args().skip(1);
    match cli_args.next().as_deref() {
        Some("migrate") => return run_migrations().await,
        Some("promote-admin") => {
            let email = cli_args
                .next()
                .context("usage: accord-backend promote-admin <email>")?;
            return run_promote_admin(&email).await;
        }
        _ => {}
    }

    // 1. Configuration — fail-loud before anything else depends on it.
    let config = AppConfig::load().context("loading configuration")?;

    // 2. Telemetry — driven by config; keep the guard alive until `main` ends so
    //    batched spans are flushed on shutdown.
    let _telemetry_guard = telemetry::init(&config.telemetry).context("initializing telemetry")?;
    info!(
        service = %config.telemetry.service_name,
        "telemetry initialized; starting Accord2 backend"
    );

    // 2b. Preflight — refuse to start in production on insecure compiled-in dev
    //     defaults (public secrets, ephemeral JWT key); warn in dev.
    config.validate().context("configuration preflight")?;

    // 3. Resolve the bind address before `config` is moved into state.
    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port)
        .parse()
        .with_context(|| {
            format!(
                "invalid bind address {}:{}",
                config.server.host, config.server.port
            )
        })?;

    // 4. Shared state — connects the externalized backends (lazy Postgres pool,
    //    Redis client, NATS client with background reconnect).
    let state = AppState::connect(config)
        .await
        .context("building application state")?;

    // 4b. Bootstrap admins — promote configured emails whose accounts already
    //     exist (AUTH__BOOTSTRAP_ADMIN_EMAILS). Emails registering later are
    //     promoted inline by /auth/register. Best-effort: the pool is lazy, so a
    //     briefly-unreachable database only warns — the register-time hook and
    //     the next boot cover it.
    for email in &state.config.auth.bootstrap_admin_emails {
        let normalized = email.trim().to_lowercase();
        if normalized.is_empty() {
            continue;
        }
        match repositories::user_repo::promote_admin_by_email(&state.db, &normalized).await {
            Ok(Some(user_id)) => info!(%user_id, email = %normalized, "bootstrap: promoted admin"),
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(email = %normalized, error = %err, "bootstrap admin promotion failed")
            }
        }
    }

    // 4c. Email outbox worker — drains queued mail and delivers over SMTP.
    //     In dev a broken mailer is best-effort (log + continue; mail still queues).
    //     In production it is fatal: verification / password-reset mail silently
    //     never arriving is worse than failing to start.
    match domain::mailer::SmtpMailer::from_config(&state.config.email) {
        Ok(mailer) => {
            let pool = state.db.clone();
            let poll = state.config.email.outbox_poll_secs;
            let max = state.config.email.max_attempts;
            tokio::spawn(domain::outbox::run_worker(pool, mailer, poll, max));
            info!("email outbox worker started");
        }
        Err(err) if state.config.server.production => {
            return Err(err).context("email outbox worker (required in production)");
        }
        Err(err) => tracing::warn!(error = %err, "email disabled: could not build SMTP mailer"),
    }

    // 5. Router with the full middleware stack. Capture the shutdown token first
    //    so the graceful-shutdown future can close live WebSocket tasks.
    let shutdown_token = state.shutdown.clone();
    let app = routes::build_router(state);

    // 6. Bind and serve with graceful shutdown on SIGTERM/SIGINT.
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding TCP listener on {addr}"))?;
    info!(%addr, "listening");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown::shutdown_signal().await;
        // Close live WebSockets so `serve` finishes draining instead of blocking
        // on long-lived connections.
        shutdown_token.cancel();
    })
    .await
    .context("server error")?;

    info!("shutdown complete");
    Ok(())
}

/// Grant the `admin` role to the account with this email, then exit. The
/// command-line counterpart of `AUTH__BOOTSTRAP_ADMIN_EMAILS` — handy on a
/// running deployment: `docker compose exec backend accord-backend promote-admin
/// you@example.com`. Idempotent.
async fn run_promote_admin(email: &str) -> anyhow::Result<()> {
    let config = AppConfig::load().context("loading configuration")?;
    let pool = sqlx::PgPool::connect(&config.database.url)
        .await
        .context("connecting to Postgres")?;
    let normalized = email.trim().to_lowercase();
    let row = sqlx::query!(
        "UPDATE users SET role = 'admin', updated_at = now() WHERE email = $1 RETURNING id",
        normalized,
    )
    .fetch_optional(&pool)
    .await
    .context("promoting admin")?;
    match row {
        Some(row) => println!("{normalized} is now an administrator (user id {})", row.id),
        None => anyhow::bail!("no account with email {normalized}"),
    }
    Ok(())
}

/// Apply all pending schema migrations, then exit. The migrations are embedded at
/// build time from `migrations/`, so this needs no external tooling — the deploy
/// runs the same image with the `migrate` argument as a one-shot before serving.
async fn run_migrations() -> anyhow::Result<()> {
    let config = AppConfig::load().context("loading configuration")?;
    let pool = sqlx::PgPool::connect(&config.database.url)
        .await
        .context("connecting to Postgres for migrations")?;
    sqlx::migrate!("../migrations")
        .run(&pool)
        .await
        .context("applying migrations")?;
    println!("migrations applied");
    Ok(())
}
