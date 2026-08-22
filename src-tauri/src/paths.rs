use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where Tauri unpacked the app's bundled resources — today, the trimmed Java runtime and the
/// InterSystems JDBC driver the IRIS datasource needs.
///
/// Recorded at startup rather than resolved on demand because the layers that need it (the
/// `datasource` drivers) are deliberately free of Tauri types: they take a config and return rows,
/// and threading an `AppHandle` down to them just to find a directory would undo that.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Records that directory in its plain form — never Windows' verbatim `\\?\C:\…`.
///
/// Tauri resolves its resource directory from a *canonicalized* `current_exe`, and on Windows
/// `std::fs::canonicalize` always answers with the verbatim prefix. Rust reads that form happily,
/// and so does `CreateProcess`, so it survives every hop inside the app — and then breaks the one
/// consumer that isn't Rust. The JVM in [`crate::datasource::jvm`] parses a leading `\\` as a UNC
/// share, so `\\?\C:\…\iris-bridge.jar` on its classpath names a server called `?`: it opens
/// neither jar, silently drops both entries, and dies with `Could not find or load main class`,
/// which reaches the user as "the bridge stopped running" and names nothing anyone can fix.
///
/// Undone here rather than at that call site because the fault is in the path and not in the JVM:
/// the next resource handed to any program that isn't Rust would hit the same wall.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(plain(&dir));
}

/// See [`set_resource_dir`]. Nothing at all off Windows, and on it nothing to a path that was
/// already plain.
///
/// `dunce` rather than stripping `\\?\` by hand because the prefix is not always removable: a
/// device path has no plain spelling and must be left alone, and `\\?\UNC\server\share` has one
/// that isn't a prefix strip (`\\server\share`). Getting either wrong would trade this bug for a
/// resource directory that names nothing.
fn plain(dir: &Path) -> PathBuf {
    dunce::simplified(dir).to_path_buf()
}

/// `None` outside a packaged app — a `cargo test` has no Tauri runtime to have set it. Callers
/// treat that as "look for a source checkout instead", not as an error.
pub fn resource_dir() -> Option<&'static Path> {
    RESOURCE_DIR.get().map(PathBuf::as_path)
}

// ---------------------------------------------------------------------------
// The three roots
// ---------------------------------------------------------------------------
//
// Until v1.19 there was one: `C:\CodeFlow` on Windows, `~/CodeFlow` everywhere else, holding the
// database, the user's cloned repositories, the encrypted backups, the caches and the markers all
// together. That was an explicit product requirement, and it bought three things worth naming
// before they are given up, because the reasons are not obvious in hindsight:
//
//   1. The NSIS uninstaller could name the directory. A `.nsh` script cannot ask this crate where
//      the data lives; it needs a string literal, and a fixed path is the easiest literal there is.
//      Given up cheaply: `$LOCALAPPDATA` is an NSIS built-in and `CodeFlow` is just as literal, so
//      the requirement was never really "fixed" — it was "expressible in NSIS", and both are.
//   2. The user could find it. `C:\CodeFlow` is typeable into an Explorer bar; a per-user app
//      directory is not. Replaced by something better: the `app_paths` command plus a "Show in
//      folder" button, which beats a memorised path — and which is *needed* regardless, because
//      the settings screen used to reproduce the platform branch below in TSX and guess.
//   3. It sat outside the user profile. This is the one that was never written down and the only
//      one that is a real loss: on non-persistent VDI, a mandatory profile, or an FSLogix setup
//      that excludes `AppData\Local`, the state root below is discarded at logoff while
//      `C:\CodeFlow` survives. That is what [`HOME_OVERRIDE`] exists for, and what the breadcrumb
//      in `migrate::BREADCRUMB` detects — a file left in the *old* root, which is outside the
//      profile and therefore the only place a "you already migrated" note can survive the night.
//
// What the split buys, which the single directory could not: on Windows the old root was
// machine-wide with no per-user component, so every local account shared one `codeflow.db` —
// including the vault's `kdf_salt` and `dek_wrapped`, readable by anyone with an account on the
// machine. A per-user state root ends that, and it is the actual reason this change exists.
//
// Three roots, and only the first one moved:
//
//   state — app-owned and wipeable. The database, workspaces, chain memory, logs, models, markers.
//   cache — regenerable. Nothing here is worth a byte of migration or backup.
//   user  — the user's own files. Cloned repositories and encrypted backups. Never wiped by a
//           reset, never moved by a migration, and on macOS it is *literally the old root*, which
//           is why `~/CodeFlow` does not disappear from a Mac user's home after upgrading.

