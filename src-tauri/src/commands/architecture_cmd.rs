//! Arquitectura's commands: the AI (one read-only run per question, in the section's own working
//! folder where its skills live — see `crate::architecture`), generation from sources, the
//! repository preview and the cloud reads. Answers come back as text; the app parses the
//! `arch-patch` / `arch-doc` / `pregunta` blocks out of them.
//!
//! The cloud commands run only when the person clicks the authorization that names them — one click
//! per read; nothing here reads a cloud on its own.

use tauri::{AppHandle, State};

use crate::ai;
use crate::ai_runs;
use crate::architecture::cloud::{self, CloudContexts, CloudScope, CloudSnapshot, Provider};
use crate::architecture::sources::{self, ArchSource, RepoScan};
use crate::architecture::{self, Action, Turn};
use crate::commands::claude_cmd::AiTask;
use crate::db::Db;

/// What a lens's answer gets of the re-read sources.
const LENS_SOURCES_BUDGET: usize = 30_000;
/// What generation gets of every source together.
const GENERATE_BUDGET: usize = 90_000;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn architecture_ai(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: Option<String>,
    action: String,
    question: String,
    document: String,
    context: String,
    history: Vec<Turn>,
    language: String,
    run_id: Option<String>,
    sources: Option<Vec<ArchSource>>,
) -> Result<String, String> {
    let action = Action::parse(&action).ok_or_else(|| format!("Unknown architecture action: {action}"))?;
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::commands::claude_cmd::load_ai_config_in(&conn, AiTask::Architecture, workspace_id.as_deref())?
    };
    let english = language == "en";
    let cwd = architecture::workdir()?;
    let cwd = cwd.to_string_lossy().to_string();
    let system = architecture::system_prompt(action, english, &config.provider);
    // The document's sources, read again so the answer stands on them — never the cloud, which
    // would need a fresh authorization. One that cannot be read is said, not fatal.
    let grounding = match sources.as_deref() {
        Some(list) if !list.is_empty() => {
            let (read, notes) = sources::read_lenient(list).await;
            let mut text = if read.is_empty() { String::new() } else { sources::assemble(&read, LENS_SOURCES_BUDGET) };
            for note in notes {
                text.push_str(&format!("(could not read again: {note})\n"));
            }
            text
        }
        _ => String::new(),
    };
    let data = architecture::payload(&document, &context, &grounding, &history, english);
    let ask = if question.trim().is_empty() {
        if english { "Do what the instructions ask with the document below." } else { "Haz lo que piden las instrucciones con el documento de abajo." }.to_string()
    } else {
        question
    };
    ai_runs::scoped(app, run_id, async {
        ai::architecture_turn(&*config.engine, &config.binary, &config.model, &config.provider, &cwd, &system, &ask, &data).await
    })
    .await
}

/// A new document from sources (`document` None → an `arch-doc` answer), or changes to the open one
/// from them (`document` Some → an `arch-patch` answer).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn architecture_generate(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: Option<String>,
    sources: Vec<ArchSource>,
    focus: String,
    document: Option<String>,
    language: String,
    run_id: Option<String>,
) -> Result<String, String> {
    if sources.is_empty() {
        return Err("Pick at least one source".into());
    }
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::commands::claude_cmd::load_ai_config_in(&conn, AiTask::Architecture, workspace_id.as_deref())?
    };
    let english = language == "en";
    let action = if document.is_some() { Action::Update } else { Action::Generate };
    let read = sources::read_all(&sources, true).await?;
    let data = architecture::generate_payload(&sources::assemble(&read, GENERATE_BUDGET), document.as_deref(), &focus, english);
    let cwd = architecture::workdir()?;
    let cwd = cwd.to_string_lossy().to_string();
    let system = architecture::system_prompt(action, english, &config.provider);
    let ask = if english { "Do what the instructions ask with the sources below." } else { "Haz lo que piden las instrucciones con las fuentes de abajo." };
    ai_runs::scoped(app, run_id, async {
        ai::architecture_turn(&*config.engine, &config.binary, &config.model, &config.provider, &cwd, &system, ask, &data).await
    })
    .await
}

/// A repository's facts — compose, Kubernetes, Helm, Terraform, Bicep, OpenAPI, ADRs, dependencies,
/// `.env.example` key names — for the dialog to show before anything is generated.
#[tauri::command]
pub async fn architecture_scan_repo(path: String) -> Result<RepoScan, String> {
    tokio::task::spawn_blocking(move || sources::scan_repo(std::path::Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// How the repositories connect, read from their code without a model: what each one is, the routes and
/// queues linking them (each `verified`, `inferred`, or left `unresolved`) and the infrastructure they
/// share. The same map generation starts from, for the dialog to show before anything is generated.
#[tauri::command]
pub async fn architecture_scan_system(paths: Vec<String>) -> Result<crate::architecture::system::SystemMap, String> {
    tokio::task::spawn_blocking(move || crate::architecture::system::scan_system(&paths)).await.map_err(|e| e.to_string())?
}

/// A Mermaid sequence of what happens from one repository outward, over the same map. `None` when it
/// calls nothing the map could place.
#[tauri::command]
pub async fn architecture_sequence_from(paths: Vec<String>, start: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        crate::architecture::system::scan_system(&paths).map(|map| crate::architecture::system::sequence_from(&map, &start))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The provider CLI's accounts / profiles / projects. A read of its own, authorized by its own click.
#[tauri::command]
pub async fn architecture_cloud_contexts(provider: String) -> Result<CloudContexts, String> {
    Ok(cloud::contexts(Provider::parse(&provider)?).await)
}

/// Resource groups (Azure), regions (AWS), nothing (Google Cloud: the project is the scope).
#[tauri::command]
pub async fn architecture_cloud_scopes(provider: String, context: String) -> Result<Vec<CloudScope>, String> {
    cloud::scopes(Provider::parse(&provider)?, &context).await
}

/// The command lines [`architecture_cloud_read`] would run, for the authorization card.
#[tauri::command]
pub fn architecture_cloud_plan(provider: String, context: String, scope: Option<String>) -> Result<Vec<String>, String> {
    Ok(cloud::plan(Provider::parse(&provider)?, &context, scope.as_deref()))
}

/// Runs the planned read-only listing, sanitized. Only called from the authorization's own button.
#[tauri::command]
pub async fn architecture_cloud_read(provider: String, context: String, scope: Option<String>) -> Result<CloudSnapshot, String> {
    cloud::read(Provider::parse(&provider)?, &context, scope.as_deref()).await
}
