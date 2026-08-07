//! Data-access layer — one repository per aggregate, all SQL compile-checked by
//! sqlx. Repositories own the queries; controllers own the HTTP shape.

pub mod admin_repo;
pub mod attachment_repo;
pub mod call_sound_asset_repo;
pub mod conversation_repo;
pub mod device_key_repo;
pub mod friend_repo;
pub mod game_account_repo;
pub mod message_reaction_repo;
pub mod message_repo;
pub mod mls_group_repo;
pub mod mls_key_package_repo;
pub mod profile_repo;
pub mod push_device_repo;
pub mod session_repo;
pub mod totp_repo;
pub mod transparency_repo;
pub mod user_repo;
pub mod verification_repo;
pub mod xp_repo;
