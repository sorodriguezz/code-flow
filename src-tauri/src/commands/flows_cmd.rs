//! The Flujos workspace's command surface.
//!
//! Thin, like [`super::diagrams_cmd`]: every call locks the connection, forwards to
//! [`crate::db::flow_queries`] and maps the error. The one thing it adds is the gate: **every
//! document that reaches a row goes through `flows::spec::parse` first**, so a row never holds a
//! flow the canvas could not have drawn — an unknown node, a port that does not exist, a cycle no
//! loop node closes. The canvas prevents all of those as you draw; this is the check that does not
//! trust it to.
//!
//! "Not found" comes back as `None` and a stale save as `conflict: true`, not as errors — neither is
//! the user doing something wrong, so neither should put a red toast on screen.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::db::flow_queries::{self, FlowFolderRow, FlowMeta, FlowRow, FlowSaved, FlowsTree};
use crate::db::flow_run_queries::{
    self, FlowCredential, FlowRunNodeRow, FlowRunRow, FlowStateEntry, FlowVariable,
};
use crate::db::version_queries::{self, DocVersion};
use crate::db::Db;
use crate::flows::expr::ExprWorker;
use crate::flows::run::RunMode;
use crate::flows::runs::{self, NodeDataView};
use crate::flows::{builder, catalog, params, share, spec, triggers};

/// The longest flow or folder name. A name is a row in a tree, not a paragraph.
const MAX_NAME: usize = 200;

fn clean_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("A flow needs a name".into());
    }
    Ok(trimmed.chars().take(MAX_NAME).collect())
}

/// A catalogue entry as the frontend receives it: the shape, and the parameters the form draws.
#[derive(Serialize)]
pub struct CatalogEntry {
    #[serde(flatten)]
    descriptor: catalog::NodeDescriptor,
    params: &'static [params::ParamSpec],
}

/// Every node a flow can hold. Static, so the frontend asks once per session.
/// The declarative connectors (Slack, GitHub, Trello, Linear, Supabase… — `flows/connectors/`) the "Conector" node calls —
/// the definitions as shipped, which the node's form draws from.
#[tauri::command]
pub fn flows_connectors() -> &'static [crate::flows::connectors::Connector] {
    crate::flows::connectors::all()
}

#[tauri::command]
pub fn flows_node_catalog() -> Vec<CatalogEntry> {
    catalog::CATALOG
        .iter()
        .map(|descriptor| CatalogEntry { descriptor: *descriptor, params: params::for_type(descriptor.type_id) })
        .collect()
}

#[tauri::command]
pub fn flows_load_tree(db: State<Db>, workspace_id: String) -> Result<FlowsTree, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// One flow with its document — the only call here that returns `spec`.
#[tauri::command]
pub fn flows_get_flow(db: State<Db>, id: String) -> Result<Option<FlowRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::get_flow(&conn, &id).map_err(|e| e.to_string())
}

/// `spec` is optional: a new flow starts empty unless the caller brings a document (an import, a
/// template, a paste of a whole flow).
#[tauri::command]
pub fn flows_create_flow(
    db: State<Db>,
    workspace_id: String,
    folder_id: Option<String>,
    name: String,
    spec: Option<String>,
) -> Result<FlowMeta, String> {
    let name = clean_name(&name)?;
    // A flow started here is the user's; one that arrives with a document (an import, a template) is
    // not trusted until it is reviewed.
    let trusted = spec.is_none();
    let text = spec.unwrap_or_else(spec::empty_text);
    let derived = spec::derive(&spec::parse(&text)?);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::create_flow(&conn, &workspace_id, folder_id.as_deref(), &name, &text, &derived, trusted)
        .map_err(|e| e.to_string())
}

/// The autosave path. Validated before the lock is taken: parsing a large flow is not something to
/// hold the whole database's connection for.
/// `keep_trust: false` is the save of a change the user did not write — an accepted AI proposal:
/// a trusted flow whose commands change that way goes back to "not reviewed". Absent means `true`.
#[tauri::command]
pub fn flows_save_flow(
    app: AppHandle,
    db: State<Db>,
    id: String,
    spec: String,
    expected_version: Option<i64>,
    keep_trust: Option<bool>,
) -> Result<FlowSaved, String> {
    let derived = spec::derive(&spec::parse(&spec)?);
    let mut saved = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::save_spec(&conn, &id, &spec, &derived, expected_version, keep_trust.unwrap_or(true))
            .map_err(|e| e.to_string())?
    };
    // An active flow listens with what is on the canvas: re-armed from the saved document, and
    // switched off — with the reason — when that document can no longer be armed.
    if !saved.conflict && saved.meta.as_ref().is_some_and(|meta| meta.active) {
        if let Err(error) = triggers::arm(&app, &id) {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            saved.meta = flow_queries::set_active(&conn, &id, false).map_err(|e| e.to_string())?;
            triggers::disarm(&app, &id);
            saved.trigger_error = Some(error);
        }
    }
    Ok(saved)
}

/// A flow the model wrote, checked — for the editor to show as changes to accept.
#[derive(Serialize)]
pub struct FlowBuilt {
    /// The whole document, as a save would write it.
    spec: String,
    summary: String,
}

