//! Server-authoritative call state, backed by Redis (Phase 4 · Lot 5c).
//!
//! Phase 4's signaling is otherwise stateless: the server relays ring/end and
//! mints LiveKit tokens but never records who is in a call. That is fine for 1:1
//! but breaks group calls — the client cannot discover an in-progress call, show
//! an authoritative roster, or tell "one participant left" from "the whole call
//! ended". This module adds a per-conversation participant roster so those become
//! server truth instead of a client heuristic.
//!
//! Mirrors the presence model: a per-conversation sorted set scored by each
//! participant's expiry; a heartbeat refreshes the score, a crashed client simply
//! falls out of the window. The call's canonical `call_id` is a sibling string set
//! once (atomically, `SET NX`) by whoever joins first, so concurrent joiners share
//! one call identity; it is cleared when the last participant leaves.

use chrono::Utc;
use redis::AsyncCommands;
use uuid::Uuid;

use crate::error::ApiError;

/// How long a participant entry lives without a heartbeat. The client heartbeats
/// several times inside this window; the TTL is the backstop for a crashed client.
pub const CALL_TTL_SECS: i64 = 60;

fn participants_key(conversation_id: Uuid) -> String {
    format!("call:participants:{conversation_id}")
}
fn call_id_key(conversation_id: Uuid) -> String {
    format!("call:id:{conversation_id}")
}
fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// One roster member. The LiveKit identity is per-(user, device) so two devices of
/// one user don't evict each other; the roster stores that same identity, and the
/// participant list dedups back to distinct user ids.
fn member(user_id: Uuid, device: Option<&str>) -> String {
    match device.filter(|d| !d.is_empty()) {
        Some(d) => format!("{user_id}:{d}"),
        None => user_id.to_string(),
    }
}

/// Distinct user ids from raw roster members (`{user_id}` or `{user_id}:{device}`).
fn distinct_users(members: Vec<String>) -> Vec<Uuid> {
    let mut out: Vec<Uuid> = Vec::new();
    for m in members {
        let uid = m.split(':').next().unwrap_or(&m);
        if let Ok(id) = Uuid::parse_str(uid)
            && !out.contains(&id)
        {
            out.push(id);
        }
    }
    out
}

async fn conn(redis: &redis::Client) -> Result<redis::aio::MultiplexedConnection, ApiError> {
    redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("call store unavailable: {e}")))
}

fn map_err(e: redis::RedisError) -> ApiError {
    ApiError::ServiceUnavailable(format!("call store error: {e}"))
}

/// Prune expired members, then read the live distinct-user roster.
async fn live_users(
    c: &mut redis::aio::MultiplexedConnection,
    key: &str,
    now: i64,
) -> Result<Vec<Uuid>, ApiError> {
    let _: i64 = c.zrembyscore(key, 0, now).await.map_err(map_err)?;
    let members: Vec<String> = c.zrange(key, 0, -1).await.map_err(map_err)?;
    Ok(distinct_users(members))
}

/// Outcome of a join.
pub struct JoinOutcome {
    /// The conversation's canonical call id (created if this is the first joiner).
    pub call_id: Uuid,
    /// True when this join started the call (roster was empty before).
    pub is_new: bool,
    /// The distinct user ids now in the call (including the joiner).
    pub participants: Vec<Uuid>,
}

/// Add a participant to the conversation's call, creating the call (and its
/// canonical id) if none is live. Returns the shared call id, whether this join
/// started the call, and the current distinct-user roster.
pub async fn join(
    redis: &redis::Client,
    conversation_id: Uuid,
    user_id: Uuid,
    device: Option<&str>,
    ttl_secs: i64,
) -> Result<JoinOutcome, ApiError> {
    let pkey = participants_key(conversation_id);
    let ckey = call_id_key(conversation_id);
    let now = now_ms();
    let expiry = now + ttl_secs * 1000;
    let ttl_ms = ttl_secs * 1000;
    let mut c = conn(redis).await?;

    // Prune expired first so "was the roster empty" reflects live members only.
    let _: i64 = c.zrembyscore(&pkey, 0, now).await.map_err(map_err)?;
    let before: i64 = c.zcard(&pkey).await.map_err(map_err)?;

    // Claim the canonical call id atomically: the first joiner's SET NX wins; a
    // concurrent joiner falls through to the stored id. (An orphaned id from a
    // previous call can only exist if the roster was non-empty, so pruning to empty
    // above means we always mint a fresh id when starting a call.)
    let candidate = Uuid::now_v7().to_string();
    if before == 0 {
        let _: () = redis::cmd("DEL")
            .arg(&ckey)
            .query_async(&mut c)
            .await
            .map_err(map_err)?;
    }
    let set: Option<String> = redis::cmd("SET")
        .arg(&ckey)
        .arg(&candidate)
        .arg("NX")
        .arg("PX")
        .arg(ttl_ms)
        .query_async(&mut c)
        .await
        .map_err(map_err)?;
    let is_new = set.is_some();
    let call_id_str: String = if is_new {
        candidate
    } else {
        c.get(&ckey).await.map_err(map_err)?
    };
    let call_id = Uuid::parse_str(&call_id_str)
        .map_err(|_| ApiError::ServiceUnavailable("corrupt call id".to_string()))?;

    // Add / refresh this participant, and keep both keys alive.
    let _: i64 = c
        .zadd(&pkey, member(user_id, device), expiry)
        .await
        .map_err(map_err)?;
    let _: bool = c.pexpire(&pkey, ttl_ms).await.map_err(map_err)?;
    let _: bool = c.pexpire(&ckey, ttl_ms).await.map_err(map_err)?;

    let participants = live_users(&mut c, &pkey, now).await?;
    Ok(JoinOutcome {
        call_id,
        is_new: is_new && before == 0,
        participants,
    })
}

