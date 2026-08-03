//! Instance-administration queries (admin panel). Compile-checked by sqlx.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

/// One user as listed in the admin panel (joined with the profile for the
/// shown name).
#[derive(Debug)]
pub struct AdminUserRow {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
    pub is_active: bool,
    pub disabled_at: Option<DateTime<Utc>>,
    /// Échéance de la suspension (`None` avec `disabled_at` = sans terme).
    pub disabled_until: Option<DateTime<Utc>>,
    pub disabled_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Expérience cumulée, pour afficher et régler le niveau depuis le panel.
    pub xp: Option<i64>,
}

/// Instance-wide counters for the admin overview.
#[derive(Debug)]
pub struct InstanceStats {
    pub users_total: i64,
    pub users_active: i64,
    pub users_disabled: i64,
    pub admins: i64,
    pub conversations: i64,
    pub messages: i64,
    pub attachments: i64,
    pub attachment_bytes: i64,
    pub db_bytes: i64,
}

/// Gathers the overview counters in one round-trip.
pub async fn stats(pool: &PgPool) -> Result<InstanceStats, ApiError> {
    let row = sqlx::query!(
        r#"SELECT
            (SELECT count(*) FROM users)                               AS "users_total!",
            (SELECT count(*) FROM users WHERE is_active)               AS "users_active!",
            (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL) AS "users_disabled!",
            (SELECT count(*) FROM users WHERE role = 'admin')          AS "admins!",
            (SELECT count(*) FROM conversations)                       AS "conversations!",
            (SELECT count(*) FROM messages)                            AS "messages!",
            (SELECT count(*) FROM attachments)                         AS "attachments!",
            (SELECT coalesce(sum(size_bytes), 0) FROM attachments)::bigint AS "attachment_bytes!",
            pg_database_size(current_database())                       AS "db_bytes!""#
    )
    .fetch_one(pool)
    .await?;
    Ok(InstanceStats {
        users_total: row.users_total,
        users_active: row.users_active,
        users_disabled: row.users_disabled,
        admins: row.admins,
        conversations: row.conversations,
        messages: row.messages,
        attachments: row.attachments,
        attachment_bytes: row.attachment_bytes,
        db_bytes: row.db_bytes,
    })
}

