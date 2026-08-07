use std::time::Duration;

use sqlx::PgPool;

use crate::config::StorageConfig;
use crate::domain::storage;
use crate::repositories::call_sound_asset_repo;

const CLEANUP_BATCH: i64 = 100;

pub async fn run_worker(pool: PgPool, storage_config: StorageConfig) {
    loop {
        if let Err(error) = cleanup_once(&pool, &storage_config).await {
            tracing::warn!(error = %error, "call sound cleanup failed; will retry");
        }
        tokio::time::sleep(Duration::from_secs(60 * 60)).await;
    }
}

async fn cleanup_once(pool: &PgPool, config: &StorageConfig) -> anyhow::Result<usize> {
    let expired = call_sound_asset_repo::expired(pool, CLEANUP_BATCH).await?;
    let client = reqwest::Client::new();
    let mut removed = 0;
    for (conversation_id, blob_id) in expired {
        let key = storage::attachment_key(&conversation_id, &blob_id);
        let url = storage::presign(config, &config.bucket, "DELETE", &key, 60);
        let response = client.delete(url).send().await;
        let object_gone = response
            .as_ref()
            .is_ok_and(|r| r.status().is_success() || r.status() == reqwest::StatusCode::NOT_FOUND);
        if object_gone
            && call_sound_asset_repo::remove_if_expired(pool, conversation_id, blob_id).await?
        {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!(removed, "expired call sound assets cleaned");
    }
    Ok(removed)
}
