//! LiveKit access-token minting (Phase 4, voice/video).
//!
//! The backend is the only trusted authority: it verifies conversation membership
//! then signs a short-lived HS256 JWT that authorizes a participant to join a
//! room. No LiveKit SDK — just the `jsonwebtoken` crate the app already uses. The
//! SFU routes media the server never decrypts (E2EE keys are derived client-side
//! from the MLS group exporter, never from LiveKit).

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::Serialize;

use crate::error::ApiError;

/// The `video` grant nested in a LiveKit token — what the participant may do.
/// Field names are camelCase on the wire (LiveKit's schema).
#[derive(Debug, Serialize)]
struct VideoGrant<'a> {
    room: &'a str,
    #[serde(rename = "roomJoin")]
    room_join: bool,
    #[serde(rename = "canPublish")]
    can_publish: bool,
    #[serde(rename = "canSubscribe")]
    can_subscribe: bool,
    #[serde(rename = "canPublishData")]
    can_publish_data: bool,
}

/// LiveKit access-token claims. Flat JWT claims (`iss` = api key, `sub` = the
/// participant identity) with the grant nested under `video`.
#[derive(Debug, Serialize)]
struct LiveKitClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    nbf: i64,
    iat: i64,
    exp: i64,
    video: VideoGrant<'a>,
}

/// Mints a LiveKit JWT authorizing `identity` to join `room`, valid `ttl_secs`
/// from `now` (unix seconds). Full publish/subscribe grants (a symmetric call).
pub fn mint_livekit_token(
    api_key: &str,
    api_secret: &str,
    identity: &str,
    room: &str,
    ttl_secs: i64,
    now: i64,
) -> Result<String, ApiError> {
    let claims = LiveKitClaims {
        iss: api_key,
        sub: identity,
        nbf: now,
        iat: now,
        exp: now + ttl_secs,
        video: VideoGrant {
            room,
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
        },
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("livekit token encode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
    use serde_json::Value;

    #[test]
    fn token_has_flat_claims_and_nested_camelcase_video_grant() {
        let token =
            mint_livekit_token("accord_key", "accord_dev_secret", "user-1:dev-a", "conv-42", 600, 1_000)
                .expect("mint");

        // Verify the signature with the same secret, then inspect the claims.
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = false; // fixed `now` in the test
        validation.set_required_spec_claims::<&str>(&[]);
        let data = decode::<Value>(
            &token,
            &DecodingKey::from_secret(b"accord_dev_secret"),
            &validation,
        )
        .expect("decode+verify");
        let c = data.claims;

        assert_eq!(c["iss"], "accord_key");
        assert_eq!(c["sub"], "user-1:dev-a");
        assert_eq!(c["nbf"], 1_000);
        assert_eq!(c["exp"], 1_600);
        // Grant is nested under `video`, camelCase, no "grants" wrapper.
        assert_eq!(c["video"]["room"], "conv-42");
        assert_eq!(c["video"]["roomJoin"], true);
        assert_eq!(c["video"]["canPublish"], true);
        assert_eq!(c["video"]["canSubscribe"], true);
        assert!(c.get("grants").is_none());
    }

    #[test]
    fn wrong_secret_fails_verification() {
        let token = mint_livekit_token("accord_key", "right", "u", "r", 600, 0).unwrap();
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_exp = false;
        v.set_required_spec_claims::<&str>(&[]);
        assert!(decode::<Value>(&token, &DecodingKey::from_secret(b"wrong"), &v).is_err());
    }
}
