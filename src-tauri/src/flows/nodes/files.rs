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
    let limit = number(&params, "limit").unwrap_or(0.0).max(0.0) as usize;
    let root = folder.clone();
    let mut found = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        walk(&root, recursive, 0, &mut found).map(|_| found)
    })
    .await
    .map_err(|e| NodeError::failed(e.to_string()))??;
    let cutoff = (newer > 0.0).then(|| SystemTime::now() - Duration::from_secs_f64(newer * 60.0));
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
        let time_ok = cutoff.is_none_or(|cutoff| meta.modified().is_ok_and(|modified| modified >= cutoff));
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
    let repo = repo_folder(ctx, &params).await?;
    let operation = text(&params, "operation");
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
            let count = number(&params, "maxCount").unwrap_or(20.0).clamp(1.0, 1000.0) as u32;
            let output = run(vec![
                "log".into(),
                format!("-n{count}"),
                "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s".into(),
            ])
            .await?
            .ok_or_fail("git log")?;
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
