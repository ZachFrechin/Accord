//! Comptes de jeu du profil — liaison, rangs, rafraîchissement.
//!
//! `GET /games/accounts` renvoie aussi quels jeux sont CONFIGURÉS (clé API
//! présente) pour que le client grise le reste. Les identifiants externes ne
//! sortent jamais vers les AUTRES utilisateurs (seul le nom d'affichage +
//! rang sont publics).

use axum::Json;
use axum::extract::{Path, State};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::games;
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::game_account_repo;
use crate::state::AppState;

/// Rafraîchissement manuel : au plus une fois toutes les 2 minutes par compte.
const REFRESH_MIN_SECS: i64 = 120;
/// À l'affichage d'un profil, un rang plus vieux que ceci se rafraîchit en fond.
const STALE_SECS: i64 = 12 * 3600;

fn account_json(row: &game_account_repo::GameAccountRow, include_ids: bool) -> Value {
    let mut v = json!({
        "game": row.game,
        "external_name": row.external_name,
        "region": row.region,
        "rank": row.rank_payload,
        "rank_updated_at": row.rank_updated_at,
    });
    if include_ids {
        v["external_id"] = json!(row.external_id);
    }
    v
}

/// `GET /games/accounts` — les comptes du caller + les jeux configurés.
pub async fn mine(
    State(state): State<AppState>,
    caller: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = game_account_repo::list_for_user(&state.db, caller.user_id).await?;
    let accounts: Vec<Value> = rows.iter().map(|r| account_json(r, true)).collect();
    Ok(Json(json!({
        "accounts": accounts,
        "configured": {
            "lol": !state.config.games.riot_api_key.trim().is_empty(),
            "cs2": !state.config.games.faceit_api_key.trim().is_empty(),
            "valorant": false,
            "rocket-league": false,
        },
    })))
}

/// `GET /users/{id}/games` — comptes visibles sur un profil. Un rang trop
/// vieux déclenche un rafraîchissement en tâche de fond (best-effort).
pub async fn of_user(
    State(state): State<AppState>,
    _caller: AuthUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let rows = game_account_repo::list_for_user(&state.db, user_id).await?;
    for row in &rows {
        let stale = row
            .rank_updated_at
            .is_none_or(|t| (Utc::now() - t).num_seconds() > STALE_SECS);
        if stale {
            spawn_refresh(&state, user_id, row);
        }
    }
    let accounts: Vec<Value> = rows.iter().map(|r| account_json(r, false)).collect();
    Ok(Json(json!({ "accounts": accounts })))
}

fn spawn_refresh(state: &AppState, user_id: Uuid, row: &game_account_repo::GameAccountRow) {
    let state = state.clone();
    let game = row.game.clone();
    let external_id = row.external_id.clone();
    let region = row.region.clone();
    tokio::spawn(async move {
        let rank = match game.as_str() {
            games::GAME_LOL => {
                games::fetch_lol_rank(
                    &state.config.games.riot_api_key,
                    region.as_deref().unwrap_or("euw1"),
                    &external_id,
                )
                .await
            }
            games::GAME_CS2 => {
                games::fetch_faceit_rank(&state.config.games.faceit_api_key, &external_id).await
            }
            _ => return,
        };
        match rank {
            Ok(payload) => {
                if let Err(e) =
                    game_account_repo::update_rank(&state.db, user_id, &game, &payload).await
                {
                    tracing::warn!(error = %e, %game, "game rank persist failed");
                }
            }
            Err(e) => tracing::debug!(error = %e, %game, "background rank refresh failed"),
        }
    });
}

/// Corps de `PUT /games/accounts/{game}` — champs selon le jeu.
#[derive(Debug, Deserialize)]
pub struct LinkBody {
    /// LoL : « Pseudo#TAG ».
    #[serde(default)]
    pub riot_id: Option<String>,
    /// LoL : plateforme (euw1, na1…).
    #[serde(default)]
    pub platform: Option<String>,
    /// CS2 : pseudo FACEIT.
    #[serde(default)]
    pub nickname: Option<String>,
}

/// `PUT /games/accounts/{game}` — lier (ou re-lier) un compte et lire son rang.
pub async fn link(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(game): Path<String>,
    Json(body): Json<LinkBody>,
) -> Result<Json<Value>, ApiError> {
    let resolved = match game.as_str() {
        games::GAME_LOL => {
            let riot_id = body
                .riot_id
                .as_deref()
                .ok_or_else(|| ApiError::Validation("riot_id requis".to_string()))?;
            let platform = body.platform.as_deref().unwrap_or("euw1");
            games::link_lol(&state.config.games.riot_api_key, riot_id, platform).await?
        }
        games::GAME_CS2 => {
            let nickname = body
                .nickname
                .as_deref()
                .ok_or_else(|| ApiError::Validation("nickname requis".to_string()))?;
            games::link_faceit(&state.config.games.faceit_api_key, nickname).await?
        }
        g if games::KNOWN_GAMES.contains(&g) => {
            return Err(ApiError::ServiceUnavailable(
                "ce jeu arrive bientôt".to_string(),
            ));
        }
        _ => return Err(ApiError::Validation("jeu inconnu".to_string())),
    };
    game_account_repo::upsert(
        &state.db,
        caller.user_id,
        &game,
        &resolved.external_id,
        &resolved.external_name,
        resolved.region.as_deref(),
        &resolved.rank,
    )
    .await?;
    let row = game_account_repo::get(&state.db, caller.user_id, &game)
        .await?
        .ok_or_else(|| ApiError::NotFound("compte introuvable".to_string()))?;
    Ok(Json(account_json(&row, true)))
}

/// `POST /games/accounts/{game}/refresh` — relire le rang (throttlé).
pub async fn refresh(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(game): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row = game_account_repo::get(&state.db, caller.user_id, &game)
        .await?
        .ok_or_else(|| ApiError::NotFound("aucun compte lié pour ce jeu".to_string()))?;
    if let Some(t) = row.rank_updated_at
        && (Utc::now() - t).num_seconds() < REFRESH_MIN_SECS
    {
        return Err(ApiError::TooManyRequests(
            "rang déjà rafraîchi il y a moins de 2 minutes".to_string(),
        ));
    }
    let rank = match game.as_str() {
        games::GAME_LOL => {
            games::fetch_lol_rank(
                &state.config.games.riot_api_key,
                row.region.as_deref().unwrap_or("euw1"),
                &row.external_id,
            )
            .await?
        }
        games::GAME_CS2 => {
            games::fetch_faceit_rank(&state.config.games.faceit_api_key, &row.external_id).await?
        }
        _ => return Err(ApiError::Validation("jeu inconnu".to_string())),
    };
    game_account_repo::update_rank(&state.db, caller.user_id, &game, &rank).await?;
    let row = game_account_repo::get(&state.db, caller.user_id, &game)
        .await?
        .ok_or_else(|| ApiError::NotFound("compte introuvable".to_string()))?;
    Ok(Json(account_json(&row, true)))
}

/// `DELETE /games/accounts/{game}` — délier.
pub async fn unlink(
    State(state): State<AppState>,
    caller: AuthUser,
    Path(game): Path<String>,
) -> Result<Json<Value>, ApiError> {
    game_account_repo::delete(&state.db, caller.user_id, &game).await?;
    Ok(Json(json!({ "status": "deleted" })))
}
