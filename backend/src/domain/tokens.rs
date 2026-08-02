//! Access-token signing & verification (EdDSA / Ed25519) plus the JWKS document.
//!
//! Access tokens are short-lived (minutes) and asymmetric: any replica verifies
//! them with the public key (served at `/.well-known/jwks.json`) without a shared
//! secret. Revocation does not rely on the token itself — it rides on the session
//! id (`sid`), which the auth middleware checks cheaply in Redis. Long-lived
//! authority stays with opaque refresh tokens (see [`crate::domain::secrets`]).

use anyhow::Context;
use data_encoding::{BASE64, BASE64URL_NOPAD};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use ring::signature::KeyPair;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::config::JwtConfig;
use crate::error::ApiError;

/// Claims carried by an access token. `sid` enables session-scoped revocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    /// Issuer — the minting backend's public URL.
    pub iss: String,
    /// Audience — constant `"accord"` (configurable).
    pub aud: String,
    /// Subject — the user id (UUID string).
    pub sub: String,
    /// Session id this token belongs to (UUID string).
    pub sid: String,
    /// Unique token id.
    pub jti: String,
    /// Issued-at (unix seconds).
    pub iat: i64,
    /// Expiry (unix seconds).
    pub exp: i64,
}

/// Claims of a key-transparency Signed Tree Head (Phase 3 · Lot 6). Distinct field
/// shape + `typ` from [`AccessClaims`] so an STH can never be replayed as an access
/// token (and vice versa). Verified against the same JWKS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SthClaims {
    /// Audience — constant `"accord"` (configurable), pinned like access tokens.
    pub aud: String,
    /// Token type marker.
    pub typ: String,
    /// The tree size (number of leaves) this head commits to.
    pub size: u64,
    /// The Merkle Tree Hash root, hex-encoded.
    pub root: String,
    /// Issued-at (unix seconds).
    pub iat: i64,
}

/// Ed25519 signing material plus the cached JWKS document.
///
/// Held behind an `Arc` in [`crate::state::AppState`]; neither `EncodingKey` nor
/// `DecodingKey` needs to be cloned.
pub struct Keyring {
    encoding: EncodingKey,
    decoding: DecodingKey,
    kid: String,
    audience: String,
    jwks: Value,
}

impl Keyring {
    /// Builds the keyring from config, or generates an ephemeral dev key.
    ///
    /// `JWT__PRIVATE_KEY_PEM` accepts either form (see [`load_ed25519_key`]): a
    /// real PKCS#8 Ed25519 key (PEM or single-line base64 DER), or any strong
    /// random secret from which a stable key is derived. Without it, an ephemeral
    /// keypair is generated and a loud warning is logged — tokens then do not
    /// survive a restart, which is fine for local dev but never for production.
    pub fn from_config(cfg: &JwtConfig) -> anyhow::Result<Self> {
        let (pkcs8_der, public_raw) = match &cfg.private_key_pem {
            Some(secret) => load_ed25519_key(secret).context("loading JWT__PRIVATE_KEY_PEM")?,
            None => {
                tracing::warn!(
                    "JWT__PRIVATE_KEY_PEM is unset — generating an EPHEMERAL Ed25519 signing key. \
                     Tokens will NOT survive a restart; NEVER run production this way."
                );
                generate_ed25519().context("generating ephemeral Ed25519 key")?
            }
        };

        let encoding = EncodingKey::from_ed_der(&pkcs8_der);
        let decoding = DecodingKey::from_ed_der(&public_raw);
        let jwks = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "use": "sig",
                "alg": "EdDSA",
                "kid": cfg.key_id,
                "x": BASE64URL_NOPAD.encode(&public_raw),
            }]
        });

        Ok(Self {
            encoding,
            decoding,
            kid: cfg.key_id.clone(),
            audience: cfg.audience.clone(),
            jwks,
        })
    }

    /// The JWKS document served at `/.well-known/jwks.json`.
    pub fn jwks(&self) -> &Value {
        &self.jwks
    }

    /// Signs an access token for `sub`/`sid`, valid from `iat` until `exp`.
    pub fn mint_access(
        &self,
        iss: &str,
        sub: &str,
        sid: &str,
        jti: &str,
        iat: i64,
        exp: i64,
    ) -> Result<String, ApiError> {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        let claims = AccessClaims {
            iss: iss.to_string(),
            aud: self.audience.clone(),
            sub: sub.to_string(),
            sid: sid.to_string(),
            jti: jti.to_string(),
            iat,
            exp,
        };
        encode(&header, &claims, &self.encoding)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("jwt encode: {e}")))
    }

    /// Signs a key-transparency Signed Tree Head over `(size, root)`. Clients gossip
    /// it out-of-band: two validly-signed STHs with the same `size` but different
    /// `root` are non-repudiable proof the server equivocated.
    pub fn mint_sth(&self, size: u64, root_hex: &str, iat: i64) -> Result<String, ApiError> {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        let claims = SthClaims {
            aud: self.audience.clone(),
            typ: "kt-sth".to_string(),
            size,
            root: root_hex.to_string(),
            iat,
        };
        encode(&header, &claims, &self.encoding)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("sth encode: {e}")))
    }

    /// Verifies an access token's signature, audience and expiry, returning the
    /// claims. Any failure maps to a generic `401` — the reason is never leaked.
    pub fn verify_access(&self, token: &str) -> Result<AccessClaims, ApiError> {
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_audience(std::slice::from_ref(&self.audience));
        // `iss` is intentionally not pinned: a multi-instance client talks to many
        // backends, each with its own issuer. Signature + audience + expiry suffice.
        decode::<AccessClaims>(token, &self.decoding, &validation)
            .map(|data| data.claims)
            .map_err(|_| ApiError::Unauthorized("invalid or expired token".to_string()))
    }
}

