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

// ---------- known false positives (repository-scoped suppression rules) ----------

/// Where a workspace's suppression rules live. One row per workspace rather than one per
/// repository: the settings screen lists them all together, and a rule already carries the
/// `repo_key` it applies to, so splitting the storage would only make that read a fan-out.
fn suppressions_key(workspace_id: &str) -> String {
    format!("fp_suppressions:{workspace_id}")
}

/// A workspace's suppression rules, newest first. A corrupt or absent blob reads as "no rules" —
/// these silence findings, so failing open (reporting everything) is the safe direction.
pub fn load_fp_suppressions(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> Vec<crate::review_memory::FpSuppression> {
    queries::get_setting(conn, &suppressions_key(workspace_id))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_fp_suppressions(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    rules: &[crate::review_memory::FpSuppression],
) -> Result<(), String> {
    let json = serde_json::to_string(rules).map_err(|e| e.to_string())?;
    queries::set_setting(conn, &suppressions_key(workspace_id), &json).map_err(|e| e.to_string())
}

/// Every standing false positive in the workspace — what the settings screen lists and what a
/// review of any of its repositories is filtered from.
#[tauri::command]
pub fn list_fp_suppressions(
    db: State<Db>,
    workspace_id: String,
) -> Result<Vec<crate::review_memory::FpSuppression>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(load_fp_suppressions(&conn, &workspace_id))
}

/// Drops one rule, so the finding it denied is reported again from the next review on.
#[tauri::command]
pub fn remove_fp_suppression(db: State<Db>, workspace_id: String, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut rules = load_fp_suppressions(&conn, &workspace_id);
    rules.retain(|r| r.id != id);
    save_fp_suppressions(&conn, &workspace_id, &rules)
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

// ---------- moving review memory between installs ----------
//
// Export and import are one feature, and the second half is what makes the first worth having: a
// folder of reviews nothing can read back is a folder of reviews. So the shape below is chosen to
// round-trip — the human-readable layout export already wrote, plus the one file it was missing
// (`run.json`, the row's identity) — rather than a new archive format that would orphan every
// export already on disk.

/// What one export wrote.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub runs: usize,
    /// Standing false positives written alongside. Zero for a single-run export, which is a review
    /// someone wants to read rather than a memory being moved.
    pub rules: usize,
}

/// The rules file, at the root of the chosen folder rather than inside any run.
const RULES_FILE: &str = "suppressions.json";

/// Exports saved runs to a user-chosen folder as `PR-<n>_<timestamp>/` subfolders holding
/// `review.md`, `meta.json`, `diff.patch`, `findings.json` and `run.json`.
///
/// Three scopes, in the order they are checked: `id` exports that one run, `project_id` exports
/// every run of that repository, and neither exports the whole workspace. The last two also write
/// the standing false positives in scope — they are memory of the same repository, and a machine
/// restored without them re-argues every finding a human already dismissed.
#[tauri::command]
pub fn export_review_runs(
    db: State<Db>,
    workspace_id: String,
    id: Option<String>,
    project_id: Option<String>,
    dest_dir: String,
) -> Result<ExportOutcome, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    export_into(
        &conn,
        &workspace_id,
        id.as_deref(),
        project_id.as_deref(),
        std::path::Path::new(&dest_dir),
    )
}