/// The folder name every root ends in.
///
/// `CodeFlow`, and not the bundle identifier that Tauri's `app_local_data_dir()` would give
/// (`com.codeflow.app`). The trade is deliberate. This module cannot use Tauri's resolver at all —
/// `db::init()` runs at `.manage()` time, before any `AppHandle` exists, and `run()` migrates
/// earlier still — so the path is computed here from `dirs` either way. Given that, the name the
/// user reads when they press "Show in folder" should be the app's name and not its reverse-DNS id.
///
/// The cost is that nothing can assert these agree with what Tauri would answer. The tests at the
/// bottom of this file pin the expected spelling for each platform instead, which is the same
/// guarantee by a different route — and, unlike an assertion inside `.setup()`, one that fires
/// before a release rather than after the migration has already used the other answer.
const APP_DIR: &str = "CodeFlow";

/// Redirects all three roots under one directory, for the two cases the per-OS defaults cannot
/// serve.
///
/// The first is the profile that does not persist (reason 3 above): an administrator points this at
/// a volume that survives logoff and the whole fleet follows, without a per-machine install step.
/// The second is this crate's own tests, which must never be able to touch a developer's real
/// data — though note that the functions worth testing here take their roots as arguments for
/// exactly that reason, and do not read this at all.
///
/// Deliberately one variable and three subdirectories rather than three variables: an admin who
/// redirects the database and forgets the cache gets a layout no code in this app expects, and the
/// failure would surface weeks later as a cache that cannot be written.
const HOME_OVERRIDE: &str = "CODEFLOW_HOME";

/// Which per-OS convention the roots follow.
///
/// Named rather than left to `#[cfg]` at each call site so that [`resolve`] can be asked for a
/// layout it is not running on. That is not a nicety: this is developed on macOS and released for
/// Windows and macOS in parity, and the Windows-only rule below (the cache root *cannot* be
/// `dirs::cache_dir()`) is exactly the kind of thing that gets written once, never executed by its
/// author, and ships broken.
// Every variant is constructed on exactly one platform, and all three by the tests below — which
// is precisely the point, and also why `dead_code` sees only the host's and calls the other two
// unused. Suppressed here rather than per-variant so that adding a fourth platform does not need a
// fourth attribute.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layout {
    Windows,
    /// macOS. `~/Library/Application Support` and `~/Library/Caches`.
    Apple,
    /// Linux and the rest. XDG: `~/.local/share` and `~/.cache`. Not a release target today — the
    /// updater manifest names only `darwin-aarch64` and `windows-x86_64` — but it is what a
    /// `cargo test` on a CI runner resolves to, so it has to be a real answer and not a panic.
    Xdg,
}

impl Layout {
    /// The layout of the machine this build is running on.
    pub const fn host() -> Self {
        #[cfg(target_os = "windows")]
        {
            Layout::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Layout::Apple
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Layout::Xdg
        }
    }
}

/// The three directories, plus whether they were resolved or guessed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Roots {
    pub state: PathBuf,
    pub cache: PathBuf,
    pub user: PathBuf,
    /// `false` when the user's home directory could not be determined and the roots below are a
    /// fallback under the temp directory.
    ///
    /// This exists because of what the old code did in the same situation: `dirs::home_dir()`
    /// returning `None` produced `PathBuf::from(".").join("CodeFlow")` — a *relative* path, so the
    /// database landed in whatever the process working directory happened to be, silently, with a
    /// different answer every launch. The most plausible origin of the zero-byte
    /// `CodeFlowcodeflow.db` that sat in this repository's root since its first commit is exactly
    /// that path being concatenated rather than joined.
    ///
    /// A temp directory is at least absolute and consistent within a session. It is still wrong,
    /// which is why [`crate::requirements`] reports it as a failed check by name instead of letting
    /// the app come up and quietly lose the user's work at the next reboot.
    pub resolved: bool,
}

