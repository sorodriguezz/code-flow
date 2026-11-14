//! What a shared session never replicates, whatever the repository's `.gitignore` says.
//!
//! The first filter is git's: the scan only lists tracked files and untracked files git does not
//! ignore (`manifest`). These rules are the safety net for repositories whose ignore file is missing
//! or wrong. A repository with no `.gitignore` would otherwise push its whole `node_modules` to
//! every peer.
//!
//! Three kinds of rule:
//!
//! - **Dependencies and caches**, always, even when tracked. Nobody shares an install tree. Each
//!   peer runs its own install in its own worktree.
//! - **Build output**, only when untracked. A `build/` or `bin/` folder under version control is
//!   source (scripts, Gradle conventions), and git already says so by tracking it.
//! - **Secrets**, always. A tracked `.env` is already a leak, but a session must not spread the
//!   *changes* to it.
//!
//! Everything else travels, binaries included (decision 8 of the plan), up to [`MAX_FILE_BYTES`].

use serde::Serialize;

/// The largest file a session replicates. Blobs travel through PostgREST as base64 in stage B, so
/// this is set well under what one request can carry. Moving them to Supabase Storage would raise
/// it (see the plan's open risks).
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// Why a path stays on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Excluded {
    /// A dependency or cache folder (`node_modules`, `.venv`…).
    Dependencies,
    /// Untracked build output (`target`, `dist`…).
    BuildOutput,
    /// A file that holds credentials.
    Secret,
    /// A symlink: what it points at is a path on this machine, which means nothing on another one.
    Symlink,
    /// Past [`MAX_FILE_BYTES`].
    TooLarge,
    /// A name some peer's filesystem cannot hold (a `:`, a Windows device name, a trailing dot…).
    Unportable,
}

/// Folders that are never shared, at any depth, tracked or not. Matched against whole path
/// segments, so `node_modules_docs/` is not caught.
const DEPENDENCY_DIRS: &[&str] = &[
    "node_modules",
    "bower_components",
    "jspm_packages",
    ".pnpm-store",
    ".yarn-cache",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".angular",
    ".gradle",
    ".terraform",
    ".dart_tool",
    "Pods",
    ".expo",
    ".vercel",
];

/// Folders shared only when git tracks the file. Untracked, they are what a build left behind.
const BUILD_DIRS: &[&str] = &["target", "dist", "build", "out", "bin", "obj", "coverage", ".cache", "tmp"];

/// `.env` files that are templates, not secrets, and are meant to be shared.
const ENV_TEMPLATES: &[&str] = &["example", "sample", "template", "defaults", "dist"];

/// Exact file names that hold credentials.
const SECRET_NAMES: &[&str] = &[
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    ".dockercfg",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];

/// File extensions that hold keys or certificates with their private half.
const SECRET_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore", "jks", "ppk"];

/// Whether `path` (relative to the repository, either separator) stays on this machine, and why.
/// `tracked` is whether git tracks it. `size` is its length in bytes.
pub fn classify(path: &str, tracked: bool, size: u64) -> Option<Excluded> {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    let Some((name, dirs)) = segments.split_last() else {
        return None;
    };
    if dirs.iter().any(|d| DEPENDENCY_DIRS.contains(d)) {
        return Some(Excluded::Dependencies);
    }
    if !tracked && dirs.iter().any(|d| BUILD_DIRS.contains(d)) {
        return Some(Excluded::BuildOutput);
    }
    if is_secret(name) {
        return Some(Excluded::Secret);
    }
    if size > MAX_FILE_BYTES {
        return Some(Excluded::TooLarge);
    }
    None
}

/// Whether a file name, on its own, says it holds credentials.
pub fn is_secret(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env" {
        return true;
    }
    if let Some(rest) = lower.strip_prefix(".env.") {
        // `.env.example` is a template; `.env.local`, `.env.production` are the real thing.
        return !rest.split('.').any(|part| ENV_TEMPLATES.contains(&part));
    }
    if SECRET_NAMES.contains(&lower.as_str()) {
        return true;
    }
    // `id_rsa.pub` is the public half: shareable.
    if lower.starts_with("id_") && lower.ends_with(".pub") {
        return false;
    }
    match lower.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => SECRET_EXTENSIONS.contains(&ext),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_folders_never_travel_even_when_tracked() {
        assert_eq!(classify("node_modules/react/index.js", true, 10), Some(Excluded::Dependencies));
        assert_eq!(classify("apps/web/node_modules/x/y.js", false, 10), Some(Excluded::Dependencies));
        assert_eq!(classify("api\\.venv\\lib\\site.py", false, 10), Some(Excluded::Dependencies));
        assert_eq!(classify("src/__pycache__/a.pyc", true, 10), Some(Excluded::Dependencies));
    }

    #[test]
    fn a_segment_must_match_whole() {
        assert_eq!(classify("docs/node_modules_explained.md", false, 10), None);
        assert_eq!(classify("node_modules_docs/a.md", false, 10), None);
    }

    #[test]
    fn build_output_travels_only_when_git_tracks_it() {
        assert_eq!(classify("target/debug/app", false, 10), Some(Excluded::BuildOutput));
        assert_eq!(classify("web/dist/main.js", false, 10), Some(Excluded::BuildOutput));
        assert_eq!(classify("bin/release.sh", true, 10), None);
        assert_eq!(classify("build/config.gradle", true, 10), None);
    }

    #[test]
    fn env_files_are_secrets_but_their_templates_are_not() {
        for name in [".env", ".env.local", ".env.production", ".ENV", "api/.env.development.local"] {
            assert_eq!(classify(name, true, 10), Some(Excluded::Secret), "{name}");
        }
        for name in [".env.example", ".env.sample", ".env.template", ".env.local.example", "web/.env.dist"] {
            assert_eq!(classify(name, true, 10), None, "{name}");
        }
    }

    #[test]
    fn keys_and_credential_files_are_secrets() {
        for name in ["certs/server.pem", "server.key", "store.p12", "deploy/id_rsa", ".npmrc", "ci/.pypirc"] {
            assert_eq!(classify(name, false, 10), Some(Excluded::Secret), "{name}");
        }
        for name in ["deploy/id_rsa.pub", "keyboard.ts", "monkey.json", "src/key.rs", ".key"] {
            assert_eq!(classify(name, false, 10), None, "{name}");
        }
    }

    #[test]
    fn binaries_travel_up_to_the_cap() {
        assert_eq!(classify("assets/logo.png", true, 2 * 1024 * 1024), None);
        assert_eq!(classify("assets/video.mp4", true, MAX_FILE_BYTES + 1), Some(Excluded::TooLarge));
        assert_eq!(classify("assets/exact.bin", true, MAX_FILE_BYTES), None);
    }

    #[test]
    fn an_empty_path_is_not_excluded_and_does_not_panic() {
        assert_eq!(classify("", false, 0), None);
        assert_eq!(classify("/", false, 0), None);
    }
}
