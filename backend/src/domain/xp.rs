//! Instance leveling — XP amounts, anti-abuse caps and the level curve.
//!
//! The curve mirrors the classic community-bot shape: the cost of level n→n+1
//! is `5n² + 50n + 100`, so early levels come fast and the tail stretches.
//! The FRONTEND holds a mirror of `level_for_xp` (lib/levels.ts) — keep both
//! in sync if the curve ever changes.

/// XP for one counted message (at most one per [`MSG_COOLDOWN_SECS`]).
pub const MSG_XP: i64 = 15;
/// Minimum seconds between two message XP grants.
pub const MSG_COOLDOWN_SECS: i64 = 60;
/// XP per full minute spent in a call with at least one other person.
pub const CALL_XP_PER_MIN: i64 = 5;
/// Hard ceiling on XP earned per user per day (all sources).
pub const DAY_CAP: i64 = 1500;
/// Upper bound on a single call-XP grant (8h of call, defensive).
pub const CALL_GRANT_MAX: i64 = 8 * 60 * CALL_XP_PER_MIN;

/// Cost of going from `level` to `level + 1`.
fn level_cost(level: i64) -> i64 {
    5 * level * level + 50 * level + 100
}

/// The level reached with `xp` total experience (level 0 at 0 XP).
pub fn level_for_xp(xp: i64) -> i64 {
    let mut level = 0;
    let mut remaining = xp;
    loop {
        let cost = level_cost(level);
        if remaining < cost || level >= 500 {
            return level;
        }
        remaining -= cost;
        level += 1;
    }
}

/// Total XP required to REACH `level`.
pub fn xp_for_level(level: i64) -> i64 {
    (0..level).map(level_cost).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_is_monotonic_and_consistent() {
        assert_eq!(level_for_xp(0), 0);
        assert_eq!(level_for_xp(99), 0);
        assert_eq!(level_for_xp(100), 1); // first level costs 100
        for level in 0..60 {
            let floor = xp_for_level(level);
            assert_eq!(level_for_xp(floor), level, "floor of level {level}");
            if level > 0 {
                assert_eq!(level_for_xp(floor - 1), level - 1);
            }
        }
    }

    #[test]
    fn early_levels_are_reachable() {
        // ~7 counted messages for level 1; level 5 within a lively day.
        assert!(xp_for_level(1) <= 7 * MSG_XP);
        assert!(xp_for_level(5) <= DAY_CAP);
    }
}
