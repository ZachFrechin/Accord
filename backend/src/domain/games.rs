//! Connecteurs de rangs de jeu — Riot (LoL) et FACEIT (CS2).
//!
//! Le serveur résout l'identité (Riot ID → puuid, pseudo FACEIT → player_id)
//! puis lit le rang ; les clés API vivent en config et une clé absente coupe
//! proprement le jeu concerné. reqwest est compilé sans la feature `json` :
//! on lit du texte et on parse via serde_json.

use std::time::Duration;

use serde_json::Value;

use crate::error::ApiError;

pub const GAME_LOL: &str = "lol";
pub const GAME_CS2: &str = "cs2";
/// Réservés (phase C) — la table les accepte déjà.
pub const KNOWN_GAMES: [&str; 4] = [GAME_LOL, GAME_CS2, "valorant", "rocket-league"];

/// Identité externe résolue + premier rang lu.
pub struct ResolvedAccount {
    pub external_id: String,
    pub external_name: String,
    pub region: Option<String>,
    pub rank: Value,
}

fn http() -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("accord2-backend")
        .build()
        .map_err(|e| ApiError::ServiceUnavailable(format!("http client: {e}")))
}

fn upstream(err: reqwest::Error) -> ApiError {
    ApiError::ServiceUnavailable(format!("service du jeu injoignable: {err}"))
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
) -> Result<(u16, Value), ApiError> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.map_err(upstream)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(upstream)?;
    let value = serde_json::from_str(&body).unwrap_or(Value::Null);
    Ok((status, value))
}

/// Plateformes LoL supportées (sélecteur côté client) → hôte de routage compte.
pub fn lol_routing_for(platform: &str) -> Option<&'static str> {
    match platform {
        "euw1" | "eune1" | "tr1" | "ru" => Some("europe"),
        "na1" | "br1" | "la1" | "la2" => Some("americas"),
        "kr" | "jp1" | "oc1" => Some("asia"),
        _ => None,
    }
}

fn require_key(key: &str, game: &str) -> Result<(), ApiError> {
    if key.trim().is_empty() {
        return Err(ApiError::ServiceUnavailable(format!(
            "l'intégration {game} n'est pas configurée sur ce serveur"
        )));
    }
    Ok(())
}

/// Extrait l'entrée classée pertinente des réponses league-v4 (solo, sinon flex).
fn lol_rank_payload(entries: &Value) -> Value {
    let list = entries.as_array().cloned().unwrap_or_default();
    let pick = list
        .iter()
        .find(|e| e["queueType"] == "RANKED_SOLO_5x5")
        .or_else(|| list.iter().find(|e| e["queueType"] == "RANKED_FLEX_SR"));
    match pick {
        Some(e) => serde_json::json!({
            "queue": e["queueType"],
            "tier": e["tier"],
            "division": e["rank"],
            "lp": e["leaguePoints"],
            "wins": e["wins"],
            "losses": e["losses"],
        }),
        None => serde_json::json!({ "tier": "UNRANKED" }),
    }
}

/// Lit le rang LoL d'un puuid connu (rafraîchissement).
pub async fn fetch_lol_rank(key: &str, platform: &str, puuid: &str) -> Result<Value, ApiError> {
    require_key(key, "LoL")?;
    if lol_routing_for(platform).is_none() {
        return Err(ApiError::Validation("région LoL inconnue".to_string()));
    }
    let client = http()?;
    let url =
        format!("https://{platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/{puuid}");
    let (status, body) = get_json(&client, &url, &[("X-Riot-Token", key)]).await?;
    match status {
        200 => Ok(lol_rank_payload(&body)),
        401 | 403 => Err(ApiError::ServiceUnavailable(
            "clé Riot invalide ou expirée côté serveur".to_string(),
        )),
        429 => Err(ApiError::TooManyRequests(
            "limite Riot atteinte, réessayez dans un instant".to_string(),
        )),
        _ => Err(ApiError::ServiceUnavailable(format!(
            "Riot a répondu {status}"
        ))),
    }
}

/// Résout un Riot ID « Nom#TAG » sur une plateforme et lit son rang.
pub async fn link_lol(
    key: &str,
    riot_id: &str,
    platform: &str,
) -> Result<ResolvedAccount, ApiError> {
    require_key(key, "LoL")?;
    let routing = lol_routing_for(platform)
        .ok_or_else(|| ApiError::Validation("région LoL inconnue".to_string()))?;
    let (name, tag) = riot_id
        .split_once('#')
        .map(|(n, t)| (n.trim(), t.trim()))
        .filter(|(n, t)| !n.is_empty() && !t.is_empty())
        .ok_or_else(|| ApiError::Validation("format attendu : Pseudo#TAG".to_string()))?;

    let client = http()?;
    let url = format!(
        "https://{routing}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
        urlencoding::encode(name),
        urlencoding::encode(tag),
    );
    let (status, body) = get_json(&client, &url, &[("X-Riot-Token", key)]).await?;
    let puuid = match status {
        200 => body["puuid"].as_str().unwrap_or_default().to_string(),
        404 => {
            return Err(ApiError::NotFound(
                "Riot ID introuvable — vérifiez Pseudo#TAG".to_string(),
            ));
        }
        401 | 403 => {
            return Err(ApiError::ServiceUnavailable(
                "clé Riot invalide ou expirée côté serveur".to_string(),
            ));
        }
        429 => {
            return Err(ApiError::TooManyRequests(
                "limite Riot atteinte, réessayez dans un instant".to_string(),
            ));
        }
        _ => {
            return Err(ApiError::ServiceUnavailable(format!(
                "Riot a répondu {status}"
            )));
        }
    };
    if puuid.is_empty() {
        return Err(ApiError::ServiceUnavailable(
            "réponse Riot inattendue".to_string(),
        ));
    }

    let display = format!(
        "{}#{}",
        body["gameName"].as_str().unwrap_or(name),
        body["tagLine"].as_str().unwrap_or(tag),
    );
    let rank = fetch_lol_rank(key, platform, &puuid).await?;
    Ok(ResolvedAccount {
        external_id: puuid,
        external_name: display,
        region: Some(platform.to_string()),
        rank,
    })
}