/// The OS-provided directories [`resolve`] builds on, injected rather than read.
struct Bases {
    /// `dirs::data_local_dir()` — `%LOCALAPPDATA%`, `~/Library/Application Support`,
    /// `~/.local/share`.
    data_local: Option<PathBuf>,
    /// `dirs::cache_dir()` — `%LOCALAPPDATA%`, `~/Library/Caches`, `~/.cache`.
    os_cache: Option<PathBuf>,
    /// `dirs::home_dir()` — on Windows this is `%USERPROFILE%`.
    home: Option<PathBuf>,
}

/// Builds the three roots from an override, the OS directories and a layout.
///
/// Pure, and every input is a parameter. That is the whole point: the rules below are per-platform
/// and one of them is counter-intuitive enough that reading the code is not sufficient assurance.
fn resolve(layout: Layout, override_home: Option<PathBuf>, bases: &Bases) -> Roots {
    if let Some(home) = override_home {
        // Subdirectories rather than the bare directory for all three, so that pointing the
        // override at an existing folder full of something else cannot merge the app's state into
        // it — and so that `state`, `cache` and `user` stay distinguishable when an admin looks.
        return Roots {
            state: home.join("state"),
            cache: home.join("cache"),
            user: home.join("user"),
            resolved: true,
        };
    }

    let state = bases.data_local.as_ref().map(|d| d.join(APP_DIR));

    // The Windows rule, and the reason `Layout` exists as a parameter: there,
    // `dirs::cache_dir()` and `dirs::data_local_dir()` are *the same directory* —
    // `%LOCALAPPDATA%`. Deriving the cache root from it would put `pr-link-reviews/` next to
    // `codeflow.db` and make "purge the cache" and "wipe the state" the same operation, silently,
    // on one platform only. So on Windows the cache is a subdirectory of the state root and says
    // so; on macOS and Linux the OS genuinely separates them and we use what it gives.
    let cache = match layout {
        Layout::Windows => state.as_ref().map(|s| s.join("cache")),
        Layout::Apple | Layout::Xdg => bases.os_cache.as_ref().map(|c| c.join(APP_DIR)),
    };

    // The same expression on every platform, and on macOS and Linux it is *the old root*: on
    // Windows `dirs::home_dir()` is `%USERPROFILE%`, so this is `%USERPROFILE%\CodeFlow` there and
    // `~/CodeFlow` elsewhere. Keeping the user's repositories and backups under a name they already
    // recognise is the point; a migration that made `~/CodeFlow` vanish would look like data loss
    // even though it was not.
    let user = bases.home.as_ref().map(|h| h.join(APP_DIR));

    match (state, cache, user) {
        (Some(state), Some(cache), Some(user)) => Roots { state, cache, user, resolved: true },
        _ => {
            // See `Roots::resolved`. Absolute and stable within the session, reported as a failure,
            // and never a relative path.
            let base = std::env::temp_dir().join(APP_DIR);
            Roots {
                state: base.join("state"),
                cache: base.join("cache"),
                user: base.join("user"),
                resolved: false,
            }
        }
    }
}

/// The roots for this process, resolved once.
///
/// Cached because `db::init()`, the migration and the requirements probe all ask before the window
/// exists, and an environment variable that changed mid-session would give three different answers
/// to three callers that must agree.
fn roots() -> &'static Roots {
    static ROOTS: OnceLock<Roots> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let override_home = std::env::var_os(HOME_OVERRIDE)
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        resolve(
            Layout::host(),
            override_home,
            &Bases {
                data_local: dirs::data_local_dir(),
                os_cache: dirs::cache_dir(),
                home: dirs::home_dir(),
            },
        )
    })
}

/// App-owned and wipeable: the database, workspaces, chain memory, logs, models, markers.
///
/// `%LOCALAPPDATA%\CodeFlow` · `~/Library/Application Support/CodeFlow` · `~/.local/share/CodeFlow`
pub fn state_dir() -> PathBuf {
    roots().state.clone()
}

/// Regenerable. Nothing here is worth migrating or backing up, and deleting all of it while the app
/// is closed must be a no-op the user cannot notice.
///
/// `%LOCALAPPDATA%\CodeFlow\cache` · `~/Library/Caches/CodeFlow` · `~/.cache/CodeFlow`
pub fn cache_dir() -> PathBuf {
    roots().cache.clone()
}

/// The user's own files: cloned repositories and encrypted backups. Never wiped by a reset, never
/// moved by a migration.
///
/// `%USERPROFILE%\CodeFlow` · `~/CodeFlow`
pub fn user_dir() -> PathBuf {
    roots().user.clone()
}

