//! Instance administration — overview stats + user management.
//!
//! Every handler requires [`AdminUser`], which re-checks the role in the
//! database on each request: demotion or suspension of an admin applies
//! instantly instead of riding out a cached token claim.

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
    /// Échéance de la suspension (absente = sans terme).
    pub disabled_until: Option<DateTime<Utc>>,
    pub disabled_reason: Option<String>,
    /// Expérience cumulée, pour afficher et régler le niveau.
    pub xp: i64,
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
            // « Suspendu » au sens de MAINTENANT : une sanction à terme échu ne
            // bloque plus rien, l'afficher comme active induirait en erreur.
            disabled: row.disabled_at.is_some()
                && row.disabled_until.is_none_or(|until| until > Utc::now()),
            disabled_until: row.disabled_until,
            disabled_reason: row.disabled_reason,
            xp: row.xp.unwrap_or(0),
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
    /// `recent` (défaut), `oldest`, `name_asc`, `name_desc`, `xp_desc`.
    #[serde(default)]
    pub sort: Option<String>,
    /// Bornes d'inscription, incluses.
    #[serde(default)]
    pub from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub to: Option<DateTime<Utc>>,
}

/// Tris acceptés. Une valeur inconnue retombe sur le plus récent plutôt que de
/// rejeter la requête : un tri inattendu ne vaut pas une page d'erreur.
fn sort_key(raw: Option<&str>) -> &'static str {
    match raw {
        Some("oldest") => "oldest",
        Some("name_asc") => "name_asc",
        Some("name_desc") => "name_desc",
        Some("xp_desc") => "xp_desc",
        _ => "recent",
    }
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
    let search = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let (rows, total) = admin_repo::list_users(
        &state.db,
        search,
        per_page,
        (page - 1) * per_page,
        query.from,
        query.to,
        sort_key(query.sort.as_deref()),
    )
    .await?;
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
        return Err(ApiError::Validation(
            "color must be #rgb or #rrggbb".to_string(),
        ));
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
    audit(
        &state,
        panel.user_id,
        "role.create",
        None,
        json!({ "name": name }),
    )
    .await;
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
    audit(
        &state,
        panel.user_id,
        "role.update",
        None,
        json!({ "name": name }),
    )
    .await;
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
    audit(
        &state,
        panel.user_id,
        "role.delete",
        None,
        json!({ "role_id": role_id }),
    )
    .await;
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
        audit(
            &state,
            admin.user_id,
            "user.role",
            Some(user_id),
            json!({ "role": role }),
        )
        .await;
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
            if disabled {
                "user.suspend"
            } else {
                "user.reinstate"
            },
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
    let (rows, total) = admin_repo::list_audit(&state.db, per_page, (page - 1) * per_page).await?;
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
    Ok(Json(
        json!({ "items": items, "total": total, "page": page, "per_page": per_page }),
    ))
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

// ── Sanctions, mots de passe et niveaux (panel v3) ───────────────────────────

#[derive(Debug, Deserialize)]
pub struct SuspendBody {
    /// Échéance. Absente = suspension sans terme.
    #[serde(default)]
    pub until: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Vérifie qu'on a le droit d'agir sur ce compte, et renvoie sa ligne.
///
/// Deux garde-fous que rien d'autre ne rattraperait : on ne se sanctionne pas
/// soi-même — ce serait le seul moyen de se verrouiller hors de son propre panel
/// — et un modérateur ne touche pas à un administrateur, faute de quoi la
/// hiérarchie s'inverserait.
async fn target_user(
    state: &AppState,
    panel: &PanelUser,
    user_id: Uuid,
) -> Result<admin_repo::AdminUserRow, ApiError> {
    if user_id == panel.user_id {
        return Err(ApiError::Forbidden(
            "vous ne pouvez pas appliquer cette action à votre propre compte".to_string(),
        ));
    }
    let Some(target) = admin_repo::get_user(&state.db, user_id).await? else {
        return Err(ApiError::NotFound("utilisateur introuvable".to_string()));
    };
    if target.role == "admin" && !panel.is_admin {
        return Err(ApiError::Forbidden(
            "seul un administrateur peut agir sur un administrateur".to_string(),
        ));
    }
    Ok(target)
}

/// `POST /admin/users/{id}/suspend` — suspend, avec ou sans échéance.
pub async fn suspend_user(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<SuspendBody>,
) -> Result<Json<AdminUserDto>, ApiError> {
    panel.require(permissions::MANAGE_USERS, "suspendre un compte")?;
    target_user(&state, &panel, user_id).await?;
    if let Some(until) = body.until
        && until <= Utc::now()
    {
        return Err(ApiError::Validation(
            "l'échéance doit être dans le futur".to_string(),
        ));
    }
    let reason = body
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    admin_repo::suspend_user(&state.db, user_id, body.until, reason).await?;
    // Les sessions ouvertes doivent tomber : sans ça, la sanction n'agirait qu'à
    // la prochaine connexion et un onglet déjà ouvert continuerait de fonctionner.
    session_repo::revoke_all_for_user(&state.db, user_id).await?;
    audit(
        &state,
        panel.user_id,
        "user.suspend",
        Some(user_id),
        json!({ "until": body.until, "reason": reason }),
    )
    .await;
    let row = admin_repo::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("utilisateur introuvable".to_string()))?;
    Ok(Json(row.into()))
}

