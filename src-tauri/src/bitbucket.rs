//! Bitbucket Cloud as a fourth VCS host, alongside Azure DevOps, GitHub and GitLab.
//!
//! The wire types are the provider-neutral ones in [`crate::ado`] — `PullRequestSummary`,
//! `PrCommentThread`, `PrThreadComment` — so a Bitbucket pull request reaches the sidebar, the review
//! pipeline and the comment panel shaped exactly like everyone else's.
//!
//! Five things about Bitbucket differ enough from the other three to shape this file:
//!
//! - **One host, many workspaces.** Every repository lives at `bitbucket.org/{workspace}/{repo}`
//!   and every API call goes to `api.bitbucket.org/2.0`, so there is no host to key a credential
//!   by. The workspace is the account boundary instead — it is what a repository access token is
//!   scoped to, and what a remote URL names — so connections, the keychain entry and auto-linking
//!   are all per workspace, the same shape as Azure's per-organisation PATs.
//! - **Two kinds of credential, two schemes.** An Atlassian API token (the replacement for the app
//!   passwords Atlassian is retiring) authenticates as Basic with the account's e-mail as the user
//!   name; a repository, project or workspace access token is a Bearer token of its own. See
//!   [`BitbucketAuth`].
//! - **Scopes come in two vocabularies.** API tokens carry the granular `read:pullrequest:bitbucket`
//!   family; access tokens the older `pullrequest:write` family. [`verify_credential`] reports
//!   what is missing in whichever vocabulary the credential in hand speaks.
//! - **A thread is a root comment and its replies.** Comments come back flat, each reply pointing at
//!   its parent; a conversation is reassembled from those pointers, and it is the root comment —
//!   an integer, like every thread id the finding memory stores — that is replied to and resolved.
//! - **The merge strategy is picked per merge**, from the list the destination branch allows. The
//!   pull request itself carries that list, so there is no settings read to make first.

use serde::{Deserialize, Serialize};

use crate::ado::{PrCommentThread, PrThreadComment, PullRequestSummary};

/// The one host Bitbucket Cloud serves repositories from.
pub const BITBUCKET_ORG: &str = "bitbucket.org";

/// Where every REST call goes. Unlike GitHub Enterprise or self-managed GitLab there is no other
/// instance to point at: Bitbucket Data Center is a different product with a different API.
pub(crate) const API_ROOT: &str = "https://api.bitbucket.org/2.0";

/// One client for the process, cloned per call — see `crate::github::client` for why building a
/// rustls client per request cost a full TLS handshake and an unshared connection pool every time.
/// It carries the pull-request clients' shared timeouts (`ado::pr_http_client`).
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(crate::ado::pr_http_client).clone()
}

/// How many pages a "read all of it" loop follows — see `github::MAX_PAGES` for the reasoning.
const MAX_PAGES: u32 = 30;

/// What a 401 means here, said once. Bitbucket answers a wrong e-mail, a wrong token and an expired
/// one with the same bare 401, so the sentence names all three.
pub(crate) const BAD_CREDENTIALS: &str = "Bitbucket rejected the credentials — the token may have \
     expired or been revoked, or (for an API token) the e-mail isn't the one of the Atlassian account \
     that created it. Reconnect it in Settings → Integrations.";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// How a saved connection authenticates.
///
/// Stored whole in the keychain, as JSON, rather than as a bare token with the e-mail beside it in
/// `app_settings` the way Jira keeps its pair: every request here starts from a `LinkedRepo`, which
/// has no database at hand, and a credential that needs two stores to be complete is one that can be
/// half-restored. The e-mail is not secret, but nothing is lost by keeping it with the token it
/// belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BitbucketAuth {
    /// An Atlassian API token: Basic authentication with the account's e-mail as the user name.
    ApiToken { email: String, token: String },
    /// A repository, project or workspace access token: a Bearer token, tied to what it was
    /// created for rather than to a person.
    AccessToken { token: String },
}

impl BitbucketAuth {
    /// The keychain's copy read back. A value that isn't this JSON is read as a bare access token,
    /// so a credential written by hand (or by an older build) still authenticates the way the only
    /// single-field kind does.
    pub fn from_secret(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        match serde_json::from_str::<BitbucketAuth>(trimmed) {
            Ok(auth) => Some(auth).filter(|auth| auth.is_complete()),
            Err(_) if !trimmed.starts_with('{') => Some(BitbucketAuth::AccessToken { token: trimmed.to_string() }),
            Err(_) => None,
        }
    }

    pub fn to_secret(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Whether every field the scheme needs is there — an API token without its e-mail is a 401
    /// waiting to happen, and one that says so before the request is the kinder failure.
    pub fn is_complete(&self) -> bool {
        match self {
            BitbucketAuth::ApiToken { email, token } => !email.trim().is_empty() && !token.trim().is_empty(),
            BitbucketAuth::AccessToken { token } => !token.trim().is_empty(),
        }
    }

    /// The same credential with the whitespace a paste carries taken off both fields.
    pub fn trimmed(&self) -> Self {
        match self {
            BitbucketAuth::ApiToken { email, token } => {
                BitbucketAuth::ApiToken { email: email.trim().to_string(), token: token.trim().to_string() }
            }
            BitbucketAuth::AccessToken { token } => BitbucketAuth::AccessToken { token: token.trim().to_string() },
        }
    }

    fn is_api_token(&self) -> bool {
        matches!(self, BitbucketAuth::ApiToken { .. })
    }
}

/// A request with the credential on it, in whichever scheme it takes.
pub(crate) fn authed(request: reqwest::RequestBuilder, auth: &BitbucketAuth) -> reqwest::RequestBuilder {
    match auth {
        BitbucketAuth::ApiToken { email, token } => request.basic_auth(email, Some(token)),
        BitbucketAuth::AccessToken { token } => request.bearer_auth(token),
    }
}

/// A workspace slug as it is stored and keyed: trimmed and lower-case. Bitbucket issues workspace
/// ids in lower case and routes them case-insensitively, so two spellings are one workspace — and
/// one keychain entry.
pub fn normalize_workspace(workspace: &str) -> String {
    workspace.trim().trim_matches('/').to_ascii_lowercase()
}

/// One path segment of an API address. Slugs are URL-safe already; this is for the stray `/` or `?`
/// a hand-typed one could carry, and for the braces of a `{uuid}`.
fn seg(value: &str) -> String {
    crate::ado::encode_segment(value.trim())
}

/// `/repositories/{workspace}/{repo}` — the prefix of nearly every address below.
pub(crate) fn repo_root(workspace: &str, repo: &str) -> String {
    format!("{API_ROOT}/repositories/{}/{}", seg(workspace), seg(repo))
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DetectedBitbucketRepo {
    pub workspace: String,
    /// The repository *slug* — lower-case, what the API and the URL both use.
    pub repo: String,
}

/// Whether a remote's host is Bitbucket Cloud: the web host, and `altssh.bitbucket.org`, the port-443
/// SSH endpoint Bitbucket documents for networks that block port 22.
fn is_bitbucket_host(host: &str) -> bool {
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    matches!(host.as_str(), "bitbucket.org" | "www.bitbucket.org" | "altssh.bitbucket.org")
}

/// Recognises a Bitbucket Cloud remote in the shapes git actually stores one:
/// `https://bitbucket.org/ws/repo.git` (with or without a user — Bitbucket's clone box puts one in,
/// and a CI checkout leaves `x-token-auth:…@`), `git@bitbucket.org:ws/repo.git`, and
/// `ssh://git@altssh.bitbucket.org:443/ws/repo.git`.
///
/// No allowlist is needed, unlike GitLab's: the host is fixed, and a Bitbucket path is always
/// exactly a workspace and a repository.
pub fn detect_from_remote_url(remote_url: &str) -> Option<DetectedBitbucketRepo> {
    let url = remote_url.trim().trim_end_matches('/');
    let (host, path) = if let Some(at) = url.find("://") {
        let rest = &url[at + 3..];
        let (authority, path) = rest.split_once('/')?;
        (authority, path)
    } else {
        // scp-like: `git@bitbucket.org:ws/repo.git`.
        let (authority, path) = url.split_once(':')?;
        (authority, path)
    };
    if !is_bitbucket_host(host) {
        return None;
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let [workspace, repo] = parts.as_slice() else {
        return None;
    };
    Some(DetectedBitbucketRepo { workspace: normalize_workspace(workspace), repo: repo.to_ascii_lowercase() })
}

/// The repository's home page.
pub fn web_repo_url(workspace: &str, repo: &str) -> String {
    format!("https://{BITBUCKET_ORG}/{workspace}/{repo}")
}

fn web_pull_request_url(workspace: &str, repo: &str, id: i64) -> String {
    format!("https://{BITBUCKET_ORG}/{workspace}/{repo}/pull-requests/{id}")
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// `null` read as the type's default. Bitbucket sends `null` for fields it has nothing for far more
/// often than it leaves them out, and serde's `default` only covers the missing case.
fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// Bitbucket's error envelope is `{"type": "error", "error": {"message": …, "detail": …}}`, where
/// `detail` is usually a sentence and, on a missing scope, an object naming what the call required
/// and what the credential was granted. Both halves are worth reading.
pub(crate) fn message_of(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let error = value.get("error")?;
    let message = error.get("message").and_then(|m| m.as_str()).map(str::trim).filter(|m| !m.is_empty())?;
    let detail = match error.get("detail") {
        Some(serde_json::Value::String(text)) if !text.trim().is_empty() && text.trim() != message => {
            Some(text.trim().to_string())
        }
        Some(serde_json::Value::Object(map)) => {
            let list = |key: &str| {
                map.get(key)
                    .and_then(|v| v.as_array())
                    .map(|items| items.iter().filter_map(|i| i.as_str()).collect::<Vec<_>>().join(", "))
                    .filter(|joined| !joined.is_empty())
            };
            match (list("required"), list("granted")) {
                (Some(required), Some(granted)) => Some(format!("required: {required}; granted: {granted}")),
                (Some(required), None) => Some(format!("required: {required}")),
                _ => None,
            }
        }
        _ => None,
    };
    let text = match detail {
        Some(detail) => format!("{message} ({detail})"),
        None => message.to_string(),
    };
    Some(text.chars().take(400).collect())
}

/// A failure as a sentence. Always starts `Bitbucket returned {status}` — [`is_unanchorable`]
/// relies on it — except for the 401, which gets the one sentence that says what to do about it.
pub(crate) fn describe(status: reqwest::StatusCode, body: &str) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return BAD_CREDENTIALS.to_string();
    }
    match message_of(body) {
        Some(message) => format!("Bitbucket returned {status}: {message}"),
        None => {
            let excerpt: String = body.trim().chars().take(300).collect();
            if excerpt.is_empty() {
                format!("Bitbucket returned {status}")
            } else {
                format!("Bitbucket returned {status}: {excerpt}")
            }
        }
    }
}

/// Whether posting an inline comment failed because Bitbucket won't anchor it there. It answers a
/// line or a path outside the pull request's diff with a 400, which is also its answer to every other
/// malformed comment — so any 400 on an inline post is retried as a general comment naming the line.
/// A body Bitbucket refuses for some other reason fails the second time too, and says why.
pub fn is_unanchorable(error: &str) -> bool {
    error.starts_with("Bitbucket returned 400")
}

async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    request.send().await.map_err(|e| format!("couldn't reach Bitbucket: {e}"))
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str, auth: &BitbucketAuth) -> Result<T, String> {
    let response = send(authed(client().get(url), auth)).await?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("unexpected response from Bitbucket: {e}"))?;
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from Bitbucket: {e}"))
}

