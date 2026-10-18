//! The Reviewer, as the Settings pane and the Revisor tab see it. The work is in [`crate::reviewer`];
//! this file reads the settings rows, holds the database lock only while it reads, and owns the
//! credentials boundary — tokens go into the keychain here and never come back out.

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

use crate::db::Db;
use crate::reviewer::analysis::{self, ActiveRun, HistoryEntry, RunRequest, RunSummary};
use crate::reviewer::config::{self, GatePreset, RemoteServer, ReviewerConfig, RulesPreset};
use crate::reviewer::{catalog, detect, install, rules, server, triage, Settings};

/// A connected server, as listed: never its token, only whether there is one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    pub server: RemoteServer,
    pub has_token: bool,
}

/// Everything the Settings pane draws, in one round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerStatus {
    pub install: install::InstallStatus,
    pub server: server::ServerStatus,
    pub config: ReviewerConfig,
    pub servers: Vec<ServerView>,
    pub rules: Option<rules::RulesReport>,
    pub sonarqube_version: String,
    pub scanner_version: String,
    pub java_release: u32,
}

fn settings(db: &Db) -> Result<Settings, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(Settings::load(&conn))
}

fn has_token(id: &str) -> bool {
    crate::reviewer::remote_token(id).is_some_and(|t| !t.is_empty())
}

fn views(servers: Vec<RemoteServer>) -> Vec<ServerView> {
    servers.into_iter().map(|server| ServerView { has_token: has_token(&server.id), server }).collect()
}

#[tauri::command]
pub fn reviewer_status(db: State<Db>) -> Result<ReviewerStatus, String> {
    let settings = settings(&db)?;
    Ok(ReviewerStatus {
        install: install::status(),
        server: server::status(),
        config: settings.config,
        servers: views(settings.servers),
        rules: rules::last_report(),
        sonarqube_version: catalog::SONARQUBE.version.to_string(),
        scanner_version: catalog::SCANNER.version.to_string(),
        java_release: catalog::JAVA_RELEASE,
    })
}

/// Walked on demand: the server's data is a few hundred megabytes of index files.
#[tauri::command]
pub async fn reviewer_disk_used() -> Result<u64, String> {
    tokio::task::spawn_blocking(install::disk_used).await.map_err(|e| e.to_string())
}

static INSTALL_CANCEL: std::sync::Mutex<Option<CancellationToken>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn reviewer_install(app: AppHandle) -> Result<install::InstallStatus, String> {
    let cancel = CancellationToken::new();
    *INSTALL_CANCEL.lock().map_err(|e| e.to_string())? = Some(cancel.clone());
    let result = install::install(Some(&app), cancel).await;
    *INSTALL_CANCEL.lock().map_err(|e| e.to_string())? = None;
    result
}

/// Stops a download where it is; the next one resumes from there.
#[tauri::command]
pub fn reviewer_cancel_install() {
    if let Ok(slot) = INSTALL_CANCEL.lock() {
        if let Some(cancel) = slot.as_ref() {
            cancel.cancel();
        }
    }
}

/// Removes what was downloaded — and with `with_data`, every analysis and the local server's
/// account, which are gone with the data anyway.
#[tauri::command]
pub async fn reviewer_uninstall(with_data: bool) -> Result<install::InstallStatus, String> {
    if analysis::active_run().is_some() {
        return Err("A review is running. Stop it first.".into());
    }
    server::stop().await?;
    if with_data {
        server::credentials::forget();
    }
    tokio::task::spawn_blocking(move || install::uninstall(with_data)).await.map_err(|e| e.to_string())??;
    Ok(install::status())
}

#[tauri::command]
pub async fn reviewer_server_start(app: AppHandle, db: State<'_, Db>) -> Result<server::ServerStatus, String> {
    let settings = settings(&db)?;
    server::start(Some(&app), &settings).await
}

#[tauri::command]
pub async fn reviewer_server_stop() -> Result<(), String> {
    if analysis::active_run().is_some() {
        return Err("A review is running. Stop it first.".into());
    }
    server::stop().await
}

#[tauri::command]
pub fn reviewer_server_log(lines: Option<usize>) -> Vec<String> {
    server::log_tail(lines.unwrap_or(200))
}

#[tauri::command]
pub fn reviewer_save_config(db: State<Db>, config: ReviewerConfig) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        config::save(&conn, &config)?;
    }
    server::set_idle_minutes(config.idle_minutes);
    Ok(())
}

/// Puts the configured rules and gate in place on the running server, now.
#[tauri::command]
pub async fn reviewer_apply_rules(db: State<'_, Db>) -> Result<rules::RulesReport, String> {
    let settings = settings(&db)?;
    let client = server::client().await?;
    rules::apply(&client, &settings.config, &settings.servers).await
}

/// Adds or updates a connection. `token`: `None` keeps the stored one, an empty string removes it.
#[tauri::command]
pub fn reviewer_save_server(db: State<Db>, server: RemoteServer, token: Option<String>) -> Result<Vec<ServerView>, String> {
    let url = crate::reviewer::api::normalize_base(&server.url);
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("The address has to start with https:// (or http://).".into());
    }
    let mut server = RemoteServer { url, ..server };
    server.name = server.name.trim().to_string();
    if server.name.is_empty() {
        server.name = server.url.trim_start_matches("https://").trim_start_matches("http://").to_string();
    }
    if server.id.trim().is_empty() {
        server.id = uuid::Uuid::new_v4().simple().to_string();
    }
    if let Some(token) = token {
        let key = crate::secrets::sonar_server_token_key(&server.id);
        if token.trim().is_empty() {
            crate::secrets::delete_secret(&key)?;
        } else {
            crate::secrets::set_secret(&key, token.trim())?;
        }
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut servers = config::servers(&conn);
    match servers.iter_mut().find(|s| s.id == server.id) {
        Some(existing) => *existing = server,
        None => servers.push(server),
    }
    config::save_servers(&conn, &servers)?;
    Ok(views(servers))
}

