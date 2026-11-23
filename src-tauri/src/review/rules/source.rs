//! What a rule reads, behind two seams: the pull request's files at its source commit
//! ([`FileSource`]) and the network ([`Net`]).
//!
//! Both are traits for the same reason the reference tool passes `read` and `fetch` into every
//! `collect`: a rule's logic is tested offline, against fixtures, and the real implementations are
//! a few lines each. A review with a clone reads git ([`GitSource`]); a review by link reads the
//! host's API ([`HostSource`]). Neither may stop a review: whatever goes wrong comes back as a short
//! reason a rule turns into `not_evaluated`.
//!
//! **Nothing sensitive leaves through here.** A token is only ever a request header; an error is
//! the class of the failure (`sin autorización`, `HTTP 500`), never a response body — the reason
//! ends up in a prompt.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::Value;

/// Per-request ceiling. A rule has its own, larger one on top (its `timeout`).
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a connection attempt may take before it counts as unreachable — a vault name that
/// resolves to a dead address must not cost the whole request timeout per secret.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// Where the Key Vault token is for.
pub const KEY_VAULT_RESOURCE: &str = "https://vault.azure.net";

/// A file of the pull request as of its source commit: `Ok(None)` when it is not there, `Err` with a
/// short reason when that could not be found out.
pub trait FileSource: Send + Sync {
    fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, String>>;
}

/// Why a GET produced nothing usable — the class, never the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Status(u16),
    Unreachable,
    Timeout,
    Unreadable,
}

impl HttpError {
    pub fn reason(&self) -> String {
        match self {
            HttpError::Status(401) => "sin autorización".into(),
            HttpError::Status(403) => "sin permiso".into(),
            HttpError::Status(404) => "no encontrado".into(),
            HttpError::Status(code) => format!("HTTP {code}"),
            HttpError::Unreachable => "no se pudo conectar".into(),
            HttpError::Timeout => format!("sin respuesta en {} s", HTTP_TIMEOUT.as_secs()),
            HttpError::Unreadable => "respuesta ilegible".into(),
        }
    }

    /// A 401/403: the credential, not the network — worth naming the registry or vault for.
    pub fn denied(&self) -> bool {
        matches!(self, HttpError::Status(401 | 403))
    }
}

/// The network as the rules see it.
pub trait Net: Send + Sync {
    /// A GET that answers JSON. `headers` are sent as given (an `Authorization` among them).
    fn get_json<'a>(&'a self, url: &'a str, headers: Vec<(String, String)>) -> BoxFuture<'a, Result<Value, HttpError>>;
    /// A Key Vault token from the user's `az login` session.
    fn vault_token(&self) -> BoxFuture<'_, Result<String, String>>;
    /// The Azure DevOps PAT already stored for an organisation.
    fn ado_pat(&self, org: &str) -> Option<String>;
}

fn client() -> reqwest::Client {
    crate::http_clients::cached("review-rules", || {
        reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).timeout(HTTP_TIMEOUT).user_agent("CodeFlow")
    })
    .unwrap_or_default()
}

fn classify(e: reqwest::Error) -> HttpError {
    if e.is_timeout() {
        HttpError::Timeout
    } else if let Some(status) = e.status() {
        HttpError::Status(status.as_u16())
    } else {
        HttpError::Unreachable
    }
}

/// Documents that change at most daily and are the same for every review: Node's release index and
/// schedule. Kept per day, so a session of twenty reviews downloads them once.
fn cacheable(url: &str) -> bool {
    url.starts_with("https://nodejs.org/") || url.starts_with("https://raw.githubusercontent.com/nodejs/")
}

fn day_cache() -> &'static Mutex<HashMap<String, (chrono::NaiveDate, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (chrono::NaiveDate, Value)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The real network.
pub struct RealNet;

