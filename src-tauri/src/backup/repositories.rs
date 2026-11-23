//! Portable working copies, including Git history and uncommitted files.
//!
//! What stays out is what a fresh clone and a build would bring back: whatever the repository's own
//! `.gitignore` (and `.git/info/exclude`) ignores, plus a fixed list of dependency, cache and build
//! folders as a safety net for folders without a Git repository or with an incomplete `.gitignore`.
//! Local `.env` files stay out too, ignored or not — the backup is meant to sit in a shared drive,
//! and those are the files a person would least expect to find in it. Anything Git *tracks* always
//! travels, whatever its name: leaving it out would restore as a deletion.
//!
//! `.dockerignore`, `.npmignore` and the AI tools' ignore files are deliberately not consulted: they
//! say what a build context, a package or a model does not need — often the `.git` folder, the tests
//! or the documentation — not what a backup can do without.
//!
//! Each folder is a tar compressed with brotli before it is base64-encoded into the payload; the
//! envelope's own deflate cannot do much with base64, and a source tree compresses far better as
//! raw bytes.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use super::snapshot::{Selection, TableDump};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepositoryArchive {
    pub source_path: String,
    /// Base64 of the folder's tar, compressed as `compression` says.
    pub archive: String,
    /// [`BROTLI`] for archives written now; empty for an uncompressed tar, which is what backups
    /// made before compression carry (the field is missing from them altogether).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub compression: String,
}

pub const BROTLI: &str = "br";

/// Brotli quality 5 with a 4 MiB window. Measured on CodeFlow's own checkout (107 MB of tar, 46 MB
/// of it `.git`): the working tree shrinks to a quarter at every quality from 5 to 9, and the Git
/// objects are already zlib-compressed, so quality 9 with a 16 MiB window saves 5% more of the file
/// at five times the time — a minute instead of a dozen seconds for one repository, on every
/// scheduled backup.
const BROTLI_QUALITY: u32 = 5;
const BROTLI_WINDOW: u32 = 22;
const BROTLI_BUFFER: usize = 64 * 1024;

/// A repository whose folder was left out of the file: where it was, and what it takes to get it
/// back — the remote to clone from and the branch it was on. The project's own row still travels in
/// the core; this is only what the row cannot say (the branch) or might not (a project added from a
/// local folder has no `remote_url` of its own, but its checkout usually has an `origin`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepositoryRef {
    pub source_path: String,
    pub name: String,
    pub remote_url: String,
    pub branch: String,
}

/// What [`collect`] gathered: the folders that go into the file, and the ones that stay behind.
#[derive(Debug, Default)]
pub struct Collected {
    pub archives: Vec<RepositoryArchive>,
    pub skipped: Vec<RepositoryRef>,
}

/// One project's folder, as the `projects` dump has it.
struct ProjectFolder {
    id: String,
    name: String,
    path: String,
    remote_url: String,
}

fn project_folders(tables: &[TableDump]) -> Vec<ProjectFolder> {
    let Some(projects) = tables.iter().find(|t| t.name == "projects") else {
        return Vec::new();
    };
    let column = |name: &str| projects.columns.iter().position(|c| c == name);
    let Some(path) = column("local_path") else {
        return Vec::new();
    };
    let (id, name, remote) = (column("id"), column("name"), column("remote_url"));
    let text = |row: &[serde_json::Value], index: Option<usize>| {
        index
            .and_then(|i| row.get(i))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    projects
        .rows
        .iter()
        .filter_map(|row| {
            let folder = text(row, Some(path));
            (!folder.is_empty()).then(|| ProjectFolder {
                id: text(row, id),
                name: text(row, name),
                path: folder,
                remote_url: text(row, remote),
            })
        })
        .collect()
}

/// The checkout's `origin`, or its only remote — for a project whose row has no remote URL.
fn checkout_remote(path: &Path) -> String {
    let Ok(repo) = git2::Repository::open(path) else {
        return String::new();
    };
    let url = |name: &str| repo.find_remote(name).ok().and_then(|r| r.url().map(str::to_string));
    url("origin")
        .or_else(|| {
            let names = repo.remotes().ok()?;
            let only = names.iter().flatten().next()?.to_string();
            url(&only)
        })
        .unwrap_or_default()
}

/// The branch checked out, or empty for a detached HEAD, an unborn branch or no repository at all.
fn checkout_branch(path: &Path) -> String {
    git2::Repository::open(path)
        .ok()
        .and_then(|repo| {
            let head = repo.head().ok()?;
            head.is_branch().then(|| head.shorthand().map(str::to_string)).flatten()
        })
        .unwrap_or_default()
}

fn generated(path: &Path, directory: bool) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if directory {
        if matches!(
            name,
            "node_modules"
                | ".pnpm-store"
                | ".yarn-cache"
                | ".next"
                | ".nuxt"
                | ".output"
                | ".svelte-kit"
                | ".angular"
                | ".parcel-cache"
                | ".turbo"
                | ".vite"
                | "__pycache__"
                | ".venv"
                | ".pytest_cache"
                | ".mypy_cache"
                | ".ruff_cache"
                | ".tox"
                | ".nox"
                | ".gradle"
                | ".m2"
                | ".dart_tool"
                | ".cache"
                | ".phpunit.cache"
                | ".eggs"
                | ".hypothesis"
        ) {
            return true;
        }
        let parent = path.parent().unwrap_or(path);
        let has = |file: &str| parent.join(file).is_file();
        match name {
            "target" => has("Cargo.toml") || has("pom.xml"),
            "vendor" => has("composer.json") || has("go.mod"),
            "venv" | "env" => path.join("pyvenv.cfg").is_file(),
            "dist" | "build" | "coverage" => {
                has("package.json")
                    || has("build.gradle")
                    || has("build.gradle.kts")
                    || has("pyproject.toml")
                    || has("setup.py")
            }
            "out" => has("build.gradle") || has("build.gradle.kts"),
            "cache" | "unplugged" => parent.file_name().is_some_and(|name| name == ".yarn"),
            name if name.ends_with(".egg-info") => true,
            _ => false,
        }
    } else {
        matches!(
            name,
            ".DS_Store"
                | "Thumbs.db"
                | "desktop.ini"
                | ".phpunit.result.cache"
                | ".coverage"
                | "npm-debug.log"
                | "yarn-error.log"
                | "pnpm-debug.log"
                | ".php-cs-fixer.cache"
        ) || name.ends_with(".pyc")
            || name.ends_with(".pyo")
            || name.ends_with(".class")
            || name.ends_with(".tsbuildinfo")
            || name.ends_with(".cfbackup")
            || name.ends_with(".swp")
            || name.ends_with(".swo")
    }
}

