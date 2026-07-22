use std::path::Path;
use std::process::Stdio;

use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::db::{models::WorkspaceSkill, queries, Db};
use crate::paths;

#[derive(Clone, serde::Serialize)]
struct SkillProgressEvent {
    line: String,
}

/// `npx` is a `.cmd` shim on Windows — spawning it directly (rather than through `cmd /C`)
/// fails to launch at all, the same class of issue as calling any other npm-installed shim.
fn npx_command() -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npx"]);
        cmd
    } else {
        Command::new("npx")
    }
}

/// Installs a skill from skills.sh into this workspace's canonical skill store
/// (`C:\CodeFlow\workspaces\<id>\skills\.claude\skills\<name>`) via `npx skills add`,
/// streaming its output, then records it in `workspace_skills`.
#[tauri::command]
pub async fn install_workspace_skill(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: String,
    source_repo: String,
    skill_name: String,
) -> Result<WorkspaceSkill, String> {
    let dir = paths::workspace_skills_dir(&workspace_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut cmd = npx_command();
    cmd.args(["--yes", "skills", "add", &source_repo, "--skill", &skill_name])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to launch npx: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let stdout_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        if let Some(out) = stdout {
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_out.emit("skills:progress", SkillProgressEvent { line: line.clone() });
                collected.push(line);
            }
        }
        collected
    });
    let app_err = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        if let Some(err) = stderr {
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_err.emit("skills:progress", SkillProgressEvent { line: line.clone() });
                collected.push(line);
            }
        }
        collected
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stdout_lines = stdout_task.await.unwrap_or_default();
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let detail = if !stderr_lines.is_empty() {
            stderr_lines.join("\n")
        } else {
            stdout_lines.join("\n")
        };
        return Err(format!("npx skills add failed: {detail}"));
    }

    let installed_path = dir.join(".claude").join("skills").join(&skill_name);
    if !installed_path.exists() {
        return Err(format!(
            "skills add reported success but {} wasn't created — check the skill name and repo",
            installed_path.display()
        ));
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_workspace_skill(&conn, &workspace_id, &skill_name, &source_repo).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_workspace_skills(db: State<Db>, workspace_id: String) -> Result<Vec<WorkspaceSkill>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_workspace_skill(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let skill = queries::get_workspace_skill(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Skill not found".to_string())?;
    queries::delete_workspace_skill(&conn, &id).map_err(|e| e.to_string())?;
    let dir = paths::workspace_skills_dir(&skill.workspace_id)
        .join(".claude")
        .join("skills")
        .join(&skill.skill_name);
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

/// Copies every skill installed for a workspace into a specific project's own
/// `.claude/skills/` — Claude Code only discovers skills relative to its working
/// directory, there's no flag to point it at a shared/external skills folder, so this is
/// what actually makes "skills apply to the whole workspace" true in practice.
pub fn sync_skills_into_project(workspace_id: &str, project_path: &str) -> Result<(), String> {
    let src_root = paths::workspace_skills_dir(workspace_id).join(".claude").join("skills");
    if !src_root.exists() {
        return Ok(());
    }
    let dest_root = Path::new(project_path).join(".claude").join("skills");
    std::fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;

    for entry in std::fs::read_dir(&src_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let dest = dest_root.join(entry.file_name());
        copy_dir_recursive(&entry.path(), &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}
