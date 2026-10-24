//! «Salud de dependencias», as the Revisor's «Dependencias» section and its settings pane see it.
//! The work is in [`crate::deps`]; this file loads projects and settings, holds the database lock
//! only while it reads, and turns progress into events.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::deps::analysis::{self, RepoReport};
use crate::deps::config::DepsConfig;
use crate::deps::osv::{self, Advisory};
use crate::deps::update::{self, Outcome, Plan, UpdateItem};
use crate::deps::{alerts, manifests, now_ms};

fn config(db: &Db) -> Result<DepsConfig, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(DepsConfig::load(&conn))
}

fn project(db: &State<'_, Db>, id: &str) -> Result<crate::db::models::Project, String> {
    crate::commands::ado_cmd::load_project(db, id)
}

/// The settings, defaults filled in. Written by the frontend through `set_setting`, so every window
/// hears `settings:changed`.
#[tauri::command]
pub fn deps_config_get(db: State<Db>) -> Result<DepsConfig, String> {
    config(&db)
}

/// Repositories being analysed right now — a second «Analizar» on the same one is refused.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    project_id: &'a str,
    phase: &'a str,
    done: usize,
    total: usize,
}

/// Analyses one repository; emits `deps:progress` while it works and saves the report.
#[tauri::command]
pub async fn deps_analyze(app: AppHandle, db: State<'_, Db>, project_id: String) -> Result<RepoReport, String> {
    let project = project(&db, &project_id)?;
    let config = config(&db)?;
    if !running().lock().map_err(|e| e.to_string())?.insert(project_id.clone()) {
        return Err("busy".into());
    }
    let report = analysis::analyze(&project_id, std::path::Path::new(&project.local_path), &config, |phase, done, total| {
        let _ = app.emit("deps:progress", Progress { project_id: &project_id, phase, done, total });
    })
    .await;
    if let Ok(mut set) = running().lock() {
        set.remove(&project_id);
    }
    // What the user has now seen counts as seen: the daily check must not announce it tomorrow.
    let mut seen = alerts::load();
    seen.absorb(&project_id, advisory_keys(&report));
    alerts::save(&seen);
    analysis::save(&report)?;
    Ok(report)
}

fn advisory_keys(report: &RepoReport) -> Vec<String> {
    let direct = report.rows.iter().flat_map(|r| r.advisories.iter().map(move |a| alerts::key(&report.project_id, r.ecosystem.id(), &r.name, &a.id)));
    let transitive = report.transitive.iter().flat_map(|t| t.advisories.iter().map(move |a| alerts::key(&report.project_id, t.ecosystem.id(), &t.name, &a.id)));
    direct.chain(transitive).collect()
}

/// The last saved report of each repository that has one.
#[tauri::command]
pub async fn deps_reports(project_ids: Vec<String>) -> Result<Vec<RepoReport>, String> {
    tokio::task::spawn_blocking(move || project_ids.iter().filter_map(|id| analysis::load(id)).collect())
        .await
        .map_err(|e| e.to_string())
}

/// What a batch update would do in one repository, without touching it.
#[tauri::command]
pub async fn deps_update_plan(db: State<'_, Db>, project_id: String, items: Vec<UpdateItem>) -> Result<Plan, String> {
    let project = project(&db, &project_id)?;
    let lockfiles = analysis::load(&project_id).map(|r| r.lockfiles).unwrap_or_default();
    tokio::task::spawn_blocking(move || update::plan(&project.local_path, &items, &lockfiles))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLine<'a> {
    project_id: &'a str,
    line: String,
}

/// Runs the confirmed update in one repository: branch, edits, lockfile, commit, push. The pull
/// request and its review are opened by the frontend through the existing host commands, so the
/// PR lands in the same lists and the same review queue as any other.
#[tauri::command]
pub async fn deps_update_apply(app: AppHandle, db: State<'_, Db>, project_id: String, items: Vec<UpdateItem>, branch: String) -> Result<Outcome, String> {
    let project = project(&db, &project_id)?;
    if !branch.starts_with("deps/update-") || branch.contains("..") || branch.contains(char::is_whitespace) {
        return Err(format!("unexpected branch name: {branch}"));
    }
    let lockfiles = analysis::load(&project_id).map(|r| r.lockfiles).unwrap_or_else(|| {
        let root = std::path::PathBuf::from(&project.local_path);
        manifests::scan(&root).lockfiles
    });
    let emitter = app.clone();
    let id = project_id.clone();
    update::apply(app, &project.local_path, &items, &lockfiles, &branch, move |line| {
        let _ = emitter.emit("deps:update", UpdateLine { project_id: &id, line });
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAdvisory {
    pub project_id: String,
    pub project_name: String,
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub advisory: Advisory,
}

/// The daily check (user, 2026-10-23: «Aviso cuando sale una vulnerabilidad nueva en algo que
/// usas»). `None` when it is not due, switched off, or battery saving is at Fuerte or above — the
/// check is background work nobody asked for just now. With `force`, runs whatever the clock says.
#[tauri::command]
pub async fn deps_check_alerts(db: State<'_, Db>, project_ids: Vec<String>, force: bool) -> Result<Option<Vec<NewAdvisory>>, String> {
    let config = config(&db)?;
    if !config.alerts || crate::power::saving(2) {
        return Ok(None);
    }
    let mut seen = alerts::load();
    if !force && !alerts::due(&seen, now_ms()) {
        return Ok(None);
    }
    let projects: Vec<_> = project_ids.iter().filter_map(|id| project(&db, id).ok()).collect();
    let scans = tokio::task::spawn_blocking({
        let paths: Vec<(String, String, String)> = projects.iter().map(|p| (p.id.clone(), p.name.clone(), p.local_path.clone())).collect();
        move || paths.into_iter().map(|(id, name, path)| (id, name, manifests::scan(std::path::Path::new(&path)))).collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let all: Vec<osv::Query> = scans.iter().flat_map(|(_, _, scan)| analysis::queries(scan)).collect();
    // Offline: try again at the next tick rather than burning the day.
    let vulns = osv::check(&all).await?;
    let mut fresh = Vec::new();
    for (id, name, scan) in &scans {
        let mut per_key: HashMap<String, (osv::Query, Advisory)> = HashMap::new();
        for q in analysis::queries(scan) {
            for a in vulns.get(&q).into_iter().flatten() {
                per_key.insert(alerts::key(id, q.ecosystem.id(), &q.name, &a.id), (q.clone(), a.clone()));
            }
        }
        for key in seen.absorb(id, per_key.keys().cloned().collect::<Vec<_>>()) {
            if let Some((q, a)) = per_key.remove(&key) {
                fresh.push(NewAdvisory {
                    project_id: id.clone(),
                    project_name: name.clone(),
                    ecosystem: q.ecosystem.id().into(),
                    name: q.name,
                    version: q.version,
                    advisory: a,
                });
            }
        }
    }
    seen.last_check = now_ms();
    alerts::save(&seen);
    Ok(Some(fresh))
}
