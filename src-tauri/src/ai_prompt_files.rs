//! The files a prompt sometimes has to become, and the promise that none of them outlives its run.
//!
//! Five engines cannot always be handed their brief as an argument: Claude takes a long system
//! prompt through `--append-system-prompt-file`, agy and Cline are pointed at a file their model
//! then reads, grok reads `--prompt-file`, and opencode attaches the whole brief with `--file`. Each
//! used to write that file straight into the OS temp directory under a guessable name, readable by
//! every account on the machine (`0644` on a shared `/tmp`), and never deleted it. A brief is the
//! whole prompt — a pull request's diff, a chat's transcript, a work item nobody outside the team
//! should read — so a machine that ran reviews for a month kept a month of them lying around.
//!
//! Three rules now:
//!
//! - **Private.** One directory per user (`codeflow-ai-<uid>` under the temp directory), created
//!   `0700` and checked to be a real directory this user owns before anything is put in it — a name
//!   in a shared `/tmp` can be claimed first by somebody else, and a symlink there would aim our
//!   writes wherever its owner liked. Inside it, one directory per process; every file `0600`,
//!   created with `create_new` so an existing file is never written through.
//! - **Scoped to the run.** An invocation collects what its engine wrote in a [`PromptFiles`], and
//!   `ai::spawn_once` takes them the moment the command is built and deletes them once the process
//!   is gone — by every route out, which is why it is a guard rather than a call.
//! - **Swept.** A process that dies without running destructors — Force Quit, a crash, and the
//!   normal quit too, which ends in `std::process::exit` — leaves its directory behind.
//!   [`remove_own`] clears this process's on the way out, and [`sweep_stale`] removes, at the next
//!   launch, the directories of processes that are no longer alive, plus the loose files the
//!   versions before this one scattered across the temp directory.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// The per-user directory's name, under the temp directory.
///
/// The uid is in the name on Unix because `/tmp` is shared there: without it the first user to run
/// the app would own the one name every other user needs. Windows' temp directory is already the
/// user's own (`%LOCALAPPDATA%\Temp`), so the plain name is enough.
fn root_name() -> String {
    #[cfg(unix)]
    {
        // SAFETY: `getuid` takes nothing, cannot fail and has no side effects.
        format!("codeflow-ai-{}", unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    {
        "codeflow-ai".to_string()
    }
}

/// Where the per-user directory may live, in order of preference.
///
/// The temp directory first, because it is where every one of these CLIs already reads from. The
/// app's own cache directory second, for the case the checks in [`ensure_private`] exist for: the
/// temp name taken by somebody else, or not a directory at all.
fn roots() -> Vec<PathBuf> {
    vec![std::env::temp_dir().join(root_name()), crate::paths::cache_dir().join("ai-prompts")]
}

/// Creates `dir` if it is missing and answers whether it is safe to write prompts into: a real
/// directory (never a symlink), owned by this user, and closed to everybody else.
fn ensure_private(dir: &Path) -> bool {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    if builder.create(dir).is_err() {
        return false;
    }
    is_private(dir)
}

/// [`ensure_private`] without the creating: whether an existing `dir` is ours to use — and, which
/// is why the sweep asks this first, ours to delete from.
fn is_private(dir: &Path) -> bool {
    // `symlink_metadata`, not `metadata`: a symlink planted under our name must read as what it is.
    let Ok(meta) = std::fs::symlink_metadata(dir) else { return false };
    if !meta.file_type().is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: as in `root_name`.
        if meta.uid() != unsafe { libc::getuid() } {
            return false;
        }
        // Ours but opened up — by a umask of 000, or by hand. Closed again rather than refused.
        if meta.permissions().mode() & 0o077 != 0
            && std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).is_err()
        {
            return false;
        }
    }
    true
}

/// This process's directory, resolved once and re-created on demand.
///
/// Re-created on every use rather than trusted: the sweep of a much later launch — or the user
/// clearing their temp directory — can take it away from under a process that is still running,
/// and a run that then fell back to an inline prompt for no visible reason would be a mystery.
fn process_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    let resolved = DIR.get_or_init(|| {
        roots()
            .into_iter()
            .find(|root| ensure_private(root))
            .map(|root| root.join(std::process::id().to_string()))
    });
    let dir = resolved.as_ref()?;
    ensure_private(dir).then(|| dir.clone())
}

