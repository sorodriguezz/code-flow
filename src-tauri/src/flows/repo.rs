//! Flows kept in a repository, beside the code they automate: `.codeflow/flows/*.json`, each in the
//! export format (`flows::transfer`) — committed, reviewed in a pull request and pulled like any file.
//!
//! **Linked, not mirrored.** A flow imported from a repository, or saved into one, remembers the
//! file (`flow_repo_links`) and the hash of the bytes it last wrote or read there. Nothing moves on
//! its own: the explorer shows a file that changed on disk (a pull, a checkout) and a flow edited
//! since its last save, and the person brings one side to the other — a flow being edited must not
//! be rewritten by a `git checkout`, nor a working tree dirtied by every autosave.
//!
//! **What comes from a repository is not trusted.** A teammate's commit can carry commands: an
//! import arrives untrusted, and a pull that changes what the flow runs takes its trust away
//! (`flow_queries::save_spec` with `keep_trust: false`) — the review dialog runs first, the same
//! gate an imported file goes through.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::transfer::{ExportFile, MARKER};

/// Where a repository keeps its flows, from its root.
pub const FOLDER: &str = ".codeflow/flows";

/// A flow file found in a repository.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundFile {
    /// From the repository's root, with forward slashes: `.codeflow/flows/deploy.json`.
    pub path: String,
    pub name: String,
    pub description: String,
    pub node_count: usize,
    pub hash: String,
    /// Why the file could not be read as a flow, when it could not.
    pub error: Option<String>,
}

/// The bytes of a file, hashed the way links remember them.
pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// A path a command was handed, checked: inside the flows folder, a `.json`, no way out of it.
pub fn checked(path: &str) -> Result<String, String> {
    let path = path.trim().replace('\\', "/");
    let inside = Path::new(&path);
    if inside.is_absolute() || inside.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir)) {
        return Err(format!("{path} is not a path inside the repository"));
    }
    if !path.starts_with(&format!("{FOLDER}/")) || !path.to_ascii_lowercase().ends_with(".json") {
        return Err(format!("A repository's flows are .json files in {FOLDER}/"));
    }
    Ok(path)
}

/// `root` joined with a checked path — refusing a link that points the file out of the repository.
pub fn file_in(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = checked(path)?;
    let full = root.join(&path);
    if let Ok(meta) = std::fs::symlink_metadata(&full) {
        if meta.file_type().is_symlink() {
            return Err(format!("{path} is a link; flows are read from plain files"));
        }
    }
    Ok(full)
}

/// What a flow file says about itself: its name, description and node count.
pub fn read(text: &str) -> Result<(String, String, usize), String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Not JSON: {e}"))?;
    if value.get("format").and_then(|f| f.as_str()) == Some(MARKER) {
        let file: ExportFile = serde_json::from_value(value).map_err(|e| format!("Not a CodeFlow flow: {e}"))?;
        return Ok((file.name, file.description, file.spec.nodes.len()));
    }
    // A bare document (`{ schema, nodes, … }`) is a flow too, named after its file by the caller.
    let spec = super::spec::parse(text)?;
    Ok((String::new(), String::new(), spec.nodes.len()))
}

/// Every flow file of a repository, by path.
pub fn scan(root: &Path) -> Vec<FoundFile> {
    let dir = root.join(FOLDER);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut found: Vec<FoundFile> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.to_ascii_lowercase().ends_with(".json") {
                return None;
            }
            let path = format!("{FOLDER}/{name}");
            let stem = name.trim_end_matches(".json").trim_end_matches(".flow").to_string();
            Some(match std::fs::read(entry.path()) {
                Err(error) => FoundFile { path, name: stem, description: String::new(), node_count: 0, hash: String::new(), error: Some(error.to_string()) },
                Ok(bytes) => {
                    let hash = hash(&bytes);
                    match read(&String::from_utf8_lossy(&bytes)) {
                        Ok((title, description, node_count)) => {
                            FoundFile { path, name: if title.trim().is_empty() { stem } else { title }, description, node_count, hash, error: None }
                        }
                        Err(error) => FoundFile { path, name: stem, description: String::new(), node_count: 0, hash, error: Some(error) },
                    }
                }
            })
        })
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// A file name for a flow: its name in lower case, letters and digits joined by `-`.
pub fn slug(name: &str) -> String {
    let folded: String = name
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'Á' | 'À' | 'Ä' | 'Â' => 'a',
            'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'Ó' | 'Ò' | 'Ö' | 'Ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
            'ñ' | 'Ñ' => 'n',
            other => other.to_ascii_lowercase(),
        })
        .collect();
    let mut out = String::new();
    for c in folded.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(60).collect::<String>();
    if out.is_empty() { "flujo".into() } else { out }
}