#[tauri::command]
pub fn reviewer_delete_server(db: State<Db>, id: String) -> Result<Vec<ServerView>, String> {
    let _ = crate::secrets::delete_secret(&crate::secrets::sonar_server_token_key(&id));
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut servers = config::servers(&conn);
    servers.retain(|s| s.id != id);
    config::save_servers(&conn, &servers)?;
    // Rules or a gate that came from it fall back to CodeFlow's own, rather than to an import that
    // can no longer run.
    let mut current = config::load(&conn);
    let mut changed = false;
    if matches!(&current.rules, RulesPreset::Server { server_id, .. } if *server_id == id) {
        current.rules = RulesPreset::Strict;
        changed = true;
    }
    if matches!(&current.gate, GatePreset::Server { server_id, .. } if *server_id == id) {
        current.gate = GatePreset::Strict;
        changed = true;
    }
    if changed {
        config::save(&conn, &current)?;
    }
    Ok(views(servers))
}

/// What a connected server offers — its profiles and gates — which also proves the token works.
#[tauri::command]
pub async fn reviewer_server_catalog(db: State<'_, Db>, id: String) -> Result<rules::RemoteCatalog, String> {
    let settings = settings(&db)?;
    let server = settings.servers.iter().find(|s| s.id == id).ok_or("That connection no longer exists.")?;
    rules::remote_catalog(server).await
}

#[tauri::command]
pub fn reviewer_detect(repo_path: String, project_name: String, project_key: Option<String>) -> detect::Suggestion {
    detect::suggest(std::path::Path::new(&repo_path), &project_name, project_key.as_deref().unwrap_or_default())
}

#[tauri::command]
pub fn reviewer_run(app: AppHandle, db: State<Db>, request: RunRequest) -> Result<String, String> {
    let settings = settings(&db)?;
    analysis::start(app, settings, request)
}

#[tauri::command]
pub fn reviewer_cancel_run(run_id: String) -> bool {
    analysis::cancel(&run_id)
}

#[tauri::command]
pub fn reviewer_active_run() -> Option<ActiveRun> {
    analysis::active_run()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub project_key: String,
    pub summary: Option<RunSummary>,
    pub history: Vec<HistoryEntry>,
}

/// A project's last review and its history, for the tab to show without running anything.
#[tauri::command]
pub fn reviewer_last_run(repo_path: String, project_name: String, project_key: Option<String>) -> LastRun {
    let key = detect::project_key(std::path::Path::new(&repo_path), &project_name, project_key.as_deref().unwrap_or_default());
    LastRun { summary: analysis::last(&key), history: analysis::history(&key), project_key: key }
}

// ------------------------------------------------------------------------------------ the report

/// A client of the local server, starting it first when it went idle — a rule or a triage is asked
/// for from a report, long after the review that made it.
async fn local_client(app: &AppHandle, db: &State<'_, Db>) -> Result<crate::reviewer::api::SonarClient, String> {
    let settings = settings(db)?;
    server::start(Some(app), &settings).await?;
    server::signed_in().await.map(|(client, _)| client)
}

/// The rule behind an issue or a hotspot, as SonarQube explains it.
#[tauri::command]
pub async fn reviewer_rule(app: AppHandle, db: State<'_, Db>, key: String) -> Result<triage::RuleInfo, String> {
    let client = local_client(&app, &db).await?;
    triage::rule(&client, &key).await
}

/// Marks an issue a false positive or accepted, on the server and in the kept report.
#[tauri::command]
pub async fn reviewer_issue_decide(
    app: AppHandle,
    db: State<'_, Db>,
    project_key: String,
    issue_key: String,
    verdict: triage::IssueVerdict,
    comment: String,
) -> Result<(), String> {
    let client = local_client(&app, &db).await?;
    triage::decide_issue(&client, &issue_key, verdict, &comment).await?;
    triage::update_last(&project_key, |summary| {
        let before = summary.issues.len();
        summary.issues.retain(|issue| issue.key != issue_key);
        if summary.issues.len() < before {
            summary.issues_total = summary.issues_total.saturating_sub(1);
        }
    })
}

/// Reviews a hotspot (`SAFE`, `FIXED`, `ACKNOWLEDGED`) or sends it back (`None`).
#[tauri::command]
pub async fn reviewer_hotspot_review(
    app: AppHandle,
    db: State<'_, Db>,
    project_key: String,
    hotspot_key: String,
    resolution: Option<String>,
    comment: String,
) -> Result<(), String> {
    let client = local_client(&app, &db).await?;
    triage::review_hotspot(&client, &hotspot_key, resolution.as_deref(), &comment).await?;
    triage::update_last(&project_key, |summary| {
        if let Some(hotspot) = summary.hotspots.iter_mut().find(|h| h.key == hotspot_key) {
            hotspot.status = if resolution.is_some() { "REVIEWED".into() } else { "TO_REVIEW".into() };
            hotspot.resolution = resolution.clone();
        }
    })
}

/// The lines changed against `base` (empty: the default branch) — what "new code only" filters by.
#[tauri::command]
pub async fn reviewer_changed_lines(repo_path: String, base: String) -> Result<triage::ChangedLines, String> {
    tokio::task::spawn_blocking(move || triage::changed_lines(&repo_path, &base)).await.map_err(|e| e.to_string())?
}