/// `false` when the roots above are the temp-directory fallback. See [`Roots::resolved`].
pub fn roots_resolved() -> bool {
    roots().resolved
}

/// The single directory this app used before v1.19, and the source a migration reads.
///
/// Still hardcoded, and it has to be: its whole purpose is to name where the data used to be, so
/// it cannot be derived from anything that has since changed. On macOS and Linux this is the same
/// path as [`user_dir`] — the old root is not going anywhere, it is being *narrowed* to the
/// repositories and backups it already held.
pub fn legacy_base_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\CodeFlow")
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Deliberately not the `.` fallback the old code had — see `Roots::resolved`. A machine
        // with no resolvable home has no legacy directory worth finding either.
        dirs::home_dir()
            .map(|h| h.join(APP_DIR))
            .unwrap_or_else(|| std::env::temp_dir().join("CodeFlow-legacy-unresolved"))
    }
}

// --------------------------------------------------------------- state root

pub fn db_path() -> PathBuf {
    state_dir().join("codeflow.db")
}

/// The application log. Written by [`crate::applog`], and — unlike every previous version of this
/// directory — actually written to: for years `logs/` was created on every launch and had no writer
/// at all, which is why a failed storage migration on someone else's machine had to be diagnosed
/// from a screenshot.
pub fn logs_dir() -> PathBuf {
    state_dir().join("logs")
}

/// Downloaded model weights, for the local completion engine.
///
/// Nothing calls this yet: the engine is a later release, and this path is landed now so that
/// arriving with several gigabytes of weights does not mean reopening the layout, the reset plan
/// and the uninstaller a second time. The exclusion below is the part that had to exist today.
///
/// Under the state root because they are app data: the user did not author them and a redownload
/// reproduces them exactly. But they are also multi-gigabyte, so they are the one thing under this
/// root that a reset must NOT delete — see [`wipe_plan`], and the test that pins it. Deleting all
/// models is its own action with its own measured size in its own place.
#[allow(dead_code)]
pub fn models_dir() -> PathBuf {
    state_dir().join("models")
}

/// Where a workspace's skills (installed via `npx skills add`) live before being synced
/// into whichever project is actually being reviewed — the canonical, workspace-scoped copy.
pub fn workspace_skills_dir(workspace_id: &str) -> PathBuf {
    state_dir().join("workspaces").join(workspace_id).join("skills")
}

/// Where one chain's memory notes actually live.
///
/// Consolidated here rather than in a repository for the same reason the skills are: a repository
/// can be deleted, moved or renamed, and a chain's record of what it did should not go with it.
/// What each repository gets is a *mirror* — see `chain_memory`.
pub fn chain_memory_dir(chain_id: &str) -> PathBuf {
    state_dir().join("chain-memory").join(chain_id)
}

/// A "please wipe everything" request has to be handled on the *next* launch, before the
/// database is opened — deleting `codeflow.db` out from under this process's own open SQLite
/// connection would fail on Windows (can't remove a file that's still locked open). Requesting
/// a reset just drops this marker and quits; `run()` checks for it first thing on startup, when
/// nothing has touched the directory yet, and deletes it then.
pub fn reset_marker_path() -> PathBuf {
    state_dir().join(".reset-pending")
}

/// Records which on-disk layout the state root holds, and is the single authority on whether the
/// migration from [`legacy_base_dir`] has run.
///
/// A file rather than a row in `app_settings`, because it answers a question asked *about* the
/// database — including the case where the database is the thing that failed to arrive.
///
/// Dot-prefixed and named for what it is, deliberately not `layout.json`: the manifest's absence
/// means "copy the old database over whatever is here", so a name that another feature would
/// plausibly reach for (window layout is the obvious one, and `window_state` already persists
/// geometry) is a name that can get a user's data overwritten by a filename collision. For the
/// same reason [`crate::migrate`] requires a magic field inside and treats a file that parses
/// without one as an unknown occupant to abort on, not as an absent manifest to migrate over.
pub fn layout_manifest_path() -> PathBuf {
    state_dir().join(".codeflow-layout.json")
}

// --------------------------------------------------------------- cache root