/// A plain-text answer — the diff. The endpoint redirects to the repository's own diff address on the
/// same host, which reqwest follows with the credential still on (it only strips it across hosts).
async fn get_text(url: &str, auth: &BitbucketAuth) -> Result<String, String> {
    let response = send(authed(client().get(url), auth)).await?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("unexpected response from Bitbucket: {e}"))?;
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    Ok(body)
}

/// One page of a collection: its values, and the address of the next page when there is one.
#[derive(Deserialize)]
struct Paged<T> {
    #[serde(default = "Vec::new")]
    values: Vec<T>,
    #[serde(default)]
    next: Option<String>,
}

/// Only a `next` on Bitbucket's own API host is followed. The address comes out of a response body,
/// and every request carries the credential — a link anywhere else would send it there.
fn same_api(next: Option<String>) -> Option<String> {
    next.filter(|url| url.starts_with(&format!("{API_ROOT}/")))
}

/// Every page of a collection, in order, from `first` — following the `next` links Bitbucket hands
/// back rather than building page numbers, which its docs ask clients not to do.
async fn get_all_pages<T: for<'de> Deserialize<'de>>(first: &str, auth: &BitbucketAuth) -> Result<Vec<T>, String> {
    let mut all = Vec::new();
    let mut url = Some(first.to_string());
    for _ in 0..MAX_PAGES {
        let Some(current) = url.take() else { break };
        let page: Paged<T> = get_json(&current, auth).await?;
        all.extend(page.values);
        url = same_api(page.next);
    }
    Ok(all)
}

async fn send_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
    auth: &BitbucketAuth,
    body: &serde_json::Value,
) -> Result<T, String> {
    let response = send(authed(request, auth).json(body)).await?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("unexpected response from Bitbucket: {e}"))?;
    if !status.is_success() {
        return Err(describe(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from Bitbucket: {e}"))
}

/// For the calls whose answer is of no interest — only that they succeeded. `ok_conflict` treats a
/// 409 as done: Bitbucket's answer to approving what is already approved or resolving what is
/// already resolved, which is the state that was asked for.
async fn send_ignoring_body(
    request: reqwest::RequestBuilder,
    auth: &BitbucketAuth,
    body: Option<&serde_json::Value>,
    ok_conflict: bool,
) -> Result<(), String> {
    let request = authed(request, auth);
    let request = match body {
        Some(body) => request.json(body),
        None => request,
    };
    let response = send(request).await?;
    let status = response.status();
    if status.is_success() || (ok_conflict && status == reqwest::StatusCode::CONFLICT) {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    Err(describe(status, &text))
}

// ---------------------------------------------------------------------------
// Accounts and credentials
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct RawAccount {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
}

impl RawAccount {
    /// The name comments carry — the display name, which is also what [`get_authenticated_user`]
    /// returns, so the two compare.
    fn name(&self) -> String {
        self.display_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| self.nickname.clone())
            .unwrap_or_default()
    }

    fn is(&self, other: &BitbucketUser) -> bool {
        let same = |a: &Option<String>, b: &Option<String>| match (a, b) {
            (Some(a), Some(b)) => !a.is_empty() && a.eq_ignore_ascii_case(b),
            _ => false,
        };
        same(&self.uuid, &other.uuid) || same(&self.account_id, &other.account_id)
    }
}

/// The account a credential authenticates as.
#[derive(Debug, Clone, Serialize)]
pub struct BitbucketUser {
    pub display_name: String,
    pub uuid: Option<String>,
    pub account_id: Option<String>,
}

/// `GET /user`. An API token answers with its account; an access token usually cannot — it is not
/// a person, and a repository token has no `account` scope to grant — so callers treat a failure here
/// as "unknown", never as a broken connection.
pub async fn get_authenticated_user(auth: &BitbucketAuth) -> Result<BitbucketUser, String> {
    let raw: RawAccount = get_json(&format!("{API_ROOT}/user"), auth).await?;
    Ok(BitbucketUser { display_name: raw.name(), uuid: raw.uuid, account_id: raw.account_id })
}

/// What a connection test found.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CredentialCheck {
    /// Who the credential acts as: the account's display name. Empty when Bitbucket wouldn't say — an
    /// access token is not an account.
    pub user: String,
    /// `x-credential-type`, as Bitbucket labelled the credential (`api_token`, `repo_access_token`…).
    pub credential_type: Option<String>,
    /// The scopes Bitbucket listed for it in `x-oauth-scopes`, when it listed any.
    pub granted: Vec<String>,
    /// Scopes a feature here needs that the credential is known to lack, in its own vocabulary.
    pub missing: Vec<String>,
    /// Needed scopes nothing could confirm without writing something — listed so that "nothing
    /// missing" is never read as "everything checked".
    pub unverified: Vec<String>,
    /// The repository the read probes ran against, when the workspace showed one.
    pub probed_repo: Option<String>,
}

/// The scopes each feature needs, in the granular vocabulary of API tokens: reading who you are,
/// the repository (commit statuses, a pipeline file), pull requests and pipelines — and writing the
/// last two.
const API_TOKEN_SCOPES: [(&str, Access); 6] = [
    ("read:user:bitbucket", Access::User),
    ("read:repository:bitbucket", Access::Repository),
    ("read:pullrequest:bitbucket", Access::PullRequests),
    ("write:pullrequest:bitbucket", Access::Write),
    ("read:pipeline:bitbucket", Access::Pipelines),
    ("write:pipeline:bitbucket", Access::Write),
];

/// The same needs in the older vocabulary access tokens are created with. No `account`: a repository
/// access token cannot have it, and nothing here depends on it.
const ACCESS_TOKEN_SCOPES: [(&str, Access); 5] = [
    ("repository", Access::Repository),
    ("pullrequest", Access::PullRequests),
    ("pullrequest:write", Access::Write),
    ("pipeline", Access::Pipelines),
    ("pipeline:write", Access::Write),
];

/// Which probe answers for a scope.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    User,
    Repository,
    PullRequests,
    Pipelines,
    /// Nothing reads it; only a write would show it, and a test must not write.
    Write,
}

/// Whether `granted` covers `needed`, with the implications the older vocabulary has built in:
/// `X:admin` includes `X:write`, which includes `X`, and reading pull requests reads the repository.
/// The granular vocabulary has none — a `write:` scope there does not read — so it matches exactly.
fn covers(granted: &[String], needed: &str) -> bool {
    let has = |scope: &str| granted.iter().any(|g| g.eq_ignore_ascii_case(scope));
    if has(needed) {
        return true;
    }
    match needed {
        "repository" => has("repository:write") || has("repository:admin") || covers(granted, "pullrequest"),
        "repository:write" => has("repository:admin"),
        "pullrequest" => has("pullrequest:write"),
        "pipeline" => has("pipeline:write") || has("pipeline:variable"),
        "pipeline:write" => has("pipeline:variable"),
        _ => false,
    }
}

