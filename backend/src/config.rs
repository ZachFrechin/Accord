//! Application configuration.
//!
//! Values are layered: an optional TOML file (`config/default.toml`, see
//! [`AppConfig::load`]) supplies defaults and every key can be overridden by an
//! environment variable using `__` as the nesting separator
//! (e.g. `SERVER__PORT=9000`, `TELEMETRY__LOG_FORMAT=pretty`).
//!
//! The design is deliberately **fail-loud**: [`AppConfig::load`] returns an
//! error rather than silently falling back to a bogus default. Connection URLs
//! (`DATABASE__URL`, `REDIS__URL`, `NATS__URL`) are REQUIRED and have no
//! committed default, so the binary never ships with a placeholder — a missing
//! one aborts boot instead of failing on the first request.

use config::{Config, Environment, File};
use serde::Deserialize;

/// How structured logs are rendered to stdout.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    /// One JSON object per line — the production default (machine-parseable,
    /// ships to Loki via the collector).
    #[default]
    Json,
    /// Human-friendly multi-line output for local development.
    Pretty,
}

/// HTTP server binding and CORS policy.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    /// Interface to bind. `0.0.0.0` inside containers.
    pub host: String,
    /// TCP port to listen on.
    pub port: u16,
    /// Exact-match allowlist of `Origin` values permitted by CORS. Empty means
    /// no cross-origin browser access is granted — we never fall back to a
    /// permissive `*` policy (see [`crate::routes`]).
    #[serde(default)]
    pub cors_allowed_origins: Vec<String>,
    /// Public base URL of this backend, used to build links in outgoing emails
    /// (verification, password reset). Override via `SERVER__PUBLIC_URL`.
    /// Consumed by the email layer (Phase 1 · Lot 4); parsed now so the config
    /// contract is stable.
    #[serde(default = "default_public_url")]
    #[allow(dead_code)]
    pub public_url: String,
    /// Production deployment flag (`SERVER__PRODUCTION=true`). When set, the boot
    /// preflight ([`AppConfig::validate`]) turns "insecure dev default" warnings
    /// into hard, fail-to-start errors — so a real deployment can never silently
    /// run on the compiled-in public dev secrets. Defaults to false (local dev).
    #[serde(default)]
    pub production: bool,
}

/// Default public base URL when `SERVER__PUBLIC_URL` is unset (local dev).
fn default_public_url() -> String {
    "http://localhost:8080".to_string()
}

/// PostgreSQL connection-pool settings.
///
/// From Phase 1 the database is REQUIRED (accounts, sessions, messages). The
/// pool is still created *lazily* so a briefly-unreachable database does not
/// prevent startup — a stateless replica must come up fast under an
/// orchestrator, and `/health/ready` reports the real connectivity.
#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    /// Postgres connection string. REQUIRED — boot fails loud if unset (never a
    /// committed placeholder). Supply via `DATABASE__URL` (see `.env.example`).
    pub url: String,
    /// Upper bound on pooled connections per replica.
    #[serde(default = "default_max_connections")]
    pub max_connections: u32,
}

/// Default pool ceiling when `DATABASE__MAX_CONNECTIONS` is unset.
fn default_max_connections() -> u32 {
    10
}

/// Observability configuration for traces and logs.
#[derive(Debug, Clone, Deserialize)]
pub struct TelemetryConfig {
    /// OTLP/gRPC endpoint of the collector.
    #[serde(default = "default_otlp_endpoint")]
    pub otlp_endpoint: String,
    /// `service.name` resource attribute attached to every span.
    #[serde(default = "default_service_name")]
    pub service_name: String,
    /// Log rendering format (see [`LogFormat`]).
    #[serde(default)]
    pub log_format: LogFormat,
}

/// Default OTLP collector endpoint (matches `infra/otel-collector.yaml`).
fn default_otlp_endpoint() -> String {
    "http://localhost:4317".to_string()
}

