//! Small cryptographic helpers shared by the auth core.
//!
//! Opaque secrets (refresh tokens, email/reset tokens) are high-entropy random
//! strings handed to the client once; only their SHA-256 digest is persisted, so
//! a database dump never reveals a usable token.

use data_encoding::BASE64URL_NOPAD;
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

/// Number of random bytes behind an opaque token (256 bits).
const TOKEN_BYTES: usize = 32;

/// Generates a fresh opaque token: 32 CSPRNG bytes, base64url (no padding).
///
/// The returned plaintext is shown to the client exactly once; persist only its
/// [`sha256`] digest.
pub fn random_token() -> String {
    let mut buf = [0u8; TOKEN_BYTES];
    OsRng.fill_bytes(&mut buf);
    BASE64URL_NOPAD.encode(&buf)
}

/// Returns the raw SHA-256 digest of `input` (32 bytes) — the at-rest form of an
/// opaque token, stored in a `bytea` column and looked up by digest.
pub fn sha256(input: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().to_vec()
}