/// Writes or changes a flow from a description — see `flows::builder`. **Nothing is saved**: the
/// editor draws the answer as changes over the canvas, and an accepted one is saved without
/// carrying trust. Routed on the "flow_builder" row; `run_id` puts it in the AI run log, where its
/// Stop works.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn flows_build_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: String,
    flow_name: String,
    prompt: String,
    current: Option<String>,
    language: String,
    notes: HashMap<String, String>,
    run_id: Option<String>,
) -> Result<FlowBuilt, String> {
    if prompt.trim().is_empty() {
        return Err("Write what the flow should do".into());
    }
    let current = match current.as_deref().filter(|text| !text.trim().is_empty()) {
        Some(text) => Some(spec::parse(text)?),
        None => None,
    };
    let (config, credentials) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = crate::commands::claude_cmd::load_ai_config_in(
            &conn,
            crate::commands::claude_cmd::AiTask::FlowBuilder,
            Some(&workspace_id),
        )?;
        let credentials: Vec<(String, String, String)> = flow_run_queries::list_credentials(&conn, &workspace_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|credential| (credential.id, credential.name, credential.kind))
            .collect();
        (config, credentials)
    };
    let request = builder::BuildRequest {
        prompt: &prompt,
        current: current.as_ref(),
        flow_name: &flow_name,
        language: &language,
        notes: &notes,
        credentials: &credentials,
    };
    let data = builder::request_text(&request);
    let schema = builder::answer_schema().to_string();
    let built = |proposal: builder::Proposal| FlowBuilt {
        spec: serde_json::to_string(&proposal.spec).unwrap_or_default(),
        summary: proposal.summary,
    };
    crate::ai_runs::scoped(app, run_id, async {
        let first = crate::ai::build_flow(&*config.engine, &config.binary, &config.model, builder::SYSTEM_PROMPT, builder::ASK, &data, &schema)
            .await?;
        let problems = match builder::proposal(&first, &request) {
            Ok(proposal) => return Ok(built(proposal)),
            Err(problems) => problems,
        };
        // Once more, with what was wrong read back; then what is still wrong is the answer.
        let again = format!("{data}\n{}", builder::retry_text(&first, &problems));
        let second = crate::ai::build_flow(&*config.engine, &config.binary, &config.model, builder::SYSTEM_PROMPT, builder::ASK, &again, &schema)
            .await?;
        builder::proposal(&second, &request)
            .map(built)
            .map_err(|problems| format!("The model's flow could not be used: {}", problems.join("; ")))
    })
    .await
}

/// Switches a flow on (its automatic triggers armed) or off. Switching on is refused, with the
/// reason, when a trigger cannot be armed — `no-automatic-trigger` when there is none to arm.
#[tauri::command]
pub fn flows_set_active(app: AppHandle, db: State<Db>, id: String, active: bool) -> Result<Option<FlowMeta>, String> {
    if !active {
        triggers::disarm(&app, &id);
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        return flow_queries::set_active(&conn, &id, false).map_err(|e| e.to_string());
    }
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::get_flow(&conn, &id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?
    };
    if !row.meta.trusted {
        return Err("untrusted".into());
    }
    let parsed = spec::parse(&row.spec)?;
    triggers::validate(&app, &id, &parsed)?;
    let meta = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::set_active(&conn, &id, true).map_err(|e| e.to_string())?
    };
    if let Err(error) = triggers::arm(&app, &id) {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::set_active(&conn, &id, false).map_err(|e| e.to_string())?;
        return Err(error);
    }
    Ok(meta)
}

/// What every active flow of a workspace listens for — the Programación view.
#[tauri::command]
pub fn flows_trigger_status(workspace_id: Option<String>) -> Vec<triggers::ArmedFlowView> {
    triggers::status(workspace_id.as_deref())
}

/// The names of the flows that stop listening when CodeFlow quits — the quit question.
#[tauri::command]
pub fn flows_armed_names() -> Vec<String> {
    triggers::armed_names()
}

/// Where webhooks are served: `http://127.0.0.1:<port>/hooks/`.
#[tauri::command]
pub fn flows_webhook_base() -> String {
    triggers::webhook::base_url()
}

#[tauri::command]
pub fn flows_rename_flow(db: State<Db>, id: String, name: String) -> Result<Option<FlowMeta>, String> {
    let name = clean_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::rename_flow(&conn, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_set_description(
    db: State<Db>,
    id: String,
    description: String,
) -> Result<Option<FlowMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::set_description(&conn, &id, description.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_move_flow(
    db: State<Db>,
    id: String,
    folder_id: Option<String>,
) -> Result<Option<FlowMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::move_flow(&conn, &id, folder_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_set_scope(app: AppHandle, db: State<Db>, id: String, global: bool) -> Result<Option<FlowMeta>, String> {
    let meta = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::set_scope(&conn, &id, global).map_err(|e| e.to_string())?
    };
    // Which workspace's error triggers and status lists it belongs to just changed.
    if meta.as_ref().is_some_and(|m| m.active) {
        let _ = triggers::arm(&app, &id);
    }
    Ok(meta)
}

#[tauri::command]
pub fn flows_move_to_workspace(
    app: AppHandle,
    db: State<Db>,
    id: String,
    workspace_id: String,
) -> Result<Option<FlowMeta>, String> {
    let meta = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::move_to_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())?
    };
    if meta.as_ref().is_some_and(|m| m.active) {
        let _ = triggers::arm(&app, &id);
    }
    Ok(meta)
}

#[tauri::command]
pub fn flows_duplicate_flow(db: State<Db>, id: String, name: String) -> Result<Option<FlowMeta>, String> {
    let name = clean_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::duplicate_flow(&conn, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_delete_flow(app: AppHandle, db: State<Db>, id: String) -> Result<(), String> {
    triggers::disarm(&app, &id);
    let runs = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let runs = flow_run_queries::run_ids_of_flow(&conn, &id).map_err(|e| e.to_string())?;
        flow_queries::delete_flow(&conn, &id).map_err(|e| e.to_string())?;
        runs
    };
    // After the rows: a run folder with no row is swept at the next launch anyway, while a row with
    // no folder would open as an execution whose every node is empty.
    for run in &runs {
        runs::cancel(run);
    }
    runs::forget_files(&runs);
    // A shared flow stops syncing here; the remote copy is its host's to end.
    let shared = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::flow_share_queries::get(&conn, &id).map_err(|e| e.to_string())?.is_some()
    };
    if shared {
        share::leave(&db, &id)?;
    }
    Ok(())
}

// ---------- sharing (the user's own Supabase project — see `flows::share`) ----------

/// Every flow shared on this machine, in whatever workspace it is filed — the poller's list.
#[tauri::command]
pub fn flows_shares(db: State<Db>) -> Result<Vec<crate::db::flow_share_queries::FlowShareRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::db::flow_share_queries::list(&conn).map_err(|e| e.to_string())
}

