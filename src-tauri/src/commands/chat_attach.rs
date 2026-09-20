//! Files attached to a conversation.
//!
//! # Why a copy under the app's own root, and not the path the user picked
//!
//! "Attaching" a file to one of these CLIs means telling an agent where to read it — none of them
//! takes a document on stdin, and only two take a file flag at all. The naive version of that is to
//! paste the original path into the message, which is what the composer did first and which fails
//! two ways in ordinary use: the user moves or deletes the original between attaching and asking,
//! and several of these engines run with a restricted view of the filesystem, so a path under
//! Downloads is not necessarily a path the engine may open. A copy under
//! [`crate::paths::chat_attachments_dir`] is reachable, is stable, and cannot be pulled out from
//! under a conversation halfway through it.
//!
//! # Why the lifetime is the conversation and not the turn
//!
//! Deleting the copy the moment the model has read it is the tidier-sounding rule, and it is wrong.
//! A follow-up question — "and the line before the error?" — may make the model read the file
//! again. On a resuming engine the first read is still in the session transcript so it *often* does
//! not need to, but "often" is not a guarantee; and Cline cannot resume at all, so it re-sends the
//! whole context every turn and a path that has since vanished fails outright. What a model does
//! when told to read a file that is not there is either an error in the middle of an answer or a
//! confident guess, and neither is worth the megabyte.
//!
//! So a copy lives as long as its conversation. It goes when the conversation goes, and
//! [`sweep_orphan_attachments`] collects whatever a crash or an out-of-process deletion left behind.
//!
//! # What is enforced here
//!
//! - **The conversation id must be a UUID.** It always is — this app mints them — but it is also
//!   the one component of a path that arrives from the frontend, so it is checked rather than
//!   trusted. See [`safe_conversation_dir`].
//! - **A size ceiling.** An attachment is copied into the state root and then described to a model
//!   that will read it, so both disk and tokens are spent on it. The cap is generous enough for a
//!   log or a screenshot and small enough that nobody attaches a disk image by accident.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::db::{chat_queries, Db};

/// The largest single attachment, in bytes.
///
/// 25 MB: comfortably past any screenshot, log tail or spreadsheet, and short of the video file
/// somebody will eventually drag in by accident. The limit is about what happens *next* rather than
/// about disk — every one of these bytes is on its way to a model that has to read it.
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// Extensions the engines can actually *see* as images rather than read as bytes.
const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    /// The stored file's name on disk, which is also its identity for removal. Prefixed with a
    /// short random component so two files called `screenshot.png` can both be attached.
    pub id: String,
    /// What the user called it, for the chip in the composer.
    pub name: String,
    /// Absolute path to the copy. This is what goes to the engine.
    pub path: String,
    pub bytes: u64,
    /// Whether an engine that understands images would see this as one. Text files are readable by
    /// every engine here; images are not, and the composer says which.
    pub is_image: bool,
}

fn is_image(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// The attachment directory for a conversation, refusing an id that is not a plain UUID.
///
/// The id is minted by this app and has never been anything else. It is still checked, because it
/// is the one path component that arrives over IPC, and "this value always comes from us" is
/// precisely the invariant that stops being true without anyone noticing. Rejecting anything with a
/// separator or a `..` in it costs one pass over 36 characters.
fn safe_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("invalid id".to_string())
    }
}

fn safe_conversation_dir(conversation_id: &str) -> Result<PathBuf, String> {
    safe_id(conversation_id)?;
    Ok(crate::paths::chat_conversation_attachments_dir(conversation_id))
}

/// A project's shared-context directory, under its own root. See [`crate::paths::chat_group_context_dir`]
/// for why it is not a subfolder of the conversation attachments.
fn safe_group_dir(group_id: &str) -> Result<PathBuf, String> {
    safe_id(group_id)?;
    Ok(crate::paths::chat_group_context_dir(group_id))
}

