//! Comptes de jeu liés (rangs de profil) — une ligne par (utilisateur, jeu).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

pub struct GameAccountRow {
    pub game: String,
    pub external_id: String,
    pub external_name: String,
    pub region: Option<String>,
    pub rank_payload: serde_json::Value,
    pub rank_updated_at: Option<DateTime<Utc>>,
}

pub async fn upsert(
    pool: &PgPool,
    user_id: Uuid,
    game: &str,
    external_id: &str,
    external_name: &str,
    region: Option<&str>,
    rank_payload: &serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"INSERT INTO game_accounts
             (user_id, game, external_id, external_name, region, rank_payload, rank_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (user_id, game) DO UPDATE SET
             external_id = EXCLUDED.external_id,
             external_name = EXCLUDED.external_name,
             region = EXCLUDED.region,
             rank_payload = EXCLUDED.rank_payload,
             rank_updated_at = now()"#,
        user_id,
        game,
        external_id,
        external_name,
        region,
        rank_payload,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_rank(
    pool: &PgPool,
    user_id: Uuid,
    game: &str,
    rank_payload: &serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query!(
        r#"UPDATE game_accounts SET rank_payload = $3, rank_updated_at = now()
           WHERE user_id = $1 AND game = $2"#,
        user_id,
        game,
        rank_payload,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get(
    pool: &PgPool,
    user_id: Uuid,
    game: &str,
) -> Result<Option<GameAccountRow>, ApiError> {
    Ok(sqlx::query_as!(
        GameAccountRow,
        r#"SELECT game, external_id, external_name, region, rank_payload, rank_updated_at
           FROM game_accounts WHERE user_id = $1 AND game = $2"#,
        user_id,
        game,
    )
    .fetch_optional(pool)
    .await?)
}

pub async fn list_for_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<GameAccountRow>, ApiError> {
    Ok(sqlx::query_as!(
        GameAccountRow,
        r#"SELECT game, external_id, external_name, region, rank_payload, rank_updated_at
           FROM game_accounts WHERE user_id = $1 ORDER BY game"#,
        user_id,
    )
    .fetch_all(pool)
    .await?)
}

pub async fn delete(pool: &PgPool, user_id: Uuid, game: &str) -> Result<(), ApiError> {
    sqlx::query!(
        "DELETE FROM game_accounts WHERE user_id = $1 AND game = $2",
        user_id,
        game,
    )
    .execute(pool)
    .await?;
    Ok(())
}