/// Default service name reported to the tracing backend.
fn default_service_name() -> String {
    "accord-backend".to_string()
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            otlp_endpoint: default_otlp_endpoint(),
            service_name: default_service_name(),
            log_format: LogFormat::default(),
        }
    }
}

/// Redis connection settings — presence, distributed rate-limit and cache.
#[derive(Debug, Clone, Deserialize)]
pub struct RedisConfig {
    /// Redis URL, e.g. `redis://localhost:6379`. REQUIRED (fail-loud if unset).
    pub url: String,
}

/// NATS connection settings — cross-node realtime fan-out (JetStream).
#[derive(Debug, Clone, Deserialize)]
pub struct NatsConfig {
    /// NATS URL, e.g. `nats://localhost:4222`. REQUIRED (fail-loud if unset).
    pub url: String,
}

/// Authentication / session tuning (Phase 1 auth core).
#[derive(Debug, Clone, Deserialize)]
pub struct AuthConfig {
    /// Access-token lifetime, seconds. Short by design — revocation rides on the
    /// session id (`sid`) / version, checked cheaply in Redis.
    #[serde(default = "default_access_ttl")]
    pub access_ttl_secs: i64,
    /// Opaque refresh-token lifetime, days.
    #[serde(default = "default_refresh_ttl_days")]
    pub refresh_ttl_days: i64,
    /// Absolute session lifetime, days, regardless of how often it is refreshed.
    #[serde(default = "default_session_ttl_days")]
    pub session_absolute_ttl_days: i64,
    /// Minimum password length. NIST SP 800-63B floor is 8; we default to 12.
    #[serde(default = "default_min_password_len")]
    pub min_password_len: usize,
    /// Reject passwords present in HIBP Pwned Passwords at registration.
    #[serde(default = "default_true")]
    pub hibp_enabled: bool,
    /// Argon2id memory cost (KiB). Default = OWASP baseline (19 MiB).
    #[serde(default = "default_argon2_m")]
    pub argon2_m_cost_kib: u32,
    /// Argon2id time cost (iterations).
    #[serde(default = "default_argon2_t")]
    pub argon2_t_cost: u32,
    /// Argon2id parallelism.
    #[serde(default = "default_argon2_p")]
    pub argon2_p_cost: u32,
    /// Issuer label shown in authenticator apps for TOTP entries.
    #[serde(default = "default_totp_issuer")]
    pub totp_issuer: String,
    /// TOTP clock-drift tolerance, in 30-second steps on each side.
    #[serde(default = "default_totp_skew")]
    pub totp_skew_steps: i64,
    /// Passphrase whose SHA-256 seals TOTP secrets at rest (AEAD). A dev default is
    /// used if unset — a WEAK, PUBLIC value; MUST be overridden in production
    /// (`AUTH__TOTP_ENC_KEY`), else enrolled secrets are trivially decryptable.
    #[serde(default = "default_totp_enc_key")]
    pub totp_enc_key: String,
    /// Emails promoted to the `admin` role automatically — at boot if the account
    /// exists, or the moment it registers. Comma-separated list in
    /// `AUTH__BOOTSTRAP_ADMIN_EMAILS`. This is how the FIRST administrator of an
    /// instance is chosen; further admins are promoted from the admin panel.
    #[serde(default)]
    pub bootstrap_admin_emails: Vec<String>,
}

fn default_access_ttl() -> i64 {
    600
}
fn default_refresh_ttl_days() -> i64 {
    30
}
fn default_session_ttl_days() -> i64 {
    90
}
fn default_min_password_len() -> usize {
    12
}
fn default_true() -> bool {
    true
}
fn default_argon2_m() -> u32 {
    19456
}
fn default_argon2_t() -> u32 {
    2
}
fn default_argon2_p() -> u32 {
    1
}
fn default_totp_issuer() -> String {
    "Accord".to_string()
}
fn default_totp_skew() -> i64 {
    // ±2 steps (±60s → a code is valid across a 150s span) tolerates typical
    // authenticator/server clock drift, which is the usual cause of a rejected code.
    2
}
fn default_totp_enc_key() -> String {
    "accord-dev-totp-key-change-me".to_string()
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            access_ttl_secs: default_access_ttl(),
            refresh_ttl_days: default_refresh_ttl_days(),
            session_absolute_ttl_days: default_session_ttl_days(),
            min_password_len: default_min_password_len(),
            hibp_enabled: true,
            argon2_m_cost_kib: default_argon2_m(),
            argon2_t_cost: default_argon2_t(),
            argon2_p_cost: default_argon2_p(),
            totp_issuer: default_totp_issuer(),
            totp_skew_steps: default_totp_skew(),
            totp_enc_key: default_totp_enc_key(),
            bootstrap_admin_emails: Vec::new(),
        }
    }
}

