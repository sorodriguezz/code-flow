use std::path::Path;
use std::process::Stdio;

use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::db::{models::WorkspaceSkill, queries, Db};
use crate::paths;
use crate::proc;

#[derive(Clone, serde::Serialize)]
struct SkillProgressEvent {
    line: String,
}

/// `npx` is a `.cmd` shim on Windows — spawning it directly (rather than through `cmd /C`)
/// fails to launch at all, the same class of issue as calling any other npm-installed shim.
fn npx_command() -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = proc::command("cmd");
        cmd.args(["/C", "npx"]);
        cmd
    } else {
        proc::command("npx")
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
    let _ = std::fs::remove_dir_all(skill_dir(&skill.workspace_id, &skill.skill_name));
    Ok(())
}

/// Toggles a skill on/off. Disabled skills aren't synced into projects at review time (and are
/// removed from a project's `.claude/skills` on the next sync) — the way to stop using skills, e.g.
/// with a non-Claude engine, without deleting them.
#[tauri::command]
pub fn set_workspace_skill_enabled(db: State<Db>, id: String, enabled: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_workspace_skill_enabled(&conn, &id, enabled).map_err(|e| e.to_string())
}

/// Creates a skill from scratch in the workspace store — a folder with a `SKILL.md` the user
/// authored in-app, rather than pulling one from the skills.sh registry.
#[tauri::command]
pub fn create_custom_skill(
    db: State<Db>,
    workspace_id: String,
    name: String,
    skill_md: String,
) -> Result<WorkspaceSkill, String> {
    let clean = sanitize_name(&name);
    if clean.is_empty() {
        return Err("Please give the skill a name".to_string());
    }
    let dir = skill_dir(&workspace_id, &clean);
    if dir.exists() {
        return Err(format!("A skill named \"{clean}\" already exists in this workspace"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), skill_md).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_workspace_skill(&conn, &workspace_id, &clean, "custom").map_err(|e| e.to_string())
}

/// Imports a skill from a local folder (one that already has a `SKILL.md`), copying it into the
/// workspace store. The skill name is the folder's own name.
#[tauri::command]
pub fn import_skill_from_folder(
    db: State<Db>,
    workspace_id: String,
    src_dir: String,
) -> Result<WorkspaceSkill, String> {
    let src = Path::new(&src_dir);
    if !src.join("SKILL.md").exists() {
        return Err("That folder isn't a skill — it has no SKILL.md".to_string());
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_name)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "Couldn't derive a skill name from that folder".to_string())?;
    let dir = skill_dir(&workspace_id, &name);
    if dir.exists() {
        return Err(format!("A skill named \"{name}\" already exists in this workspace"));
    }
    copy_dir_recursive(src, &dir).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_workspace_skill(&conn, &workspace_id, &name, "local").map_err(|e| e.to_string())
}

/// Lists every file inside a skill's folder (relative paths, `/`-separated) — the file tree the
/// in-app editor shows so any file (SKILL.md, references/*, scripts) can be edited.
#[tauri::command]
pub fn list_skill_files(workspace_id: String, skill_name: String) -> Result<Vec<String>, String> {
    let dir = skill_dir(&workspace_id, &skill_name);
    let mut out = Vec::new();
    collect_files(&dir, &dir, &mut out).map_err(|e| e.to_string())?;
    out.sort();
    Ok(out)
}

#[tauri::command]
pub fn read_skill_file(workspace_id: String, skill_name: String, rel_path: String) -> Result<String, String> {
    let path = safe_skill_path(&workspace_id, &skill_name, &rel_path)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_skill_file(
    workspace_id: String,
    skill_name: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let path = safe_skill_path(&workspace_id, &skill_name, &rel_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_skill_file(workspace_id: String, skill_name: String, rel_path: String) -> Result<(), String> {
    let path = safe_skill_path(&workspace_id, &skill_name, &rel_path)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

fn skills_root(workspace_id: &str) -> std::path::PathBuf {
    paths::workspace_skills_dir(workspace_id).join(".claude").join("skills")
}

fn skill_dir(workspace_id: &str, name: &str) -> std::path::PathBuf {
    skills_root(workspace_id).join(name)
}

/// Keeps a skill name usable as a single path segment.
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect::<String>()
        .trim_matches(['-', '.', ' '])
        .to_string()
}

/// Joins a skill-relative path safely — rejects `..` traversal so the editor can never read/write
/// outside the skill's own folder.
fn safe_skill_path(workspace_id: &str, skill_name: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    if rel.split(['/', '\\']).any(|c| c == ".." || c.is_empty()) {
        return Err("invalid file path".to_string());
    }
    Ok(skill_dir(workspace_id, &sanitize_name(skill_name)).join(rel))
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_files(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// Copies the workspace's **enabled** skills into a project's own `.claude/skills/` (Claude Code
/// only discovers skills relative to its working directory), and removes any of our **disabled**
/// skills that a previous sync left there. Only ever touches folders named after skills we manage —
/// never the user's own unmanaged `.claude/skills` entries.
pub fn sync_skills_into_project(skills: &[WorkspaceSkill], workspace_id: &str, project_path: &str) -> Result<(), String> {
    let dest_root = Path::new(project_path).join(".claude").join("skills");
    for skill in skills.iter().filter(|s| !s.enabled) {
        let _ = std::fs::remove_dir_all(dest_root.join(&skill.skill_name));
    }
    let enabled: std::collections::HashSet<&str> =
        skills.iter().filter(|s| s.enabled).map(|s| s.skill_name.as_str()).collect();
    let src_root = skills_root(workspace_id);
    if !src_root.exists() || enabled.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&src_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if !enabled.contains(name.to_string_lossy().as_ref()) {
            continue;
        }
        copy_dir_recursive(&entry.path(), &dest_root.join(name)).map_err(|e| e.to_string())?;
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