impl Net for RealNet {
    fn get_json<'a>(&'a self, url: &'a str, headers: Vec<(String, String)>) -> BoxFuture<'a, Result<Value, HttpError>> {
        Box::pin(async move {
            let today = chrono::Local::now().date_naive();
            let cache = cacheable(url) && headers.iter().all(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
            if cache {
                if let Some((day, value)) = day_cache().lock().ok().and_then(|m| m.get(url).cloned()) {
                    if day == today {
                        return Ok(value);
                    }
                }
            }
            let mut request = client().get(url).header("Accept", "application/json");
            for (k, v) in &headers {
                request = request.header(k.as_str(), v.as_str());
            }
            let response = request.send().await.map_err(classify)?;
            let status = response.status();
            if !status.is_success() {
                return Err(HttpError::Status(status.as_u16()));
            }
            let value: Value = response.json().await.map_err(|e| if e.is_timeout() { HttpError::Timeout } else { HttpError::Unreadable })?;
            if cache {
                if let Ok(mut map) = day_cache().lock() {
                    map.insert(url.to_string(), (today, value.clone()));
                }
            }
            Ok(value)
        })
    }

    fn vault_token(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            // The CLI's own message can be long and names the account; the facts get the class.
            crate::datasource::entra::cli_token("", KEY_VAULT_RESOURCE).await.map_err(|e| {
                let lower = e.to_lowercase();
                if lower.contains("isn't installed") || lower.contains("path") {
                    "no se encontró 'az' en el PATH".to_string()
                } else if lower.contains("az login") || lower.contains("not logged in") {
                    "sin sesión de az con acceso a Key Vault (az login)".to_string()
                } else {
                    "az no entregó un token de Key Vault".to_string()
                }
            })
        })
    }

    fn ado_pat(&self, org: &str) -> Option<String> {
        crate::secrets::ado_pat(org).ok().flatten().filter(|p| !p.trim().is_empty())
    }
}

// ---------------------------------------------------------------------------
// Files at the source commit
// ---------------------------------------------------------------------------

/// The local clone, at the revision the review reads the PR's side from.
pub struct GitSource {
    pub repo: String,
    pub rev: String,
}

impl FileSource for GitSource {
    fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        let (repo, rev, path) = (self.repo.clone(), self.rev.clone(), path.trim_start_matches('/').to_string());
        Box::pin(async move {
            let read = tokio::task::spawn_blocking(move || crate::git::diff::file_at_ref(&repo, &rev, &path))
                .await
                .map_err(|_| "la lectura de git se interrumpió".to_string())?;
            match read {
                Ok(text) => Ok(Some(text.trim_start_matches('\u{feff}').to_string())),
                // Not in the tree, a directory, or binary: for a rule, all three are "no such text file".
                Err(e) if e.contains("does not exist") || e.contains("not found") || e.contains("is not a file") || e.contains("is binary") => Ok(None),
                Err(_) => Err("no se pudo leer del clon local".to_string()),
            }
        })
    }
}

/// A review by link: the host's API, at the PR's source branch (or head ref, where the host has one).
pub enum HostSource {
    Azure { org: String, project: String, repo: String, branch: String, pat: String },
    GitHub { host: String, owner: String, repo: String, rf: String, token: String },
    GitLab { host: String, project: String, rf: String, token: String },
    Bitbucket { workspace: String, repo: String, rf: String, auth: crate::bitbucket::BitbucketAuth },
}

impl HostSource {
    /// The source for the pull request behind a link. GitHub and GitLab publish a ref for the
    /// request's head — what a PR from a fork needs, since its branch is not in the base repository.
    pub fn for_link(target: &crate::pr_link::PrLinkTarget, credential: &str, source_branch: &str) -> Self {
        use crate::pr_link::PrLinkTarget as T;
        match target {
            T::Azure { org, project, repo, .. } => HostSource::Azure {
                org: org.clone(),
                project: project.clone(),
                repo: repo.clone(),
                branch: source_branch.to_string(),
                pat: credential.to_string(),
            },
            T::GitHub { host, owner, repo, number } => HostSource::GitHub {
                host: host.clone(),
                owner: owner.clone(),
                repo: repo.clone(),
                rf: format!("refs/pull/{number}/head"),
                token: credential.to_string(),
            },
            T::GitLab { host, project, number } => HostSource::GitLab {
                host: host.clone(),
                project: project.clone(),
                rf: format!("refs/merge-requests/{number}/head"),
                token: credential.to_string(),
            },
            T::Bitbucket { workspace, repo, .. } => HostSource::Bitbucket {
                workspace: workspace.clone(),
                repo: repo.clone(),
                rf: source_branch.to_string(),
                auth: crate::bitbucket::BitbucketAuth::from_secret(credential)
                    .unwrap_or_else(|| crate::bitbucket::BitbucketAuth::AccessToken { token: credential.to_string() }),
            },
        }
    }

