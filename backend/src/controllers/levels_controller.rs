//! Instance leveling — XP/level of a user and the leaderboard.
//! XP is GRANTED elsewhere (message send, MLS frame, call leave); this
//! controller only reads.

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::{storage, xp};
use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::repositories::xp_repo;
use crate::state::AppState;

fn level_payload(xp_total: i64) -> Value {
    let level = xp::level_for_xp(xp_total);
    json!({
        "xp": xp_total,
        "level": level,
        "level_floor": xp::xp_for_level(level),
        "next_level_at": xp::xp_for_level(level + 1),
    })
}

/// `GET /levels/me` — the caller's XP and level.
pub async fn me(State(state): State<AppState>, caller: AuthUser) -> Result<Json<Value>, ApiError> {
    let total = xp_repo::xp_of(&state.db, caller.user_id).await?;
    Ok(Json(level_payload(total)))
}

/// `GET /levels/users/{id}` — any user's XP and level (profile display).
pub async fn user(
    State(state): State<AppState>,
    _caller: AuthUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let total = xp_repo::xp_of(&state.db, user_id).await?;
    Ok(Json(level_payload(total)))
}

/// Query of `GET /levels/leaderboard`.
#[derive(Debug, Deserialize)]
pub struct LeaderboardQuery {
    /// `all` (default) or `week`.
    #[serde(default)]
    pub period: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `GET /levels/leaderboard?period=all|week` — top of the instance.
pub async fn leaderboard(
    State(state): State<AppState>,
    _caller: AuthUser,
    Query(q): Query<LeaderboardQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let week = q.period.as_deref() == Some("week");
    let rows = if week {
        xp_repo::leaderboard_week(&state.db, limit).await?
    } else {
        xp_repo::leaderboard_all(&state.db, limit).await?
    };
    let items: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "user_id": r.user_id,
                "username": r.username,
                "display_name": r.display_name,
                "avatar_url": storage::avatar_public_url(&state.config.storage, &r.user_id, r.avatar_version),
                "xp": r.xp,
                "level": xp::level_for_xp(r.xp),
            })
        })
        .collect();
    Ok(Json(
        json!({ "items": items, "period": if week { "week" } else { "all" } }),
    ))
}