/// The body of [`export_review_runs`], over a connection rather than Tauri state so the round trip
/// with [`import_from`] can be tested without an app handle.
fn export_into(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    id: Option<&str>,
    project_id: Option<&str>,
    root: &std::path::Path,
) -> Result<ExportOutcome, String> {
    let one_run = id.map(str::trim).filter(|s| !s.is_empty());
    let one_repo = project_id.map(str::trim).filter(|s| !s.is_empty());

    let runs = match one_run {
        Some(id) => queries::get_review_run(conn, id)
            .map_err(|e| e.to_string())?
            .map(|r| vec![r])
            .unwrap_or_default(),
        None => {
            let summaries =
                queries::list_review_runs(conn, workspace_id).map_err(|e| e.to_string())?;
            summaries
                .into_iter()
                .filter(|s| one_repo.is_none_or(|wanted| s.project_id == wanted))
                .filter_map(|s| queries::get_review_run(conn, &s.id).ok().flatten())
                .collect()
        }
    };

    // Which repository each run belongs to, for the identity written beside it. Read from the
    // project rather than trusted from `meta`, so a run recorded before repository keys existed
    // still exports with one and imports somewhere sensible.
    let repo_keys = project_repo_keys(conn, workspace_id);

    // A single-run export carries no rules: it is one review being shared or read, not a memory
    // being moved, and silently attaching the repository's standing judgements to it would be a
    // surprise on the other end.
    let rules: Vec<crate::review_memory::FpSuppression> = if one_run.is_some() {
        Vec::new()
    } else {
        let all = load_fp_suppressions(conn, workspace_id);
        match one_repo.and_then(|p| repo_keys.get(p)) {
            Some(key) => all.into_iter().filter(|r| r.repo_key.eq_ignore_ascii_case(key)).collect(),
            None => all,
        }
    };

    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;

    for run in &runs {
        let stamp = run.created_at.replace([':', '.'], "-");
        let dir = root.join(format!("PR-{}_{}", run.pr_id, stamp));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("review.md"), &run.review_md).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("meta.json"), &run.meta).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("diff.patch"), &run.diff).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("findings.json"), &run.findings).map_err(|e| e.to_string())?;

        let identity = crate::review_memory::RunIdentity {
            id: run.id.clone(),
            project_id: run.project_id.clone(),
            workspace_id: workspace_id.to_string(),
            pr_id: run.pr_id,
            iter: run.iter,
            level: run.level.clone(),
            created_at: run.created_at.clone(),
            repo_key: repo_keys.get(&run.project_id).cloned().unwrap_or_default(),
        };
        let json = serde_json::to_string_pretty(&identity).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("run.json"), json).map_err(|e| e.to_string())?;
    }

    // Merged rather than overwritten: exporting one repository into a folder that already holds a
    // whole-workspace export must not throw the rest of it away.
    let written_rules = if rules.is_empty() {
        0
    } else {
        let path = root.join(RULES_FILE);
        let existing = read_rules(&path);
        let (merged, added) = crate::review_memory::merge_suppressions(&existing, &rules);
        let json = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("{}: {e}", path.display()))?;
        added
    };

    Ok(ExportOutcome { runs: runs.len(), rules: written_rules })
}

/// Every linked project in the workspace, as `project_id → repo_key`.
fn project_repo_keys(
    conn: &rusqlite::Connection,
    workspace_id: &str,
) -> std::collections::HashMap<String, String> {
    queries::list_projects(conn, workspace_id)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            crate::commands::ado_cmd::project_repo_key(&p).map(|key| (p.id.clone(), key))
        })
        .collect()
}

fn read_rules(path: &std::path::Path) -> Vec<crate::review_memory::FpSuppression> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// What one import found and what it did with it.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: usize,
    /// Runs this install already had. The common, harmless case — importing the same folder twice,
    /// or two machines that have both seen the same review.
    pub already_present: usize,
    pub rules: usize,
    /// Repositories named by runs in the folder that no project in this workspace is linked to.
    /// Named rather than counted: the fix is to link that repository and import again, which the
    /// user can only do if they are told which one it was.
    pub unmatched_repos: Vec<String>,
    /// Folders that looked like a run but couldn't be read back — a truncated copy, or a
    /// `meta.json` that isn't JSON.
    pub unreadable: usize,
}

/// An export is two levels deep (chosen folder → run folder). The allowance is for the user having
/// moved it inside a couple of folders of their own; the bound is because the folder they pick is
/// their choice and could be a home directory.
const MAX_IMPORT_DEPTH: usize = 4;

