//! «Entorno»'s commands: scan a repository's env files, see what its code reads, reveal one value,
//! move one into the Llavero, add a missing key to the example file, and show what a service gets.
//! See `repo_env` for the formats and the reference syntax.
//!
//! Every one walks or reads the disk, so every one is `async` and does its work on a blocking
//! thread — a plain command runs on the UI thread.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::{keyvault_queries, queries, Db};
use crate::keyvault::crypto;
use crate::keyvault::session::VaultSession;
use crate::repo_env::{self, config, edit::Edit, Format};

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Both settings layers, read fresh: the rows are written by the webview with `set_setting`.
fn effective_for(app: &AppHandle, project_id: Option<&str>) -> Result<config::Effective, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let global = queries::get_setting(&conn, config::GLOBAL_KEY).map_err(|e| e.to_string())?;
    let repo = match project_id {
        Some(id) => queries::get_setting(&conn, &config::repo_key(id)).map_err(|e| e.to_string())?,
        None => None,
    };
    Ok(config::effective(&config::parse_global(global.as_deref()), &config::parse_repo(repo.as_deref())))
}

fn root_of(repo_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(repo_path);
    if !root.is_dir() {
        return Err(format!("{repo_path} is not a folder"));
    }
    Ok(root)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDefaults {
    pub patterns: Vec<String>,
    pub exclude: Vec<String>,
}

/// The shipped lists, for Settings' "reset".
#[tauri::command]
pub async fn repo_env_defaults() -> EnvDefaults {
    EnvDefaults {
        patterns: config::DEFAULT_PATTERNS.iter().map(|p| p.to_string()).collect(),
        exclude: config::DEFAULT_EXCLUDE.iter().map(|p| p.to_string()).collect(),
    }
}

/// The repository's env files and their keys — no values.
#[tauri::command]
pub async fn repo_env_scan(app: AppHandle, project_id: Option<String>, repo_path: String) -> Result<repo_env::Scan, String> {
    blocking(move || {
        let root = root_of(&repo_path)?;
        let eff = effective_for(&app, project_id.as_deref())?;
        Ok(repo_env::scan(&root, eff))
    })
    .await
}

/// What the repository's code reads.
#[tauri::command]
pub async fn repo_env_usage(app: AppHandle, project_id: Option<String>, repo_path: String) -> Result<repo_env::usage::Usage, String> {
    blocking(move || {
        let root = root_of(&repo_path)?;
        let eff = effective_for(&app, project_id.as_deref())?;
        Ok(repo_env::usage::scan(&root, &eff.exclude))
    })
    .await
}

/// One value, on the user's click on its cell. The only command here that returns one.
#[tauri::command]
pub async fn repo_env_reveal(repo_path: String, source_id: String, key: String) -> Result<String, String> {
    blocking(move || {
        let root = root_of(&repo_path)?;
        let (_, _, _, entry) = repo_env::find_entry(&root, &source_id, &key)?;
        Ok(entry.value)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub item_id: String,
    pub title: String,
}

/// Moves one value into the Llavero and leaves a reference in its place (see `repo_env::edit`).
///
/// Order matters: the entry is created first and the file written second, and a failed write takes
/// the entry back out — so a failure leaves the file as it was and the keyring as it was. The
/// reverse order could leave a file pointing at nothing. `note` is the entry's notes, already in the
/// user's language.
#[tauri::command]
pub async fn repo_env_move_to_vault(
    app: AppHandle,
    project_id: String,
    repo_path: String,
    source_id: String,
    key: String,
    note: String,
) -> Result<Moved, String> {
    blocking(move || {
        let root = root_of(&repo_path)?;
        let session = app.state::<VaultSession>();
        if !session.is_unlocked() {
            return Err(crypto::CODE_LOCKED.to_string());
        }
        let (rel, _, text, entry) = repo_env::find_entry(&root, &source_id, &key)?;
        if let Edit::Refused(reason) = &entry.edit {
            return Err(reason.to_string());
        }
        if entry.reference.is_some() {
            return Err(format!("{key} is already in the Llavero"));
        }
        if entry.value.trim().is_empty() {
            return Err(format!("{key} is empty — there is nothing to move"));
        }

        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let project = queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "that repository is no longer here".to_string())?;
        let title = match &entry.sub {
            Some(sub) => format!("{}/{rel}/{sub}/{key}", project.name),
            None => format!("{}/{rel}/{key}", project.name),
        };
        let payload = serde_json::to_vec(&serde_json::json!({ "apiKey": entry.value, "notes": note })).map_err(|e| e.to_string())?;
        // As `keyvault_create_item`: the id is the AAD, so the row exists before it is sealed.
        let created = keyvault_queries::create_item(
            &conn,
            keyvault_queries::NewItem {
                folder_id: None,
                kind: "key",
                title: &title,
                subtitle: "",
                site: "",
                tags: "[\"entorno\"]",
                workspace_id: &project.workspace_id,
                secret_nonce: "",
                secret_blob: "",
            },
        )
        .map_err(|e| e.to_string())?;
        let undo = |conn: &rusqlite::Connection| {
            let _ = keyvault_queries::purge_item(conn, &created.id);
        };
        let sealed = match session.with_key(|dek| crypto::seal(dek, &created.id, &payload)) {
            Ok(Ok(sealed)) => sealed,
            Ok(Err(e)) | Err(e) => {
                undo(&conn);
                return Err(String::from(e));
            }
        };
        if let Err(e) = keyvault_queries::update_item(&conn, &created.id, &title, "", "", "[\"entorno\"]", &sealed.0, &sealed.1) {
            undo(&conn);
            return Err(e.to_string());
        }
        let rewritten = match repo_env::edit::apply(&text, &entry.edit, &created.id) {
            Ok(text) => text,
            Err(e) => {
                undo(&conn);
                return Err(e);
            }
        };
        if let Err(e) = repo_env::write_atomically(&root, &rel, &rewritten) {
            undo(&conn);
            return Err(e);
        }
        keyvault_queries::record_audit(&conn, &created.id, "create");
        Ok(Moved { item_id: created.id, title })
    })
    .await
}

/// Appends `KEY=` to a dotenv file — the fix for "the example does not list it".
#[tauri::command]
pub async fn repo_env_add_key(repo_path: String, path: String, key: String) -> Result<(), String> {
    blocking(move || {
        let root = root_of(&repo_path)?;
        let rel = config::normalize(&path);
        if repo_env::format_of(&rel) != Format::Dotenv {
            return Err("only a dotenv file can be added to here".into());
        }
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-') {
            return Err(format!("{key} is not a variable name"));
        }
        let text = repo_env::read_text(&root, &rel)?;
        if repo_env::dotenv::parse(&text).iter().any(|e| e.key == key) {
            return Ok(());
        }
        repo_env::write_atomically(&root, &rel, &repo_env::append_key(&text, &key))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEnv {
    pub project_id: Option<String>,
    /// The service's folder relative to its repository, `""` for the root.
    pub folder: String,
    pub files: Vec<repo_env::inject::UsedFile>,
}

/// The env files a service uses and the Llavero references in them — names and counts, for the
/// Services dock.
#[tauri::command]
pub async fn repo_env_service_files(app: AppHandle, service_id: String) -> Result<ServiceEnv, String> {
    blocking(move || {
        let service = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            crate::db::service_queries::get_service(&conn, &service_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "that service is no longer here".to_string())?
        };
        let Some(cwd) = crate::services::supervisor::resolve_cwd(&app, &service)? else {
            return Ok(ServiceEnv { project_id: service.project_id, folder: String::new(), files: Vec::new() });
        };
        let env: Vec<(String, String)> = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&service.env)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect();
        let files_list = crate::services::envfile::files_of(&service.env_files);
        let (_, files) = repo_env::inject::wanted(&cwd, &files_list, &service.command, &env);
        let folder = service.cwd.trim().replace('\\', "/");
        let folder = if Path::new(&folder).is_absolute() { String::new() } else { config::normalize(&folder) };
        Ok(ServiceEnv { project_id: service.project_id, folder, files })
    })
    .await
}
