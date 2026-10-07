//! A container's files: list a folder, delete, and copy in and out — through the engine's own
//! `exec` and `cp`, so it works for any container with a shell (and `cp` even without one).
//!
//! A path inside the container only ever travels as an argument: the scripts below are fixed text
//! that reads it as `$1`, so a file named `$(reboot)` is a file with an odd name and nothing more.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::cli;
use super::engine::{self, EngineKind, Target};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub dir: bool,
    pub link: bool,
    pub size: Option<u64>,
    /// Unix seconds.
    pub modified: Option<i64>,
}

/// Lists the folder `$1`: a `TYPE|SIZE|MTIME|./NAME` line per entry, dotfiles included (`stat -c`,
/// which GNU and busybox both have, without following links), then `::targets` and the same for
/// what each symbolic link points at. Without `stat` — or with too many entries for one command
/// line (126: the shell could not start it) — `::ls` and the bare names of `ls -1Ap` (a folder's
/// ending in `/`). `./` keeps a name starting with `-` from reading as an option; a glob that
/// matches nothing stays as written and `stat` skips it.
const LIST_SCRIPT: &str = r#"[ -d "$1" ] || exit 3
cd "$1" 2>/dev/null || exit 4
if ! command -v stat >/dev/null 2>&1; then echo ::ls; exec ls -1Ap; fi
stat -c '%F|%s|%Y|%n' ./.* ./* 2>/dev/null
if [ $? -ge 126 ]; then echo ::ls; exec ls -1Ap; fi
set --
for f in ./.* ./*; do [ -L "$f" ] && set -- "$@" "$f"; done
if [ $# -gt 0 ]; then echo ::targets; stat -L -c '%F|%s|%Y|%n' "$@" 2>/dev/null; fi
exit 0"#;

const DELETE_SCRIPT: &str = r#"rm -rf -- "$1""#;

/// The container `exec` and `cp` reach. containerd's bare `ctr` has neither.
fn container<'a>(target: &Target, id: &'a str) -> Result<&'a str, String> {
    if target.engine()? == EngineKind::Ctr {
        return Err("ctr cannot reach a container's files; install nerdctl for that".into());
    }
    let id = id.trim();
    engine::check_ref(id)?;
    Ok(id)
}

/// An absolute path inside the container with `.`, `..` and doubled slashes resolved: `/` is as far
/// up as it goes.
pub fn container_path(path: &str) -> Result<String, String> {
    let path = path.trim_start();
    if !path.starts_with('/') {
        return Err(format!("\"{path}\" is not a path inside the container (it starts with /)"));
    }
    if path.contains('\0') {
        return Err("the path holds a NUL character".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// `TYPE|SIZE|MTIME|NAME`, split on the first three bars only: a name may hold one.
fn stat_line(line: &str) -> Option<(&str, u64, i64, &str)> {
    let mut fields = line.splitn(4, '|');
    let (kind, size, modified, name) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
    let name = name.strip_prefix("./").unwrap_or(name);
    Some((kind, size.trim().parse().ok()?, modified.trim().parse().ok()?, name))
}

/// What the list script printed, as entries: folders first (a link to one counts), then by name
/// without regard to case.
pub fn parse_listing(out: &str) -> Vec<FileEntry> {
    let mut entries: Vec<FileEntry> = Vec::new();
    #[derive(PartialEq)]
    enum Part {
        Entries,
        Targets,
        Names,
    }
    let mut part = Part::Entries;
    for line in out.lines().map(|l| l.trim_end_matches('\r')) {
        // Once in `ls`'s names, a file called `::targets` is just a file.
        if part != Part::Names {
            match line {
                "::ls" => {
                    part = Part::Names;
                    continue;
                }
                "::targets" => {
                    part = Part::Targets;
                    continue;
                }
                _ => {}
            }
        }
        match part {
            Part::Entries => {
                let Some((kind, size, modified, name)) = stat_line(line) else { continue };
                if matches!(name, "" | "." | "..") {
                    continue;
                }
                let (dir, link) = (kind == "directory", kind == "symbolic link");
                // A folder's own size is its listing's, and a link's the length of what it names:
                // neither is what a size column means.
                let size = if dir || link { None } else { Some(size) };
                entries.push(FileEntry { name: name.to_string(), dir, link, size, modified: Some(modified) });
            }
            Part::Targets => {
                let Some((kind, size, _, name)) = stat_line(line) else { continue };
                if let Some(entry) = entries.iter_mut().find(|e| e.link && e.name == name) {
                    entry.dir = kind == "directory";
                    entry.size = if kind.starts_with("regular") { Some(size) } else { None };
                }
            }
            Part::Names => {
                if line.is_empty() {
                    continue;
                }
                let (name, dir) = match line.strip_suffix('/') {
                    Some(name) => (name, true),
                    None => (line, false),
                };
                entries.push(FileEntry { name: name.to_string(), dir, link: false, size: None, modified: None });
            }
        }
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name)));
    entries
}

/// `exec` found no `sh` to run: a distroless or `scratch` image.
fn no_shell(output: &cli::Output) -> bool {
    let text = output.complaint().to_lowercase();
    text.contains("executable file not found") || text.contains("not found in $path") || (matches!(output.code, Some(126 | 127)) && (text.contains("\"sh\"") || text.contains("`sh`")))
}

/// Why an `exec` failed, said for what was being done.
fn exec_failure(output: &cli::Output, path: &str, without_shell: &str) -> String {
    if no_shell(output) {
        return without_shell.to_string();
    }
    let complaint = output.complaint();
    if complaint.to_lowercase().contains("is not running") {
        return "the container is not running: start it to reach its files".into();
    }
    match output.code {
        Some(3) => format!("{path} is not a folder in this container"),
        Some(4) => format!("{path} cannot be opened by the container's user"),
        _ => complaint,
    }
}

pub async fn browse(target: &Target, id: &str, path: &str) -> Result<Vec<FileEntry>, String> {
    let id = container(target, id)?;
    let path = container_path(path)?;
    // `sh` is the script's `$0`; the path is `$1`.
    let args: Vec<String> = vec!["exec".into(), id.into(), "sh".into(), "-c".into(), LIST_SCRIPT.into(), "sh".into(), path.clone()];
    let output = target.run_owned(args, engine::LIST_TIMEOUT).await?;
    if !output.ok() {
        return Err(exec_failure(&output, &path, "this container has no shell — download a path instead"));
    }
    Ok(parse_listing(&output.stdout))
}

pub async fn delete(target: &Target, id: &str, path: &str) -> Result<(), String> {
    let id = container(target, id)?;
    let path = container_path(path)?;
    if path == "/" {
        return Err("the container's root folder cannot be deleted".into());
    }
    let args: Vec<String> = vec!["exec".into(), id.into(), "sh".into(), "-c".into(), DELETE_SCRIPT.into(), "sh".into(), path.clone()];
    let output = target.run_owned(args, engine::ACTION_TIMEOUT).await?;
    if output.ok() {
        Ok(())
    } else {
        Err(exec_failure(&output, &path, "this container has no shell to delete with"))
    }
}

/// The checks a copy into a container makes before anything is copied: every path of this computer
/// is a full path that exists, so a copy never stops halfway on a typo.
fn upload_plan(id: &str, dir: &str, host_paths: &[String]) -> Result<(String, Vec<String>), String> {
    let dir = container_path(dir)?;
    if host_paths.is_empty() {
        return Err("choose what to copy into the container".into());
    }
    for host in host_paths {
        let path = Path::new(host);
        if !path.is_absolute() || std::fs::symlink_metadata(path).is_err() {
            return Err(format!("{host} is not on this computer"));
        }
    }
    // The trailing slash: into that folder, which must exist — never a new file named like it.
    let destination = if dir == "/" { format!("{id}:/") } else { format!("{id}:{dir}/") };
    Ok((destination, host_paths.to_vec()))
}

/// Copies files of this computer into `dir` inside the container.
pub async fn upload(target: &Target, id: &str, dir: &str, host_paths: &[String]) -> Result<(), String> {
    let id = container(target, id)?;
    let (destination, sources) = upload_plan(id, dir, host_paths)?;
    for source in sources {
        // A copy is a transfer, and a big one takes as long as a pull.
        let output = target.run_owned(vec!["cp".into(), source.clone(), destination.clone()], engine::PULL_TIMEOUT).await?;
        if !output.ok() {
            let name = Path::new(&source).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(source.clone());
            return Err(format!("{name}: {}", output.complaint()));
        }
    }
    Ok(())
}

/// `name` in `dir`, or `name (2)`, `name (3)`… — the first not taken, the number before an extension
/// (`report (2).txt`). A download never replaces what the folder holds; a dangling link takes a name
/// too, since writing to it would write wherever it points.
pub fn free_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let taken = |path: &Path| std::fs::symlink_metadata(path).is_ok();
    let first = dir.join(name);
    if !taken(&first) {
        return Ok(first);
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => name.split_at(dot),
        _ => (name, ""),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){extension}"))).find(|path| !taken(path)).ok_or_else(|| format!("{name} has too many copies in {} already", dir.display()))
}

/// Copies `path` (a file or a folder) out of the container into `host_dir`; where it landed.
pub async fn download(target: &Target, id: &str, path: &str, host_dir: &str) -> Result<String, String> {
    let id = container(target, id)?;
    let path = container_path(path)?;
    let Some(name) = path.rsplit('/').next().filter(|name| !name.is_empty()) else {
        return Err("choose a file or folder to copy, not the container's root".into());
    };
    let dir = Path::new(host_dir);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(format!("{host_dir} is not a folder of this computer"));
    }
    let landing = free_path(dir, name)?.to_string_lossy().into_owned();
    // `cp` to a path that does not exist yet creates it with the copy — a file, or a folder holding
    // what the container's folder held.
    let output = target.run_owned(vec!["cp".into(), format!("{id}:{path}"), landing.clone()], engine::PULL_TIMEOUT).await?;
    if output.ok() {
        Ok(landing)
    } else {
        Err(output.complaint())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_absolute_and_resolved() {
        assert_eq!(container_path("/").unwrap(), "/");
        assert_eq!(container_path("/etc/").unwrap(), "/etc");
        assert_eq!(container_path("  /usr//local/./bin/../lib").unwrap(), "/usr/local/lib");
        assert_eq!(container_path("/../../etc/passwd").unwrap(), "/etc/passwd", "nothing is above /");
        assert_eq!(container_path("/a b/$(x)|c").unwrap(), "/a b/$(x)|c", "odd names stay as they are");
        assert!(container_path("").is_err());
        assert!(container_path("etc").is_err());
        assert!(container_path("-rf").is_err());
        assert!(container_path("/a\0b").is_err());
    }

    /// What busybox's `stat` and the link pass print for a small folder, `./`-prefixed.
    const LISTING: &str = "directory|4096|1759322400|./.\n\
directory|4096|1759322400|./..\n\
regular file|220|1759322401|./.profile\n\
directory|4096|1759322402|./bin\n\
regular empty file|0|1759322403|./empty\n\
regular file|12|1759322404|./a|b|c.txt\n\
symbolic link|7|1759322405|./current\n\
symbolic link|11|1759322406|./notes\n\
symbolic link|7|1759322407|./gone\n\
directory|4096|1759322408|./Zeta\n\
fifo|0|1759322409|./pipe\n\
regular file|5|not-a-time|./broken line\n\
::targets\n\
directory|4096|1759322300|./current\n\
regular file|5120|1759322300|./notes\n";

    #[test]
    fn a_listing_reads_into_entries() {
        let entries = parse_listing(LISTING);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["bin", "current", "Zeta", ".profile", "a|b|c.txt", "empty", "gone", "notes", "pipe"], "folders (and links to one) first, then by name");
        let get = |name: &str| entries.iter().find(|e| e.name == name).unwrap().clone();
        assert_eq!(get("bin"), FileEntry { name: "bin".into(), dir: true, link: false, size: None, modified: Some(1_759_322_402) });
        assert_eq!(get("a|b|c.txt").size, Some(12), "a bar in a name survives");
        assert_eq!(get("empty").size, Some(0));
        assert_eq!(get("current"), FileEntry { name: "current".into(), dir: true, link: true, size: None, modified: Some(1_759_322_405) });
        assert_eq!(get("notes"), FileEntry { name: "notes".into(), dir: false, link: true, size: Some(5120), modified: Some(1_759_322_406) }, "a link to a file has its file's size");
        assert_eq!(get("gone"), FileEntry { name: "gone".into(), dir: false, link: true, size: None, modified: Some(1_759_322_407) }, "a dangling link");
        assert!(!get("pipe").dir && get("pipe").size == Some(0));
        assert!(parse_listing("").is_empty());
    }

    #[test]
    fn without_stat_the_names_alone() {
        let entries = parse_listing("::ls\n.cache/\nbin/\nREADME\n::targets\n-rf\n\n");
        let summary: Vec<(&str, bool)> = entries.iter().map(|e| (e.name.as_str(), e.dir)).collect();
        assert_eq!(summary, vec![(".cache", true), ("bin", true), ("-rf", false), ("::targets", false), ("README", false)]);
        assert!(entries.iter().all(|e| e.size.is_none() && e.modified.is_none() && !e.link));
    }

    #[test]
    fn a_failed_exec_says_why() {
        let out = |code: i32, stderr: &str| cli::Output { code: Some(code), stdout: String::new(), stderr: stderr.into() };
        let docker = out(126, "OCI runtime exec failed: exec failed: unable to start container process: exec: \"sh\": executable file not found in $PATH: unknown");
        assert_eq!(exec_failure(&docker, "/", "no shell"), "no shell");
        let podman = out(127, "Error: crun: executable file `sh` not found in $PATH: No such file or directory: OCI runtime attempted to invoke a command that was not found");
        assert_eq!(exec_failure(&podman, "/", "no shell"), "no shell");
        assert!(exec_failure(&out(1, "Error response from daemon: container 4f2c is not running"), "/", "x").contains("not running"));
        assert_eq!(exec_failure(&out(3, ""), "/etc/hosts", "x"), "/etc/hosts is not a folder in this container");
        assert_eq!(exec_failure(&out(4, ""), "/root", "x"), "/root cannot be opened by the container's user");
        assert_eq!(exec_failure(&out(1, "rm: can't remove '/proc/1': Operation not permitted"), "/proc/1", "x"), "rm: can't remove '/proc/1': Operation not permitted");
    }

    #[test]
    fn the_scripts_never_hold_the_path() {
        // The path is `$1` and only `$1`: nothing the user picks is ever part of the script's text.
        assert!(LIST_SCRIPT.contains(r#"cd "$1""#) && !LIST_SCRIPT.contains("{"));
        assert_eq!(DELETE_SCRIPT, r#"rm -rf -- "$1""#);
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_download_never_replaces_anything() {
        let dir = scratch();
        assert_eq!(free_path(&dir, "report.txt").unwrap(), dir.join("report.txt"));
        std::fs::write(dir.join("report.txt"), "a").unwrap();
        std::fs::write(dir.join("report (2).txt"), "b").unwrap();
        assert_eq!(free_path(&dir, "report.txt").unwrap(), dir.join("report (3).txt"));
        std::fs::create_dir(dir.join("logs")).unwrap();
        assert_eq!(free_path(&dir, "logs").unwrap(), dir.join("logs (2)"));
        std::fs::write(dir.join(".bashrc"), "").unwrap();
        assert_eq!(free_path(&dir, ".bashrc").unwrap(), dir.join(".bashrc (2)"), "a dotfile has no extension");
        std::fs::write(dir.join("archive.tar.gz"), "").unwrap();
        assert_eq!(free_path(&dir, "archive.tar.gz").unwrap(), dir.join("archive.tar (2).gz"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("nowhere"), dir.join("dangling")).unwrap();
            assert_eq!(free_path(&dir, "dangling").unwrap(), dir.join("dangling (2)"), "a dangling link is taken");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_upload_checks_every_path_first() {
        let dir = scratch();
        let file = dir.join("app.jar");
        std::fs::write(&file, "x").unwrap();
        let file = file.to_string_lossy().into_owned();
        assert_eq!(upload_plan("web", "/opt/app/", std::slice::from_ref(&file)).unwrap(), ("web:/opt/app/".to_string(), vec![file.clone()]));
        assert_eq!(upload_plan("web", "/", std::slice::from_ref(&file)).unwrap().0, "web:/");
        assert!(upload_plan("web", "/opt", &[file.clone(), dir.join("missing").to_string_lossy().into_owned()]).unwrap_err().contains("missing"));
        assert!(upload_plan("web", "/opt", &["relative.txt".into()]).is_err());
        assert!(upload_plan("web", "/opt", &[]).is_err());
        assert!(upload_plan("web", "opt", std::slice::from_ref(&file)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ctr_and_flags_are_refused() {
        let ctr = Target { runtime: "ctr".into(), context: None };
        assert!(container(&ctr, "web").unwrap_err().contains("nerdctl"));
        let docker = Target { runtime: "docker".into(), context: None };
        assert_eq!(container(&docker, " web ").unwrap(), "web");
        assert!(container(&docker, "--privileged").is_err());
    }
}
