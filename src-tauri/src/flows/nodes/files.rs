//! Files and git: read and write a file, list a folder, move/copy/trash, run git, run docker.
//!
//! **Nothing here deletes for good.** Removing a file sends it to the system trash, and moving onto
//! a name that exists either refuses or — when the node says to overwrite — trashes what was there
//! first. A flow that runs at 03:00 must never be the reason something is gone.
//!
//! **Writes land whole.** A file is written next to its destination under a temporary name and
//! renamed over it, so a reader never sees half of it and a failure leaves the old file in place.
//! The size is read back afterwards: a write that the filesystem shortened is a failure, not a file.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use globset::{Glob, GlobMatcher};
use serde_json::{json, Value};

use super::process::{output_items, run_program};
use super::{flag, number, pairs, strings, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{set_path, to_text};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "files.file" => file(ctx).await,
        "files.list" => list(ctx).await,
        "files.move" => move_files(ctx).await,
        "files.git" => git(ctx).await,
        "code.docker" => docker(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

/// `~` and `~/…` against the user's home; everything else as written.
pub fn expand(path: &str) -> PathBuf {
    let path = path.trim();
    if path == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    PathBuf::from(path)
}

fn need_path(params: &Value, name: &str, what: &str) -> Result<PathBuf, NodeError> {
    let raw = text(params, name);
    if raw.trim().is_empty() {
        return Err(NodeError::failed(format!("Write the {what}")));
    }
    let path = expand(&raw);
    if !path.is_absolute() {
        return Err(NodeError::failed(format!("{} is not an absolute path", path.display())));
    }
    Ok(path)
}

fn iso(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()
}

/// What an item says about a file: where it is and what it is.
pub fn describe(path: &Path) -> Value {
    let meta = std::fs::metadata(path).ok();
    json!({
        "path": path.to_string_lossy(),
        "name": path.file_name().map(|n| n.to_string_lossy().into_owned()),
        "folder": path.parent().map(|p| p.to_string_lossy().into_owned()),
        "extension": path.extension().map(|e| e.to_string_lossy().into_owned()),
        "size": meta.as_ref().map(|m| m.len()),
        "isDir": meta.as_ref().map(|m| m.is_dir()),
        "modifiedAt": meta.and_then(|m| m.modified().ok()).map(iso),
    })
}

/// Writes `bytes` to `path` whole: a temporary sibling, then a rename over the destination, then
/// the size read back.
pub fn write_whole(path: &Path, bytes: &[u8], create_folders: bool) -> Result<(), NodeError> {
    let parent = path.parent().ok_or_else(|| NodeError::failed(format!("{} has no folder", path.display())))?;
    if !parent.is_dir() {
        if create_folders {
            std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(format!("Could not create {}: {e}", parent.display())))?;
        } else {
            return Err(NodeError::failed(format!("The folder {} does not exist", parent.display())));
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = parent.join(format!(".{name}.cf-{}", uuid::Uuid::new_v4().simple()));
    let written = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(NodeError::failed(format!("Could not write {}: {error}", path.display())));
    }
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size != bytes.len() as u64 {
        return Err(NodeError::failed(format!(
            "{} was written short: {size} of {} bytes landed",
            path.display(),
            bytes.len()
        )));
    }
    Ok(())
}

fn paired_item(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

fn base_json(ctx: &NodeCtx, index: usize) -> Value {
    ctx.items().get(index).map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

// ------------------------------------------------------------------------------------- read/write

async fn file(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let operation = ctx.param_str("operation");
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let path = need_path(params, "path", "file's path")?;
        let mut json = base_json(ctx, index);
        match operation.as_str() {
            "write" | "addToEnd" => {
                let content = params.get("content").cloned().unwrap_or(Value::Null);
                // A file reference handed on (a download, an upload) is copied as it is.
                let referenced = super::binary::is_reference(&content).then(|| super::binary::path_of(&content)).flatten();
                let bytes: Vec<u8> = match (referenced, text(params, "writeAs").as_str()) {
                    (Some(source), _) => std::fs::read(&source).map_err(|e| NodeError::failed(format!("Could not read {}: {e}", source.display())))?,
                    (None, kind) => match kind {
                    "json" => serde_json::to_vec_pretty(&content).unwrap_or_default(),
                    "base64" => base64::engine::general_purpose::STANDARD
                        .decode(to_text(&content).trim())
                        .map_err(|e| NodeError::failed(format!("The content is not base64: {e}")))?,
                    _ => to_text(&content).into_bytes(),
                    },
                };
                let create = flag(params, "createFolders");
                if operation == "addToEnd" && path.is_file() {
                    let mut current = std::fs::read(&path).map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
                    current.extend_from_slice(&bytes);
                    write_whole(&path, &current, create)?;
                } else {
                    write_whole(&path, &bytes, create)?;
                }
                set_path(&mut json, "file", describe(&path));
            }
            _ => {
                let bytes = tokio::fs::read(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
                let content = match text(params, "readAs").as_str() {
                    "json" => serde_json::from_slice::<Value>(&bytes)
                        .map_err(|e| NodeError::failed(format!("{} is not JSON: {e}", path.display())))?,
                    "lines" => Value::Array(
                        String::from_utf8_lossy(&bytes).lines().map(|line| Value::String(line.to_string())).collect(),
                    ),
                    "base64" => Value::String(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                    _ => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
                };
                let target = text(params, "target");
                set_path(&mut json, if target.trim().is_empty() { "content" } else { target.trim() }, content);
                set_path(&mut json, "file", describe(&path));
            }
        }
        out.push(paired_item(ctx, index, json));
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------------- list

/// More entries than this in one listing is a folder somebody pointed at by mistake (`/`).
const MAX_ENTRIES: usize = 50_000;

fn walk(dir: &Path, recursive: bool, depth: usize, found: &mut Vec<PathBuf>) -> Result<(), NodeError> {
    let entries = std::fs::read_dir(dir).map_err(|e| NodeError::failed(format!("Could not list {}: {e}", dir.display())))?;
    for entry in entries.flatten() {
        if found.len() >= MAX_ENTRIES {
            return Err(NodeError::failed(format!("{} holds more than {MAX_ENTRIES} entries", dir.display())));
        }
        let path = entry.path();
        // A link is listed as itself and never followed: a link to `..` would otherwise list forever.
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        found.push(path.clone());
        if recursive && is_dir && depth < 32 {
            walk(&path, true, depth + 1, found)?;
        }
    }
    Ok(())
}

async fn list(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let folder = need_path(&params, "folder", "folder to list")?;
    if !folder.is_dir() {
        return Err(NodeError::failed(format!("{} is not a folder", folder.display())));
    }
    let pattern = text(&params, "pattern");
    let matcher: Option<GlobMatcher> = if pattern.trim().is_empty() || pattern.trim() == "*" {
        None
    } else {
        Some(Glob::new(pattern.trim()).map_err(|e| NodeError::failed(format!("\"{pattern}\" is not a pattern: {e}")))?.compile_matcher())
    };
    let recursive = flag(&params, "recursive");
    let include = text(&params, "entryKinds");
    let newer = number(&params, "newerThanMinutes").unwrap_or(0.0).max(0.0);
    let older_days = number(&params, "olderThanDays").unwrap_or(0.0).max(0.0);
    let limit = number(&params, "limit").unwrap_or(0.0).max(0.0) as usize;
    let root = folder.clone();
    let mut found = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        walk(&root, recursive, 0, &mut found).map(|_| found)
    })
    .await
    .map_err(|e| NodeError::failed(e.to_string()))??;
    let cutoff = (newer > 0.0).then(|| SystemTime::now() - Duration::from_secs_f64(newer * 60.0));
    // The other end: what has not changed for days — old backups to rotate, a cache to clean.
    let stale = (older_days > 0.0).then(|| SystemTime::now() - Duration::from_secs_f64(older_days * 86_400.0));
    found.retain(|path| {
        let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
        let kind_ok = match include.as_str() {
            "folders" => meta.is_dir(),
            "both" => true,
            _ => meta.is_file(),
        };
        let name_ok = matcher.as_ref().is_none_or(|matcher| {
            let relative = path.strip_prefix(&folder).unwrap_or(path);
            matcher.is_match(relative) || path.file_name().is_some_and(|name| matcher.is_match(name))
        });
        let time_ok = cutoff.is_none_or(|cutoff| meta.modified().is_ok_and(|modified| modified >= cutoff))
            && stale.is_none_or(|stale| meta.modified().is_ok_and(|modified| modified < stale));
        kind_ok && name_ok && time_ok
    });
    match text(&params, "sortBy").as_str() {
        "modified" => found.sort_by_key(|path| std::cmp::Reverse(std::fs::metadata(path).and_then(|m| m.modified()).ok())),
        "size" => found.sort_by_key(|path| std::cmp::Reverse(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))),
        _ => found.sort(),
    }
    if limit > 0 {
        found.truncate(limit);
    }
    if text(&params, "listOutput") == "listSummary" {
        // One item: how many, how big, the oldest and the newest — what a cleanup or an alert reads.
        let metas: Vec<(PathBuf, std::fs::Metadata)> = found.iter().filter_map(|p| std::fs::metadata(p).ok().map(|m| (p.clone(), m))).collect();
        let total: u64 = metas.iter().filter(|(_, m)| m.is_file()).map(|(_, m)| m.len()).sum();
        let by_time = |newest: bool| {
            metas
                .iter()
                .filter_map(|(p, m)| m.modified().ok().map(|t| (p, t)))
                .reduce(|a, b| if (b.1 > a.1) == newest { b } else { a })
                .map(|(p, t)| json!({"path": p.to_string_lossy(), "modified": chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()}))
        };
        return Ok(vec![vec![Item::new(json!({
            "folder": folder.to_string_lossy(),
            "count": metas.len(),
            "totalBytes": total,
            "totalSize": crate::containers::engine::human_bytes(total),
            "oldest": by_time(false),
            "newest": by_time(true),
            "paths": found.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        }))]]);
    }
    Ok(vec![found.iter().map(|path| Item::new(describe(path))).collect()])
}

// ------------------------------------------------------------------------------------------- move

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)?.flatten() {
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Clears the way for an overwrite: what is at `path` goes to the trash.
fn make_room(path: &Path, overwrite: bool) -> Result<(), NodeError> {
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    if !overwrite {
        return Err(NodeError::failed(format!("{} already exists (turn on «Overwrite» to replace it)", path.display())));
    }
    trash::delete(path).map_err(|e| NodeError::failed(format!("Could not move the old {} to the trash: {e}", path.display())))
}

async fn move_files(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let operation = ctx.param_str("operation");
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let source = need_path(params, "source", "path of the file or folder")?;
        if std::fs::symlink_metadata(&source).is_err() {
            return Err(NodeError::failed(format!("{} does not exist", source.display())));
        }
        let overwrite = flag(params, "overwrite");
        let mut json = base_json(ctx, index);
        match operation.as_str() {
            "trash" => {
                trash::delete(&source).map_err(|e| NodeError::failed(format!("Could not move {} to the trash: {e}", source.display())))?;
                set_path(&mut json, "trashed", json!(source.to_string_lossy()));
            }
            "rename" => {
                let name = text(params, "newName");
                let name = name.trim();
                if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
                    return Err(NodeError::failed("Write the new name (a name, not a path)"));
                }
                let target = source.with_file_name(name);
                make_room(&target, overwrite)?;
                std::fs::rename(&source, &target).map_err(|e| NodeError::failed(format!("Could not rename: {e}")))?;
                set_path(&mut json, "file", describe(&target));
            }
            _ => {
                let destination = need_path(params, "destPath", "destination")?;
                // Into a folder when it exists or the path ends in a separator (`…/procesados/`);
                // otherwise the destination is the new path itself, as `mv` reads it.
                let into_folder = destination.is_dir() || text(params, "destPath").trim_end().ends_with(['/', '\\']);
                let target = if into_folder { destination.join(source.file_name().unwrap_or_default()) } else { destination };
                if target == source {
                    return Err(NodeError::failed("The destination is the file itself"));
                }
                if source.is_dir() && target.starts_with(&source) {
                    return Err(NodeError::failed("A folder cannot go inside itself"));
                }
                make_room(&target, overwrite)?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(format!("Could not create {}: {e}", parent.display())))?;
                }
                if operation == "copy" {
                    copy_tree(&source, &target).map_err(|e| NodeError::failed(format!("Could not copy: {e}")))?;
                } else if std::fs::rename(&source, &target).is_err() {
                    // Another volume: a copy, then the original to the trash.
                    copy_tree(&source, &target).map_err(|e| NodeError::failed(format!("Could not move: {e}")))?;
                    trash::delete(&source).map_err(|e| NodeError::failed(format!("Copied, but could not move the original to the trash: {e}")))?;
                }
                set_path(&mut json, "file", describe(&target));
            }
        }
        out.push(paired_item(ctx, index, json));
    }
    Ok(vec![out])
}

