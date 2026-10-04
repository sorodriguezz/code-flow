//! A small client for SonarQube's Web API — the local server CodeFlow runs and the servers a user
//! connects to for their rules (a company's SonarQube Server, or SonarQube Cloud).
//!
//! Tokens go in an `Authorization: Bearer` header, which every supported version accepts; the local
//! server's first sign-in uses the admin password with Basic auth, once, to mint that token.

use std::time::Duration;

use serde_json::Value;

#[derive(Clone)]
pub enum Auth {
    None,
    Bearer(String),
    Basic { user: String, password: String },
}

/// A failed call, with the HTTP status when there was one so callers can tell "wrong token" (401)
/// from "this server doesn't have that" (404) from "nobody answered".
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<ApiError> for String {
    fn from(error: ApiError) -> Self {
        error.message
    }
}

#[derive(Clone)]
pub struct SonarClient {
    base: String,
    auth: Auth,
    http: reqwest::Client,
}

impl SonarClient {
    /// `verify_tls` off accepts any certificate — for a company server behind a private CA that the
    /// operating system doesn't know. The system's own roots are always added, which is what covers
    /// most private CAs without that switch.
    pub fn new(base: &str, auth: Auth, verify_tls: bool) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("CodeFlow/", env!("CARGO_PKG_VERSION")))
            .danger_accept_invalid_certs(!verify_tls);
        if verify_tls {
            for certificate in rustls_native_certs::load_native_certs().certs {
                if let Ok(certificate) = reqwest::Certificate::from_der(certificate.as_ref()) {
                    builder = builder.add_root_certificate(certificate);
                }
            }
        }
        let http = builder.build().map_err(|e| format!("Couldn't create the HTTP client: {e}"))?;
        Ok(Self { base: normalize_base(base), auth, http })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base, path.trim_start_matches('/'))
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.auth {
            Auth::None => request,
            Auth::Bearer(token) => request.bearer_auth(token),
            Auth::Basic { user, password } => request.basic_auth(user, Some(password)),
        }
    }

    pub async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let response = self
            .authorize(self.http.get(self.url(path)).query(query))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        json_of(response).await
    }

    /// For the few endpoints that answer in something other than JSON — a profile backup is XML.
    pub async fn get_text(&self, path: &str, query: &[(&str, String)]) -> Result<String, ApiError> {
        let response = self
            .authorize(self.http.get(self.url(path)).query(query))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| ApiError { status: Some(status.as_u16()), message: e.to_string() })?;
        if !status.is_success() {
            return Err(error_of(status.as_u16(), &text));
        }
        Ok(text)
    }

    /// A POST with form parameters, which is how SonarQube's write endpoints take their input.
    /// `Value::Null` for the many that answer 204.
    pub async fn post(&self, path: &str, form: &[(&str, String)]) -> Result<Value, ApiError> {
        let response = self
            .authorize(self.http.post(self.url(path)).form(form))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        json_of(response).await
    }

    pub async fn post_multipart(&self, path: &str, form: reqwest::multipart::Form) -> Result<Value, ApiError> {
        let response = self
            .authorize(self.http.post(self.url(path)).multipart(form))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        json_of(response).await
    }

    fn unreachable(&self, error: reqwest::Error) -> ApiError {
        let reason = if error.is_timeout() {
            "it took too long to answer".to_string()
        } else if error.is_connect() {
            "nothing is answering at that address".to_string()
        } else {
            error.to_string()
        };
        ApiError { status: None, message: format!("Couldn't reach {}: {reason}.", self.base) }
    }

    /// Every page of a paginated search, up to `limit` items. SonarQube caps a page at 500 and a
    /// search at 10,000 results.
    pub async fn get_all(
        &self,
        path: &str,
        query: &[(&str, String)],
        items_key: &str,
        limit: usize,
    ) -> Result<Vec<Value>, ApiError> {
        let mut items = Vec::new();
        let mut page = 1usize;
        loop {
            let mut params: Vec<(&str, String)> = query.to_vec();
            params.push(("ps", "500".to_string()));
            params.push(("p", page.to_string()));
            let value = self.get(path, &params).await?;
            let batch = value.get(items_key).and_then(Value::as_array).cloned().unwrap_or_default();
            let fetched = batch.len();
            items.extend(batch);
            let total = value
                .get("paging")
                .and_then(|p| p.get("total"))
                .and_then(Value::as_u64)
                .or_else(|| value.get("total").and_then(Value::as_u64))
                .unwrap_or(items.len() as u64) as usize;
            if fetched == 0 || items.len() >= total.min(limit) || page * 500 >= 10_000 {
                break;
            }
            page += 1;
        }
        items.truncate(limit);
        Ok(items)
    }
}

/// `https://sonar.example.com/` and `https://sonar.example.com` are the same server; a pasted URL of
/// a page inside it (`…/projects`) is not something to guess about, so only the trailing slash goes.
pub fn normalize_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

async fn json_of(response: reqwest::Response) -> Result<Value, ApiError> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| ApiError { status: Some(status.as_u16()), message: e.to_string() })?;
    if !status.is_success() {
        return Err(error_of(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| ApiError {
        status: Some(status.as_u16()),
        message: format!("The server answered something that isn't JSON: {e}"),
    })
}

/// SonarQube's errors arrive as `{"errors":[{"msg":"…"}]}`; anything else is described by its status.
fn error_of(status: u16, body: &str) -> ApiError {
    let messages: Vec<String> = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("errors").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| e.get("msg").and_then(Value::as_str).map(str::to_string))
        .collect();
    let message = if !messages.is_empty() {
        messages.join(" ")
    } else {
        match status {
            401 => "The server refused the credentials (401). Check the token.".to_string(),
            403 => "The token doesn't have permission for this (403).".to_string(),
            404 => "The server doesn't have that (404).".to_string(),
            _ => format!("The server answered {status}."),
        }
    };
    ApiError { status: Some(status), message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sonar_error_bodies_become_their_message() {
        let error = error_of(400, r#"{"errors":[{"msg":"Value of parameter 'x' is invalid"}]}"#);
        assert_eq!(error.status, Some(400));
        assert_eq!(error.message, "Value of parameter 'x' is invalid");
        assert!(error_of(401, "").message.contains("401"));
        assert!(error_of(502, "<html>").message.contains("502"));
    }

    #[test]
    fn the_base_loses_only_its_trailing_slash() {
        assert_eq!(normalize_base(" https://sonar.example.com/ "), "https://sonar.example.com");
        assert_eq!(normalize_base("https://sonar.example.com/sonar/"), "https://sonar.example.com/sonar");
    }
}