/// `x-oauth-scopes` split into its scopes. Bitbucket separates them with commas and spaces.
fn parse_scopes(header: &str) -> Vec<String> {
    header
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// One probe's answer: its status, its body, and the two headers that describe the credential.
struct Probe {
    status: reqwest::StatusCode,
    body: String,
    scopes: Option<String>,
    credential_type: Option<String>,
}

async fn probe(url: &str, auth: &BitbucketAuth) -> Result<Probe, String> {
    let response = send(authed(client().get(url), auth)).await?;
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .filter(|v| !v.trim().is_empty())
    };
    let scopes = header("x-oauth-scopes");
    let credential_type = header("x-credential-type");
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Ok(Probe { status, body, scopes, credential_type })
}

/// What a finished set of probes adds up to. Split out from [`verify_credential`] so the arithmetic
/// — which scopes are missing, in which vocabulary, and which were never checked — is testable
/// without a network. `unprobed` is what no read answered for: the writes always, and the pull
/// request and pipeline reads too when the workspace showed no repository to ask.
fn summarize_check(
    auth_is_api_token: bool,
    granted: Vec<String>,
    refused: &[Access],
    unprobed: &[Access],
) -> (Vec<String>, Vec<String>) {
    // The vocabulary is the credential's own. An API token's header, when Bitbucket sends one, is in
    // the granular names; if it ever came back in the old ones, reading it in the granular list
    // would call every scope missing.
    let granular = auth_is_api_token || granted.iter().any(|g| g.ends_with(":bitbucket"));
    let table: &[(&str, Access)] = if granular { &API_TOKEN_SCOPES } else { &ACCESS_TOKEN_SCOPES };
    let mut missing = Vec::new();
    let mut unverified = Vec::new();
    for (scope, access) in table {
        let known_missing = if !granted.is_empty() {
            !covers(&granted, scope)
        } else {
            refused.contains(access)
        };
        if known_missing {
            missing.push(scope.to_string());
        } else if granted.is_empty() && unprobed.contains(access) {
            unverified.push(scope.to_string());
        }
    }
    (missing, unverified)
}