/// The cached login `PATH`.
///
/// Cache and not state: losing it costs one slow launch while `shell_env` re-probes a login shell,
/// which is the definition of regenerable. It moved out of the state root when the roots split, and
/// lost its leading dot on the way — inside a directory that exists only for caches there is
/// nothing to hide it from.
pub fn shell_path_cache() -> PathBuf {
    cache_dir().join("shell-path")
}

/// Per-pull-request working copies of a review opened from a link: the rendered overview and the
/// diff, both re-fetched from the host on demand.
///
/// Cache, and the only genuinely unbounded thing under any of these roots — one directory per
/// (host, owner, repo, number) ever reviewed from a link, never swept. Being under the cache root
/// at least means "reclaim this" is now an operation that exists.
pub fn pr_link_review_dir(slug: &str) -> PathBuf {
    cache_dir().join("pr-link-reviews").join(slug)
}

// ---------------------------------------------------------------- user root

/// Default destination root for repositories cloned from within CodeFlow.
///
/// The *default*: `commands::repos::default_clone_dir` prefers an `app_settings.clone_root` row
/// when one exists, which is how a Windows user who already had clones under `C:\CodeFlow\repos`
/// keeps them exactly where they are. This module cannot read that row — it runs before the
/// database is open — so the split is deliberate rather than an oversight.
pub fn clone_root() -> PathBuf {
    user_dir().join("repos")
}

/// Default destination for encrypted backups.
///
/// Also only the default; `backup_settings.folder` overrides it. Note the asymmetry with
/// [`clone_root`] on a Windows machine upgrading from the shared `C:\CodeFlow`: an existing
/// `repos` directory is adopted where it stands, an existing `Backups` directory is *not*. Cloned
/// repositories may hold uncommitted work and moving or abandoning them would be the worse harm,
/// while a shared backup folder is one of the bugs this change exists to fix — every account wrote
/// the same `codeflow-backup.cfbackup` filename into it and the five-copy prune evicted whoever
/// wrote last, with each file sealed by a passphrase only its own author's credential store holds.
/// The old files are left alone; a new backup lands in the per-user folder within the interval.
pub fn backups_dir() -> PathBuf {
    user_dir().join("Backups")
}

// -------------------------------------------------------------- bookkeeping

/// Creates the directories that must exist before anything else runs.
///
/// Only these: the roots plus the two that something writes into unconditionally on a normal
/// launch. Everything else under the state root (`workspaces/`, `chain-memory/`, `models/`) is
/// created at its own call site when first needed, which is why a migration must enumerate what is
/// actually on disk rather than trusting this list — the previous version of this function created
/// three of seven directories and reading it was a good way to lose four of them.
pub fn ensure_dirs() -> std::io::Result<()> {
    std::fs::create_dir_all(state_dir())?;
    std::fs::create_dir_all(cache_dir())?;
    std::fs::create_dir_all(logs_dir())?;
    // The user root, but not `repos`/`Backups` inside it: those are created when the user first
    // clones or first backs up, and an empty `Backups` folder that the user never asked for reads
    // as the app having done something.
    std::fs::create_dir_all(user_dir())?;
    std::fs::create_dir_all(clone_root())?;
    Ok(())
}

/// What "Reset app data" deletes, and what it deliberately leaves.
///
/// Enumerated rather than expressed as `remove_dir_all(root)`, which is what it used to be and
/// which is the bug: the single old root held the user's cloned repositories and every encrypted
/// backup, so a reset destroyed working copies with uncommitted work and, in the same sweep, the
/// only artefacts that could have recovered from it — while the confirmation text listed neither.
///
/// Two rules, and both are enforced by tests below rather than by care:
///   * the user root is never a target, at any depth;
///   * `models/` survives, because a reset is not a reason to re-download several gigabytes.
pub struct WipePlan {
    /// Deleted recursively, in this order. Paths that do not exist are skipped by the caller.
    pub remove: Vec<PathBuf>,
    /// Named in the confirmation text as surviving, so the user can see what a reset is *not*.
    pub kept: Vec<PathBuf>,
}