/// A local environment file: `.env`, `.env.local`, `.env.production`, direnv's `.envrc`… but not
/// the templates a project keeps next to them (`.env.example`, `.env.sample`, …), which hold no
/// values and are worth having back.
fn local_env(name: &str) -> bool {
    let template = [".example", ".sample", ".template", ".dist", ".defaults"]
        .iter()
        .any(|suffix| name.ends_with(suffix));
    (name == ".env" || name == ".envrc" || name.starts_with(".env.")) && !template
}

/// One Git repository's view of the folders under it: what its ignore rules leave out, and what it
/// tracks (which travels regardless).
struct Ignores {
    repo: git2::Repository,
    /// The repository's working directory, as a path inside the archive.
    base: PathBuf,
    /// Tracked files, and every directory that holds one, relative to the working directory.
    tracked: HashSet<String>,
}

impl Ignores {
    /// `None` when `root` is not the top of a working copy Git can open.
    fn open(root: &Path, base: &Path) -> Option<Self> {
        let repo = git2::Repository::open(root).ok()?;
        let workdir = repo.workdir()?;
        if fs::canonicalize(workdir).ok()? != fs::canonicalize(root).ok()? {
            return None;
        }
        let mut tracked = HashSet::new();
        if let Ok(index) = repo.index() {
            for entry in index.iter() {
                let Ok(path) = String::from_utf8(entry.path) else {
                    continue;
                };
                let mut end = path.len();
                tracked.insert(path.clone());
                while let Some(slash) = path[..end].rfind('/') {
                    if !tracked.insert(path[..slash].to_string()) {
                        break;
                    }
                    end = slash;
                }
            }
        }
        Some(Self { repo, base: base.to_path_buf(), tracked })
    }

    fn inner(&self, relative: &Path) -> Option<String> {
        let inner = relative.strip_prefix(&self.base).ok()?;
        Some(inner.to_string_lossy().replace('\\', "/"))
    }

    fn tracks(&self, relative: &Path) -> bool {
        self.inner(relative).is_some_and(|path| self.tracked.contains(&path))
    }

    fn ignores(&self, relative: &Path) -> bool {
        self.inner(relative)
            .filter(|path| !path.is_empty())
            .is_some_and(|path| self.repo.is_path_ignored(Path::new(&path)).unwrap_or(false))
    }
}

/// A sorted file map also lets a linked worktree override the common Git directory's HEAD/index.
///
/// `ignores` is the innermost repository holding `root`; `excluded` says `root` itself was left out
/// and is only being walked for the files its repository tracks.
fn gather(
    root: &Path,
    prefix: &Path,
    git: bool,
    files: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    gather_in(root, prefix, git, None, false, files)
}

fn gather_in(
    root: &Path,
    prefix: &Path,
    git: bool,
    ignores: Option<&Ignores>,
    excluded: bool,
    files: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    // A folder with its own `.git` answers to its own `.gitignore`, not its parent's.
    let own = if git || !root.join(".git").exists() {
        None
    } else {
        Ignores::open(root, prefix)
    };
    let ignores = own.as_ref().or(ignores);
    let entries = fs::read_dir(root).map_err(|e| format!("{}: {e}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = prefix.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let mut left_out = excluded;
        if !git && entry.file_name() != ".git" {
            let tracked = ignores.is_some_and(|i| i.tracks(&relative));
            if !tracked {
                if excluded {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_str().unwrap_or_default();
                let dir = kind.is_dir();
                if local_env(name) || generated(&path, dir) {
                    continue;
                }
                // An ignored folder that is a repository of its own is someone's work, not output.
                if ignores.is_some_and(|i| i.ignores(&relative))
                    && !(dir && path.join(".git").exists())
                {
                    continue;
                }
            } else if !excluded && kind.is_dir() {
                // Walked for its tracked files only, when the folder itself would be left out.
                let name = entry.file_name();
                left_out = generated(&path, true)
                    || local_env(name.to_str().unwrap_or_default())
                    || ignores.is_some_and(|i| i.ignores(&relative));
            }
        }
        if git {
            // Locks and worktree registrations belong to the source machine. The Git objects,
            // refs, reflogs, index, hooks and configuration themselves all travel.
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".lock"))
                || (prefix.file_name().is_some_and(|name| name == ".git")
                    && matches!(
                        entry.file_name().to_str(),
                        Some("worktrees" | "commondir" | "gitdir")
                    ))
            {
                continue;
            }
        }
        if entry.file_name() == ".git" && !git {
            let common = crate::git_exclude::common_git_dir(root)
                .ok_or_else(|| format!("{}: could not read the Git directory", path.display()))?;
            // Borrowed object databases would otherwise leave a backup depending on another disk.
            if common.join("objects/info/alternates").is_file() {
                return Err(format!(
                    "{}: Git alternates must be made self-contained before backing up",
                    root.display()
                ));
            }
            gather(&common, &relative, true, files)?;
            if kind.is_file() {
                let repo = git2::Repository::open(root).map_err(|e| e.to_string())?;
                for name in ["HEAD", "index", "logs/HEAD", "config.worktree"] {
                    let own = repo.path().join(name);
                    if own.is_file() {
                        files.insert(relative.join(name), own);
                    }
                }
            }
        } else if kind.is_dir() {
            files.insert(relative.clone(), path.clone());
            gather_in(&path, &relative, git, ignores, left_out, files)?;
        } else if kind.is_file() || kind.is_symlink() {
            files.insert(relative, path);
        }
    }
    Ok(())
}