/// A free path for a new flow file in `root`: `<slug>.json`, then `<slug>-2.json`…
pub fn free_path(root: &Path, name: &str) -> String {
    let base = slug(name);
    (1..)
        .map(|n| if n == 1 { format!("{FOLDER}/{base}.json") } else { format!("{FOLDER}/{base}-{n}.json") })
        .find(|path| !root.join(path).exists())
        .unwrap_or_else(|| format!("{FOLDER}/{base}.json"))
}

/// Writes a flow file, creating the folder; answers the hash of what was written.
pub fn write(root: &Path, path: &str, file: &ExportFile) -> Result<String, String> {
    let full = file_in(root, path)?;
    if let Some(dir) = full.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    // A diff in review reads better without the export's moment changing on every save.
    let mut stable = file.clone();
    stable.exported_at = String::new();
    let mut text = serde_json::to_string_pretty(&stable).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&full, text.as_bytes()).map_err(|e| format!("Could not write {}: {e}", full.display()))?;
    Ok(hash(text.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_flows_folder() {
        assert_eq!(checked(".codeflow/flows/deploy.json").unwrap(), ".codeflow/flows/deploy.json");
        assert_eq!(checked(".codeflow\\flows\\a.json").unwrap(), ".codeflow/flows/a.json");
        assert!(checked(".codeflow/flows/../../etc/passwd.json").is_err());
        assert!(checked("/etc/flows.json").is_err());
        assert!(checked("src/app.json").is_err());
        assert!(checked(".codeflow/flows/notes.txt").is_err());
    }

    #[test]
    fn names_become_file_names_and_files_are_found() {
        assert_eq!(slug("Revisión de PR — diaria"), "revision-de-pr-diaria");
        assert_eq!(slug("¡¡!!"), "flujo");
        let root = std::env::temp_dir().join(format!("cf-repo-flows-{}", uuid::Uuid::new_v4()));
        let spec = crate::flows::spec::parse(r#"{"schema":1,"nodes":[{"id":"a","type":"trigger.manual","name":"Inicio","pos":[0,0],"params":{}}],"connections":[]}"#).unwrap();
        let file = ExportFile {
            format: MARKER.into(),
            schema: 1,
            name: "Deploy diario".into(),
            description: "Despliega".into(),
            exported_at: "2026-10-06T00:00:00Z".into(),
            credentials: vec![],
            spec,
        };
        let path = free_path(&root, &file.name);
        assert_eq!(path, ".codeflow/flows/deploy-diario.json");
        let written = write(&root, &path, &file).unwrap();
        assert_eq!(free_path(&root, &file.name), ".codeflow/flows/deploy-diario-2.json", "a taken name gets a number");
        std::fs::write(root.join(FOLDER).join("roto.json"), "{").unwrap();
        let found = scan(&root);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].name.as_str(), found[0].node_count, found[0].hash.as_str()), ("Deploy diario", 1, written.as_str()));
        assert!(found[1].error.is_some(), "a broken file is listed with its reason");
        let text = std::fs::read_to_string(root.join(&path)).unwrap();
        assert!(!text.contains("2026-10-06T00:00:00Z"), "no moment in the file: saves diff cleanly");
        let _ = std::fs::remove_dir_all(&root);
    }
}
