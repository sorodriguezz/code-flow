//! A file's bytes on one side of a diff — what lets a binary change be *shown* (two images side by
//! side, two sizes) instead of being named "binary file" and left there.
//!
//! **Git LFS.** A path stored through LFS is a three-line pointer in git's objects (and, with LFS
//! not installed, in the working tree too). The pointer is followed to the object git-lfs keeps in
//! `$GIT_COMMON_DIR/lfs/objects/aa/bb/<oid>` when it has been downloaded; when it has not, the side
//! says so — the view offers `git lfs pull` rather than drawing a pointer as if it were the file.

use std::path::Path;

use base64::Engine;
use serde::Serialize;

use super::features::common_dir;
use super::repo::open;

/// The largest file whose bytes are sent to the view. A diff of two 300 MB videos has nothing to
/// draw that the sizes do not already say.
pub const MAX_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;

/// The first line of every LFS pointer (the spec allows nothing else there).
const LFS_VERSION_LINE: &str = "version https://git-lfs.github.com/spec/v1";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LfsPointer {
    /// The object's SHA-256.
    pub oid: String,
    /// The real file's size, as the pointer records it.
    pub size: u64,
    /// The object is in the local LFS store, so its bytes could be read.
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FileSide {
    /// The file is there on this side at all (an added file has no old side).
    pub exists: bool,
    /// The real content's size — the LFS object's when the side is a pointer.
    pub size: u64,
    /// The content, base64. `None` past [`MAX_PREVIEW_BYTES`], or for an LFS object not downloaded.
    pub data: Option<String>,
    pub lfs: Option<LfsPointer>,
}

/// The oid and size an LFS pointer names, when `bytes` is one. Pointers are small (the spec caps
/// them at 1024 bytes) and start with the version line.
pub fn parse_lfs_pointer(bytes: &[u8]) -> Option<(String, u64)> {
    if bytes.len() > 1024 {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if lines.next()?.trim_end() != LFS_VERSION_LINE {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(rest) = line.strip_prefix("oid sha256:") {
            let rest = rest.trim();
            if rest.len() == 64 && rest.bytes().all(|b| b.is_ascii_hexdigit()) {
                oid = Some(rest.to_ascii_lowercase());
            }
        } else if let Some(rest) = line.strip_prefix("size ") {
            size = rest.trim().parse::<u64>().ok();
        }
    }
    Some((oid?, size?))
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A side from its raw bytes: the bytes themselves, or — for a pointer — the LFS object they name.
fn side_from(repo: &git2::Repository, bytes: &[u8]) -> FileSide {
    if let Some((oid, size)) = parse_lfs_pointer(bytes) {
        let object = common_dir(repo).join("lfs").join("objects").join(&oid[0..2]).join(&oid[2..4]).join(&oid);
        let downloaded = object.is_file();
        let data = (downloaded && size <= MAX_PREVIEW_BYTES).then(|| std::fs::read(&object).ok().map(|b| encode(&b))).flatten();
        return FileSide { exists: true, size, data, lfs: Some(LfsPointer { oid, size, downloaded }) };
    }
    let size = bytes.len() as u64;
    FileSide { exists: true, size, data: (size <= MAX_PREVIEW_BYTES).then(|| encode(bytes)), lfs: None }
}

/// `file_path` as it is on one side of a change: `"WORKDIR"` (the file on disk), `"INDEX"` (what is
/// staged), or any revision `git rev-parse` takes (`HEAD`, a commit, `<commit>^`). A revision that
/// does not resolve — the parent of a root commit — is a side where the file does not exist.
pub fn file_side(repo_path: &str, file_path: &str, side: &str) -> Result<FileSide, String> {
    let repo = open(repo_path)?;
    let rel = Path::new(file_path);
    match side {
        "WORKDIR" => {
            let workdir = repo.workdir().ok_or("this repository has no working tree")?;
            let full = workdir.join(rel);
            let Ok(meta) = std::fs::metadata(&full) else { return Ok(FileSide::default()) };
            if !meta.is_file() {
                return Ok(FileSide::default());
            }
            if meta.len() > MAX_PREVIEW_BYTES {
                return Ok(FileSide { exists: true, size: meta.len(), data: None, lfs: None });
            }
            let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
            Ok(side_from(&repo, &bytes))
        }
        "INDEX" => {
            let index = repo.index().map_err(|e| e.message().to_string())?;
            let Some(entry) = index.get_path(rel, 0) else { return Ok(FileSide::default()) };
            blob_side(&repo, entry.id)
        }
        revision => {
            let Ok(commit) = repo.revparse_single(revision).and_then(|object| object.peel_to_commit()) else {
                return Ok(FileSide::default());
            };
            let tree = commit.tree().map_err(|e| e.message().to_string())?;
            let Ok(entry) = tree.get_path(rel) else { return Ok(FileSide::default()) };
            if entry.kind() != Some(git2::ObjectType::Blob) {
                return Ok(FileSide::default());
            }
            blob_side(&repo, entry.id())
        }
    }
}

fn blob_side(repo: &git2::Repository, id: git2::Oid) -> Result<FileSide, String> {
    let blob = repo.find_blob(id).map_err(|e| e.message().to_string())?;
    let size = blob.size() as u64;
    if size > MAX_PREVIEW_BYTES {
        return Ok(FileSide { exists: true, size, data: None, lfs: None });
    }
    Ok(side_from(repo, blob.content()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";

    fn pointer(size: u64) -> String {
        format!("{LFS_VERSION_LINE}\noid sha256:{OID}\nsize {size}\n")
    }

    #[test]
    fn a_pointer_is_recognised_and_anything_else_is_not() {
        assert_eq!(parse_lfs_pointer(pointer(12345).as_bytes()), Some((OID.to_string(), 12345)));
        assert_eq!(parse_lfs_pointer(b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(parse_lfs_pointer(format!("{LFS_VERSION_LINE}\nsize 3\n").as_bytes()), None, "no oid");
    }

    #[test]
    fn a_side_follows_its_pointer_to_the_downloaded_object() {
        let dir = std::env::temp_dir().join(format!("codeflow-blobs-{}", uuid::Uuid::new_v4()));
        let repo = git2::Repository::init(&dir).unwrap();
        std::fs::write(dir.join("logo.png"), pointer(4)).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("logo.png")).unwrap();
        index.write().unwrap();
        let root = dir.to_string_lossy().to_string();

        let missing = file_side(&root, "logo.png", "INDEX").unwrap();
        assert_eq!(missing.lfs.as_ref().map(|l| l.downloaded), Some(false));
        assert_eq!(missing.size, 4);
        assert!(missing.data.is_none());

        let store = dir.join(".git/lfs/objects").join(&OID[0..2]).join(&OID[2..4]);
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join(OID), b"\x89PNG").unwrap();
        let found = file_side(&root, "logo.png", "WORKDIR").unwrap();
        assert_eq!(found.lfs.as_ref().map(|l| l.downloaded), Some(true));
        assert_eq!(found.data.as_deref(), Some(encode(b"\x89PNG").as_str()));

        assert!(!file_side(&root, "logo.png", "HEAD").unwrap().exists, "an unborn HEAD has nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
