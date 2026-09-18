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

    Ok(removed)
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
