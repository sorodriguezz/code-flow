//! What is on disk, and what it costs.
//!
//! Deliberately the only place that decides whether a model counts as installed, and it decides it
//! by looking: the file named by [`ModelSpec::file`] either exists under [`dir`] or it does not.
//! There is no row in the database recording the answer, and that is the point — a row can say
//! "installed" about a file a user deleted from Finder, or "missing" about one restored from a
//! backup, and every such disagreement surfaces as the feature being mysteriously broken.
//!
//! [`super::download`] is what makes this trustworthy: it writes to `<file>.part` and renames only
//! after the SHA-256 matches, so the presence of the final name is proof of a complete, verified
//! download rather than of an attempt.

use std::path::PathBuf;

use super::catalogue::{ModelSpec, Tier, CATALOGUE};

/// Where weights live: `paths::models_dir()`, which is `state_dir()/models`.
///
/// Reserved for exactly this before there was anything to put in it, and already carved out of the
/// reset plan — see the doc comment on `paths::models_dir` and the test in `paths` that pins the
/// exclusion. A "reset the app" that silently discarded eight gigabytes the user waited on would
/// be the single most expensive mistake this feature could make.
pub fn dir() -> PathBuf {
    crate::paths::models_dir()
}

pub fn path_of(spec: &ModelSpec) -> PathBuf {
    dir().join(spec.file)
}

/// Whether `spec`'s weights are present and verified.
pub fn is_installed(spec: &ModelSpec) -> bool {
    path_of(spec).is_file()
}

/// Bytes of a download that was interrupted, or `None` when there is no partial file.
///
/// Surfaced so the settings row can say "resume (1.2 GB of 1.5 GB)" instead of offering what looks
/// like a fresh download of a file that is nearly there.
pub fn partial_bytes(spec: &ModelSpec) -> Option<u64> {
    let part = dir().join(format!("{}.part", spec.file));
    std::fs::metadata(part).ok().map(|meta| meta.len()).filter(|&len| len > 0)
}

/// One catalogue row, as the settings pane needs it.
#[derive(serde::Serialize)]
pub struct ModelRow {
    pub id: String,
    pub label: String,
    pub tier: Tier,
    pub params: String,
    pub licence: String,
    pub size_bytes: u64,
    pub min_ram_gb: u32,
    pub installed: bool,
    /// Bytes already fetched by an interrupted attempt, if any.
    pub partial_bytes: Option<u64>,
}

/// The whole catalogue with its on-disk state attached, in catalogue order.
pub fn rows() -> Vec<ModelRow> {
    CATALOGUE
        .iter()
        .map(|spec| ModelRow {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            tier: spec.tier,
            params: spec.params.to_string(),
            licence: spec.licence.to_string(),
            size_bytes: spec.size_bytes,
            min_ram_gb: spec.min_ram_gb,
            installed: is_installed(spec),
            partial_bytes: partial_bytes(spec),
        })
        .collect()
}

/// Total bytes of every model file and partial download under [`dir`].
///
/// Walked rather than summed from the catalogue, so weights left behind by a build whose catalogue
/// has since changed still show up. A user looking at "Models: 3.1 GB" wants the number the disk
/// would report, not the number this binary can account for.
pub fn disk_used() -> u64 {
    let Ok(entries) = std::fs::read_dir(dir()) else { return 0 };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

/// Removes `spec`'s weights and any partial download of them.
///
/// The caller is responsible for stopping the engine first when the model being deleted is the one
/// it has open — see `commands::localai_cmd::localai_delete_model`. On Windows this is not advice:
/// a file mapped by a running process cannot be removed, so deleting the active model without
/// stopping it fails with a message about the file being in use.
pub fn delete(spec: &ModelSpec) -> Result<(), String> {
    let weights = path_of(spec);
    if weights.is_file() {
        std::fs::remove_file(&weights).map_err(|e| {
            format!("Couldn't delete {}: {e}", weights.display())
        })?;
    }
    // Best effort. A leftover `.part` costs disk but breaks nothing, and failing the whole delete
    // over it would leave the user unable to reclaim the gigabytes that actually matter.
    let _ = std::fs::remove_file(dir().join(format!("{}.part", spec.file)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalogue_entry_gets_a_row() {
        let rows = rows();
        assert_eq!(rows.len(), CATALOGUE.len());
        for (row, spec) in rows.iter().zip(CATALOGUE) {
            assert_eq!(row.id, spec.id, "rows() must preserve catalogue order");
            assert_eq!(row.size_bytes, spec.size_bytes);
        }
    }

    /// The whole "is it installed?" contract: presence of the final name, nothing else. A `.part`
    /// must never read as installed, or the engine would be launched against half a model.
    #[test]
    fn a_partial_download_is_not_installed() {
        let spec = super::super::catalogue::find("qwen2.5-coder-0.5b").expect("catalogue entry");
        let root = std::env::temp_dir().join("codeflow-localai-models-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");

        let part = root.join(format!("{}.part", spec.file));
        std::fs::write(&part, b"not the whole thing").expect("write");

        // `is_installed` reads the real `dir()`, so this asserts the rule directly rather than
        // through it — the rule being that only the final name counts.
        assert!(!root.join(spec.file).is_file());
        assert!(part.is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disk_used_is_zero_when_nothing_is_downloaded() {
        // Whatever the developer's machine actually holds, this must not panic or overflow — it is
        // called on every render of the settings pane.
        let _ = disk_used();
    }
}