// -------------------------------------------------------------------------------------------- git

const GIT_ENV: [(&str, &str); 2] = [("GIT_TERMINAL_PROMPT", "0"), ("GIT_EDITOR", "true")];

fn git_env() -> Vec<(String, String)> {
    GIT_ENV.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

async fn repo_folder(ctx: &NodeCtx, params: &Value) -> Result<PathBuf, NodeError> {
    let project = text(params, "project");
    let path = if !project.trim().is_empty() {
        PathBuf::from(ctx.run.host.project_path(&project).map_err(NodeError::Failed)?)
    } else {
        need_path(params, "repoPath", "repository's folder")?
    };
    if !path.join(".git").exists() && git2::Repository::discover(&path).is_err() {
        return Err(NodeError::failed(format!("{} is not a git repository", path.display())));
    }
    Ok(path)
}

/// `git status --porcelain=v2 --branch` as an object.
pub fn parse_status(output: &str) -> Value {
    let mut branch = Value::Null;
    let mut upstream = Value::Null;
    let (mut ahead, mut behind) = (0i64, 0i64);
    let mut files = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = json!(rest);
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = json!(rest);
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            files.push(json!({"path": rest, "status": "untracked"}));
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
            let fields: Vec<&str> = line.splitn(if line.starts_with("2 ") { 10 } else { 9 }, ' ').collect();
            let xy = fields.get(1).copied().unwrap_or("..");
            let path = fields.last().copied().unwrap_or_default();
            let path = path.split('\t').next().unwrap_or(path);
            let staged = xy.chars().next().is_some_and(|c| c != '.');
            let unstaged = xy.chars().nth(1).is_some_and(|c| c != '.');
            files.push(json!({
                "path": path,
                "status": if line.starts_with("u ") { "conflicted" } else if line.starts_with("2 ") { "renamed" } else { "modified" },
                "xy": xy,
                "staged": staged,
                "unstaged": unstaged,
            }));
        }
    }
    json!({
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "clean": files.is_empty(),
        "files": files,
    })
}

