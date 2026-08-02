//! Distributed rate limiting & failed-login lockout, backed by Redis.
//!
//! [`check`] is an atomic sliding-window log (a Lua script: prune, count, admit
//! or reject in one round-trip) so the limit is consistent across every replica.
//! The failed-login lockout is a per-account counter with a TTL: too many
//! failures within the window lock the account regardless of which node is hit.

use redis::AsyncCommands;
use uuid::Uuid;

use crate::error::ApiError;

/// Sliding-window-log admission control. `member` must be unique per call so
/// simultaneous requests get distinct entries.
const SLIDING_WINDOW_LUA: &str = r#"
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return 1
else
  return 0
end
"#;

async fn conn(redis: &redis::Client) -> Result<redis::aio::MultiplexedConnection, ApiError> {
    redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("rate limiter unavailable: {e}")))
}

fn map_err(e: redis::RedisError) -> ApiError {
    ApiError::ServiceUnavailable(format!("rate limiter error: {e}"))
}

/// Admits one request against a sliding window, or returns `429`.
///
/// `key` scopes the limit (e.g. `rl:login:ip:1.2.3.4`); `window_secs`/`max` are
/// the policy. Fails **open** on a Redis error — a limiter outage must not lock
/// everyone out of the service.
pub async fn check(
    redis: &redis::Client,
    key: &str,
    window_secs: u64,
    max: u64,
) -> Result<(), ApiError> {
    let mut c = match conn(redis).await {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(error = %err, "rate limiter unavailable; failing open");
            return Ok(());
        }
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let member = format!("{now_ms}:{}", Uuid::new_v4());
    let allowed: i64 = redis::Script::new(SLIDING_WINDOW_LUA)
        .key(key)
        .arg(now_ms)
        .arg((window_secs as i64) * 1000)
        .arg(max as i64)
        .arg(member)
        .invoke_async(&mut c)
        .await
        .map_err(map_err)?;

    if allowed == 1 {
        Ok(())
    } else {
        Err(ApiError::TooManyRequests(
            "too many requests; please try again later".to_string(),
        ))
    }
}

/// Redis key for a per-account failed-login counter.
fn login_fail_key(account: &str) -> String {
    format!("authfail:acct:{account}")
}

/// Returns whether an account is currently locked out by failed logins.
pub async fn is_account_locked(
    redis: &redis::Client,
    account: &str,
    threshold: i64,
) -> Result<bool, ApiError> {
    let mut c = conn(redis).await?;
    let count: Option<i64> = c.get(login_fail_key(account)).await.map_err(map_err)?;
    Ok(count.unwrap_or(0) >= threshold)
}

/// Records a failed login for an account, starting the window on the first miss.
pub async fn record_login_failure(
    redis: &redis::Client,
    account: &str,
    window_secs: u64,
) -> Result<(), ApiError> {
    let key = login_fail_key(account);
    let mut c = conn(redis).await?;
    let count: i64 = c.incr(&key, 1).await.map_err(map_err)?;
    if count == 1 {
        let _: bool = c.expire(&key, window_secs as i64).await.map_err(map_err)?;
    }
    Ok(())
}

/// Clears an account's failed-login counter (called on a successful login).
pub async fn clear_login_failures(redis: &redis::Client, account: &str) -> Result<(), ApiError> {
    let mut c = conn(redis).await?;
    let _: i64 = c.del(login_fail_key(account)).await.map_err(map_err)?;
    Ok(())
}
