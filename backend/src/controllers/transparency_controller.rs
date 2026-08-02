//! Key-transparency endpoints (Phase 3 · Lot 6).
//!
//! Serve the append-only log so a client can (1) fetch the current Signed Tree
//! Head, (2) prove a device's published key is included in the log, and (3) prove
//! a newer head is an append-only extension of an older one. Combined with
//! out-of-band gossip of the STH, this makes a server that equivocates on a key
//! detectable. All computation reuses the audited [`crate::domain::transparency`]
//! core; the tree is rebuilt from stored leaf hashes per request.

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::Utc;
use data_encoding::{BASE64, HEXLOWER};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::transparency::{Hash, MerkleLog, binding_leaf, hash_leaf};
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::{device_key_repo, transparency_repo};
use crate::state::AppState;

fn hex_all(hashes: &[Hash]) -> Vec<String> {
    hashes.iter().map(|h| HEXLOWER.encode(h)).collect()
}

/// `GET /transparency/sth` — the current Signed Tree Head: the tree size, its root,
/// and a JWT signature over both (verifiable against `/.well-known/jwks.json`).
pub async fn sth(State(state): State<AppState>, _caller: AuthUser) -> Result<Json<Value>, ApiError> {
    let log = MerkleLog::from_leaf_hashes(transparency_repo::all_leaf_hashes(&state.db).await?);
    let size = log.size() as u64;
    let root = HEXLOWER.encode(&log.root());
    let sth = state.keyring.mint_sth(size, &root, Utc::now().timestamp())?;
    Ok(Json(json!({ "tree_size": size, "root": root, "sth": sth })))
}

/// `GET /transparency/inclusion/{user_id}/{device_id}` — proof that the device's
/// currently-published key is a leaf of the log. The client checks the returned
/// `public_key` matches the one it received, then verifies `proof` against a head.
pub async fn inclusion(
    State(state): State<AppState>,
    _caller: AuthUser,
    Path((user_id, device_id)): Path<(Uuid, String)>,
) -> Result<Json<Value>, ApiError> {
    let key = device_key_repo::list_active(&state.db, user_id)
        .await?
        .into_iter()
        .find(|k| k.device_id == device_id)
        .ok_or_else(|| ApiError::NotFound("no active key for this device".to_string()))?;

    let leaf = hash_leaf(&binding_leaf(user_id.as_bytes(), &device_id, &key.public_key));
    let log = MerkleLog::from_leaf_hashes(transparency_repo::all_leaf_hashes(&state.db).await?);
    let index = log
        .index_of(&leaf)
        .ok_or_else(|| ApiError::NotFound("binding not yet in the transparency log".to_string()))?;
    let proof = log.inclusion_proof(index).expect("index is in range");

    Ok(Json(json!({
        "user_id": user_id,
        "device_id": device_id,
        "public_key": BASE64.encode(&key.public_key),
        "index": index,
        "tree_size": log.size(),
        "root": HEXLOWER.encode(&log.root()),
        "proof": hex_all(&proof),
    })))
}

/// Query for [`consistency`].
#[derive(Debug, Deserialize)]
pub struct ConsistencyQuery {
    /// The old (smaller) tree size the client already trusts.
    first: usize,
    /// The new tree size (defaults to the current size).
    #[serde(default)]
    second: Option<usize>,
}

/// `GET /transparency/consistency?first=M&second=N` — proof that the size-`N` tree
/// (root returned) is an append-only extension of the size-`M` tree (whose root
/// the client holds from an earlier head). `N` defaults to the current size.
pub async fn consistency(
    State(state): State<AppState>,
    _caller: AuthUser,
    Query(q): Query<ConsistencyQuery>,
) -> Result<Json<Value>, ApiError> {
    let leaves = transparency_repo::all_leaf_hashes(&state.db).await?;
    let current = leaves.len();
    let second = q.second.unwrap_or(current);
    if q.first == 0 || q.first > second || second > current {
        return Err(ApiError::Validation("invalid first/second sizes".to_string()));
    }
    let tree = MerkleLog::from_leaf_hashes(leaves[..second].to_vec());
    let proof = tree
        .consistency_proof(q.first)
        .ok_or_else(|| ApiError::Validation("no consistency proof for these sizes".to_string()))?;
    Ok(Json(json!({
        "first": q.first,
        "second": second,
        "second_root": HEXLOWER.encode(&tree.root()),
        "proof": hex_all(&proof),
    })))
}
