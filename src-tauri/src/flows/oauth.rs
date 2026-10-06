//! OAuth 2 credentials for flows — Google, Microsoft or any provider — so a node can call an API
//! that only takes a user's token (Gmail, Sheets, Calendar, Drive, Microsoft Graph).
//!
//! **The user's own OAuth client.** Each credential names a client the user created (a "Desktop app"
//! in Google Cloud, a public client in Entra): its id in the row, its secret in the keychain. Nothing
//! here ships a client id of CodeFlow's — a published app with these scopes would need the
//! provider's review, and the person's own client is what a self-hosted n8n asks for too.
//!
//! **Signed in once, in the browser.** `connect` runs the loopback consent `crate::oauth` already
//! runs for Drive and OneDrive — an ephemeral port, or the exact redirect a custom provider has on
//! file — and trades the code for tokens. The refresh token lives in the keychain next to the client
//! secret; `access_token` hands a node a token good for at least another minute, refreshing — one
//! refresh per credential at a time — when it is not.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine as _;
use serde_json::Value;

use crate::oauth::{self as loopback, RedirectMode};

/// What the keychain holds for an OAuth 2 credential.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: String,
    /// Unix seconds.
    #[serde(default)]
    pub expires_at: i64,
}

impl Tokens {
    /// A stored secret: the JSON this module writes, or — a credential just saved from the form —
    /// the bare client secret.
    pub fn read(secret: &str) -> Tokens {
        serde_json::from_str(secret).unwrap_or_else(|_| Tokens { client_secret: secret.to_string(), ..Default::default() })
    }

    pub fn fresh(&self, now: i64) -> bool {
        !self.access_token.is_empty() && self.expires_at - 60 > now
    }
}

fn text(meta: &Value, key: &str) -> String {
    meta.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// Where a provider signs people in and hands out tokens — `(auth url, token url, extra auth
/// parameters)`. A custom provider brings its own two URLs.
pub fn endpoints(meta: &Value) -> Result<(String, String, Vec<(&'static str, &'static str)>), String> {
    match text(meta, "provider").as_str() {
        // `prompt=consent` with `access_type=offline` is what makes Google hand out a refresh token
        // on every connect, not only the first.
        "google" => Ok((
            "https://accounts.google.com/o/oauth2/v2/auth".into(),
            "https://oauth2.googleapis.com/token".into(),
            vec![("access_type", "offline"), ("prompt", "consent")],
        )),
        "microsoft" => {
            let tenant = Some(text(meta, "tenant")).filter(|t| !t.is_empty()).unwrap_or_else(|| "common".into());
            Ok((
                format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"),
                format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"),
                vec![("prompt", "select_account")],
            ))
        }
        _ => {
            let (auth, token) = (text(meta, "authUrl"), text(meta, "tokenUrl"));
            if auth.is_empty() || token.is_empty() {
                return Err("A custom OAuth 2 provider needs its authorization and token URLs".into());
            }
            Ok((auth, token, Vec::new()))
        }
    }
}

/// The scopes the credential asks for: whitespace or commas between them, sent space-separated.
/// Microsoft only hands out a refresh token for `offline_access`, so it is always added there.
pub fn scopes(meta: &Value) -> String {
    let mut list: Vec<String> = text(meta, "scopes").split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).map(str::to_string).collect();
    if text(meta, "provider") == "microsoft" && !list.iter().any(|s| s == "offline_access") {
        list.push("offline_access".into());
    }
    list.join(" ")
}

