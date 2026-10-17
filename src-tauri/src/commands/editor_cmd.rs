//! The editor's own two backend calls that are not file reads and writes: formatting with the
//! repository's Prettier, and the restore point a project-wide rename takes before it writes to
//! files nobody has open.

/// Formats the editor's buffer as the file at `rel_path`, with the Prettier in the repository's
/// `node_modules` — see [`crate::prettier`]. Writes nothing: the answer goes back into the buffer.
#[tauri::command]
pub async fn format_with_prettier(
    repo_path: String,
    rel_path: String,
    text: String,
) -> Result<crate::prettier::Outcome, String> {
    crate::prettier::format(&repo_path, &rel_path, &text).await
}

/// A checkpoint of the working tree before a rename writes to files that are not open, so the
/// whole rename can be put back from the restore-points list — the same guarantee a project-wide
/// replace gives. Returns the checkpoint's id.
///
/// `(async)` because the snapshot walks the working tree, which on a large repository is long
/// enough to freeze the window; it builds its tree in an in-memory index, so it never touches
/// the one on disk and needs no main-thread ordering against the git writes that do.
#[tauri::command(async)]
pub fn create_editor_checkpoint(repo_path: String) -> Result<String, String> {
    crate::git::checkpoint::create(&repo_path, "rename-symbol")
}

/// SchemaStore's catalogue — which schema each JSON file name gets. See [`crate::json_schemas`].
#[tauri::command]
pub async fn json_schema_catalog() -> Result<String, String> {
    crate::json_schemas::fetch(crate::json_schemas::CATALOG_URL).await
}

/// One schema's text, by its URL — a catalogue entry, a file's own `$schema`, or a `$ref` inside
/// another schema. Public web addresses only.
#[tauri::command]
pub async fn json_schema_fetch(url: String) -> Result<String, String> {
    crate::json_schemas::fetch(&url).await
}
