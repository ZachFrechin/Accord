//! Appareils enregistrés pour le réveil par push.
//!
//! Le jeton identifie une installation, pas une personne : il change à chaque
//! réinstallation, et Google peut le réattribuer. D'où l'enregistrement
//! idempotent sur le jeton — si le même jeton revient pour quelqu'un d'autre,
//! c'est le nouveau propriétaire qui compte, et l'ancien ne doit surtout plus
//! recevoir ses réveils.

use uuid::Uuid;

use crate::error::ApiError;

/// Un appareil à réveiller.
pub struct PushDevice {
    pub token: String,
}

/// Enregistre (ou réattribue) un jeton d'appareil.
pub async fn upsert(
    db: &sqlx::PgPool,
    user_id: Uuid,
    token: &str,
    platform: &str,
) -> Result<Uuid, ApiError> {
    let row = sqlx::query!(
        r#"
        INSERT INTO push_devices (user_id, token, platform)
        VALUES ($1, $2, $3)
        ON CONFLICT (token) DO UPDATE
          SET user_id = EXCLUDED.user_id,
              platform = EXCLUDED.platform,
              last_seen_at = now()
        RETURNING id
        "#,
        user_id,
        token,
        platform
    )
    .fetch_one(db)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("enregistrement de l'appareil : {e}")))?;
    Ok(row.id)
}

/// Retire un jeton — déconnexion, ou jeton que Google déclare mort.
pub async fn delete(db: &sqlx::PgPool, token: &str) -> Result<(), ApiError> {
    sqlx::query!("DELETE FROM push_devices WHERE token = $1", token)
        .execute(db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("retrait de l'appareil : {e}")))?;
    Ok(())
}

/// Les appareils d'une personne.
pub async fn for_user(db: &sqlx::PgPool, user_id: Uuid) -> Result<Vec<PushDevice>, ApiError> {
    let rows = sqlx::query!("SELECT token FROM push_devices WHERE user_id = $1", user_id)
        .fetch_all(db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("lecture des appareils : {e}")))?;
    Ok(rows
        .into_iter()
        .map(|r| PushDevice { token: r.token })
        .collect())
}
