//! What a working copy changed over a base commit, file by file.
//!
//! Two git listings, both NUL-separated so no path is ever quoted or mangled:
//!
//! - `git diff --name-status -z --no-renames <base>`: every tracked path whose working-tree content
//!   differs from the base (added, modified, deleted, type-changed). The comparison is with the
//!   working tree, so staged or not makes no difference.
//! - `git ls-files --others --exclude-standard -z`: untracked files git does not ignore.
//!
//! A path in neither is equal to the base on this machine, and so on every machine that has that
//! base. That is why a manifest only names what changed. Each listed path then goes through
//! [`exclude::classify`] and is hashed (SHA-256 of its bytes) when present.
//!
//! **Renames are a delete plus an add.** A rename only exists relative to a diff, and peers agree on
//! files, not diffs.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::exclude::{self, Excluded};
use crate::git::cli;

/// A file's state relative to the session's base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FileState {
    /// Identical to the base (or absent from both).
    Base,
    /// Present with these bytes.
    Present { sha: String, size: u64, binary: bool },
    /// Present in the base, deleted here.
    Deleted,
}

impl FileState {
    /// Whether two states mean the same bytes on disk. Only the hash counts for a present file: the
    /// size and the binary flag follow from it.
    pub fn same_as(&self, other: &FileState) -> bool {
        match (self, other) {
            (FileState::Base, FileState::Base) | (FileState::Deleted, FileState::Deleted) => true,
            (FileState::Present { sha: a, .. }, FileState::Present { sha: b, .. }) => a == b,
            _ => false,
        }
    }
}

/// A path that changed but stays on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: Excluded,
}

/// The changed files of one working copy, keyed by repository-relative path with `/` separators.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Manifest {
    pub files: BTreeMap<String, FileState>,
    pub skipped: Vec<Skipped>,
}

/// The state of `path` in a manifest: listed, or equal to the base.
pub fn state_of<'a>(files: &'a BTreeMap<String, FileState>, path: &str) -> &'a FileState {
    static BASE: FileState = FileState::Base;
    files.get(path).unwrap_or(&BASE)
}

fn git_out(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = cli::run_in(cwd, args, &[])?;
    if out.success {
        Ok(out.stdout)
    } else {
        Err(format!("git {}: {}", args.first().copied().unwrap_or(""), out.detail()))
    }
}

/// `git diff --name-status -z` output as `(status letter, path)`. Each record is a status field
/// then a path field. With `--no-renames` there is never a second path.
pub fn parse_name_status(z: &str) -> Vec<(char, String)> {
    let mut fields = z.split('\0').filter(|f| !f.is_empty());
    let mut out = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        if let Some(letter) = status.chars().next() {
            out.push((letter, path.to_string()));
        }
    }
    out
}

/// A NUL-separated path list.
pub fn parse_z_list(z: &str) -> Vec<String> {
    z.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect()
}