/// Imports review memory from a folder written by [`export_review_runs`].
///
/// Runs are routed to the local project that **is** the repository the run names, never to the
/// project id the export carries — see `review_memory::resolve_project` for why that distinction is
/// load-bearing. Anything already here is left alone rather than overwritten: memory is cumulative
/// traceability, and an import is not a reason to lose a mark someone made on this machine.
#[tauri::command]
pub fn import_review_runs(
    db: State<Db>,
    workspace_id: String,
    src_dir: String,
) -> Result<ImportOutcome, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    import_from(&conn, &workspace_id, std::path::Path::new(&src_dir))
}

/// The body of [`import_review_runs`], over a connection rather than Tauri state.
fn import_from(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    root: &std::path::Path,
) -> Result<ImportOutcome, String> {
    let (run_dirs, rule_files) = collect_exported(root);
    if run_dirs.is_empty() && rule_files.is_empty() {
        return Err("no exported review memory was found in that folder".into());
    }

    let local: Vec<crate::review_memory::LocalProject> =
        queries::list_projects(conn, workspace_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|p| crate::review_memory::LocalProject {
                repo_key: crate::commands::ado_cmd::project_repo_key(&p),
                id: p.id,
            })
            .collect();

    let mut out = ImportOutcome::default();
    for dir in &run_dirs {
        let Some(run) = read_exported_run(dir) else {
            out.unreadable += 1;
            continue;
        };
        let Some(project) = crate::review_memory::resolve_project(&run.identity, &local) else {
            let named = unmatched_label(&run);
            if !out.unmatched_repos.contains(&named) {
                out.unmatched_repos.push(named);
            }
            continue;
        };
        if queries::review_run_exists(conn, &run.identity.id).map_err(|e| e.to_string())? {
            out.already_present += 1;
            continue;
        }
        queries::add_review_run(
            conn,
            &run.identity.id,
            &project.id,
            workspace_id,
            run.identity.pr_id,
            run.identity.iter,
            &run.identity.level,
            &run.meta,
            &run.review_md,
            &run.diff,
            &run.findings,
        )
        .map_err(|e| e.to_string())?;
        out.imported += 1;
    }

    let incoming: Vec<crate::review_memory::FpSuppression> =
        rule_files.iter().flat_map(|path| read_rules(path)).collect();
    if !incoming.is_empty() {
        let existing = load_fp_suppressions(conn, workspace_id);
        let (merged, added) = crate::review_memory::merge_suppressions(&existing, &incoming);
        save_fp_suppressions(conn, workspace_id, &merged)?;
        out.rules = added;
    }

    Ok(out)
}

