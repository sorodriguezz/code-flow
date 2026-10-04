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
use crate::flows::{catalog, params, spec, triggers};

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
    let text = spec.unwrap_or_else(spec::empty_text);
    let derived = spec::derive(&spec::parse(&text)?);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    flow_queries::create_flow(&conn, &workspace_id, folder_id.as_deref(), &name, &text, &derived)
        .map_err(|e| e.to_string())
}

/// The autosave path. Validated before the lock is taken: parsing a large flow is not something to
/// hold the whole database's connection for.
#[tauri::command]
pub fn flows_save_flow(
    app: AppHandle,
    db: State<Db>,
    id: String,
    spec: String,
    expected_version: Option<i64>,
) -> Result<FlowSaved, String> {
    let derived = spec::derive(&spec::parse(&spec)?);
    let mut saved = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::save_spec(&conn, &id, &spec, &derived, expected_version).map_err(|e| e.to_string())?
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
    Ok(())
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
pub fn flows_run(app: AppHandle, flow_id: String, mode: RunMode, trigger: Option<String>) -> Result<FlowRunRow, String> {
    runs::start(&app, &flow_id, mode, trigger)
}

#[tauri::command]
pub fn flows_cancel_run(run_id: String) -> bool {
    runs::cancel(&run_id)
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

const CREDENTIAL_KINDS: &[&str] = &["bearer", "basic", "header", "query", "hmac"];

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
        _ => Ok(json!({})),
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
    if secret.is_empty() {
        return Err("The secret is empty".into());
    }
    let meta = clean_meta(&kind, &meta)?;
    let id = uuid::Uuid::new_v4().to_string();
    crate::secrets::set_secret(&crate::secrets::flow_credential_key(&id), &secret)?;
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
    let meta = clean_meta(&current.kind, &meta)?;
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        crate::secrets::set_secret(&crate::secrets::flow_credential_key(&id), &secret)?;
    }
    flow_run_queries::update_credential(&conn, &id, &name, &meta, &crate::flows::engine::now_text()).map_err(|e| e.to_string())
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