/// Escapes LIKE wildcards so a search for a literal `%`/`_` behaves literally.
fn like_pattern(search: &str) -> String {
    let escaped = search
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Pages through users, newest first, optionally filtered by a case-insensitive
/// match on username, email or display name. Returns the page + total count.
pub async fn list_users(
    pool: &PgPool,
    search: Option<&str>,
    limit: i64,
    offset: i64,
    created_from: Option<DateTime<Utc>>,
    created_to: Option<DateTime<Utc>>,
    sort: &str,
) -> Result<(Vec<AdminUserRow>, i64), ApiError> {
    let pattern = search.map(like_pattern);
    let rows = sqlx::query_as!(
        AdminUserRow,
        r#"SELECT u.id, u.username, u.email, p.display_name AS "display_name?",
                  u.role, u.is_active, u.disabled_at, u.disabled_until,
                  u.disabled_reason, u.created_at, x.xp AS "xp?"
           FROM users u
           LEFT JOIN user_profiles p ON p.user_id = u.id
           LEFT JOIN user_xp x ON x.user_id = u.id
           WHERE ($1::text IS NULL
              OR u.username ILIKE $1
              OR u.email ILIKE $1
              OR p.display_name ILIKE $1)
             AND ($4::timestamptz IS NULL OR u.created_at >= $4)
             AND ($5::timestamptz IS NULL OR u.created_at <= $5)
           ORDER BY
             CASE WHEN $6 = 'name_asc'    THEN lower(u.username) END ASC,
             CASE WHEN $6 = 'name_desc'   THEN lower(u.username) END DESC,
             CASE WHEN $6 = 'oldest'      THEN u.created_at END ASC,
             CASE WHEN $6 = 'xp_desc'     THEN coalesce(x.xp, 0) END DESC,
             u.created_at DESC
           LIMIT $2 OFFSET $3"#,
        pattern.as_deref(),
        limit,
        offset,
        created_from,
        created_to,
        sort,
    )
    .fetch_all(pool)
    .await?;

    let total = sqlx::query_scalar!(
        r#"SELECT count(*) AS "count!"
           FROM users u
           LEFT JOIN user_profiles p ON p.user_id = u.id
           WHERE $1::text IS NULL
              OR u.username ILIKE $1
              OR u.email ILIKE $1
              OR p.display_name ILIKE $1"#,
        pattern.as_deref(),
    )
    .fetch_one(pool)
    .await?;

    Ok((rows, total))
}

/// One user in the admin projection (post-update responses).
pub async fn get_user(pool: &PgPool, id: Uuid) -> Result<Option<AdminUserRow>, ApiError> {
    sqlx::query_as!(
        AdminUserRow,
        r#"SELECT u.id, u.username, u.email, p.display_name AS "display_name?",
                  u.role, u.is_active, u.disabled_at, u.disabled_until,
                  u.disabled_reason, u.created_at, x.xp AS "xp?"
           FROM users u
           LEFT JOIN user_profiles p ON p.user_id = u.id
           LEFT JOIN user_xp x ON x.user_id = u.id
           WHERE u.id = $1"#,
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

// ── Custom roles ─────────────────────────────────────────────────────────────

/// A custom instance role.
#[derive(Debug, Clone)]
pub struct RoleRow {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub permissions: i64,
}

pub async fn list_roles(pool: &PgPool) -> Result<Vec<RoleRow>, ApiError> {
    Ok(sqlx::query_as!(
        RoleRow,
        r#"SELECT id, name, color, position, permissions
           FROM roles ORDER BY position, name"#
    )
    .fetch_all(pool)
    .await?)
}

pub async fn create_role(
    pool: &PgPool,
    name: &str,
    color: Option<&str>,
    position: i32,
    permissions: i64,
) -> Result<RoleRow, ApiError> {
    let id = Uuid::now_v7();
    sqlx::query!(
        "INSERT INTO roles (id, name, color, position, permissions) VALUES ($1, $2, $3, $4, $5)",
        id,
        name,
        color,
        position,
        permissions,
    )
    .execute(pool)
    .await?;
    Ok(RoleRow {
        id,
        name: name.to_string(),
        color: color.map(str::to_string),
        position,
        permissions,
    })
}

pub async fn update_role(
    pool: &PgPool,
    id: Uuid,
    name: &str,
    color: Option<&str>,
    position: i32,
    permissions: i64,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE roles SET name = $2, color = $3, position = $4, permissions = $5 WHERE id = $1",
        id,
        name,
        color,
        position,
        permissions,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_role(pool: &PgPool, id: Uuid) -> Result<(), ApiError> {
    sqlx::query!("DELETE FROM roles WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Replace a user's role set (transactional delete + insert).
pub async fn set_user_roles(
    pool: &PgPool,
    user_id: Uuid,
    role_ids: &[Uuid],
) -> Result<(), ApiError> {
    let mut tx = pool.begin().await?;
    sqlx::query!("DELETE FROM user_roles WHERE user_id = $1", user_id)
        .execute(&mut *tx)
        .await?;
    for role_id in role_ids {
        sqlx::query!(
            "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            user_id,
            role_id,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// role ids per user, for a page of users (one query, no N+1).
pub async fn roles_of_users(
    pool: &PgPool,
    user_ids: &[Uuid],
) -> Result<Vec<(Uuid, Uuid)>, ApiError> {
    Ok(sqlx::query!(
        r#"SELECT user_id, role_id FROM user_roles WHERE user_id = ANY($1)"#,
        user_ids,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|r| (r.user_id, r.role_id))
    .collect())
}

/// OR of every permission bit granted to a user through their roles.
pub async fn permissions_of(pool: &PgPool, user_id: Uuid) -> Result<i64, ApiError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT coalesce(bit_or(r.permissions), 0)::bigint AS "perms!"
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = $1"#,
        user_id,
    )
    .fetch_one(pool)
    .await?)
}

/// A user's custom roles (for the public profile), highest position first.
pub struct UserRoleRow {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
}

pub async fn roles_of_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<UserRoleRow>, ApiError> {
    Ok(sqlx::query_as!(
        UserRoleRow,
        r#"SELECT r.id, r.name, r.color
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = $1
           ORDER BY r.position DESC, r.name"#,
        user_id,
    )
    .fetch_all(pool)
    .await?)
}

// ── Audit log ────────────────────────────────────────────────────────────────

/// One audit entry, actor/target usernames resolved (target may be gone).
pub struct AuditRow {
    pub id: Uuid,
    pub actor_id: Uuid,
    pub actor_username: Option<String>,
    pub action: String,
    pub target_id: Option<Uuid>,
    pub target_username: Option<String>,
    pub detail: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

/// Best-effort by design at call sites: an audit failure must never abort the
/// action it documents — callers log and continue.
pub async fn record_audit(
    pool: &PgPool,
    actor_id: Uuid,
    action: &str,
    target_id: Option<Uuid>,
    detail: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO audit_log (id, actor_id, action, target_id, detail) VALUES ($1, $2, $3, $4, $5)",
        Uuid::new_v4(),
        actor_id,
        action,
        target_id,
        detail,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_audit(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<(Vec<AuditRow>, i64), ApiError> {
    let rows = sqlx::query_as!(
        AuditRow,
        r#"SELECT a.id, a.actor_id, ua.username AS "actor_username?",
                  a.action, a.target_id, ut.username AS "target_username?",
                  a.detail, a.created_at
           FROM audit_log a
           LEFT JOIN users ua ON ua.id = a.actor_id
           LEFT JOIN users ut ON ut.id = a.target_id
           ORDER BY a.created_at DESC
           LIMIT $1 OFFSET $2"#,
        limit,
        offset,
    )
    .fetch_all(pool)
    .await?;
    let total = sqlx::query_scalar!(r#"SELECT count(*) AS "n!" FROM audit_log"#)
        .fetch_one(pool)
        .await?;
    Ok((rows, total))
}

// ── MLS moderation tombstones ────────────────────────────────────────────────

pub async fn add_mls_tombstone(
    pool: &PgPool,
    conversation_id: Uuid,
    message_ref: &str,
    actor_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO mls_tombstones (conversation_id, message_ref, actor_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        conversation_id,
        message_ref,
        actor_id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_mls_tombstones(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Vec<String>, ApiError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT message_ref FROM mls_tombstones WHERE conversation_id = $1"#,
        conversation_id,
    )
    .fetch_all(pool)
    .await?)
}

// ── Panel v3 : sanctions, mots de passe, niveaux ─────────────────────────────

/// Suspend un compte. `until = None` = sans terme.
///
/// `disabled_at` est TOUJOURS réécrit : reposer une sanction sur un compte déjà
/// suspendu doit dater la nouvelle décision, sans quoi le journal raconterait
/// l'ancienne.
pub async fn suspend_user(
    pool: &PgPool,
    user_id: Uuid,
    until: Option<DateTime<Utc>>,
    reason: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE users SET disabled_at = now(), disabled_until = $2, disabled_reason = $3 \
         WHERE id = $1",
        user_id,
        until,
        reason,
    )
    .execute(pool)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("suspension : {e}")))?;
    Ok(())
}

/// Lève la suspension et efface ce qui l'accompagnait.
pub async fn reinstate_user(pool: &PgPool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE users SET disabled_at = NULL, disabled_until = NULL, disabled_reason = NULL \
         WHERE id = $1",
        user_id,
    )
    .execute(pool)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("levée de suspension : {e}")))?;
    Ok(())
}

/// Remplace le mot de passe (empreinte déjà calculée par l'appelant).
pub async fn set_password_hash(pool: &PgPool, user_id: Uuid, hash: &str) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
        user_id,
        hash,
    )
    .execute(pool)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("mise à jour du mot de passe : {e}")))?;
    Ok(())
}