/// JWT signing configuration (EdDSA / Ed25519 + JWKS).
#[derive(Debug, Clone, Deserialize)]
pub struct JwtConfig {
    /// Ed25519 private key, PKCS#8 PEM. If unset, a dev-ephemeral key is
    /// generated at boot with a loud warning — NEVER acceptable in production.
    #[serde(default)]
    pub private_key_pem: Option<String>,
    /// Key id (`kid`) advertised in JWT headers and the JWKS document.
    #[serde(default = "default_kid")]
    pub key_id: String,
    /// Token audience (`aud`).
    #[serde(default = "default_audience")]
    pub audience: String,
}

fn default_kid() -> String {
    "accord-ed25519-dev".to_string()
}
fn default_audience() -> String {
    "accord".to_string()
}

impl Default for JwtConfig {
    fn default() -> Self {
        Self {
            private_key_pem: None,
            key_id: default_kid(),
            audience: default_audience(),
        }
    }
}

/// Transactional email configuration (Phase 1 · Lot 4).
///
/// Delivery is via a config-driven SMTP relay: `smtp://localhost:1025` (Mailpit)
/// in dev, or any provider's SMTP endpoint (e.g. `smtps://user:pass@smtp.host:465`)
/// in production. The outbox worker drains queued mail with retries.
#[derive(Debug, Clone, Deserialize)]
pub struct EmailConfig {
    /// SMTP relay URL.
    #[serde(default = "default_smtp_url")]
    pub smtp_url: String,
    /// `From` header, e.g. `Accord <no-reply@accord.local>`.
    #[serde(default = "default_email_from")]
    pub from: String,
    /// Outbox worker poll interval, seconds.
    #[serde(default = "default_outbox_poll_secs")]
    pub outbox_poll_secs: u64,
    /// Max delivery attempts before an outbox row is marked failed.
    #[serde(default = "default_email_max_attempts")]
    pub max_attempts: i32,
}

fn default_smtp_url() -> String {
    "smtp://localhost:1025".to_string()
}
fn default_email_from() -> String {
    "Accord <no-reply@accord.local>".to_string()
}
fn default_outbox_poll_secs() -> u64 {
    5
}
fn default_email_max_attempts() -> i32 {
    6
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            smtp_url: default_smtp_url(),
            from: default_email_from(),
            outbox_poll_secs: default_outbox_poll_secs(),
            max_attempts: default_email_max_attempts(),
        }
    }
}

/// Presence tracking (Phase 1 · Lot 6).
#[derive(Debug, Clone, Deserialize)]
pub struct PresenceConfig {
    /// Device liveness TTL, seconds. A client heartbeat (~half this) refreshes it;
    /// a missed heartbeat expires the device.
    #[serde(default = "default_presence_ttl")]
    pub device_ttl_secs: u64,
}

fn default_presence_ttl() -> u64 {
    30
}

impl Default for PresenceConfig {
    fn default() -> Self {
        Self {
            device_ttl_secs: default_presence_ttl(),
        }
    }
}

