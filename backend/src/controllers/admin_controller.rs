//! Instance administration — overview stats + user management.
//!
//! Every handler requires [`AdminUser`], which re-checks the role in the
//! database on each request: demotion or suspension of an admin applies
//! instantly instead of riding out a cached token claim.

use axum::Json;
use serde_json::{Value, json};
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::{permissions, validation};
use crate::error::ApiError;
use crate::middleware::auth::{self, AuthUser, PanelUser};
use crate::realtime::presence;
use crate::repositories::{admin_repo, profile_repo, session_repo, user_repo};
use crate::state::AppState;

/// Best-effort audit write: a journal hiccup never aborts the action it records.
async fn audit(state: &AppState, actor: Uuid, action: &str, target: Option<Uuid>, detail: Value) {
    if let Err(e) = admin_repo::record_audit(&state.db, actor, action, target, detail).await {
        tracing::warn!(error = %e, %action, "audit write failed");
    }
}

/// A custom role as exposed to the panel.
#[derive(Debug, Serialize)]
pub struct RoleDto {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
    pub position: i32,
    pub permissions: i64,
}

impl From<admin_repo::RoleRow> for RoleDto {
    fn from(r: admin_repo::RoleRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            color: r.color,
            position: r.position,
            permissions: r.permissions,
        }
    }
}

/// A user as shown in the admin panel.
#[derive(Debug, Serialize)]
pub struct AdminUserDto {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String,
    pub email_verified: bool,
    pub disabled: bool,
    pub created_at: DateTime<Utc>,
    /// Custom role ids assigned to this user (details come from /admin/roles).
    #[serde(default)]
    pub role_ids: Vec<Uuid>,
}

impl From<admin_repo::AdminUserRow> for AdminUserDto {
    fn from(row: admin_repo::AdminUserRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            email: row.email,
            display_name: row.display_name,
            role: row.role,
            email_verified: row.is_active,
            disabled: row.disabled_at.is_some(),
            created_at: row.created_at,
            role_ids: Vec::new(),
        }
    }
}

/// Overview counters for the admin dashboard.
#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub users_total: i64,
    pub users_active: i64,
    pub users_disabled: i64,
    pub admins: i64,
    /// Approximate: live presence device-sets in Redis.
    pub users_online: i64,
    pub conversations: i64,
    pub messages: i64,
    pub attachments: i64,
    pub attachment_bytes: i64,
    pub db_bytes: i64,
    pub version: &'static str,
}

/// `GET /admin/stats` — instance overview counters.
pub async fn stats(
    State(state): State<AppState>,
    panel: PanelUser,
) -> Result<Json<StatsResponse>, ApiError> {
    panel.require(permissions::ADMIN_PANEL, "voir le panel")?;
    let s = admin_repo::stats(&state.db).await?;
    // Best-effort: a Redis hiccup must not take down the whole overview.
    let users_online = presence::online_count(&state.redis).await.unwrap_or(0);
    Ok(Json(StatsResponse {
        users_total: s.users_total,
        users_active: s.users_active,
        users_disabled: s.users_disabled,
        admins: s.admins,
        users_online,
        conversations: s.conversations,
        messages: s.messages,
        attachments: s.attachments,
        attachment_bytes: s.attachment_bytes,
        db_bytes: s.db_bytes,
        version: env!("CARGO_PKG_VERSION"),
    }))
}

/// Query for `GET /admin/users`.
#[derive(Debug, Deserialize)]
pub struct UsersQuery {
    /// Case-insensitive filter on username / email / display name.
    #[serde(default)]
    pub q: Option<String>,
    /// 1-based page index.
    #[serde(default = "default_page")]
    pub page: i64,
    #[serde(default = "default_per_page")]
    pub per_page: i64,
}

fn default_page() -> i64 {
    1
}
fn default_per_page() -> i64 {
    25
}

/// One page of users.
#[derive(Debug, Serialize)]
pub struct UserListResponse {
    pub items: Vec<AdminUserDto>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

/// `GET /admin/users` — paged, searchable user list.
pub async fn list_users(
    State(state): State<AppState>,
    panel: PanelUser,
    Query(query): Query<UsersQuery>,
) -> Result<Json<UserListResponse>, ApiError> {
    panel.require(permissions::ADMIN_PANEL, "voir le panel")?;
    let per_page = query.per_page.clamp(1, 100);
    let page = query.page.max(1);
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (rows, total) =
        admin_repo::list_users(&state.db, search, per_page, (page - 1) * per_page).await?;
    let mut items: Vec<AdminUserDto> = rows.into_iter().map(Into::into).collect();
    // One query attaches every custom-role assignment of the page (no N+1).
    let ids: Vec<Uuid> = items.iter().map(|u| u.id).collect();
    for (user_id, role_id) in admin_repo::roles_of_users(&state.db, &ids).await? {
        if let Some(u) = items.iter_mut().find(|u| u.id == user_id) {
            u.role_ids.push(role_id);
        }
    }
    Ok(Json(UserListResponse {
        items,
        total,
        page,
        per_page,
    }))
}

// ── Custom roles ─────────────────────────────────────────────────────────────

/// Body for role creation/update.
#[derive(Debug, Deserialize)]
pub struct RoleBody {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub position: i32,
    pub permissions: i64,
}

fn validate_role_body(body: &RoleBody) -> Result<(String, i64), ApiError> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 50 {
        return Err(ApiError::Validation("invalid role name".to_string()));
    }
    if let Some(c) = body.color.as_deref()
        && !c.is_empty()
        && !(c.starts_with('#') && (c.len() == 7 || c.len() == 4))
    {
        return Err(ApiError::Validation("color must be #rgb or #rrggbb".to_string()));
    }
    // Unknown bits are dropped rather than rejected: an older client editing a
    // role must not wipe permissions a newer server added — but it can't set
    // bits it doesn't know either.
    Ok((name, body.permissions & permissions::ALL))
}