fn pack(root: &Path) -> Result<String, String> {
    let mut files = BTreeMap::new();
    gather(root, Path::new(""), false, &mut files)?;
    // Windows checkouts do not expose Git's executable bit in filesystem metadata.
    let tracked: BTreeMap<Vec<u8>, u32> = if cfg!(windows) {
        git2::Repository::open(root)
            .ok()
            .and_then(|repo| repo.index().ok())
            .map(|index| index.iter().map(|entry| (entry.path, entry.mode)).collect())
            .unwrap_or_default()
    } else {
        BTreeMap::new()
    };
    let encoder =
        brotli::CompressorWriter::new(Vec::new(), BROTLI_BUFFER, BROTLI_QUALITY, BROTLI_WINDOW);
    let mut archive = tar::Builder::new(encoder);
    for (relative, source) in files {
        let portable = relative
            .to_str()
            .ok_or("repository contains a non-UTF-8 filename")?
            .replace('\\', "/");
        let relative = Path::new(&portable);
        safe_relative(relative)?;
        let metadata =
            fs::symlink_metadata(&source).map_err(|e| format!("{}: {e}", source.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_metadata_in_mode(&metadata, tar::HeaderMode::Deterministic);
        // Timestamps must not make an unchanged scheduled backup look different.
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        let git_mode = tracked.get(portable.as_bytes()).copied().unwrap_or(0);
        if git_mode == 0o100755 {
            header.set_mode(0o755);
        }
        let result = if metadata.is_symlink() {
            let target = fs::read_link(&source).map_err(|e| e.to_string())?;
            let target = PathBuf::from(target.to_string_lossy().replace('\\', "/"));
            safe_link(relative, &target)?;
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            archive.append_link(&mut header, relative, target)
        } else if git_mode == 0o120000 {
            let target = fs::read_to_string(&source).map_err(|e| e.to_string())?;
            let target = Path::new(&target);
            safe_link(relative, target)?;
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            archive.append_link(&mut header, relative, target)
        } else if metadata.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            archive.append_data(&mut header, relative, std::io::empty())
        } else {
            let file = fs::File::open(&source).map_err(|e| format!("{}: {e}", source.display()))?;
            archive.append_data(&mut header, relative, file)
        };
        result.map_err(|e| format!("{}: {e}", source.display()))?;
    }
    // `into_inner` on the encoder finishes the brotli stream.
    archive
        .into_inner()
        .map(|encoder| B64.encode(encoder.into_inner()))
        .map_err(|e| e.to_string())
}

/// The folders the selection asks for, packed; and, for every project whose folder it leaves out,
/// what a restore needs to offer cloning it instead.
///
/// A folder shared by several projects travels when any of them wants it. An unavailable folder
/// fails the backup only when it was asked for: one the user left out is not a hole in the file.
pub fn collect(tables: &[TableDump], selection: &Selection) -> Result<Collected, String> {
    let mut wanted = BTreeMap::new();
    let mut left_out: BTreeMap<String, ProjectFolder> = BTreeMap::new();
    for project in project_folders(tables) {
        if selection.repositories && !selection.excluded_repositories.contains(&project.id) {
            wanted.insert(project.path.clone(), ());
        } else {
            left_out.entry(project.path.clone()).or_insert(project);
        }
    }
    left_out.retain(|path, _| !wanted.contains_key(path));
    let archives = wanted
        .into_keys()
        .map(|path| {
            if !Path::new(&path).is_dir() {
                return Err(format!(
                    "repository folder is unavailable; the backup was not written: {path}"
                ));
            }
            let archive = pack(Path::new(&path))?;
            Ok(RepositoryArchive {
                source_path: path,
                archive,
                compression: BROTLI.into(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let skipped = left_out
        .into_values()
        .map(|project| {
            let folder = Path::new(&project.path);
            RepositoryRef {
                remote_url: if project.remote_url.is_empty() {
                    checkout_remote(folder)
                } else {
                    project.remote_url
                },
                branch: checkout_branch(folder),
                name: project.name,
                source_path: project.path,
            }
        })
        .collect();
    Ok(Collected { archives, skipped })
}

/// Roughly what a folder adds to a backup: the bytes [`pack`] would read from it, with the same
/// exclusions (ignored files, `.env`, dependencies, caches, build output) and the same Git directory
/// rules. Before compression, so it errs on the large side — which is the side worth erring on when
/// deciding whether something fits a shared drive.
pub fn folder_size(path: &Path) -> Result<u64, String> {
    if !path.is_dir() {
        return Err(format!("{}: folder not found", path.display()));
    }
    let mut files = BTreeMap::new();
    gather(path, Path::new(""), false, &mut files)?;
    Ok(files
        .values()
        .filter_map(|source| fs::symlink_metadata(source).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum())
}

/// Never interpret a foreign drive, backslash or parent traversal using the host's path parser.
fn safe_relative(path: &Path) -> Result<(), String> {
    let raw = path.to_string_lossy();
    if path.as_os_str().is_empty()
        || raw.contains(['\\', ':', '\0'])
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!(
            "unsafe repository archive path: {}",
            path.display()
        ));
    }
    Ok(())
}

fn safe_link(path: &Path, target: &Path) -> Result<PathBuf, String> {
    let mut resolved = path.parent().unwrap_or(Path::new("")).to_path_buf();
    if target.to_string_lossy().contains(['\\', ':', '\0']) {
        return Err(format!("unsafe repository symlink: {}", path.display()));
    }
    for component in target.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir if resolved.pop() => {}
            _ => {
                return Err(format!(
                    "repository symlink leaves its working copy: {}",
                    path.display()
                ))
            }
        }
    }
    safe_relative(Path::new(&resolved.to_string_lossy().replace('\\', "/")))?;
    Ok(resolved)
}

/// Resolve the archive's own links before installing them; a chain of individually relative
/// targets can otherwise escape through `..` after a previous component resolves to a symlink.
fn resolve_link(
    path: &Path,
    target: &Path,
    links: &[(PathBuf, PathBuf, PathBuf)],
    seen: &mut Vec<PathBuf>,
) -> Result<PathBuf, String> {
    if seen.iter().any(|other| other == path) {
        return Err("repository contains a symlink cycle".into());
    }
    seen.push(path.to_path_buf());
    let mut resolved = path.parent().unwrap_or(Path::new("")).to_path_buf();
    for component in target.components() {
        match component {
            Component::Normal(part) => {
                resolved.push(part);
                if let Some((other, target, _)) =
                    links.iter().find(|(other, _, _)| *other == resolved)
                {
                    resolved = resolve_link(other, target, links, seen)?;
                }
            }
            Component::CurDir => {}
            Component::ParentDir if resolved.pop() => {}
            _ => return Err("repository symlink leaves its working copy".into()),
        }
    }
    seen.pop();
    Ok(resolved)
}

fn unpack(packed: &RepositoryArchive, directory: &Path) -> Result<(), String> {
    let bytes = B64.decode(&packed.archive).map_err(|e| e.to_string())?;
    let reader: Box<dyn Read> = match packed.compression.as_str() {
        "" => Box::new(Cursor::new(bytes)),
        BROTLI => Box::new(brotli::Decompressor::new(Cursor::new(bytes), BROTLI_BUFFER)),
        other => return Err(format!("unsupported repository archive compression: {other}")),
    };
    let mut archive = tar::Archive::new(reader);
    let mut links = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        safe_relative(&path)?;
        let key = path.to_string_lossy();
        let key = if cfg!(any(windows, target_os = "macos")) {
            key.to_lowercase()
        } else {
            key.into_owned()
        };
        if !seen.insert(key) {
            return Err("repository archive contains conflicting file names".into());
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|e| e.to_string())?
                .ok_or("repository symlink has no target")?
                .into_owned();
            let resolved = safe_link(&path, &target)?;
            links.push((path, target, resolved));
        } else if kind.is_file() || kind.is_dir() {
            if !entry.unpack_in(directory).map_err(|e| e.to_string())? {
                return Err("repository entry leaves its destination".into());
            }
        } else {
            return Err(format!(
                "unsupported repository archive entry: {}",
                path.display()
            ));
        }
    }
    // Links are installed last so an archive cannot redirect later writes outside the new folder.
    for (path, target, _) in &links {
        if links
            .iter()
            .any(|(other, _, _)| path != other && path.starts_with(other))
        {
            return Err("repository archive puts a file inside a symlink".into());
        }
        let _resolved = resolve_link(path, target, &links, &mut Vec::new())?;
        let destination = directory.join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, destination).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            let source = directory.join(_resolved);
            // Windows does not grant symlink creation to a normal installation. Materialise the
            // target instead; all archive writes have finished and it stays inside the new copy.
            let _ = target;
            copy_link_target(&source, &destination)?;
        }
    }
    // Discard machine-specific Git worktree locations; linked worktrees/submodules become
    // independent repositories holding their own object database, HEAD and index.
    relocate_git(directory)?;
    Ok(())
}