async fn git(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let operation = text(&params, "operation");
    if operation == "clone" {
        return clone(ctx, &params).await;
    }
    let repo = repo_folder(ctx, &params).await?;
    let remote = {
        let remote = text(&params, "remote");
        if remote.trim().is_empty() { "origin".to_string() } else { remote.trim().to_string() }
    };
    let run = |args: Vec<String>| run_program(ctx, "git", args, Some(repo.clone()), git_env(), None);
    let repo_text = repo.to_string_lossy().into_owned();
    let result = match operation.as_str() {
        "makeCommit" => {
            let message = text(&params, "message");
            if message.trim().is_empty() {
                return Err(NodeError::failed("Write the commit message"));
            }
            crate::git::branch::guard_head_unlocked_at(&repo_text).map_err(NodeError::Failed)?;
            if flag(&params, "stageAll") {
                run(vec!["add".into(), "-A".into()]).await?.ok_or_fail("git add")?;
            }
            run(vec!["commit".into(), "-m".into(), message]).await?.ok_or_fail("git commit")?;
            let sha = run(vec!["rev-parse".into(), "HEAD".into()]).await?.ok_or_fail("git rev-parse")?;
            json!({"committed": true, "sha": sha.stdout.trim()})
        }
        "pull" => {
            let output = run(vec!["pull".into(), "--ff-only".into(), remote.clone()]).await?.ok_or_fail("git pull")?;
            json!({"output": output.stdout.trim(), "remote": remote})
        }
        "push" => {
            crate::git::branch::guard_head_unlocked_at(&repo_text).map_err(NodeError::Failed)?;
            let mut args = vec!["push".to_string(), remote.clone()];
            let branch = text(&params, "branch");
            if !branch.trim().is_empty() {
                args.push(branch.trim().to_string());
            }
            if flag(&params, "pushTags") {
                args.push("--tags".into());
            }
            let output = run(args).await?.ok_or_fail("git push")?;
            json!({"output": format!("{}{}", output.stdout.trim(), output.stderr.trim()), "remote": remote})
        }
        "fetch" => {
            run(vec!["fetch".into(), "--prune".into(), remote.clone()]).await?.ok_or_fail("git fetch")?;
            json!({"fetched": remote})
        }
        "checkout" => {
            let name = text(&params, "branch");
            if name.trim().is_empty() {
                return Err(NodeError::failed("Write the branch name"));
            }
            let mut args = vec!["switch".to_string()];
            if flag(&params, "create") {
                args.push("-c".into());
            }
            args.push(name.trim().to_string());
            run(args).await?.ok_or_fail("git switch")?;
            json!({"branch": name.trim()})
        }
        "createTag" => {
            let name = text(&params, "tag");
            if name.trim().is_empty() {
                return Err(NodeError::failed("Write the tag name"));
            }
            let message = text(&params, "message");
            let mut args = vec!["tag".to_string()];
            if !message.trim().is_empty() {
                args.extend(["-a".into(), name.trim().to_string(), "-m".into(), message]);
            } else {
                args.push(name.trim().to_string());
            }
            run(args).await?.ok_or_fail("git tag")?;
            json!({"tag": name.trim()})
        }
        "diff" => {
            let base = text(&params, "base");
            let mut args = vec!["diff".to_string(), "--no-color".to_string()];
            if !base.trim().is_empty() {
                args.push(format!("{}...HEAD", base.trim()));
            }
            let output = run(args).await?.ok_or_fail("git diff")?;
            json!({"diff": output.stdout})
        }
        "log" => {
            let count = number(&params, "maxCount").unwrap_or(20.0).clamp(1.0, 5000.0) as u32;
            let mut args = vec!["log".to_string(), format!("-n{count}"), "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s".into()];
            // `v1.2.0..HEAD`: the commits a release is made of — what release notes are written from.
            let range = text(&params, "logRange");
            if !range.trim().is_empty() {
                if range.trim().starts_with('-') {
                    return Err(NodeError::failed("The range is a revision range, not a flag"));
                }
                args.push(range.trim().to_string());
            }
            let output = run(args).await?.ok_or_fail("git log")?;
            let commits: Vec<Value> = output
                .stdout
                .lines()
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split('\u{1f}').collect();
                    (parts.len() == 5).then(|| json!({"sha": parts[0], "author": parts[1], "email": parts[2], "date": parts[3], "subject": parts[4]}))
                })
                .collect();
            return Ok(vec![commits.into_iter().map(Item::new).collect()]);
        }
        "mergeBranch" => {
            let branch = need_ref(&params, "branch", "branch to merge")?;
            crate::git::branch::guard_head_unlocked_at(&repo_text).map_err(NodeError::Failed)?;
            require_clean_state(&repo)?;
            let mut args = vec!["merge".to_string()];
            if flag(&params, "ffOnly") {
                args.push("--ff-only".into());
            } else {
                args.push("--no-edit".into());
            }
            args.push(branch.clone());
            let output = run(args).await?;
            if output.code != Some(0) {
                // A conflicted merge is undone, so the repository is never left half-merged by a flow.
                if left_half_done(&repo) {
                    let _ = run(vec!["merge".into(), "--abort".into()]).await;
                }
                return Err(failure(output, "git merge"));
            }
            json!({"merged": branch, "output": output.stdout.trim()})
        }
        "rebaseOnto" => {
            let branch = need_ref(&params, "branch", "branch to rebase onto")?;
            crate::git::branch::guard_head_unlocked_at(&repo_text).map_err(NodeError::Failed)?;
            require_clean_state(&repo)?;
            let output = run(vec!["rebase".into(), branch.clone()]).await?;
            if output.code != Some(0) {
                if left_half_done(&repo) {
                    let _ = run(vec!["rebase".into(), "--abort".into()]).await;
                }
                return Err(failure(output, "git rebase"));
            }
            json!({"rebasedOnto": branch, "output": output.stdout.trim()})
        }
        "stashPush" => {
            let mut args = vec!["stash".to_string(), "push".into(), "--include-untracked".into()];
            let message = text(&params, "message");
            if !message.trim().is_empty() {
                args.extend(["-m".into(), message.trim().to_string()]);
            }
            let output = run(args).await?.ok_or_fail("git stash")?;
            json!({"stashed": !output.stdout.contains("No local changes"), "output": output.stdout.trim()})
        }
        "stashPop" => {
            let output = run(vec!["stash".into(), "pop".into()]).await?.ok_or_fail("git stash pop")?;
            json!({"output": output.stdout.trim()})
        }
        "cherryPick" | "revertCommit" => {
            let shas: Vec<String> = text(&params, "shas").split([',', ' ', '\n']).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect();
            if shas.is_empty() {
                return Err(NodeError::failed("Write the commits (their sha)"));
            }
            if shas.iter().any(|sha| sha.starts_with('-')) {
                return Err(NodeError::failed("A commit is a sha, not a flag"));
            }
            crate::git::branch::guard_head_unlocked_at(&repo_text).map_err(NodeError::Failed)?;
            require_clean_state(&repo)?;
            let verb = if operation == "cherryPick" { "cherry-pick" } else { "revert" };
            let mut args = vec![verb.to_string()];
            if verb == "revert" {
                args.push("--no-edit".into());
            }
            args.extend(shas.iter().cloned());
            let output = run(args).await?;
            if output.code != Some(0) {
                if left_half_done(&repo) {
                    let _ = run(vec![verb.into(), "--abort".into()]).await;
                }
                return Err(failure(output, &format!("git {verb}")));
            }
            json!({"applied": shas, "output": output.stdout.trim()})
        }
        "deleteBranch" => {
            let branch = need_ref(&params, "branch", "branch to delete")?;
            // A locked branch is not deleted by a flow, here or on the remote — the app refuses the
            // remote half the same way (`remote::delete_remote_branch`): the lock keeps pushes off a
            // branch, and a deletion is the most final push there is. Asked of the branch named,
            // not of HEAD, which is never the branch being deleted.
            crate::git::branch::guard_branch_unlocked_at(&repo_text, &branch).map_err(NodeError::Failed)?;
            let local = run(vec!["branch".into(), if flag(&params, "forceDelete") { "-D".into() } else { "-d".into() }, branch.clone()]).await?.ok_or_fail("git branch -d")?;
            let mut remote_out = String::new();
            if flag(&params, "deleteRemote") {
                remote_out = run(vec!["push".into(), remote.clone(), "--delete".into(), branch.clone()]).await?.ok_or_fail("git push --delete")?.stderr;
            }
            json!({"deleted": branch, "output": format!("{}{}", local.stdout.trim(), remote_out.trim())})
        }
        "branches" => {
            let output = run(vec![
                "for-each-ref".into(),
                "--sort=-committerdate".into(),
                "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(authorname)%1f%(upstream:short)%1f%(upstream:track)".into(),
                "refs/heads".into(),
            ])
            .await?
            .ok_or_fail("git for-each-ref")?;
            let merged_into = text(&params, "mergedInto");
            let merged: std::collections::HashSet<String> = if merged_into.trim().is_empty() {
                Default::default()
            } else {
                run(vec!["branch".into(), "--format=%(refname:short)".into(), "--merged".into(), merged_into.trim().to_string()])
                    .await?
                    .ok_or_fail("git branch --merged")?
                    .stdout
                    .lines()
                    .map(|l| l.trim().to_string())
                    .collect()
            };
            let stale_days = number(&params, "staleDays").unwrap_or(0.0).max(0.0);
            let now = chrono::Utc::now();
            let current = super::super::triggers::current_branch(&repo_text);
            let items: Vec<Item> = output
                .stdout
                .lines()
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split('\u{1f}').collect();
                    if parts.len() < 6 {
                        return None;
                    }
                    let date = chrono::DateTime::parse_from_rfc3339(parts[2]).ok()?;
                    let age_days = (now - date.with_timezone(&chrono::Utc)).num_days();
                    if stale_days > 0.0 && (age_days as f64) < stale_days {
                        return None;
                    }
                    let name = parts[0].to_string();
                    if !merged_into.trim().is_empty() && (!merged.contains(&name) || name == merged_into.trim()) {
                        return None;
                    }
                    Some(Item::new(json!({
                        "branch": name,
                        "sha": parts[1],
                        "lastCommit": parts[2],
                        "ageDays": age_days,
                        "author": parts[3],
                        "upstream": parts[4],
                        "tracking": parts[5],
                        "current": parts[0] == current,
                        "merged": merged.contains(parts[0]),
                    })))
                })
                .collect();
            return Ok(vec![items]);
        }
        "tags" => {
            let count = number(&params, "maxCount").unwrap_or(20.0).clamp(1.0, 5000.0) as usize;
            let output = run(vec![
                "for-each-ref".into(),
                "--sort=-creatordate".into(),
                "--format=%(refname:short)%1f%(objectname)%1f%(creatordate:iso-strict)%1f%(subject)".into(),
                "refs/tags".into(),
            ])
            .await?
            .ok_or_fail("git for-each-ref")?;
            let items: Vec<Item> = output
                .stdout
                .lines()
                .take(count)
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split('\u{1f}').collect();
                    (parts.len() >= 4).then(|| Item::new(json!({"tag": parts[0], "sha": parts[1], "date": parts[2], "subject": parts[3]})))
                })
                .collect();
            return Ok(vec![items]);
        }
        _ => {
            let output = run(vec!["status".into(), "--porcelain=v2".into(), "--branch".into()]).await?.ok_or_fail("git status")?;
            parse_status(&output.stdout)
        }
    };
    let mut json = result;
    if let Value::Object(map) = &mut json {
        map.insert("repository".into(), json!(repo_text));
    }
    Ok(vec![vec![if ctx.items().is_empty() { Item::new(json) } else { Item::paired(json, 0) }]])
}

