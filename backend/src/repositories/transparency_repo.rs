//! Key-transparency log storage (Phase 3 · Lot 6). Append-only: leaves are only
//! ever inserted, never updated or deleted, so the leaf order (and thus every
//! proof) is stable. The Merkle tree itself is recomputed from the stored leaf
//! hashes on demand (see [`crate::domain::transparency`]).

use uuid::Uuid;

use crate::domain::transparency::{Hash, binding_leaf, hash_leaf};
use crate::error::ApiError;

/// Append an identity↔key binding to the log. Idempotent: re-publishing an
/// identical binding maps to the same leaf hash and is ignored (`DO NOTHING`).
pub async fn append_binding(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    device_id: &str,
    public_key: &[u8],
) -> Result<(), ApiError> {
    let leaf = hash_leaf(&binding_leaf(user_id.as_bytes(), device_id, public_key));
    sqlx::query!(
        "INSERT INTO key_transparency_log (leaf_hash, user_id, device_id, public_key) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (leaf_hash) DO NOTHING",
        &leaf[..],
        user_id,
        device_id,
        public_key,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// All leaf hashes in append (seq) order — the material to rebuild the tree.
pub async fn all_leaf_hashes(pool: &sqlx::PgPool) -> Result<Vec<Hash>, ApiError> {
    let rows = sqlx::query!("SELECT leaf_hash FROM key_transparency_log ORDER BY seq")
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let h: Hash = r
            .leaf_hash
            .try_into()
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("corrupt leaf hash width")))?;
        out.push(h);
    }
    Ok(out)
}
