//! Documents kept as files in a repository: a diagram or a note "saved in a repository", and a
//! Markdown or diagram file of a working tree opened in the app.
//!
//! **Mirrored, not linked.** Unlike a flow (`flows::repo`, which only moves when the person says
//! so), a document tied to a file *is* that file: every autosave writes it, every open re-reads it.
//! A flow can run commands and has to be reviewed before a teammate's version of it takes effect; a
//! diagram or a note is text the person is looking at, and a copy that drifts from its file is the
//! one thing a mirror must not do.
//!
//! **Over the version last read, never blind.** A write is checked against the version of the file
//! the document last read or wrote (`fsops::write_file_text_checked`), so a `git pull` or a checkout
//! that changed the file under an open document is a question for the person — reload or overwrite
//! — rather than something the next autosave quietly undoes.

use std::path::Path;

use crate::fsops::{self, DiskVersion};

/// Where a repository keeps the diagrams saved into it, from its root.
pub const DIAGRAMS_FOLDER: &str = ".codeflow/diagrams";

/// Where a repository keeps the notes saved into it, from its root.
pub const NOTES_FOLDER: &str = ".codeflow/notes";

/// A file name for a document: its title in lower case, letters and digits joined by `-`, at most
/// sixty characters — `fallback` when nothing of the title survives.
pub fn slug(name: &str, fallback: &str) -> String {
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
    if out.is_empty() { fallback.into() } else { out }
}

/// A path for a new document file in `root`'s `folder`: `<slug>.<ext>`, then `<slug>-2.<ext>`… —
/// the first one with no file on disk and that no document claims (`taken`).
///
/// `taken` matters as much as the disk: a document tied to a file that a checkout has since removed
/// still names that path, and handing it to a second document would tie two of them to one file.
pub fn free_path(
    root: &Path,
    folder: &str,
    name: &str,
    ext: &str,
    fallback: &str,
    taken: impl Fn(&str) -> bool,
) -> String {
    let base = slug(name, fallback);
    // Bounded: a `taken` that answers yes to everything (a query that keeps failing) must not spin.
    // Past the bound a name nothing can hold yet is made up instead.
    (1..=999)
        .map(|n| {
            if n == 1 {
                format!("{folder}/{base}.{ext}")
            } else {
                format!("{folder}/{base}-{n}.{ext}")
            }
        })
        .find(|path| !root.join(path).exists() && !taken(path))
        .unwrap_or_else(|| format!("{folder}/{base}-{}.{ext}", uuid::Uuid::new_v4().simple()))
}

/// Writes a document's first file — folders included — and answers the version written, which is
/// what its next save is checked against.
///
/// Refuses a path that already holds a file rather than overwriting it: [`free_path`] chose one with
/// nothing there, and something appearing in between is somebody else's file.
pub fn create(repo_path: &str, rel_path: &str, text: &str) -> Result<DiskVersion, String> {
    fsops::create_file(repo_path, rel_path)?;
    let version = fsops::write_file_text_checked(repo_path, rel_path, text, None)?;
    // A repository where a chain once ran hides all of `.codeflow/` from git — see the function.
    crate::chain_memory::narrow_legacy_exclude(repo_path);
    Ok(version)
}

/// Writes a mirrored document's file over the version it was read at.
///
/// With no `expected` version the document never read the file (it was missing when the document
/// opened): writing recreates it, unless something has put a file there since, which is a change on
/// disk like any other. `force` is the person's "overwrite", given after they were asked.
pub fn write_linked(
    repo_path: &str,
    rel_path: &str,
    text: &str,
    expected: Option<&DiskVersion>,
    force: bool,
) -> Result<DiskVersion, String> {
    if force {
        return fsops::write_file_text_checked(repo_path, rel_path, text, None);
    }
    match expected {
        Some(version) => fsops::write_file_text_checked(repo_path, rel_path, text, Some(version)),
        None => {
            if fsops::stat_editor_file(repo_path, rel_path, None)?.is_some() {
                return Err(format!(
                    "{}: {rel_path} appeared on disk since the document was opened",
                    fsops::CHANGED_ON_DISK
                ));
            }
            fsops::write_file_text_checked(repo_path, rel_path, text, None)
        }
    }
}

/// A mirrored document's file, and the version of the bytes read — both from one read, so the
/// version is the version of exactly this text. Anything but UTF-8 text is an error: the document
/// would save it back as something else.
pub fn read_linked(repo_path: &str, rel_path: &str) -> Result<(String, DiskVersion), String> {
    match fsops::read_editor_file(repo_path, rel_path, false)? {
        fsops::EditorFile::Text { text, version } => Ok((text, version)),
        _ => Err(format!("{rel_path} is not a UTF-8 text file")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-repo-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn titles_become_file_names() {
        assert_eq!(slug("Diseño de la API", "nota"), "diseno-de-la-api");
        assert_eq!(slug("  ¿?  ", "nota"), "nota");
        assert_eq!(slug("v2 — Migración", "diagrama"), "v2-migracion");
    }

    #[test]
    fn a_path_is_free_of_files_and_of_other_documents() {
        let root = scratch();
        let first = free_path(&root, NOTES_FOLDER, "Plan", "md", "nota", |_| false);
        assert_eq!(first, ".codeflow/notes/plan.md");

        let version = create(&root.to_string_lossy(), &first, "# Plan\n").unwrap();
        assert_eq!(version.size, 7);
        assert_eq!(std::fs::read_to_string(root.join(&first)).unwrap(), "# Plan\n");
        assert!(create(&root.to_string_lossy(), &first, "otra").is_err(), "never over a file");

        let second = free_path(&root, NOTES_FOLDER, "Plan", "md", "nota", |_| false);
        assert_eq!(second, ".codeflow/notes/plan-2.md", "the file is taken");
        let third = free_path(&root, NOTES_FOLDER, "Plan", "md", "nota", |path| path.ends_with("plan-2.md"));
        assert_eq!(third, ".codeflow/notes/plan-3.md", "and so is a path a document still names");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_mirrored_write_is_refused_over_a_file_that_moved() {
        let root = scratch();
        let repo = root.to_string_lossy().into_owned();
        let version = create(&repo, "doc.md", "uno").unwrap();
        std::fs::write(root.join("doc.md"), "cambiado por un pull").unwrap();

        let refused = write_linked(&repo, "doc.md", "dos", Some(&version), false).unwrap_err();
        assert!(refused.starts_with(fsops::CHANGED_ON_DISK), "{refused}");
        write_linked(&repo, "doc.md", "dos", Some(&version), true).unwrap();
        let (text, _) = read_linked(&repo, "doc.md").unwrap();
        assert_eq!(text, "dos", "overwritten once asked");
        std::fs::remove_dir_all(&root).ok();
    }
}
