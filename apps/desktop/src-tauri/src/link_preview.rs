//! Sender-side link previews. The page is fetched from the NATIVE side (the
//! webview would be CORS-blocked) by the person who typed the URL, metadata is
//! extracted here, and the frontend embeds the result in the ENCRYPTED message
//! envelope. The server never sees the URL — let alone fetches it — and
//! receivers render the card with zero network access of their own.

use serde::Serialize;

#[derive(Serialize)]
pub struct LinkPreview {
    pub url: String,
    pub host: String,
    pub title: String,
    pub description: Option<String>,
}

/// Fetch + extract a preview. `Ok(None)` = nothing sensible to show (non-HTML,
/// non-2xx, no title…); `Err` is reserved for malformed input.
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<Option<LinkPreview>, String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Ok(None);
    }
    let host = parsed.host_str().unwrap_or_default().to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("Mozilla/5.0 (compatible; Accord-Preview)")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = match client.get(parsed).send().await {
        Ok(r) => r,
        Err(_) => return Ok(None), // unreachable host = simply no preview
    };
    if !resp.status().is_success() {
        return Ok(None);
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type.contains("text/html") {
        return Ok(None);
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    // Metadata lives in <head> — 256 KiB is plenty, whatever the page size.
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256 * 1024)]);

    let title = extract_meta(&head, "og:title")
        .or_else(|| extract_meta(&head, "twitter:title"))
        .or_else(|| extract_tag_text(&head, "title"));
    let description = extract_meta(&head, "og:description")
        .or_else(|| extract_meta(&head, "twitter:description"))
        .or_else(|| extract_meta(&head, "\"description\""));

    match title {
        Some(title) if !title.trim().is_empty() => Ok(Some(LinkPreview {
            url,
            host,
            title: clamp(title.trim(), 200),
            description: description
                .map(|d| clamp(d.trim(), 300))
                .filter(|d| !d.is_empty()),
        })),
        _ => Ok(None),
    }
}

/// `content="…"` of the nearest <meta …> tag containing `needle`, either
/// attribute order. Hand-rolled on purpose: no HTML-parser dependency for four
/// meta tags.
fn extract_meta(html: &str, needle: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = html[from..].find(needle) {
        let at = from + i;
        let tag_start = html[..at].rfind('<')?;
        let tag_end = at + html[at..].find('>')?;
        if let Some(tag) = html.get(tag_start..tag_end) {
            if tag.starts_with("<meta") {
                if let Some(c) = tag.find("content=") {
                    let rest = &tag[c + "content=".len()..];
                    let quote = rest.chars().next()?;
                    if quote == '"' || quote == '\'' {
                        if let Some(end) = rest[1..].find(quote) {
                            return Some(decode_entities(&rest[1..1 + end]));
                        }
                    }
                }
            }
        }
        from = at + needle.len();
    }
    None
}

/// Inner text of the first `<tag …>…</tag>` (used for `<title>`).
fn extract_tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let open = lower.find(&format!("<{tag}"))?;
    let after = open + lower[open..].find('>')? + 1;
    let close = after + lower[after..].find(&format!("</{tag}"))?;
    html.get(after..close).map(decode_entities)
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn clamp(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_og_meta_and_title_fallback() {
        let html = r#"<html><head><title>Fallback &amp; Co</title>
            <meta property="og:title" content="Le Titre &amp; plus"/>
            <meta name="og:description" content='Une description.'>
            </head></html>"#;
        assert_eq!(
            extract_meta(html, "og:title").as_deref(),
            Some("Le Titre & plus")
        );
        assert_eq!(
            extract_meta(html, "og:description").as_deref(),
            Some("Une description.")
        );
        assert_eq!(
            extract_tag_text(html, "title").as_deref(),
            Some("Fallback & Co")
        );
        assert_eq!(extract_meta(html, "og:image"), None);
    }
}
