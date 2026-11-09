//! Portable working copies, including Git history and uncommitted files. Generated dependencies
//! and build caches are omitted; `.gitignore` is deliberately not a backup exclusion list.

use std::collections::BTreeMap;
use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use super::snapshot::TableDump;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryArchive {
    pub source_path: String,
    /// An uncompressed tar inside the already compressed, encrypted backup envelope.
    pub archive: String,
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

/// A sorted file map also lets a linked worktree override the common Git directory's HEAD/index.
fn gather(
    root: &Path,
    prefix: &Path,
    git: bool,
    files: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|e| format!("{}: {e}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = prefix.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", path.display()))?;
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
        } else if generated(&path, kind.is_dir()) {
            continue;
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
            gather(&path, &relative, git, files)?;
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
    let mut archive = tar::Builder::new(Vec::new());
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
    archive
        .into_inner()
        .map(|bytes| B64.encode(bytes))
        .map_err(|e| e.to_string())
}

pub fn collect(tables: &[TableDump]) -> Result<Vec<RepositoryArchive>, String> {
    let mut paths = BTreeMap::new();
    if let Some(projects) = tables.iter().find(|t| t.name == "projects") {
        if let Some(column) = projects.columns.iter().position(|c| c == "local_path") {
            for row in &projects.rows {
                if let Some(path) = row
                    .get(column)
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                {
                    paths.insert(path.to_string(), ());
                }
            }
        }
    }
    paths
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
            })
        })
        .collect()
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

fn unpack(encoded: &str, directory: &Path) -> Result<(), String> {
    let bytes = B64.decode(encoded).map_err(|e| e.to_string())?;
    let mut archive = tar::Archive::new(Cursor::new(bytes));
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
        unpack(&archive.archive, &destination)?;
        restored
            .mappings
            .push((archive.source_path.clone(), destination));
    }
    // Match a nested repository before a containing repository when rebasing stored file paths.
    restored.mappings.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    Ok(restored)
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
    fn keeps_git_history_dirty_files_and_ignored_configuration_without_generated_files() {
        let temp = TestDir::new();
        let source = temp.0.join("source");
        let repo = git2::Repository::init(&source).unwrap();
        write(&source, "src/main.ts", "committed");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("src/main.ts")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Backup", "backup@example.com").unwrap();
        let commit = repo
            .commit(Some("HEAD"), &signature, &signature, "original", &tree, &[])
            .unwrap();
        write(&source, "src/main.ts", "uncommitted edit");
        write(&source, ".gitignore", ".env\nnode_modules\n");
        write(&source, ".env", "LOCAL_SETTING=keep-me");
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
        };
        let restored = restore(&[archive], &temp.0.join("destination")).unwrap();
        let destination = &restored.mappings[0].1;
        assert_eq!(destination.file_name().unwrap(), "RulesEngine");
        assert_eq!(
            fs::read_to_string(destination.join("src/main.ts")).unwrap(),
            "uncommitted edit"
        );
        assert!(destination.join(".env").is_file());
        assert!(destination.join("docs/build/design.md").is_file());
        assert!(destination.join("python/app.py").is_file());
        for excluded in [
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
        assert!(collect(&tables)
            .unwrap_err()
            .contains("folder is unavailable"));
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
            archive: B64.encode(archive.into_inner().unwrap()),
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