/// Generates a fresh Ed25519 keypair, returning `(pkcs8_der, public_key_raw)`.
fn generate_ed25519() -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng)
        .map_err(|_| anyhow::anyhow!("ring: keypair generation failed"))?;
    let key_pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| anyhow::anyhow!("ring: generated key did not round-trip"))?;
    let public = key_pair.public_key().as_ref().to_vec();
    Ok((pkcs8.as_ref().to_vec(), public))
}

/// Loads the JWT signing key from the configured secret, returning
/// `(pkcs8_der, public_key_raw)`.
///
/// Two accepted forms let a deployment either bring its own key or let the
/// orchestrator mint a random one:
///   1. A **PKCS#8 Ed25519 private key** — PEM armor or single-line base64 DER,
///      v1 (`openssl genpkey`) or v2 (`ring`). Used verbatim: the "bring your own
///      key" path, unchanged from before.
///   2. **Any other high-entropy string** — the 32-byte Ed25519 seed is derived
///      deterministically as `SHA-256(secret)`. This lets a platform that can
///      only generate a random password / base64 blob (e.g. Coolify's magic env
///      vars) supply a STABLE signing key with no key-generation tooling. Same
///      secret in → same key out across restarts and replicas, which is all JWT
///      signing needs.
fn load_ed25519_key(secret: &str) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let trimmed = secret.trim();
    anyhow::ensure!(!trimmed.is_empty(), "JWT signing secret is empty");

    // Prefer an actual PKCS#8 key when the value is one.
    if let Ok(pair) = parse_ed25519_pkcs8(trimmed) {
        return Ok(pair);
    }

    // A value carrying PEM armor was *meant* to be a key. If it didn't parse, the
    // operator supplied a broken/truncated key — fail closed rather than silently
    // signing with a different, SHA-256-derived key that only an external verifier
    // would ever notice was wrong.
    anyhow::ensure!(
        !trimmed.contains("-----BEGIN"),
        "JWT__PRIVATE_KEY_PEM carries PEM armor but is not a valid PKCS#8 Ed25519 key; \
         refusing to fall back to a derived key. Fix the key, or supply a plain random \
         secret (no PEM armor) to derive a stable key from."
    );

    // Otherwise the value is a plain secret (not a mistyped key): derive a stable
    // signing key from it.
    if trimmed.len() < 32 {
        tracing::warn!(
            "JWT__PRIVATE_KEY_PEM is a short secret ({} chars); use 32+ random chars for a \
             strong derived signing key.",
            trimmed.len()
        );
    }
    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    let seed: [u8; 32] = hasher.finalize().into();
    let der = seed_to_pkcs8_v1(&seed);
    let key_pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der)
        .map_err(|_| anyhow::anyhow!("derived Ed25519 key did not round-trip"))?;
    let public = key_pair.public_key().as_ref().to_vec();
    tracing::warn!(
        "JWT signing key DERIVED from the JWT__PRIVATE_KEY_PEM secret (the value is not a \
         PKCS#8 key). Expected when using an auto-generated random secret; the key is stable \
         as long as the secret is unchanged."
    );
    Ok((der, public))
}

