//! Password hashing (Argon2id) and password policy.
//!
//! Hashing is CPU-heavy (~19 MiB, tens of ms) so it always runs on a blocking
//! thread — never on the async runtime, or a burst of logins would stall every
//! other request. Passwords are NFKC-normalized before hashing/verifying so the
//! same secret produces the same result across platforms (it will also seed E2EE
//! key derivation later). [`is_pwned`] screens against HaveIBeenPwned using
//! k-anonymity: only a SHA-1 prefix leaves the process, never the password.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use sha1::{Digest, Sha1};
use unicode_normalization::UnicodeNormalization;

use crate::config::AuthConfig;
use crate::error::ApiError;

/// Argon2id cost parameters, copied out of config so hashing can move to a
/// blocking thread without borrowing the whole config.
#[derive(Debug, Clone, Copy)]
pub struct Argon2Params {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl From<&AuthConfig> for Argon2Params {
    fn from(cfg: &AuthConfig) -> Self {
        Self {
            m_cost_kib: cfg.argon2_m_cost_kib,
            t_cost: cfg.argon2_t_cost,
            p_cost: cfg.argon2_p_cost,
        }
    }
}

/// NFKC-normalizes a secret. Applied to every password before hashing/verifying.
pub fn normalize(input: &str) -> String {
    input.nfkc().collect()
}

/// Builds an Argon2id hasher from the given cost parameters.
fn hasher(p: Argon2Params) -> Result<Argon2<'static>, ApiError> {
    let params = Params::new(p.m_cost_kib, p.t_cost, p.p_cost, Some(32))
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("invalid argon2 params: {e}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Synchronous Argon2id hash — for callers already on a blocking thread (e.g.
/// hashing a batch of recovery codes). Prefer [`hash_password`] on the async path.
pub fn hash_sync(plain: &str, params: Argon2Params) -> Result<String, ApiError> {
    let argon2 = hasher(params)?;
    let salt = SaltString::generate(&mut OsRng);
    argon2
        .hash_password(normalize(plain).as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("argon2 hash: {e}")))
}

/// Hashes a plaintext password with Argon2id, returning a PHC string.
///
/// Runs on a blocking thread. The plaintext is moved in and dropped there.
pub async fn hash_password(plain: String, params: Argon2Params) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_sync(&plain, params))
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("hash task panicked: {e}")))?
}

/// Verifies a plaintext password against a stored PHC hash.
///
/// Returns `Ok(true)` on match, `Ok(false)` on mismatch, `Err` only on a
/// malformed stored hash. Cost parameters are read from the hash itself.
pub async fn verify_password(plain: String, phc: String) -> Result<bool, ApiError> {
    tokio::task::spawn_blocking(move || {
        let parsed = PasswordHash::new(&phc)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("stored hash malformed: {e}")))?;
        Ok(Argon2::default()
            .verify_password(normalize(&plain).as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("verify task panicked: {e}")))?
}

/// Burns roughly one hash worth of CPU to equalize the response time of a login
/// against a non-existent account, closing the timing side-channel. The result
/// is discarded.
pub async fn dummy_verify(params: Argon2Params) {
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(argon2) = hasher(params) {
            let salt = SaltString::generate(&mut OsRng);
            let _ = argon2.hash_password(b"timing-equalizer", &salt);
        }
    })
    .await;
}

/// Returns `true` if the password appears in HaveIBeenPwned's Pwned Passwords.
///
/// Uses the range API with k-anonymity: only the first five hex chars of the
/// SHA-1 digest are sent; suffixes are matched locally. `Err(())` signals a
/// network/HTTP failure so the caller can fail *open* (never block signup on a
/// third-party outage).
pub async fn is_pwned(plain: &str) -> Result<bool, ()> {
    let mut hasher = Sha1::new();
    hasher.update(normalize(plain).as_bytes());
    let digest = hex::encode_upper(hasher.finalize());
    let (prefix, suffix) = digest.split_at(5);

    let resp = reqwest::Client::new()
        .get(format!("https://api.pwnedpasswords.com/range/{prefix}"))
        .header("Add-Padding", "true")
        .send()
        .await
        .map_err(|_| ())?;
    let body = resp.text().await.map_err(|_| ())?;

    Ok(body.lines().any(|line| {
        line.split(':')
            .next()
            .is_some_and(|s| s.eq_ignore_ascii_case(suffix))
    }))
}