/// Starts sharing a flow on one project; answers the invitation material (the token).
#[tauri::command]
pub async fn flows_share(db: State<'_, Db>, url: String, flow_id: String) -> Result<crate::supabase::SharedCollection, String> {
    share::share(&db, &url, &flow_id).await
}

/// Accepts an invitation into `workspace_id` — the flow arrives not reviewed and inactive.
#[tauri::command]
pub async fn flows_join_shared(
    db: State<'_, Db>,
    url: String,
    token: String,
    workspace_id: String,
    folder_id: Option<String>,
) -> Result<FlowMeta, String> {
    share::join(&db, &url, &token, &workspace_id, folder_id.as_deref()).await
}

/// What every window does after a round: an applied version re-arms an active flow — or switches
/// it off, with the reason, when it can no longer be armed (commands someone else wrote are not
/// trusted) — and is announced, so an open editor reloads it.
fn after_round(app: &AppHandle, db: &State<'_, Db>, flow_id: &str, round: &share::Round) {
    if round.applied && round.meta.as_ref().is_some_and(|meta| meta.active) {
        if let Err(error) = triggers::arm(app, flow_id) {
            triggers::disarm(app, flow_id);
            if let Ok(conn) = db.0.lock() {
                let _ = flow_queries::set_active(&conn, flow_id, false);
            }
            let _ = tauri::Emitter::emit(app, "flows:shared-disarmed", json!({"flowId": flow_id, "error": error}));
        }
    }
    if round.applied || round.state == "conflict" {
        let _ = tauri::Emitter::emit(app, "flows:shared", json!({"flowId": flow_id, "applied": round.applied, "state": round.state}));
    }
}

/// The poller's call for one shared flow: a full round only when something moved.
#[tauri::command]
pub async fn flows_share_tick(app: AppHandle, db: State<'_, Db>, flow_id: String) -> Result<Option<share::Round>, String> {
    let round = share::tick(&db, &flow_id).await?;
    if let Some(round) = &round {
        after_round(&app, &db, &flow_id, round);
    }
    Ok(round)
}

/// A full round now — "sync now".
#[tauri::command]
pub async fn flows_share_sync(app: AppHandle, db: State<'_, Db>, flow_id: String) -> Result<share::Round, String> {
    let round = share::sync(&db, &flow_id).await?;
    after_round(&app, &db, &flow_id, &round);
    Ok(round)
}

/// The user's answer to a conflict: keep this machine's version (sent now) or take theirs.
#[tauri::command]
pub async fn flows_share_resolve(app: AppHandle, db: State<'_, Db>, flow_id: String, keep_mine: bool) -> Result<share::Round, String> {
    let round = share::resolve(&db, &flow_id, keep_mine).await?;
    after_round(&app, &db, &flow_id, &round);
    Ok(round)
}

/// Host only: a new invitation code, which is how access is taken back.
#[tauri::command]
pub async fn flows_share_rotate(db: State<'_, Db>, flow_id: String) -> Result<String, String> {
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::flow_share_queries::get(&conn, &flow_id).map_err(|e| e.to_string())?.ok_or("This flow is not shared")?
    };
    if row.role != "owner" {
        return Err("Only the host of a shared flow can issue a new code".into());
    }
    crate::supabase::rotate(row.project_url, flow_id).await
}

/// Stops syncing a flow here. The flow stays.
#[tauri::command]
pub fn flows_share_leave(db: State<Db>, flow_id: String) -> Result<(), String> {
    share::leave(&db, &flow_id)
}

