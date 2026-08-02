//! One-time recovery codes — an offline fallback to the email reset flow.
//!
//! A set of high-entropy codes is generated at registration. The plaintext is
//! shown to the user exactly once; only Argon2id hashes are persisted, so a
//! database dump never yields a usable code.

use argon2::password_hash::rand_core::{OsRng, RngCore};
use data_encoding::BASE32_NOPAD;

use crate::domain::password::{Argon2Params, hash_sync};
use crate::error::ApiError;

/// Number of codes issued per set.
const CODE_COUNT: usize = 10;
/// Random bytes per code (10 bytes -> 16 base32 chars).
const CODE_BYTES: usize = 10;

/// A freshly generated set: `plaintext` to show once, `hashes` to persist.
pub struct RecoveryCodeSet {
    pub plaintext: Vec<String>,
    pub hashes: Vec<String>,
}

/// Generates a set of recovery codes and their Argon2id hashes.
///
/// Hashing all codes happens on a single blocking thread (Argon2id is
/// CPU-heavy). Returns the plaintext (caller shows it once) alongside the hashes
/// (caller persists them).
pub async fn generate_set(params: Argon2Params) -> Result<RecoveryCodeSet, ApiError> {
    let plaintext: Vec<String> = (0..CODE_COUNT)
        .map(|_| {
            let mut buf = [0u8; CODE_BYTES];
            OsRng.fill_bytes(&mut buf);
            BASE32_NOPAD.encode(&buf)
        })
        .collect();

    let to_hash = plaintext.clone();
    let hashes = tokio::task::spawn_blocking(move || {
        to_hash
            .iter()
            .map(|code| hash_sync(code, params))
            .collect::<Result<Vec<_>, ApiError>>()
    })
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("recovery hash task panicked: {e}")))??;

    Ok(RecoveryCodeSet { plaintext, hashes })
}
