//! What the local agent can do to a working copy, and the fences around it.
//!
//! Every path the model names is resolved through the same guards the editor's saves and the hybrid
//! executor go through (`fsops::resolve_existing_for_write`, `fsops::resolve_path_for_create`):
//! `..` is refused before anything is looked up, and a link must lead somewhere inside the root.
//! A model cannot be talked into reading `~/.ssh` or writing outside the repository any more than a
//! click in the file tree can.
//!
//! **What is on offer is the permission.** A read-only run is given the read tools and nothing else
//! — not "asked not to write": the write tools do not exist in its request, and [`Toolbox::call`]
//! refuses them by name as well, for a model that invents a call it was never offered. That is why
//! `CodeFlowEngine::enforces_read_only` can honestly answer yes, which no CLI that merely takes a
//! "please don't" flag can.
//!
//! Output is sized for a small model's window: a file comes back a few hundred lines at a time with
//! line numbers, a search a few dozen hits, a command its last few kilobytes. Each says what it left
//! out, so the model can ask for the next part instead of assuming it saw everything.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::{fsops, search};

/// Lines `read_file` returns when the model names no range.
const READ_LINES: usize = 300;
/// …and the characters, whichever runs out first — a minified file is one enormous line.
const READ_CHARS: usize = 24_000;
/// Hits `search` returns.
const SEARCH_HITS: usize = 60;
/// Names `find_files` returns.
const FIND_RESULTS: usize = 200;
/// Entries `list_files` returns.
const LIST_ENTRIES: usize = 300;
/// The tail of a command's output that goes back to the model.
const COMMAND_OUTPUT_CHARS: usize = 8_000;
/// How long a command may run.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Files a non-git folder is walked for, at most — a chat's own folder, not a whole disk.
const PLAIN_WALK_LIMIT: usize = 5_000;
/// Folders never walked in a non-git folder; a repository's own ignore rules cover the git case.
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__"];

/// What a run may do, decided once from the invocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grants {
    pub write: bool,
    pub run: bool,
}

pub struct Toolbox {
    root: PathBuf,
    root_str: String,
    git: bool,
    grants: Grants,
    /// Files `read_file` has shown this run. An existing file can only be edited or rewritten once
    /// it is in here — Claude Code's rule, and for the same reason: a model that has not looked at
    /// a file rewrites it from imagination. Seen live: a 7B replaced a README it had never opened.
    read: std::sync::Mutex<std::collections::HashSet<String>>,
}

/// One tool call's result: the text the model reads, and a short line for the run log.
pub struct Outcome {
    pub content: String,
    pub summary: String,
    pub ok: bool,
    /// Lines added and removed, for a call that wrote.
    pub changed: Option<(i64, i64)>,
}

impl Outcome {
    fn ok(content: String, summary: String) -> Self {
        Self { content, summary, ok: true, changed: None }
    }

    fn err(message: impl Into<String>) -> Self {
        let message = message.into();
        Self { content: format!("Error: {message}"), summary: message, ok: false, changed: None }
    }
}

impl Toolbox {
    pub fn new(root: &str, grants: Grants) -> Result<Self, String> {
        let root_path = Path::new(root).canonicalize().map_err(|e| format!("invalid working folder {root}: {e}"))?;
        let git = git2::Repository::open(&root_path).ok().and_then(|repo| repo.workdir().map(Path::to_path_buf)).is_some_and(|workdir| {
            workdir.canonicalize().is_ok_and(|workdir| workdir == root_path)
        });
        Ok(Self { root_str: root_path.to_string_lossy().to_string(), root: root_path, git, grants, read: Default::default() })
    }

    pub fn grants(&self) -> Grants {
        self.grants
    }

    /// The project's files, as a list the model reads before its first step — a small model that
    /// can *see* `src/cart.js` opens it, where one that has to discover it searches for prose. Cut
    /// at `max` names, and says so.
    pub fn file_map(&self, max: usize) -> String {
        let files = self.files().unwrap_or_default();
        if files.is_empty() {
            return "(no files)".to_string();
        }
        let mut map = files.iter().take(max).map(String::as_str).collect::<Vec<_>>().join("\n");
        if files.len() > max {
            map.push_str(&format!("\n… and {} more files (use find_files)", files.len() - max));
        }
        map
    }

