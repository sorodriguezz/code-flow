use crate::fsops;
use crate::search;

#[tauri::command]
pub fn list_dir(repo_path: String, sub_path: Option<String>) -> Result<Vec<fsops::FileEntry>, String> {
    fsops::list_dir(&repo_path, sub_path)
}

#[tauri::command(async)]
pub fn read_file_text(repo_path: String, rel_path: String) -> Result<String, String> {
    fsops::read_file_text(&repo_path, &rel_path)
}

/// One page of a file's bytes for the editor's hex view — see `fsops::read_byte_range`. Capped at
/// 1 MiB a call, whatever is asked.
#[derive(serde::Serialize)]
pub struct FileBytes {
    bytes: Vec<u8>,
    total: u64,
}

#[tauri::command(async)]
pub fn read_file_bytes(repo_path: String, rel_path: String, offset: u64, len: usize) -> Result<FileBytes, String> {
    let (bytes, total) = fsops::read_byte_range(&repo_path, &rel_path, offset, len.min(1 << 20))?;
    Ok(FileBytes { bytes, total })
}

#[tauri::command]
pub fn write_file_text(repo_path: String, rel_path: String, content: String) -> Result<(), String> {
    fsops::write_file_text(&repo_path, &rel_path, &content)
}

/// The editor's read: the text and the disk version it was read at, or what the file is instead of
/// editable text — see [`fsops::EditorFile`]. `allow_large` is a tab's "open anyway".
///
/// `(async)` because it reads and hashes up to the read cap, which is no job for the UI thread.
#[tauri::command(async)]
pub fn read_editor_file(
    repo_path: String,
    rel_path: String,
    allow_large: Option<bool>,
    encoding: Option<String>,
) -> Result<fsops::EditorFile, String> {
    // «Reopen with encoding»: read as the one asked for instead of the one the bytes suggest.
    if let Some(encoding) = encoding.filter(|e| !e.is_empty()) {
        return fsops::read_editor_file_as(&repo_path, &rel_path, &encoding);
    }
    fsops::read_editor_file(&repo_path, &rel_path, allow_large.unwrap_or(false))
}

/// The disk version of an open tab's file now — `known` handed back untouched when its stamp still
/// matches. The editor's sweep over its tabs on every watcher event; see [`fsops::stat_editor_file`].
#[tauri::command(async)]
pub fn stat_editor_file(
    repo_path: String,
    rel_path: String,
    known: Option<fsops::DiskVersion>,
) -> Result<Option<fsops::DiskVersion>, String> {
    fsops::stat_editor_file(&repo_path, &rel_path, known)
}

/// The editor's save. Refuses with [`fsops::CHANGED_ON_DISK`] when the file is no longer the one
/// `expected` describes; `expected: None` overwrites. Returns the version written.
///
/// Sync, like [`write_file_text`]: the UI thread is what orders two saves of the same file.
#[tauri::command]
pub fn write_editor_file(
    repo_path: String,
    rel_path: String,
    content: String,
    expected: Option<fsops::DiskVersion>,
    encoding: Option<String>,
) -> Result<fsops::DiskVersion, String> {
    // The file's own encoding when it is not UTF-8 — refused, not mangled, when the text no longer
    // fits it (see `fsops::encode_as`).
    let bytes = match encoding.as_deref().filter(|e| !e.is_empty()) {
        Some(encoding) => fsops::encode_as(&content, encoding)?,
        None => content.into_bytes(),
    };
    // What was there, for the local history's first version of a file — read before the write
    // replaces it, kept only once the write (and its path checks) succeeded.
    let previous = std::fs::read(std::path::Path::new(&repo_path).join(&rel_path)).ok();
    let written = fsops::write_bytes_checked(&repo_path, &rel_path, &bytes, expected.as_ref())?;
    let _ = crate::local_history::record(&repo_path, &rel_path, previous.as_deref(), &bytes);
    Ok(written)
}

/// The editor's local history of one file, newest first — see [`crate::local_history`].
#[tauri::command(async)]
pub fn local_history_list(repo_path: String, rel_path: String) -> Vec<crate::local_history::LocalVersion> {
    crate::local_history::list(&repo_path, &rel_path)
}

/// One version's text from the local history.
#[tauri::command(async)]
pub fn local_history_read(repo_path: String, rel_path: String, id: String) -> Result<String, String> {
    crate::local_history::read(&repo_path, &rel_path, &id)
}

/// Saves an exported binary (today: a code snapshot PNG) to the absolute path the user picked in
/// the native save dialog.
#[tauri::command]
pub fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    fsops::write_file_bytes(&path, &contents)
}

/// Reads a JSON file the user picked in the native open dialog — an exported workspace list being
/// imported. The dialog is the authorisation, as it is for [`write_file_bytes`]; the extension and a
/// size cap keep this from being a general "read any file" door.
#[tauri::command(async)]
pub fn read_picked_json(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 5 * 1024 * 1024;
    let target = std::path::Path::new(&path);
    if !target.is_absolute() {
        return Err(format!("expected an absolute path, got: {path}"));
    }
    if !target.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")) {
        return Err("only .json files can be read here".into());
    }
    let size = std::fs::metadata(target).map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err(format!("{path} is too large ({size} bytes)"));
    }
    std::fs::read_to_string(target).map_err(|e| e.to_string())
}