/// Builds the plan for a given pair of roots.
///
/// Takes the roots as arguments so a test can point it at a directory tree it built, and reads the
/// state root because the exclusion of `models/` can only be expressed as "everything except", and
/// "everything" is a fact about the disk rather than about this file.
pub fn wipe_plan_for(state: &Path, cache: &Path) -> WipePlan {
    let models = state.join("models");
    let mut remove = Vec::new();

    match std::fs::read_dir(state) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path == models {
                    continue;
                }
                remove.push(path);
            }
        }
        // An unreadable state root means there is nothing here to delete. Reporting an empty plan
        // is right: the caller's next step is the requirements probe, which will say why.
        Err(_) => {}
    }
    remove.sort();

    // The whole cache root, not its entries: there is nothing inside it to preserve, and taking the
    // directory itself means a stale subdirectory from a previous version goes with it.
    //
    // Only if the loop above did not already name it, which on Windows it did: there the cache root
    // *is* a subdirectory of the state root (see `resolve`), so the two halves of this function
    // overlap on exactly one platform. Pushing it twice would be harmless — the caller skips paths
    // that no longer exist — but a plan that lists a directory twice is a plan that reads as a bug
    // to whoever prints it next to a size.
    if !remove.iter().any(|already| already == cache) {
        remove.push(cache.to_path_buf());
    }

    WipePlan { remove, kept: vec![models] }
}

