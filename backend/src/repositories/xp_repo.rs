//! Instance XP — atomic grants with cooldown + daily cap in one statement,
//! and the leaderboard reads. Award failures are ALWAYS best-effort at call
//! sites: leveling must never break messaging or calls.

use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::xp;
use crate::error::ApiError;

/// Grant message XP if the 60s cooldown has elapsed and the daily cap allows.
/// Returns the new total when granted, None when skipped.
pub async fn award_message_xp(pool: &PgPool, user_id: Uuid) -> Result<Option<i64>, ApiError> {
    let granted = sqlx::query_scalar!(
        r#"INSERT INTO user_xp AS ux (user_id, xp, week_xp, day_xp, last_msg_xp_at)
           VALUES ($1, $2, $2, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET
             xp = ux.xp + $2,
             week_xp = CASE WHEN ux.week_start = date_trunc('week', now())::date
                            THEN ux.week_xp + $2 ELSE $2 END,
             week_start = date_trunc('week', now())::date,
             day_xp = CASE WHEN ux.day = current_date THEN ux.day_xp + $2 ELSE $2 END,
             day = current_date,
             last_msg_xp_at = now(),
             updated_at = now()
           WHERE (ux.last_msg_xp_at IS NULL
                  OR ux.last_msg_xp_at <= now() - make_interval(secs => $3::double precision))
             AND (CASE WHEN ux.day = current_date THEN ux.day_xp ELSE 0 END) + $2 <= $4
           RETURNING xp"#,
        user_id,
        xp::MSG_XP,
        xp::MSG_COOLDOWN_SECS as f64,
        xp::DAY_CAP,
    )
    .fetch_optional(pool)
    .await?;
    Ok(granted)
}

/// Grant call XP (already computed from minutes). Clamped by the daily cap:
/// a grant that would overflow the cap is trimmed to the remaining headroom.
pub async fn award_call_xp(pool: &PgPool, user_id: Uuid, amount: i64) -> Result<(), ApiError> {
    let amount = amount.clamp(0, xp::CALL_GRANT_MAX);
    if amount == 0 {
        return Ok(());
    }
    sqlx::query!(
        r#"INSERT INTO user_xp AS ux (user_id, xp, week_xp, day_xp)
           VALUES ($1, LEAST($2::bigint, $3::bigint), LEAST($2::bigint, $3::bigint), LEAST($2::bigint, $3::bigint))
           ON CONFLICT (user_id) DO UPDATE SET
             xp = ux.xp + LEAST($2, GREATEST(0, $3 - CASE WHEN ux.day = current_date THEN ux.day_xp ELSE 0 END)),
             week_xp = CASE WHEN ux.week_start = date_trunc('week', now())::date
                            THEN ux.week_xp ELSE 0 END
                       + LEAST($2, GREATEST(0, $3 - CASE WHEN ux.day = current_date THEN ux.day_xp ELSE 0 END)),
             week_start = date_trunc('week', now())::date,
             day_xp = CASE WHEN ux.day = current_date THEN ux.day_xp ELSE 0 END
                      + LEAST($2, GREATEST(0, $3 - CASE WHEN ux.day = current_date THEN ux.day_xp ELSE 0 END)),
             day = current_date,
             updated_at = now()"#,
        user_id,
        amount,
        xp::DAY_CAP,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Total XP of one user (0 when they never earned any).
pub async fn xp_of(pool: &PgPool, user_id: Uuid) -> Result<i64, ApiError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT xp FROM user_xp WHERE user_id = $1"#,
        user_id,
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or(0))
}

/// One leaderboard row (profile name resolved; avatar version for the URL).
pub struct LeaderboardRow {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_version: i32,
    pub xp: i64,
}

/// Top users by all-time XP.
pub async fn leaderboard_all(pool: &PgPool, limit: i64) -> Result<Vec<LeaderboardRow>, ApiError> {
    Ok(sqlx::query_as!(
        LeaderboardRow,
        r#"SELECT ux.user_id, u.username, p.display_name,
                  coalesce(p.avatar_version, 0) AS "avatar_version!",
                  ux.xp AS "xp!"
           FROM user_xp ux
           JOIN users u ON u.id = ux.user_id
           LEFT JOIN user_profiles p ON p.user_id = ux.user_id
           WHERE u.disabled_at IS NULL AND ux.xp > 0
           ORDER BY ux.xp DESC, u.username
           LIMIT $1"#,
        limit,
    )
    .fetch_all(pool)
    .await?)
}

/// Top users by XP earned in the CURRENT week (stale week rows count as zero
/// and are simply filtered out).
pub async fn leaderboard_week(pool: &PgPool, limit: i64) -> Result<Vec<LeaderboardRow>, ApiError> {
    Ok(sqlx::query_as!(
        LeaderboardRow,
        r#"SELECT ux.user_id, u.username, p.display_name,
                  coalesce(p.avatar_version, 0) AS "avatar_version!",
                  ux.week_xp AS "xp!"
           FROM user_xp ux
           JOIN users u ON u.id = ux.user_id
           LEFT JOIN user_profiles p ON p.user_id = ux.user_id
           WHERE u.disabled_at IS NULL
             AND ux.week_start = date_trunc('week', now())::date
             AND ux.week_xp > 0
           ORDER BY ux.week_xp DESC, u.username
           LIMIT $1"#,
        limit,
    )
    .fetch_all(pool)
    .await?)
}