/// Copies a file into a directory this module owns, and describes the copy.
///
/// The shared half of attaching, so the conversation and the project paths cannot drift on the
/// things that matter: the size ceiling, the unique-but-legible stored name, and the refusal to
/// take anything that is not a plain file.
fn store_file(dir: &Path, source_path: &str) -> Result<ChatAttachment, String> {
    let source = Path::new(source_path);
    let meta = std::fs::metadata(source).map_err(|e| format!("could not read {source_path}: {e}"))?;
    if !meta.is_file() {
        return Err("only files can be attached".to_string());
    }
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "that file is {:.1} MB; the limit is {} MB",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create the attachment directory: {e}"))?;
    let target = dir.join(stored_name(source_path, &uuid_prefix()));
    std::fs::copy(source, &target).map_err(|e| format!("could not copy the attachment: {e}"))?;
    Ok(describe(&target, meta.len()))
}

/// Everything in a directory this module owns, as attachments.
fn list_dir(dir: &Path) -> Vec<ChatAttachment> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<ChatAttachment> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| describe(&entry.path(), meta.len()))
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn remove_from(dir: &Path, attachment_id: &str) -> Result<(), String> {
    // The id is a file *name*, so the same rule applies to it as to the owner id: it must not be
    // able to address anything outside the directory it belongs to.
    if attachment_id.contains('/') || attachment_id.contains('\\') || attachment_id.contains("..") {
        return Err("invalid attachment id".to_string());
    }
    match std::fs::remove_file(dir.join(attachment_id)) {
        Ok(()) => Ok(()),
        // Already gone is the outcome the caller wanted.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove the attachment: {e}")),
    }
}

/// Builds a unique, safe filename for a copy, keeping the user's own name visible.
///
/// The stored name is `<8 hex>-<sanitised original>`: the prefix makes two files of the same name
/// distinct, and keeping the original after it means the path the model is handed still says what
/// the thing is. A model told to read `a3f19c2e-invoice.pdf` knows more than one told to read
/// `a3f19c2e.bin`, and the file's extension is also how several engines decide whether they are
/// looking at an image.
fn stored_name(original: &str, unique: &str) -> String {
    let base = Path::new(original)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // A leading dot would make the copy a hidden file, and an empty name is not a name.
    let cleaned = cleaned.trim_start_matches('.').to_string();
    let cleaned = if cleaned.is_empty() { "attachment".to_string() } else { cleaned };
    format!("{unique}-{cleaned}")
}

fn describe(path: &Path, bytes: u64) -> ChatAttachment {
    let id = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    // The user-facing name is the stored one minus the uniqueness prefix, so the chip reads
    // `invoice.pdf` rather than `a3f19c2e-invoice.pdf`.
    let name = id.split_once('-').map(|(_, rest)| rest.to_string()).unwrap_or_else(|| id.clone());
    ChatAttachment {
        is_image: is_image(&name),
        id,
        name,
        path: path.to_string_lossy().to_string(),
        bytes,
    }
}

/// Copies a file the user picked into the conversation's directory.
#[tauri::command]
pub fn chat_attach_file(conversation_id: String, source_path: String) -> Result<ChatAttachment, String> {
    store_file(&safe_conversation_dir(&conversation_id)?, &source_path)
}

/// Adds a file to a **project's** shared context, available to every conversation filed under it.
///
/// The difference from a conversation attachment is entirely in the lifetime and in when the model
/// is told about it: a project's context is named once per engine session rather than on the turn
/// it was attached, and it outlives every individual chat. See `commands::chat_cmd`.
#[tauri::command]
pub fn chat_group_attach_file(group_id: String, source_path: String) -> Result<ChatAttachment, String> {
    store_file(&safe_group_dir(&group_id)?, &source_path)
}

#[tauri::command]
pub fn chat_group_list_context(group_id: String) -> Result<Vec<ChatAttachment>, String> {
    Ok(list_dir(&safe_group_dir(&group_id)?))
}

#[tauri::command]
pub fn chat_group_remove_context(group_id: String, attachment_id: String) -> Result<(), String> {
    remove_from(&safe_group_dir(&group_id)?, &attachment_id)
}

/// A project's shared context files, for the send path. Empty when it has none, which is the
/// ordinary case — and empty too for an id that is somehow not a safe one, because a turn is not
/// the place to fail over a folder that cannot exist.
pub fn group_context_files(group_id: &str) -> Vec<ChatAttachment> {
    safe_group_dir(group_id).map(|dir| list_dir(&dir)).unwrap_or_default()
}

