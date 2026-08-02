//! Input validation for the auth surface. Returns client-safe [`ApiError`]s.

use crate::error::ApiError;

/// Validates and normalizes a username to lowercase `[a-z0-9_]{3,32}`.
pub fn validate_username(raw: &str) -> Result<String, ApiError> {
    let username = raw.trim().to_lowercase();
    let len_ok = (3..=32).contains(&username.chars().count());
    let charset_ok = username
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if len_ok && charset_ok {
        Ok(username)
    } else {
        Err(ApiError::Validation(
            "username must be 3-32 characters of a-z, 0-9 or _".to_string(),
        ))
    }
}

/// Validates and normalizes an email with a minimal structural check. Real
/// deliverability is proven by the verification email, not by a regex.
pub fn validate_email(raw: &str) -> Result<String, ApiError> {
    let email = raw.trim().to_lowercase();
    let parts: Vec<&str> = email.split('@').collect();
    let ok = email.len() <= 254
        && parts.len() == 2
        && parts.iter().all(|p| !p.is_empty())
        && parts[1].contains('.');
    if ok {
        Ok(email)
    } else {
        Err(ApiError::Validation(
            "enter a valid email address".to_string(),
        ))
    }
}

/// Normalizes a custom presence status text: strips control chars AND the
/// Unicode line/paragraph separators, bidi controls, and zero-width/format chars
/// (so it stays a clean single line and can't spoof text direction), then
/// truncates to 100 scalar values (emoji-safe). An empty result means "clear".
/// Always `Ok` (the WS command has no error channel — over-long is truncated, not
/// rejected): `Ok(None)` clears, `Ok(Some)` sets.
pub fn validate_status_text(raw: &str) -> Result<Option<String>, ApiError> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|&c| {
            !c.is_control()
                && !matches!(c,
                    '\u{200B}'..='\u{200F}'   // zero-width + bidi marks
                    | '\u{2028}' | '\u{2029}' // line / paragraph separators
                    | '\u{202A}'..='\u{202E}' // bidi embedding / override
                    | '\u{2060}'..='\u{2064}' // word joiner + invisible math ops
                    | '\u{FEFF}') // BOM / zero-width no-break space
        })
        .take(100)
        .collect();
    let cleaned = cleaned.trim();
    Ok(if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    })
}

/// Shared profile-text sanitizer: strips control chars (except a newline when
/// `allow_newline`), bidi/zero-width/format chars (anti-spoofing), and caps to
/// `max` scalar values. Empty → `None`.
fn sanitize_profile_text(raw: &str, max: usize, allow_newline: bool) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|&c| {
            (!c.is_control() || (allow_newline && c == '\n'))
                && !matches!(c,
                    '\u{200B}'..='\u{200F}'
                    | '\u{2028}' | '\u{2029}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'..='\u{2064}'
                    | '\u{FEFF}')
        })
        .take(max)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// Display name — a single sanitized line, up to 48 scalar values. `None` = clear.
pub fn validate_display_name(raw: &str) -> Option<String> {
    sanitize_profile_text(raw, 48, false)
}

/// Bio — sanitized, newlines allowed, up to 300 scalar values. `None` = clear.
pub fn validate_bio(raw: &str) -> Option<String> {
    sanitize_profile_text(raw, 300, true)
}

/// Accent color — `#RRGGBB` (lowercased). Empty → `None`; malformed → error.
pub fn validate_accent_color(raw: &str) -> Result<Option<String>, ApiError> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let valid = t.len() == 7 && t.starts_with('#') && t[1..].chars().all(|c| c.is_ascii_hexdigit());
    if valid {
        Ok(Some(t.to_ascii_lowercase()))
    } else {
        Err(ApiError::Validation(
            "accent_color must be a #RRGGBB hex value".to_string(),
        ))
    }
}

/// Enforces the password length policy (charset/composition rules are
/// deliberately avoided per NIST SP 800-63B; strength is screened via HIBP).
pub fn validate_password(raw: &str, min_len: usize) -> Result<(), ApiError> {
    let len = raw.chars().count();
    if len < min_len {
        return Err(ApiError::Validation(format!(
            "password must be at least {min_len} characters"
        )));
    }
    if len > 256 {
        return Err(ApiError::Validation(
            "password must be at most 256 characters".to_string(),
        ));
    }
    Ok(())
}