/// Distributed rate-limit & lockout tuning (Phase 1 · Lot 6).
///
/// Login defense is a per-account failure lockout (targets brute force on one
/// account) plus a per-IP sliding window (caps volume without locking out shared
/// NAT addresses at a low threshold).
#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitConfig {
    /// Failed logins per account before it is temporarily locked.
    #[serde(default = "default_login_fail_threshold")]
    pub login_fail_threshold: i64,
    /// Window over which failed logins accumulate (and the lock lasts), seconds.
    #[serde(default = "default_login_fail_window")]
    pub login_fail_window_secs: u64,
    /// Per-IP login attempts allowed per window.
    #[serde(default = "default_login_max")]
    pub login_max: u64,
    #[serde(default = "default_login_window")]
    pub login_window_secs: u64,
    /// Per-IP registrations per window.
    #[serde(default = "default_register_max")]
    pub register_max: u64,
    #[serde(default = "default_register_window")]
    pub register_window_secs: u64,
    /// Per-IP password-reset requests per window.
    #[serde(default = "default_reset_max")]
    pub reset_max: u64,
    #[serde(default = "default_reset_window")]
    pub reset_window_secs: u64,
    /// Per-user WebSocket ticket requests per window.
    #[serde(default = "default_ws_ticket_max")]
    pub ws_ticket_max: u64,
    #[serde(default = "default_ws_ticket_window")]
    pub ws_ticket_window_secs: u64,
}

fn default_login_fail_threshold() -> i64 {
    10
}
fn default_login_fail_window() -> u64 {
    900
}
fn default_login_max() -> u64 {
    20
}
fn default_login_window() -> u64 {
    60
}
fn default_register_max() -> u64 {
    10
}
fn default_register_window() -> u64 {
    3600
}
fn default_reset_max() -> u64 {
    5
}
fn default_reset_window() -> u64 {
    3600
}
fn default_ws_ticket_max() -> u64 {
    60
}
fn default_ws_ticket_window() -> u64 {
    60
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            login_fail_threshold: default_login_fail_threshold(),
            login_fail_window_secs: default_login_fail_window(),
            login_max: default_login_max(),
            login_window_secs: default_login_window(),
            register_max: default_register_max(),
            register_window_secs: default_register_window(),
            reset_max: default_reset_max(),
            reset_window_secs: default_reset_window(),
            ws_ticket_max: default_ws_ticket_max(),
            ws_ticket_window_secs: default_ws_ticket_window(),
        }
    }
}

/// Object storage (S3-compatible; MinIO self-host in dev). Attachments are
/// uploaded/downloaded directly by the client via SigV4 presigned URLs — the
/// backend only signs, it never proxies the (already client-encrypted) bytes.
#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
    /// S3 endpoint the backend signs against, e.g. `http://localhost:9000`.
    #[serde(default = "default_s3_endpoint")]
    pub endpoint: String,
    /// Endpoint the CLIENT uses to reach storage, if it differs from `endpoint`
    /// (e.g. a public gateway). Defaults to `endpoint`.
    #[serde(default)]
    pub public_endpoint: Option<String>,
    /// Signing region (MinIO ignores it, but SigV4 requires one).
    #[serde(default = "default_s3_region")]
    pub region: String,
    /// Bucket that holds attachment ciphertext.
    #[serde(default = "default_s3_bucket")]
    pub bucket: String,
    /// Public-read bucket for profile avatars (served at a stable, cacheable URL;
    /// avatars are shown to any contact, so — unlike attachments — not encrypted).
    #[serde(default = "default_avatars_bucket")]
    pub avatars_bucket: String,
    #[serde(default = "default_s3_access_key")]
    pub access_key: String,
    #[serde(default = "default_s3_secret_key")]
    pub secret_key: String,
    /// Max attachment size (bytes) a client may request an upload URL for.
    #[serde(default = "default_max_upload_bytes")]
    pub max_upload_bytes: i64,
}

