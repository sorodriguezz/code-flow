//! Tauri commands for the editor's notebooks: finding kernels, running them, and the per-cell AI.
//! The kernels themselves are `crate::jupyter`; the notebook — cells, outputs, the file — is the
//! webview's.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::ai;
use crate::ai_runs;
use crate::commands::claude_cmd::{load_ai_config_in, shared_template, AiTask};
use crate::db::Db;
use crate::jupyter::{self, assist::AssistRequest, kernel::Kernel, kernelspec};

/// How long a closing notebook's kernel is given to shut down by itself.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// The folder a notebook lives in, inside its repository — where its kernel runs, which is what
/// makes `pd.read_csv("data.csv")` find the file beside it, as Jupyter does.
fn notebook_dir(repo_path: &str, notebook_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = PathBuf::from(repo_path);
    let rel = Path::new(notebook_path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Ruta de notebook no válida".to_string());
    }
    let dir = root.join(rel).parent().map(Path::to_path_buf).unwrap_or_else(|| root.clone());
    Ok((root, dir))
}

/// The kernels a notebook could run on — see `jupyter::kernelspec::discover`. The choices are
/// remembered, and a start names one of them.
#[tauri::command]
pub async fn notebook_discover_kernels(
    repo_path: String,
    notebook_path: String,
) -> Result<kernelspec::KernelDiscovery, String> {
    let (root, dir) = notebook_dir(&repo_path, &notebook_path)?;
    let discovery = kernelspec::discover(&dir, &root).await;
    jupyter::remember_choices(&discovery.kernels);
    Ok(discovery)
}

/// Starts a kernel for a notebook, under the id the notebook minted, and answers with its
/// `kernel_info` once it is ready.
#[tauri::command]
pub async fn notebook_kernel_start(
    app: AppHandle,
    kernel_id: String,
    choice_id: String,
    repo_path: String,
    notebook_path: String,
) -> Result<Value, String> {
    let choice = jupyter::choice(&choice_id)
        .ok_or_else(|| "Ese kernel ya no está en la lista; vuelve a buscar kernels".to_string())?;
    if jupyter::kernel(&kernel_id).is_some() {
        return Err("Ese kernel ya está en marcha".to_string());
    }
    let (_, cwd) = notebook_dir(&repo_path, &notebook_path)?;
    jupyter::sweep_stale_connection_files();
    let events = jupyter::AppEvents::shared(&app);
    let (kernel, info) = Kernel::start(kernel_id, choice, cwd, jupyter::runtime_dir(), events).await?;
    jupyter::insert(kernel);
    Ok(info)
}

fn running(kernel_id: &str) -> Result<std::sync::Arc<Kernel>, String> {
    jupyter::kernel(kernel_id).ok_or_else(|| "El kernel no está en marcha".to_string())
}

/// Runs code. Returns once the request is sent; everything it produces arrives as events carrying
/// `msg_id` as their parent.
#[tauri::command]
pub async fn notebook_kernel_execute(
    kernel_id: String,
    msg_id: String,
    code: String,
    allow_stdin: Option<bool>,
) -> Result<(), String> {
    running(&kernel_id)?.execute(&msg_id, &code, allow_stdin.unwrap_or(true)).await
}

/// What the user typed into an `input()` box.
#[tauri::command]
pub async fn notebook_kernel_input(kernel_id: String, value: String) -> Result<(), String> {
    running(&kernel_id)?.input_reply(&value).await
}

#[tauri::command]
pub async fn notebook_kernel_interrupt(kernel_id: String) -> Result<(), String> {
    running(&kernel_id)?.interrupt().await
}

#[tauri::command]
pub async fn notebook_kernel_restart(kernel_id: String) -> Result<Value, String> {
    running(&kernel_id)?.restart().await
}

/// Stops a notebook's kernel — its tab closed. A kernel already gone is not an error: the question
/// was "make sure it is not running".
#[tauri::command]
pub async fn notebook_kernel_shutdown(kernel_id: String) -> Result<(), String> {
    if let Some(kernel) = jupyter::remove(&kernel_id) {
        kernel.shutdown(SHUTDOWN_GRACE).await;
    }
    Ok(())
}

/// One AI action on a notebook cell — generate, explain, fix, document. Text in, text out: see
/// `jupyter::assist`.
#[tauri::command]
pub async fn notebook_ai(
    app: AppHandle,
    db: State<'_, Db>,
    request: AssistRequest,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = load_ai_config_in(&conn, AiTask::Notebook, workspace_id.as_deref())?;
        let template = shared_template(&conn, "notebook_template", "")?;
        (config, template)
    };
    let payload = jupyter::assist::payload(&request);
    ai_runs::scoped(app, run_id, async {
        ai::notebook_assist(&*config.engine, &config.binary, &config.model, &template, request.action, &payload).await
    })
    .await
}

/// The built-in instructions behind the notebook's AI when `notebook_template` is blank — what
/// Settings shows as the default and restores.
#[tauri::command]
pub fn default_notebook_template() -> String {
    jupyter::assist::DEFAULT_PROMPT.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kernel_runs_in_its_notebooks_folder() {
        let (root, dir) = notebook_dir("/repo", "analysis/2026/q1.ipynb").unwrap();
        assert_eq!(root, PathBuf::from("/repo"));
        assert_eq!(dir, PathBuf::from("/repo/analysis/2026"));
        let (_, top) = notebook_dir("/repo", "q1.ipynb").unwrap();
        assert_eq!(top, PathBuf::from("/repo"));
    }

    #[test]
    fn a_path_out_of_the_repository_is_refused() {
        assert!(notebook_dir("/repo", "../elsewhere/n.ipynb").is_err());
        assert!(notebook_dir("/repo", "/etc/n.ipynb").is_err());
    }

    #[test]
    fn the_default_prompt_is_what_settings_restores() {
        assert!(default_notebook_template().contains("```"));
    }
}