/// Writes `content` to a new file `dir/name`, readable by this user alone.
///
/// `create_new`: a file already at that path — which a name with a fresh UUID in it only ever is if
/// somebody put it there — is refused rather than written through.
pub fn write_into(dir: &Path, name: &str, content: &str) -> Option<PathBuf> {
    use std::io::Write;
    let path = dir.join(name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).ok()?;
    if file.write_all(content.as_bytes()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(path)
}

/// Deletes one path this module created, whatever it turned out to be.
///
/// `remove_dir_all` does not follow a symlink inside the tree — it removes the link — so a
/// directory an engine wrote a link into cannot take anything outside it down with it.
fn remove(path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_dir() => {
            let _ = std::fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// What one invocation's engine wrote to hand over its prompt. Owned by `ai::AiInvocation`.
///
/// A `Mutex` rather than a `RefCell` because the invocation is borrowed across the awaits of a run,
/// which makes it `Sync` or makes the whole run future impossible to send.
///
/// Dropping it deletes whatever was never [taken](PromptFiles::take) — an invocation that was built
/// and never spawned, which is what a test does, leaves nothing behind either.
#[derive(Debug, Default)]
pub struct PromptFiles(Mutex<Vec<PathBuf>>);

impl PromptFiles {
    fn track(&self, path: PathBuf) {
        if let Ok(mut paths) = self.0.lock() {
            paths.push(path);
        }
    }

    /// Writes `content` as a new private file named `<stem>-<uuid>.<extension>`, and remembers it
    /// for deletion. `None` when it could not be written — every caller has an inline fallback, and
    /// a prompt that cannot become a file is no reason to lose the run.
    pub fn write(&self, stem: &str, extension: &str, content: &str) -> Option<PathBuf> {
        let dir = process_dir()?;
        let path = write_into(&dir, &format!("{stem}-{}.{extension}", uuid::Uuid::new_v4()), content)?;
        self.track(path.clone());
        Some(path)
    }

    /// A new, empty private directory named `<stem>-<uuid>`, remembered for deletion with everything
    /// that ends up inside it — agy's `--add-dir` scope, Cline's scratch working directory.
    pub fn dir(&self, stem: &str) -> Option<PathBuf> {
        let dir = process_dir()?.join(format!("{stem}-{}", uuid::Uuid::new_v4()));
        if !ensure_private(&dir) {
            return None;
        }
        self.track(dir.clone());
        Some(dir)
    }

    /// Hands everything written so far to a guard that deletes it when dropped.
    ///
    /// Taken per attempt rather than left for the invocation to drop: a run retried once builds its
    /// command twice, and the first attempt's files are dead the moment it is over.
    pub fn take(&self) -> Cleanup {
        Cleanup(self.0.lock().map(|mut paths| std::mem::take(&mut *paths)).unwrap_or_default())
    }
}

impl Drop for PromptFiles {
    fn drop(&mut self) {
        drop(self.take());
    }
}

/// The files of one attempt, deleted when this is dropped. See [`PromptFiles::take`].
#[must_use = "dropping this deletes the files at once — hold it until the process has exited"]
#[derive(Debug, Default)]
pub struct Cleanup(Vec<PathBuf>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for path in &self.0 {
            remove(path);
        }
    }
}

/// Deletes this process's directory. The quit path's half of the lifecycle: `std::process::exit`
/// runs no destructor, so the guards of runs the quit just stopped never get to clean up after
/// themselves.
pub fn remove_own() {
    for root in roots() {
        let dir = root.join(std::process::id().to_string());
        if is_private(&root) {
            remove(&dir);
        }
    }
}

/// How long a directory of a pid that is — apparently — still alive is kept.
///
/// Pids are reused. A dead session's pid handed to some unrelated program would otherwise protect
/// its prompts for as long as that program ran, so past this age the directory goes whoever holds
/// the number. A live CodeFlow loses nothing by it: its directory is re-created on the next write
/// (see [`process_dir`]), and a week-old file is not one any run is still reading.
const LIVE_PID_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// How old a file from the versions before this module has to be before it is swept, so a sweep can
/// never race a run of an older build that is still starting.
const LEGACY_MIN_AGE: Duration = Duration::from_secs(10 * 60);

/// Where the versions before this module left their prompts: loose in the temp directory.
const LEGACY_PREFIXES: [&str; 5] =
    ["codeflow-claude-system-", "codeflow-grok-", "codeflow-opencode-", "codeflow-cline-", "codeflow-agy-"];

/// Removes what earlier sessions left behind. Run once at startup.
///
/// Safe to run before the single-instance check, which is where it is called: it only ever deletes
/// the directory of a process that is **not** alive, so a second launch that is about to be told to
/// exit cannot take the running instance's prompts with it.
pub fn sweep_stale() {
    let own = std::process::id();
    for root in roots() {
        sweep_root(&root, own, process_alive);
    }
    sweep_legacy(&std::env::temp_dir(), LEGACY_MIN_AGE);
}

/// Every entry of `root` that is not the directory of `own` or of a live process.
fn sweep_root(root: &Path, own: u32, alive: impl Fn(u32) -> bool) {
    // Checked, never assumed: sweeping a directory somebody else planted under our name — or a
    // symlink pointing into the user's files — is the one way this function could do harm.
    if !is_private(root) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let keep = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
            .is_some_and(|pid| pid == own || (alive(pid) && !older_than(&path, LIVE_PID_MAX_AGE)));
        if !keep {
            remove(&path);
        }
    }
}

/// The loose `codeflow-<engine>-…` files and directories the earlier versions wrote.
fn sweep_legacy(temp: &Path, min_age: Duration) {
    let Ok(entries) = std::fs::read_dir(temp) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if LEGACY_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) && older_than(&entry.path(), min_age) {
            remove(&entry.path());
        }
    }
}