fn relocate_git(directory: &Path) -> Result<(), String> {
    for file in ["config", "config.worktree"] {
        let config_path = directory.join(".git").join(file);
        if !config_path.is_file() {
            continue;
        }
        let mut config = git2::Config::open(&config_path).map_err(|e| e.to_string())?;
        let _ = config.remove("core.worktree");
        config
            .set_bool("core.bare", false)
            .map_err(|e| e.to_string())?;
        config
            .set_bool("core.filemode", cfg!(unix))
            .map_err(|e| e.to_string())?;
        config
            .set_bool("core.symlinks", cfg!(unix))
            .map_err(|e| e.to_string())?;
    }
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() != ".git" && entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            relocate_git(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn copy_link_target(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.starts_with(source) {
        return Err("a repository directory link points to its own ancestor".into());
    }
    let kind = fs::symlink_metadata(source).map_err(|e| format!("{}: {e}", source.display()))?;
    if kind.is_dir() {
        fs::create_dir(destination).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_link_target(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if kind.is_file() {
        fs::copy(source, destination).map_err(|e| e.to_string())?;
    } else {
        return Err("repository link target is not a regular file or directory".into());
    }
    Ok(())
}

fn folder_name(source: &str) -> String {
    let last = source
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("repository");
    let name: String = last
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches('.');
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return format!("repository-{name}");
    }
    if name.is_empty() {
        "repository".into()
    } else {
        name.into()
    }
}

/// Deletes only directories created by this attempt if extraction or the database transaction
/// fails. Existing working copies are never overwritten by an import, in either restore mode.
pub struct RestoredRepositories {
    pub mappings: Vec<(String, PathBuf)>,
    created: Vec<PathBuf>,
    committed: bool,
}

impl RestoredRepositories {
    pub fn commit(mut self) -> usize {
        self.committed = true;
        self.created.len()
    }
}

impl Drop for RestoredRepositories {
    fn drop(&mut self) {
        if !self.committed {
            for directory in &self.created {
                let _ = fs::remove_dir_all(directory);
            }
        }
    }
}

pub fn restore(
    archives: &[RepositoryArchive],
    root: &Path,
) -> Result<RestoredRepositories, String> {
    let mut restored = RestoredRepositories {
        mappings: Vec::new(),
        created: Vec::new(),
        committed: false,
    };
    if !archives.is_empty() {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
    }
    for archive in archives {
        let name = folder_name(&archive.source_path);
        let mut suffix = 0;
        let destination = loop {
            let candidate = root.join(if suffix == 0 {
                name.clone()
            } else {
                format!("{name}-restored-{suffix}")
            });
            match fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => suffix += 1,
                Err(e) => return Err(format!("{}: {e}", candidate.display())),
            }
        };
        restored.created.push(destination.clone());
        unpack(archive, &destination)?;
        restored
            .mappings
            .push((archive.source_path.clone(), destination));
    }
    // Match a nested repository before a containing repository when rebasing stored file paths.
    restored.mappings.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    Ok(restored)
}

/// Where a project whose folder was left out of the file ends up pointing.
#[derive(Debug, Clone)]
pub struct Placement {
    pub reference: RepositoryRef,
    pub destination: PathBuf,
    /// Whether the project's stored path changes. `false` when its original folder is right here —
    /// a restore onto the machine the backup was made on — and nothing needs rewriting.
    pub moved: bool,
}

/// Comparable form of a remote: no credentials, no trailing `/` or `.git`, case folded.
fn normalize_remote(url: &str) -> String {
    let url = url.trim().to_lowercase();
    let url = match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
            let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
            format!("{scheme}://{host}/{path}")
        }
        None => url,
    };
    url.trim_end_matches('/').trim_end_matches(".git").to_string()
}

