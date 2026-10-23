//! «Publicar» for a repository with no remote: created on GitHub, GitLab, Bitbucket or Azure DevOps
//! with the credential the app already holds for that account, then pushed for the first time with
//! it — the way VS Code publishes to GitHub, for every host this app connects to.
//!
//! Three steps the frontend runs in order (`repoStore::publishToHost`): [`publish_targets`] lists the
//! connected accounts and where each can create a repository (an owner: a GitHub user or
//! organisation, a GitLab namespace, a Bitbucket project, an Azure DevOps project);
//! [`publish_create`] makes the empty repository and answers its clone URL, which the frontend adds
//! as `origin`; [`publish_push`] pushes the branch with the account's credential.
//!
//! **The credential never reaches git's config or the remote URL.** It rides as an
//! `http.<host>.extraHeader` handed to that one process through `GIT_CONFIG_*` variables
//! (`remote::publish_push_with_header`); later pushes use whatever the user's git normally uses.
//! Each host takes HTTP Basic with its own user name for a token: `x-access-token` (GitHub),
//! `oauth2` (GitLab), `x-bitbucket-api-token-auth` / `x-token-auth` (Bitbucket API / access tokens),
//! and an empty one for an Azure DevOps PAT.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::ado_cmd::{ado_connected_orgs, bitbucket_auth, bitbucket_connected_workspaces, connected_hosts, github_token, gitlab_token};
use crate::bitbucket::BitbucketAuth;
use crate::db::Db;

/// Where a repository can be created under one account.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    /// What `publish_create` is given back: a login, a namespace id, a project key or id.
    pub id: String,
    pub label: String,
}

/// One connected account, as the publish dialog offers it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishTarget {
    /// `github` · `gitlab` · `bitbucket` · `azure`.
    pub provider: &'static str,
    /// The host (GitHub, GitLab), the workspace (Bitbucket) or the organisation (Azure DevOps).
    pub account: String,
    pub owners: Vec<Owner>,
    /// The visibilities this host offers, first the default; empty where the owner decides it
    /// (an Azure DevOps repository is as visible as its project).
    pub visibilities: Vec<&'static str>,
    /// Why the owners could not be read — the account is still listed, so the user sees it is there
    /// and why it cannot be used rather than wondering where it went.
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub clone_url: String,
    pub web_url: String,
}

fn client() -> reqwest::Client {
    crate::ado::client()
}