/// What to call a run whose repository isn't here, in the sentence that asks the user to link it.
///
/// The repository key when there is one. Otherwise the project's *name* out of `meta` rather than
/// its id — that id is a uuid from another machine, and telling someone to go link
/// `9f8e-…-a3b4` names nothing they can act on.
fn unmatched_label(run: &ExportedRun) -> String {
    if !run.identity.repo_key.trim().is_empty() {
        return run.identity.repo_key.clone();
    }
    serde_json::from_str::<serde_json::Value>(&run.meta)
        .ok()
        .and_then(|meta| {
            meta.get("project_name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| run.identity.project_id.clone())
}

/// One run as it sits on disk.
struct ExportedRun {
    identity: crate::review_memory::RunIdentity,
    meta: String,
    review_md: String,
    diff: String,
    findings: String,
}

/// Reads a run folder back, or `None` when it isn't one.
///
/// Only `review.md` is required — it is what makes a folder a run at all. The rest default to what
/// an empty column holds, so a partially copied export loses detail rather than the review itself.
fn read_exported_run(dir: &std::path::Path) -> Option<ExportedRun> {
    let review_md = std::fs::read_to_string(dir.join("review.md")).ok()?;
    let meta = std::fs::read_to_string(dir.join("meta.json")).unwrap_or_else(|_| "{}".into());
    let diff = std::fs::read_to_string(dir.join("diff.patch")).unwrap_or_default();
    let findings = std::fs::read_to_string(dir.join("findings.json")).unwrap_or_else(|_| "[]".into());

    let identity = match std::fs::read_to_string(dir.join("run.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<crate::review_memory::RunIdentity>(&raw).ok())
    {
        Some(identity) => identity,
        // Exported before identities were written beside runs: everything needed is still in
        // `meta`, except the id — which is derived, so re-importing stays a no-op.
        None => identity_from_meta(&serde_json::from_str(&meta).ok()?)?,
    };
    Some(ExportedRun { identity, meta, review_md, diff, findings })
}

/// Reconstructs a run's identity from its `meta.json` alone.
fn identity_from_meta(meta: &serde_json::Value) -> Option<crate::review_memory::RunIdentity> {
    let text = |key: &str| {
        meta.get(key).and_then(serde_json::Value::as_str).unwrap_or_default().to_string()
    };
    let number = |key: &str| meta.get(key).and_then(serde_json::Value::as_i64).unwrap_or_default();

    let pr_id = number("pr_id");
    if pr_id == 0 {
        return None;
    }
    let repo_key = text("repo_key");
    let iter = number("iter").max(1);
    // The run's own timestamp stands in for the row's `created_at`: they are written in the same
    // operation, and it is the only one of the two that survives inside `meta`.
    let created_at = text("timestamp");
    Some(crate::review_memory::RunIdentity {
        id: crate::review_memory::derived_run_id(&repo_key, pr_id, iter, &created_at),
        project_id: text("project_id"),
        workspace_id: text("workspace_id"),
        pr_id,
        iter,
        level: text("level"),
        created_at,
        repo_key,
    })
}

/// Finds every run folder and rules file under `root`.
fn collect_exported(root: &std::path::Path) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) {
    let mut runs = Vec::new();
    let mut rules = Vec::new();
    walk_exported(root, 0, &mut runs, &mut rules);
    (runs, rules)
}

fn walk_exported(
    dir: &std::path::Path,
    depth: usize,
    runs: &mut Vec<std::path::PathBuf>,
    rules: &mut Vec<std::path::PathBuf>,
) {
    if depth > MAX_IMPORT_DEPTH {
        return;
    }
    // A run folder holds no run folders, so this is where the walk stops rather than one that
    // could pick the same review up twice from a nested copy.
    if dir.join("review.md").is_file() {
        runs.push(dir.to_path_buf());
        return;
    }
    let rules_path = dir.join(RULES_FILE);
    if rules_path.is_file() {
        rules.push(rules_path);
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            walk_exported(&path, depth + 1, runs, rules);
        }
    }
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




#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_memory::FpSuppression;
    use rusqlite::Connection;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-memory-export-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An install with one workspace and `repos` projects, each linked to a GitHub repository of
    /// the same name, and one saved review run per project.
    fn install(repos: &[&str]) -> (Connection, String, Vec<String>) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch("DELETE FROM workspaces;").unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
             VALUES ('ws', 'Flow', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();

        let mut ids = Vec::new();
        for repo in repos {
            let project = queries::create_project(
                &conn,
                NewProject {
                    workspace_id: "ws".into(),
                    name: (*repo).into(),
                    local_path: format!("/tmp/{repo}"),
                    remote_url: None,
                    color: "#111".into(),
                    icon: "folder".into(),
                    ado_org: None,
                    ado_project: None,
                    ado_repo_id: None,
                    github_owner: Some("acme".into()),
                    github_repo: Some((*repo).into()),
                    github_host: Some("github.com".into()),
                    gitlab_project: None,
                    gitlab_host: None,
                },
            )
            .unwrap();
            ids.push(project.id.clone());
            add_run(&conn, &project.id, repo, 7);
        }
        (conn, "ws".into(), ids)
    }

    fn add_run(conn: &Connection, project_id: &str, repo: &str, pr_id: i64) {
        let meta = serde_json::json!({
            "pr_id": pr_id,
            "pr_title": "Add the thing",
            "project_id": project_id,
            "workspace_id": "ws",
            "repo_key": format!("github:github.com/acme/{repo}"),
            "iter": 1,
            "level": "deep",
            "timestamp": "2026-08-01T10:00:00+00:00",
        })
        .to_string();
        queries::add_review_run(
            conn,
            &format!("run-{repo}"),
            project_id,
            "ws",
            pr_id,
            1,
            "deep",
            &meta,
            "# Review\n\nfindings here",
            "diff --git a/x b/x",
            r#"[{"id":"F-001","severity":"critical","tipo":"BUG","categoria":"stale-ref","subtitulo":"x","archivo":"a.ts","lineas":"1","confianza":80,"estado":"falso_positivo"}]"#,
        )
        .unwrap();
    }

    fn rule(repo: &str) -> FpSuppression {
        FpSuppression {
            id: uuid::Uuid::new_v4().to_string(),
            repo_key: format!("github:github.com/acme/{repo}"),
            categoria: "stale-ref".into(),
            archivo: Some("a.ts".into()),
            motivo: "el padre remonta por key".into(),
            pr_id: 7,
            created_at: "2026-08-01T00:00:00Z".into(),
        }
    }

    /// The whole point of the feature: what leaves one install arrives at another, findings, marks
    /// and standing rules included.
    #[test]
    fn a_workspace_export_lands_on_another_install() {
        let dir = scratch("round-trip");
        let (source, ws, _) = install(&["app", "api"]);
        save_fp_suppressions(&source, &ws, &[rule("app")]).unwrap();

        let written = export_into(&source, &ws, None, None, &dir).unwrap();
        assert_eq!(written.runs, 2);
        assert_eq!(written.rules, 1);

        // A second machine with the same two repositories, and no memory of its own.
        let (target, target_ws, _) = install(&["app", "api"]);
        queries::purge_workspace_review_runs(&target, &target_ws).unwrap();

        let out = import_from(&target, &target_ws, &dir).unwrap();
        assert_eq!(out.imported, 2);
        assert_eq!(out.rules, 1);
        assert!(out.unmatched_repos.is_empty());
        assert_eq!(out.unreadable, 0);

        let landed = queries::list_review_runs(&target, &target_ws).unwrap();
        assert_eq!(landed.len(), 2);
        // The mark a human made survives the trip — it is most of what memory is for.
        let detail = queries::get_review_run(&target, &landed[0].id).unwrap().unwrap();
        assert!(detail.findings.contains("falso_positivo"));
        assert_eq!(load_fp_suppressions(&target, &target_ws).len(), 1);
    }

    /// Importing twice must not double the memory, or every sync would inflate it.
    #[test]
    fn importing_the_same_folder_twice_changes_nothing_the_second_time() {
        let dir = scratch("idempotent");
        let (source, ws, _) = install(&["app"]);
        export_into(&source, &ws, None, None, &dir).unwrap();

        let (target, target_ws, _) = install(&["app"]);
        queries::purge_workspace_review_runs(&target, &target_ws).unwrap();

        assert_eq!(import_from(&target, &target_ws, &dir).unwrap().imported, 1);
        let again = import_from(&target, &target_ws, &dir).unwrap();
        assert_eq!(again.imported, 0);
        assert_eq!(again.already_present, 1);
        assert_eq!(queries::list_review_runs(&target, &target_ws).unwrap().len(), 1);
    }

    /// Same, for a folder exported before identities were written beside runs: the derived id has
    /// to be stable enough that re-importing is still a no-op.
    #[test]
    fn an_export_without_identities_still_imports_once() {
        let dir = scratch("legacy");
        let (source, ws, _) = install(&["app"]);
        export_into(&source, &ws, None, None, &dir).unwrap();
        for entry in std::fs::read_dir(&dir).unwrap().filter_map(Result::ok) {
            let _ = std::fs::remove_file(entry.path().join("run.json"));
        }

        let (target, target_ws, _) = install(&["app"]);
        queries::purge_workspace_review_runs(&target, &target_ws).unwrap();

        assert_eq!(import_from(&target, &target_ws, &dir).unwrap().imported, 1);
        assert_eq!(import_from(&target, &target_ws, &dir).unwrap().already_present, 1);
    }

    /// The dangerous one. A run whose repository isn't here must be reported by name, never filed
    /// against whichever project happens to be around — that would hand one repository another's
    /// findings, which is exactly what the memory scope exists to prevent.
    #[test]
    fn a_run_for_an_absent_repository_is_reported_not_placed() {
        let dir = scratch("unmatched");
        let (source, ws, _) = install(&["app", "secret-service"]);
        export_into(&source, &ws, None, None, &dir).unwrap();

        let (target, target_ws, _) = install(&["app"]);
        queries::purge_workspace_review_runs(&target, &target_ws).unwrap();

        let out = import_from(&target, &target_ws, &dir).unwrap();
        assert_eq!(out.imported, 1);
        assert_eq!(out.unmatched_repos, vec!["github:github.com/acme/secret-service".to_string()]);
        assert_eq!(queries::list_review_runs(&target, &target_ws).unwrap().len(), 1);
    }

    #[test]
    fn a_repository_export_carries_that_repository_only() {
        let dir = scratch("one-repo");
        let (source, ws, ids) = install(&["app", "api"]);
        save_fp_suppressions(&source, &ws, &[rule("app"), rule("api")]).unwrap();

        let written = export_into(&source, &ws, None, Some(&ids[0]), &dir).unwrap();
        assert_eq!(written.runs, 1);
        assert_eq!(written.rules, 1, "only the exported repository's rules travel");

        let (target, target_ws, _) = install(&["app", "api"]);
        queries::purge_workspace_review_runs(&target, &target_ws).unwrap();
        let out = import_from(&target, &target_ws, &dir).unwrap();
        assert_eq!(out.imported, 1);
        assert_eq!(queries::list_review_runs(&target, &target_ws).unwrap()[0].project_id, {
            let projects = queries::list_projects(&target, &target_ws).unwrap();
            projects.iter().find(|p| p.name == "app").unwrap().id.clone()
        });
    }

    /// One run is a review someone wants to read, not a memory being moved — attaching the
    /// repository's standing judgements to it would surprise whoever opens the folder.
    #[test]
    fn a_single_run_export_carries_no_rules() {
        let dir = scratch("one-run");
        let (source, ws, _) = install(&["app"]);
        save_fp_suppressions(&source, &ws, &[rule("app")]).unwrap();

        let written = export_into(&source, &ws, Some("run-app"), None, &dir).unwrap();
        assert_eq!(written.runs, 1);
        assert_eq!(written.rules, 0);
        assert!(!dir.join(RULES_FILE).exists());
    }

    /// Exporting one repository into a folder that already holds a whole-workspace export must add
    /// to its rules, not replace them with the narrower set.
    #[test]
    fn exporting_again_into_the_same_folder_keeps_the_rules_already_there() {
        let dir = scratch("merge-rules");
        let (source, ws, ids) = install(&["app", "api"]);
        save_fp_suppressions(&source, &ws, &[rule("app"), rule("api")]).unwrap();

        export_into(&source, &ws, None, None, &dir).unwrap();
        export_into(&source, &ws, None, Some(&ids[0]), &dir).unwrap();

        let kept = read_rules(&dir.join(RULES_FILE));
        assert_eq!(kept.len(), 2, "the narrower second export must not shrink the file");
    }

    #[test]
    fn a_folder_with_nothing_in_it_says_so() {
        let dir = scratch("empty");
        let (conn, ws, _) = install(&["app"]);
        assert!(import_from(&conn, &ws, &dir).is_err());
    }
}