    async fn fetch(&self, path: &str) -> Result<Option<String>, String> {
        let path = path.trim_start_matches('/');
        let segments = path.split('/').map(crate::ado::encode_segment).collect::<Vec<_>>().join("/");
        let request = match self {
            HostSource::Azure { org, project, repo, branch, pat } => client()
                .get(format!(
                    "https://dev.azure.com/{}/{}/_apis/git/repositories/{}/items",
                    crate::ado::encode_segment(&crate::ado::normalize_org(org)),
                    crate::ado::encode_segment(project),
                    crate::ado::encode_segment(repo)
                ))
                .query(&[
                    ("path", format!("/{path}")),
                    ("versionDescriptor.version", branch.clone()),
                    ("versionDescriptor.versionType", "branch".to_string()),
                    ("includeContent", "true".to_string()),
                    ("api-version", crate::ado::API_VERSION.to_string()),
                ])
                .header("Authorization", crate::ado::auth_header(pat))
                .header("Accept", "application/json"),
            HostSource::GitHub { host, owner, repo, rf, token } => client()
                .get(format!(
                    "{}/repos/{}/{}/contents/{segments}",
                    crate::github::api_root(host),
                    crate::ado::encode_segment(owner),
                    crate::ado::encode_segment(repo)
                ))
                .query(&[("ref", rf.as_str())])
                .header("Authorization", crate::github::bearer(token))
                .header("Accept", "application/vnd.github.raw+json"),
            HostSource::GitLab { host, project, rf, token } => crate::gitlab::authed(
                client()
                    .get(format!(
                        "{}/projects/{}/repository/files/{}/raw",
                        crate::gitlab::api_root(host),
                        crate::gitlab::encode_path(project),
                        crate::gitlab::encode_path(path)
                    ))
                    .query(&[("ref", rf.as_str())]),
                token,
            ),
            HostSource::Bitbucket { workspace, repo, rf, auth } => crate::bitbucket::authed(
                client().get(format!("{}/src/{}/{segments}", crate::bitbucket::repo_root(workspace, repo), crate::ado::encode_segment(rf))),
                auth,
            ),
        };
        let response = request.send().await.map_err(|e| classify(e).reason())?;
        let status = response.status();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(HttpError::Status(status.as_u16()).reason());
        }
        let text = response.text().await.map_err(|_| HttpError::Unreadable.reason())?;
        let text = match self {
            // Azure answers JSON with the file in `content`.
            HostSource::Azure { .. } => serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("content").and_then(Value::as_str).map(str::to_string))
                .ok_or_else(|| HttpError::Unreadable.reason())?,
            _ => text,
        };
        Ok(Some(text.trim_start_matches('\u{feff}').to_string()))
    }
}

impl FileSource for HostSource {
    fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(self.fetch(path))
    }
}

/// Any source, read at most once per path — two rules reading the same `package.json` (and the
/// pre-scan, its manifests) cost one request.
pub struct Cached<S> {
    inner: S,
    seen: Mutex<HashMap<String, Result<Option<String>, String>>>,
}

impl<S: FileSource> Cached<S> {
    pub fn new(inner: S) -> Self {
        Self { inner, seen: Mutex::new(HashMap::new()) }
    }
}

impl<S: FileSource> FileSource for Cached<S> {
    fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            let key = path.trim_start_matches('/').to_string();
            if let Some(hit) = self.seen.lock().ok().and_then(|m| m.get(&key).cloned()) {
                return hit;
            }
            let read = self.inner.read(&key).await;
            if let Ok(mut map) = self.seen.lock() {
                map.insert(key, read.clone());
            }
            read
        })
    }
}

/// Test doubles: a map of files, and a network that answers from a map of URLs.
#[cfg(test)]
pub mod fake {
    use super::*;

    #[derive(Default)]
    pub struct Files(pub HashMap<String, String>);

    impl Files {
        pub fn with(entries: &[(&str, &str)]) -> Self {
            Self(entries.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
        }
    }

    impl FileSource for Files {
        fn read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
            let found = self.0.get(path.trim_start_matches('/')).cloned();
            Box::pin(async move { Ok(found) })
        }
    }

    #[derive(Default)]
    pub struct FakeNet {
        pub responses: HashMap<String, Result<Value, HttpError>>,
        pub token: Option<String>,
        pub pats: HashMap<String, String>,
        /// Every URL asked for, with whether it carried an Authorization header.
        pub asked: Mutex<Vec<(String, bool)>>,
    }

    impl FakeNet {
        pub fn answer(mut self, url: &str, value: Result<Value, HttpError>) -> Self {
            self.responses.insert(url.to_string(), value);
            self
        }
    }

    impl Net for FakeNet {
        fn get_json<'a>(&'a self, url: &'a str, headers: Vec<(String, String)>) -> BoxFuture<'a, Result<Value, HttpError>> {
            let authed = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization"));
            if let Ok(mut asked) = self.asked.lock() {
                asked.push((url.to_string(), authed));
            }
            let answer = self.responses.get(url).cloned().unwrap_or(Err(HttpError::Status(404)));
            Box::pin(async move { answer })
        }

        fn vault_token(&self) -> BoxFuture<'_, Result<String, String>> {
            let token = self.token.clone().ok_or_else(|| "no se encontró 'az' en el PATH".to_string());
            Box::pin(async move { token })
        }

        fn ado_pat(&self, org: &str) -> Option<String> {
            self.pats.get(&org.to_lowercase()).cloned()
        }
    }
}