/// `GET /admin/roles` — every custom role, ordered.
pub async fn list_roles(
    State(state): State<AppState>,
    panel: PanelUser,
) -> Result<Json<Value>, ApiError> {
    panel.require(permissions::ADMIN_PANEL, "voir le panel")?;
    let roles: Vec<RoleDto> = admin_repo::list_roles(&state.db)
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(json!({ "roles": roles })))
}

/// `POST /admin/roles` — create a role.
pub async fn create_role(
    State(state): State<AppState>,
    panel: PanelUser,
    Json(body): Json<RoleBody>,
) -> Result<Json<RoleDto>, ApiError> {
    panel.require(permissions::MANAGE_ROLES, "gérer les rôles")?;
    let (name, perms) = validate_role_body(&body)?;
    let row = admin_repo::create_role(
        &state.db,
        &name,
        body.color.as_deref().filter(|c| !c.is_empty()),
        body.position,
        perms,
    )
    .await?;
    audit(&state, panel.user_id, "role.create", None, json!({ "name": name })).await;
    tracing::info!(admin = %panel.user_id, role = %row.id, %name, "role created");
    Ok(Json(row.into()))
}

/// `PATCH /admin/roles/{id}` — update a role.
pub async fn update_role(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(role_id): Path<Uuid>,
    Json(body): Json<RoleBody>,
) -> Result<Json<Value>, ApiError> {
    panel.require(permissions::MANAGE_ROLES, "gérer les rôles")?;
    let (name, perms) = validate_role_body(&body)?;
    admin_repo::update_role(
        &state.db,
        role_id,
        &name,
        body.color.as_deref().filter(|c| !c.is_empty()),
        body.position,
        perms,
    )
    .await?;
    audit(&state, panel.user_id, "role.update", None, json!({ "name": name })).await;
    Ok(Json(json!({ "status": "updated" })))
}

/// `DELETE /admin/roles/{id}` — delete a role (assignments cascade).
pub async fn delete_role(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(role_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    panel.require(permissions::MANAGE_ROLES, "gérer les rôles")?;
    admin_repo::delete_role(&state.db, role_id).await?;
    audit(&state, panel.user_id, "role.delete", None, json!({ "role_id": role_id })).await;
    tracing::info!(admin = %panel.user_id, role = %role_id, "role deleted");
    Ok(Json(json!({ "status": "deleted" })))
}

/// Body for `PUT /admin/users/{id}/roles`.
#[derive(Debug, Deserialize)]
pub struct SetUserRolesBody {
    pub role_ids: Vec<Uuid>,
}

/// `PUT /admin/users/{id}/roles` — replace a user's custom-role set.
pub async fn set_user_roles(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<SetUserRolesBody>,
) -> Result<Json<Value>, ApiError> {
    panel.require(permissions::MANAGE_ROLES, "gérer les rôles")?;
    if admin_repo::get_user(&state.db, user_id).await?.is_none() {
        return Err(ApiError::NotFound("user not found".to_string()));
    }
    admin_repo::set_user_roles(&state.db, user_id, &body.role_ids).await?;
    audit(
        &state,
        panel.user_id,
        "user.roles",
        Some(user_id),
        json!({ "count": body.role_ids.len() }),
    )
    .await;
    tracing::info!(admin = %panel.user_id, target_user = %user_id, count = body.role_ids.len(), "user roles set");
    Ok(Json(json!({ "status": "updated" })))
}

/// Body for `PATCH /admin/users/{id}` — every field optional, applied if set.
#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    /// `member` | `admin`.
    pub role: Option<String>,
    /// `true` suspends (and revokes every live session), `false` reinstates.
    pub disabled: Option<bool>,
    /// New display name; empty string clears it. Requires EDIT_PROFILES.
    pub display_name: Option<String>,
    /// New @username (unique). Requires EDIT_PROFILES.
    pub username: Option<String>,
}

