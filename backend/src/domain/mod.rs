//! Domain logic — pure(ish) building blocks used by the controllers.
//!
//! Kept separate from `controllers` (HTTP shape) and `repositories` (SQL) so the
//! security-sensitive pieces (password hashing, token signing) have a single,
//! auditable home.

pub mod games;
pub mod livekit;
pub mod mailer;
pub mod outbox;
pub mod password;
pub mod permissions;
pub mod push;
pub mod recovery;
pub mod secrets;
pub mod storage;
pub mod tokens;
pub mod totp;
pub mod transparency;
pub mod validation;
pub mod xp;