/// A host's answer as an error worth reading: its own `message` when it gave one, the status else.
fn failure(host: &str, status: reqwest::StatusCode, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed.as_ref().and_then(|v| {
        v.get("message")
            .or_else(|| v.pointer("/error/message"))
            .or_else(|| v.get("error"))
            .map(|m| match m {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
    });
    match message {
        Some(message) => format!("{host}: {message}"),
        None => format!("{host} answered {}", status.as_u16()),
    }
}

async fn send(host: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| format!("couldn't reach {host}: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    // Azure DevOps answers a bad PAT with its sign-in page and a 203, not a 401 (see `ado::get_json`).
    if !status.is_success() || status.as_u16() == 203 {
        return Err(failure(host, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from {host}: {e}"))
}

/// A clone URL without the `user@` some hosts put in it — the credential is the header's business.
fn without_userinfo(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/') {
            Some((authority, path)) => format!("{scheme}://{}/{path}", authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority)),
            None => url.to_string(),
        },
        None => url.to_string(),
    }
}

/// A repository name as a URL slug: what Bitbucket keys a repository by.
fn slug(name: &str) -> String {
    let lowered: String = name.trim().to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' }).collect();
    lowered.split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-")
}

// ------------------------------------------------------------------------------------- owners

async fn github_owners(host: &str) -> Result<Vec<Owner>, String> {
    let token = github_token(host)?;
    Ok(crate::github::publish_owners(host, &token).await?.into_iter().map(|login| Owner { id: login.clone(), label: login }).collect())
}

async fn gitlab_owners(host: &str) -> Result<Vec<Owner>, String> {
    let token = gitlab_token(host)?;
    let url = format!("{}/namespaces?per_page=100", crate::gitlab::api_root(host));
    let list = send(host, crate::gitlab::authed(client().get(url), &token)).await?;
    let mut owners: Vec<(bool, Owner)> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|ns| {
            let id = ns.get("id")?.as_i64()?.to_string();
            let label = ns.get("full_path")?.as_str()?.to_string();
            Some((ns.get("kind").and_then(Value::as_str) == Some("user"), Owner { id, label }))
        })
        .collect();
    // The user's own namespace first — where a repository goes when nothing else is chosen.
    owners.sort_by_key(|(is_user, owner)| (!*is_user, owner.label.to_ascii_lowercase()));
    Ok(owners.into_iter().map(|(_, owner)| owner).collect())
}

async fn bitbucket_owners(workspace: &str) -> Result<Vec<Owner>, String> {
    let auth = bitbucket_auth(workspace)?;
    let url = format!("{}/workspaces/{workspace}/projects?pagelen=100", crate::bitbucket::API_ROOT);
    let page = send("Bitbucket", crate::bitbucket::authed(client().get(url), &auth)).await?;
    // No project key: the workspace's default project, the only choice in a workspace with none.
    let mut owners = vec![Owner { id: String::new(), label: workspace.to_string() }];
    owners.extend(page.get("values").and_then(Value::as_array).into_iter().flatten().filter_map(|p| {
        Some(Owner { id: p.get("key")?.as_str()?.to_string(), label: format!("{workspace} / {}", p.get("name")?.as_str()?) })
    }));
    // With projects, the default is the workspace's own choice; listed first only when there are none.
    if owners.len() > 1 {
        owners.remove(0);
    }
    Ok(owners)
}

async fn azure_owners(org: &str) -> Result<Vec<Owner>, String> {
    let pat = crate::secrets::ado_pat(org)?.ok_or_else(|| format!("No Azure DevOps PAT saved for \"{org}\" — connect it in Settings first"))?;
    Ok(crate::ado::list_projects(org, &pat).await?.into_iter().map(|p| Owner { id: p.id, label: format!("{org} / {}", p.name) }).collect())
}

/// Every connected account and where it can create a repository. An account whose owners could not
/// be read is listed with why.
#[tauri::command]
pub async fn publish_targets(db: State<'_, Db>) -> Result<Vec<PublishTarget>, String> {
    let github = connected_hosts(&db, "github_connections")?;
    let gitlab = connected_hosts(&db, "gitlab_connections")?;
    let bitbucket = bitbucket_connected_workspaces(&db)?;
    let azure = ado_connected_orgs(&db)?;
    let mut targets = Vec::new();
    let mut add = |provider: &'static str, account: String, visibilities: Vec<&'static str>, owners: Result<Vec<Owner>, String>| match owners {
        Ok(owners) if owners.is_empty() => targets.push(PublishTarget { provider, account, owners, visibilities, error: Some("NO_OWNERS".into()) }),
        Ok(owners) => targets.push(PublishTarget { provider, account, owners, visibilities, error: None }),
        Err(error) => targets.push(PublishTarget { provider, account, owners: Vec::new(), visibilities, error: Some(error) }),
    };
    for host in github {
        let owners = github_owners(&host).await;
        add("github", host, vec!["private", "public"], owners);
    }
    for host in gitlab {
        let owners = gitlab_owners(&host).await;
        add("gitlab", host, vec!["private", "internal", "public"], owners);
    }
    for workspace in bitbucket {
        let owners = bitbucket_owners(&workspace).await;
        add("bitbucket", workspace, vec!["private", "public"], owners);
    }
    for org in azure {
        let owners = azure_owners(&org).await;
        add("azure", org, Vec::new(), owners);
    }
    Ok(targets)
}

// ------------------------------------------------------------------------------------- create

/// Creates an empty repository `name` under `owner` of an account — no README, nothing a first push
/// would collide with — and answers where to push it.
#[tauri::command]
pub async fn publish_create(provider: String, account: String, owner: String, name: String, visibility: String) -> Result<Created, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name the repository".into());
    }
    let private = visibility != "public";
    match provider.as_str() {
        "github" => {
            let token = github_token(&account)?;
            let login = crate::github::get_authenticated_user(&account, &token).await?;
            let made = crate::github::create_repository(&account, &token, &owner, &login, &name, private).await?;
            Ok(Created { clone_url: made.clone_url, web_url: made.html_url })
        }
        "gitlab" => {
            let token = gitlab_token(&account)?;
            let mut body = json!({ "name": name, "visibility": if ["private", "internal", "public"].contains(&visibility.as_str()) { visibility.as_str() } else { "private" }, "initialize_with_readme": false });
            if let Ok(id) = owner.parse::<i64>() {
                body["namespace_id"] = json!(id);
            }
            let url = format!("{}/projects", crate::gitlab::api_root(&account));
            let made = send(&account, crate::gitlab::authed(client().post(url), &token).json(&body)).await?;
            Ok(Created {
                clone_url: made.get("http_url_to_repo").and_then(Value::as_str).unwrap_or_default().to_string(),
                web_url: made.get("web_url").and_then(Value::as_str).unwrap_or_default().to_string(),
            })
        }
        "bitbucket" => {
            let auth = bitbucket_auth(&account)?;
            let repo = slug(&name);
            if repo.is_empty() {
                return Err("Name the repository with letters or numbers".into());
            }
            let mut body = json!({ "scm": "git", "name": name, "is_private": private });
            if !owner.is_empty() {
                body["project"] = json!({ "key": owner });
            }
            let url = format!("{}/repositories/{account}/{repo}", crate::bitbucket::API_ROOT);
            let made = send("Bitbucket", crate::bitbucket::authed(client().post(url), &auth).json(&body)).await?;
            let clone = made
                .pointer("/links/clone")
                .and_then(Value::as_array)
                .and_then(|links| links.iter().find(|l| l.get("name").and_then(Value::as_str) == Some("https")))
                .and_then(|l| l.get("href").and_then(Value::as_str))
                .map(without_userinfo)
                .unwrap_or_else(|| format!("https://bitbucket.org/{account}/{repo}.git"));
            Ok(Created { clone_url: clone, web_url: made.pointer("/links/html/href").and_then(Value::as_str).unwrap_or_default().to_string() })
        }
        "azure" => {
            let pat = crate::secrets::ado_pat(&account)?.ok_or_else(|| format!("No Azure DevOps PAT saved for \"{account}\""))?;
            let org = crate::ado::normalize_org(&account);
            let url = format!("https://dev.azure.com/{org}/_apis/git/repositories?api-version={}", crate::ado::API_VERSION);
            let request = client().post(url).header("Authorization", crate::ado::auth_header(&pat)).json(&json!({ "name": name, "project": { "id": owner } }));
            let made = send("Azure DevOps", request).await?;
            Ok(Created {
                clone_url: made.get("remoteUrl").and_then(Value::as_str).map(without_userinfo).unwrap_or_default(),
                web_url: made.get("webUrl").and_then(Value::as_str).unwrap_or_default().to_string(),
            })
        }
        other => Err(format!("Unknown host: {other}")),
    }
}