/// `PATCH /admin/users/{id}` — change a user's role and/or suspension state.
///
/// Self-modification is rejected: an admin can neither demote nor suspend
/// themself, which also guarantees the instance can never lose its last
/// administrator through this endpoint.
pub async fn update_user(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
    Json(req): Json<UpdateUserRequest>,
) -> Result<Json<AdminUserDto>, ApiError> {
    let admin = &panel;
    if user_id == admin.user_id {
        return Err(ApiError::Forbidden(
            "you cannot change your own role or suspend your own account".to_string(),
        ));
    }
    if let Some(role) = req.role.as_deref()
        && role != "member"
        && role != "admin"
    {
        return Err(ApiError::Validation(
            "role must be 'member' or 'admin'".to_string(),
        ));
    }
    let Some(target) = admin_repo::get_user(&state.db, user_id).await? else {
        return Err(ApiError::NotFound("user not found".to_string()));
    };
    // A moderator must not be able to touch an administrator's account.
    if target.role == "admin" && !panel.is_admin {
        return Err(ApiError::Forbidden(
            "seul un administrateur peut modifier un administrateur".to_string(),
        ));
    }

    if let Some(role) = req.role.as_deref() {
        // Granting or revoking ADMIN is reserved to full admins — a
        // MANAGE_USERS role must not be able to escalate to root.
        if !panel.is_admin {
            return Err(ApiError::Forbidden(
                "seul un administrateur peut changer le rôle admin".to_string(),
            ));
        }
        user_repo::set_role(&state.db, user_id, role).await?;
        audit(&state, admin.user_id, "user.role", Some(user_id), json!({ "role": role })).await;
        tracing::info!(target_user = %user_id, admin = %admin.user_id, %role, "admin changed user role");
    }
    if req.disabled.is_some() {
        panel.require(permissions::MANAGE_USERS, "gérer les utilisateurs")?;
    }
    if let Some(disabled) = req.disabled {
        user_repo::set_disabled(&state.db, user_id, disabled).await?;
        if disabled {
            // Suspension is immediate: revoke every live session; still-cached
            // access tokens die on the Redis revocation flag within their TTL.
            let revoked = session_repo::revoke_all_for_user(&state.db, user_id).await?;
            for session_id in revoked {
                auth::mark_session_revoked(&state, session_id).await;
            }
        }
        audit(
            &state,
            admin.user_id,
            if disabled { "user.suspend" } else { "user.reinstate" },
            Some(user_id),
            json!({}),
        )
        .await;
        tracing::info!(target_user = %user_id, admin = %admin.user_id, %disabled, "admin changed user suspension");
    }
    if req.display_name.is_some() || req.username.is_some() {
        panel.require(permissions::EDIT_PROFILES, "modifier les profils")?;
    }
    if let Some(raw) = req.display_name.as_deref() {
        let display_name = validation::validate_display_name(raw);
        profile_repo::set_display_name(&state.db, user_id, display_name.as_deref()).await?;
        audit(
            &state,
            admin.user_id,
            "user.rename",
            Some(user_id),
            json!({ "display_name": display_name }),
        )
        .await;
    }
    if let Some(raw) = req.username.as_deref() {
        let username = validation::validate_username(raw)?;
        user_repo::set_username(&state.db, user_id, &username).await?;
        audit(
            &state,
            admin.user_id,
            "user.rename",
            Some(user_id),
            json!({ "username": username }),
        )
        .await;
    }

    let row = admin_repo::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;
    Ok(Json(row.into()))
}

// ── Audit log & caller capabilities ─────────────────────────────────────────

/// One audit entry as exposed to the panel.
#[derive(Debug, Serialize)]
pub struct AuditDto {
    pub id: Uuid,
    pub actor_id: Uuid,
    pub actor_username: Option<String>,
    pub action: String,
    pub target_id: Option<Uuid>,
    pub target_username: Option<String>,
    pub detail: Value,
    pub created_at: DateTime<Utc>,
}

/// `GET /admin/audit` — paged administration journal (VIEW_AUDIT).
pub async fn audit_log(
    State(state): State<AppState>,
    panel: PanelUser,
    Query(query): Query<UsersQuery>,
) -> Result<Json<Value>, ApiError> {
    panel.require(permissions::VIEW_AUDIT, "consulter le journal")?;
    let per_page = query.per_page.clamp(1, 100);
    let page = query.page.max(1);
    let (rows, total) =
        admin_repo::list_audit(&state.db, per_page, (page - 1) * per_page).await?;
    let items: Vec<AuditDto> = rows
        .into_iter()
        .map(|r| AuditDto {
            id: r.id,
            actor_id: r.actor_id,
            actor_username: r.actor_username,
            action: r.action,
            target_id: r.target_id,
            target_username: r.target_username,
            detail: r.detail,
            created_at: r.created_at,
        })
        .collect();
    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

/// `GET /admin/me` — the caller's effective instance capabilities. Never 403s:
/// a plain member simply gets zero bits. Lets the client decide which
/// moderation affordances (delete any message…) to show.
pub async fn my_permissions(
    State(state): State<AppState>,
    caller: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let (is_admin, perms) = auth::instance_permissions(&state, caller.user_id).await?;
    Ok(Json(json!({ "is_admin": is_admin, "permissions": perms })))
}