/// Refuses to start a merge, rebase, cherry-pick or revert while the repository is in the middle of
/// one already. That one is somebody's — most likely the user's, conflicts half resolved by hand —
/// and the `--abort` that undoes a failed step of a flow would throw their work away with its own.
fn require_clean_state(repo: &Path) -> Result<(), NodeError> {
    let state = git2::Repository::discover(repo).map_err(|e| NodeError::failed(e.message().to_string()))?.state();
    if state == git2::RepositoryState::Clean {
        return Ok(());
    }
    Err(NodeError::failed(format!(
        "{} has a {} in progress — finish it or abort it first; a flow does not start another on top of it",
        repo.display(),
        state_name(state)
    )))
}

/// Whether the step that just failed left an operation half done. The repository was clean when it
/// started (`require_clean_state`), so whatever is in progress now is the step's own — the only thing
/// its `--abort` may undo. A step that failed before starting one (a branch that does not exist, a
/// working tree git would not touch) has nothing to abort.
fn left_half_done(repo: &Path) -> bool {
    git2::Repository::discover(repo).is_ok_and(|repository| repository.state() != git2::RepositoryState::Clean)
}

fn state_name(state: git2::RepositoryState) -> &'static str {
    use git2::RepositoryState as State;
    match state {
        State::Merge => "merge",
        State::Revert | State::RevertSequence => "revert",
        State::CherryPick | State::CherryPickSequence => "cherry-pick",
        State::Rebase | State::RebaseInteractive | State::RebaseMerge | State::ApplyMailboxOrRebase => "rebase",
        State::ApplyMailbox => "git am",
        State::Bisect => "bisect",
        State::Clean => "clean state",
    }
}

