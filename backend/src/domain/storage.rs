//! S3-compatible object storage: SigV4 presigned URLs.
//!
//! The backend never touches attachment bytes — it signs a short-lived URL the
//! client uses to PUT/GET directly against storage (MinIO). The bytes are
//! ciphertext the client encrypted end-to-end, so storage (like the backend)
//! only ever holds opaque data.

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::config::StorageConfig;

type HmacSha256 = Hmac<Sha256>;

/// URI-encodes per AWS SigV4 rules. With `encode_slash = false`, `/` is kept
/// verbatim (used for the canonical object path).
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Builds a SigV4 presigned URL for `method` (`GET`/`PUT`) on `bucket`/`key`.
///
/// Host and URL both come from the client-facing endpoint so the `Host` header
/// the client sends matches what was signed (SigV4 signs the host).
pub fn presign(
    config: &StorageConfig,
    bucket: &str,
    method: &str,
    key: &str,
    expires_secs: u64,
) -> String {
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let scope = format!("{date}/{}/s3/aws4_request", config.region);

    let base = config
        .public_endpoint
        .as_deref()
        .unwrap_or(&config.endpoint)
        .trim_end_matches('/');
    let host = base.split("://").nth(1).unwrap_or(base);

    let canonical_uri = format!("/{}/{}", bucket, uri_encode(key, false));

    // Canonical query: sorted by key, values URI-encoded.
    let mut query = [
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
        ("X-Amz-Credential", format!("{}/{scope}", config.access_key)),
        ("X-Amz-Date", amz_date.clone()),
        ("X-Amz-Expires", expires_secs.to_string()),
        ("X-Amz-SignedHeaders", "host".to_string()),
    ];
    query.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD"
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac(
        format!("AWS4{}", config.secret_key).as_bytes(),
        date.as_bytes(),
    );
    let k_region = hmac(&k_date, config.region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));

    format!(
        "{base}/{}/{}?{canonical_query}&X-Amz-Signature={signature}",
        bucket,
        uri_encode(key, false),
    )
}

/// The storage object key for an attachment blob.
pub fn attachment_key(conversation_id: &uuid::Uuid, blob_id: &uuid::Uuid) -> String {
    format!("att/{conversation_id}/{blob_id}")
}

/// The storage key for a user's avatar (versioned so the public URL cache-busts).
pub fn avatar_key(user_id: &uuid::Uuid, version: i32) -> String {
    format!("{user_id}/{version}")
}

/// The storage key for a user's banner (in the same public bucket, `banner/` prefix).
pub fn banner_key(user_id: &uuid::Uuid, version: i32) -> String {
    format!("banner/{user_id}/{version}")
}

/// Stable public URL for an avatar, or `None` when `version <= 0`.
pub fn avatar_public_url(
    config: &StorageConfig,
    user_id: &uuid::Uuid,
    version: i32,
) -> Option<String> {
    public_url(config, &avatar_key(user_id, version), version)
}

/// Stable public URL for a banner, or `None` when `version <= 0`.
pub fn banner_public_url(
    config: &StorageConfig,
    user_id: &uuid::Uuid,
    version: i32,
) -> Option<String> {
    public_url(config, &banner_key(user_id, version), version)
}

/// The stable, public (unsigned) URL for `key` in the public-read avatars bucket,
/// or `None` when `version <= 0`. Cacheable; the version invalidates the cache.
fn public_url(config: &StorageConfig, key: &str, version: i32) -> Option<String> {
    if version <= 0 {
        return None;
    }
    let base = config
        .public_endpoint
        .as_deref()
        .unwrap_or(&config.endpoint)
        .trim_end_matches('/');
    Some(format!("{base}/{}/{}", config.avatars_bucket, key))
}
