//! Presence state, backed by Redis.
//!
//! A user is ONLINE while at least one device (WebSocket connection) is live. Each
//! device is a member of a per-user sorted set scored by its expiry; a client
//! heartbeat refreshes the score, and a missed heartbeat lets it fall out of the
//! window. Transitions (offline↔online) are reported so the caller can broadcast
//! them; the TTL on the key is the backstop for a crashed *node* (stale devices
//! then simply expire and the next read shows OFFLINE).

use chrono::Utc;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ApiError;

/// A user's presence status. `OFFLINE` is derived (no live devices), never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PresenceStatus {
    Online,
    Away,
    Dnd,
    Offline,
}

impl PresenceStatus {
    /// The manual statuses a client may set (OFFLINE is not settable).
    fn as_stored(self) -> Option<&'static str> {
        match self {
            PresenceStatus::Online => Some("ONLINE"),
            PresenceStatus::Away => Some("AWAY"),
            PresenceStatus::Dnd => Some("DND"),
            PresenceStatus::Offline => None,
        }
    }

    fn parse(s: &str) -> PresenceStatus {
        match s {
            "AWAY" => PresenceStatus::Away,
            "DND" => PresenceStatus::Dnd,
            _ => PresenceStatus::Online,
        }
    }
}

fn devices_key(user_id: Uuid) -> String {
    format!("presence:dev:{user_id}")
}
fn status_key(user_id: Uuid) -> String {
    format!("presence:status:{user_id}")
}
fn status_text_key(user_id: Uuid) -> String {
    format!("presence:text:{user_id}")
}
fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

async fn conn(redis: &redis::Client) -> Result<redis::aio::MultiplexedConnection, ApiError> {
    redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("presence store unavailable: {e}")))
}

fn map_err(e: redis::RedisError) -> ApiError {
    ApiError::ServiceUnavailable(format!("presence store error: {e}"))
}

/// Registers a device as live. Returns `true` if this brought the user online
/// (their first live device).
pub async fn device_online(
    redis: &redis::Client,
    user_id: Uuid,
    conn_id: Uuid,
    ttl_secs: u64,
) -> Result<bool, ApiError> {
    let key = devices_key(user_id);
    let now = now_ms();
    let expiry = now + (ttl_secs as i64) * 1000;
    let mut c = conn(redis).await?;
    let _: i64 = c.zrembyscore(&key, 0, now).await.map_err(map_err)?;
    let before: i64 = c.zcard(&key).await.map_err(map_err)?;
    let _: i64 = c
        .zadd(&key, conn_id.to_string(), expiry)
        .await
        .map_err(map_err)?;
    let _: bool = c
        .pexpire(&key, (ttl_secs as i64) * 1000)
        .await
        .map_err(map_err)?;
    Ok(before == 0)
}

/// Refreshes a device's liveness (called on each client heartbeat).
pub async fn heartbeat(
    redis: &redis::Client,
    user_id: Uuid,
    conn_id: Uuid,
    ttl_secs: u64,
) -> Result<(), ApiError> {
    let key = devices_key(user_id);
    let expiry = now_ms() + (ttl_secs as i64) * 1000;
    let mut c = conn(redis).await?;
    let _: i64 = c
        .zadd(&key, conn_id.to_string(), expiry)
        .await
        .map_err(map_err)?;
    let _: bool = c
        .pexpire(&key, (ttl_secs as i64) * 1000)
        .await
        .map_err(map_err)?;
    // Keep the manual status + custom status text alive alongside the devices.
    // (Both must be refreshed here or they silently expire mid-session.)
    let _: bool = c
        .pexpire(status_key(user_id), (ttl_secs as i64) * 1000)
        .await
        .map_err(map_err)?;
    let _: bool = c
        .pexpire(status_text_key(user_id), (ttl_secs as i64) * 1000)
        .await
        .map_err(map_err)?;
    Ok(())
}