    /// The tool schemas, OpenAI-shaped, for what this run may do.
    pub fn schemas(&self) -> Vec<Value> {
        let mut tools = vec![
            tool(
                "list_files",
                "List the files and folders in one folder of the project (one level). Folders end with '/'.",
                json!({ "path": { "type": "string", "description": "Folder relative to the project root; empty for the root." } }),
                &[],
            ),
            tool(
                "find_files",
                "Find files by name or glob anywhere in the project, e.g. '*.ts', 'src/**/*.rs', 'package.json'.",
                json!({ "pattern": { "type": "string", "description": "A file name or glob." } }),
                &["pattern"],
            ),
            tool(
                "read_file",
                "Read a text file, with line numbers. Long files come back in parts: use start_line to read further.",
                json!({
                    "path": { "type": "string", "description": "File path relative to the project root." },
                    "start_line": { "type": "integer", "description": "First line to read, 1-based. Optional." },
                    "end_line": { "type": "integer", "description": "Last line to read. Optional." }
                }),
                &["path"],
            ),
            tool(
                "search",
                "Search the text of every file in the project. Returns path:line: text for each match.",
                json!({
                    "query": { "type": "string", "description": "Text to look for (or a regular expression when regex is true)." },
                    "regex": { "type": "boolean", "description": "Treat query as a regular expression." },
                    "include": { "type": "string", "description": "Comma-separated globs limiting the files searched, e.g. 'src/**, *.ts'." }
                }),
                &["query"],
            ),
        ];
        if self.grants.write {
            tools.push(tool(
                "edit_file",
                "Replace text in an existing file. old_text must match the file exactly (whitespace included) and be unique unless replace_all is true. Read the file first.",
                json!({
                    "path": { "type": "string", "description": "File path relative to the project root." },
                    "old_text": { "type": "string", "description": "The exact text to replace." },
                    "new_text": { "type": "string", "description": "What to put instead." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence." }
                }),
                &["path", "old_text", "new_text"],
            ));
            tools.push(tool(
                "write_file",
                "Create a file, or replace a whole file, with the given content. Prefer edit_file for small changes to an existing file.",
                json!({
                    "path": { "type": "string", "description": "File path relative to the project root." },
                    "content": { "type": "string", "description": "The complete new content of the file." }
                }),
                &["path", "content"],
            ));
        }
        if self.grants.run {
            tools.push(tool(
                "run_command",
                "Run a shell command in the project root (tests, builds, git status…). Returns its exit code and the end of its output. Do not run interactive or never-ending commands.",
                json!({ "command": { "type": "string", "description": "The command line." } }),
                &["command"],
            ));
        }
        tools
    }

    /// Runs one call. Never panics and never returns `Err`: a failure is an answer the model reads
    /// and can correct, exactly like a CLI agent's tool error.
    pub async fn call(&self, name: &str, args: &Value, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Outcome {
        let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        match name {
            "list_files" => self.list_files(&text("path")),
            "find_files" => self.find_files(&text("pattern")),
            "read_file" => self.read_file(&text("path"), line_arg(args, "start_line"), line_arg(args, "end_line")),
            "search" => self.search(&text("query"), args.get("regex").and_then(Value::as_bool).unwrap_or(false), &text("include")),
            "edit_file" | "write_file" if !self.grants.write => {
                Outcome::err("this conversation is read-only: files cannot be changed here")
            }
            "edit_file" => self.edit_file(
                &text("path"),
                &text("old_text"),
                &text("new_text"),
                args.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
            ),
            "write_file" => self.write_file(&text("path"), &text("content")),
            "run_command" if !self.grants.run => Outcome::err("commands cannot be run in this conversation"),
            "run_command" => self.run_command(&text("command"), cancel).await,
            other => Outcome::err(format!("there is no tool named {other:?}")),
        }
    }

    fn list_files(&self, path: &str) -> Outcome {
        let rel = clean_rel(path);
        let sub = (!rel.is_empty()).then(|| rel.clone());
        match fsops::list_dir(&self.root_str, sub) {
            Err(error) => Outcome::err(error),
            Ok(entries) => {
                let total = entries.len();
                let lines: Vec<String> = entries
                    .iter()
                    .take(LIST_ENTRIES)
                    .map(|entry| if entry.is_dir { format!("{}/", entry.path) } else { entry.path.clone() })
                    .collect();
                let mut content = if lines.is_empty() { "(empty folder)".to_string() } else { lines.join("\n") };
                if total > LIST_ENTRIES {
                    content.push_str(&format!("\n… and {} more entries", total - LIST_ENTRIES));
                }
                let shown = if rel.is_empty() { ".".to_string() } else { rel };
                Outcome::ok(content, format!("{shown} · {total}"))
            }
        }
    }

    fn files(&self) -> Result<Vec<String>, String> {
        if self.git {
            search::list_files(&self.root_str)
        } else {
            Ok(plain_walk(&self.root, PLAIN_WALK_LIMIT))
        }
    }

    fn find_files(&self, pattern: &str) -> Outcome {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.is_empty() {
            return Outcome::err("pattern is empty");
        }
        let glob = if pattern.contains('/') { pattern.to_string() } else { format!("**/{pattern}") };
        let matcher = match globset::GlobBuilder::new(&glob).case_insensitive(true).literal_separator(false).build() {
            Ok(glob) => glob.compile_matcher(),
            Err(error) => return Outcome::err(format!("invalid pattern: {error}")),
        };
        // A bare name with no wildcard also matches as a substring — `button` finds `Button.tsx`.
        let loose = (!pattern.contains(['*', '?', '[', '/'])).then(|| pattern.to_lowercase());
        let files = match self.files() {
            Ok(files) => files,
            Err(error) => return Outcome::err(error),
        };
        let hits: Vec<&String> = files
            .iter()
            .filter(|file| {
                matcher.is_match(file.as_str())
                    || loose.as_deref().is_some_and(|needle| {
                        file.rsplit('/').next().is_some_and(|name| name.to_lowercase().contains(needle))
                    })
            })
            .collect();
        let total = hits.len();
        let mut content = hits.iter().take(FIND_RESULTS).map(|s| s.as_str()).collect::<Vec<_>>().join("\n");
        if total == 0 {
            content = "No files match.".to_string();
        } else if total > FIND_RESULTS {
            content.push_str(&format!("\n… and {} more", total - FIND_RESULTS));
        }
        Outcome::ok(content, format!("{pattern} · {total}"))
    }

    fn read_file(&self, path: &str, start: Option<usize>, end: Option<usize>) -> Outcome {
        let rel = clean_rel(path);
        if rel.is_empty() {
            return Outcome::err("path is empty");
        }
        let full = match fsops::resolve_existing_for_write(&self.root_str, &rel) {
            Ok(full) => full,
            Err(error) => return Outcome::err(error),
        };
        if full.is_dir() {
            return Outcome::err(format!("{rel} is a folder — use list_files"));
        }
        let bytes = match std::fs::read(&full) {
            Ok(bytes) => bytes,
            Err(error) => return Outcome::err(format!("{rel}: {error}")),
        };
        if search::looks_binary(&bytes) {
            return Outcome::err(format!("{rel} is a binary file"));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let first = start.unwrap_or(1).max(1);
        if total > 0 && first > total {
            return Outcome::err(format!("{rel} has only {total} lines"));
        }
        let last = end.unwrap_or(first + READ_LINES - 1).min(total).max(first.min(total));
        let mut out = String::new();
        let mut shown_last = first.saturating_sub(1);
        for (index, line) in lines.iter().enumerate().take(last).skip(first - 1) {
            let row = format!("{:>5}\t{line}\n", index + 1);
            if out.len() + row.len() > READ_CHARS && !out.is_empty() {
                break;
            }
            out.push_str(&row);
            shown_last = index + 1;
        }
        if total == 0 {
            out = "(empty file)".to_string();
        } else if shown_last < total {
            out.push_str(&format!("… {} more lines — read_file with start_line {} to continue\n", total - shown_last, shown_last + 1));
        }
        if let Ok(mut read) = self.read.lock() {
            read.insert(rel.clone());
        }
        let range = if total == 0 { "0".to_string() } else { format!("{first}–{shown_last}/{total}") };
        Outcome::ok(out, format!("{rel} · {range}"))
    }

    fn search(&self, query: &str, regex: bool, include: &str) -> Outcome {
        let query = query.trim();
        if query.is_empty() {
            return Outcome::err("query is empty");
        }
        // `a|b` from a model that did not say regex is an alternation it meant, not a literal bar —
        // the first live run searched for "cart total|calculate total" as text and found nothing.
        let regex = regex || (query.contains('|') && regex::Regex::new(query).is_ok());
        let hits = if self.git {
            let options = search::SearchOptions { regex, include: include.to_string(), ..Default::default() };
            match search::search(&self.root_str, query, &options, SEARCH_HITS) {
                Ok(outcome) => (outcome.hits.into_iter().map(|hit| format!("{}:{}: {}", hit.path, hit.line_no, hit.line.trim())).collect::<Vec<_>>(), outcome.truncated),
                Err(error) => return Outcome::err(error),
            }
        } else {
            match plain_search(&self.root, query, regex, SEARCH_HITS) {
                Ok(found) => found,
                Err(error) => return Outcome::err(error),
            }
        };
        let (lines, truncated) = hits;
        let count = lines.len();
        let mut content = if lines.is_empty() { "No matches.".to_string() } else { lines.join("\n") };
        if truncated {
            content.push_str(&format!("\n… more matches not shown; narrow the query or use include"));
        }
        Outcome::ok(content, format!("{query} · {count}{}", if truncated { "+" } else { "" }))
    }

    fn edit_file(&self, path: &str, old: &str, new: &str, all: bool) -> Outcome {
        let rel = clean_rel(path);
        if old.is_empty() {
            return Outcome::err("old_text is empty — use write_file to create a file");
        }
        let full = match fsops::resolve_existing_for_write(&self.root_str, &rel) {
            Ok(full) => full,
            Err(error) => return Outcome::err(error),
        };
        let original = match std::fs::read_to_string(&full) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Outcome::err(format!("{rel} does not exist — use write_file to create it"))
            }
            Err(error) => return Outcome::err(format!("{rel}: {error}")),
        };
        // A file written with CRLF reads back with them, while a model writes `\n`: match on the
        // file's own line endings so an exact copy of what `read_file` showed is found.
        let crlf = original.contains("\r\n");
        let (old, new) = if crlf {
            (old.replace("\r\n", "\n").replace('\n', "\r\n"), new.replace("\r\n", "\n").replace('\n', "\r\n"))
        } else {
            (old.to_string(), new.to_string())
        };
        if !self.was_read(&rel) {
            return Outcome::err(format!("read {rel} with read_file before editing it"));
        }
        // The model copied `read_file`'s output line numbers along with the code (qwen3:8b did, ten
        // times in a row, on a live run): when the text as sent is not there, try it without them.
        let (old, new) = if !original.contains(old.as_str()) && has_line_numbers(&old) {
            (strip_line_numbers(&old), if has_line_numbers(&new) { strip_line_numbers(&new) } else { new })
        } else {
            (old, new)
        };
        let count = original.matches(old.as_str()).count();
        // Not there as written, but there line for line once indentation is ignored — the other way
        // a small model copies code (the line numbers stripped above usually take the indentation with
        // them). Applied only when exactly one block matches, keeping the file's own indentation.
        if count == 0 {
            if let Some(updated) = flexible_replace(&original, &old, &new) {
                return self.finish_edit(&rel, &full, &original, &updated, 1);
            }
        }
        if count == 0 {
            // The lines as they really are, around the one the model meant: a small model that
            // misremembers a line (qwen3:8b turned a `}` into a blank line, eight times running) cannot
            // fix that from "copy the text exactly", and is not allowed a third identical re-read.
            let hint = closest_line(&original, &old)
                .map(|(no, _)| {
                    let lines: Vec<&str> = original.lines().collect();
                    let from = no.saturating_sub(3);
                    let to = (no + 2).min(lines.len());
                    format!(
                        " Lines {}–{to} of the file are exactly:\n{}\nCopy old_text from these lines, without line numbers. One line is enough when it is unique.",
                        from + 1,
                        lines[from..to].join("\n")
                    )
                })
                .unwrap_or_else(|| " Read the file again and copy the text exactly.".to_string());
            let mut outcome = Outcome::err(format!("old_text was not found in {rel}."));
            outcome.content.push_str(&hint);
            return outcome;
        }
        if count > 1 && !all {
            return Outcome::err(format!(
                "old_text appears {count} times in {rel} — include more surrounding lines so it is unique, or set replace_all"
            ));
        }
        let updated = if all { original.replace(old.as_str(), &new) } else { original.replacen(old.as_str(), &new, 1) };
        self.finish_edit(&rel, &full, &original, &updated, count)
    }

    fn finish_edit(&self, rel: &str, full: &Path, original: &str, updated: &str, count: usize) -> Outcome {
        if let Err(error) = crate::hybrid::apply::write_atomic(full, updated) {
            return Outcome::err(format!("could not write {rel}: {error}"));
        }
        let (added, removed) = crate::hybrid::apply::line_stats(original, updated);
        let mut outcome = Outcome::ok(
            format!("Edited {rel}: {count} replacement{} (+{added} −{removed} lines).", if count == 1 { "" } else { "s" }),
            format!("{rel} · +{added} −{removed}"),
        );
        outcome.changed = Some((added, removed));
        outcome
    }

    fn write_file(&self, path: &str, content: &str) -> Outcome {
        let rel = clean_rel(path);
        if rel.is_empty() {
            return Outcome::err("path is empty");
        }
        let existing = fsops::resolve_existing_for_write(&self.root_str, &rel).ok().filter(|full| full.is_file());
        let (full, original) = match existing {
            Some(full) => {
                let original = std::fs::read_to_string(&full).ok();
                (full, original)
            }
            None => match fsops::resolve_path_for_create(&self.root_str, &rel) {
                Ok(full) => (full, None),
                Err(error) => return Outcome::err(error),
            },
        };
        if full.is_dir() {
            return Outcome::err(format!("{rel} is a folder"));
        }
        if original.is_some() && !self.was_read(&rel) {
            return Outcome::err(format!("{rel} already exists: read it with read_file first, then change it with edit_file"));
        }
        let text = crate::hybrid::apply::conform(original.as_deref(), content);
        if let Err(error) = crate::hybrid::apply::write_atomic(&full, &text) {
            return Outcome::err(format!("could not write {rel}: {error}"));
        }
        let (added, removed) = crate::hybrid::apply::line_stats(original.as_deref().unwrap_or(""), &text);
        let verb = if original.is_some() { "Rewrote" } else { "Created" };
        let mut outcome = Outcome::ok(format!("{verb} {rel} (+{added} −{removed} lines)."), format!("{rel} · +{added} −{removed}"));
        outcome.changed = Some((added, removed));
        outcome
    }

    fn was_read(&self, rel: &str) -> bool {
        self.read.lock().is_ok_and(|read| read.contains(rel))
    }

    async fn run_command(&self, command: &str, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Outcome {
        let command = command.trim();
        if command.is_empty() {
            return Outcome::err("command is empty");
        }
        let mut cmd = if cfg!(windows) {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.arg("/C").arg(command);
            cmd
        } else {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c").arg(command);
            cmd
        };
        cmd.current_dir(&self.root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        crate::ai::apply_command_path(&mut cmd);
        crate::proc::hide_console(&mut cmd);
        crate::proc::own_process_group(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => return Outcome::err(format!("could not start the command: {error}")),
        };
        let run_id = crate::ai_runs::current().map(|ctx| ctx.run_id);
        let _live = child.id().map(|pid| crate::ai_runs::register_process(pid, run_id.as_deref()));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let read = |pipe: Option<tokio::process::ChildStdout>| async move {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        let read_err = |pipe: Option<tokio::process::ChildStderr>| async move {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        let out_task = tokio::spawn(read(stdout));
        let err_task = tokio::spawn(read_err(stderr));
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = crate::ai_runs::cancelled(cancel) => {
                crate::ai_runs::kill_tree(&mut child).await;
                return Outcome::err("stopped");
            }
            _ = tokio::time::sleep(COMMAND_TIMEOUT) => {
                crate::ai_runs::kill_tree(&mut child).await;
                None
            }
        };
        let out = out_task.await.unwrap_or_default();
        let err = err_task.await.unwrap_or_default();
        let mut text = String::from_utf8_lossy(&out).to_string();
        let err = String::from_utf8_lossy(&err);
        if !err.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&err);
        }
        let text = crate::ai::strip_ansi(&text);
        let tail = tail_chars(&text, COMMAND_OUTPUT_CHARS);
        let shown = if tail.len() < text.len() { format!("… (earlier output cut)\n{tail}") } else { text.clone() };
        match status {
            None => Outcome {
                content: format!("The command did not finish within {} s and was stopped.\n{shown}", COMMAND_TIMEOUT.as_secs()),
                summary: format!("{command} · timeout"),
                ok: false,
                changed: None,
            },
            Some(status) => {
                let code = status.code().map_or("signal".to_string(), |code| code.to_string());
                Outcome {
                    content: format!("Exit code {code}.\n{}", if shown.trim().is_empty() { "(no output)".to_string() } else { shown }),
                    summary: format!("{command} · {code}"),
                    ok: status.success(),
                    changed: None,
                }
            }
        }
    }
}

/// `old` matched against `original` line by line with leading and trailing whitespace ignored; when
/// exactly one run of lines matches, it is replaced by `new`, each new line given the indentation of
/// the original line in its position (the last one's past the end) plus whatever indentation the
/// model's line has beyond its first line's — so a nested line stays nested.
fn flexible_replace(original: &str, old: &str, new: &str) -> Option<String> {
    let wanted: Vec<&str> = old.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    if wanted.is_empty() {
        return None;
    }
    let newline = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = original.lines().collect();
    let matches: Vec<usize> = (0..lines.len().saturating_sub(wanted.len() - 1))
        .filter(|&start| wanted.iter().enumerate().all(|(offset, want)| lines[start + offset].trim() == *want))
        .collect();
    let [start] = matches.as_slice() else { return None };
    let indent_of = |line: &str| line[..line.len() - line.trim_start().len()].to_string();
    let new_lines: Vec<&str> = new.lines().collect();
    let base = new_lines.iter().find(|line| !line.trim().is_empty()).map(|line| indent_of(line).len()).unwrap_or(0);
    let replaced: Vec<String> = new_lines
        .iter()
        .enumerate()
        .map(|(offset, line)| {
            if line.trim().is_empty() {
                return String::new();
            }
            let anchor = lines[(start + offset).min(start + wanted.len() - 1)];
            let extra = indent_of(line).len().saturating_sub(base);
            format!("{}{}{}", indent_of(anchor), " ".repeat(extra), line.trim())
        })
        .collect();
    let mut out: Vec<String> = lines[..*start].iter().map(|line| line.to_string()).collect();
    out.extend(replaced);
    out.extend(lines[start + wanted.len()..].iter().map(|line| line.to_string()));
    let mut text = out.join(newline);
    if original.ends_with('\n') {
        text.push_str(newline);
    }
    Some(text)
}

/// Whether every non-empty line starts with the `   12\t` prefix `read_file` adds.
fn has_line_numbers(text: &str) -> bool {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty()).peekable();
    lines.peek().is_some() && lines.all(|line| line_number_prefix(line).is_some())
}

/// The length of a line's `read_file` prefix: spaces, digits, then a tab — or what models write in its
/// place: `→`, `|`, or `:` and a space (qwen3:8b sent `    5: total -= item.price;` eight times).
fn line_number_prefix(line: &str) -> Option<usize> {
    let digits_start = line.len() - line.trim_start_matches(' ').len();
    let rest = &line[digits_start..];
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let after = &rest[digits..];
    let sep = ['\t', '→', '|', ':'].into_iter().find(|sep| after.starts_with(*sep))?;
    let mut cut = digits_start + digits + sep.len_utf8();
    if sep != '\t' && line[cut..].starts_with(' ') {
        cut += 1;
    }
    Some(cut)
}

fn strip_line_numbers(text: &str) -> String {
    text.split('\n')
        .map(|line| match line_number_prefix(line) {
            Some(cut) => &line[cut..],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required },
        }
    })
}