fn default_s3_endpoint() -> String {
    "http://localhost:9000".to_string()
}
fn default_s3_region() -> String {
    "us-east-1".to_string()
}
fn default_s3_bucket() -> String {
    "accord-attachments".to_string()
}
fn default_avatars_bucket() -> String {
    "accord-avatars".to_string()
}
fn default_s3_access_key() -> String {
    "minioadmin".to_string()
}
fn default_s3_secret_key() -> String {
    "minioadmin".to_string()
}
fn default_max_upload_bytes() -> i64 {
    100 * 1024 * 1024
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            endpoint: default_s3_endpoint(),
            public_endpoint: None,
            region: default_s3_region(),
            bucket: default_s3_bucket(),
            avatars_bucket: default_avatars_bucket(),
            access_key: default_s3_access_key(),
            secret_key: default_s3_secret_key(),
            max_upload_bytes: default_max_upload_bytes(),
        }
    }
}

/// LiveKit (SFU) settings — voice/video calls (Phase 4). The backend mints JWT
/// access tokens with this key/secret pair; the SFU routes media the server never
/// decrypts (E2EE keys come from the MLS group exporter, not from LiveKit).
#[derive(Debug, Clone, Deserialize)]
pub struct LiveKitConfig {
    /// LiveKit API key (token `iss`). Override via `LIVEKIT__API_KEY`.
    #[serde(default = "default_livekit_api_key")]
    pub api_key: String,
    /// Shared secret the token is HS256-signed with. DEV default is the committed
    /// placeholder from `infra/livekit.yaml`; override via `LIVEKIT__API_SECRET`.
    #[serde(default = "default_livekit_api_secret")]
    pub api_secret: String,
    /// SFU signaling URL handed to clients. Override via `LIVEKIT__URL`.
    #[serde(default = "default_livekit_url")]
    pub url: String,
}

fn default_livekit_api_key() -> String {
    "accord_key".to_string()
}
fn default_livekit_api_secret() -> String {
    "accord_dev_secret".to_string()
}
fn default_livekit_url() -> String {
    "ws://localhost:7880".to_string()
}

impl Default for LiveKitConfig {
    fn default() -> Self {
        Self {
            api_key: default_livekit_api_key(),
            api_secret: default_livekit_api_secret(),
            url: default_livekit_url(),
        }
    }
}

/// Game-integration API keys (profile ranks). An EMPTY key disables that
/// game's linking with a clear client-side message — nothing else breaks.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct GamesConfig {
    /// Riot Games API key (League of Legends). Override via `GAMES__RIOT_API_KEY`.
    #[serde(default)]
    pub riot_api_key: String,
    /// FACEIT Data API key (CS2 elo/level). Override via `GAMES__FACEIT_API_KEY`.
    #[serde(default)]
    pub faceit_api_key: String,
}

/// Silent push notifications (mobile). An EMPTY credential disables push
/// entirely — a valid deployment, not a failure. Whoever runs an Accord API
/// supplies their own Firebase service account, exactly like the game keys.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct PushConfig {
    /// Firebase service-account JSON, or a path to it. Override via
    /// `PUSH__FCM_CREDENTIALS`. Never committed.
    #[serde(default)]
    pub fcm_credentials: String,
}

/// Root configuration aggregate handed to [`crate::state::AppState`].
#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub nats: NatsConfig,
    #[serde(default)]
    pub telemetry: TelemetryConfig,
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub jwt: JwtConfig,
    #[serde(default)]
    pub email: EmailConfig,
    #[serde(default)]
    pub presence: PresenceConfig,
    #[serde(default)]
    pub rate_limit: RateLimitConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub livekit: LiveKitConfig,
    #[serde(default)]
    pub games: GamesConfig,
    #[serde(default)]
    pub push: PushConfig,
}