/// `POST /admin/users/{id}/reinstate` — lève la suspension.
pub async fn reinstate_user(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<AdminUserDto>, ApiError> {
    panel.require(permissions::MANAGE_USERS, "rétablir un compte")?;
    target_user(&state, &panel, user_id).await?;
    admin_repo::reinstate_user(&state.db, user_id).await?;
    audit(
        &state,
        panel.user_id,
        "user.reinstate",
        Some(user_id),
        json!({}),
    )
    .await;
    let row = admin_repo::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("utilisateur introuvable".to_string()))?;
    Ok(Json(row.into()))
}

#[derive(Debug, Serialize)]
pub struct TemporaryPasswordResponse {
    /// Affiché UNE seule fois : seule son empreinte est conservée.
    pub password: String,
}

/// `POST /admin/users/{id}/password/temporary` — engendre un mot de passe.
///
/// Le mot de passe n'est renvoyé qu'ici, en clair, et jamais journalisé : c'est
/// à l'administrateur de le transmettre. Toutes les sessions tombent, sinon la
/// personne resterait connectée avec un mot de passe qu'elle ne connaît plus.
pub async fn temporary_password(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<TemporaryPasswordResponse>, ApiError> {
    panel.require(
        permissions::RESET_PASSWORDS,
        "réinitialiser un mot de passe",
    )?;
    target_user(&state, &panel, user_id).await?;
    let plain = crate::domain::secrets::random_token();
    // Le jeton fait 43 caractères base64url : au-delà d'une trentaine, il devient
    // pénible à transmettre sans rien gagner en solidité.
    let plain: String = plain.chars().take(24).collect();
    let hash = crate::domain::password::hash_password(
        plain.clone(),
        crate::domain::password::Argon2Params::from(&state.config.auth),
    )
    .await?;
    admin_repo::set_password_hash(&state.db, user_id, &hash).await?;
    session_repo::revoke_all_for_user(&state.db, user_id).await?;
    // Le journal retient le geste, jamais le secret.
    audit(
        &state,
        panel.user_id,
        "user.password.temporary",
        Some(user_id),
        json!({}),
    )
    .await;
    Ok(Json(TemporaryPasswordResponse { password: plain }))
}

/// `POST /admin/users/{id}/password/link` — envoie un lien de réinitialisation.
///
/// À préférer au mot de passe temporaire : le secret ne transite jamais par
/// l'administrateur, et la personne choisit elle-même son nouveau mot de passe.
pub async fn send_reset_link(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    panel.require(
        permissions::RESET_PASSWORDS,
        "envoyer un lien de réinitialisation",
    )?;
    let target = target_user(&state, &panel, user_id).await?;
    let token = crate::domain::secrets::random_token();
    let token_hash = crate::domain::secrets::sha256(token.as_bytes());
    let expires = Utc::now() + chrono::Duration::hours(1);
    crate::repositories::verification_repo::create_password_reset(
        &state.db,
        user_id,
        &token_hash,
        expires,
    )
    .await?;
    crate::repositories::verification_repo::enqueue_email(
        &state.db,
        &target.email,
        "password_reset",
        &json!({ "token": token }),
    )
    .await?;
    audit(
        &state,
        panel.user_id,
        "user.password.link",
        Some(user_id),
        json!({}),
    )
    .await;
    Ok(Json(json!({ "status": "reset_email_sent" })))
}

#[derive(Debug, Deserialize)]
pub struct LevelBody {
    /// Expérience cible. 0 remet le compte à zéro.
    pub xp: i64,
}

/// `PUT /admin/users/{id}/level` — fixe l'expérience (donc le niveau).
pub async fn set_level(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<LevelBody>,
) -> Result<Json<AdminUserDto>, ApiError> {
    panel.require(permissions::MANAGE_LEVELS, "modifier un niveau")?;
    if body.xp < 0 {
        return Err(ApiError::Validation(
            "l'expérience ne peut pas être négative".to_string(),
        ));
    }
    target_user(&state, &panel, user_id).await?;
    admin_repo::set_xp(&state.db, user_id, body.xp).await?;
    audit(
        &state,
        panel.user_id,
        "user.level",
        Some(user_id),
        json!({ "xp": body.xp }),
    )
    .await;
    let row = admin_repo::get_user(&state.db, user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("utilisateur introuvable".to_string()))?;
    Ok(Json(row.into()))
}

#[derive(Debug, Deserialize)]
pub struct RoleSuspendBody {
    pub suspended: bool,
}

/// `POST /admin/roles/{id}/suspension` — suspend ou rétablit un rôle.
pub async fn set_role_suspension(
    State(state): State<AppState>,
    panel: PanelUser,
    Path(role_id): Path<Uuid>,
    Json(body): Json<RoleSuspendBody>,
) -> Result<Json<Value>, ApiError> {
    panel.require(permissions::MANAGE_ROLES, "suspendre un rôle")?;
    admin_repo::set_role_suspended(&state.db, role_id, body.suspended).await?;
    audit(
        &state,
        panel.user_id,
        if body.suspended {
            "role.suspend"
        } else {
            "role.reinstate"
        },
        Some(role_id),
        json!({}),
    )
    .await;
    Ok(Json(json!({ "suspended": body.suspended })))
}
