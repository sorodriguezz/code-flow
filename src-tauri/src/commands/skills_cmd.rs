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

/// Caps on a `.skill` bundle, applied before anything is written.
///
/// The compressed cap is the cheap one — it is a `metadata` call and it rejects the honest mistake
/// (a video dropped on the dialog). The uncompressed cap and the entry count are what make a zip
/// bomb boring: a three-kilobyte archive can declare a petabyte, and without a running total the
/// first thing to notice is the disk.
const MAX_SKILL_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SKILL_UNPACKED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SKILL_ENTRIES: usize = 2_000;

/// Imports a skill from a `.skill` bundle — the zipped skill folder Claude hands out — into the
/// workspace store.
///
/// **A `.skill` is a zip whose root is either the skill's folder or the skill itself**, because
/// both are in the wild: `zip -r foo.skill foo/` writes `foo/SKILL.md`, and zipping the folder's
/// *contents* writes `SKILL.md`. Rather than insisting on one, the archive is searched for the
/// shallowest `SKILL.md` and what sits beside it is what gets copied — which also drops the
/// `__MACOSX/` sidecar the Finder staples to anything zipped on a Mac.
///
/// **The name comes from the skill, not from the file.** `SKILL.md`'s front matter carries `name:`,
/// and that is the name the model discovers the skill by, so a bundle renamed on its way through a
/// chat window still lands under the name its instructions were written for. The folder inside the
/// archive is the fallback and the file's own stem the last resort.
///
/// **Nothing is published until the whole archive has been read.** Extraction goes to a staging
/// directory beside the destination and is renamed into place at the end, so a bundle that turns
/// out to be truncated, oversized or hostile leaves no half-imported skill behind for
/// `list_skill_files` to show and for a review to sync into a project.
#[tauri::command]
pub fn import_skill_from_file(
    db: State<Db>,
    workspace_id: String,
    file_path: String,
) -> Result<WorkspaceSkill, String> {
    let src = Path::new(&file_path);
    let meta = std::fs::metadata(src).map_err(|e| format!("{file_path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{file_path} is not a file"));
    }
    if meta.len() > MAX_SKILL_ARCHIVE_BYTES {
        return Err(format!(
            "That bundle is {} MB — too large for a skill",
            meta.len() / (1024 * 1024)
        ));
    }

    let mut file = std::fs::File::open(src).map_err(|e| format!("{file_path}: {e}"))?;
    // Sniffed before it is opened as an archive, purely so the error is worth reading: "it isn't a
    // zip" leaves a user holding a `.tar.gz` with nowhere to go, and "that's a gzip — unpack it and
    // use Import from folder" is the same refusal with the way out attached.
    if let Some(what) = not_a_zip(&mut file) {
        return Err(format!(
            "That file isn't a .skill bundle — it looks like {what}. A .skill is a zipped skill \
             folder; unpack this one and use Import from folder instead."
        ));
    }
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|_| "That .skill bundle can't be read — the zip is damaged or truncated".to_string())?;
    if zip.len() > MAX_SKILL_ENTRIES {
        return Err("That bundle has too many files for a skill".to_string());
    }

    let (skill_md_at, prefix) = find_skill_root(&mut zip)?;

    // The name, before a single byte is written: an import that is going to collide should say so
    // while the user still has the file dialog in mind, not after copying a hundred files.
    //
    // **The folder inside the archive comes first, not the front matter**, which is the one part of
    // this that reads backwards until you know why. For a skill on disk it is the *directory name*
    // that Claude Code discovers the skill by; front-matter `name` is only the label shown in a
    // listing. The folder in the bundle is therefore the name the skill had on the machine it was
    // written on, and the name its own instructions refer to. Anthropic's packager derives the
    // archive folder, the front-matter name and the `.skill` filename from that same directory, so
    // for a well-formed bundle all three agree and the order never shows; it shows when they
    // disagree, and then the folder is the one that was true.
    let skill_md = read_archive_text(&mut zip, skill_md_at)?;
    let from_folder = prefix.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    let name = [
        sanitize_name(from_folder),
        front_matter_name(&skill_md).map(|n| sanitize_name(&n)).unwrap_or_default(),
        sanitize_name(src.file_stem().and_then(|s| s.to_str()).unwrap_or_default()),
    ]
    .into_iter()
    .find(|candidate| !candidate.is_empty())
    .ok_or_else(|| "Couldn't work out a name for that skill".to_string())?;
    // `synced` is where `CLAUDE_CODE_SYNC_SKILLS` writes the skills it pulls down from claude.ai,
    // in every skills root and in any capitalisation. A skill importing itself into that name would
    // be overwritten without warning by the next sync.
    if name.eq_ignore_ascii_case("synced") {
        return Err("\"synced\" is a reserved name — rename the skill's folder and try again".to_string());
    }

    let dir = skill_dir(&workspace_id, &name);
    if dir.exists() {
        return Err(format!(
            "A skill named \"{name}\" already exists in this workspace — remove it first"
        ));
    }

    // Staged, so a failure part-way through the loop is a directory nobody has been told about
    // rather than a skill missing the references its instructions point at. The leading dot keeps
    // it out of `sync_skills_into_project`'s way too, which walks this same root by name.
    let staging = dir.with_file_name(format!(".{name}.importing"));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(e) = extract_skill(&mut zip, &prefix, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&staging, &dir) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.to_string());
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // `bundle`, not `local`: the badge beside a row is the only place the panel says where a skill
    // came from, and "a folder on this machine" and "a bundle somebody sent me" are different
    // answers to that question.
    match queries::add_workspace_skill(&conn, &workspace_id, &name, "bundle") {
        Ok(row) => Ok(row),
        Err(e) => {
            // The row is what makes a skill exist as far as the app is concerned. A directory
            // without one is invisible in the panel and therefore undeletable from it.
            let _ = std::fs::remove_dir_all(&dir);
            Err(e.to_string())
        }
    }
}