/// Fixe l'expérience d'un compte (0 = remise à zéro).
///
/// Les compteurs de la journée et de la semaine sont remis à zéro eux aussi :
/// les laisser garderait les plafonds anti-abus déjà atteints, et un compte
/// « remis à zéro » ne pourrait plus rien gagner avant le lendemain.
pub async fn set_xp(pool: &PgPool, user_id: Uuid, xp: i64) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO user_xp (user_id, xp, week_xp, day_xp, updated_at) \
         VALUES ($1, $2, 0, 0, now()) \
         ON CONFLICT (user_id) DO UPDATE \
           SET xp = EXCLUDED.xp, week_xp = 0, day_xp = 0, updated_at = now()",
        user_id,
        xp,
    )
    .execute(pool)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("mise à jour de l'expérience : {e}")))?;
    Ok(())
}

/// Suspend ou rétablit un rôle.
///
/// Un rôle suspendu garde ses membres et ses permissions mais n'accorde plus
/// rien. Le supprimer perdrait la liste de ses titulaires, qu'il faudrait
/// reconstituer à la main pour revenir en arrière.
pub async fn set_role_suspended(
    pool: &PgPool,
    role_id: Uuid,
    suspended: bool,
) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE roles SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1",
        role_id,
        suspended,
    )
    .execute(pool)
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("suspension du rôle : {e}")))?;
    Ok(())
}