/// Outcome of a leave.
pub struct LeaveOutcome {
    /// The call the participant left (absent if there was no live call).
    pub call_id: Option<Uuid>,
    /// The distinct user ids still in the call after the leave.
    pub participants: Vec<Uuid>,
    /// True when that was the last participant — the whole call has ended.
    pub ended: bool,
}

/// Remove a participant. If they were the last, the call ends (state cleared).
pub async fn leave(
    redis: &redis::Client,
    conversation_id: Uuid,
    user_id: Uuid,
    device: Option<&str>,
) -> Result<LeaveOutcome, ApiError> {
    let pkey = participants_key(conversation_id);
    let ckey = call_id_key(conversation_id);
    let now = now_ms();
    let mut c = conn(redis).await?;

    let call_id_str: Option<String> = c.get(&ckey).await.map_err(map_err)?;
    let call_id = call_id_str.as_deref().and_then(|s| Uuid::parse_str(s).ok());

    let _: i64 = c
        .zrem(&pkey, member(user_id, device))
        .await
        .map_err(map_err)?;
    let participants = live_users(&mut c, &pkey, now).await?;

    let ended = participants.is_empty();
    if ended {
        let _: () = redis::cmd("DEL")
            .arg(&pkey)
            .arg(&ckey)
            .query_async(&mut c)
            .await
            .map_err(map_err)?;
    }
    Ok(LeaveOutcome {
        call_id,
        participants,
        ended,
    })
}

/// Refresh a participant's liveness (score) — a no-op if they aren't in the call
/// (`ZADD XX` only updates existing members), so a stale heartbeat can't resurrect
/// someone who left. Also extends both keys' TTL.
pub async fn heartbeat(
    redis: &redis::Client,
    conversation_id: Uuid,
    user_id: Uuid,
    device: Option<&str>,
    ttl_secs: i64,
) -> Result<(), ApiError> {
    let pkey = participants_key(conversation_id);
    let ckey = call_id_key(conversation_id);
    let now = now_ms();
    let expiry = now + ttl_secs * 1000;
    let ttl_ms = ttl_secs * 1000;
    let mut c = conn(redis).await?;

    // XX: only refresh if already a member; do not re-add a departed participant.
    let _: i64 = redis::cmd("ZADD")
        .arg(&pkey)
        .arg("XX")
        .arg(expiry)
        .arg(member(user_id, device))
        .query_async(&mut c)
        .await
        .map_err(map_err)?;
    let _: bool = c.pexpire(&pkey, ttl_ms).await.map_err(map_err)?;
    let _: bool = c.pexpire(&ckey, ttl_ms).await.map_err(map_err)?;
    Ok(())
}

/// The live call in a conversation, or `None` if no one is in a call.
pub struct CallState {
    pub call_id: Uuid,
    pub participants: Vec<Uuid>,
}

/// Read the conversation's current call (pruning expired participants first).
pub async fn state(
    redis: &redis::Client,
    conversation_id: Uuid,
) -> Result<Option<CallState>, ApiError> {
    let pkey = participants_key(conversation_id);
    let ckey = call_id_key(conversation_id);
    let now = now_ms();
    let mut c = conn(redis).await?;

    let participants = live_users(&mut c, &pkey, now).await?;
    if participants.is_empty() {
        return Ok(None);
    }
    let call_id_str: Option<String> = c.get(&ckey).await.map_err(map_err)?;
    match call_id_str.as_deref().and_then(|s| Uuid::parse_str(s).ok()) {
        Some(call_id) => Ok(Some(CallState {
            call_id,
            participants,
        })),
        None => Ok(None),
    }
}

// ── Call-XP timers ───────────────────────────────────────────────────────────

fn xp_start_key(conversation_id: Uuid, user_id: Uuid) -> String {
    format!("call:xpstart:{conversation_id}:{user_id}")
}

/// Stamp "in a call with company since now" for each user (NX: an existing
/// stamp is never moved). Called on every join once the roster has ≥2 people,
/// so the FIRST joiner's clock starts when the second arrives.
pub async fn stamp_xp_start(
    redis: &redis::Client,
    conversation_id: Uuid,
    user_ids: &[Uuid],
) -> Result<(), ApiError> {
    let mut c = conn(redis).await?;
    let now = now_ms();
    for user_id in user_ids {
        let _: Option<String> = redis::cmd("SET")
            .arg(xp_start_key(conversation_id, *user_id))
            .arg(now)
            .arg("NX")
            .arg("EX")
            .arg(24 * 3600)
            .query_async(&mut c)
            .await
            .map_err(map_err)?;
    }
    Ok(())
}

/// Consume the user's stamp, returning it (ms epoch) if one was set.
pub async fn take_xp_start(
    redis: &redis::Client,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<Option<i64>, ApiError> {
    let mut c = conn(redis).await?;
    let v: Option<i64> = redis::cmd("GETDEL")
        .arg(xp_start_key(conversation_id, user_id))
        .query_async(&mut c)
        .await
        .map_err(map_err)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_encodes_device_when_present() {
        let u = Uuid::nil();
        assert_eq!(member(u, None), u.to_string());
        assert_eq!(member(u, Some("")), u.to_string()); // empty device is treated as none
        assert_eq!(member(u, Some("dev1")), format!("{u}:dev1"));
    }

    #[test]
    fn distinct_users_dedups_across_devices_and_ignores_junk() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        // Two devices of `a` + one of `b` + a malformed entry → distinct {a, b}, in order.
        let got = distinct_users(vec![
            format!("{a}:d1"),
            format!("{a}:d2"),
            b.to_string(),
            "not-a-uuid:d9".to_string(),
        ]);
        assert_eq!(got, vec![a, b]);
    }
}