#[tauri::command]
pub fn flows_create_folder(db: State<Db>, workspace_id: String, name: String) -> Result<FlowFolderRow, String> {
    let name = clean_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::create_folder(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_rename_folder(db: State<Db>, id: String, name: String) -> Result<Option<FlowFolderRow>, String> {
    let name = clean_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::rename_folder(&conn, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_delete_folder(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::delete_folder(&conn, &id).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- version history ----------

#[tauri::command]
pub fn flows_list_versions(db: State<Db>, id: String) -> Result<Vec<DocVersion>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::list_versions(&conn, flow_queries::VERSION_KIND, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_version_content(db: State<Db>, version_id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::version_content(&conn, &version_id).map_err(|e| e.to_string())
}

/// Drops one of a flow's versions — see `VersionHistoryModal`, which prunes the list from here.
#[tauri::command]
pub fn flows_delete_version(db: State<Db>, version_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::delete_version(&conn, flow_queries::VERSION_KIND, &version_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Drops every version of one flow. The flow itself is untouched.
#[tauri::command]
pub fn flows_clear_versions(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::delete_versions(&conn, flow_queries::VERSION_KIND, &id).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- running ----------

/// Starts a run: the whole flow, up to a node, or one node on its last input. Returns the run's row
/// at once; what happens next arrives as `flows:run`, `flows:node` and `flows:log`.
///
/// `no-trigger` (nothing starts this flow, or nothing that reaches the node) comes back as the error
/// text itself, a code the frontend turns into a sentence.
#[tauri::command]
pub fn flows_run(app: AppHandle, flow_id: String, mode: RunMode, trigger: Option<String>, input: Option<serde_json::Value>) -> Result<FlowRunRow, String> {
    runs::start(&app, &flow_id, mode, trigger, input)
}

/// The main window's answer to a run's question (`flows::bridge`). `false` when nobody waits for it
/// any more — the run ended, or the question timed out.
#[tauri::command]
pub fn flows_bridge_answer(id: String, ok: bool, value: Option<serde_json::Value>, error: Option<String>) -> bool {
    let result = if ok { Ok(value.unwrap_or(serde_json::Value::Null)) } else { Err(error.unwrap_or_else(|| "The window could not do it".to_string())) };
    crate::flows::bridge::answer(&id, result)
}

/// The form a run would ask for before it starts — see `runs::run_form`.
#[tauri::command]
pub fn flows_run_form(app: AppHandle, flow_id: String, mode: RunMode, trigger: Option<String>) -> Result<Option<runs::RunForm>, String> {
    runs::run_form(&app, &flow_id, &mode, trigger.as_deref())
}

#[tauri::command]
pub fn flows_cancel_run(app: AppHandle, run_id: String) -> bool {
    // A run waiting since before a restart has no task to cancel; it is ended from its records.
    runs::cancel(&run_id) || crate::flows::waits::cancel_parked(&app, &run_id).unwrap_or(false)
}

/// Writes a flow to a JSON file — its document and the names of the credentials it uses, never a
/// secret. See `flows::transfer`.
#[tauri::command]
pub fn flows_export_flow(db: State<Db>, id: String, path: String) -> Result<(), String> {
    let file = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let row = flow_queries::get_flow(&conn, &id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?;
        let parsed = spec::parse(&row.spec)?;
        crate::flows::transfer::export(&conn, &row.meta.name, &row.meta.description, &parsed).map_err(|e| e.to_string())?
    };
    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Could not write {path}: {e}"))
}

/// What an import made, and what it had to change to fit this workspace.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowImported {
    pub meta: FlowMeta,
    pub notes: crate::flows::transfer::ImportNotes,
}

/// Reads a flow file into a new flow of the workspace — untrusted, inactive, credentials matched by
/// name. `fallback_name` names it when the file does not (a bare document).
#[tauri::command]
pub fn flows_import_flow(
    db: State<Db>,
    workspace_id: String,
    folder_id: Option<String>,
    path: String,
    fallback_name: String,
) -> Result<FlowImported, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (document, name, description, notes) = crate::flows::transfer::import(&conn, &workspace_id, &text)?;
    let name = clean_name(if name.trim().is_empty() { &fallback_name } else { &name })?;
    let text = serde_json::to_string(&document).map_err(|e| e.to_string())?;
    let derived = spec::derive(&document);
    let mut meta = flow_queries::create_flow(&conn, &workspace_id, folder_id.as_deref(), &name, &text, &derived, false)
        .map_err(|e| e.to_string())?;
    if !description.trim().is_empty() {
        if let Some(updated) = flow_queries::set_description(&conn, &meta.id, description.trim()).map_err(|e| e.to_string())? {
            meta = updated;
        }
    }
    Ok(FlowImported { meta, notes })
}

/// Trusts what a flow runs, as reviewed: `exec_hash` is the hash the review was of, and a flow that
/// changed since is refused with `changed` — what was looked at is not what it would run.
#[tauri::command]
pub fn flows_trust_flow(db: State<Db>, id: String, exec_hash: String) -> Result<FlowMeta, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::trust_flow(&conn, &id, &exec_hash).map_err(|e| e.to_string())?.ok_or_else(|| "changed".to_string())
}

/// Runs waiting for someone — approvals, calls, times — of one workspace, oldest first.
#[tauri::command]
pub fn flows_list_waits(app: AppHandle, workspace_id: String) -> Result<Vec<flow_run_queries::FlowWaitRow>, String> {
    crate::flows::waits::open_waits(&app, Some(&workspace_id))
}

/// Approves, rejects or resumes a waiting run. `comment` travels with an approval's decision.
#[tauri::command]
pub fn flows_decide_wait(app: AppHandle, id: String, decision: String, comment: Option<String>) -> Result<flow_run_queries::FlowWaitRow, String> {
    let payload = comment.filter(|c| !c.trim().is_empty()).map_or(Value::Null, Value::String);
    crate::flows::waits::decide(&app, &id, &decision, "desktop", payload)
}

/// The runs still going in a workspace — what a window that opened after they started picks up.
#[tauri::command]
pub fn flows_active_runs(db: State<Db>, workspace_id: String) -> Result<Vec<FlowRunRow>, String> {
    let ids = runs::active_ids(Some(&workspace_id));
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, _) in ids {
        if let Some(row) = flow_run_queries::get_run(&conn, &id).map_err(|e| e.to_string())? {
            out.push(row);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn flows_list_runs(db: State<Db>, flow_id: String, limit: Option<i64>, before: Option<String>) -> Result<Vec<FlowRunRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::list_runs(&conn, &flow_id, limit.unwrap_or(50).clamp(1, 500), before.as_deref()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct FlowRunDetail {
    run: FlowRunRow,
    nodes: Vec<FlowRunNodeRow>,
}

#[tauri::command]
pub fn flows_get_run(db: State<Db>, run_id: String) -> Result<Option<FlowRunDetail>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some(run) = flow_run_queries::get_run(&conn, &run_id).map_err(|e| e.to_string())? else { return Ok(None) };
    let nodes = flow_run_queries::run_nodes(&conn, &run_id).map_err(|e| e.to_string())?;
    Ok(Some(FlowRunDetail { run, nodes }))
}

/// One node's input and output in a run, cut to `limit` items per port (the counts say how many
/// there were).
#[tauri::command]
pub async fn flows_run_node_data(run_id: String, node_id: String, limit: Option<usize>) -> Result<Option<NodeDataView>, String> {
    let limit = limit.unwrap_or(200).clamp(1, 5000);
    tauri::async_runtime::spawn_blocking(move || runs::node_data_view(&run_id, &node_id, limit))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn flows_run_log(run_id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || runs::read_log(&run_id, 20_000)).await.map_err(|e| e.to_string())
}

/// What a run's editing AI nodes changed, per repository: the files and the diff against the run's
/// restore point.
#[tauri::command]
pub async fn flows_run_edits(run_id: String) -> Result<Vec<runs::RunEdits>, String> {
    tauri::async_runtime::spawn_blocking(move || runs::edits(&run_id)).await.map_err(|e| e.to_string())
}

/// Puts back everything a run's editing AI nodes changed — the paths it touched.
#[tauri::command]
pub async fn flows_undo_edits(run_id: String) -> Result<Vec<String>, String> {
    if runs::active_ids(None).iter().any(|(id, _)| id == &run_id) {
        return Err("This run is still going — stop it first".into());
    }
    tauri::async_runtime::spawn_blocking(move || runs::undo_edits(&run_id)).await.map_err(|e| e.to_string())?
}

/// The models a local server offers, for the Local model node's picker. `server` is the node's:
/// `auto` reads Settings' choice (or the first server that answers).
#[tauri::command]
pub async fn flows_local_models(db: State<'_, Db>, server: String, url: String) -> Result<Vec<String>, String> {
    use crate::hybrid::local_llm::{self, BackendKind, Endpoint};
    use crate::hybrid::runtime;
    let settings = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::hybrid::config::read(&conn)?
    };
    let kind = match BackendKind::from_setting(&server) {
        Some(kind) => kind,
        None => runtime::pick_backend(&settings, &runtime::detect(&settings, runtime::Freshness::Recent).await),
    };
    if kind == BackendKind::Bundled {
        return Ok(crate::localai::exec_catalogue::EXEC_CATALOGUE
            .iter()
            .filter(|entry| crate::localai::models::is_installed(&entry.spec))
            .map(|entry| entry.spec.id.to_string())
            .collect());
    }
    let url = if url.trim().is_empty() { settings.url_for(kind) } else { url };
    let endpoint = Endpoint::new(kind, &url, crate::hybrid::config::api_key());
    let listed = local_llm::list_models(&endpoint).await.map_err(|e| e.sentence())?;
    Ok(listed.into_iter().map(|model| model.id).collect())
}

#[tauri::command]
pub fn flows_delete_run(db: State<Db>, run_id: String) -> Result<(), String> {
    if runs::cancel(&run_id) {
        return Err("This run is still going — stop it first".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    runs::delete(&conn, &run_id).map_err(|e| e.to_string())
}

/// Deletes every finished run of a flow.
#[tauri::command]
pub fn flows_clear_runs(db: State<Db>, flow_id: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let ids = flow_run_queries::run_ids_of_flow(&conn, &flow_id).map_err(|e| e.to_string())?;
    let active: Vec<String> = runs::active_ids(None).into_iter().map(|(id, _)| id).collect();
    let mut deleted = 0;
    for id in ids.iter().filter(|id| !active.contains(id)) {
        runs::delete(&conn, id).map_err(|e| e.to_string())?;
        deleted += 1;
    }
    Ok(deleted)
}

/// What an expression evaluates to against a node's input in the flow's newest run — the live
/// preview under a parameter. `spec` is the editor's draft, which may be newer than the saved flow.
#[tauri::command]
pub async fn flows_preview_expression(
    db: State<'_, Db>,
    flow_id: String,
    node_id: String,
    expression: String,
    item_index: Option<usize>,
    spec: Option<String>,
) -> Result<Value, String> {
    let (parsed, run_id, workspace_id, vars, locale, flow_name) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let flow = flow_queries::get_flow(&conn, &flow_id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?;
        let text = spec.unwrap_or_else(|| flow.spec.clone());
        let parsed = spec::parse(&text)?;
        let newest = flow_run_queries::list_runs(&conn, &flow_id, 1, None).map_err(|e| e.to_string())?;
        let vars = flow_run_queries::variables_map(&conn, &flow.meta.workspace_id).map_err(|e| e.to_string())?;
        let language = crate::db::queries::get_setting(&conn, "app_language").ok().flatten();
        let locale = if language.as_deref() == Some("es") { "es" } else { "en-US" };
        (parsed, newest.first().map(|run| run.id.clone()), flow.meta.workspace_id.clone(), vars, locale.to_string(), flow.meta.name)
    };
    let node_name = parsed.nodes.iter().find(|n| n.id == node_id).map(|n| n.name.clone()).ok_or("No such node")?;
    let spec = Arc::new(parsed);
    let source = run_id.clone();
    // Reading the run's files and starting QuickJS both block; neither belongs on a runtime worker.
    let (worker, items) = tauri::async_runtime::spawn_blocking(move || -> Result<(ExprWorker, Vec<Value>), String> {
        let mut stored = runs::StoredRun::new(source.as_deref().unwrap_or("none"), spec);
        let input = if source.is_some() { stored.input_of(&node_id) } else { Default::default() };
        let items: Vec<Value> = input.inputs.iter().flatten().map(|item| item.json.clone()).collect();
        Ok((ExprWorker::start(Arc::new(stored), &locale)?, items))
    })
    .await
    .map_err(|e| e.to_string())??;
    let job = json!({
        "kind": "eval",
        "expression": expression,
        "index": item_index.unwrap_or(0),
        "items": items,
        "context": {
            "node": node_name,
            "flow": {"id": flow_id, "name": flow_name, "active": false},
            "execution": {"id": run_id.unwrap_or_default(), "mode": "manual"},
            "vars": vars,
            "timezone": Value::Null,
            "workspace": workspace_id,
        }
    });
    Ok(match worker.run(&job, std::time::Duration::from_secs(3)).await {
        Ok(value) => json!({"ok": true, "value": value["value"], "type": value["type"], "items": items.len()}),
        Err(error) => json!({"ok": false, "error": error.to_string(), "items": items.len()}),
    })
}

// ---------- pinned output ----------

#[tauri::command]
pub fn flows_list_pins(db: State<Db>, flow_id: String) -> Result<HashMap<String, Value>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(flow_run_queries::list_pins(&conn, &flow_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|(node, text)| serde_json::from_str(&text).ok().map(|value| (node, value)))
        .collect())
}

/// Pins a node's output: `ports` is `[[json, …], …]`, one list per output port.
#[tauri::command]
pub fn flows_pin_node(db: State<Db>, flow_id: String, node_id: String, ports: Value) -> Result<(), String> {
    let valid = ports.as_array().is_some_and(|list| list.iter().all(|port| port.as_array().is_some_and(|items| items.iter().all(Value::is_object))));
    if !valid {
        return Err("Pinned data must be lists of objects, one list per output".into());
    }
    let text = ports.to_string();
    if text.len() > 16 * 1024 * 1024 {
        return Err("Pinned data is limited to 16 MB".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::set_pin(&conn, &flow_id, &node_id, &text, &crate::flows::engine::now_text()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_unpin_node(db: State<Db>, flow_id: String, node_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::delete_pin(&conn, &flow_id, &node_id).map_err(|e| e.to_string())
}

// ---------- remembered state ----------

#[tauri::command]
pub fn flows_state_list(db: State<Db>, flow_id: String) -> Result<Vec<FlowStateEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::state_list(&conn, &flow_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_state_clear(db: State<Db>, flow_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::state_clear(&conn, &flow_id).map_err(|e| e.to_string())
}

// ---------- variables ----------

fn clean_variable_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let valid = !name.is_empty()
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit());
    if valid {
        Ok(name.to_string())
    } else {
        Err("A variable name is letters, digits and _, and does not start with a digit".into())
    }
}

#[tauri::command]
pub fn flows_list_variables(db: State<Db>, workspace_id: String) -> Result<Vec<FlowVariable>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::list_variables(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_put_variable(db: State<Db>, workspace_id: String, name: String, value: String) -> Result<FlowVariable, String> {
    let name = clean_variable_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::put_variable(&conn, &workspace_id, &name, &value, &crate::flows::engine::now_text()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_rename_variable(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let name = clean_variable_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::rename_variable(&conn, &id, &name, &crate::flows::engine::now_text()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_delete_variable(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::delete_variable(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flows_set_variable_scope(db: State<Db>, id: String, global: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::set_variable_scope(&conn, &id, global).map_err(|e| e.to_string())
}

// ---------- credentials ----------

const CREDENTIAL_KINDS: &[&str] = &["bearer", "basic", "header", "query", "hmac", "smtp", "imap", "webhook", "oauth2", "aws"];

/// The parts of a credential that are safe to keep in the row, by kind; everything else is dropped.
fn clean_meta(kind: &str, meta: &Value) -> Result<Value, String> {
    let field = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    match kind {
        "basic" => Ok(json!({"user": field("user")})),
        "header" | "query" => {
            let name = field("name");
            if name.is_empty() {
                return Err(format!("A {kind} credential needs the name it is sent under"));
            }
            Ok(json!({"name": name}))
        }
        "smtp" => {
            let host = field("host");
            if host.is_empty() {
                return Err("An SMTP account needs its server".into());
            }
            let port = field("port");
            if !port.is_empty() && port.parse::<u16>().is_err() {
                return Err(format!("{port} is not a port"));
            }
            let security = match field("security").as_str() {
                "tls" => "tls",
                "none" => "none",
                _ => "starttls",
            };
            Ok(json!({"host": host, "port": port, "user": field("user"), "security": security, "from": field("from")}))
        }
        "aws" => {
            let access_key = field("user");
            if access_key.is_empty() {
                return Err("An AWS credential needs its access key ID".into());
            }
            Ok(json!({"user": access_key, "region": field("region")}))
        }
        "imap" => {
            let host = field("host");
            if host.is_empty() {
                return Err("An IMAP account needs its server".into());
            }
            let port = field("port");
            if !port.is_empty() && port.parse::<u16>().is_err() {
                return Err(format!("{port} is not a port"));
            }
            let security = match field("security").as_str() {
                "starttls" => "starttls",
                "none" => "none",
                _ => "tls",
            };
            Ok(json!({"host": host, "port": port, "user": field("user"), "security": security}))
        }
        "oauth2" => {
            let provider = match field("provider").as_str() {
                "google" => "google",
                "microsoft" => "microsoft",
                _ => "custom",
            };
            let client_id = field("clientId");
            if client_id.is_empty() {
                return Err("An OAuth 2 credential needs its client id".into());
            }
            let mut clean = json!({"provider": provider, "clientId": client_id, "scopes": field("scopes")});
            if provider == "microsoft" && !field("tenant").is_empty() {
                clean["tenant"] = json!(field("tenant"));
            }
            if provider == "custom" {
                for key in ["authUrl", "tokenUrl"] {
                    let url = field(key);
                    if !matches!(url::Url::parse(&url).map(|u| u.scheme().to_string()).as_deref(), Ok("https" | "http")) {
                        return Err("A custom OAuth 2 provider needs its authorization and token URLs".into());
                    }
                    clean[key] = json!(url);
                }
                let redirect = field("redirectUri");
                if !redirect.is_empty() {
                    crate::oauth::loopback_redirect(&redirect)?;
                    clean["redirectUri"] = json!(redirect);
                }
            }
            Ok(clean)
        }
        _ => Ok(json!({})),
    }
}

/// Whether two `oauth2` metas sign in as the same client for the same thing — when not, the tokens
/// the old one got are for someone else's client or scopes, and the credential must connect again.
fn same_sign_in(before: &Value, after: &Value) -> bool {
    ["provider", "clientId", "tenant", "authUrl", "tokenUrl", "scopes", "redirectUri"].iter().all(|key| before.get(*key) == after.get(*key))
}

/// Tries a credential for real: an SMTP account signs in to its server; an HTTP credential signs a
/// GET to `url` and must not be refused; a webhook URL is asked about itself (a Discord webhook
/// answers a GET with its own description, posting nothing). Answers with what happened, in a sentence.
#[tauri::command]
pub async fn flows_test_credential(db: State<'_, Db>, id: String, url: Option<String>) -> Result<String, String> {
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_run_queries::get_credential(&conn, &id).map_err(|e| e.to_string())?.ok_or("That credential no longer exists")?
    };
    let mut secret = crate::secrets::get_secret(&crate::secrets::flow_credential_key(&id))?.ok_or("Its secret is not stored on this computer")?;
    let mut kind = row.kind.clone();
    if kind == "oauth2" {
        secret = crate::flows::oauth::access_token(&id, &row.meta).await?;
        if url.as_deref().map(str::trim).unwrap_or_default().is_empty() {
            return Ok("The token is valid".into());
        }
        kind = "bearer".into();
    }
    let meta = |key: &str| row.meta.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    match kind.as_str() {
        "smtp" => {
            use lettre::transport::smtp::authentication::Credentials;
            use lettre::{AsyncSmtpTransport, Tokio1Executor};
            let host = meta("host");
            let mut builder = match meta("security").as_str() {
                "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&host),
                "none" => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host)),
                _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host),
            }
            .map_err(|e| e.to_string())?;
            if let Ok(port) = meta("port").parse::<u16>() {
                builder = builder.port(port);
            }
            if !meta("user").is_empty() {
                builder = builder.credentials(Credentials::new(meta("user"), secret));
            }
            let mailer: AsyncSmtpTransport<Tokio1Executor> = builder.timeout(Some(std::time::Duration::from_secs(15))).build();
            match mailer.test_connection().await {
                Ok(true) => Ok(format!("{host} accepted the account")),
                Ok(false) => Err(format!("{host} did not answer as an SMTP server")),
                Err(e) => Err(format!("{host}: {e}")),
            }
        }
        "bearer" | "basic" | "header" | "query" => {
            let url = url.unwrap_or_default();
            if url.trim().is_empty() {
                return Err("Write a URL to try it against".into());
            }
            let mut request = reqwest::Client::new().get(url.trim()).timeout(std::time::Duration::from_secs(15));
            match kind.as_str() {
                "bearer" => request = request.bearer_auth(&secret),
                "basic" => request = request.basic_auth(meta("user"), Some(&secret)),
                "header" => request = request.header(meta("name").as_str(), secret.as_str()),
                _ => request = request.query(&[(meta("name"), secret.clone())]),
            }
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                Err(format!("The server refused it ({status})"))
            } else {
                Ok(format!("The server answered {status}"))
            }
        }
        "aws" => {
            // STS answers who a key is without needing any permission.
            let url = url::Url::parse("https://sts.amazonaws.com/").map_err(|e| e.to_string())?;
            let body = "Action=GetCallerIdentity&Version=2011-06-15";
            let headers = vec![("content-type".to_string(), "application/x-www-form-urlencoded; charset=utf-8".to_string())];
            let signed = crate::sigv4::sigv4_headers(
                "POST",
                &url,
                &headers,
                &crate::sigv4::hex_sha256(body.as_bytes()),
                &meta("user"),
                &secret,
                "",
                "us-east-1",
                "sts",
                &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
            )?;
            let mut request = reqwest::Client::new().post(url.as_str()).timeout(std::time::Duration::from_secs(15)).body(body);
            for (name, value) in headers.into_iter().chain(signed) {
                request = request.header(name, value);
            }
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let between = |open: &str, close: &str| text.split(open).nth(1).and_then(|rest| rest.split(close).next()).unwrap_or_default().to_string();
            if status.is_success() {
                Ok(format!("AWS knows the key as {}", between("<Arn>", "</Arn>")))
            } else {
                Err(format!("AWS refused it ({status}): {}", between("<Message>", "</Message>")))
            }
        }
        "imap" => {
            let account = crate::flows::mail::Account::of(&row.meta, secret)?;
            let mut session = crate::flows::mail::open(&account).await?;
            let inbox = session.examine("INBOX").await.map_err(|e| e.to_string());
            let _ = session.logout().await;
            let inbox = inbox?;
            Ok(format!("{} accepted the account · INBOX has {} message(s)", account.host, inbox.exists))
        }
        "webhook" => {
            let parsed = url::Url::parse(secret.trim()).map_err(|_| "The webhook is not a URL".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("The webhook is not an http or https URL".into());
            }
            let host = parsed.host_str().unwrap_or_default().to_string();
            let response = reqwest::Client::new()
                .get(parsed)
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("{host}: {e}"))?;
            let status = response.status();
            if matches!(status.as_u16(), 401 | 403 | 404) {
                Err(format!("{host} does not know this webhook ({status})"))
            } else {
                Ok(format!("{host} answered {status}"))
            }
        }
        other => Err(format!("A {other} credential has nothing to try against")),
    }
}

#[tauri::command]
pub fn flows_list_credentials(db: State<Db>, workspace_id: String) -> Result<Vec<FlowCredential>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::list_credentials(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Creates a credential. The secret goes to the keychain before the row exists, so a row never
/// names a secret that was not stored.
#[tauri::command]
pub fn flows_create_credential(
    db: State<Db>,
    workspace_id: String,
    name: String,
    kind: String,
    meta: Value,
    secret: String,
) -> Result<FlowCredential, String> {
    let name = clean_name(&name)?;
    if !CREDENTIAL_KINDS.contains(&kind.as_str()) {
        return Err(format!("Unknown credential kind {kind}"));
    }
    if secret.is_empty() && kind != "oauth2" {
        return Err("The secret is empty".into());
    }
    let meta = clean_meta(&kind, &meta)?;
    let id = uuid::Uuid::new_v4().to_string();
    // An OAuth 2 credential keeps its client secret (a public client has none) with the tokens
    // `flows_oauth_connect` adds later.
    let stored = if kind == "oauth2" {
        serde_json::to_string(&crate::flows::oauth::Tokens { client_secret: secret, ..Default::default() }).map_err(|e| e.to_string())?
    } else {
        secret
    };
    crate::secrets::set_secret(&crate::secrets::flow_credential_key(&id), &stored)?;
    let now = crate::flows::engine::now_text();
    let credential = FlowCredential {
        id: id.clone(),
        workspace_id,
        scope: "workspace".into(),
        name,
        kind,
        meta,
        created_at: now.clone(),
        updated_at: now,
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if let Err(error) = flow_run_queries::insert_credential(&conn, &credential) {
        let _ = crate::secrets::delete_secret(&crate::secrets::flow_credential_key(&id));
        return Err(error.to_string());
    }
    Ok(credential)
}

/// Renames a credential, changes what is safe to show, and — when `secret` is given — replaces it.
#[tauri::command]
pub fn flows_update_credential(
    db: State<Db>,
    id: String,
    name: String,
    meta: Value,
    secret: Option<String>,
) -> Result<(), String> {
    let name = clean_name(&name)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let current = flow_run_queries::get_credential(&conn, &id).map_err(|e| e.to_string())?.ok_or("This credential no longer exists")?;
    let mut meta = clean_meta(&current.kind, &meta)?;
    let key = crate::secrets::flow_credential_key(&id);
    if current.kind == "oauth2" {
        let mut tokens = crate::flows::oauth::Tokens::read(&crate::secrets::get_secret(&key)?.unwrap_or_default());
        let signed_in_as_before = same_sign_in(&current.meta, &meta);
        if let Some(secret) = secret.filter(|s| !s.is_empty()) {
            tokens.client_secret = secret;
        }
        if signed_in_as_before {
            for key in ["account", "connected"] {
                if let Some(value) = current.meta.get(key) {
                    meta[key] = value.clone();
                }
            }
        } else {
            tokens = crate::flows::oauth::Tokens { client_secret: tokens.client_secret, ..Default::default() };
        }
        crate::secrets::set_secret(&key, &serde_json::to_string(&tokens).map_err(|e| e.to_string())?)?;
    } else if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        crate::secrets::set_secret(&key, &secret)?;
    }
    flow_run_queries::update_credential(&conn, &id, &name, &meta, &crate::flows::engine::now_text()).map_err(|e| e.to_string())
}

/// The models a provider's API offers, for an AI node's model picker — read with the node's own
/// credential (`purpose`: `chat` or `embed`).
#[tauri::command]
pub async fn flows_ai_models(
    db: State<'_, Db>,
    provider: String,
    base_url: String,
    credential_id: Option<String>,
    purpose: String,
) -> Result<Vec<String>, String> {
    let key = match credential_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                flow_run_queries::get_credential(&conn, &id).map_err(|e| e.to_string())?.ok_or("That credential no longer exists")?;
            }
            crate::secrets::get_secret(&crate::secrets::flow_credential_key(&id))?
        }
        None => None,
    };
    crate::flows::nodes::list_models(&provider, &base_url, key.as_deref(), &purpose).await
}

/// Signs an OAuth 2 credential in, in the browser (`flows::oauth::connect`), and labels it with the
/// account it got — the credential, as the list shows it, comes back.
#[tauri::command]
pub async fn flows_oauth_connect(db: State<'_, Db>, id: String) -> Result<FlowCredential, String> {
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_run_queries::get_credential(&conn, &id).map_err(|e| e.to_string())?.ok_or("That credential no longer exists")?
    };
    if row.kind != "oauth2" {
        return Err("Only an OAuth 2 credential connects".into());
    }
    let account = crate::flows::oauth::connect(&id, &row.meta).await?;
    let mut meta = row.meta.clone();
    match account {
        Some(account) => meta["account"] = json!(account),
        None => meta["account"] = json!(""),
    }
    meta["connected"] = json!(true);
    let now = crate::flows::engine::now_text();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::update_credential(&conn, &id, &row.name, &meta, &now).map_err(|e| e.to_string())?;
    Ok(FlowCredential { meta, updated_at: now, ..row })
}

#[tauri::command]
pub fn flows_delete_credential(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::delete_credential(&conn, &id).map_err(|e| e.to_string())?;
    // After the row: a secret left behind is harmless and invisible; a row whose secret is gone
    // fails every node that uses it.
    let _ = crate::secrets::delete_secret(&crate::secrets::flow_credential_key(&id));
    Ok(())
}

#[tauri::command]
pub fn flows_set_credential_scope(db: State<Db>, id: String, global: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_run_queries::set_credential_scope(&conn, &id, global).map_err(|e| e.to_string())
}