/// Picks, for every repository left out of the file, the folder its project should point at: the
/// place [`restore`] would have extracted it to (`<clone root>/<folder name>`), so cloning it there
/// afterwards puts everything back where a full backup would have.
///
/// A folder already there is used only when it is the same repository (same remote); anything else
/// gets the same `-restored-N` suffix an extracted copy would. `taken` are the folders this restore
/// has just extracted, which are never shared with a repository that was not in the file.
pub fn place_skipped(refs: &[RepositoryRef], root: &Path, taken: &[PathBuf]) -> Vec<Placement> {
    let mut taken: Vec<PathBuf> = taken.to_vec();
    refs.iter()
        .map(|reference| {
            let original = Path::new(&reference.source_path);
            if original.is_absolute() && original.is_dir() {
                return Placement {
                    reference: reference.clone(),
                    destination: original.to_path_buf(),
                    moved: false,
                };
            }
            let name = folder_name(&reference.source_path);
            let remote = normalize_remote(&reference.remote_url);
            let mut suffix = 0;
            let destination = loop {
                let candidate = root.join(if suffix == 0 {
                    name.clone()
                } else {
                    format!("{name}-restored-{suffix}")
                });
                suffix += 1;
                if taken.contains(&candidate) {
                    continue;
                }
                if !candidate.exists() {
                    break candidate;
                }
                if !remote.is_empty() && normalize_remote(&checkout_remote(&candidate)) == remote {
                    break candidate;
                }
            };
            taken.push(destination.clone());
            Placement { reference: reference.clone(), destination, moved: true }
        })
        .collect()
}

