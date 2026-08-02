//! MLS KeyPackage directory repository (Phase 3 · Lot 2).
//!
//! Stores and serves PUBLIC, opaque KeyPackage bytes only — no secret ever
//! reaches the server (a KeyPackage has none). Single-use is enforced here with
//! an atomic claim (RFC 9750 delegates it to the Delivery Service), correct
//! across all stateless replicas via `FOR UPDATE SKIP LOCKED`.

use uuid::Uuid;

use crate::error::ApiError;

/// A claimed KeyPackage plus whether it was the reusable last-resort fallback.
pub struct ClaimedKeyPackage {
    pub kp_data: Vec<u8>,
    pub last_resort: bool,
}

/// Publishes a pool of single-use KeyPackages for one of the caller's devices.
/// De-duplicates by (user_id, kp_ref) so a retried publish is idempotent.
pub async fn publish_pool(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    device_id: &str,
    refs: &[Vec<u8>],
    datas: &[Vec<u8>],
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO mls_key_packages (user_id, device_id, kp_ref, kp_data) \
         SELECT $1, $2, r, d FROM UNNEST($3::bytea[], $4::bytea[]) AS t(r, d) \
         ON CONFLICT (user_id, kp_ref) DO NOTHING",
        user_id,
        device_id,
        refs,
        datas,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Sets (replacing any prior) the single last-resort KeyPackage for a device.
pub async fn set_last_resort(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    device_id: &str,
    kp_ref: &[u8],
    kp_data: &[u8],
) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "DELETE FROM mls_key_packages WHERE user_id = $1 AND device_id = $2 AND last_resort",
        user_id,
        device_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO mls_key_packages (user_id, device_id, kp_ref, kp_data, last_resort) \
         VALUES ($1, $2, $3, $4, true) \
         ON CONFLICT (user_id, kp_ref) \
         DO UPDATE SET kp_data = $4, last_resort = true, consumed_at = NULL",
        user_id,
        device_id,
        kp_ref,
        kp_data,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Atomically claims one KeyPackage for `(user_id, device_id)`: consumes the
/// oldest available single-use package, or falls back to the reusable last-resort
/// one. Returns `None` only if the device has published nothing at all.
pub async fn claim(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    device_id: &str,
) -> Result<Option<ClaimedKeyPackage>, ApiError> {
    // Single-use: pick + consume atomically (skip-locked → safe under concurrency).
    let single = sqlx::query_scalar!(
        "WITH picked AS ( \
             SELECT id FROM mls_key_packages \
             WHERE user_id = $1 AND device_id = $2 AND consumed_at IS NULL AND NOT last_resort \
             ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE mls_key_packages SET consumed_at = now() \
         WHERE id IN (SELECT id FROM picked) RETURNING kp_data",
        user_id,
        device_id,
    )
    .fetch_optional(pool)
    .await?;
    if let Some(kp_data) = single {
        return Ok(Some(ClaimedKeyPackage {
            kp_data,
            last_resort: false,
        }));
    }

    // Pool exhausted → reusable last-resort package (client should rotate it).
    let last = sqlx::query_scalar!(
        "SELECT kp_data FROM mls_key_packages \
         WHERE user_id = $1 AND device_id = $2 AND last_resort LIMIT 1",
        user_id,
        device_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(last.map(|kp_data| ClaimedKeyPackage {
        kp_data,
        last_resort: true,
    }))
}

/// Count of a device's remaining available single-use KeyPackages (low-watermark).
pub async fn count_available(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    device_id: &str,
) -> Result<i64, ApiError> {
    let count = sqlx::query_scalar!(
        "SELECT count(*) AS \"count!\" FROM mls_key_packages \
         WHERE user_id = $1 AND device_id = $2 AND consumed_at IS NULL AND NOT last_resort",
        user_id,
        device_id,
    )
    .fetch_one(pool)
    .await?;
    Ok(count)
}