/// The consent page's address.
pub fn authorize_url(meta: &Value, redirect: &str, state: &str, challenge: &str) -> Result<String, String> {
    let (auth, _, extra) = endpoints(meta)?;
    let client = text(meta, "clientId");
    if client.is_empty() {
        return Err("The credential needs its OAuth client id".into());
    }
    let mut url = url::Url::parse(&auth).map_err(|e| format!("The authorization URL is not valid: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("response_type", "code");
        pairs.append_pair("client_id", &client);
        pairs.append_pair("redirect_uri", redirect);
        let scope = scopes(meta);
        if !scope.is_empty() {
            pairs.append_pair("scope", &scope);
        }
        pairs.append_pair("state", state);
        pairs.append_pair("code_challenge", challenge);
        pairs.append_pair("code_challenge_method", "S256");
        for (key, value) in extra {
            pairs.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

/// What a token endpoint answered, read into the stored tokens — a refresh that does not send a new
/// refresh token keeps the old one. Some providers answer 200 with an `error`, so that is checked too.
pub fn absorb(previous: &Tokens, answer: &Value, now: i64) -> Result<Tokens, String> {
    if let Some(error) = answer.get("error") {
        let detail = answer.get("error_description").and_then(Value::as_str).unwrap_or_default();
        return Err(format!("The provider refused: {} {detail}", error.as_str().unwrap_or("error")).trim().to_string());
    }
    let access = answer.get("access_token").and_then(Value::as_str).ok_or("The provider answered without an access token")?;
    let expires_in = answer.get("expires_in").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(3600);
    Ok(Tokens {
        client_secret: previous.client_secret.clone(),
        refresh_token: loopback::field(answer, "refresh_token").unwrap_or_else(|| previous.refresh_token.clone()),
        access_token: access.to_string(),
        expires_at: now + expires_in,
    })
}

/// The account a sign-in was for, from the `id_token` the `openid email` scopes bring — read, not
/// verified: it only labels the credential.
pub fn account_of(answer: &Value) -> Option<String> {
    let payload = answer.get("id_token")?.as_str()?.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    claims.get("email").or_else(|| claims.get("preferred_username")).and_then(Value::as_str).map(str::to_string)
}

/// One credential's refresh at a time — two nodes of a run asking together must not both spend a
/// refresh token the provider rotates on use.
static REFRESHING: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

/// A token good for at least another minute, refreshed and stored when it was not.
pub async fn access_token(id: &str, meta: &Value) -> Result<String, String> {
    let gate = REFRESHING.lock().map_err(|e| e.to_string())?.entry(id.to_string()).or_default().clone();
    let _held = gate.lock().await;
    let key = crate::secrets::flow_credential_key(id);
    let tokens = Tokens::read(&crate::secrets::get_secret(&key)?.ok_or("The credential has no secret stored on this computer")?);
    let now = chrono::Utc::now().timestamp();
    if tokens.fresh(now) {
        return Ok(tokens.access_token);
    }
    if tokens.refresh_token.is_empty() {
        return Err("This OAuth 2 credential is not connected yet — press Connect in the flow's credentials".into());
    }
    let (_, token_url, _) = endpoints(meta)?;
    let client = text(meta, "clientId");
    let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", tokens.refresh_token.as_str()), ("client_id", client.as_str())];
    if !tokens.client_secret.is_empty() {
        form.push(("client_secret", tokens.client_secret.as_str()));
    }
    let answer = loopback::post_form(&token_url, &form).await.map_err(|e| format!("The token could not be renewed ({e}) — connect the credential again"))?;
    let next = absorb(&tokens, &answer, now).map_err(|e| format!("{e} — connect the credential again"))?;
    crate::secrets::set_secret(&key, &serde_json::to_string(&next).map_err(|e| e.to_string())?)?;
    Ok(next.access_token)
}

/// Signs a credential in: the consent page in the browser, the code caught on the loopback, traded
/// for tokens and stored. Answers with the account, when the provider says which.
pub async fn connect(id: &str, meta: &Value) -> Result<Option<String>, String> {
    let provider = text(meta, "provider");
    let service = match provider.as_str() {
        "google" => "Google",
        "microsoft" => "Microsoft",
        _ => "the provider",
    };
    // Checked before the browser opens: a credential missing its client id fails here, not after.
    authorize_url(meta, "http://127.0.0.1", "", "")?;
    let registered = text(meta, "redirectUri");
    let (code, redirect, verifier) = if registered.is_empty() {
        // Microsoft registers `http://localhost`; Google, the loopback address itself.
        let host = if provider == "microsoft" { "localhost" } else { "127.0.0.1" };
        let grant = loopback::consent(service, host, |redirect, challenge, state| {
            authorize_url(meta, redirect, state, challenge).unwrap_or_default()
        })
        .await?;
        (grant.code, grant.redirect_uri, grant.verifier)
    } else {
        // A provider that only redirects to the exact URI registered with it.
        let target = loopback::loopback_redirect(&registered)?;
        let (verifier, challenge) = loopback::pkce_pair();
        let state = uuid::Uuid::new_v4().to_string();
        let url = authorize_url(meta, &registered, &state, &challenge)?;
        let params = loopback::capture_redirect(&target, &state, RedirectMode::Code, || open::that(&url).map_err(|e| format!("could not open the browser: {e}"))).await?;
        let code = params.into_iter().find(|(k, _)| k == "code").map(|(_, v)| v).ok_or("The provider answered without a code")?;
        (code, registered, verifier)
    };

    let key = crate::secrets::flow_credential_key(id);
    let tokens = Tokens::read(&crate::secrets::get_secret(&key)?.unwrap_or_default());
    let (_, token_url, _) = endpoints(meta)?;
    let client = text(meta, "clientId");
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("client_id", client.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    if !tokens.client_secret.is_empty() {
        form.push(("client_secret", tokens.client_secret.as_str()));
    }
    let answer = loopback::post_form(&token_url, &form).await?;
    let next = absorb(&tokens, &answer, chrono::Utc::now().timestamp())?;
    if next.refresh_token.is_empty() {
        return Err(match provider.as_str() {
            "google" => "Google gave no refresh token — the OAuth client must be a Desktop app".into(),
            "microsoft" => "Microsoft gave no refresh token — the app must allow public client flows".into(),
            _ => "The provider gave no refresh token — add the scope it needs for offline access".into(),
        });
    }
    crate::secrets::set_secret(&key, &serde_json::to_string(&next).map_err(|e| e.to_string())?)?;
    Ok(account_of(&answer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_consent_url_carries_pkce_and_the_providers_extras() {
        let meta = json!({"provider": "google", "clientId": "abc.apps.googleusercontent.com", "scopes": "openid email\nhttps://www.googleapis.com/auth/spreadsheets"});
        let url = url::Url::parse(&authorize_url(&meta, "http://127.0.0.1:5555", "s1", "ch").unwrap()).unwrap();
        let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        assert_eq!((query["code_challenge"].as_str(), query["code_challenge_method"].as_str()), ("ch", "S256"));
        assert_eq!(query["access_type"], "offline");
        assert_eq!(query["scope"], "openid email https://www.googleapis.com/auth/spreadsheets");
        assert!(authorize_url(&json!({"provider": "custom", "clientId": "x"}), "r", "s", "c").is_err());
        assert!(authorize_url(&json!({"provider": "google"}), "r", "s", "c").is_err());

        let ms = json!({"provider": "microsoft", "tenant": "contoso.onmicrosoft.com", "scopes": "Mail.Send, User.Read"});
        assert!(endpoints(&ms).unwrap().1.contains("contoso.onmicrosoft.com/oauth2/v2.0/token"));
        assert_eq!(scopes(&ms), "Mail.Send User.Read offline_access");
    }

    #[test]
    fn token_answers_are_absorbed_keeping_what_a_refresh_leaves_out() {
        let before = Tokens { client_secret: "cs".into(), refresh_token: "r1".into(), access_token: "a0".into(), expires_at: 0 };
        let refreshed = absorb(&before, &json!({"access_token": "a1", "expires_in": 3599}), 1_000).unwrap();
        assert_eq!((refreshed.refresh_token.as_str(), refreshed.access_token.as_str(), refreshed.expires_at), ("r1", "a1", 4_599));
        assert_eq!(refreshed.client_secret, "cs");
        assert!(refreshed.fresh(4_000) && !refreshed.fresh(4_560));
        let rotated = absorb(&before, &json!({"access_token": "a2", "refresh_token": "r2", "expires_in": "60"}), 0).unwrap();
        assert_eq!((rotated.refresh_token.as_str(), rotated.expires_at), ("r2", 60));
        assert!(absorb(&before, &json!({"error": "invalid_grant", "error_description": "Token has been expired or revoked."}), 0)
            .unwrap_err()
            .contains("invalid_grant"));
        assert_eq!(Tokens::read("bare-client-secret").client_secret, "bare-client-secret");
        let stored = serde_json::to_string(&refreshed).unwrap();
        assert_eq!(Tokens::read(&stored), refreshed);
    }

    #[test]
    fn the_account_is_read_from_the_id_token() {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"email":"ana@example.com"}"#);
        assert_eq!(account_of(&json!({"id_token": format!("h.{claims}.s")})).as_deref(), Some("ana@example.com"));
        assert_eq!(account_of(&json!({})), None);
    }

    #[tokio::test]
    async fn a_fresh_token_is_handed_out_without_a_refresh_and_an_unconnected_one_says_so() {
        let _store = crate::secrets::test_store();
        let key = crate::secrets::flow_credential_key("oauth-test");
        let later = chrono::Utc::now().timestamp() + 3_600;
        let fresh = Tokens { client_secret: "cs".into(), refresh_token: "r".into(), access_token: "live".into(), expires_at: later };
        crate::secrets::set_secret(&key, &serde_json::to_string(&fresh).unwrap()).unwrap();
        // A custom provider with an unroutable token URL: a refresh would fail, so success proves none ran.
        let meta = json!({"provider": "custom", "clientId": "c", "authUrl": "http://127.0.0.1:9/a", "tokenUrl": "http://127.0.0.1:9/t"});
        assert_eq!(access_token("oauth-test", &meta).await.unwrap(), "live");

        crate::secrets::set_secret(&key, "only-the-client-secret").unwrap();
        assert!(access_token("oauth-test", &meta).await.unwrap_err().contains("not connected"));
        crate::secrets::delete_secret(&key).unwrap();
    }
}