/// A 1-based line argument, whether the model sent a number or a numeric string.
fn line_arg(args: &Value, key: &str) -> Option<usize> {
    match args.get(key)? {
        Value::Number(n) => n.as_u64().map(|n| n as usize),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|&n| n > 0)
}

/// A path as models write it — `./src/a.ts`, `/src/a.ts`, `src\a.ts` — as the repository-relative,
/// `/`-separated form the guards take. A leading `/` is read as "from the project root", which is
/// what a model means by it; the guards still refuse `..` and anything absolute that remains.
fn clean_rel(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_start_matches("./").trim_start_matches('/');
    let path = path.trim_end_matches('/');
    if path == "." {
        String::new()
    } else {
        path.to_string()
    }
}

/// The line of `text` most like the first line of `wanted`, for an edit that did not match — the
/// usual cause is indentation or a line the model remembered wrong, and naming the real line fixes
/// both on the next try.
fn closest_line(text: &str, wanted: &str) -> Option<(usize, String)> {
    let first = wanted.lines().map(str::trim).find(|line| !line.is_empty())?;
    if first.len() < 3 {
        return None;
    }
    text.lines()
        .enumerate()
        .filter(|(_, line)| line.trim() == first || line.contains(first) || first.contains(line.trim()) && line.trim().len() > 8)
        .map(|(index, line)| (index + 1, line.trim().chars().take(160).collect::<String>()))
        .next()
}

