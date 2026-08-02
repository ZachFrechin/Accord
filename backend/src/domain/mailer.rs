//! Transactional email over SMTP, plus the message templates.
//!
//! Delivery goes through a single config-driven SMTP relay so the same code path
//! serves Mailpit in dev and any provider's SMTP endpoint in production. Only the
//! outbox worker calls [`SmtpMailer::send`]; request handlers merely enqueue.

use anyhow::Context;
use lettre::message::{Mailbox, MultiPart};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde_json::Value;

use crate::config::EmailConfig;
use crate::error::ApiError;

/// A fully-rendered email ready to send.
pub struct EmailMessage {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// SMTP-backed mailer built from [`EmailConfig`].
#[derive(Clone)]
pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    /// Builds the transport from the configured relay URL and `From` mailbox.
    /// Fails on a malformed URL or `From` header — surfaced at boot, not at send.
    pub fn from_config(cfg: &EmailConfig) -> anyhow::Result<Self> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(&cfg.smtp_url)
            .context("parsing EMAIL__SMTP_URL")?
            .build();
        let from: Mailbox = cfg.from.parse().context("parsing EMAIL__FROM")?;
        Ok(Self { transport, from })
    }

    /// Sends one message (text + HTML alternative). Errors are mapped to a
    /// masked internal error; the outbox worker retries on failure.
    pub async fn send(&self, msg: EmailMessage) -> Result<(), ApiError> {
        let to: Mailbox = msg
            .to
            .parse()
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("invalid recipient address: {e}")))?;
        let email = Message::builder()
            .from(self.from.clone())
            .to(to)
            .subject(msg.subject)
            .multipart(MultiPart::alternative_plain_html(msg.text, msg.html))
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("building email: {e}")))?;
        self.transport
            .send(email)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("smtp send: {e}")))?;
        Ok(())
    }
}

/// Renders an outbox row (template + JSON payload) into an [`EmailMessage`].
///
/// Payload fields come from our own code (validated usernames, generated links),
/// so plain interpolation is safe here; a templating engine with escaping can
/// replace this later without touching the outbox contract.
pub fn render(template: &str, recipient: &str, payload: &Value) -> EmailMessage {
    let field = |k: &str| {
        payload
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match template {
        "verify_email" => {
            let url = field("verify_url");
            let username = payload
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("there");
            EmailMessage {
                to: recipient.to_string(),
                subject: "Confirm your Accord email".to_string(),
                text: format!(
                    "Hi {username},\n\nConfirm your email address to activate your account:\n{url}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email."
                ),
                html: format!(
                    "<p>Hi {username},</p><p><a href=\"{url}\">Confirm your email address</a> to activate your account.</p><p>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>"
                ),
            }
        }
        "password_reset" => {
            let url = field("reset_url");
            EmailMessage {
                to: recipient.to_string(),
                subject: "Reset your Accord password".to_string(),
                text: format!(
                    "Reset your password:\n{url}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email."
                ),
                html: format!(
                    "<p><a href=\"{url}\">Reset your password</a>.</p><p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>"
                ),
            }
        }
        "account_exists" => EmailMessage {
            to: recipient.to_string(),
            subject: "You already have an Accord account".to_string(),
            text: "Someone tried to register with this email address, but you already have an account. Try signing in, or reset your password if you've forgotten it.".to_string(),
            html: "<p>Someone tried to register with this email address, but you already have an account. Try signing in, or reset your password if you've forgotten it.</p>".to_string(),
        },
        "security_alert" => EmailMessage {
            to: recipient.to_string(),
            subject: "Your Accord password was changed".to_string(),
            text: "Your password was just changed and all active sessions were signed out. If this wasn't you, reset your password immediately.".to_string(),
            html: "<p>Your password was just changed and all active sessions were signed out.</p><p><strong>If this wasn't you, reset your password immediately.</strong></p>".to_string(),
        },
        other => EmailMessage {
            to: recipient.to_string(),
            subject: "Accord notification".to_string(),
            text: format!("(unrecognized email template: {other})"),
            html: format!("<p>(unrecognized email template: {other})</p>"),
        },
    }
}
