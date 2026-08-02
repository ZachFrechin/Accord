//! TOTP (RFC 6238) second factor.
//!
//! Hand-rolled HOTP/TOTP over the already-present `hmac`/`sha1` crates (no new
//! dependency) — verified against the official RFC 6238 test vectors below. The
//! shared secret is symmetric key material (it must be reversible to compute
//! codes), so at rest it is sealed with an AEAD (ChaCha20-Poly1305 via `ring`)
//! under a key from config — never stored plaintext and never hashed.

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use rand::RngCore;
use rand::rngs::OsRng;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use sha1::Sha1;

use crate::error::ApiError;

type HmacSha1 = Hmac<Sha1>;

/// TOTP secret length — 160 bits, the RFC 4226 recommendation for HMAC-SHA1.
const SECRET_LEN: usize = 20;

/// A fresh random TOTP secret (raw bytes).
pub fn generate_secret() -> [u8; SECRET_LEN] {
    let mut secret = [0u8; SECRET_LEN];
    OsRng.fill_bytes(&mut secret);
    secret
}

/// Base32 (no padding) encoding of a secret — the form authenticator apps expect.
pub fn to_base32(secret: &[u8]) -> String {
    BASE32_NOPAD.encode(secret)
}

/// Build the `otpauth://totp/...` URI that an authenticator app scans (QR) or
/// imports. `account` labels the entry (e.g. the username); `issuer` is the app.
pub fn otpauth_uri(issuer: &str, account: &str, secret: &[u8]) -> String {
    let label = urlencode(&format!("{issuer}:{account}"));
    let issuer_q = urlencode(issuer);
    let secret_b32 = to_base32(secret);
    format!(
        "otpauth://totp/{label}?secret={secret_b32}&issuer={issuer_q}&algorithm=SHA1&digits=6&period=30"
    )
}

/// HOTP (RFC 4226) — the truncated code for a specific counter.
fn hotp(secret: &[u8], counter: u64, digits: u32) -> u32 {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let hs = mac.finalize().into_bytes(); // 20 bytes
    // Dynamic truncation (RFC 4226 §5.3).
    let offset = (hs[19] & 0x0f) as usize;
    let bin = (u32::from(hs[offset] & 0x7f) << 24)
        | (u32::from(hs[offset + 1]) << 16)
        | (u32::from(hs[offset + 2]) << 8)
        | u32::from(hs[offset + 3]);
    bin % 10u32.pow(digits)
}

/// The 6-digit TOTP code for a unix timestamp (30-second step).
pub fn code_at(secret: &[u8], unix_secs: u64) -> String {
    let counter = unix_secs / 30;
    format!("{:06}", hotp(secret, counter, 6))
}

/// Verify a user-supplied code against `secret` at `unix_secs`, accepting the
/// current step ± `skew` steps (clock drift). Returns the matched step counter
/// (so the caller can enforce one-time use per step, RFC 6238 §5.2), or `None`.
/// Constant-time comparison; the input is normalized (trim + strip spaces) first.
pub fn verify(secret: &[u8], code: &str, unix_secs: u64, skew: i64) -> Option<u64> {
    let candidate = code.trim().replace([' ', '-'], "");
    if candidate.len() != 6 || !candidate.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let counter = (unix_secs / 30) as i64;
    let mut matched: Option<u64> = None;
    for delta in -skew..=skew {
        let c = (counter + delta).max(0) as u64;
        let expected = format!("{:06}", hotp(secret, c, 6));
        // Constant-time compare; keep scanning the whole window (no early return)
        // so timing does not reveal which step matched.
        if ct_eq(expected.as_bytes(), candidate.as_bytes()) {
            matched = Some(c);
        }
    }
    matched
}

/// Constant-time byte-equality (for equal-length inputs; lengths here are not
/// secret). Accumulates differences so timing does not depend on where they diverge.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── At-rest encryption of the secret ─────────────────────────────────────────