/// What a file is, when it is not a zip — or `None` when it is one.
///
/// Only ever used to phrase the refusal, so it names the two containers that plausibly turn up with
/// a `.skill` on them and calls everything else what it is: not a bundle. Leaves the cursor back at
/// the start, since the caller reads the same handle as an archive immediately afterwards.
fn not_a_zip(file: &mut std::fs::File) -> Option<&'static str> {
    use std::io::{Read, Seek, SeekFrom};
    let mut head = [0u8; 264];
    let read = file.read(&mut head).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(0));
    // `PK\x03\x04` is a member; `PK\x05\x06` is an empty archive and `PK\x07\x08` a spanned one.
    // All three are zips — an empty one goes on to fail with a message about having no SKILL.md,
    // which is the more useful thing to say about it.
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") || head.starts_with(b"PK\x07\x08") {
        return None;
    }
    if head.starts_with(b"\x1f\x8b") {
        return Some("a gzip archive (.tar.gz)");
    }
    if read >= 262 && &head[257..262] == b"ustar" {
        return Some("a tar archive");
    }
    Some("something else")
}

/// Locates the skill's own folder inside a bundle, without extracting anything.
///
/// The *shallowest* `SKILL.md` is the skill's; a deeper one belongs to a bundled example or to a
/// nested skill, and taking that one would import the example and drop the skill. Ties are not
/// worth resolving — two at the same depth is two skills in one bundle, where either answer is as
/// defensible as the other.
///
/// Returns the index as well as the prefix, because `by_name` wants the archive's *stored* name and
/// that is not what `enclosed_name` hands back: an archive written with `./` in front of every
/// member would fail every lookup built by concatenation.
fn find_skill_root<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<(usize, String), String> {
    let mut found: Option<(usize, String)> = None;
    for at in 0..zip.len() {
        let entry = zip.by_index(at).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else { continue };
        let name = name.to_string_lossy().replace('\\', "/");
        if ignored_archive_path(&name) || !name.ends_with("SKILL.md") {
            continue;
        }
        let candidate = name[..name.len() - "SKILL.md".len()].to_string();
        let shallower = found
            .as_ref()
            .is_none_or(|(_, current)| candidate.matches('/').count() < current.matches('/').count());
        if shallower {
            found = Some((at, candidate));
        }
    }
    found.ok_or_else(|| "That bundle isn't a skill — it has no SKILL.md".to_string())
}