impl AppConfig {
    /// Loads configuration from (in increasing precedence):
    /// 1. the TOML file at `ACCORD_CONFIG_PATH` (default `config/default.toml`,
    ///    optional — absence is not an error),
    /// 2. process environment variables (`__` nesting separator; comma-separated
    ///    lists for `SERVER__CORS_ALLOWED_ORIGINS`).
    ///
    /// `.env` is loaded first (best-effort) so local development can keep secrets
    /// out of the shell. Returns an error — never a silent default — when the
    /// merged configuration cannot be deserialized, so misconfiguration surfaces
    /// at boot rather than on the first request.
    pub fn load() -> anyhow::Result<Self> {
        // Best-effort: a missing .env is fine in production where env vars come
        // from the orchestrator / secrets manager.
        let _ = dotenvy::dotenv();

        let config_path = std::env::var("ACCORD_CONFIG_PATH")
            .unwrap_or_else(|_| "config/default.toml".to_string());

        let builder = Config::builder()
            .add_source(File::with_name(&config_path).required(false))
            .add_source(
                Environment::default()
                    .separator("__")
                    .list_separator(",")
                    .with_list_parse_key("server.cors_allowed_origins")
                    .with_list_parse_key("auth.bootstrap_admin_emails")
                    .try_parsing(true),
            );

        let cfg: Self = builder
            .build()
            .map_err(|e| anyhow::anyhow!("configuration build error: {e}"))?
            .try_deserialize()
            .map_err(|e| anyhow::anyhow!("configuration deserialize error: {e}"))?;

        Ok(cfg)
    }

    /// Boot preflight for insecure compiled-in dev defaults.
    ///
    /// Several secrets fall back to a WEAK, PUBLIC value if unset so local dev
    /// runs with zero configuration. Shipping any of them is a real vulnerability
    /// (forgeable call tokens, decryptable 2FA secrets, default object-store
    /// credentials, ephemeral JWT signing keys, undelivered mail). This gathers
    /// every such condition and, in production (`SERVER__PRODUCTION=true`),
    /// refuses to start until they are overridden; in dev it warns loudly but
    /// boots. Call once at startup, after telemetry is initialized.
    pub fn validate(&self) -> anyhow::Result<()> {
        let mut issues: Vec<String> = Vec::new();

        if self.auth.totp_enc_key == default_totp_enc_key() {
            issues.push(
                "AUTH__TOTP_ENC_KEY is the public dev default — enrolled 2FA secrets \
                 would be trivially decryptable. Set a strong random secret."
                    .to_string(),
            );
        }
        if self.livekit.api_secret == default_livekit_api_secret() {
            issues.push(
                "LIVEKIT__API_SECRET is the public dev default — anyone could forge \
                 call tokens. Set the real SFU secret."
                    .to_string(),
            );
        }
        if self.storage.secret_key == default_s3_secret_key() {
            issues.push(
                "STORAGE__SECRET_KEY is the default object-store credential \
                 (minioadmin). Set the real access/secret keys."
                    .to_string(),
            );
        }
        if self.jwt.private_key_pem.is_none() {
            issues.push(
                "JWT__PRIVATE_KEY_PEM is unset — a per-process ephemeral signing key \
                 is generated, so tokens die on restart and cannot be shared across \
                 replicas. Provide a stable Ed25519 PKCS#8 key, or any strong random \
                 secret (32+ chars) to derive a stable key from."
                    .to_string(),
            );
        }
        if self.email.smtp_url == default_smtp_url() {
            issues.push(
                "EMAIL__SMTP_URL is the local dev relay — verification and \
                 password-reset mail will not be delivered. Configure a real SMTP \
                 endpoint."
                    .to_string(),
            );
        }

        if issues.is_empty() {
            return Ok(());
        }

        if self.server.production {
            let list = issues
                .iter()
                .map(|i| format!("  - {i}"))
                .collect::<Vec<_>>()
                .join("\n");
            anyhow::bail!(
                "refusing to start: SERVER__PRODUCTION is set but {} insecure \
                 default(s) remain:\n{list}",
                issues.len()
            );
        }

        for issue in &issues {
            tracing::warn!(target: "config::preflight", "insecure dev default: {issue}");
        }
        tracing::warn!(
            target: "config::preflight",
            "{} insecure dev default(s) in use — acceptable for local dev only; \
             set SERVER__PRODUCTION=true in a real deployment to enforce overrides.",
            issues.len()
        );
        Ok(())
    }
}