/// Seal a TOTP secret for storage: `nonce (12B) || ciphertext || tag`. `key` must
/// be exactly 32 bytes (ChaCha20-Poly1305). `aad` (associated data — e.g. the
/// owning user id) is authenticated but not encrypted, cryptographically pinning
/// the ciphertext to its row so a sealed blob can't be relocated to another user.
pub fn seal(key: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, ApiError> {
    let unbound = UnboundKey::new(&CHACHA20_POLY1305, key)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("totp: bad encryption key length")))?;
    let sealing = LessSafeKey::new(unbound);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("totp: rng failure")))?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("totp: seal failed")))?;
    let mut out = Vec::with_capacity(NONCE_LEN + in_out.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&in_out);
    Ok(out)
}

/// Open a secret sealed by [`seal`]. `aad` must match what was sealed (the owning
/// user id) or authentication fails.
pub fn open(key: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>, ApiError> {
    if data.len() < NONCE_LEN {
        return Err(ApiError::Internal(anyhow::anyhow!("totp: ciphertext too short")));
    }
    let (nonce_bytes, ct) = data.split_at(NONCE_LEN);
    let nonce_arr: [u8; NONCE_LEN] = nonce_bytes.try_into().expect("checked length");
    let nonce = Nonce::assume_unique_for_key(nonce_arr);
    let unbound = UnboundKey::new(&CHACHA20_POLY1305, key)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("totp: bad encryption key length")))?;
    let opening = LessSafeKey::new(unbound);
    let mut in_out = ct.to_vec();
    let plain = opening
        .open_in_place(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("totp: decrypt failed")))?;
    Ok(plain.to_vec())
}

/// Minimal percent-encoding for the otpauth label/issuer (RFC 3986 unreserved set
/// stays; everything else is %XX). Enough for usernames/issuer strings.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B test vectors (SHA1 seed = ASCII "12345678901234567890").
    const SEED: &[u8] = b"12345678901234567890";

    #[test]
    fn rfc6238_vectors() {
        // (unix time, expected 8-digit code). We compute 8 digits here to match the
        // RFC table exactly, proving the HOTP/truncation core is correct.
        let cases = [
            (59u64, 94287082u32),
            (1111111109, 7081804),
            (1111111111, 14050471),
            (1234567890, 89005924),
            (2000000000, 69279037),
            (20000000000, 65353130),
        ];
        for (t, expected) in cases {
            let counter = t / 30;
            assert_eq!(hotp(SEED, counter, 8), expected, "RFC 6238 vector at T={t}");
        }
    }

    #[test]
    fn verify_accepts_current_and_adjacent_steps() {
        let secret = generate_secret();
        let now = 1_700_000_000u64;
        let code = code_at(&secret, now);
        assert!(verify(&secret, &code, now, 1).is_some());
        // One step earlier still verifies within skew=1.
        assert!(verify(&secret, &code, now + 30, 1).is_some());
        // Formatting tolerance: spaces stripped.
        let spaced = format!("{} {}", &code[..3], &code[3..]);
        assert!(verify(&secret, &spaced, now, 1).is_some());
        // A wrong code fails.
        let wrong = if code == "000000" { "111111" } else { "000000" };
        assert!(verify(&secret, wrong, now, 1).is_none());
        // Outside the skew window fails.
        assert!(verify(&secret, &code, now + 300, 1).is_none());
    }

    #[test]
    fn seal_open_roundtrip() {
        let key = [7u8; 32];
        let aad = b"user-123";
        let secret = generate_secret();
        let sealed = seal(&key, aad, &secret).unwrap();
        assert_ne!(sealed, secret, "sealed bytes are not the plaintext");
        assert_eq!(open(&key, aad, &sealed).unwrap(), secret);
        // Wrong key fails to open (AEAD authentication).
        assert!(open(&[9u8; 32], aad, &sealed).is_err());
        // Wrong AAD (different owner) fails — no ciphertext relocation.
        assert!(open(&key, b"user-999", &sealed).is_err());
        // Two seals of the same secret differ (random nonce).
        assert_ne!(seal(&key, aad, &secret).unwrap(), sealed);
    }
}