fn tail_chars(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Every file under a folder that is not a git working copy, relative and `/`-separated, skipping
/// hidden and dependency folders.
fn plain_walk(root: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if kind.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
                if out.len() >= limit {
                    out.sort();
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

fn plain_search(root: &Path, query: &str, regex: bool, max: usize) -> Result<(Vec<String>, bool), String> {
    let body = if regex { query.to_string() } else { regex::escape(query) };
    let matcher = regex::Regex::new(&format!("(?i){body}")).map_err(|e| format!("invalid regular expression: {e}"))?;
    let mut hits = Vec::new();
    for rel in plain_walk(root, PLAIN_WALK_LIMIT) {
        let path = root.join(&rel);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if search::looks_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            if matcher.is_match(line) {
                if hits.len() >= max {
                    return Ok((hits, true));
                }
                hits.push(format!("{rel}:{}: {}", index + 1, line.trim().chars().take(300).collect::<String>()));
            }
        }
    }
    Ok((hits, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("codeflow-local-agent-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_repo() -> TempDir {
        let dir = TempDir::new();
        git2::Repository::init(dir.path()).expect("git init");
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/app.ts"), "export function total(items) {\n  return 0;\n}\n").unwrap();
        std::fs::write(dir.path().join("README.md"), "# Demo\n").unwrap();
        dir
    }

    fn toolbox(dir: &TempDir, grants: Grants) -> Toolbox {
        Toolbox::new(dir.path().to_str().unwrap(), grants).expect("toolbox")
    }

    const READ: Grants = Grants { write: false, run: false };
    const WRITE: Grants = Grants { write: true, run: false };

    #[tokio::test]
    async fn read_only_offers_and_runs_no_write_tool() {
        let dir = temp_repo();
        let tools = toolbox(&dir, READ);
        let names: Vec<String> =
            tools.schemas().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect();
        assert!(!names.iter().any(|n| n == "edit_file" || n == "write_file" || n == "run_command"));
        let outcome = tools.call("write_file", &json!({ "path": "x.txt", "content": "hi" }), &mut None).await;
        assert!(!outcome.ok);
        assert!(!dir.path().join("x.txt").exists(), "a read-only run must not write");
    }

    #[tokio::test]
    async fn paths_cannot_leave_the_root() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        for path in ["../escaped.txt", "src/../../escaped.txt"] {
            let outcome = tools.call("write_file", &json!({ "path": path, "content": "x" }), &mut None).await;
            assert!(!outcome.ok, "{path} must be refused");
        }
        assert!(!dir.path().parent().unwrap().join("escaped.txt").exists());
        let outcome = tools.call("read_file", &json!({ "path": "../../etc/passwd" }), &mut None).await;
        assert!(!outcome.ok);
    }

    #[tokio::test]
    async fn read_file_numbers_lines_and_reads_ranges() {
        let dir = temp_repo();
        let tools = toolbox(&dir, READ);
        let outcome = tools.call("read_file", &json!({ "path": "./src/app.ts" }), &mut None).await;
        assert!(outcome.ok);
        assert!(outcome.content.contains("    2\t  return 0;"), "{}", outcome.content);
        let outcome = tools.call("read_file", &json!({ "path": "src/app.ts", "start_line": "2", "end_line": 2 }), &mut None).await;
        assert!(outcome.content.trim_start().starts_with("2\t  return 0;\n"), "{}", outcome.content);
        assert!(!outcome.content.contains("export function"), "line 1 is outside the range");
    }

    #[tokio::test]
    async fn edit_file_needs_an_exact_unique_match() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        let unread = tools
            .call("edit_file", &json!({ "path": "src/app.ts", "old_text": "  return 0;", "new_text": "x" }), &mut None)
            .await;
        assert!(!unread.ok, "an edit to a file never read this run is refused");
        tools.call("read_file", &json!({ "path": "src/app.ts" }), &mut None).await;
        let missing = tools
            .call("edit_file", &json!({ "path": "src/app.ts", "old_text": "return 1;", "new_text": "x" }), &mut None)
            .await;
        assert!(!missing.ok);
        let edited = tools
            .call(
                "edit_file",
                &json!({ "path": "src/app.ts", "old_text": "  return 0;", "new_text": "  return items.length;" }),
                &mut None,
            )
            .await;
        assert!(edited.ok, "{}", edited.content);
        assert_eq!(edited.changed, Some((1, 1)));
        let text = std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap();
        assert!(text.contains("return items.length;"));
    }

    #[tokio::test]
    async fn write_file_creates_folders_inside_the_root() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        let outcome = tools
            .call("write_file", &json!({ "path": "src/lib/new.ts", "content": "export const a = 1;" }), &mut None)
            .await;
        assert!(outcome.ok, "{}", outcome.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("src/lib/new.ts")).unwrap(), "export const a = 1;\n");
        let blind = tools.call("write_file", &json!({ "path": "README.md", "content": "gone" }), &mut None).await;
        assert!(!blind.ok, "an existing file is not rewritten unread");
        assert_eq!(std::fs::read_to_string(dir.path().join("README.md")).unwrap(), "# Demo\n");
    }

    #[tokio::test]
    async fn find_and_search_cover_git_and_plain_folders() {
        let dir = temp_repo();
        let tools = toolbox(&dir, READ);
        let found = tools.call("find_files", &json!({ "pattern": "app" }), &mut None).await;
        assert!(found.content.contains("src/app.ts"), "{}", found.content);
        let hits = tools.call("search", &json!({ "query": "return 0" }), &mut None).await;
        assert!(hits.content.contains("src/app.ts:2:"), "{}", hits.content);

        let plain = TempDir::new();
        std::fs::write(plain.path().join("notes.txt"), "alpha\nbeta\n").unwrap();
        let tools = Toolbox::new(plain.path().to_str().unwrap(), READ).unwrap();
        let hits = tools.call("search", &json!({ "query": "BETA" }), &mut None).await;
        assert!(hits.content.contains("notes.txt:2:"), "{}", hits.content);
    }

    #[tokio::test]
    async fn an_edit_copied_with_line_numbers_still_applies() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        tools.call("read_file", &json!({ "path": "src/app.ts" }), &mut None).await;
        let edited = tools
            .call(
                "edit_file",
                &json!({ "path": "src/app.ts", "old_text": "    2\t  return 0;", "new_text": "    2\t  return 1;" }),
                &mut None,
            )
            .await;
        assert!(edited.ok, "{}", edited.content);
        assert!(std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("  return 1;\n"));
        // The colon form, indentation lost with it — still a unique substring of the file.
        let colon = tools
            .call(
                "edit_file",
                &json!({ "path": "src/app.ts", "old_text": "    2: return 1;", "new_text": "    2: return 2;" }),
                &mut None,
            )
            .await;
        assert!(colon.ok, "{}", colon.content);
        assert!(std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("  return 2;\n"));
    }

    #[test]
    fn flexible_replace_keeps_the_files_indentation() {
        let file = "function f(items) {\n  for (const item of items) {\n    total -= item.price;\n  }\n}\n";
        let updated = flexible_replace(file, "total -= item.price;\n}", "total += item.price;\n}").unwrap();
        assert_eq!(updated, "function f(items) {\n  for (const item of items) {\n    total += item.price;\n  }\n}\n");
        // Ambiguous: two identical lines, so nothing is guessed.
        assert!(flexible_replace("a();\na();\n", "a();", "b();").is_none());
    }

    #[test]
    fn model_paths_are_cleaned() {
        assert_eq!(clean_rel("./src/a.ts"), "src/a.ts");
        assert_eq!(clean_rel("/src/a.ts"), "src/a.ts");
        assert_eq!(clean_rel("src\\a.ts"), "src/a.ts");
        assert_eq!(clean_rel("."), "");
        assert_eq!(clean_rel("src/"), "src");
    }
}