/// Extrait elo/niveau CS2 d'un objet joueur FACEIT.
fn faceit_rank_payload(player: &Value) -> Result<Value, ApiError> {
    let cs2 = &player["games"]["cs2"];
    if cs2.is_null() {
        return Err(ApiError::NotFound(
            "ce compte FACEIT n'a pas de profil CS2".to_string(),
        ));
    }
    Ok(serde_json::json!({
        "elo": cs2["faceit_elo"],
        "level": cs2["skill_level"],
    }))
}

/// Lit le rang FACEIT d'un player_id connu (rafraîchissement).
pub async fn fetch_faceit_rank(key: &str, player_id: &str) -> Result<Value, ApiError> {
    require_key(key, "CS2/FACEIT")?;
    let client = http()?;
    let url = format!("https://open.faceit.com/data/v4/players/{player_id}");
    let auth = format!("Bearer {key}");
    let (status, body) = get_json(&client, &url, &[("Authorization", &auth)]).await?;
    match status {
        200 => faceit_rank_payload(&body),
        401 | 403 => Err(ApiError::ServiceUnavailable(
            "clé FACEIT invalide côté serveur".to_string(),
        )),
        404 => Err(ApiError::NotFound("compte FACEIT introuvable".to_string())),
        429 => Err(ApiError::TooManyRequests(
            "limite FACEIT atteinte, réessayez dans un instant".to_string(),
        )),
        _ => Err(ApiError::ServiceUnavailable(format!(
            "FACEIT a répondu {status}"
        ))),
    }
}

/// Résout un pseudo FACEIT et lit son elo/niveau CS2.
pub async fn link_faceit(key: &str, nickname: &str) -> Result<ResolvedAccount, ApiError> {
    require_key(key, "CS2/FACEIT")?;
    let nickname = nickname.trim();
    if nickname.is_empty() || nickname.len() > 64 {
        return Err(ApiError::Validation("pseudo FACEIT invalide".to_string()));
    }
    let client = http()?;
    let url = format!(
        "https://open.faceit.com/data/v4/players?nickname={}",
        urlencoding::encode(nickname),
    );
    let auth = format!("Bearer {key}");
    let (status, body) = get_json(&client, &url, &[("Authorization", &auth)]).await?;
    match status {
        200 => {
            let player_id = body["player_id"].as_str().unwrap_or_default().to_string();
            if player_id.is_empty() {
                return Err(ApiError::ServiceUnavailable(
                    "réponse FACEIT inattendue".to_string(),
                ));
            }
            let rank = faceit_rank_payload(&body)?;
            Ok(ResolvedAccount {
                external_id: player_id,
                external_name: body["nickname"].as_str().unwrap_or(nickname).to_string(),
                region: None,
                rank,
            })
        }
        404 => Err(ApiError::NotFound(
            "pseudo FACEIT introuvable — vérifiez l'orthographe".to_string(),
        )),
        401 | 403 => Err(ApiError::ServiceUnavailable(
            "clé FACEIT invalide côté serveur".to_string(),
        )),
        429 => Err(ApiError::TooManyRequests(
            "limite FACEIT atteinte, réessayez dans un instant".to_string(),
        )),
        _ => Err(ApiError::ServiceUnavailable(format!(
            "FACEIT a répondu {status}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lol_rank_picks_solo_queue_first() {
        let entries = serde_json::json!([
            { "queueType": "RANKED_FLEX_SR", "tier": "GOLD", "rank": "I", "leaguePoints": 10, "wins": 1, "losses": 1 },
            { "queueType": "RANKED_SOLO_5x5", "tier": "EMERALD", "rank": "II", "leaguePoints": 54, "wins": 40, "losses": 35 },
        ]);
        let p = lol_rank_payload(&entries);
        assert_eq!(p["tier"], "EMERALD");
        assert_eq!(p["division"], "II");
        assert_eq!(p["queue"], "RANKED_SOLO_5x5");
    }

    #[test]
    fn lol_rank_unranked_when_no_entries() {
        assert_eq!(lol_rank_payload(&serde_json::json!([]))["tier"], "UNRANKED");
    }

    #[test]
    fn routing_map_covers_known_platforms() {
        assert_eq!(lol_routing_for("euw1"), Some("europe"));
        assert_eq!(lol_routing_for("na1"), Some("americas"));
        assert_eq!(lol_routing_for("kr"), Some("asia"));
        assert_eq!(lol_routing_for("mars"), None);
    }
}
