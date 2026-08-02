//! Device identity keys repository (E2EE key distribution). The server only ever
//! stores and returns PUBLIC keys — compile-checked by the sqlx macros.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::ApiError;

/// One device's published public identity key.
#[derive(Debug, Clone)]
pub struct DeviceKey {
    pub device_id: String,
    pub public_key: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

/// Publishes (or re-publishes) the caller's public key for a device. Re-publishing
/// replaces the key and clears any prior revocation for that device.
pub async fn publish(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    device_id: &str,
    public_key: &[u8],
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO device_keys (user_id, device_id, public_key) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, device_id) \
         DO UPDATE SET public_key = $3, created_at = now(), revoked_at = NULL",
        user_id,
        device_id,
        public_key,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns a user's active (non-revoked) device public keys — their key bundle.
pub async fn list_active(pool: &sqlx::PgPool, user_id: Uuid) -> Result<Vec<DeviceKey>, ApiError> {
    sqlx::query_as!(
        DeviceKey,
        "SELECT device_id, public_key, created_at FROM device_keys \
         WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at",
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Revokes one of the caller's devices. Returns whether a device was revoked.
pub async fn revoke(pool: &sqlx::PgPool, user_id: Uuid, device_id: &str) -> Result<bool, ApiError> {
    let affected = sqlx::query!(
        "UPDATE device_keys SET revoked_at = now() \
         WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
        user_id,
        device_id,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok(affected > 0)
}