/// Checks a credential against a workspace before anything is stored — the same "verify, then
/// save" rule the Azure form follows, so a bad token can never overwrite a good one.
///
/// Four reads, each needing one scope: who the credential is, one repository of the workspace, and
/// that repository's pull requests and pipelines. A 403 on any of them is a scope the credential
/// lacks; a 401 is the credential itself, and fails the whole check. When Bitbucket lists the
/// granted scopes (`x-oauth-scopes`, which access tokens get) the list decides, writes included;
/// otherwise the writes are reported as unverified rather than guessed at.
pub async fn verify_credential(workspace: &str, auth: &BitbucketAuth) -> Result<CredentialCheck, String> {
    let workspace = normalize_workspace(workspace);
    if workspace.is_empty() {
        return Err("Enter the workspace this credential is for".to_string());
    }
    if !auth.is_complete() {
        return Err(match auth {
            BitbucketAuth::ApiToken { .. } => "An API token needs the e-mail of its Atlassian account".to_string(),
            BitbucketAuth::AccessToken { .. } => "Paste the access token".to_string(),
        });
    }

    let mut check = CredentialCheck::default();
    let mut granted: Vec<String> = Vec::new();
    let mut refused: Vec<Access> = Vec::new();
    // The two headers describe the credential, not the call, so the first probe that carries them
    // is as good as any.
    fn note(probe: &Probe, check: &mut CredentialCheck, granted: &mut Vec<String>) {
        if granted.is_empty() {
            if let Some(scopes) = &probe.scopes {
                *granted = parse_scopes(scopes);
            }
        }
        if check.credential_type.is_none() {
            check.credential_type = probe.credential_type.clone();
        }
    }

    let user = probe(&format!("{API_ROOT}/user"), auth).await?;
    note(&user, &mut check, &mut granted);
    // Only an API token is judged by this one: `/user` is a person's endpoint, and an access token
    // can be turned away from it however it answers. The workspace probe below decides for those.
    if user.status == reqwest::StatusCode::UNAUTHORIZED && auth.is_api_token() {
        return Err(BAD_CREDENTIALS.to_string());
    }
    if user.status.is_success() {
        check.user = serde_json::from_str::<RawAccount>(&user.body).map(|a| a.name()).unwrap_or_default();
    } else if user.status == reqwest::StatusCode::FORBIDDEN && auth.is_api_token() {
        // An access token is refused here as a matter of course; only a person's token is expected
        // to answer, so only for one is the refusal a missing scope.
        refused.push(Access::User);
    }

    let repos = probe(&format!("{API_ROOT}/repositories/{}?pagelen=1", seg(&workspace)), auth).await?;
    note(&repos, &mut check, &mut granted);
    match repos.status {
        s if s == reqwest::StatusCode::UNAUTHORIZED => return Err(BAD_CREDENTIALS.to_string()),
        s if s == reqwest::StatusCode::NOT_FOUND => {
            return Err(format!("Bitbucket has no workspace \"{workspace}\" that this credential can see"))
        }
        s if s == reqwest::StatusCode::FORBIDDEN => refused.push(Access::Repository),
        s if s.is_success() => {
            #[derive(Deserialize)]
            struct Slug {
                #[serde(default)]
                slug: Option<String>,
            }
            check.probed_repo = serde_json::from_str::<Paged<Slug>>(&repos.body)
                .ok()
                .and_then(|page| page.values.into_iter().find_map(|r| r.slug));
        }
        s => return Err(describe(s, &repos.body)),
    }

    let mut unprobed = vec![Access::Write];
    if let Some(repo) = check.probed_repo.clone() {
        let base = repo_root(&workspace, &repo);
        let prs = probe(&format!("{base}/pullrequests?pagelen=1"), auth).await?;
        note(&prs, &mut check, &mut granted);
        if prs.status == reqwest::StatusCode::FORBIDDEN {
            refused.push(Access::PullRequests);
        }
        let pipelines = probe(&format!("{base}/pipelines?pagelen=1"), auth).await?;
        note(&pipelines, &mut check, &mut granted);
        match pipelines.status {
            s if s == reqwest::StatusCode::FORBIDDEN => refused.push(Access::Pipelines),
            // A repository with Pipelines switched off: says nothing either way about the scope.
            s if !s.is_success() => unprobed.push(Access::Pipelines),
            _ => {}
        }
    } else {
        unprobed.extend([Access::PullRequests, Access::Pipelines]);
    }

    let (missing, unverified) = summarize_check(auth.is_api_token(), granted.clone(), &refused, &unprobed);
    check.granted = granted;
    check.missing = missing;
    check.unverified = unverified;
    Ok(check)
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct RawBranch {
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    /// On the destination only: the strategies this branch lets a pull request be merged with.
    #[serde(default, deserialize_with = "nullable")]
    merge_strategies: Vec<String>,
    #[serde(default)]
    default_merge_strategy: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawCommitRef {
    #[serde(default)]
    hash: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawRepoRef {
    #[serde(default)]
    full_name: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawEndpoint {
    #[serde(default, deserialize_with = "nullable")]
    branch: RawBranch,
    #[serde(default)]
    commit: Option<RawCommitRef>,
    #[serde(default)]
    repository: Option<RawRepoRef>,
}

#[derive(Deserialize, Default)]
struct RawHref {
    #[serde(default)]
    href: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawPrLinks {
    #[serde(default, deserialize_with = "nullable")]
    html: RawHref,
}

#[derive(Deserialize, Default)]
struct RawText {
    #[serde(default)]
    raw: Option<String>,
}

#[derive(Deserialize)]
struct RawParticipant {
    #[serde(default)]
    user: Option<RawAccount>,
    #[serde(default, deserialize_with = "nullable")]
    approved: bool,
    /// `approved` · `changes_requested` · `null`.
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
struct RawPullRequest {
    id: i64,
    #[serde(default, deserialize_with = "nullable")]
    title: String,
    #[serde(default)]
    description: Option<String>,
    /// The description again, as `{raw, markup, html}` — read when `description` is missing.
    #[serde(default)]
    summary: Option<RawText>,
    /// `OPEN` · `MERGED` · `DECLINED` · `SUPERSEDED`.
    #[serde(default, deserialize_with = "nullable")]
    state: String,
    #[serde(default, deserialize_with = "nullable")]
    draft: bool,
    #[serde(default)]
    author: Option<RawAccount>,
    #[serde(default, deserialize_with = "nullable")]
    source: RawEndpoint,
    #[serde(default, deserialize_with = "nullable")]
    destination: RawEndpoint,
    #[serde(default, deserialize_with = "nullable")]
    created_on: String,
    #[serde(default, deserialize_with = "nullable")]
    links: RawPrLinks,
    #[serde(default, deserialize_with = "nullable")]
    participants: Vec<RawParticipant>,
    /// The author's "delete the branch when merged" choice.
    #[serde(default, deserialize_with = "nullable")]
    close_source_branch: bool,
}

/// Collapses Bitbucket's state and its draft flag into the four buckets the sidebar groups by.
/// `SUPERSEDED` — a pull request replaced by another from the same branch — is finished without
/// being merged, which is what the UI calls closed.
fn bucket_status(state: &str, draft: bool) -> String {
    match state {
        "MERGED" => "merged",
        "DECLINED" | "SUPERSEDED" => "closed",
        _ if draft => "draft",
        _ => "open",
    }
    .to_string()
}

fn map_pull_request(workspace: &str, repo: &str, pr: RawPullRequest) -> PullRequestSummary {
    let description = pr
        .description
        .filter(|d| !d.trim().is_empty())
        .or_else(|| pr.summary.and_then(|s| s.raw))
        .unwrap_or_default();
    PullRequestSummary {
        id: pr.id,
        url: pr
            .links
            .html
            .href
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| web_pull_request_url(workspace, repo, pr.id)),
        title: pr.title,
        description,
        status: bucket_status(&pr.state, pr.draft),
        source_branch: pr.source.branch.name,
        target_branch: pr.destination.branch.name,
        author: pr.author.map(|a| a.name()).unwrap_or_default(),
        created_at: pr.created_on,
        provider: "bitbucket".to_string(),
    }
}

/// The `/pullrequests` address for one page of a scope, newest first. `state` repeats for each
/// state wanted, which is how Bitbucket takes "merged or declined" in one query.
fn pull_requests_page_url(workspace: &str, repo: &str, scope: crate::ado::PrListScope, page: u32) -> String {
    let states: &[&str] = match scope {
        crate::ado::PrListScope::Open => &["OPEN"],
        crate::ado::PrListScope::Closed => &["MERGED", "DECLINED", "SUPERSEDED"],
        crate::ado::PrListScope::All => &["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
    };
    let filter = states.iter().map(|s| format!("state={s}")).collect::<Vec<_>>().join("&");
    format!(
        "{}/pullrequests?{filter}&pagelen={}&page={}&sort=-created_on",
        repo_root(workspace, repo),
        crate::ado::PR_PAGE_SIZE,
        page.max(1)
    )
}

/// One page of the repository's pull requests.
pub async fn list_pull_requests_page(
    workspace: &str,
    repo: &str,
    scope: crate::ado::PrListScope,
    page: u32,
    auth: &BitbucketAuth,
) -> Result<crate::ado::PrPage, String> {
    let url = pull_requests_page_url(workspace, repo, scope, page);
    let raw: Paged<RawPullRequest> = get_json(&url, auth).await?;
    let has_more = raw.next.is_some();
    let items = raw
        .values
        .into_iter()
        .map(|pr| map_pull_request(workspace, repo, pr))
        .filter(|pr| scope.admits(&pr.status))
        .collect();
    Ok(crate::ado::PrPage { items, page: page.max(1), has_more })
}

async fn fetch_pull_request(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<RawPullRequest, String> {
    get_json(&format!("{}/pullrequests/{id}", repo_root(workspace, repo)), auth).await
}

/// One pull request by its number — however old, whatever its state.
pub async fn get_pull_request(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<PullRequestSummary, String> {
    Ok(map_pull_request(workspace, repo, fetch_pull_request(workspace, repo, id, auth).await?))
}

/// The pull request's unified diff, read from the host — what a review from nothing but a link runs
/// on. Bitbucket serves it whole and in git's own format, headers included, so unlike GitLab's
/// there is nothing to reassemble.
pub async fn pull_request_diff(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<String, String> {
    let diff = get_text(&format!("{}/pullrequests/{id}/diff", repo_root(workspace, repo)), auth).await?;
    if diff.trim().is_empty() {
        return Err("Bitbucket reported no changes for this pull request".to_string());
    }
    Ok(diff)
}

/// The body that opens a pull request. The branch must already exist on Bitbucket.
fn create_body(title: &str, description: &str, source_branch: &str, target_branch: &str, draft: bool) -> serde_json::Value {
    serde_json::json!({
        "title": title,
        "description": description,
        "source": { "branch": { "name": source_branch } },
        "destination": { "branch": { "name": target_branch } },
        "draft": draft,
    })
}

/// Opens a pull request.
#[allow(clippy::too_many_arguments)]
pub async fn create_pull_request(
    workspace: &str,
    repo: &str,
    title: &str,
    description: &str,
    source_branch: &str,
    target_branch: &str,
    draft: bool,
    auth: &BitbucketAuth,
) -> Result<PullRequestSummary, String> {
    let url = format!("{}/pullrequests", repo_root(workspace, repo));
    let body = create_body(title, description, source_branch, target_branch, draft);
    let raw: RawPullRequest = send_json(client().post(&url), auth, &body).await?;
    Ok(map_pull_request(workspace, repo, raw))
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct RawInline {
    #[serde(default)]
    path: Option<String>,
    /// The line in the old file — set alone on a comment about a deleted line.
    #[serde(default)]
    from: Option<i64>,
    /// The line in the new file; the *last* line of a multi-line comment.
    #[serde(default)]
    to: Option<i64>,
    #[serde(default)]
    start_from: Option<i64>,
    #[serde(default)]
    start_to: Option<i64>,
}

#[derive(Deserialize)]
struct RawParentRef {
    id: i64,
}

#[derive(Deserialize)]
struct RawComment {
    id: i64,
    #[serde(default)]
    content: Option<RawText>,
    #[serde(default)]
    user: Option<RawAccount>,
    #[serde(default, deserialize_with = "nullable")]
    created_on: String,
    #[serde(default, deserialize_with = "nullable")]
    deleted: bool,
    /// A comment still in its author's unpublished review — nobody else can see it yet.
    #[serde(default, deserialize_with = "nullable")]
    pending: bool,
    #[serde(default)]
    parent: Option<RawParentRef>,
    #[serde(default)]
    inline: Option<RawInline>,
    /// Set on a resolved thread's root comment.
    #[serde(default)]
    resolution: Option<serde_json::Value>,
}

/// The root of the thread a comment belongs to: follows `parent` until it runs out. Bounded, so a
/// malformed answer whose parents loop can't hang the listing.
fn root_of(id: i64, parents: &std::collections::HashMap<i64, i64>) -> i64 {
    let mut current = id;
    for _ in 0..64 {
        match parents.get(&current) {
            Some(parent) if *parent != current => current = *parent,
            _ => break,
        }
    }
    current
}

/// Flat comments reassembled into conversations: one per root comment, in the order the roots were
/// written, each with its replies in order.
///
/// A resolved thread is left out — the conversation on the pull request is over, and the review
/// prompt reads this list as what is still open. So is anything deleted, still pending in someone's
/// draft review, or empty. A deleted root with live replies still keeps its thread, under its id.
fn group_threads(comments: Vec<RawComment>) -> Vec<PrCommentThread> {
    let parents: std::collections::HashMap<i64, i64> =
        comments.iter().filter_map(|c| c.parent.as_ref().map(|p| (c.id, p.id))).collect();
    let resolved: std::collections::HashSet<i64> = comments
        .iter()
        .filter(|c| c.parent.is_none() && c.resolution.as_ref().is_some_and(|r| !r.is_null()))
        .map(|c| c.id)
        .collect();
    let inline_of: std::collections::HashMap<i64, &RawInline> =
        comments.iter().filter_map(|c| c.inline.as_ref().map(|i| (c.id, i))).collect();

    let mut order: Vec<i64> = Vec::new();
    let mut threads: std::collections::HashMap<i64, PrCommentThread> = std::collections::HashMap::new();
    for comment in &comments {
        let root = root_of(comment.id, &parents);
        if resolved.contains(&root) || comment.deleted || comment.pending {
            continue;
        }
        let Some(content) = comment
            .content
            .as_ref()
            .and_then(|c| c.raw.as_ref())
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
        else {
            continue;
        };
        let entry = threads.entry(root).or_insert_with(|| {
            order.push(root);
            // The anchor is the root's: a reply to an inline comment carries the same `inline`, but
            // a root that was deleted leaves only its replies to say where it was.
            let inline = inline_of.get(&root).copied().or(comment.inline.as_ref());
            let end = inline.and_then(|i| i.to.or(i.from));
            let start = inline.and_then(|i| i.start_to.or(i.start_from)).or(end);
            PrCommentThread {
                id: root,
                file_path: inline.and_then(|i| i.path.clone()).filter(|p| !p.trim().is_empty()),
                start_line: start,
                end_line: end,
                comments: Vec::new(),
            }
        });
        entry.comments.push(PrThreadComment {
            author: comment.user.as_ref().map(|u| u.name()).unwrap_or_default(),
            content,
            published_date: comment.created_on.clone(),
        });
    }
    order.into_iter().filter_map(|id| threads.remove(&id)).collect()
}

/// The pull request's open conversations — inline comments and general ones alike — so a human
/// reviewer's feedback shows beside CodeFlow's own findings and can be answered the same way.
pub async fn list_pr_comment_threads(
    workspace: &str,
    repo: &str,
    id: i64,
    auth: &BitbucketAuth,
) -> Result<Vec<PrCommentThread>, String> {
    let url = format!("{}/pullrequests/{id}/comments?pagelen=100", repo_root(workspace, repo));
    let comments: Vec<RawComment> = get_all_pages(&url, auth).await?;
    Ok(group_threads(comments))
}

#[derive(Deserialize)]
struct CreatedComment {
    id: i64,
}

/// The body of an inline comment. Bitbucket anchors a range — `start_to` through `to` on the new
/// side — so a multi-line finding lands on all of its lines rather than on the last one only.
fn inline_comment_body(content: &str, file_path: &str, start_line: i64, end_line: i64) -> serde_json::Value {
    let end = end_line.max(start_line).max(1);
    let start = start_line.max(1).min(end);
    let mut inline = serde_json::json!({ "path": file_path.trim_start_matches('/'), "to": end });
    if start < end {
        inline["start_to"] = serde_json::json!(start);
    }
    serde_json::json!({ "content": { "raw": content }, "inline": inline })
}

/// Posts an inline comment anchored to a file and a range of lines; returns its id, which is the
/// thread's.
#[allow(clippy::too_many_arguments)]
pub async fn post_pr_comment_anchored(
    workspace: &str,
    repo: &str,
    id: i64,
    content: &str,
    file_path: &str,
    start_line: i64,
    end_line: i64,
    auth: &BitbucketAuth,
) -> Result<i64, String> {
    let url = format!("{}/pullrequests/{id}/comments", repo_root(workspace, repo));
    let created: CreatedComment =
        send_json(client().post(&url), auth, &inline_comment_body(content, file_path, start_line, end_line)).await?;
    Ok(created.id)
}

/// Posts a general comment — the summary, and the fallback for a finding with no location.
pub async fn post_pr_comment(workspace: &str, repo: &str, id: i64, content: &str, auth: &BitbucketAuth) -> Result<i64, String> {
    let url = format!("{}/pullrequests/{id}/comments", repo_root(workspace, repo));
    let created: CreatedComment = send_json(client().post(&url), auth, &serde_json::json!({ "content": { "raw": content } })).await?;
    Ok(created.id)
}

/// Replies in the conversation `parent_id` belongs to, keeping it one thread.
pub async fn reply_pr_comment(
    workspace: &str,
    repo: &str,
    id: i64,
    parent_id: i64,
    content: &str,
    auth: &BitbucketAuth,
) -> Result<(), String> {
    let url = format!("{}/pullrequests/{id}/comments", repo_root(workspace, repo));
    let body = serde_json::json!({ "content": { "raw": content }, "parent": { "id": parent_id } });
    send_ignoring_body(client().post(&url), auth, Some(&body), false).await
}

/// Marks the conversation rooted at `comment_id` resolved. Bitbucket only resolves a thread from its
/// root (it answers 403 for a reply); a thread already resolved is a 409, which is the state asked
/// for and so counts as done.
pub async fn resolve_comment_thread(
    workspace: &str,
    repo: &str,
    id: i64,
    comment_id: i64,
    auth: &BitbucketAuth,
) -> Result<(), String> {
    let url = format!("{}/pullrequests/{id}/comments/{comment_id}/resolve", repo_root(workspace, repo));
    send_ignoring_body(client().post(&url), auth, None, true).await
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/// What `me` has already decided, read off the pull request's participants.
fn decision_of(participants: &[RawParticipant], me: &BitbucketUser) -> &'static str {
    let Some(mine) = participants.iter().find(|p| p.user.as_ref().is_some_and(|u| u.is(me))) else {
        return "none";
    };
    if mine.approved || mine.state.as_deref() == Some("approved") {
        "approved"
    } else if mine.state.as_deref() == Some("changes_requested") {
        "changes_requested"
    } else {
        "none"
    }
}

/// The decision the signed-in user has recorded, read from the host — they may have approved from
/// the website. `none` when the credential can't say who it is (an access token), which is the same
/// reading the other hosts give an account that hasn't decided.
pub async fn viewer_decision(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<String, String> {
    let pr = fetch_pull_request(workspace, repo, id, auth).await?;
    let Ok(me) = get_authenticated_user(auth).await else {
        return Ok("none".to_string());
    };
    Ok(decision_of(&pr.participants, &me).to_string())
}

/// Records a decision. Bitbucket has both verbs natively, and they exclude each other: approving
/// withdraws a change request first and requesting changes withdraws an approval — each withdrawal
/// best-effort, since "there was nothing to withdraw" is the state wanted anyway. A non-empty body
/// goes on the pull request as a comment, because neither verb carries a message of its own.
pub async fn submit_pr_review(
    workspace: &str,
    repo: &str,
    id: i64,
    event: &str,
    body: &str,
    auth: &BitbucketAuth,
) -> Result<(), String> {
    let base = format!("{}/pullrequests/{id}", repo_root(workspace, repo));
    if event.eq_ignore_ascii_case("APPROVE") {
        if !body.trim().is_empty() {
            post_pr_comment(workspace, repo, id, body, auth).await?;
        }
        let _ = send_ignoring_body(client().delete(format!("{base}/request-changes")), auth, None, false).await;
        return send_ignoring_body(client().post(format!("{base}/approve")), auth, None, true).await;
    }
    let _ = send_ignoring_body(client().delete(format!("{base}/approve")), auth, None, false).await;
    send_ignoring_body(client().post(format!("{base}/request-changes")), auth, None, true).await?;
    if !body.trim().is_empty() {
        post_pr_comment(workspace, repo, id, body, auth).await?;
    }
    Ok(())
}

/// Declines the pull request — Bitbucket's close.
pub async fn decline_pull_request(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<(), String> {
    let url = format!("{}/pullrequests/{id}/decline", repo_root(workspace, repo));
    send_ignoring_body(client().post(&url), auth, None, false).await
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/// A Bitbucket merge strategy in the shared vocabulary of `MergeOptions::methods`. `squash_ff` is
/// Bitbucket's own — a squash that is refused unless the branch fast-forwards — and has no
/// counterpart on the other hosts.
fn method_of(strategy: &str) -> Option<&'static str> {
    Some(match strategy {
        "merge_commit" => "merge",
        "squash" => "squash",
        "fast_forward" => "ff",
        "rebase_fast_forward" => "rebase",
        "rebase_merge" => "rebase_merge",
        "squash_fast_forward" => "squash_ff",
        _ => return None,
    })
}

fn strategy_of(method: &str) -> Option<&'static str> {
    Some(match method {
        "merge" => "merge_commit",
        "squash" => "squash",
        "ff" => "fast_forward",
        "rebase" => "rebase_fast_forward",
        "rebase_merge" => "rebase_merge",
        "squash_ff" => "squash_fast_forward",
        _ => return None,
    })
}

/// The strategies to offer, in Bitbucket's order, and whether that list is the branch's own. A pull
/// request read without them (an older response) is offered the three every repository allows by
/// default, marked as not known.
fn offered_methods(destination: &RawBranch) -> (Vec<String>, bool, Option<String>) {
    let known: Vec<String> = destination
        .merge_strategies
        .iter()
        .filter_map(|s| method_of(s))
        .map(str::to_string)
        .collect();
    let default = destination.default_merge_strategy.as_deref().and_then(method_of).map(str::to_string);
    if known.is_empty() {
        let menu: Vec<String> = ["merge", "squash", "ff"].iter().map(|s| s.to_string()).collect();
        return (menu, false, default.or_else(|| Some("merge".to_string())));
    }
    let default = default.filter(|d| known.contains(d)).or_else(|| known.first().cloned());
    (known, true, default)
}

/// How this pull request can be merged: the strategies its destination branch allows, whether its
/// branch can go, and what Bitbucket says about merging it now — which, short of trying, is only
/// its state, its draft flag and whether its files conflict.
pub async fn merge_options(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<crate::ado::MergeOptions, String> {
    let pr = fetch_pull_request(workspace, repo, id, auth).await?;
    let (methods, methods_known, default_method) = offered_methods(&pr.destination.branch);
    let readiness = if pr.state != "OPEN" {
        "closed"
    } else if pr.draft {
        "draft"
    } else {
        // Best-effort: the endpoint redirects to the file conflicts of the pull request's range, and
        // a failure to read it leaves the dialog saying "unknown" rather than guessing "clean".
        #[derive(Deserialize)]
        struct Conflict {}
        let url = format!("{}/pullrequests/{id}/conflicts?pagelen=1", repo_root(workspace, repo));
        match get_json::<Paged<Conflict>>(&url, auth).await {
            Ok(page) if !page.values.is_empty() => "conflicts",
            _ => "unknown",
        }
    };
    // A branch in a fork belongs to someone else's repository — not this one's to delete.
    let same_repo = match (&pr.source.repository, &pr.destination.repository) {
        (Some(source), Some(destination)) => match (&source.full_name, &destination.full_name) {
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
            _ => true,
        },
        _ => true,
    };
    Ok(crate::ado::MergeOptions {
        methods,
        methods_known,
        default_method,
        squash: None,
        can_delete_source_branch: same_repo,
        delete_source_branch_default: pr.close_source_branch,
        transition_work_items: None,
        readiness: readiness.to_string(),
        readiness_detail: Some(pr.state.to_lowercase()).filter(|s| !s.is_empty()),
    })
}

/// A merge Bitbucket accepted: the pull request as it now is, and whether it is merged yet — a slow
/// merge is handed back as a task still running.
pub struct Merged {
    pub summary: PullRequestSummary,
    pub merged: bool,
}

/// How long a merge Bitbucket moved to the background is waited on before it is reported as
/// requested rather than done.
const MERGE_POLLS: u32 = 10;
const MERGE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

fn merge_body(strategy: &str, close_source_branch: bool) -> serde_json::Value {
    serde_json::json!({
        "type": "pullrequest_merge_parameters",
        "merge_strategy": strategy,
        "close_source_branch": close_source_branch,
    })
}

#[derive(Deserialize)]
struct RawMergeTask {
    #[serde(default)]
    task_status: Option<String>,
    #[serde(default)]
    merge_result: Option<RawPullRequest>,
}

/// Merges the pull request with `method`.
///
/// Bitbucket merges while the request waits and answers with the merged pull request — unless it
/// takes too long, in which case it answers 202 with a task to poll in `Location`. That task is
/// followed for a few seconds; one still running then is a merge requested, not refused. A refusal
/// comes back as [`crate::ado::merge_refusal`], classified from Bitbucket's own sentence.
pub async fn merge_pull_request(
    workspace: &str,
    repo: &str,
    id: i64,
    method: &str,
    close_source_branch: bool,
    auth: &BitbucketAuth,
) -> Result<Merged, String> {
    let strategy = strategy_of(method).ok_or_else(|| format!("unknown merge method: {method}"))?;
    let url = format!("{}/pullrequests/{id}/merge", repo_root(workspace, repo));
    let response = send(authed(client().post(&url), auth).json(&merge_body(strategy, close_source_branch))).await?;
    let status = response.status();
    let location = response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let text = response.text().await.map_err(|e| format!("unexpected response from Bitbucket: {e}"))?;

    if status == reqwest::StatusCode::ACCEPTED {
        if let Some(task) = same_api(location) {
            for _ in 0..MERGE_POLLS {
                tokio::time::sleep(MERGE_POLL_INTERVAL).await;
                let Ok(state) = get_json::<RawMergeTask>(&task, auth).await else { break };
                if state.task_status.as_deref() == Some("SUCCESS") {
                    if let Some(merged) = state.merge_result {
                        return Ok(Merged { merged: merged.state == "MERGED", summary: map_pull_request(workspace, repo, merged) });
                    }
                    break;
                }
            }
        }
        let latest = fetch_pull_request(workspace, repo, id, auth).await?;
        let merged = latest.state == "MERGED";
        return Ok(Merged { summary: map_pull_request(workspace, repo, latest), merged });
    }
    if !status.is_success() {
        let message = message_of(&text).unwrap_or_else(|| format!("Bitbucket returned {status}"));
        return Err(crate::ado::merge_refusal(crate::ado::classify_merge_refusal(status.as_u16(), &message), &message));
    }
    let merged: RawPullRequest = serde_json::from_str(&text).map_err(|e| format!("unexpected response from Bitbucket: {e}"))?;
    let done = merged.state == "MERGED";
    Ok(Merged { summary: map_pull_request(workspace, repo, merged), merged: done })
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawStatus {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// `SUCCESSFUL` · `FAILED` · `INPROGRESS` · `STOPPED`.
    #[serde(default, deserialize_with = "nullable")]
    state: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// A commit status in the Pipelines tab's vocabulary. Anything unrecognised is queued — the reading
/// that asserts no outcome, as `gitlab::pipeline_state` has it.
fn status_state(state: &str) -> &'static str {
    use crate::ci::status;
    match state {
        "SUCCESSFUL" => status::SUCCESS,
        "FAILED" => status::FAILED,
        "INPROGRESS" => status::RUNNING,
        "STOPPED" => status::CANCELLED,
        _ => status::QUEUED,
    }
}

/// The build number a Bitbucket Pipelines status links to — its URL ends in `/results/{n}`, in the
/// current `…/pipelines/results/{n}` form and in the older `…/addon/pipelines/home#!/results/{n}`.
fn pipeline_build_number(url: &str) -> Option<i64> {
    if !url.contains("/pipelines") {
        return None;
    }
    let (_, rest) = url.rsplit_once("/results/")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn status_check(raw: RawStatus) -> crate::ado::PrCheck {
    crate::ado::PrCheck {
        kind: "status".to_string(),
        name: raw
            .name
            .filter(|n| !n.trim().is_empty())
            .or(raw.key)
            .unwrap_or_else(|| "status".to_string()),
        state: status_state(&raw.state).to_string(),
        raw_state: raw.state,
        description: raw.description.filter(|d| !d.trim().is_empty()),
        url: raw.url.filter(|u| !u.trim().is_empty()),
        pipeline_run_id: None,
        // Bitbucket's "passing builds" merge check lives in branch restrictions, which need an admin
        // scope to read; nothing here claims to know.
        required: None,
    }
}

#[derive(Deserialize)]
struct RawPipelineRef {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    build_number: Option<i64>,
}

/// The build numbers of the source branch's recent pipelines, joined to their uuids — the id the
/// Pipelines tab knows a Bitbucket run by. A status names only the number, in its URL.
async fn recent_pipeline_uuids(
    workspace: &str,
    repo: &str,
    branch: &str,
    auth: &BitbucketAuth,
) -> Result<std::collections::HashMap<i64, String>, String> {
    let url = format!(
        "{}/pipelines?target.branch={}&sort=-created_on&pagelen=30",
        repo_root(workspace, repo),
        seg(branch)
    );
    let page: Paged<RawPipelineRef> = get_json(&url, auth).await?;
    Ok(page
        .values
        .into_iter()
        .filter_map(|p| Some((p.build_number?, p.uuid?)))
        .collect())
}

/// The commit statuses of the pull request's head commit — builds reported by Bitbucket Pipelines
/// or by anything else that posts statuses — for the checks chip.
///
/// A status that links to a Pipelines build is joined to its run, so the PR view can open it in the
/// Pipelines tab; that join is one more request and best-effort (a credential without the pipeline
/// scope still gets its checks, only without the jump).
pub async fn pr_checks(workspace: &str, repo: &str, id: i64, auth: &BitbucketAuth) -> Result<crate::ado::PrChecks, String> {
    let pr = fetch_pull_request(workspace, repo, id, auth).await?;
    let head = pr.source.commit.as_ref().and_then(|c| c.hash.clone()).filter(|h| !h.trim().is_empty());
    let Some(head_sha) = head else {
        return Ok(crate::ado::PrChecks { head_sha: None, checks: Vec::new() });
    };
    let url = format!("{}/commit/{}/statuses?pagelen=100", repo_root(workspace, repo), seg(&head_sha));
    let statuses: Vec<RawStatus> = get_all_pages(&url, auth).await?;

    let numbers: Vec<Option<i64>> =
        statuses.iter().map(|s| s.url.as_deref().and_then(pipeline_build_number)).collect();
    let uuids = if numbers.iter().any(Option::is_some) && !pr.source.branch.name.is_empty() {
        recent_pipeline_uuids(workspace, repo, &pr.source.branch.name, auth).await.unwrap_or_default()
    } else {
        Default::default()
    };
    let checks = statuses
        .into_iter()
        .zip(numbers)
        .map(|(status, number)| {
            let mut check = status_check(status);
            check.pipeline_run_id = number.and_then(|n| uuids.get(&n).cloned());
            check
        })
        .collect();
    Ok(crate::ado::PrChecks { head_sha: Some(head_sha), checks })
}

#[cfg(test)]
mod tests {
    //! Fixtures are the response shapes Bitbucket's REST reference documents, trimmed to the fields
    //! read here, with placeholder workspaces and repositories.
    use super::*;

    #[test]
    fn remotes_resolve_to_a_workspace_and_a_repository() {
        for url in [
            "https://bitbucket.org/example-workspace/example-repo.git",
            "https://someone@bitbucket.org/example-workspace/example-repo.git",
            "https://x-token-auth:placeholder@bitbucket.org/example-workspace/example-repo",
            "git@bitbucket.org:example-workspace/example-repo.git",
            "ssh://git@bitbucket.org/example-workspace/example-repo.git",
            "ssh://git@altssh.bitbucket.org:443/example-workspace/example-repo.git",
            "  https://bitbucket.org/Example-Workspace/Example-Repo/  ",
        ] {
            let detected = detect_from_remote_url(url).unwrap_or_else(|| panic!("{url}"));
            assert_eq!(detected.workspace, "example-workspace", "{url}");
            assert_eq!(detected.repo, "example-repo", "{url}");
        }
    }

    #[test]
    fn other_hosts_and_other_path_shapes_are_not_bitbucket() {
        assert!(detect_from_remote_url("https://github.com/example-org/example-repo.git").is_none());
        assert!(detect_from_remote_url("git@gitlab.com:group/sub/project.git").is_none());
        // A look-alike host is not Bitbucket.
        assert!(detect_from_remote_url("https://bitbucket.org.example.test/ws/repo.git").is_none());
        // Bitbucket paths are exactly a workspace and a repository.
        assert!(detect_from_remote_url("https://bitbucket.org/lonely").is_none());
        assert!(detect_from_remote_url("https://bitbucket.org/ws/repo/src/main").is_none());
        assert!(detect_from_remote_url("not a url").is_none());
    }

    #[test]
    fn a_saved_credential_round_trips_and_a_bare_token_reads_as_an_access_token() {
        let api = BitbucketAuth::ApiToken { email: "dev@example.test".into(), token: "placeholder".into() };
        assert_eq!(BitbucketAuth::from_secret(&api.to_secret()), Some(api.clone()));
        assert!(api.to_secret().contains(r#""kind":"api_token""#));

        let access = BitbucketAuth::AccessToken { token: "placeholder".into() };
        assert_eq!(BitbucketAuth::from_secret(&access.to_secret()), Some(access));
        assert_eq!(
            BitbucketAuth::from_secret("  bare-placeholder  "),
            Some(BitbucketAuth::AccessToken { token: "bare-placeholder".into() })
        );
        // An API token without its e-mail cannot authenticate, so it doesn't read as a credential.
        assert_eq!(BitbucketAuth::from_secret(r#"{"kind":"api_token","email":"","token":"x"}"#), None);
        assert_eq!(BitbucketAuth::from_secret("{not json"), None);
        assert_eq!(BitbucketAuth::from_secret("   "), None);
    }

    #[test]
    fn each_kind_of_credential_goes_out_in_its_own_scheme() {
        let api = BitbucketAuth::ApiToken { email: "dev@example.test".into(), token: "placeholder".into() };
        let request = authed(reqwest::Client::new().get(format!("{API_ROOT}/user")), &api).build().unwrap();
        let header = request.headers().get("authorization").unwrap().to_str().unwrap().to_string();
        assert!(header.starts_with("Basic "), "{header}");

        let access = BitbucketAuth::AccessToken { token: "placeholder".into() };
        let request = authed(reqwest::Client::new().get(format!("{API_ROOT}/user")), &access).build().unwrap();
        assert_eq!(request.headers().get("authorization").unwrap(), "Bearer placeholder");
    }

    #[test]
    fn list_urls_ask_for_the_states_of_the_scope_newest_first() {
        let open = pull_requests_page_url("example-workspace", "example-repo", crate::ado::PrListScope::Open, 2);
        assert_eq!(
            open,
            "https://api.bitbucket.org/2.0/repositories/example-workspace/example-repo/pullrequests?state=OPEN&pagelen=50&page=2&sort=-created_on"
        );
        let closed = pull_requests_page_url("ws", "repo", crate::ado::PrListScope::Closed, 0);
        assert!(closed.contains("state=MERGED&state=DECLINED&state=SUPERSEDED"), "{closed}");
        assert!(closed.contains("page=1"), "page 0 is read as the first: {closed}");
        // A stray slash can't reroute the request.
        assert!(repo_root("ws", "a/b").ends_with("/repositories/ws/a%2Fb"));
    }

    fn raw_pr(extra: serde_json::Value) -> RawPullRequest {
        let mut value = serde_json::json!({
            "type": "pullrequest",
            "id": 7,
            "title": "Add login",
            "description": "Adds the login form.",
            "summary": { "raw": "Adds the login form.", "markup": "markdown", "html": "<p>Adds the login form.</p>" },
            "state": "OPEN",
            "draft": false,
            "author": { "display_name": "Ana Example", "uuid": "{11111111-1111-1111-1111-111111111111}", "account_id": "557058:aaaa" },
            "source": {
                "branch": { "name": "feature/login" },
                "commit": { "hash": "abc123def456" },
                "repository": { "full_name": "example-workspace/example-repo" }
            },
            "destination": {
                "branch": { "name": "main", "merge_strategies": ["merge_commit", "squash", "fast_forward"], "default_merge_strategy": "squash" },
                "commit": { "hash": "0123456789ab" },
                "repository": { "full_name": "example-workspace/example-repo" }
            },
            "created_on": "2026-09-01T10:00:00.000000+00:00",
            "links": { "html": { "href": "https://bitbucket.org/example-workspace/example-repo/pull-requests/7" } },
            "participants": [],
            "close_source_branch": true
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, v) in extra {
                base.insert(key.clone(), v.clone());
            }
        }
        serde_json::from_value(value).expect("a pull request")
    }

    #[test]
    fn a_pull_request_maps_onto_the_shared_summary() {
        let pr = map_pull_request("example-workspace", "example-repo", raw_pr(serde_json::json!({})));
        assert_eq!(pr.id, 7);
        assert_eq!(pr.provider, "bitbucket");
        assert_eq!(pr.status, "open");
        assert_eq!(pr.source_branch, "feature/login");
        assert_eq!(pr.target_branch, "main");
        assert_eq!(pr.author, "Ana Example");
        assert_eq!(pr.url, "https://bitbucket.org/example-workspace/example-repo/pull-requests/7");

        // No `description`: the summary's raw text stands in; no link: one is built.
        let sparse = map_pull_request(
            "example-workspace",
            "example-repo",
            raw_pr(serde_json::json!({ "description": null, "links": null, "draft": null, "author": null })),
        );
        assert_eq!(sparse.description, "Adds the login form.");
        assert_eq!(sparse.url, "https://bitbucket.org/example-workspace/example-repo/pull-requests/7");
        assert_eq!(sparse.author, "");
    }

    #[test]
    fn states_collapse_into_the_four_buckets_the_sidebar_groups_by() {
        assert_eq!(bucket_status("OPEN", false), "open");
        assert_eq!(bucket_status("OPEN", true), "draft");
        assert_eq!(bucket_status("MERGED", true), "merged");
        assert_eq!(bucket_status("DECLINED", false), "closed");
        assert_eq!(bucket_status("SUPERSEDED", false), "closed");
    }

    #[test]
    fn a_page_says_whether_another_follows_and_only_same_host_links_are_followed() {
        let page: Paged<RawPullRequest> = serde_json::from_value(serde_json::json!({
            "pagelen": 50, "page": 1,
            "next": "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?page=2",
            "values": []
        }))
        .unwrap();
        assert!(page.next.is_some());
        assert!(same_api(page.next).is_some());
        assert!(same_api(Some("https://example.test/2.0/steal".into())).is_none());
        // The last page carries no `next` at all.
        let last: Paged<RawPullRequest> = serde_json::from_value(serde_json::json!({ "values": [] })).unwrap();
        assert!(last.next.is_none());
    }

    fn comment(value: serde_json::Value) -> RawComment {
        serde_json::from_value(value).expect("a comment")
    }

    #[test]
    fn flat_comments_become_threads_by_their_parents() {
        let comments = vec![
            comment(serde_json::json!({
                "id": 10, "content": { "raw": "Null check?" }, "user": { "display_name": "Ana Example" },
                "created_on": "2026-09-01T10:00:00+00:00",
                "inline": { "path": "src/app.ts", "from": null, "to": 42, "start_to": 40 }
            })),
            comment(serde_json::json!({
                "id": 11, "content": { "raw": "General note" }, "user": { "display_name": "Luis Example" },
                "created_on": "2026-09-01T10:05:00+00:00"
            })),
            comment(serde_json::json!({
                "id": 12, "content": { "raw": "Fixed" }, "user": { "display_name": "Luis Example" },
                "created_on": "2026-09-01T11:00:00+00:00", "parent": { "id": 10 },
                "inline": { "path": "src/app.ts", "to": 42 }
            })),
            // A reply to a reply still belongs to the root's thread.
            comment(serde_json::json!({
                "id": 13, "content": { "raw": "Thanks" }, "user": { "display_name": "Ana Example" },
                "created_on": "2026-09-01T11:10:00+00:00", "parent": { "id": 12 }
            })),
            // Resolved, deleted and pending comments are not part of the open conversation.
            comment(serde_json::json!({
                "id": 20, "content": { "raw": "Done already" }, "created_on": "2026-09-01T09:00:00+00:00",
                "resolution": { "type": "comment_resolution", "created_on": "2026-09-02T09:00:00+00:00" }
            })),
            comment(serde_json::json!({ "id": 21, "content": { "raw": "reply to resolved" }, "parent": { "id": 20 } })),
            comment(serde_json::json!({ "id": 22, "content": { "raw": "gone" }, "deleted": true })),
            comment(serde_json::json!({ "id": 23, "content": { "raw": "draft" }, "pending": true })),
            comment(serde_json::json!({ "id": 24, "content": { "raw": "   " } })),
        ];
        let threads = group_threads(comments);
        assert_eq!(threads.len(), 2, "{threads:?}");

        let inline = &threads[0];
        assert_eq!(inline.id, 10);
        assert_eq!(inline.file_path.as_deref(), Some("src/app.ts"));
        assert_eq!((inline.start_line, inline.end_line), (Some(40), Some(42)));
        let said: Vec<&str> = inline.comments.iter().map(|c| c.content.as_str()).collect();
        assert_eq!(said, vec!["Null check?", "Fixed", "Thanks"]);
        assert_eq!(inline.comments[1].author, "Luis Example");

        let general = &threads[1];
        assert_eq!(general.id, 11);
        assert!(general.file_path.is_none());
        assert!(general.start_line.is_none());
    }

    #[test]
    fn a_comment_on_a_deleted_line_reports_the_old_line() {
        let threads = group_threads(vec![comment(serde_json::json!({
            "id": 5, "content": { "raw": "why remove this?" },
            "inline": { "path": "src/old.rs", "from": 17, "to": null }
        }))]);
        assert_eq!(threads[0].end_line, Some(17));
        assert_eq!(threads[0].start_line, Some(17));
    }

    #[test]
    fn looping_parents_cannot_hang_the_grouping() {
        let parents: std::collections::HashMap<i64, i64> = [(1, 2), (2, 1)].into_iter().collect();
        let _ = root_of(1, &parents);
    }

    #[test]
    fn an_inline_comment_anchors_its_whole_range_on_the_new_side() {
        let body = inline_comment_body("text", "/src/a.rs", 10, 14);
        assert_eq!(
            body,
            serde_json::json!({ "content": { "raw": "text" }, "inline": { "path": "src/a.rs", "to": 14, "start_to": 10 } })
        );
        // One line: no start. A range written backwards is one line, not a negative span.
        let single = inline_comment_body("text", "a.rs", 7, 7);
        assert!(single["inline"].get("start_to").is_none());
        assert_eq!(inline_comment_body("t", "a.rs", 9, 3)["inline"]["to"], 9);
    }

    #[test]
    fn bitbucket_errors_become_sentences() {
        let scope = r#"{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes.","detail":{"granted":["repository"],"required":["pullrequest"]}}}"#;
        assert_eq!(
            describe(reqwest::StatusCode::FORBIDDEN, scope),
            "Bitbucket returned 403 Forbidden: Your credentials lack one or more required privilege scopes. (required: pullrequest; granted: repository)"
        );
        let plain = r#"{"type":"error","error":{"message":"Bad request","detail":"The line isn't part of the diff."}}"#;
        let described = describe(reqwest::StatusCode::BAD_REQUEST, plain);
        assert_eq!(described, "Bitbucket returned 400 Bad Request: Bad request (The line isn't part of the diff.)");
        assert!(is_unanchorable(&described));
        assert!(!is_unanchorable(&describe(reqwest::StatusCode::FORBIDDEN, scope)));
        assert_eq!(describe(reqwest::StatusCode::UNAUTHORIZED, ""), BAD_CREDENTIALS);
        assert_eq!(describe(reqwest::StatusCode::BAD_GATEWAY, "upstream down"), "Bitbucket returned 502 Bad Gateway: upstream down");
    }

    #[test]
    fn the_viewers_decision_is_read_off_their_participant_entry() {
        let me = BitbucketUser {
            display_name: "Ana Example".into(),
            uuid: Some("{11111111-1111-1111-1111-111111111111}".into()),
            account_id: None,
        };
        let participants: Vec<RawParticipant> = serde_json::from_value(serde_json::json!([
            { "user": { "uuid": "{22222222-2222-2222-2222-222222222222}" }, "approved": true, "state": "approved" },
            { "user": { "uuid": "{11111111-1111-1111-1111-111111111111}" }, "approved": false, "state": "changes_requested" }
        ]))
        .unwrap();
        assert_eq!(decision_of(&participants, &me), "changes_requested");

        let approved: Vec<RawParticipant> = serde_json::from_value(serde_json::json!([
            { "user": { "uuid": "{11111111-1111-1111-1111-111111111111}" }, "approved": true, "state": null }
        ]))
        .unwrap();
        assert_eq!(decision_of(&approved, &me), "approved");
        assert_eq!(decision_of(&[], &me), "none");
    }

    #[test]
    fn merge_strategies_map_both_ways_and_the_branch_decides_the_menu() {
        for strategy in ["merge_commit", "squash", "fast_forward", "rebase_fast_forward", "rebase_merge", "squash_fast_forward"] {
            let method = method_of(strategy).expect(strategy);
            assert_eq!(strategy_of(method), Some(strategy));
        }
        assert_eq!(method_of("octopus"), None);
        assert_eq!(strategy_of("merge"), Some("merge_commit"));

        let pr = raw_pr(serde_json::json!({}));
        let (methods, known, default) = offered_methods(&pr.destination.branch);
        assert_eq!(methods, vec!["merge", "squash", "ff"]);
        assert!(known);
        assert_eq!(default.as_deref(), Some("squash"));

        // Nothing said: the default menu, marked as a guess.
        let (methods, known, default) = offered_methods(&RawBranch::default());
        assert_eq!(methods, vec!["merge", "squash", "ff"]);
        assert!(!known);
        assert_eq!(default.as_deref(), Some("merge"));

        assert_eq!(
            merge_body("squash", true),
            serde_json::json!({ "type": "pullrequest_merge_parameters", "merge_strategy": "squash", "close_source_branch": true })
        );
    }

    #[test]
    fn statuses_become_checks_and_a_pipelines_build_is_recognised_by_its_url() {
        let raw: Vec<RawStatus> = serde_json::from_value(serde_json::json!([
            { "key": "{example-key}", "name": "Pipeline #42 for feature/login", "state": "INPROGRESS",
              "url": "https://bitbucket.org/example-workspace/example-repo/pipelines/results/42", "type": "build" },
            { "key": "CI-EXTERNAL", "name": null, "state": "FAILED", "description": "3 tests failed",
              "url": "https://ci.example.test/build/9" },
            { "key": "legacy", "name": "Pipeline #7", "state": "SUCCESSFUL",
              "url": "https://bitbucket.org/example-workspace/example-repo/addon/pipelines/home#!/results/7" },
            { "name": "Deploy", "state": "STOPPED" }
        ]))
        .unwrap();
        let numbers: Vec<Option<i64>> = raw.iter().map(|s| s.url.as_deref().and_then(pipeline_build_number)).collect();
        assert_eq!(numbers, vec![Some(42), None, Some(7), None]);

        let checks: Vec<crate::ado::PrCheck> = raw.into_iter().map(status_check).collect();
        assert_eq!(checks[0].state, crate::ci::status::RUNNING);
        assert_eq!(checks[1].name, "CI-EXTERNAL", "no name: the key stands in");
        assert_eq!(checks[1].state, crate::ci::status::FAILED);
        assert_eq!(checks[1].description.as_deref(), Some("3 tests failed"));
        assert_eq!(checks[2].state, crate::ci::status::SUCCESS);
        assert_eq!(checks[3].state, crate::ci::status::CANCELLED);
        assert_eq!(status_state("SOMETHING_NEW"), crate::ci::status::QUEUED);
    }

    #[test]
    fn older_scope_names_imply_each_other_and_granular_ones_do_not() {
        let granted = vec!["pullrequest:write".to_string(), "pipeline:write".to_string()];
        assert!(covers(&granted, "pullrequest"));
        assert!(covers(&granted, "repository"), "reading pull requests reads the repository");
        assert!(covers(&granted, "pipeline"));
        assert!(!covers(&granted, "repository:write"));

        let granular = vec!["write:pullrequest:bitbucket".to_string()];
        assert!(!covers(&granular, "read:pullrequest:bitbucket"));
        assert_eq!(parse_scopes("pullrequest:write, pipeline repository"), vec!["pullrequest:write", "pipeline", "repository"]);
    }

    #[test]
    fn a_check_names_what_is_missing_in_the_credentials_own_vocabulary() {
        // An access token whose header lists its scopes: everything is decided, writes included.
        let (missing, unverified) =
            summarize_check(false, vec!["repository".into(), "pullrequest:write".into(), "pipeline".into()], &[], &[Access::Write]);
        assert_eq!(missing, vec!["pipeline:write"]);
        assert!(unverified.is_empty());

        // An API token that answered no header: the refused reads are missing, the writes unverified.
        let (missing, unverified) = summarize_check(true, Vec::new(), &[Access::Pipelines], &[Access::Write]);
        assert_eq!(missing, vec!["read:pipeline:bitbucket"]);
        assert_eq!(unverified, vec!["write:pullrequest:bitbucket", "write:pipeline:bitbucket"]);

        // Everything answered and nothing listed: only the writes are left open.
        let (missing, unverified) = summarize_check(false, Vec::new(), &[], &[Access::Write]);
        assert!(missing.is_empty());
        assert_eq!(unverified, vec!["pullrequest:write", "pipeline:write"]);

        // A workspace with no repository to ask: its pull request and pipeline reads were never
        // checked, and saying "nothing missing" about them would be a guess.
        let (missing, unverified) =
            summarize_check(true, Vec::new(), &[], &[Access::Write, Access::PullRequests, Access::Pipelines]);
        assert!(missing.is_empty());
        assert_eq!(
            unverified,
            vec![
                "read:pullrequest:bitbucket",
                "write:pullrequest:bitbucket",
                "read:pipeline:bitbucket",
                "write:pipeline:bitbucket"
            ]
        );
    }

    #[test]
    fn a_pull_request_opens_with_its_branches_and_its_draft_flag() {
        assert_eq!(
            create_body("Add login", "Body", "feature/login", "main", true),
            serde_json::json!({
                "title": "Add login",
                "description": "Body",
                "source": { "branch": { "name": "feature/login" } },
                "destination": { "branch": { "name": "main" } },
                "draft": true
            })
        );
    }
}