/// The plan for this process's roots.
pub fn wipe_plan() -> WipePlan {
    wipe_plan_for(&state_dir(), &cache_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bases() -> Bases {
        Bases {
            data_local: Some(PathBuf::from("/LOCAL")),
            os_cache: Some(PathBuf::from("/CACHE")),
            home: Some(PathBuf::from("/HOME")),
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-paths-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The exact directory Tauri hands back from a packaged Windows install, and the exact reason
    /// IRIS could not connect from one: the prefix rode along into every jar on the JVM's
    /// classpath, which cannot carry it.
    #[test]
    #[cfg(windows)]
    fn a_verbatim_resource_dir_is_recorded_plainly() {
        let recorded = plain(Path::new(r"\\?\C:\Users\someone\AppData\Local\CodeFlow"));
        assert_eq!(
            recorded,
            Path::new(r"C:\Users\someone\AppData\Local\CodeFlow")
        );
        // What the IRIS driver actually builds from it, which is where the prefix did its damage.
        let jar = recorded.join("iris").join("iris-bridge.jar");
        assert!(!jar.to_string_lossy().starts_with(r"\\?\"), "{}", jar.display());
    }

    /// A path that never had the prefix is handed back untouched — every macOS and Linux resource
    /// directory, and a Windows one that already arrived plain.
    #[test]
    fn a_plain_path_is_left_alone() {
        let untouched = state_dir().join("resources");
        assert_eq!(plain(&untouched), untouched);
    }

    /// The Windows layout, asserted from whatever machine happens to be running the suite. This is
    /// the test that exists because the author develops on macOS: the rule it pins — that the cache
    /// root is a *subdirectory of the state root* and not `dirs::cache_dir()` — is only wrong on
    /// Windows, where `dirs::cache_dir()` is `%LOCALAPPDATA%` and would collapse the two roots into
    /// one.
    #[test]
    fn the_windows_cache_root_never_collapses_into_the_state_root() {
        let r = resolve(Layout::Windows, None, &bases());
        assert_eq!(r.state, Path::new("/LOCAL/CodeFlow"));
        assert_eq!(r.cache, Path::new("/LOCAL/CodeFlow/cache"));
        assert_ne!(r.state, r.cache, "the two roots must never be the same directory");
        assert!(r.resolved);
    }

    /// macOS, where the OS does separate the two and we take what it gives.
    #[test]
    fn the_apple_layout_uses_the_separate_caches_directory() {
        let r = resolve(Layout::Apple, None, &bases());
        assert_eq!(r.state, Path::new("/LOCAL/CodeFlow"));
        assert_eq!(r.cache, Path::new("/CACHE/CodeFlow"));
    }

    /// The user root is the same expression everywhere, and on macOS it is the pre-v1.19 directory
    /// unchanged — which is the promise that `~/CodeFlow` does not vanish from a Mac after
    /// upgrading.
    #[test]
    fn the_user_root_is_the_old_root_on_apple_and_xdg() {
        for layout in [Layout::Windows, Layout::Apple, Layout::Xdg] {
            assert_eq!(resolve(layout, None, &bases()).user, Path::new("/HOME/CodeFlow"));
        }
        #[cfg(not(target_os = "windows"))]
        assert_eq!(user_dir(), legacy_base_dir());
    }

    /// An unresolvable home never produces a relative path. The old code's answer here was
    /// `./CodeFlow`, which put the database wherever the process happened to be started from.
    #[test]
    fn an_unresolvable_home_is_absolute_and_reported() {
        let r = resolve(
            Layout::Apple,
            None,
            &Bases { data_local: None, os_cache: None, home: None },
        );
        assert!(!r.resolved, "the fallback must announce itself");
        for root in [&r.state, &r.cache, &r.user] {
            assert!(root.is_absolute(), "{} is relative", root.display());
        }
    }

    /// The override moves all three roots together, so an admin cannot end up with the database on
    /// a persisted volume and the cache on one that is discarded.
    #[test]
    fn the_override_moves_every_root() {
        let r = resolve(Layout::Windows, Some(PathBuf::from("/vol/persisted")), &bases());
        assert_eq!(r.state, Path::new("/vol/persisted/state"));
        assert_eq!(r.cache, Path::new("/vol/persisted/cache"));
        assert_eq!(r.user, Path::new("/vol/persisted/user"));
        for root in [&r.state, &r.cache, &r.user] {
            assert!(
                root.starts_with("/vol/persisted"),
                "{} escaped the override",
                root.display()
            );
        }
    }

    /// The reset must not delete downloaded weights. Several gigabytes, one confirmation dialog,
    /// and no way to tell from the dialog that it was about to happen.
    #[test]
    fn a_reset_keeps_the_models_directory() {
        let state = scratch("wipe-state");
        let cache = scratch("wipe-cache");
        for name in ["codeflow.db", "codeflow.db-wal"] {
            std::fs::write(state.join(name), b"").unwrap();
        }
        for name in ["models", "workspaces", "chain-memory", "logs"] {
            std::fs::create_dir_all(state.join(name)).unwrap();
        }

        let plan = wipe_plan_for(&state, &cache);

        assert!(
            !plan.remove.contains(&state.join("models")),
            "models were in the wipe set: {:?}",
            plan.remove
        );
        assert!(plan.kept.contains(&state.join("models")));
        for name in ["codeflow.db", "codeflow.db-wal", "workspaces", "chain-memory", "logs"] {
            assert!(
                plan.remove.contains(&state.join(name)),
                "{name} survived a reset"
            );
        }
        assert!(plan.remove.contains(&cache), "the cache root survived a reset");

        std::fs::remove_dir_all(&state).ok();
        std::fs::remove_dir_all(&cache).ok();
    }

    /// The bug this whole enumeration exists to fix: a reset used to be
    /// `remove_dir_all(base_dir())`, and the user's cloned repositories and every encrypted backup
    /// were inside it.
    #[test]
    fn a_reset_never_touches_the_user_root() {
        let roots = resolve(Layout::Apple, None, &bases());
        let plan = wipe_plan_for(&roots.state, &roots.cache);
        for target in &plan.remove {
            assert!(
                !target.starts_with(&roots.user),
                "{} is inside the user root",
                target.display()
            );
        }
        // And the two things it holds, named explicitly so that moving them later without moving
        // this test is not possible.
        for user_owned in [roots.user.join("repos"), roots.user.join("Backups")] {
            assert!(
                !plan.remove.iter().any(|t| user_owned.starts_with(t)),
                "{} was reachable from the wipe set",
                user_owned.display()
            );
        }
    }

    /// Every path this module hands out lands in the root it is documented to land in. Written as
    /// one test over the whole surface because the failure it guards against is a single
    /// copy-pasted `state_dir()` in a function whose doc comment says cache.
    #[test]
    fn every_path_sits_under_the_root_its_doc_comment_claims() {
        let state = state_dir();
        let cache = cache_dir();
        let user = user_dir();

        for p in [
            db_path(),
            logs_dir(),
            models_dir(),
            workspace_skills_dir("w1"),
            chain_memory_dir("c1"),
            reset_marker_path(),
            layout_manifest_path(),
        ] {
            assert!(p.starts_with(&state), "{} is not under the state root", p.display());
        }
        for p in [shell_path_cache(), pr_link_review_dir("github-a-b-1")] {
            assert!(p.starts_with(&cache), "{} is not under the cache root", p.display());
        }
        for p in [clone_root(), backups_dir()] {
            assert!(p.starts_with(&user), "{} is not under the user root", p.display());
        }
    }
}