fn older_than(path: &Path, age: Duration) -> bool {
    std::fs::symlink_metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|elapsed| elapsed >= age)
}

/// Whether a process with this pid exists right now. Through `sysinfo`, like
/// `localai::engine::sweep_stale`, so the answer is the same on every platform.
fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    system.process(pid).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private scratch root per test, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("cf-prompt-files-{tag}-{}", uuid::Uuid::new_v4()));
            assert!(ensure_private(&path), "a fresh directory is private");
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The lifecycle the whole module exists for: written, still there while the run holds it, gone
    /// the moment the run lets go.
    #[test]
    fn a_prompt_file_lives_exactly_as_long_as_its_run() {
        let files = PromptFiles::default();
        let path = files.write("test-brief", "txt", "the whole diff").expect("written");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "the whole diff");

        let cleanup = files.take();
        assert!(path.exists(), "still there while the process could be reading it");
        drop(cleanup);
        assert!(!path.exists(), "gone once the attempt is over");
    }

    /// An invocation built and never spawned — a test, a spawn that failed — still cleans up.
    #[test]
    fn files_nobody_took_go_with_the_invocation() {
        let path = {
            let files = PromptFiles::default();
            files.write("test-untaken", "md", "brief").expect("written")
        };
        assert!(!path.exists());
    }

    /// A directory goes with everything in it — agy's brief sits inside its `--add-dir` scope.
    #[test]
    fn a_scope_directory_is_removed_with_its_contents() {
        let files = PromptFiles::default();
        let dir = files.dir("test-scope").expect("created");
        let brief = write_into(&dir, "brief.txt", "brief").expect("written inside");
        drop(files.take());
        assert!(!brief.exists() && !dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn prompts_are_readable_by_their_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let files = PromptFiles::default();
        let path = files.write("test-mode", "txt", "secret").expect("written");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "got {mode:o}");
        let dir_mode = std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700, "got {dir_mode:o}");
    }

    /// Somebody else's file at the name is refused, never written through.
    #[test]
    fn an_existing_file_is_never_overwritten() {
        let scratch = Scratch::new("exists");
        std::fs::write(scratch.0.join("taken.txt"), "theirs").unwrap();
        assert!(write_into(&scratch.0, "taken.txt", "ours").is_none());
        assert_eq!(std::fs::read_to_string(scratch.0.join("taken.txt")).unwrap(), "theirs");
    }

    /// A symlink planted under our name is not a directory we may use — or sweep.
    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_taken_for_our_directory() {
        let scratch = Scratch::new("link");
        let target = scratch.0.join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), "the user's").unwrap();
        let link = scratch.0.join("planted");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(!is_private(&link));
        assert!(!ensure_private(&link));
        sweep_root(&link, 1, |_| false);
        assert!(target.join("keep.txt").exists(), "nothing behind the link was touched");
    }

    /// The startup sweep: the dead session's directory goes, this one's and a live one's stay.
    #[test]
    fn the_sweep_removes_only_what_no_live_process_owns() {
        let scratch = Scratch::new("sweep");
        for name in ["100", "200", "300", "not-a-pid"] {
            std::fs::create_dir(scratch.0.join(name)).unwrap();
            std::fs::write(scratch.0.join(name).join("brief.txt"), "x").unwrap();
        }
        // 100 is us, 200 is alive, 300 died with its prompts still on disk.
        sweep_root(&scratch.0, 100, |pid| pid == 200);
        assert!(scratch.0.join("100").exists(), "our own directory is kept");
        assert!(scratch.0.join("200").exists(), "a live process's directory is kept");
        assert!(!scratch.0.join("300").exists(), "a dead process's directory is swept");
        assert!(!scratch.0.join("not-a-pid").exists(), "anything else is swept");
    }

    /// The loose files of the versions before this module, and nothing that merely looks similar.
    #[test]
    fn the_sweep_clears_the_old_loose_files() {
        let scratch = Scratch::new("legacy");
        std::fs::write(scratch.0.join("codeflow-grok-1.txt"), "old brief").unwrap();
        std::fs::create_dir(scratch.0.join("codeflow-agy-2")).unwrap();
        std::fs::write(scratch.0.join("codeflow-codex-test-3"), "not ours to judge").unwrap();

        // A generous minimum age keeps a file an older build is still starting with.
        sweep_legacy(&scratch.0, Duration::from_secs(3600));
        assert!(scratch.0.join("codeflow-grok-1.txt").exists(), "too young to be stale");

        sweep_legacy(&scratch.0, Duration::ZERO);
        assert!(!scratch.0.join("codeflow-grok-1.txt").exists());
        assert!(!scratch.0.join("codeflow-agy-2").exists());
        assert!(scratch.0.join("codeflow-codex-test-3").exists(), "not a prompt prefix");
    }
}