/// Moves a file or folder into `dest_dir` (repo-relative, `""` for the root) — the explorer's
/// drag-and-drop. Returns the new repo-relative path.
#[tauri::command]
pub fn move_path(repo_path: String, from_rel: String, dest_dir: String) -> Result<String, String> {
    fsops::move_path(&repo_path, &from_rel, &dest_dir)
}

/// Copies files and folders dropped in from Finder/Explorer into the project — the editor's
/// external drop. `dest_dir` is repo-relative (`""` for the root); `sources` are the absolute
/// paths the platform handed over with the drag. Returns what landed and what was left alone.
#[tauri::command]
pub fn copy_into_repo(
    repo_path: String,
    dest_dir: String,
    sources: Vec<String>,
) -> Result<fsops::ImportOutcome, String> {
    fsops::copy_into(&repo_path, &dest_dir, &sources)
}

/// Copies a file or folder of the project into `dest_dir` (repo-relative, `""` for the root) — the
/// explorer's Copy then Paste. A taken name gets VS Code's ` copy` suffix instead of being
/// overwritten. Returns the new repo-relative path.
///
/// `(async)` for the reason [`list_repo_files`] is: copying a folder costs whatever is in it, and a
/// plain command runs on the UI thread. Two pastes at once cannot collide — see
/// `fsops::reserve_copy_target`.
#[tauri::command(async)]
pub fn copy_path(repo_path: String, from_rel: String, dest_dir: String) -> Result<String, String> {
    fsops::copy_path(&repo_path, &from_rel, &dest_dir)
}

/// Copies a file or folder from an absolute path anywhere on disk into `dest_dir` of the project —
/// a paste of what another repository's explorer, another window's explorer or the file manager
/// copied. A taken name gets the ` copy` suffix. See [`fsops::copy_external`].
///
/// `(async)` for the reason [`copy_path`] is.
#[tauri::command(async)]
pub fn copy_external_path(repo_path: String, source: String, dest_dir: String) -> Result<String, String> {
    fsops::copy_external(&repo_path, &source, &dest_dir)
}

/// The rows of the explorer's "Generate Tree" for `rel_dir` — see [`fsops::dir_tree`]. `hidden` is
/// the explorer's hidden-entries list, so the tree leaves out what the explorer does.
///
/// `(async)` because it walks a whole folder, the same as [`list_repo_files`].
#[tauri::command(async)]
pub fn dir_tree(
    repo_path: String,
    rel_dir: String,
    hidden: Vec<String>,
    max_entries: usize,
) -> Result<fsops::DirTree, String> {
    fsops::dir_tree(&repo_path, &rel_dir, &hidden, max_entries)
}

#[tauri::command]
pub fn create_dir(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::create_dir(&repo_path, &rel_path)
}

#[tauri::command]
pub fn create_file(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::create_file(&repo_path, &rel_path)
}

/// Renames a file or folder in place — the explorer's context menu and F2. Returns the new
/// repo-relative path so the editor can re-point any tab that was showing it.
#[tauri::command]
pub fn rename_path(repo_path: String, from_rel: String, new_name: String) -> Result<String, String> {
    fsops::rename_path(&repo_path, &from_rel, &new_name)
}

/// Sends a file or folder to the OS trash.
#[tauri::command]
pub fn delete_path(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::delete_path(&repo_path, &rel_path)
}

#[tauri::command]
pub fn open_in_default_app(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::open_in_default_app(&repo_path, &rel_path)
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    fsops::reveal_in_file_manager(&path)
}

#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    fsops::open_in_vscode(&path)
}

/// Every non-ignored file in the repo — what "go to file" filters over. Listed once per open
/// rather than streamed: even a large repo is a few thousand short strings, and filtering in the
/// frontend keeps typing instant.
///
/// `(async)` because a plain `#[tauri::command]` on a sync function runs inline on the UI thread,
/// and this one walks the entire working directory — on a large repository that is long enough to
/// stall painting and earn a "Not Responding". The attribute leaves the body sync and spawns it on
/// tauri's async runtime instead. Safe to run concurrently: it only reads.
#[tauri::command(async)]
pub fn list_repo_files(repo_path: String) -> Result<Vec<String>, String> {
    search::list_files(&repo_path)
}

/// Content search across the repo's text files, with the toggles the find box exposes.
///
/// `(async)` for the same reason as [`list_repo_files`], and more so — this reads every text file
/// in the repository. Note that `replace_in_repo` below deliberately does **not** get it: that one
/// writes, and the UI thread is what currently keeps it from interleaving with anything else.
#[tauri::command(async)]
pub fn search_repo(
    repo_path: String,
    query: String,
    options: search::SearchOptions,
    max_results: usize,
) -> Result<search::SearchOutcome, String> {
    search::search(&repo_path, &query, &options, max_results)
}

/// Rewrites every match across the repo — or within one file when `only_path` is given. Returns
/// what it touched, plus the checkpoint taken beforehand so the whole thing can be undone.
#[tauri::command(async)]
pub fn replace_in_repo(
    repo_path: String,
    query: String,
    replacement: String,
    options: search::SearchOptions,
    only_path: Option<String>,
) -> Result<search::ReplaceOutcome, String> {
    search::replace_all(&repo_path, &query, &replacement, &options, only_path.as_deref())
}