/// SHA-256 (hex), length, and whether the file looks binary (a NUL in its first 8000 bytes, git's
/// own heuristic).
pub fn hash_file(path: &Path) -> Result<(String, u64, bool), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    let mut binary = false;
    loop {
        let read = file.read(&mut buffer).map_err(|e| format!("{}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        if size < 8000 {
            let window = (8000 - size as usize).min(read);
            binary |= buffer[..window].contains(&0);
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((hex::encode(hasher.finalize()), size, binary))
}

/// SHA-256 (hex) of bytes already in memory: what a received blob is checked against.
pub fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Scans `worktree` against `base` (a commit-ish).
pub fn scan(worktree: &str, base: &str) -> Result<Manifest, String> {
    let tracked = parse_name_status(&git_out(worktree, &["diff", "--name-status", "-z", "--no-renames", base, "--"])?);
    let untracked = parse_z_list(&git_out(worktree, &["ls-files", "--others", "--exclude-standard", "-z"])?);

    let mut manifest = Manifest::default();
    let root = Path::new(worktree);
    let candidates = tracked
        .into_iter()
        // Everything the diff lists is tracked: in the base, or added to the index since.
        .map(|(status, path)| (path, true, status == 'D'))
        .chain(untracked.into_iter().map(|path| (path, false, false)));

    for (path, tracked, deleted) in candidates {
        if super::worktree::portable_relative(&path).is_err() {
            manifest.skipped.push(Skipped { path, reason: Excluded::Unportable });
            continue;
        }
        let on_disk = root.join(&path);
        let meta = std::fs::symlink_metadata(&on_disk).ok();
        if deleted || meta.is_none() {
            // Deleting a file is never a leak, but a deleted secret or dependency still is not the
            // session's business.
            if let Some(reason) = exclude::classify(&path, tracked, 0) {
                manifest.skipped.push(Skipped { path, reason });
            } else {
                manifest.files.insert(path, FileState::Deleted);
            }
            continue;
        }
        let meta = meta.expect("checked above");
        if meta.file_type().is_symlink() {
            manifest.skipped.push(Skipped { path, reason: Excluded::Symlink });
            continue;
        }
        if !meta.is_file() {
            continue; // A submodule or a directory entry: not a file this session carries.
        }
        if let Some(reason) = exclude::classify(&path, tracked, meta.len()) {
            manifest.skipped.push(Skipped { path, reason });
            continue;
        }
        let (sha, size, binary) = hash_file(&on_disk)?;
        manifest.files.insert(path, FileState::Present { sha, size, binary });
    }
    Ok(manifest)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    /// A repository with one commit holding `a.txt`, `keep.txt` and `.gitignore` (ignores `*.log`).
    /// Returns its path and the base commit's sha.
    pub(crate) fn repo() -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("cf-collab-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        config.set_bool("core.autocrlf", false).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        fs::write(dir.join(".gitignore"), "*.log\n").unwrap();
        let mut index = repo.index().unwrap();
        for p in ["a.txt", "keep.txt", ".gitignore"] {
            index.add_path(Path::new(p)).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let oid = repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();
        (dir, oid.to_string())
    }

    #[test]
    fn name_status_pairs_status_and_path() {
        let z = "M\0src/a.ts\0D\0old file.txt\0A\0dir/ñ.md\0";
        assert_eq!(
            parse_name_status(z),
            vec![('M', "src/a.ts".into()), ('D', "old file.txt".into()), ('A', "dir/ñ.md".into())]
        );
        assert!(parse_name_status("").is_empty());
    }

    #[test]
    fn hashing_flags_binaries_by_a_nul_in_the_head() {
        let dir = std::env::temp_dir().join(format!("cf-hash-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("t.txt"), "hola\n").unwrap();
        fs::write(dir.join("b.bin"), [0x89u8, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let (sha, size, binary) = hash_file(&dir.join("t.txt")).unwrap();
        assert_eq!(sha, hash_bytes(b"hola\n"));
        assert_eq!((size, binary), (5, false));
        assert!(hash_file(&dir.join("b.bin")).unwrap().2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_scan_lists_only_what_changed_and_keeps_the_rest_home() {
        let (dir, base) = repo();
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "two\n").unwrap(); // modified
        fs::remove_file(dir.join("keep.txt")).unwrap(); // deleted
        fs::write(dir.join("new.png"), [0u8, 1, 2, 3]).unwrap(); // untracked binary
        fs::write(dir.join("debug.log"), "noise").unwrap(); // ignored by git
        fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        fs::write(dir.join("node_modules/x/i.js"), "x").unwrap(); // dependencies
        fs::write(dir.join(".env"), "TOKEN=1").unwrap(); // secret
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::write(dir.join("dist/app.js"), "built").unwrap(); // untracked build output

        let m = scan(path, &base).unwrap();
        assert_eq!(m.files.len(), 3, "{:?}", m.files);
        assert!(matches!(m.files.get("a.txt"), Some(FileState::Present { binary: false, .. })));
        assert_eq!(m.files.get("keep.txt"), Some(&FileState::Deleted));
        assert!(matches!(m.files.get("new.png"), Some(FileState::Present { binary: true, size: 4, .. })));
        assert!(!m.files.contains_key("debug.log"));

        let reason = |p: &str| m.skipped.iter().find(|s| s.path == p).map(|s| s.reason);
        assert_eq!(reason("node_modules/x/i.js"), Some(Excluded::Dependencies));
        assert_eq!(reason(".env"), Some(Excluded::Secret));
        assert_eq!(reason("dist/app.js"), Some(Excluded::BuildOutput));
        assert_eq!(state_of(&m.files, "untouched.txt"), &FileState::Base);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_clean_copy_has_an_empty_manifest() {
        let (dir, base) = repo();
        let m = scan(dir.to_str().unwrap(), &base).unwrap();
        assert!(m.files.is_empty() && m.skipped.is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
