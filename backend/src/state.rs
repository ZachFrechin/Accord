//! Shared application state.
//!
//! [`AppState`] is cloned into every handler by Axum. Every field is cheap to
//! clone — `config` is behind an `Arc`, `PgPool`/`redis::Client`/`async_nats::Client`
//! are all internally reference-counted handles — so the whole struct is a few
//! pointer bumps.
//!
//! The state holds the three externalized backends that make the API STATELESS:
//! Postgres (source of truth), Redis (presence, rate-limit, cache) and NATS
//! (cross-node realtime fan-out). No per-connection or per-session data lives in
//! process memory, which is what lets replicas be interchangeable.

use std::sync::Arc;

use anyhow::Context;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tokio_util::sync::CancellationToken;

use crate::config::AppConfig;
use crate::domain::push::Fcm;
use crate::domain::tokens::Keyring;
use crate::realtime::bus::RealtimeBus;

/// Handler-visible state: immutable configuration plus the three shared backends.
#[derive(Clone)]
pub struct AppState {
    /// Process configuration, shared read-only across all handlers.
    pub config: Arc<AppConfig>,
    /// Lazily-connected Postgres pool (source of truth).
    pub db: PgPool,
    /// Redis client (presence, distributed rate-limit, cache). Connections are
    /// opened on demand; opening the client itself never touches the network.
    pub redis: redis::Client,
    /// NATS client for cross-node fan-out. Reconnects in the background.
    pub nats: async_nats::Client,
    /// Ed25519 signing material + JWKS document (shared, never mutated).
    pub keyring: Arc<Keyring>,
    /// Cross-node realtime delivery (WebSocket fan-out over NATS).
    pub realtime: Arc<RealtimeBus>,
    /// Silent push sender, when this instance is configured for it. `None` is a
    /// valid deployment: notifications simply stay tied to a live connection.
    pub push: Option<Arc<Fcm>>,
    /// Fired on shutdown so long-lived WebSocket tasks close and drain.
    pub shutdown: CancellationToken,
}

impl AppState {
    /// Connects the shared backends and assembles the state.
    ///
    /// * Postgres — a *lazy* pool: no connection is opened until the first query,
    ///   so a briefly-unavailable database does not delay startup.
    /// * Redis — a lazy client; connections are opened on demand.
    /// * NATS — connected with `retry_on_initial_connect` so a briefly-down
    ///   broker does not abort boot; the client reconnects in the background and
    ///   `/health/ready` reflects the live connection state.
    ///
    /// Returns an error only on an invalid connection string (Postgres/Redis) or
    /// an unresolvable NATS URL — never merely because a backend is momentarily
    /// unreachable.
    pub async fn connect(config: AppConfig) -> anyhow::Result<Self> {
        let db = PgPoolOptions::new()
            .max_connections(config.database.max_connections)
            .connect_lazy(&config.database.url)
            .map_err(|e| anyhow::anyhow!("invalid DATABASE__URL: {e}"))?;

        let redis = redis::Client::open(config.redis.url.clone())
            .map_err(|e| anyhow::anyhow!("invalid REDIS__URL: {e}"))?;

        let nats = async_nats::ConnectOptions::new()
            .retry_on_initial_connect()
            .connect(&config.nats.url)
            .await
            .map_err(|e| anyhow::anyhow!("connecting to NATS at {}: {e}", config.nats.url))?;

        // Build the JWT keyring from config (or a dev-ephemeral key). Done before
        // `config` is moved into the Arc below.
        let keyring =
            Arc::new(Keyring::from_config(&config.jwt).context("initializing JWT keyring")?);

        // Realtime bus shares the NATS client; clone before `nats` is moved in.
        let realtime = Arc::new(RealtimeBus::new(nats.clone()));

        // A malformed service account is a hard failure: starting anyway would
        // mean pushing into the void with no way to notice.
        let push = Fcm::from_config(&config.push).context("initializing push")?;

        Ok(Self {
            config: Arc::new(config),
            db,
            redis,
            nats,
            keyring,
            realtime,
            push,
            shutdown: CancellationToken::new(),
        })
    }
}