/// Removes a project's whole context directory. Called when the project is deleted.
pub fn discard_group_context(group_id: &str) {
    if let Ok(dir) = safe_group_dir(group_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Stores bytes that have no file behind them — a pasted screenshot, or a drag from an application
/// that hands over data rather than a path.
#[tauri::command]
pub fn chat_attach_bytes(
    conversation_id: String,
    name: String,
    data: Vec<u8>,
) -> Result<ChatAttachment, String> {
    let dir = safe_conversation_dir(&conversation_id)?;
    if data.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "that is {:.1} MB; the limit is {} MB",
            data.len() as f64 / (1024.0 * 1024.0),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create the attachment directory: {e}"))?;
    let target = dir.join(stored_name(&name, &uuid_prefix()));
    let len = data.len() as u64;
    std::fs::write(&target, data).map_err(|e| format!("could not write the attachment: {e}"))?;
    Ok(describe(&target, len))
}

#[tauri::command]
pub fn chat_list_attachments(conversation_id: String) -> Result<Vec<ChatAttachment>, String> {
    // A conversation with no attachments has no directory, which is not an error — it is the
    // ordinary case, and creating one here to be able to read it back empty would put a folder on
    // disk for every conversation that never attached anything.
    Ok(list_dir(&safe_conversation_dir(&conversation_id)?))
}

#[tauri::command]
pub fn chat_remove_attachment(conversation_id: String, attachment_id: String) -> Result<(), String> {
    remove_from(&safe_conversation_dir(&conversation_id)?, &attachment_id)
}

/// Removes a conversation's whole attachment directory. Called when the conversation is deleted.
pub fn discard_conversation_attachments(conversation_id: &str) {
    if let Ok(dir) = safe_conversation_dir(conversation_id) {
        // Best effort by design: a conversation the user asked to delete is deleted from the
        // database whatever the filesystem says, and anything left here is collected by the sweep
        // on the next launch. Failing the delete over a locked file would leave a row nobody can
        // reach, which is the worse outcome.
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Deletes attachment and project-context directories whose owner no longer exists.
///
/// Run once at startup. It exists because the per-delete cleanup above cannot cover every path a
/// conversation disappears down: the app can be killed mid-delete, a workspace deletion cascades
/// rows away without passing through the chat commands, and a database restored from a backup may
/// simply not contain conversations this machine still has folders for.
///
/// Returns the number of directories removed, so the log line says something.
#[tauri::command]
pub fn chat_sweep_attachments(db: State<'_, Db>) -> Result<usize, String> {
    let root = crate::paths::chat_attachments_dir();
    let live: std::collections::HashSet<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::list_conversations(&conn, true)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|c| c.id)
            .collect()
    };
    let mut removed = sweep_root(&root, &live);

    // The projects' own context directories, under their own root and against their own live set.
    // Two sweeps rather than one because the two roots hold different things: a folder named after
    // a project is garbage in the conversation root and correct in this one, and a single pass over
    // both would delete whichever set it was not given.
    let live_groups: std::collections::HashSet<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::list_groups(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|g| g.id)
            .collect()
    };
    removed += sweep_root(&crate::paths::chat_group_context_root(), &live_groups);

    // And the working directories, against the same live conversations as the attachments above.
    // These matter more than either: an attachment is a copy of something the user still has, and
    // one of these can be the only copy of a spreadsheet a model spent a minute building — so the
    // rule is the same (no owner, no directory) but the thing being collected is heavier, and a
    // root that is never swept is a root that grows for the life of the install.
    removed += sweep_root(&crate::paths::chat_outputs_dir(), &live);

    // And the dependency trees inside the directories that *do* have an owner.
    removed += sweep_dependency_trees(&crate::paths::chat_outputs_dir());

    Ok(removed)
}

/// Removes the installed dependency trees from every conversation's working directory.
///
/// # Why this is not covered by the sweep above
///
/// That one collects directories whose *conversation* is gone. This one runs on the ones that are
/// still very much alive, and it exists because of what asking for a spreadsheet actually costs:
/// the engine npm-installs a library to build it, and the measurement on the machine this was
/// written on was 81 MB across six conversations of which **81 MB was `node_modules`**. The files
/// the user asked for came to about 140 KB. Without this, every conversation that ever produced a
/// binary file keeps forty megabytes of somebody else's package manager for as long as the user
/// keeps the conversation — which, the whole feature having been built so the thread is worth
/// keeping, is forever.
///
/// # Why at startup, and only at startup
///
/// Because nothing is mid-turn at startup, which is the one moment removing a `node_modules` cannot
/// pull the floor out from under a running install. It is also why this is not done at the end of
/// each turn: a follow-up — "add a column to that spreadsheet" — reuses what is already installed,
/// and re-installing between two consecutive questions would trade a visible ten seconds for disk
/// nobody is short of *during* a session. Across sessions the trade flips, and so does this.
///
/// The deliverables and the scripts beside them are untouched. Only the trees named in
/// [`OUTPUT_SKIP_DIRS`] go — the same list the listing already refuses to walk into, so nothing
/// that was ever offered to the user can be collected here.
fn sweep_dependency_trees(root: &Path) -> usize {
    let Ok(conversations) = std::fs::read_dir(root) else { return 0 };
    let mut removed = 0;
    for conversation in conversations.flatten() {
        let Ok(entries) = std::fs::read_dir(conversation.path()) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !OUTPUT_SKIP_DIRS.contains(&name) {
                continue;
            }
            if entry.path().is_dir() && std::fs::remove_dir_all(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ===================== files a turn produced =====================

/// How deep into the working directory the listing looks, and how many files it will name.
///
/// Both are backstops rather than product limits. A turn that writes a spreadsheet writes one file
/// at the top; a turn that goes wrong can write a `node_modules`, and a listing that walks it turns
/// a chip strip into a directory browser and a UI thread into a stall.
const OUTPUT_MAX_DEPTH: usize = 3;
const OUTPUT_MAX_FILES: usize = 200;

/// Directory names that are machinery rather than deliverables, skipped whole.
///
/// Not a tidiness rule — a correctness one, and it was found the first time this feature produced a
/// spreadsheet. Asked for an `.xlsx`, the engine reached for a JavaScript library, ran an install,
/// and left a `node_modules` of several thousand files beside the one file the user wanted. The
/// walk would have spent its entire budget inside it and stopped before reaching the spreadsheet,
/// so the output of a successful turn would have been a list of somebody else's dependencies and
/// not the file that was asked for.
///
/// Names rather than patterns, and only the ones an engine actually creates on its way to a file.
const OUTPUT_SKIP_DIRS: [&str; 8] =
    ["node_modules", "venv", "env", "__pycache__", "dist", "build", "target", "site-packages"];

/// Package-manager manifests and lockfiles: the paperwork of installing a library, never the thing
/// that was asked for.
///
/// The worry with filtering by name is real — "write me a `package.json`" is a request somebody
/// makes — and this design answers it rather than ignoring it. A manifest is plain text, and plain
/// text is delivered in a **code block**, which the repo-less system prompt says in as many words
/// and which carries its own save button. The file-writing path exists for what cannot be written
/// as text at all. So a `package.json` appearing *on disk* is, by the rules this feature runs
/// under, always scaffolding — and a user who asked for one still gets it, in the block, where they
/// can read it first.
///
/// Found the first time this produced a spreadsheet: the answer offered `usuarios.xlsx`,
/// `package.json` and `package-lock.json`, and two of the three were npm's.
const OUTPUT_SKIP_FILES: [&str; 11] = [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "Cargo.lock",
    "Cargo.toml",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "go.sum",
];

/// One file a conversation's turns left in its working directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOutput {
    /// Path relative to the conversation's working directory, which is also how it is addressed for
    /// saving. Relative and not absolute: it is what the user sees on the chip, and an engine that
    /// made `salida/informe.xlsx` should not have the app's state root read out around it.
    pub path: String,
    /// The last segment, for the chip's label.
    pub name: String,
    pub bytes: u64,
    /// Milliseconds since the epoch, so the newest file can be shown first. `0` when the platform
    /// will not say, which sorts it last rather than failing the listing.
    pub modified_ms: i64,
    /// Whether this is an image the UI should *show* rather than merely offer.
    ///
    /// Decided here rather than from the extension in the frontend so that one list of image types
    /// governs both directions — an attachment coming in and a file going out.
    pub is_image: bool,
}

fn safe_outputs_dir(conversation_id: &str) -> Result<PathBuf, String> {
    safe_id(conversation_id)?;
    Ok(crate::paths::chat_conversation_outputs_dir(conversation_id))
}

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Walks one conversation's working directory, newest first.
///
/// **Anything whose name starts with a dot is skipped, at every level.** That is not tidiness: the
/// enabled skills are synced into this very directory as `.claude/skills/…` before the turn runs
/// (see `chat_send`), so without this the first thing the user would be offered to download is the
/// app's own plumbing. It also covers the `.git` an engine occasionally decides to initialise.
fn walk_outputs(root: &Path, dir: &Path, depth: usize, out: &mut Vec<ChatOutput>) {
    if depth > OUTPUT_MAX_DEPTH || out.len() >= OUTPUT_MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= OUTPUT_MAX_FILES {
            return;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if !OUTPUT_SKIP_DIRS.contains(&name) {
                walk_outputs(root, &path, depth + 1, out);
            }
            continue;
        }
        if !meta.is_file() || OUTPUT_SKIP_FILES.contains(&name) {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else { continue };
        let Some(relative) = relative.to_str() else { continue };
        out.push(ChatOutput {
            path: relative.replace('\\', "/"),
            name: name.to_string(),
            bytes: meta.len(),
            modified_ms: modified_ms(&meta),
            is_image: is_image(name),
        });
    }
}

/// Every file this conversation's turns have produced, newest first.
///
/// The directory *is* the record — there is no table to keep in step with it, which is the whole
/// reason the working directory became per-conversation. A file the user deletes from disk stops
/// being listed on the next call, and nothing anywhere claims otherwise.
#[tauri::command]
pub fn chat_list_outputs(conversation_id: String) -> Result<Vec<ChatOutput>, String> {
    let root = safe_outputs_dir(&conversation_id)?;
    let mut files = Vec::new();
    walk_outputs(&root, &root, 0, &mut files);
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.path.cmp(&b.path)));
    Ok(files)
}

/// A snapshot of one conversation's working directory: every file it holds, by path, with the
/// fingerprint that says whether a turn has since touched it.
///
/// Size *and* modification time, because either alone misses a real case: a spreadsheet rebuilt
/// with the same number of rows can keep its length, and a filesystem with coarse timestamps can
/// report the same mtime for two writes a moment apart. Together they are wrong only if a turn
/// rewrites a file to exactly the same size within the clock's resolution, which produces one
/// missing chip and nothing worse.
pub type OutputSnapshot = std::collections::HashMap<String, (u64, i64)>;

/// What is in the directory now. Cheap, and taken twice per repo-less turn.
pub fn snapshot_outputs(conversation_id: &str) -> OutputSnapshot {
    let Ok(root) = safe_outputs_dir(conversation_id) else { return OutputSnapshot::new() };
    let mut files = Vec::new();
    walk_outputs(&root, &root, 0, &mut files);
    files.into_iter().map(|f| (f.path, (f.bytes, f.modified_ms))).collect()
}

/// Extensions of things that are run rather than delivered.
///
/// Used only by the rule below, which is what keeps this list from being the blunt instrument it
/// looks like: a `.py` is not hidden for being a `.py`.
const SCRIPT_EXTENSIONS: [&str; 7] = ["js", "mjs", "cjs", "ts", "py", "sh", "rb"];

fn is_script(path: &str) -> bool {
    path.rsplit_once('.')
        .map(|(_, ext)| SCRIPT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// What this turn produced **and is worth offering**: the directory now, minus what it held before,
/// minus the tooling it used to get there.
///
/// # The diff
///
/// What makes the chips belong to an answer instead of to the conversation. The directory alone
/// cannot say it — it is a flat set of files with no memory of which turn wrote which — and the
/// alternative is a second record of the same facts that can fall out of step with the disk. Two
/// walks, one source of truth.
///
/// # Why a script can be dropped, and when it must not be
///
/// Asked for a slide deck, the engine writes `generateCafePPT.js` and runs it. Both files are new,
/// so both survive the diff — and offering the script beside the deck is offering the hammer beside
/// the shelf. But the same extension is sometimes the whole point: "write me a script that rebuilds
/// this every month" is a real request, and a rule that hid every `.py` would eat the answer.
///
/// **A script is tooling only when the same turn also produced something that is not a script.**
/// That is the distinction, and it needs no guess about intent: you can tell the hammer from the
/// shelf because there is a shelf. A turn whose entire output is scripts has delivered scripts, and
/// they all stay.
///
/// Filtering here rather than at render time because this is what gets *stored* — the row is a
/// record of what was offered, and re-deriving the rule in the UI would put the same list in two
/// places to drift apart.
///
/// Returned sorted, so a turn that wrote three files lists them the same way twice.
pub fn outputs_since(conversation_id: &str, before: &OutputSnapshot) -> Vec<String> {
    let produced: Vec<String> = snapshot_outputs(conversation_id)
        .into_iter()
        .filter(|(path, fingerprint)| before.get(path) != Some(fingerprint))
        .map(|(path, _)| path)
        .collect();
    let mut produced = deliverables(produced);
    produced.sort();
    produced
}

/// Drops the tooling from a turn's new files, keeping everything when there is no tooling to tell
/// apart from it. Split out from the walk so the rule can be tested without a filesystem.
pub fn deliverables(produced: Vec<String>) -> Vec<String> {
    if produced.iter().all(|path| is_script(path)) {
        return produced;
    }
    produced.into_iter().filter(|path| !is_script(path)).collect()
}

/// Copies one produced file out to wherever the user's save dialog landed.
///
/// A copy and not a move: the file stays where the engine left it, so a follow-up turn — "add a
/// column to that spreadsheet" — still finds it. Saving twice is therefore allowed and boring.
///
/// **`rel_path` is canonicalised and checked to be inside the conversation's directory.** It comes
/// from a listing this app produced, so it is already safe; it is checked anyway because it crosses
/// the IPC boundary, and a `..` that reached `std::fs::copy` would read any file on the disk out to
/// a path the user was persuaded to pick.
#[tauri::command]
pub fn chat_save_output(
    conversation_id: String,
    rel_path: String,
    dest_path: String,
) -> Result<(), String> {
    let root = safe_outputs_dir(&conversation_id)?;
    let source = root.join(&rel_path);
    let (Ok(real_root), Ok(real_source)) = (root.canonicalize(), source.canonicalize()) else {
        return Err("that file is no longer there".to_string());
    };
    if !real_source.starts_with(&real_root) {
        return Err("invalid path".to_string());
    }
    if !real_source.is_file() {
        return Err("that file is no longer there".to_string());
    }
    std::fs::copy(&real_source, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// How large a produced file may be and still be inlined into the transcript.
///
/// The preview travels as base64 in a `data:` URL — the app has no asset protocol, and adding one
/// for this would mean granting the webview a filesystem scope for a thumbnail — so the cost is
/// about a third again over the file itself, held in a string, per image on screen. Eight megabytes
/// is far above anything a model draws and far below the point where a transcript becomes a memory
/// problem. Past it the chip still offers the file; only the picture is withheld.
const OUTPUT_PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The bytes of one produced file, for showing it rather than saving it.
///
/// Same directory guard as [`chat_save_output`] — `rel_path` crosses the IPC boundary, so it is
/// canonicalised and checked to be inside the conversation's own folder before anything is read.
#[tauri::command]
pub fn chat_read_output(conversation_id: String, rel_path: String) -> Result<Vec<u8>, String> {
    let root = safe_outputs_dir(&conversation_id)?;
    let source = root.join(&rel_path);
    let (Ok(real_root), Ok(real_source)) = (root.canonicalize(), source.canonicalize()) else {
        return Err("that file is no longer there".to_string());
    };
    if !real_source.starts_with(&real_root) || !real_source.is_file() {
        return Err("invalid path".to_string());
    }
    let size = real_source.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
    if size > OUTPUT_PREVIEW_MAX_BYTES {
        return Err("that file is too large to preview".to_string());
    }
    std::fs::read(&real_source).map_err(|e| e.to_string())
}

/// Drops a conversation's working directory. The twin of
/// [`discard_conversation_attachments`], called from the same place and best-effort for the same
/// reason.
pub fn discard_conversation_outputs(conversation_id: &str) {
    if let Ok(dir) = safe_outputs_dir(conversation_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Removes every directory under `root` whose name is not in `live`. Returns how many went.
fn sweep_root(root: &Path, live: &std::collections::HashSet<String>) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if !live.contains(&name) && entry.path().is_dir() && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn uuid_prefix() -> String {
    uuid::Uuid::new_v4().to_string().chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule the chips under an answer live by: you can tell the hammer from the shelf because
    /// there is a shelf.
    #[test]
    fn a_script_beside_a_deliverable_is_tooling() {
        let produced = vec!["cafe.pptx".to_string(), "generateCafePPT.js".to_string()];
        assert_eq!(deliverables(produced), vec!["cafe.pptx".to_string()]);
    }

    #[test]
    fn a_turn_that_made_only_scripts_delivered_scripts() {
        // "Write me a script that rebuilds this every month" is a real request, and a rule that
        // hid every `.py` would eat the answer.
        let produced = vec!["backup.py".to_string(), "helpers.py".to_string()];
        assert_eq!(deliverables(produced.clone()), produced);
    }

    #[test]
    fn several_deliverables_all_survive_and_their_tooling_does_not() {
        let produced = vec![
            "informe.xlsx".to_string(),
            "resumen.pdf".to_string(),
            "build.sh".to_string(),
        ];
        assert_eq!(
            deliverables(produced),
            vec!["informe.xlsx".to_string(), "resumen.pdf".to_string()]
        );
    }

    #[test]
    fn an_extension_is_matched_whatever_its_case_and_a_missing_one_is_not_a_script() {
        assert!(is_script("Build.PY"));
        assert!(is_script("nested/dir/make.Js"));
        // No extension at all — a `Dockerfile`, or a binary somebody named plainly.
        assert!(!is_script("Dockerfile"));
        assert!(!is_script("informe"));
    }

    #[test]
    fn an_owner_id_cannot_address_anything_outside_its_own_folder() {
        for bad in ["../../etc", "a/b", "", "..", "x\u{0000}y"] {
            assert!(safe_conversation_dir(bad).is_err(), "{bad:?} must be refused");
            assert!(safe_group_dir(bad).is_err(), "{bad:?} must be refused for a project too");
        }
        assert!(safe_conversation_dir("6f1b9c2e-4a7d-4c19-9b3e-2d8a1f0c5e77").is_ok());
        assert!(safe_group_dir("6f1b9c2e-4a7d-4c19-9b3e-2d8a1f0c5e77").is_ok());
    }

    /// A project's context and a conversation's attachments must not share a directory: the
    /// conversation sweep deletes any folder whose name is not a live conversation, and a project
    /// id sitting among them would be collected on the first launch after it was created.
    #[test]
    fn a_projects_context_lives_under_its_own_root() {
        let id = "6f1b9c2e-4a7d-4c19-9b3e-2d8a1f0c5e77";
        assert_ne!(safe_group_dir(id).unwrap(), safe_conversation_dir(id).unwrap());
    }

    #[test]
    fn the_stored_name_keeps_the_original_visible_and_the_copy_unique() {
        let stored = stored_name("/Users/someone/Desktop/Q3 report (final).pdf", "a3f19c2e");
        assert!(stored.starts_with("a3f19c2e-"), "the prefix is what makes two same-named files distinct");
        assert!(stored.ends_with(".pdf"), "the extension survives — several engines read it to decide what this is");
        assert!(!stored.contains(' '), "spaces and parentheses are replaced, so the path needs no quoting");
    }

    #[test]
    fn a_hidden_or_nameless_source_still_gets_a_real_filename() {
        assert_eq!(stored_name(".zshrc", "abc"), "abc-zshrc");
        assert_eq!(stored_name("/", "abc"), "abc-attachment");
    }

    #[test]
    fn the_chip_shows_the_users_name_not_the_stored_one() {
        let described = describe(Path::new("/tmp/x/a3f19c2e-invoice.pdf"), 10);
        assert_eq!(described.name, "invoice.pdf");
        assert_eq!(described.id, "a3f19c2e-invoice.pdf", "removal addresses the file on disk");
        assert!(!described.is_image);
    }

    #[test]
    fn images_are_recognised_by_extension_whatever_its_case() {
        assert!(is_image("Screenshot.PNG"));
        assert!(is_image("photo.jpeg"));
        assert!(!is_image("notes.md"));
        assert!(!is_image("no-extension"));
    }
}
