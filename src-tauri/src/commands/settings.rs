use tauri::State;

use crate::db::{models::*, queries, Db};

#[tauri::command]
pub fn get_setting(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

/// A workspace's editable prompt override for `kind` (`review_standard` | `pr_description`).
/// Always non-empty — a blanked/absent row resolves to the built-in default, so the editor and
/// the AI pipeline get real text. Provider-independent: the same text applies to whatever engine
/// the task routes to.
#[tauri::command]
pub fn get_workspace_prompt(db: State<Db>, workspace_id: String, kind: String) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_workspace_prompt(&conn, &workspace_id, &kind).map_err(|e| e.to_string())
}

/// Saves a workspace's prompt override for `kind`. An empty string clears it (restore default).
#[tauri::command]
pub fn set_workspace_prompt(db: State<Db>, workspace_id: String, kind: String, content: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_workspace_prompt(&conn, &workspace_id, &kind, &content).map_err(|e| e.to_string())
}

/// The built-in default text for `kind`, for the editor's "restore default" action.
#[tauri::command]
pub fn default_workspace_prompt(kind: String) -> String {
    queries::workspace_prompt_default(&kind).to_string()
}

// ---------- review memory (review_runs) ----------

#[tauri::command]
pub fn list_review_runs(db: State<Db>, workspace_id: String) -> Result<Vec<ReviewRunSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_review_runs(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_review_run(db: State<Db>, id: String) -> Result<Option<ReviewRunDetail>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_review_run(&conn, &id).map_err(|e| e.to_string())
}

/// Marks one finding in a saved run as `falso_positivo` / `ignorado` (with a reason), or clears it
/// back to `abierto`. Provider-independent — pure DB — and carried forward on the next re-review.
#[tauri::command]
pub fn mark_review_finding(
    db: State<Db>,
    run_id: String,
    finding_id: String,
    estado: String,
    motivo: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let run = queries::get_review_run(&conn, &run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Review run not found".to_string())?;
    let mut findings: Vec<crate::review_memory::MemoryFinding> =
        serde_json::from_str(&run.findings).map_err(|e| e.to_string())?;
    let f = findings
        .iter_mut()
        .find(|f| f.id == finding_id)
        .ok_or_else(|| "Finding not found in this run".to_string())?;
    match estado.as_str() {
        "falso_positivo" | "ignorado" => {
            f.estado = estado;
            f.motivo_descarte = motivo.filter(|m| !m.trim().is_empty());
        }
        // Un-mark: back to open (or posted if it still has a thread).
        _ => {
            f.estado = if f.thread_id.is_some() { "posteado".to_string() } else { "abierto".to_string() };
            f.motivo_descarte = None;
        }
    }
    let json = serde_json::to_string(&findings).map_err(|e| e.to_string())?;
    queries::set_review_run_findings(&conn, &run_id, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_review_run(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_review_run(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_review_runs_for_pr(db: State<Db>, project_id: String, pr_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_review_runs_for_pr(&conn, &project_id, pr_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn purge_workspace_review_runs(db: State<Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::purge_workspace_review_runs(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Exports saved runs to a user-chosen folder as `PR-<n>_<timestamp>/` subfolders holding
/// `review.md`, `meta.json`, `diff.patch` and `findings.json`. `id` exports one run; when `None`,
/// exports every run in the workspace. Returns how many runs were written.
#[tauri::command]
pub fn export_review_runs(
    db: State<Db>,
    workspace_id: String,
    id: Option<String>,
    dest_dir: String,
) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let runs = match id {
        Some(id) => queries::get_review_run(&conn, &id)
            .map_err(|e| e.to_string())?
            .map(|r| vec![r])
            .unwrap_or_default(),
        None => {
            let summaries = queries::list_review_runs(&conn, &workspace_id).map_err(|e| e.to_string())?;
            summaries
                .into_iter()
                .filter_map(|s| queries::get_review_run(&conn, &s.id).ok().flatten())
                .collect()
        }
    };
    drop(conn);

    let root = std::path::Path::new(&dest_dir);
    let mut written = 0;
    for run in &runs {
        let stamp = run.created_at.replace([':', '.'], "-");
        let dir = root.join(format!("PR-{}_{}", run.pr_id, stamp));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("review.md"), &run.review_md).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("meta.json"), &run.meta).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("diff.patch"), &run.diff).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("findings.json"), &run.findings).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

// ---------- SDD/Harness agents ----------

#[tauri::command]
pub fn list_workspace_agents(db: State<Db>, workspace_id: String) -> Result<Vec<WorkspaceAgent>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_agents(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn upsert_workspace_agent(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    role: String,
    provider: String,
    model: String,
    prompt: String,
    enabled: bool,
) -> Result<WorkspaceAgent, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_workspace_agent(&conn, id, &workspace_id, &name, &role, &provider, &model, &prompt, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace_agent(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace_agent(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_review_contexts(db: State<Db>, workspace_id: String) -> Result<Vec<ReviewContext>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_review_context(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    content: String,
    enabled: bool,
) -> Result<ReviewContext, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_review_context(&conn, id, &workspace_id, &name, &content, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_review_context(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_review_context(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_workspace_mcps(db: State<Db>, workspace_id: String) -> Result<Vec<WorkspaceMcp>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn upsert_workspace_mcp(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    command: String,
    args: String,
    env: String,
    enabled: bool,
) -> Result<WorkspaceMcp, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_workspace_mcp(&conn, id, &workspace_id, &name, &command, &args, &env, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace_mcp(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace_mcp(&conn, &id).map_err(|e| e.to_string())
}
