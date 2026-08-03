//! Instance permission bits carried by custom roles (roles.permissions).
//!
//! The legacy `users.role = 'admin'` is the ROOT override: it implies every
//! bit, present and future, and is the only thing allowed to grant or revoke
//! admin itself (a MANAGE_USERS role cannot escalate to admin).

/// See the administration panel (stats, user list, role list).
pub const ADMIN_PANEL: i64 = 1 << 0;
/// Suspend / reinstate accounts.
pub const MANAGE_USERS: i64 = 1 << 1;
/// Create/edit/delete roles and assign them to users.
pub const MANAGE_ROLES: i64 = 1 << 2;
/// Delete anyone's messages (legacy rows and MLS moderation tombstones).
pub const MODERATE: i64 = 1 << 3;
/// Edit other users' identity: display name and @username.
pub const EDIT_PROFILES: i64 = 1 << 4;
/// Read the administration audit log.
pub const VIEW_AUDIT: i64 = 1 << 5;
/// Créer, renommer et supprimer des groupes ; en gérer les membres.
pub const MANAGE_GROUPS: i64 = 1 << 6;
/// Fixer ou remettre à zéro l'expérience et le niveau d'un compte.
pub const MANAGE_LEVELS: i64 = 1 << 7;
/// Réinitialiser un mot de passe : engendrer un mot de passe temporaire ou
/// envoyer un lien de réinitialisation.
///
/// Séparée de MANAGE_USERS à dessein : suspendre un compte est réversible et
/// visible de son propriétaire, alors que reprendre la main sur son mot de passe
/// ouvre l'accès à ses conversations. Les deux ne se confient pas aux mêmes
/// personnes. (Le contenu, lui, reste chiffré de bout en bout : même avec le mot
/// de passe, il faudrait aussi les clés de l'appareil.)
pub const RESET_PASSWORDS: i64 = 1 << 8;

/// Every currently defined bit (used to sanitize client input).
pub const ALL: i64 = ADMIN_PANEL
    | MANAGE_USERS
    | MANAGE_ROLES
    | MODERATE
    | EDIT_PROFILES
    | VIEW_AUDIT
    | MANAGE_GROUPS
    | MANAGE_LEVELS
    | RESET_PASSWORDS;