/// Unpacks everything under `prefix` into `dest`, refusing anything that would land outside it.
///
/// `enclosed_name` is the zip crate's own answer to zip-slip and it is trusted for what it covers —
/// absolute paths, `..`, Windows drive letters, NUL. What it cannot cover is the total, so the
/// running byte count here is what stands between a three-kilobyte archive that declares a petabyte
/// and the disk.
fn extract_skill<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    prefix: &str,
    dest: &Path,
) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    for at in 0..zip.len() {
        let mut entry = zip.by_index(at).map_err(|e| e.to_string())?;
        // Only `None` for a name the crate itself judged unsafe. Skipping beats failing: the rest
        // of the bundle is still a skill, and the one member that was refused is the one member
        // that had no business being there.
        let Some(path) = entry.enclosed_name() else { continue };
        let name = path.to_string_lossy().replace('\\', "/");
        if ignored_archive_path(&name) {
            continue;
        }
        let Some(rel) = name.strip_prefix(prefix) else { continue };
        if rel.is_empty() {
            continue;
        }
        let target = dest.join(rel);
        // Belt and braces over `enclosed_name`: this join is the only place a member's path becomes
        // absolute, so it is the only place worth checking that it stayed inside.
        if !target.starts_with(dest) {
            continue;
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        written = written.saturating_add(entry.size());
        if written > MAX_SKILL_UNPACKED_BYTES {
            return Err("That bundle unpacks to more than a skill should be".to_string());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    // The prefix was chosen *because* a `SKILL.md` sat under it, so this only fires when the
    // archive's directory listing and its members disagree — a truncated download, mostly.
    if !dest.join("SKILL.md").exists() {
        return Err("That bundle isn't a skill — it has no SKILL.md".to_string());
    }
    Ok(())
}

/// Reads one member as text, by index. Used for `SKILL.md` before anything is unpacked.
fn read_archive_text<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    at: usize,
) -> Result<String, String> {
    let mut entry = zip.by_index(at).map_err(|e| e.to_string())?;
    if entry.size() > MAX_SKILL_ARCHIVE_BYTES {
        return Err("That bundle's SKILL.md is implausibly large".to_string());
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut entry, &mut text)
        .map_err(|_| "That bundle's SKILL.md isn't text".to_string())?;
    Ok(text)
}

/// How deep a member may sit. Well past anything a real skill has, and short of the depth at which
/// a hostile archive is trying to exhaust the filesystem rather than deliver files.
const MAX_SKILL_DEPTH: usize = 32;

/// Archive members that are packaging noise rather than part of the skill.
///
/// The same set Anthropic's own packager leaves out, plus the Finder's sidecar. Filtered on the way
/// in and never treated as making the bundle invalid: a `node_modules` inside a skill is somebody's
/// working directory that got zipped, not an attack, and refusing the import over it would be
/// refusing a skill that is perfectly good once the noise is dropped.
fn ignored_archive_path(name: &str) -> bool {
    if name.matches('/').count() >= MAX_SKILL_DEPTH {
        return true;
    }
    name.split('/').any(|part| {
        matches!(part, "__MACOSX" | ".DS_Store" | ".git" | "__pycache__" | "node_modules")
            || part.ends_with(".pyc")
    })
}

/// The `name:` from a `SKILL.md`'s YAML front matter, if it has one.
///
/// Deliberately not a YAML parse. A skill's front matter is a handful of scalars and the one field
/// wanted here is a bare string on its own line; a parser would be a dependency and a fresh set of
/// failure modes in exchange for a `k: v` split. Stops at the closing `---` so a `name:` down in
/// the instructions cannot be mistaken for the skill's own.
fn front_matter_name(skill_md: &str) -> Option<String> {
    // The BOM first: a `SKILL.md` written by a Windows editor starts with one, and it would
    // otherwise make the `---` test fail and cost the skill its real name for no visible reason.
    let rest = skill_md.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let body = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n'))?;
    for line in body.lines() {
        if line.trim() == "---" {
            return None;
        }
        if let Some(value) = line.strip_prefix("name:") {
            let value = value.trim().trim_matches(['"', '\'']).trim();
            return (!value.is_empty()).then(|| value.to_string());
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Builds a `.skill` in memory. `(stored name, contents)`; a name ending in `/` is a directory.
    fn bundle(entries: &[(&str, &str)]) -> std::io::Cursor<Vec<u8>> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in entries {
                if name.ends_with('/') {
                    zip.add_directory(*name, options).unwrap();
                } else {
                    zip.start_file(*name, options).unwrap();
                    zip.write_all(body.as_bytes()).unwrap();
                }
            }
            zip.finish().unwrap();
        }
        buffer.set_position(0);
        buffer
    }

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("cf-skill-{}", uuid::Uuid::new_v4()))
    }

    /// The two shapes a `.skill` actually arrives in — `zip -r foo.skill foo/`, and a zip of the
    /// folder's contents — have to import to the same thing.
    #[test]
    fn the_root_is_found_whether_or_not_the_folder_is_in_the_archive() {
        let mut wrapped = zip::ZipArchive::new(bundle(&[
            ("my-skill/", ""),
            ("my-skill/SKILL.md", "---\nname: my-skill\n---\n"),
        ]))
        .unwrap();
        assert_eq!(find_skill_root(&mut wrapped).unwrap().1, "my-skill/");

        let mut flat = zip::ZipArchive::new(bundle(&[("SKILL.md", "hi"), ("refs/a.md", "x")])).unwrap();
        assert_eq!(find_skill_root(&mut flat).unwrap().1, "");
    }

    /// A bundle carrying an example that is itself a skill imports the *skill*, not the example.
    #[test]
    fn the_shallowest_skill_wins() {
        let mut zip = zip::ZipArchive::new(bundle(&[
            ("pack/examples/demo/SKILL.md", "deep"),
            ("pack/SKILL.md", "shallow"),
        ]))
        .unwrap();
        assert_eq!(find_skill_root(&mut zip).unwrap().1, "pack/");
    }

    #[test]
    fn a_zip_that_is_not_a_skill_is_refused() {
        let mut zip = zip::ZipArchive::new(bundle(&[("readme.md", "nope")])).unwrap();
        assert!(find_skill_root(&mut zip).is_err());
    }

    /// **The one that matters.** A member whose path climbs out of the destination must not be
    /// written — the classic zip-slip, and the reason this command reads an archive at all.
    #[test]
    fn nothing_escapes_the_destination() {
        let mut zip = zip::ZipArchive::new(bundle(&[
            ("s/SKILL.md", "---\nname: s\n---\n"),
            ("s/../../../../../../tmp/cf-escaped.txt", "pwned"),
            ("/etc/cf-absolute.txt", "pwned"),
            ("s/refs/note.md", "kept"),
            ("__MACOSX/s/._SKILL.md", "junk"),
            ("s/node_modules/left-pad/index.js", "junk"),
            ("s/__pycache__/x.cpython-311.pyc", "junk"),
            ("s/scripts/tool.pyc", "junk"),
        ]))
        .unwrap();
        let dest = scratch();
        extract_skill(&mut zip, "s/", &dest).unwrap();

        assert!(dest.join("SKILL.md").exists());
        assert_eq!(std::fs::read_to_string(dest.join("refs/note.md")).unwrap(), "kept");
        assert!(!dest.join("..").join("cf-escaped.txt").exists());
        assert!(!std::path::Path::new("/tmp/cf-escaped.txt").exists());
        // Nothing outside the skill's own folder, and none of the packaging noise inside it —
        // the Finder sidecar, a vendored `node_modules`, compiled Python.
        let mut names: Vec<String> = Vec::new();
        collect_files(&dest, &dest, &mut names).unwrap();
        names.sort();
        assert_eq!(names, vec!["SKILL.md".to_string(), "refs/note.md".to_string()]);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn the_name_comes_from_the_front_matter() {
        assert_eq!(front_matter_name("---\nname: pdf-tools\nfoo: 1\n---\n# hi").as_deref(), Some("pdf-tools"));
        assert_eq!(front_matter_name("---\r\nname: \"quoted\"\r\n---\r\n").as_deref(), Some("quoted"));
        // A BOM from a Windows editor must not cost the skill its name.
        assert_eq!(front_matter_name("\u{feff}---\nname: bom\n---\n").as_deref(), Some("bom"));
        // No front matter, and a `name:` that only appears in the body, are both "no name here".
        assert_eq!(front_matter_name("# just a heading\nname: nope\n"), None);
        assert_eq!(front_matter_name("---\ndescription: x\n---\nname: nope\n"), None);
    }

    /// The sniffer exists for its error message, so what it must get right is telling the two
    /// plausible near-misses apart from a real bundle.
    #[test]
    fn a_bundle_that_is_not_a_zip_is_named_in_the_refusal() {
        let write = |bytes: &[u8]| {
            let path = std::env::temp_dir().join(format!("cf-sniff-{}", uuid::Uuid::new_v4()));
            std::fs::write(&path, bytes).unwrap();
            path
        };
        let mut gzip = vec![0x1f, 0x8b, 0x08, 0x00];
        gzip.resize(300, 0);
        let path = write(&gzip);
        assert_eq!(not_a_zip(&mut std::fs::File::open(&path).unwrap()), Some("a gzip archive (.tar.gz)"));
        let _ = std::fs::remove_file(&path);

        let mut tar = vec![0u8; 512];
        tar[257..262].copy_from_slice(b"ustar");
        let path = write(&tar);
        assert_eq!(not_a_zip(&mut std::fs::File::open(&path).unwrap()), Some("a tar archive"));
        let _ = std::fs::remove_file(&path);

        // And a real one is let through — cursor included, which is what the caller reads next.
        let zipped = bundle(&[("SKILL.md", "---\nname: x\n---\n")]).into_inner();
        let path = write(&zipped);
        let mut handle = std::fs::File::open(&path).unwrap();
        assert_eq!(not_a_zip(&mut handle), None);
        let mut archive = zip::ZipArchive::new(std::io::BufReader::new(handle)).unwrap();
        assert_eq!(find_skill_root(&mut archive).unwrap().1, "");
        let _ = std::fs::remove_file(&path);
    }

    /// The folder wins over the front matter, because the folder is what Claude Code reads the
    /// skill's name from once it is on disk.
    #[test]
    fn the_folder_names_the_skill_before_the_front_matter_does() {
        let mut zip = zip::ZipArchive::new(bundle(&[(
            "pdf-tools/SKILL.md",
            "---\nname: Working with PDFs\n---\n",
        )]))
        .unwrap();
        let (at, prefix) = find_skill_root(&mut zip).unwrap();
        let folder = prefix.trim_end_matches('/').rsplit('/').next().unwrap();
        assert_eq!(sanitize_name(folder), "pdf-tools");
        // …and the front matter is still what answers when the archive has no folder to read.
        let md = read_archive_text(&mut zip, at).unwrap();
        assert_eq!(front_matter_name(&md).as_deref(), Some("Working with PDFs"));
    }

    #[test]
    fn a_name_is_always_one_path_segment() {
        assert_eq!(sanitize_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_name("My Skill!"), "My-Skill");
        assert_eq!(sanitize_name("  ---  "), "");
    }
}