/// Removes a device. Returns `true` if the user is now offline (no live devices).
pub async fn device_offline(
    redis: &redis::Client,
    user_id: Uuid,
    conn_id: Uuid,
) -> Result<bool, ApiError> {
    let key = devices_key(user_id);
    let now = now_ms();
    let mut c = conn(redis).await?;
    let _: i64 = c.zrem(&key, conn_id.to_string()).await.map_err(map_err)?;
    let _: i64 = c.zrembyscore(&key, 0, now).await.map_err(map_err)?;
    let remaining: i64 = c.zcard(&key).await.map_err(map_err)?;
    Ok(remaining == 0)
}

/// Sets a user's manual status (ONLINE/AWAY/DND). No-op for OFFLINE.
pub async fn set_status(
    redis: &redis::Client,
    user_id: Uuid,
    status: PresenceStatus,
    ttl_secs: u64,
) -> Result<(), ApiError> {
    let Some(stored) = status.as_stored() else {
        return Ok(());
    };
    let mut c = conn(redis).await?;
    let _: () = c
        .set_ex(status_key(user_id), stored, ttl_secs)
        .await
        .map_err(map_err)?;
    Ok(())
}

/// Sets (or clears) a user's custom free-text status. `Some(text)` stores it with
/// the device TTL; `None` clears it. Independent of the manual status, so an
/// Invisible user can still carry text, and a status change doesn't touch it.
pub async fn set_status_text(
    redis: &redis::Client,
    user_id: Uuid,
    text: Option<&str>,
    ttl_secs: u64,
) -> Result<(), ApiError> {
    let mut c = conn(redis).await?;
    match text {
        Some(t) => {
            let _: () = c
                .set_ex(status_text_key(user_id), t, ttl_secs)
                .await
                .map_err(map_err)?;
        }
        None => {
            let _: i64 = c.del(status_text_key(user_id)).await.map_err(map_err)?;
        }
    }
    Ok(())
}

/// A user's effective presence: their status plus an optional custom text.
#[derive(Debug, Clone, Serialize)]
pub struct EffectivePresence {
    pub status: PresenceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
}

/// Computes a user's effective presence: OFFLINE (and no text) if no live devices,
/// else their manual status (defaulting to ONLINE) + any custom status text.
pub async fn effective_status(
    redis: &redis::Client,
    user_id: Uuid,
) -> Result<EffectivePresence, ApiError> {
    let mut c = conn(redis).await?;
    let now = now_ms();
    let _: i64 = c
        .zrembyscore(devices_key(user_id), 0, now)
        .await
        .map_err(map_err)?;
    let live: i64 = c.zcard(devices_key(user_id)).await.map_err(map_err)?;
    if live == 0 {
        return Ok(EffectivePresence {
            status: PresenceStatus::Offline,
            status_text: None,
        });
    }
    let stored: Option<String> = c.get(status_key(user_id)).await.map_err(map_err)?;
    let status_text: Option<String> = c.get(status_text_key(user_id)).await.map_err(map_err)?;
    Ok(EffectivePresence {
        status: stored
            .map(|s| PresenceStatus::parse(&s))
            .unwrap_or(PresenceStatus::Online),
        status_text,
    })
}

/// Approximate count of users currently online: the number of live per-user
/// device sets in Redis. Stale sets fall out via their key TTL, so the count
/// can briefly overshoot right after an unclean disconnect.
pub async fn online_count(redis: &redis::Client) -> Result<i64, ApiError> {
    let mut c = conn(redis).await?;
    let mut cursor: u64 = 0;
    let mut total: i64 = 0;
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("presence:dev:*")
            .arg("COUNT")
            .arg(500)
            .query_async(&mut c)
            .await
            .map_err(map_err)?;
        total += keys.len() as i64;
        if next == 0 {
            break;
        }
        cursor = next;
    }
    Ok(total)
}

/// Returns the effective presence of each requested user.
pub async fn snapshot(
    redis: &redis::Client,
    user_ids: &[Uuid],
) -> Result<Vec<(Uuid, EffectivePresence)>, ApiError> {
    let mut out = Vec::with_capacity(user_ids.len());
    for &id in user_ids {
        out.push((id, effective_status(redis, id).await?));
    }
    Ok(out)
}
