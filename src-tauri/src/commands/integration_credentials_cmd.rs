use std::{sync::OnceLock, time::Duration};

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use reqwest::{header, Client, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::{
    ado, bitbucket,
    boards::{jira, linear, monday, BoardAuth},
    db::Db,
    github, gitlab, secrets,
};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum IntegrationProvider {
    Azure,
    Github,
    Gitlab,
    Bitbucket,
    Jira,
    Monday,
    Linear,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum CredentialStatus {
    Valid,
    Expired,
    Rejected,
    AccessDenied,
    Missing,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCheck {
    status: CredentialStatus,
    expires_at: Option<i64>,
    account: Option<String>,
}

impl CredentialCheck {
    fn valid(account: Option<String>, expires_at: Option<i64>) -> Self {
        Self { status: CredentialStatus::Valid, expires_at, account }
    }
}

impl From<CredentialStatus> for CredentialCheck {
    fn from(status: CredentialStatus) -> Self {
        Self { status, expires_at: None, account: None }
    }
}

fn client() -> Result<Client, CredentialStatus> {
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    // Private-Token and other custom auth headers must stay on the configured host.
    CLIENT.get_or_init(|| Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .build()
    ).as_ref().cloned().map_err(|_| CredentialStatus::Unavailable)
}

fn saved_secret(provider: IntegrationProvider, account: &str) -> Result<String, CredentialStatus> {
    use IntegrationProvider::*;
    let secret = match provider {
        Azure => secrets::ado_pat(account),
        Github => secrets::get_secret(&secrets::github_token_key(account)),
        Gitlab => secrets::get_secret(&secrets::gitlab_token_key(account)),
        Bitbucket => secrets::get_secret(&secrets::bitbucket_token_key(account)),
        Jira => secrets::get_secret(&secrets::jira_token_key(&jira::normalize_site(account))),
        Monday => secrets::get_secret(&secrets::monday_token_key(account)),
        Linear => secrets::get_secret(&secrets::linear_token_key(account)),
    };
    secret.map_err(|_| CredentialStatus::Unavailable)?
        .filter(|token| !token.trim().is_empty())
        .ok_or(CredentialStatus::Missing)
}

async fn send(request: RequestBuilder) -> Result<Response, CredentialStatus> {
    request.send().await.map_err(|_| CredentialStatus::Unavailable)
}

async fn json_body(response: Response) -> Result<Value, CredentialStatus> {
    response.json().await.map_err(|_| CredentialStatus::Unavailable)
}

fn status_error(status: StatusCode) -> CredentialStatus {
    match status {
        StatusCode::UNAUTHORIZED => CredentialStatus::Rejected,
        StatusCode::FORBIDDEN => CredentialStatus::AccessDenied,
        _ => CredentialStatus::Unavailable,
    }
}

fn github_expiration(header: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(header).ok().map(|date| date.timestamp_millis())
        .or_else(|| {
            let utc = header.strip_suffix(" UTC")?;
            let date = NaiveDateTime::parse_from_str(utc, "%Y-%m-%d %H:%M:%S").ok()?;
            Some(date.and_utc().timestamp_millis())
        })
}

async fn check_azure(response: Response) -> Result<CredentialCheck, CredentialStatus> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        let body = response.text().await.unwrap_or_default();
        return Err(if ado::describe_failure(status, &body) == ado::PAT_EXPIRED {
            CredentialStatus::Expired
        } else {
            CredentialStatus::Rejected
        });
    }
    let login_redirect = response.headers().get(header::LOCATION)
        .and_then(|location| location.to_str().ok())
        .and_then(|location| reqwest::Url::parse(location).ok())
        .is_some_and(|url| matches!(url.host_str(), Some("login.microsoftonline.com" | "app.vssps.visualstudio.com" | "vssps.dev.azure.com")));
    let html = response.headers().get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    if (status.is_redirection() && login_redirect) || (status.as_u16() == 203 && html) {
        return Err(CredentialStatus::Rejected);
    }
    if !status.is_success() {
        return Err(status_error(status));
    }
    let body = json_body(response).await?;
    let user = &body["authenticatedUser"];
    let id = user["id"].as_str().ok_or(CredentialStatus::Unavailable)?;
    if id == "00000000-0000-0000-0000-000000000000" {
        return Err(CredentialStatus::Rejected);
    }
    let name = user["customDisplayName"].as_str()
        .or_else(|| user["providerDisplayName"].as_str()).map(str::to_owned);
    Ok(CredentialCheck::valid(name, None))
}

async fn gitlab_expiration(client: Client, root: &str, token: &str) -> Option<i64> {
    // Older servers and some scopes cannot read this metadata. Identity is checked independently.
    let response = send(gitlab::authed(client.get(format!("{root}/personal_access_tokens/self")), token)).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = json_body(response).await.ok()?;
    let date = NaiveDate::parse_from_str(body["expires_at"].as_str()?, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

fn graphql_error(body: &Value) -> Option<CredentialStatus> {
    let errors = body["errors"].as_array()?;
    if errors.is_empty() {
        return None;
    }
    for error in errors {
        match error["extensions"]["code"].as_str().or_else(|| error["error_code"].as_str()) {
            Some("UNAUTHENTICATED" | "AUTHENTICATION_ERROR" | "NOT_AUTHENTICATED" | "InvalidTokenException") =>
                return Some(CredentialStatus::Rejected),
            Some("FORBIDDEN" | "AuthorizationException" | "UserUnauthorizedException") =>
                return Some(CredentialStatus::AccessDenied),
            _ => {}
        }
    }
    Some(CredentialStatus::Unavailable)
}

async fn check_graphql(response: Response, identity: &str, account: &str) -> Result<CredentialCheck, CredentialStatus> {
    let status = response.status();
    if !status.is_success() {
        if status == StatusCode::UNAUTHORIZED {
            let body = response.text().await.unwrap_or_default();
            if body.to_ascii_lowercase().contains("ip is restricted") {
                return Err(CredentialStatus::AccessDenied);
            }
        }
        return Err(status_error(status));
    }
    let body = json_body(response).await?;
    if let Some(error) = graphql_error(&body) {
        return Err(error);
    }
    match body.pointer(identity).and_then(Value::as_str) {
        Some(id) if id.eq_ignore_ascii_case(account) => Ok(CredentialCheck::valid(None, None)),
        Some(_) => Err(CredentialStatus::AccessDenied),
        None => Err(CredentialStatus::Unavailable),
    }
}

async fn check(
    db: &State<'_, Db>,
    provider: IntegrationProvider,
    account: &str,
) -> Result<CredentialCheck, CredentialStatus> {
    use IntegrationProvider::*;

    let token = saved_secret(provider, account)?;
    let client = client()?;
    match provider {
        Azure => {
            let response = send(client.get(ado::connection_data_url(account))
                .header(header::AUTHORIZATION, ado::auth_header(&token))
                .header(header::ACCEPT, "application/json")
                .header("X-TFS-FedAuthRedirect", "Suppress")).await?;
            check_azure(response).await
        }
        Github => {
            let response = send(github::rest(client.get(format!("{}/user", github::api_root(account))), &token)).await?;
            if !response.status().is_success() {
                // GitHub uses 403 for some rate limits and for responses that require SSO.
                let rate_limited = response.headers().get("x-ratelimit-remaining").is_some_and(|value| value == "0")
                    || response.headers().contains_key(header::RETRY_AFTER);
                return Err(if rate_limited {
                    CredentialStatus::Unavailable
                } else {
                    status_error(response.status())
                });
            }
            let expiration = response.headers().get("github-authentication-token-expiration")
                .and_then(|value| value.to_str().ok()).and_then(github_expiration);
            let body = json_body(response).await?;
            let login = body["login"].as_str().ok_or(CredentialStatus::Unavailable)?;
            Ok(CredentialCheck::valid(Some(login.to_owned()), expiration))
        }
        Gitlab => {
            let root = gitlab::api_root(account);
            let response = send(gitlab::authed(client.get(format!("{root}/user")), &token)).await?;
            if !response.status().is_success() {
                return Err(status_error(response.status()));
            }
            let body = json_body(response).await?;
            let login = body["username"].as_str().ok_or(CredentialStatus::Unavailable)?;
            let expiration = gitlab_expiration(client, &root, &token).await;
            Ok(CredentialCheck::valid(Some(login.to_owned()), expiration))
        }
        Bitbucket => {
            let auth = bitbucket::BitbucketAuth::from_secret(&token)
                .filter(bitbucket::BitbucketAuth::is_complete)
                .ok_or(CredentialStatus::Missing)?;
            let workspace = ado::encode_segment(&bitbucket::normalize_workspace(account));
            let request = client.get(format!("{}/repositories/{workspace}?pagelen=1", bitbucket::API_ROOT));
            let response = send(bitbucket::authed(request, &auth)).await?;
            match response.status() {
                StatusCode::NOT_FOUND => Err(CredentialStatus::AccessDenied),
                status if status.is_success() => {
                    let body = json_body(response).await?;
                    body["values"].as_array().ok_or(CredentialStatus::Unavailable)?;
                    Ok(CredentialCheck::valid(None, None))
                }
                status => Err(status_error(status)),
            }
        }
        Jira => {
            let email = super::stories_cmd::jira_email(db, account)
                .ok().filter(|email| !email.trim().is_empty()).ok_or(CredentialStatus::AccessDenied)?;
            let response = send(client.get(format!("{}/rest/api/2/myself", jira::normalize_site(account)))
                .basic_auth(email, Some(token)).header(header::ACCEPT, "application/json")).await?;
            if !response.status().is_success() {
                return Err(status_error(response.status()));
            }
            let body = json_body(response).await?;
            if body["active"] == false {
                return Err(CredentialStatus::AccessDenied);
            }
            if body["accountId"].as_str().or_else(|| body["name"].as_str()).is_none() {
                return Err(CredentialStatus::Unavailable);
            }
            Ok(CredentialCheck::valid(None, None))
        }
        Monday => {
            let response = send(monday::request(client, monday::IDENTITY_QUERY, json!({}), &BoardAuth::raw(token))).await?;
            check_graphql(response, "/data/me/account/slug", account).await
        }
        Linear => {
            let response = send(linear::request(client, linear::IDENTITY_QUERY, json!({}), &BoardAuth::raw(token))).await?;
            check_graphql(response, "/data/viewer/organization/urlKey", account).await
        }
    }
}

/// Check a saved integration credential with its provider and return its status and any published expiry.
#[tauri::command]
pub async fn integration_check_credential(
    db: State<'_, Db>,
    provider: IntegrationProvider,
    account: String,
) -> Result<CredentialCheck, String> {
    Ok(check(&db, provider, account.trim()).await.unwrap_or_else(Into::into))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_expiration_accepts_the_provider_header_and_iso_timestamps() {
        let iso = github_expiration("2027-02-10T00:00:00Z");
        assert!(iso.is_some());
        assert_eq!(github_expiration("2027-02-10 00:00:00 UTC"), iso);
        assert_eq!(github_expiration("never"), None);
    }

    #[test]
    fn graphql_credentials_and_permissions_are_distinct() {
        let errors = |code| json!({"errors": [{"extensions": {"code": code}}]});
        assert!(matches!(graphql_error(&errors("AUTHENTICATION_ERROR")), Some(CredentialStatus::Rejected)));
        assert!(matches!(graphql_error(&errors("FORBIDDEN")), Some(CredentialStatus::AccessDenied)));
        assert!(matches!(graphql_error(&errors("RATELIMITED")), Some(CredentialStatus::Unavailable)));
        assert!(matches!(status_error(StatusCode::TOO_MANY_REQUESTS), CredentialStatus::Unavailable));
    }
}
