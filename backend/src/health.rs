//! Kubernetes-style health probes.
//!
//! Two distinct endpoints with different contracts:
//! - **liveness** (`/health/live`) answers "is the process running?" — it must
//!   never depend on external systems, or a transient backend blip would get the
//!   pod killed and restarted pointlessly.
//! - **readiness** (`/health/ready`) answers "should this replica receive
//!   traffic?" — it verifies every shared backend (Postgres, Redis, NATS) so the
//!   load balancer can drain a replica whose dependencies are down.

use async_nats::connection::State as NatsState;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde_json::json;

use crate::state::AppState;

/// `GET /health/live` — always returns `200 OK` while the process can serve
/// requests. Intended for the liveness probe; deliberately dependency-free.
pub async fn live() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "live" })))
}

/// `GET /health/ready` — `200` when every shared backend is reachable, else `503`.
///
/// Checks Postgres (`SELECT 1`), Redis (`PING`) and the NATS connection state.
/// The body reports each dependency (`"up"`/`"down"`) so operators can see which
/// one is failing, but never leaks the underlying error to the client. A `503`
/// tells the orchestrator to stop routing traffic to this replica.
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();

    let redis_ok = match state.redis.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            let pong: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
            pong.is_ok()
        }
        Err(_) => false,
    };

    let nats_ok = matches!(state.nats.connection_state(), NatsState::Connected);

    let all_ok = db_ok && redis_ok && nats_ok;
    if !all_ok {
        tracing::warn!(db_ok, redis_ok, nats_ok, "readiness check failed");
    }

    let status = if all_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let body = json!({
        "status": if all_ok { "ready" } else { "not_ready" },
        "database": if db_ok { "up" } else { "down" },
        "redis": if redis_ok { "up" } else { "down" },
        "nats": if nats_ok { "up" } else { "down" },
    });

    (status, Json(body))
}