/// Wraps a raw 32-byte Ed25519 seed in a PKCS#8 v1 (`PrivateKeyInfo`) DER envelope
/// that `ring` accepts. The 16-byte prefix is the fixed ASN.1 header for an
/// Ed25519 (OID 1.3.101.112) `CurvePrivateKey` octet string.
fn seed_to_pkcs8_v1(seed: &[u8; 32]) -> Vec<u8> {
    const PREFIX: [u8; 16] = [
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    let mut der = Vec::with_capacity(PREFIX.len() + seed.len());
    der.extend_from_slice(&PREFIX);
    der.extend_from_slice(seed);
    der
}

/// Parses a PKCS#8 Ed25519 private-key PEM into `(pkcs8_der, public_key_raw)`.
fn parse_ed25519_pkcs8(pem: &str) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let b64: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<String>();
    let der = BASE64
        .decode(b64.trim().as_bytes())
        .context("base64-decoding PEM body")?;
    // `maybe_unchecked` accepts both PKCS#8 v1 (private key only, e.g. from
    // `openssl genpkey`) and v2 (private + public, e.g. from ring) — v1 is the
    // common external form, so support it.
    let key_pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der)
        .map_err(|_| anyhow::anyhow!("not a valid PKCS#8 Ed25519 private key"))?;
    let public = key_pair.public_key().as_ref().to_vec();
    Ok((der, public))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ED25519, Ed25519KeyPair, UnparsedPublicKey};

    /// A plain random secret must yield a working Ed25519 key that actually
    /// signs and verifies — and, critically, the SAME key every time so tokens
    /// survive restarts and validate across replicas.
    #[test]
    fn derives_stable_working_key_from_plain_secret() {
        // 64 alphanumeric chars — exactly what Coolify's SERVICE_PASSWORD_64_* mints
        // (and coincidentally valid base64, so this also covers the "decodes to 48
        // bytes but isn't a PKCS#8 key" path).
        let secret = "abcdEFGH1234abcdEFGH1234abcdEFGH1234abcdEFGH1234abcdEFGH12345678";
        let (der1, pub1) = load_ed25519_key(secret).unwrap();
        let (der2, pub2) = load_ed25519_key(secret).unwrap();
        assert_eq!(der1, der2, "derivation must be deterministic");
        assert_eq!(pub1, pub2);
        assert_eq!(pub1.len(), 32);

        let kp = Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der1).unwrap();
        let sig = kp.sign(b"accord");
        UnparsedPublicKey::new(&ED25519, &pub1)
            .verify(b"accord", sig.as_ref())
            .expect("derived key must sign+verify");
    }

    #[test]
    fn different_secrets_derive_different_keys() {
        let (_, a) = load_ed25519_key("secret-one-secret-one-secret-one-xx").unwrap();
        let (_, b) = load_ed25519_key("secret-two-secret-two-secret-two-yy").unwrap();
        assert_ne!(a, b);
    }

    /// A real PKCS#8 key (here ring-generated, base64) is used verbatim, not
    /// hashed — the "bring your own key" path stays byte-for-byte intact.
    #[test]
    fn loads_real_pkcs8_key_verbatim() {
        let (der, public) = generate_ed25519().unwrap();
        let b64 = BASE64.encode(&der);
        let (loaded_der, loaded_pub) = load_ed25519_key(&b64).unwrap();
        assert_eq!(loaded_der, der);
        assert_eq!(loaded_pub, public);
    }

    #[test]
    fn rejects_empty_secret() {
        assert!(load_ed25519_key("   ").is_err());
    }

    /// A value that carries PEM armor but isn't a valid key must FAIL, not silently
    /// derive a different key — otherwise a corrupted "bring your own key" would sign
    /// with a key the operator never intended.
    #[test]
    fn rejects_pem_armored_but_invalid_key() {
        let broken = "-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----";
        assert!(load_ed25519_key(broken).is_err());
    }
}