fn rebase(value: &str, mappings: &[(String, PathBuf)]) -> Option<String> {
    let normalized = value.replace('\\', "/");
    for (source, destination) in mappings {
        let source = source.replace('\\', "/").trim_end_matches('/').to_string();
        let windows = source.as_bytes().get(1) == Some(&b':') || source.starts_with("//");
        let matches = if windows {
            normalized
                .get(..source.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&source))
        } else {
            normalized.starts_with(&source)
        };
        if matches
            && (normalized.len() == source.len()
                || normalized.as_bytes().get(source.len()) == Some(&b'/'))
        {
            let mut path = destination.clone();
            for component in normalized[source.len()..]
                .split('/')
                .filter(|s| !s.is_empty())
            {
                if component == ".." {
                    return None;
                }
                if component == "." {
                    continue;
                }
                path.push(component);
            }
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}

fn rebase_json(value: &mut serde_json::Value, mappings: &[(String, PathBuf)]) {
    match value {
        serde_json::Value::String(text) => {
            if let Some(path) = rebase(text, mappings) {
                *text = path;
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                rebase_json(value, mappings);
            }
        }
        serde_json::Value::Object(object) => {
            *object = std::mem::take(object)
                .into_iter()
                .map(|(key, mut value)| {
                    rebase_json(&mut value, mappings);
                    (rebase(&key, mappings).unwrap_or(key), value)
                })
                .collect();
        }
        _ => {}
    }
}

pub fn remap_tables(tables: &mut [TableDump], mappings: &[(String, PathBuf)], clone_root: &Path) {
    for table in tables {
        if table.name == "app_settings" {
            let key = table.columns.iter().position(|c| c == "key");
            let value = table.columns.iter().position(|c| c == "value");
            if let (Some(key), Some(value)) = (key, value) {
                if !table
                    .rows
                    .iter()
                    .any(|row| row.get(key).and_then(|v| v.as_str()) == Some("clone_root"))
                {
                    let mut row = vec![serde_json::Value::Null; table.columns.len()];
                    row[key] = "clone_root".into();
                    row[value] = clone_root.to_string_lossy().into_owned().into();
                    table.rows.push(row);
                }
            }
        }
        for row in &mut table.rows {
            for value in row.iter_mut() {
                if let Some(text) = value.as_str() {
                    if let Some(path) = rebase(text, mappings) {
                        *value = path.into();
                    } else if let Ok(
                        mut json @ (serde_json::Value::Object(_) | serde_json::Value::Array(_)),
                    ) = serde_json::from_str(text)
                    {
                        let before = json.clone();
                        rebase_json(&mut json, mappings);
                        if json != before {
                            *value = json.to_string().into();
                        }
                    }
                }
            }
            if table.name == "app_settings" {
                let key = table.columns.iter().position(|c| c == "key");
                let value = table.columns.iter().position(|c| c == "value");
                if let (Some(key), Some(value)) = (key, value) {
                    if row.get(key).and_then(|v| v.as_str()) == Some("clone_root") {
                        if let Some(value) = row.get_mut(value) {
                            *value = clone_root.to_string_lossy().into_owned().into();
                        }
                    }
                    if row.get(key).and_then(|v| v.as_str()) == Some("scaffold_prefs") {
                        if let Some(value) = row.get_mut(value) {
                            if let Some(fixed) = local_scaffold_parent(value.as_str(), clone_root) {
                                *value = fixed.into();
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The "new project" dialog remembers the last base folder it created a project in
/// (`scaffold_prefs.parent`). A folder from the machine the backup was made on — `C:\\Users\\<them>\\…`
/// restored onto a Mac, or a folder that is simply not here — is replaced by this install's clone
/// root, the same place the dialog would have offered on a fresh install. `None` when nothing needs
/// to change.
fn local_scaffold_parent(raw: Option<&str>, clone_root: &Path) -> Option<String> {
    let mut prefs: serde_json::Value = serde_json::from_str(raw?).ok()?;
    let parent = prefs.get("parent")?.as_str()?;
    if parent.is_empty() || (Path::new(parent).is_absolute() && Path::new(parent).is_dir()) {
        return None;
    }
    prefs["parent"] = clone_root.to_string_lossy().into_owned().into();
    Some(prefs.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_foreign_scaffold_base_folder_becomes_this_installs_clone_root() {
        let root = std::env::temp_dir();
        let foreign = if cfg!(windows) { "/Users/someone/CodeFlow/repos" } else { r"C:\Users\someone\CodeFlow\repos" };
        let raw = json!({ "parent": foreign, "pm": "npm" }).to_string();
        let fixed: serde_json::Value = serde_json::from_str(&local_scaffold_parent(Some(&raw), &root).unwrap()).unwrap();
        assert_eq!(fixed["parent"], root.to_string_lossy().as_ref());
        assert_eq!(fixed["pm"], "npm");
    }

    #[test]
    fn a_scaffold_base_folder_that_exists_here_is_kept() {
        let here = std::env::temp_dir();
        let raw = json!({ "parent": here.to_string_lossy() }).to_string();
        assert_eq!(local_scaffold_parent(Some(&raw), Path::new("/elsewhere")), None);
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("codeflow-backup-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn keeps_git_history_and_dirty_files_without_ignored_generated_or_env_files() {
        let temp = TestDir::new();
        let source = temp.0.join("source");
        let repo = git2::Repository::init(&source).unwrap();
        write(&source, "src/main.ts", "committed");
        // Tracked although its folder and name are ignored: travels, or it restores as deleted.
        write(&source, "logs/keep.log", "tracked");
        write(&source, "config/.env.shared", "TRACKED=1");
        let mut index = repo.index().unwrap();
        for tracked in ["src/main.ts", "logs/keep.log", "config/.env.shared"] {
            index.add_path(Path::new(tracked)).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Backup", "backup@example.com").unwrap();
        let commit = repo
            .commit(Some("HEAD"), &signature, &signature, "original", &tree, &[])
            .unwrap();
        write(&source, "src/main.ts", "uncommitted edit");
        write(&source, ".gitignore", ".env\nnode_modules\nlogs/\n*.log\n.terraform/\nbin/\nobj/\ntools/\n");
        write(&source, ".env", "SECRET=leave-me");
        write(&source, ".env.local", "SECRET=leave-me");
        write(&source, "api/.env.production", "SECRET=leave-me");
        write(&source, ".envrc", "export SECRET=leave-me");
        write(&source, ".env.example", "SECRET=");
        write(&source, "logs/today.log", "ignored");
        write(&source, "debug.log", "ignored");
        write(&source, "infra/.terraform/providers/aws", "ignored");
        write(&source, "dotnet/bin/Debug/app.dll", "ignored");
        write(&source, "dotnet/obj/project.assets.json", "ignored");
        write(&source, "dotnet/Program.cs", "keep");
        // Ignored, but a repository of its own: someone's work, not build output.
        git2::Repository::init(source.join("tools")).unwrap();
        write(&source, "tools/main.go", "keep");
        write(&source, "tools/.env", "SECRET=leave-me");
        write(&source, "package.json", "{}");
        write(&source, "node_modules/dependency/index.js", "generated");
        write(&source, "dist/app.js", "generated");
        write(&source, "build/app.js", "generated");
        write(&source, "rust/Cargo.toml", "[package]");
        write(&source, "rust/target/debug/app", "generated");
        write(&source, "php/composer.json", "{}");
        write(&source, "php/vendor/autoload.php", "generated");
        write(&source, "java/pom.xml", "<project/>");
        write(&source, "java/target/classes/App.class", "generated");
        write(&source, "gradle/build.gradle.kts", "plugins {}");
        write(&source, "gradle/build/classes/App.class", "generated");
        write(&source, "python/.venv/bin/python", "generated");
        write(&source, "python/__pycache__/app.pyc", "generated");
        write(&source, "python/app.py", "print('keep')");
        write(
            &source,
            "docs/build/design.md",
            "authored directory, not build output",
        );
        write(&source, ".DS_Store", "junk");
        let archive = RepositoryArchive {
            source_path: r"C:\Users\someone\CodeFlow\repos\RulesEngine".into(),
            archive: pack(&source).unwrap(),
            compression: BROTLI.into(),
        };
        let restored = restore(&[archive], &temp.0.join("destination")).unwrap();
        let destination = &restored.mappings[0].1;
        assert_eq!(destination.file_name().unwrap(), "RulesEngine");
        assert_eq!(
            fs::read_to_string(destination.join("src/main.ts")).unwrap(),
            "uncommitted edit"
        );
        for kept in [
            "docs/build/design.md",
            "python/app.py",
            "dotnet/Program.cs",
            ".env.example",
            "config/.env.shared",
            "logs/keep.log",
            ".gitignore",
        ] {
            assert!(destination.join(kept).is_file(), "{kept} was left out");
        }
        assert!(destination.join("tools/main.go").is_file(), "a nested repository was left out");
        assert!(destination.join("tools/.git").is_dir());
        for excluded in [
            ".env",
            ".env.local",
            "api/.env.production",
            "tools/.env",
            ".envrc",
            "logs/today.log",
            "debug.log",
            "infra/.terraform",
            "dotnet/bin",
            "dotnet/obj",
            "node_modules",
            "dist",
            "build",
            "rust/target",
            "php/vendor",
            "java/target",
            "gradle/build",
            "python/.venv",
            "python/__pycache__",
            ".DS_Store",
        ] {
            assert!(!destination.join(excluded).exists(), "{excluded} travelled");
        }
        let copied = git2::Repository::open(destination).unwrap();
        assert_eq!(copied.head().unwrap().target(), Some(commit));
        assert!(copied
            .status_file(Path::new("src/main.ts"))
            .unwrap()
            .is_wt_modified());
    }

    #[test]
    fn repository_changes_affect_the_digest_but_timestamps_and_excluded_files_do_not() {
        let temp = TestDir::new();
        write(&temp.0, "source.txt", "one");
        let first = pack(&temp.0).unwrap();
        write(&temp.0, "source.txt", "one");
        write(&temp.0, "node_modules/dependency", "generated");
        assert_eq!(first, pack(&temp.0).unwrap());
        write(&temp.0, "source.txt", "two");
        assert_ne!(first, pack(&temp.0).unwrap());
    }

    #[test]
    fn rebases_both_foreign_path_styles_and_json_without_matching_similar_repository_names() {
        for old in [
            r"C:\Users\someone\CodeFlow\repos\RulesEngine",
            "/Users/sebas/CodeFlow/repos/RulesEngine",
        ] {
            let root = PathBuf::from("local-repos");
            let destination = root.join("RulesEngine");
            let mappings = vec![(old.to_string(), destination.clone())];
            let settings = json!({ "cwd": format!("{old}/src"), old: { "path": old }, "other": format!("{old}-other") }).to_string();
            let mut tables = vec![
                TableDump {
                    name: "projects".into(),
                    columns: vec!["local_path".into()],
                    rows: vec![vec![old.into()]],
                },
                TableDump {
                    name: "app_settings".into(),
                    columns: vec!["key".into(), "value".into()],
                    rows: vec![
                        vec!["editor".into(), settings.into()],
                        vec!["clone_root".into(), "foreign-root".into()],
                    ],
                },
            ];
            remap_tables(&mut tables, &mappings, &root);
            assert_eq!(tables[0].rows[0][0], destination.to_string_lossy().as_ref());
            let updated: serde_json::Value =
                serde_json::from_str(tables[1].rows[0][1].as_str().unwrap()).unwrap();
            assert_eq!(
                updated["cwd"],
                destination.join("src").to_string_lossy().as_ref()
            );
            assert_eq!(
                updated[destination.to_string_lossy().as_ref()]["path"],
                destination.to_string_lossy().as_ref()
            );
            assert_eq!(updated["other"], format!("{old}-other"));
            assert_eq!(tables[1].rows[1][1], "local-repos");
        }
    }

    #[test]
    fn never_overwrites_existing_folders_and_cleans_up_an_uncommitted_restore() {
        let temp = TestDir::new();
        let source = temp.0.join("source");
        write(&source, "file", "backup");
        let root = temp.0.join("repos");
        write(&root, "RulesEngine/file", "existing work");
        let archives = [RepositoryArchive {
            source_path: "/Users/test/RulesEngine".into(),
            archive: pack(&source).unwrap(),
            compression: BROTLI.into(),
        }];
        let restored = restore(&archives, &root).unwrap();
        let created = restored.mappings[0].1.clone();
        assert_eq!(
            fs::read_to_string(root.join("RulesEngine/file")).unwrap(),
            "existing work"
        );
        assert_eq!(fs::read_to_string(created.join("file")).unwrap(), "backup");
        drop(restored);
        assert!(!created.exists());
        assert!(root.join("RulesEngine/file").exists());
        assert_eq!(restore(&archives, &root).unwrap().commit(), 1);
    }

    #[test]
    fn refuses_unsafe_entries_and_leaves_no_partial_working_copy() {
        for path in ["../escape", "/absolute", r"C:\outside", r"folder\..\escape"] {
            assert!(safe_relative(Path::new(path)).is_err(), "accepted {path}");
        }
        assert!(safe_link(Path::new("link"), Path::new("../outside")).is_err());
        assert!(safe_link(Path::new("link"), Path::new("/outside")).is_err());
        let temp = TestDir::new();
        let archives = [RepositoryArchive {
            source_path: "repo".into(),
            archive: "not a tar".into(),
            ..Default::default()
        }];
        assert!(restore(&archives, &temp.0).is_err());
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 0);
    }

    #[test]
    fn unavailable_repositories_fail_instead_of_writing_an_incomplete_backup() {
        let temp = TestDir::new();
        let tables = [TableDump {
            name: "projects".into(),
            columns: vec!["local_path".into()],
            rows: vec![vec![temp
                .0
                .join("missing")
                .to_string_lossy()
                .into_owned()
                .into()]],
        }];
        assert!(collect(&tables, &Selection::default())
            .unwrap_err()
            .contains("folder is unavailable"));
    }

    fn projects(rows: &[(&str, &str, &str)]) -> Vec<TableDump> {
        vec![TableDump {
            name: "projects".into(),
            columns: vec!["id".into(), "name".into(), "local_path".into(), "remote_url".into()],
            rows: rows
                .iter()
                .map(|(id, path, remote)| {
                    vec![(*id).into(), (*id).into(), (*path).into(), (*remote).into()]
                })
                .collect(),
        }]
    }

    #[test]
    fn left_out_repositories_travel_as_a_reference_with_their_remote_and_branch() {
        let temp = TestDir::new();
        let kept = temp.0.join("kept");
        write(&kept, "file", "kept");
        let skipped = temp.0.join("skipped");
        let repo = git2::Repository::init(&skipped).unwrap();
        repo.remote("origin", "https://example.com/team/skipped.git").unwrap();
        write(&skipped, "file", "x");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file")).unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Backup", "backup@example.com").unwrap();
        let head = repo.commit(Some("HEAD"), &signature, &signature, "one", &tree, &[]).unwrap();
        repo.branch("feature/x", &repo.find_commit(head).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature/x").unwrap();
        let tables = projects(&[
            ("p1", kept.to_str().unwrap(), ""),
            ("p2", skipped.to_str().unwrap(), ""),
            // Unavailable, but left out: not a reason to fail the backup.
            ("p3", temp.0.join("gone").to_str().unwrap(), "git@example.com:team/gone.git"),
        ]);
        let selection = Selection {
            excluded_repositories: vec!["p2".into(), "p3".into()],
            ..Default::default()
        };
        let collected = collect(&tables, &selection).unwrap();
        assert_eq!(collected.archives.len(), 1);
        assert_eq!(collected.archives[0].source_path, kept.to_str().unwrap());
        assert_eq!(collected.skipped.len(), 2);
        let by_name = |name: &str| collected.skipped.iter().find(|r| r.name == name).unwrap();
        assert_eq!(by_name("p2").remote_url, "https://example.com/team/skipped.git");
        assert_eq!(by_name("p2").branch, "feature/x");
        assert_eq!(by_name("p3").remote_url, "git@example.com:team/gone.git");
        assert_eq!(by_name("p3").branch, "");

        let none = collect(&tables[..], &Selection { repositories: false, ..Default::default() });
        let none = none.unwrap();
        assert!(none.archives.is_empty());
        assert_eq!(none.skipped.len(), 3);
    }

    #[test]
    fn a_folder_shared_with_a_wanted_project_still_travels() {
        let temp = TestDir::new();
        write(&temp.0, "file", "x");
        let path = temp.0.to_str().unwrap();
        let tables = projects(&[("p1", path, ""), ("p2", path, "")]);
        let selection = Selection { excluded_repositories: vec!["p1".into()], ..Default::default() };
        let collected = collect(&tables, &selection).unwrap();
        assert_eq!(collected.archives.len(), 1);
        assert!(collected.skipped.is_empty());
    }

    #[test]
    fn the_estimated_size_skips_what_the_backup_skips() {
        let temp = TestDir::new();
        write(&temp.0, "package.json", "{}");
        write(&temp.0, "src/a.ts", "12345");
        write(&temp.0, "node_modules/dep/index.js", "a much larger generated dependency file");
        write(&temp.0, "dist/app.js", "generated output");
        assert_eq!(folder_size(&temp.0).unwrap(), 2 + 5);
        assert!(folder_size(&temp.0.join("missing")).is_err());
    }

    #[test]
    fn a_left_out_repository_is_placed_where_it_would_have_been_extracted() {
        let temp = TestDir::new();
        let root = temp.0.join("repos");
        // Already here and the same repository: used as is.
        let same = git2::Repository::init(root.join("Same")).unwrap();
        same.remote("origin", "https://user:token@Example.com/team/same").unwrap();
        // Already here but something else: not taken over.
        write(&root, "Other/file", "unrelated");
        let refs = [
            RepositoryRef { source_path: r"C:\work\Same".into(), remote_url: "https://example.com/team/same.git".into(), ..Default::default() },
            RepositoryRef { source_path: "/Users/someone/Other".into(), remote_url: "https://example.com/team/other.git".into(), ..Default::default() },
            RepositoryRef { source_path: "/Users/someone/Fresh".into(), ..Default::default() },
            RepositoryRef { source_path: "/Users/someone/Taken".into(), ..Default::default() },
            RepositoryRef { source_path: temp.0.to_string_lossy().into_owned(), ..Default::default() },
        ];
        let placed = place_skipped(&refs, &root, &[root.join("Taken")]);
        assert_eq!(placed[0].destination, root.join("Same"));
        assert_eq!(placed[1].destination, root.join("Other-restored-1"));
        assert_eq!(placed[2].destination, root.join("Fresh"));
        assert_eq!(placed[3].destination, root.join("Taken-restored-1"));
        assert!(placed[..4].iter().all(|p| p.moved));
        assert!(!placed[4].moved, "a folder that is still here stays where it is");
        assert!(!root.join("Fresh").exists(), "placing never creates the folder");
    }

    #[test]
    fn relative_symlinks_are_portable_without_leaving_the_repository() {
        let mut archive = tar::Builder::new(Vec::new());
        let mut file = tar::Header::new_gnu();
        file.set_size(7);
        file.set_mode(0o755);
        archive
            .append_data(&mut file, "src/script", &b"content"[..])
            .unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_mode(0o777);
        link.set_size(0);
        archive
            .append_link(&mut link, "script", "src/script")
            .unwrap();
        let archive = RepositoryArchive {
            source_path: "/Users/test/project".into(),
            // A tar from before compression: still restores.
            archive: B64.encode(archive.into_inner().unwrap()),
            ..Default::default()
        };
        let temp = TestDir::new();
        let restored = restore(&[archive], &temp.0).unwrap();
        let destination = &restored.mappings[0].1;
        assert_eq!(
            fs::read_to_string(destination.join("script")).unwrap(),
            "content"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(fs::symlink_metadata(destination.join("script"))
                .unwrap()
                .is_symlink());
            assert_ne!(
                fs::metadata(destination.join("src/script"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
        }
    }

    #[test]
    fn linked_worktrees_restore_as_independent_repositories() {
        let temp = TestDir::new();
        let source = temp.0.join("source");
        let repo = git2::Repository::init(&source).unwrap();
        write(&source, "file", "original");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Backup", "backup@example.com").unwrap();
        let commit = repo
            .commit(Some("HEAD"), &signature, &signature, "original", &tree, &[])
            .unwrap();
        let worktree = temp.0.join("worktree");
        repo.worktree("test-branch", &worktree, None).unwrap();
        write(&worktree, "file", "worktree changes");
        let archives = [RepositoryArchive {
            source_path: worktree.to_string_lossy().into_owned(),
            archive: pack(&worktree).unwrap(),
            compression: BROTLI.into(),
        }];
        let restored = restore(&archives, &temp.0.join("destination")).unwrap();
        let destination = &restored.mappings[0].1;
        assert!(destination.join(".git").is_dir());
        let copied = git2::Repository::open(destination).unwrap();
        assert_eq!(copied.head().unwrap().target(), Some(commit));
        assert!(copied
            .status_file(Path::new("file"))
            .unwrap()
            .is_wt_modified());
        assert!(!destination.join(".git/worktrees").exists());
    }
}