/// A failed command as the node's error, in `ok_or_fail`'s words.
fn failure(output: super::process::ProgramOutput, label: &str) -> NodeError {
    output.ok_or_fail(label).err().unwrap_or_else(|| NodeError::failed(format!("{label} failed")))
}

/// A branch or ref the user wrote — never one that git would read as a flag.
fn need_ref(params: &Value, name: &str, what: &str) -> Result<String, NodeError> {
    let value = text(params, name).trim().to_string();
    if value.is_empty() {
        return Err(NodeError::failed(format!("Write the {what}")));
    }
    if value.starts_with('-') {
        return Err(NodeError::failed(format!("\"{value}\" is not a branch")));
    }
    Ok(value)
}

/// `git clone` into a folder (made when missing; refused when it already holds a repository).
async fn clone(ctx: &NodeCtx, params: &Value) -> Result<Ports, NodeError> {
    let url = text(params, "cloneUrl").trim().to_string();
    if url.is_empty() || url.starts_with('-') {
        return Err(NodeError::failed("Write the repository's URL"));
    }
    let into = need_path(params, "cloneInto", "folder to clone into")?;
    let name = url.trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or("repo").trim_end_matches(".git").to_string();
    // A folder that exists and has things in it gets the repository inside it, the way `git clone` would.
    let target = if into.exists() && std::fs::read_dir(&into).map(|mut d| d.next().is_some()).unwrap_or(false) { into.join(&name) } else { into.clone() };
    if target.join(".git").exists() {
        return Err(NodeError::failed(format!("{} is already a repository", target.display())));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(e.to_string()))?;
    }
    let mut args = vec!["clone".to_string()];
    let depth = number(params, "depth").unwrap_or(0.0);
    if depth >= 1.0 {
        args.push(format!("--depth={}", depth as u64));
    }
    let branch = text(params, "branch");
    if !branch.trim().is_empty() {
        if branch.trim().starts_with('-') {
            return Err(NodeError::failed("The branch is a name, not a flag"));
        }
        args.extend(["--branch".into(), branch.trim().to_string()]);
    }
    args.push("--".into());
    args.push(url.clone());
    args.push(target.to_string_lossy().into_owned());
    run_program(ctx, "git", args, None, git_env(), None).await?.ok_or_fail("git clone")?;
    let head = super::super::triggers::current_branch(&target.to_string_lossy());
    let json = json!({"cloned": url, "path": target.to_string_lossy(), "branch": head});
    Ok(vec![vec![if ctx.items().is_empty() { Item::new(json) } else { Item::paired(json, 0) }]])
}

