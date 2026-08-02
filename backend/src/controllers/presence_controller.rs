//! Presence snapshot endpoint.

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::auth::AuthUser;
use crate::realtime::presence;
use crate::state::AppState;

/// Cap on how many users one snapshot request may ask about.
const MAX_IDS: usize = 100;

/// Query: `?ids=uuid1,uuid2,...`.
#[derive(Debug, Deserialize)]
pub struct PresenceQuery {
    #[serde(default)]
    ids: String,
}

/// `GET /presences?ids=…` — the effective status of each requested user.
///
/// Authenticated. In Phase 1 any signed-in user may query (there is no social
/// graph yet); a later phase gates this by relationship.
pub async fn snapshot(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<PresenceQuery>,
) -> Result<Json<Value>, ApiError> {
    let ids: Vec<Uuid> = query
        .ids
        .split(',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| Uuid::parse_str(s.trim()).ok())
        .take(MAX_IDS)
        .collect();

    let statuses = presence::snapshot(&state.redis, &ids).await?;
    // Return ONLY the bare status here — this endpoint is un-gated by relationship
    // (any signed-in user may query any id), so it must NOT expose the custom
    // status text, which is friends-only (see friend_controller). Text rides the
    // accepted-friends path of /friends instead.
    let map: serde_json::Map<String, Value> = statuses
        .into_iter()
        .map(|(id, eff)| (id.to_string(), json!(eff.status)))
        .collect();
    Ok(Json(Value::Object(map)))
}