// --------------------------------------------------------------------------------------- push

/// The host part git matches the header against, and the Basic credential, for an account.
pub(crate) fn push_credential(provider: &str, account: &str) -> Result<(String, String), String> {
    let basic = |user: &str, secret: &str| format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{secret}")));
    Ok(match provider {
        "github" => (format!("https://{account}/"), basic("x-access-token", &github_token(account)?)),
        "gitlab" => (format!("https://{account}/"), basic("oauth2", &gitlab_token(account)?)),
        "bitbucket" => {
            let header = match bitbucket_auth(account)? {
                BitbucketAuth::ApiToken { token, .. } => basic("x-bitbucket-api-token-auth", &token),
                BitbucketAuth::AccessToken { token } => basic("x-token-auth", &token),
            };
            ("https://bitbucket.org/".to_string(), header)
        }
        "azure" => {
            let pat = crate::secrets::ado_pat(account)?.ok_or_else(|| format!("No Azure DevOps PAT saved for \"{account}\""))?;
            ("https://dev.azure.com/".to_string(), crate::ado::auth_header(&pat))
        }
        other => return Err(format!("Unknown host: {other}")),
    })
}

/// The first push of the repository just created: the current branch to `origin`, with `-u`, with
/// the account's credential.
#[tauri::command]
pub async fn publish_push(app: AppHandle, repo_path: String, provider: String, account: String) -> Result<(), String> {
    let (prefix, header) = push_credential(&provider, &account)?;
    crate::remote::publish_push_with_header(app, repo_path, prefix, format!("Authorization: {header}")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clone_url_loses_its_user_name() {
        assert_eq!(without_userinfo("https://ana@bitbucket.org/acme/web.git"), "https://bitbucket.org/acme/web.git");
        assert_eq!(without_userinfo("https://acme@dev.azure.com/acme/Shop/_git/web"), "https://dev.azure.com/acme/Shop/_git/web");
        assert_eq!(without_userinfo("https://gitlab.com/ana/web.git"), "https://gitlab.com/ana/web.git");
    }

    #[test]
    fn a_name_becomes_a_slug() {
        assert_eq!(slug("Mi App  Nueva"), "mi-app-nueva");
        assert_eq!(slug("nuxt_app.v2"), "nuxt_app.v2");
        assert_eq!(slug("--"), "");
    }

    #[test]
    fn errors_say_the_host_and_its_message() {
        let status = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(failure("GitLab", status, r#"{"message":{"name":["has already been taken"]}}"#), r#"GitLab: {"name":["has already been taken"]}"#);
        assert_eq!(failure("Bitbucket", status, r#"{"error":{"message":"Repository with this Slug and Owner already exists."}}"#), "Bitbucket: Repository with this Slug and Owner already exists.");
        assert_eq!(failure("Azure DevOps", reqwest::StatusCode::CONFLICT, "<html>"), "Azure DevOps answered 409");
    }
}