// ----------------------------------------------------------------------------------------- docker

async fn docker(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let each = ctx.param_str("runFor") == "each";
    let resolved = if each { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let mode = text(params, "mode");
        let mut args: Vec<String> = Vec::new();
        let mut cwd = None;
        match mode.as_str() {
            "exec" => {
                let container = text(params, "container");
                if container.trim().is_empty() {
                    return Err(NodeError::failed("Write the container's name"));
                }
                args.extend(["exec".into()]);
                for (name, value) in pairs(params, "env") {
                    args.extend(["-e".into(), format!("{name}={value}")]);
                }
                args.push(container.trim().to_string());
                args.extend(["sh".into(), "-c".into(), text(params, "command")]);
            }
            "compose" => {
                let file = need_path(params, "composeFile", "compose file")?;
                cwd = file.parent().map(Path::to_path_buf);
                args.extend(["compose".into(), "-f".into(), file.to_string_lossy().into_owned()]);
                match text(params, "composeAction").as_str() {
                    "down" => args.push("down".into()),
                    "ps" => args.extend(["ps".into(), "--format".into(), "json".into()]),
                    "logs" => args.extend(["logs".into(), "--no-color".into(), "--tail".into(), "200".into()]),
                    _ => args.extend(["up".into(), "-d".into()]),
                }
            }
            _ => {
                let image = text(params, "image");
                if image.trim().is_empty() {
                    return Err(NodeError::failed("Write the image to run"));
                }
                args.push("run".into());
                if flag(params, "remove") {
                    args.push("--rm".into());
                }
                for (name, value) in pairs(params, "env") {
                    args.extend(["-e".into(), format!("{name}={value}")]);
                }
                for (host, container) in pairs(params, "volumes") {
                    args.extend(["-v".into(), format!("{}:{container}", expand(&host).display())]);
                }
                let workdir = text(params, "workdir");
                if !workdir.trim().is_empty() {
                    args.extend(["-w".into(), workdir.trim().to_string()]);
                }
                let network = text(params, "network");
                if !network.trim().is_empty() {
                    args.extend(["--network".into(), network.trim().to_string()]);
                }
                args.push(image.trim().to_string());
                args.extend(strings(params, "args"));
            }
        }
        let output = run_program(ctx, "docker", args, cwd, Vec::new(), None).await?;
        out.extend(output_items(ctx, params, output, (each && !ctx.items().is_empty()).then_some(index))?);
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reads_branch_counts_and_files() {
        let out = "# branch.oid 4f2c1a9\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n\
                   1 .M N... 100644 100644 100644 abc def src/a.ts\n1 M. N... 100644 100644 100644 abc def b.md\n? new.txt\n";
        let status = parse_status(out);
        assert_eq!(status["branch"], "main");
        assert_eq!(status["upstream"], "origin/main");
        assert_eq!(status["ahead"], 2);
        assert_eq!(status["behind"], 1);
        assert_eq!(status["clean"], false);
        assert_eq!(status["files"][0], json!({"path": "src/a.ts", "status": "modified", "xy": ".M", "staged": false, "unstaged": true}));
        assert_eq!(status["files"][1]["staged"], true);
        assert_eq!(status["files"][2], json!({"path": "new.txt", "status": "untracked"}));
        assert_eq!(parse_status("# branch.head main\n")["clean"], true);
    }

    #[test]
    fn a_repository_mid_operation_is_refused_and_only_a_flows_own_step_is_aborted() {
        let dir = std::env::temp_dir().join(format!("cf-files-git-{}", uuid::Uuid::new_v4()));
        git2::Repository::init(&dir).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        assert!(require_clean_state(&dir).is_ok());
        assert!(!left_half_done(&dir), "a failure that started nothing has nothing to abort");

        // The user's merge, conflicts half resolved: a flow neither starts on top of it nor aborts it.
        std::fs::write(dir.join(".git/MERGE_HEAD"), "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n").unwrap();
        let refused = require_clean_state(&dir).unwrap_err();
        assert!(matches!(refused, NodeError::Failed(ref text) if text.contains("merge in progress")), "{refused:?}");
        assert!(require_clean_state(&dir.join("src")).is_err(), "a folder inside the repository answers for it");
        assert!(left_half_done(&dir));

        std::fs::remove_file(dir.join(".git/MERGE_HEAD")).unwrap();
        std::fs::create_dir_all(dir.join(".git/rebase-merge")).unwrap();
        let refused = require_clean_state(&dir).unwrap_err();
        assert!(matches!(refused, NodeError::Failed(ref text) if text.contains("rebase in progress")), "{refused:?}");

        std::fs::remove_dir_all(dir.join(".git/rebase-merge")).unwrap();
        std::fs::write(dir.join(".git/CHERRY_PICK_HEAD"), "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n").unwrap();
        let refused = require_clean_state(&dir).unwrap_err();
        assert!(matches!(refused, NodeError::Failed(ref text) if text.contains("cherry-pick in progress")), "{refused:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_whole_write_replaces_and_checks_the_size() {
        let dir = std::env::temp_dir().join(format!("cf-files-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested/out.txt");
        assert!(write_whole(&path, b"hola", false).is_err(), "no folder, not told to create it");
        write_whole(&path, b"hola", true).unwrap();
        write_whole(&path, b"chao", true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "chao");
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1, "no temporary file left behind");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(expand("~/x"), dirs::home_dir().unwrap().join("x"));
    }
}
