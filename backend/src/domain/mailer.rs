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
        // Un code à recopier, pas un lien. Accord est une application de bureau
        // et de téléphone : un lien cliqué ouvre un navigateur, qui n'a aucun
        // moyen de rendre la main à l'application. Le lien envoyé jusqu'ici ne
        // menait d'ailleurs nulle part — la route est en POST, l'ouvrir
        // renvoyait une erreur 405. Il ne transportait que ce code.
        "verify_email" => {
            let token = field("token");
            let username = payload
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("there");
            EmailMessage {
                to: recipient.to_string(),
                subject: "Votre code de confirmation Accord".to_string(),
                text: format!(
                    "Bonjour {username},\n\nVoici votre code de confirmation. Copiez-le et collez-le dans Accord :\n\n{token}\n\nIl expire dans 24 heures. Si vous n'avez pas créé de compte, ignorez ce message."
                ),
                html: format!(
                    "<p>Bonjour {username},</p>\
                     <p>Voici votre code de confirmation. Copiez-le et collez-le dans Accord&nbsp;:</p>\
                     {}\
                     <p>Il expire dans 24&nbsp;heures. Si vous n'avez pas créé de compte, ignorez ce message.</p>",
                    code_block(&token)
                ),
            }
        }
        "password_reset" => {
            let token = field("token");
            EmailMessage {
                to: recipient.to_string(),
                subject: "Votre code de réinitialisation Accord".to_string(),
                text: format!(
                    "Voici votre code de réinitialisation. Copiez-le et collez-le dans Accord :\n\n{token}\n\nIl expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."
                ),
                html: format!(
                    "<p>Voici votre code de réinitialisation. Copiez-le et collez-le dans Accord&nbsp;:</p>\
                     {}\
                     <p>Il expire dans 1&nbsp;heure. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>",
                    code_block(&token)
                ),
            }
        }
        "account_exists" => EmailMessage {
            to: recipient.to_string(),
            subject: "Vous avez déjà un compte Accord".to_string(),
            text: "Quelqu'un a tenté de créer un compte avec cette adresse, mais vous en avez déjà un. Connectez-vous, ou réinitialisez votre mot de passe si vous l'avez oublié.".to_string(),
            html: "<p>Quelqu'un a tenté de créer un compte avec cette adresse, mais vous en avez déjà un. Connectez-vous, ou réinitialisez votre mot de passe si vous l'avez oublié.</p>".to_string(),
        },
        "security_alert" => EmailMessage {
            to: recipient.to_string(),
            subject: "Votre mot de passe Accord a été modifié".to_string(),
            text: "Votre mot de passe vient d'être modifié et toutes vos sessions ont été déconnectées. Si vous n'êtes pas à l'origine de ce changement, réinitialisez-le immédiatement.".to_string(),
            html: "<p>Votre mot de passe vient d'être modifié et toutes vos sessions ont été déconnectées.</p><p><strong>Si vous n'êtes pas à l'origine de ce changement, réinitialisez-le immédiatement.</strong></p>".to_string(),
        },
        other => EmailMessage {
            to: recipient.to_string(),
            subject: "Accord notification".to_string(),
            text: format!("(unrecognized email template: {other})"),
            html: format!("<p>(unrecognized email template: {other})</p>"),
        },
    }
}

/// Encadre le code de façon qu'il se sélectionne d'un seul geste.
///
/// Un jeton fait 43 caractères : le recopier à la main est hors de question, et
/// une sélection à la souris qui rate un caractère produit une erreur que rien
/// n'explique à l'utilisateur. Tout est en style en ligne — les clients mail
/// suppriment presque toujours les feuilles de style.
fn code_block(token: &str) -> String {
    format!(
        "<p style=\"margin:24px 0\">\
           <code style=\"display:inline-block;padding:14px 18px;border:1px solid #d0d5dd;\
                        border-radius:8px;background:#f7f8fa;font-family:ui-monospace,\
                        SFMono-Regular,Menlo,Consolas,monospace;font-size:15px;\
                        letter-spacing:0.5px;word-break:break-all;user-select:all\">{token}</code>\
         </p>"
    )
}
