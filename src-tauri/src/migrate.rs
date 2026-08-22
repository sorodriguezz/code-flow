//! Moves the app's state out of the single pre-v1.19 directory and into the three roots
//! [`crate::paths`] now defines.
//!
//! Runs from `run()`, before `db::init()` opens anything and before `shell_env` spawns a thread —
//! the one window in the process's life where nothing else is touching either directory.
//!
//! # What it will not do
//!
//! Four rules shape the whole file, and each of them exists because the obvious alternative loses
//! somebody's data:
//!
//! * **It never writes to the source.** Not one byte, not even a WAL checkpoint. The instinct is to
//!   checkpoint the old database first so that only `codeflow.db` needs copying — and that instinct
//!   puts the app in the position of mutating the only existing copy of the user's data, on a
//!   machine where the reason this is happening at all might be that the disk or the antivirus is
//!   misbehaving. Instead all three files are copied byte for byte and the checkpoint runs on the
//!   *destination*, where a failure costs nothing. SQLite recovers a WAL on first open whenever the
//!   sidecars are beside the main file, so this is the correct primary path rather than a fallback.
//!
//! * **It copies, and then makes the original unopenable by an older build.** Leaving
//!   `codeflow.db` in place looks like the conservative choice and is the dangerous one: a stale
//!   bundle in `/Applications`, a Dock alias, a downgrade, a Time Machine restore of the `.app` —
//!   any of them opens the old file and presents a working, plausible, weeks-old application. The
//!   user does not conclude "wrong binary", they conclude the app lost their work, and then they
//!   start working in it. Renaming the source to `codeflow.db.migrated-<date>` after the
//!   destination verifies means an old build finds nothing, creates an empty database, and is
//!   *obviously* wrong — while the rename is still the easiest recovery there is.
//!
//! * **After the manifest says complete, the old root is never opened for writing again.** Not as a
//!   fallback, not for one launch, not to "keep the user working". A session written into a
//!   database the app has already superseded is a session that vanishes on the next launch.
//!
//! * **It copies only what it can name.** An allow-list, against the usual advice for migrations.
//!   The old root was never exclusively ours: this app's own author's machine had three
//!   `.ipc-<pid>.sock` files and two log files in there, written by a different program. A
//!   skip-list would have carried a stranger's state into the new root, and on macOS — where the
//!   old root *is* the new user root — it would have copied the user's entire `repos/` tree.
//!   Anything unrecognised is left where it is and written to the log by name.
//!
//! # What it deliberately leaves behind
//!
//! `repos/` and `Backups/` are the user's own files and stay in the user root, which on macOS and
//! Linux is the old directory unchanged. `logs/`, `pr-link-reviews/` and `.shell-path` are caches
//! or were never ours. Nothing is ever deleted from the old root except by the user, from Settings,
//! long after the fact.

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::applog;
use crate::paths;

/// The magic field every manifest carries.
///
/// A JSON file that parses but lacks this is an *unknown occupant*, and the migration aborts rather
/// than treating it as absent — because "absent" means "copy the old database over whatever is
/// here". See [`paths::layout_manifest_path`] for why the filename is what it is.
const MANIFEST_KIND: &str = "codeflow-layout";
const MANIFEST_VERSION: u32 = 1;

/// Left in the old root, and the reason it is *there* rather than beside the manifest.
///
/// The manifest lives in the state root and answers "has this layout been migrated". That is the
/// right home for it and it is useless for the one question it cannot answer: whether the state
/// root itself survives a logoff. On non-persistent VDI, a mandatory profile, or an FSLogix
/// configuration that excludes `AppData\Local`, the state root — manifest included — is discarded
/// every evening, and a migration keyed only on the manifest would run again every morning, forever.
///
/// This file sits in the old root, which on Windows is `C:\CodeFlow`: outside the user profile,
/// which is exactly the property that made the old layout worth keeping for that population and the
/// only thing lost by moving. Present-but-no-manifest is therefore a *diagnosis*, not an invitation
/// to migrate again.
pub(crate) const BREADCRUMB: &str = "MIGRATED.txt";

/// Written into the state root when the user says they were the only person using CodeFlow on this
/// machine. See [`shared_account_hazard`] — the check it releases cannot be answered from the data,
/// only by someone who knows the machine.
const CONSENT: &str = ".shared-root-acknowledged";

/// Everything the migration will copy, in order, and nothing else.
///
/// The database first so that a run interrupted after it has moved the thing that matters most.
const COPY: &[&str] = &["codeflow.db", "codeflow.db-wal", "codeflow.db-shm", "workspaces", "chain-memory"];

/// Recognised, and deliberately not copied. Named individually so the log can distinguish "left
/// behind on purpose" from "did not recognise this at all", which are very different things to read
/// at 2am.
const LEAVE: &[&str] = &[
    "repos",            // the user's working copies — user root, and on macOS already there
    "Backups",          // the user's encrypted backups — same
    "models",           // if a future build ever put weights here; several GB, never worth copying
    "logs",             // nothing in this crate has ever written to the old one
    "pr-link-reviews",  // cache, re-fetched from the host on demand
    ".shell-path",      // cache, re-probed on the next launch
    ".write-test",      // the requirements probe's leftovers
    ".reset-pending",   // handled before this module runs, see `reset`
    BREADCRUMB,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub kind: String,
    pub version: u32,
    /// `complete` · `migrating` · `failed`.
    pub status: String,
    pub migrated_at: String,
    /// The directory this state came from, or empty on a fresh install.
    pub from: String,
    /// Absolute paths written into the state root, so an interrupted run knows what to undo.
    pub entries: Vec<String>,
    /// Why, when `status` is `failed`.
    pub error: String,
}

impl Manifest {
    fn new(status: &str, from: &Path, entries: Vec<String>, error: &str) -> Self {
        Manifest {
            kind: MANIFEST_KIND.into(),
            version: MANIFEST_VERSION,
            status: status.into(),
            migrated_at: chrono::Local::now().to_rfc3339(),
            from: from.to_string_lossy().into_owned(),
            entries,
            error: error.into(),
        }
    }
}

/// What the startup call decided. Returned rather than acted on so that `run()` stays the one place
/// that can stop the process, and so this is testable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to do: no old directory, or a fresh install.
    Fresh,
    /// The manifest says it already happened.
    AlreadyMigrated,
    /// Copied successfully just now.
    Migrated { entries: usize },
    /// The old root holds a breadcrumb but this root holds no manifest — the state root did not
    /// survive. Diagnosed, logged, and explicitly *not* retried.
    StateRootNotPersistent,
    /// Something in the state root parses as JSON but is not our manifest.
    UnknownOccupant,
    /// A previous attempt failed and was recorded as such. Not retried automatically.
    PreviouslyFailed { error: String },
    /// This attempt failed. The state root is not usable and the caller must not proceed to open a
    /// database in it.
    Failed { error: String },
    /// A Windows machine whose old root sits outside the user profile and whose database mentions
    /// another account. Needs a person, not a copy.
    NeedsAttentionShared { detail: String },
}

/// Everything the frontend needs to name the app's directories, and to say something when the
/// layout is not what it should be.
///
/// One payload for both jobs, because they are the same question asked at different volumes: the
/// settings screen wants "where is my data" and the startup notice wants "where did my data go".
/// Before this existed the settings screen answered the first by reproducing `paths.rs`'s platform
/// branch in TSX — `platform === "windows" ? "C:\\CodeFlow" : "~/CodeFlow"` — which was a guess that
/// happened to be right, and would have gone on being displayed confidently after this change made
/// it wrong.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutStatus {
    /// `false` only when the app cannot be trusted to hold data: the frontend blocks on it.
    pub ok: bool,
    /// `fresh` · `already` · `migrated` · `notPersistent` · `unknownOccupant` · `previouslyFailed`
    /// · `failed` · `sharedAccount`. Doubles as the translation-key fragment.
    pub kind: String,
    /// The underlying error, verbatim and untranslated — a quotation, not a sentence of ours. Same
    /// rule `requirements::Requirement::detail` follows.
    pub detail: String,
    pub state_dir: String,
    pub cache_dir: String,
    pub user_dir: String,
    pub legacy_dir: String,
    /// The renamed pre-migration database, when one is still on disk, and its size. What the
    /// "delete the old copy" row in Settings offers — named individually rather than as a directory
    /// because the directory it sits in is the user root and is not going anywhere.
    pub legacy_copies: Vec<String>,
    pub legacy_copy_bytes: u64,
}

/// Builds the payload from an outcome and this process's roots.
pub fn status(outcome: &Outcome) -> LayoutStatus {
    let legacy = paths::legacy_base_dir();
    let (copies, bytes) = migrated_copies(&legacy);
    let (ok, kind, detail) = match outcome {
        Outcome::Fresh => (true, "fresh", String::new()),
        Outcome::AlreadyMigrated => (true, "already", String::new()),
        Outcome::Migrated { .. } => (true, "migrated", String::new()),
        // Not `ok: false`. The app works — it is holding data in a directory that will be gone
        // tomorrow, which the user has to be told loudly and can only fix outside the app. Blocking
        // them out of a working session would not make the profile persist.
        Outcome::StateRootNotPersistent => (true, "notPersistent", String::new()),
        Outcome::UnknownOccupant => (false, "unknownOccupant", String::new()),
        Outcome::PreviouslyFailed { error } => (false, "previouslyFailed", error.clone()),
        Outcome::Failed { error } => (false, "failed", error.clone()),
        Outcome::NeedsAttentionShared { detail } => (false, "sharedAccount", detail.clone()),
    };
    LayoutStatus {
        ok,
        kind: kind.into(),
        detail,
        state_dir: paths::state_dir().to_string_lossy().into_owned(),
        cache_dir: paths::cache_dir().to_string_lossy().into_owned(),
        user_dir: paths::user_dir().to_string_lossy().into_owned(),
        legacy_dir: legacy.to_string_lossy().into_owned(),
        legacy_copies: copies,
        legacy_copy_bytes: bytes,
    }
}

/// The startup verdict, with the on-disk facts re-read.
///
/// The verdict itself is decided once, at startup, and cannot change while the process runs — but
/// the pre-migration copies can, because Settings offers a button that deletes them. Recomputing
/// only that part keeps the row's size accurate without re-running a migration check on every open
/// of the settings screen.
pub fn refresh(decided: &LayoutStatus) -> LayoutStatus {
    let (legacy_copies, legacy_copy_bytes) = migrated_copies(&paths::legacy_base_dir());
    LayoutStatus { legacy_copies, legacy_copy_bytes, ..decided.clone() }
}

fn migrated_copies(legacy: &Path) -> (Vec<String>, u64) {
    let Ok(entries) = std::fs::read_dir(legacy) else { return (Vec::new(), 0) };
    let mut found = Vec::new();
    let mut bytes = 0;
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with("codeflow.db.migrated-") {
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            found.push(entry.path().to_string_lossy().into_owned());
        }
    }
    found.sort();
    (found, bytes)
}

/// Deletes the pre-migration copies of the database the migration left in the old root.
///
/// Its own action rather than part of the reset, and gated on the migration having actually
/// completed, because these files are the recovery path: while they exist, a migration that turned
/// out to be wrong is undone with a rename.
pub fn delete_legacy_copies() -> Result<u64, String> {
    let legacy = paths::legacy_base_dir();
    if !matches!(read_manifest(&paths::layout_manifest_path()), Occupant::Complete) {
        return Err("the migration has not completed; nothing may be deleted yet".into());
    }
    let (copies, bytes) = migrated_copies(&legacy);
    for copy in &copies {
        std::fs::remove_file(copy).map_err(|e| format!("{copy}: {e}"))?;
        applog::info(&format!("layout: deleted the pre-migration copy {copy}"));
    }
    Ok(bytes)
}

/// Clears a recorded failure so the next launch tries again.
///
/// Deliberately does not retry in place. A migration runs in the one window where nothing else has
/// the database open, and this command is called from a running app that has already opened one —
/// so the honest answer is to clear the marker and ask the user to restart.
pub fn arm_retry() -> Result<(), String> {
    let manifest = paths::layout_manifest_path();
    match read_manifest(&manifest) {
        Occupant::Failed(_) | Occupant::Unknown => {}
        _ => return Err("there is no failed migration to retry".into()),
    }
    std::fs::remove_file(&manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
    applog::info("layout: a retry was armed; the migration will run again on the next launch");
    Ok(())
}

/// The whole migration, for this process's roots. Called once, from `run()`.
pub fn run_at_startup() -> Outcome {
    let outcome = migrate(&paths::legacy_base_dir(), &paths::state_dir(), &paths::user_dir());
    match &outcome {
        Outcome::Fresh => applog::info("layout: nothing to migrate"),
        Outcome::AlreadyMigrated => applog::info("layout: already migrated"),
        Outcome::Migrated { entries } => {
            applog::info(&format!("layout: migrated {entries} entries into the state root"))
        }
        Outcome::StateRootNotPersistent => applog::error(
            "layout: the old root says this user already migrated but the state root has no \
             manifest — the state root is not persisting across sessions. Not migrating again. \
             Point CODEFLOW_HOME at a directory that survives logoff.",
        ),
        Outcome::UnknownOccupant => applog::error(
            "layout: the state root holds a layout file this build does not recognise; refusing to \
             migrate over it",
        ),
        Outcome::PreviouslyFailed { error } => {
            applog::error(&format!("layout: a previous migration failed and was not retried: {error}"))
        }
        Outcome::Failed { error } => applog::error(&format!("layout: migration failed: {error}")),
        Outcome::NeedsAttentionShared { detail } => {
            applog::warn(&format!("layout: shared old root needs a decision: {detail}"))
        }
    }
    outcome
}

/// The migration, against explicit roots.
///
/// Every path is a parameter so the tests below can build a whole old-and-new pair in a temp
/// directory. Nothing in here reads [`paths`].
pub fn migrate(source: &Path, state: &Path, user: &Path) -> Outcome {
    let manifest_path = state.join(".codeflow-layout.json");
    let breadcrumb = source.join(BREADCRUMB);

    match read_manifest(&manifest_path) {
        Occupant::Complete => return Outcome::AlreadyMigrated,
        Occupant::Failed(error) => return Outcome::PreviouslyFailed { error },
        Occupant::Unknown => return Outcome::UnknownOccupant,
        Occupant::Interrupted(entries) => {
            // A previous run died between "start copying" and "verify". Everything it listed is of
            // unknown completeness, so none of it can be trusted — and all of it is a copy whose
            // original is still sitting untouched in the old root, which is what makes deleting it
            // safe.
            applog::warn(&format!(
                "layout: a previous migration was interrupted; discarding {} partial entries",
                entries.len()
            ));
            for entry in entries {
                remove_any(Path::new(&entry));
            }
        }
        Occupant::Absent => {}
    }

    if breadcrumb.exists() {
        // No manifest, but the old root remembers. See `BREADCRUMB`.
        //
        // A manifest is written all the same, and that is the difference between diagnosing this
        // and being stuck on it. The state root can be legitimately absent on a healthy machine —
        // "Reset app data" wipes it, and so does an uninstall where the user deletes the app data
        // and keeps the old folder — and without a manifest the branch above returns here on every
        // launch from then on, telling a perfectly good machine forever that its profile is broken
        // and disabling both recovery actions in Settings along the way. Recording it means the
        // warning is shown once. On a profile that genuinely does not persist, the manifest is
        // discarded along with everything else and the warning comes back tomorrow — which is
        // right, because so does the problem.
        let _ = write_manifest(&manifest_path, &Manifest::new("complete", source, Vec::new(), ""));
        return Outcome::StateRootNotPersistent;
    }

    if !source.join("codeflow.db").exists() {
        // A fresh install, or a machine whose old root only ever held repositories. Record the
        // layout so this whole path is skipped from now on.
        let manifest = Manifest::new("complete", source, Vec::new(), "");
        if let Err(e) = write_manifest(&manifest_path, &manifest) {
            return Outcome::Failed { error: e };
        }
        return Outcome::Fresh;
    }

    // Only when the two are genuinely different directories. On macOS and Linux the old root *is*
    // the user root, so a shared-account check there would be asking about a path that never left
    // the user's own home.
    if source != user && !std::path::Path::new(&state.join(CONSENT)).exists() {
        if let Some(detail) = shared_account_hazard(source) {
            return Outcome::NeedsAttentionShared { detail };
        }
    }

    match copy_everything(source, state, &manifest_path) {
        Ok(entries) => {
            let count = entries.len();
            if let Err(e) = write_breadcrumb(&breadcrumb, state) {
                // Not fatal: the copy is verified and the manifest is written. A missing breadcrumb
                // costs the VDI diagnosis, not the user's data.
                applog::warn(&format!("layout: could not write the breadcrumb: {e}"));
            }
            Outcome::Migrated { entries: count }
        }
        Err(error) => {
            let manifest = Manifest::new("failed", source, Vec::new(), &error);
            let _ = write_manifest(&manifest_path, &manifest);
            Outcome::Failed { error }
        }
    }
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

fn copy_everything(source: &Path, state: &Path, manifest_path: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(state).map_err(|e| format!("cannot create the state root: {e}"))?;

    let present: Vec<&str> = COPY.iter().copied().filter(|name| source.join(name).exists()).collect();
    let needed: u64 = present.iter().map(|name| size_of(&source.join(name))).sum();
    check_space(state, needed)?;

    // Written before the first byte moves, so that a process killed mid-copy leaves a record of
    // exactly what to discard. Listed as absolute destination paths for the same reason.
    let planned: Vec<String> =
        present.iter().map(|name| state.join(name).to_string_lossy().into_owned()).collect();
    write_manifest(manifest_path, &Manifest::new("migrating", source, planned.clone(), ""))?;

    clear_destination_database(state);

    for name in &present {
        let from = source.join(name);
        let to = state.join(name);
        applog::info(&format!("layout: copying {}", from.to_string_lossy()));
        // Anything already written is deleted before the error leaves this function. A partial
        // `codeflow.db` left in the state root is not inert: `db::init` would open it, the schema
        // parse would return `SQLITE_CORRUPT`, and the panic would land before any window exists —
        // making the recovery screen that reports *this* error unreachable, forever.
        if let Err(e) = copy_any(&from, &to) {
            discard(&planned);
            return Err(e);
        }
    }

    // The destination, never the source. See the module note.
    if let Err(e) = settle_database(&state.join("codeflow.db")) {
        discard(&planned);
        return Err(e);
    }

    log_leftovers(source);

    write_manifest(manifest_path, &Manifest::new("complete", source, planned.clone(), ""))?;
    rename_source_database(source)?;
    Ok(planned)
}

/// Removes any database already sitting in the destination, before a byte of the source is copied.
///
/// The sidecars are the reason this exists, and the failure it prevents is silent. A WAL carries no
/// link to the database it belongs to — only self-consistent salts and checksums — so SQLite will
/// happily replay a *foreign* one into whatever `codeflow.db` it finds beside it, and
/// `integrity_check` then reports `ok` because the result is a perfectly valid database. It is just
/// not the user's.
///
/// The stale sidecar is not hypothetical. Every quit in this app goes through `AppHandle::exit`,
/// which is `std::process::exit` and runs no destructors, so the SQLite connection is never closed
/// and `codeflow.db-wal` is always left behind. A launch whose migration failed still opened a
/// database here (before v1.19.0 unconditionally; now only when the layout is trusted), and the
/// retry that follows copies a source which — having been closed cleanly by the *old* build —
/// usually has no `-wal` of its own to overwrite it with.
fn clear_destination_database(state: &Path) {
    for name in ["codeflow.db", "codeflow.db-wal", "codeflow.db-shm"] {
        let target = state.join(name);
        if target.exists() {
            applog::warn(&format!("layout: clearing {} before the copy", target.display()));
            let _ = std::fs::remove_file(&target);
        }
    }
}

/// Deletes everything a failed attempt had written into the state root.
///
/// Safe by construction, and only because of the rule the whole module is built on: every one of
/// these paths is a copy whose original is still sitting untouched in the old root.
fn discard(planned: &[String]) {
    for entry in planned {
        remove_any(Path::new(entry));
    }
}

/// Copies a file or a directory tree, verifying byte counts as it goes.
fn copy_any(from: &Path, to: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;

    if meta.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
        let entries = std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("{}: {e}", from.display()))?;
            copy_any(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }

    // Symlinks are not followed and not recreated. Nothing this app writes under the old root is a
    // link, so one being there means somebody else put it there — and following it would copy
    // whatever it points at into a directory the app is about to call its own.
    if meta.is_symlink() {
        applog::warn(&format!("layout: skipping the symlink {}", from.display()));
        return Ok(());
    }

    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let written = std::fs::copy(from, to).map_err(|e| format!("copying {}: {e}", from.display()))?;

    // The stub check. OneDrive Files On-Demand and iCloud's evicted files present as ordinary files
    // whose contents materialise on read; a copy that produced a short file rather than an error
    // would pass every check after this one and hand the user a truncated database.
    let expected = meta.len();
    if written != expected {
        return Err(format!(
            "{} copied {written} of {expected} bytes — the source may be a cloud placeholder that \
             is not downloaded",
            from.display()
        ));
    }
    Ok(())
}

/// Opens the copied database, folds the WAL into it, and proves it is intact.
///
/// This is the only place the migration opens a database at all, and it is deliberately the
/// destination: the source is never touched.
fn settle_database(db: &Path) -> Result<(), String> {
    let conn = open_with_retry(db)?;

    // Folds the copied `-wal` into the main file and truncates it. After this the three-file set is
    // one file again, which is what the sidecar deletion below relies on.
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
        .map_err(|e| format!("checkpointing the copied database: {e}"))?;

    let verdict: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("checking the copied database: {e}"))?;
    if verdict != "ok" {
        return Err(format!("the copied database did not verify: {verdict}"));
    }

    rewrite_rows(&conn)?;
    drop(conn);

    // Only now, and only in the destination: the checkpoint has already folded their contents in.
    for sidecar in ["codeflow.db-wal", "codeflow.db-shm"] {
        if let Some(dir) = db.parent() {
            let _ = std::fs::remove_file(dir.join(sidecar));
        }
    }
    Ok(())
}

/// Opens the copied database, distinguishing "not ready yet" from "not a database".
///
/// The distinction is the whole function. Windows Defender routinely holds a freshly written
/// multi-hundred-megabyte file for seconds after it appears, and a sharing violation there is
/// indistinguishable from corruption to any code that treats every error the same — so the most
/// likely first-run outcome on a corporate Windows machine would be a false corruption verdict that
/// threw away a perfectly good migration. Transient errors are retried; only a database that opens
/// and fails `integrity_check`, or one SQLite refuses as `NOTADB`, is corruption.
fn open_with_retry(db: &Path) -> Result<Connection, String> {
    let mut last = String::new();
    for attempt in 0..5 {
        match Connection::open(db) {
            Ok(conn) => return Ok(conn),
            Err(e) => {
                let text = e.to_string();
                let permanent = text.contains("not a database") || text.contains("NOTADB");
                if permanent {
                    return Err(format!("the copied database is not readable: {text}"));
                }
                last = text;
                applog::warn(&format!(
                    "layout: the copied database would not open (attempt {}): {last}",
                    attempt + 1
                ));
                std::thread::sleep(std::time::Duration::from_millis(400 * (attempt + 1)));
            }
        }
    }
    Err(format!("the copied database would not open after five attempts: {last}"))
}

/// The three rows whose value was a path into the old layout, or whose meaning changed with it.
///
/// Done here, on the connection that is already open and verified, rather than after `db::init()`.
/// The alternative is a "did the migration just happen" flag threaded through startup and read by a
/// second pass, which is a second thing to get wrong for no gain.
fn rewrite_rows(conn: &Connection) -> Result<(), String> {
    // The one safety net for an unwritable data directory is gated on this row, and the migration
    // has just copied it across as "already checked" — so on the launch where the new root might
    // turn out to be unusable, the modal that exists to say so would never fire. Re-armed.
    let _ = conn.execute("DELETE FROM app_settings WHERE key = 'requirements_checked'", []);

    // The backup destination, if it still names the old root on a platform where the old root is
    // not the user root — i.e. Windows, where it was `C:\CodeFlow\Backups`, shared by every account
    // on the machine. See `paths::backups_dir` for why this one is repointed while `repos` is not.
    let legacy = paths::legacy_base_dir();
    if legacy != paths::user_dir() {
        if let Ok(Some(raw)) = crate::db::queries::get_setting(conn, "backup_settings") {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) {
                let points_at_old = value
                    .get("folder")
                    .and_then(|f| f.as_str())
                    .map(|f| !f.trim().is_empty() && Path::new(f).starts_with(&legacy))
                    .unwrap_or(false);
                if points_at_old {
                    let fresh = paths::backups_dir().to_string_lossy().into_owned();
                    value["folder"] = serde_json::Value::String(fresh.clone());
                    if let Ok(json) = serde_json::to_string(&value) {
                        let _ = crate::db::queries::set_setting(conn, "backup_settings", &json);
                        applog::info(&format!("layout: backup destination repointed to {fresh}"));
                    }
                }
            }
        }

        // The opposite decision, for the opposite reason: an existing `repos` directory in the old
        // root holds working copies that may carry uncommitted work, so it is adopted where it
        // stands rather than moved or abandoned. Seeded only when it actually has something in it.
        let legacy_repos = legacy.join("repos");
        let occupied = std::fs::read_dir(&legacy_repos).map(|mut d| d.next().is_some()).unwrap_or(false);
        if occupied {
            let value = legacy_repos.to_string_lossy().into_owned();
            let _ = crate::db::queries::set_setting(conn, "clone_root", &value);
            applog::info(&format!("layout: clone destination kept at {value}"));
        }
    }
    Ok(())
}

/// Renames the source database so an older build cannot open it. See the module note.
fn rename_source_database(source: &Path) -> Result<(), String> {
    let stamp = chrono::Local::now().format("%Y-%m-%d");
    for (name, suffix) in [("codeflow.db", ""), ("codeflow.db-wal", "-wal"), ("codeflow.db-shm", "-shm")] {
        let from = source.join(name);
        if !from.exists() {
            continue;
        }
        // `codeflow.db.migrated-<date>-wal`, and not `codeflow.db-wal.migrated-<date>`, so that the
        // single prefix `codeflow.db.migrated-` finds the whole family. The obvious spelling
        // orphaned the sidecars: nothing matched them, so Settings' "delete the old copy" left them,
        // "Reset app data" left them, and the uninstaller's wildcard left them — and a WAL is not
        // metadata. It holds the most recently written pages verbatim, including the vault columns
        // this schema deliberately stores in the clear, in a directory that on Windows every local
        // account can read.
        let to = source.join(format!("codeflow.db.migrated-{stamp}{suffix}"));
        if let Err(e) = std::fs::rename(&from, &to) {
            // Not fatal, and deliberately so: the copy is verified, the manifest says complete, and
            // this app will never look at the old file again. The cost of failing here is a stale
            // database an *older* build could open — worth a loud log line, not worth refusing to
            // start a working installation.
            applog::warn(&format!("layout: could not rename {}: {e}", from.display()));
        }
    }
    Ok(())
}

fn write_breadcrumb(path: &Path, state: &Path) -> Result<(), String> {
    let body = format!(
        "CodeFlow moved its data on {}.\n\
         \n\
         The database, workspaces and chain memory now live in:\n\
         \x20   {}\n\
         \n\
         What is still in this folder is yours and is still in use: `repos/` holds the repositories\n\
         you cloned, `Backups/` holds your encrypted backups. CodeFlow keeps reading and writing\n\
         both of them here.\n\
         \n\
         The `codeflow.db.migrated-*` file is the pre-move copy of the database, kept in case\n\
         something went wrong. Nothing reads it. You can delete it from Settings, or by hand.\n\
         \n\
         Do not delete this file: it is how CodeFlow knows it has already moved.\n",
        chrono::Local::now().format("%Y-%m-%d"),
        state.to_string_lossy(),
    );
    std::fs::write(path, body).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Reading the state root
// ---------------------------------------------------------------------------

enum Occupant {
    Absent,
    Complete,
    /// Carries the entries a dead run had started writing.
    Interrupted(Vec<String>),
    Failed(String),
    Unknown,
}

fn read_manifest(path: &Path) -> Occupant {
    let Ok(raw) = std::fs::read_to_string(path) else { return Occupant::Absent };
    let Ok(manifest) = serde_json::from_str::<Manifest>(&raw) else {
        // Parsed as neither our manifest nor nothing. Treated as an occupant rather than as absent,
        // because "absent" authorises copying a database over whatever is in this directory.
        return Occupant::Unknown;
    };
    if manifest.kind != MANIFEST_KIND {
        return Occupant::Unknown;
    }
    match manifest.status.as_str() {
        "complete" => Occupant::Complete,
        "migrating" => Occupant::Interrupted(manifest.entries),
        "failed" => Occupant::Failed(manifest.error),
        _ => Occupant::Unknown,
    }
}

fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("{}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/// Decides whether a legacy root outside the user profile may be copied without asking a person.
///
/// The plain copy is wrong on a shared machine and quietly so: `C:\CodeFlow` had no per-user
/// component, so the database is one file belonging to N accounts. Migrating it into this account's
/// profile carries the other person's notes, their API collections and cookies, their SSH hosts —
/// and their vault, whose `title`/`subtitle`/`site` columns are deliberately stored in the clear
/// and whose salt and wrapped key become a permanent offline target sitting in someone else's home
/// directory, with no way for them to remove it.
///
/// **Two rules, both learned the hard way.**
///
/// *It fails closed.* Every step used to be `.ok()?`, so a database that would not open — a lock, a
/// read-only old root, a `-shm` that cannot be created on a network share — answered "no hazard"
/// and the copy went ahead. Not being able to evaluate the guard is not the same as passing it.
///
/// *It does not rely on project paths alone.* The original signal was a `projects.local_path` under
/// another user's profile, which sounds decisive and misses the exact machine this exists for: the
/// pre-v1.19 default clone destination on Windows was `C:\CodeFlow\repos\<name>`, so on a shared
/// PC where both people took the default, *every* project path is under `C:\CodeFlow` and none is
/// under `C:\Users`. The loop found nothing and the vault was copied.
///
/// So the second signal is the machine itself: another real user profile beside this one. That is
/// deliberately broad — it fires on any family PC, whether or not the other person ever opened
/// CodeFlow — because nothing in the database can distinguish the two cases, and the honest
/// response to "cannot know" is to ask rather than to guess in the direction that leaks a vault.
/// The screen it produces carries a "I was the only one using CodeFlow here" button which writes
/// [`CONSENT`] and is never asked again. A single-account machine, which is most of them, never
/// sees it.
fn shared_account_hazard(source: &Path) -> Option<String> {
    let db = source.join("codeflow.db");
    let Some(home) = dirs::home_dir() else {
        return Some("this machine's user profile could not be identified".into());
    };

    if let Some(other) = another_user_profile(&home) {
        return Some(format!("this machine has another user account ({other})"));
    }

    // Read-only and URI-mode, so the probe cannot create a `-shm` beside a database it is only
    // looking at — the source is never written to, and that includes here.
    let conn = match Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(conn) => conn,
        Err(e) => return Some(format!("{} could not be read: {e}", db.display())),
    };

    let profiles_root = match home.parent() {
        Some(root) => root.to_path_buf(),
        None => return Some("this machine's profile directory could not be identified".into()),
    };

    let mut stmt = match conn.prepare("SELECT local_path FROM projects") {
        Ok(stmt) => stmt,
        Err(e) => return Some(format!("{} could not be inspected: {e}", db.display())),
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(e) => return Some(format!("{} could not be inspected: {e}", db.display())),
    };

    for path in rows.flatten() {
        let candidate = Path::new(&path);
        if under(candidate, &profiles_root) && !under(candidate, &home) {
            return Some(format!(
                "{} was opened from another account on this machine",
                candidate.to_string_lossy()
            ));
        }
    }
    None
}

/// `Path::starts_with`, case-insensitively where the filesystem is.
///
/// `Path::starts_with` compares components byte for byte; only the disk designator is folded on
/// Windows. So a row holding `c:\users\bob\proj` does not start with `C:\Users`, and the guard
/// above would have waved it through — on the one platform where paths are not case-sensitive and
/// where the stored casing depends on however the user typed it into a folder picker years ago.
fn under(candidate: &Path, root: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let fold = |p: &Path| p.to_string_lossy().to_lowercase().replace('/', "\\");
        return fold(candidate).starts_with(&fold(root));
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidate.starts_with(root)
    }
}

/// The name of another real user profile on this machine, if there is one.
///
/// Windows only, and only reachable there: off Windows the legacy root is inside the user's own
/// home, so `migrate` never asks. The built-in profiles are excluded by name — they exist on every
/// installation and none of them is a person.
fn another_user_profile(home: &Path) -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = home;
        None
    }
    #[cfg(target_os = "windows")]
    {
        const BUILT_IN: &[&str] =
            &["public", "default", "default user", "all users", "defaultapppool", "administrator"];
        let mine = home.file_name()?.to_string_lossy().to_lowercase();
        let entries = std::fs::read_dir(home.parent()?).ok()?;
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let folded = name.to_lowercase();
            if folded == mine || BUILT_IN.contains(&folded.as_str()) || folded.starts_with('.') {
                continue;
            }
            return Some(name);
        }
        None
    }
}

/// Records that the user says they were the only person using CodeFlow on this machine, so the
/// check above is not asked again. The migration runs on the next launch.
pub fn acknowledge_shared_root() -> Result<(), String> {
    let state = paths::state_dir();
    std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
    std::fs::write(state.join(CONSENT), b"").map_err(|e| format!("{}: {e}", state.display()))?;
    applog::info("layout: the user confirmed they are the only CodeFlow user on this machine");
    Ok(())
}

/// Refuses to start a copy that cannot finish.
///
/// Twice the copy set plus a margin, not once: the destination has to hold the copy *and* the WAL
/// the checkpoint writes through, and a disk that fills mid-copy is the one failure mode that
/// leaves a half-written database where a whole one is expected.
fn check_space(state: &Path, needed: u64) -> Result<(), String> {
    let Some(free) = free_space(state) else {
        // Unknown rather than zero. Refusing to migrate because the disk could not be measured
        // would strand every machine whose mount table this crate cannot read.
        applog::warn("layout: could not measure free space; proceeding");
        return Ok(());
    };
    let required = needed.saturating_mul(2).saturating_add(64 * 1024 * 1024);
    if free < required {
        return Err(format!(
            "not enough room in {}: {} MB free, {} MB needed",
            state.display(),
            free / (1024 * 1024),
            required / (1024 * 1024)
        ));
    }
    Ok(())
}

fn free_space(target: &Path) -> Option<u64> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    // The longest matching mount point, so that a target on a mounted volume is measured against
    // that volume and not against `/`.
    disks
        .list()
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries.flatten().map(|entry| size_of(&entry.path())).sum()
}

/// Names, in the log, everything in the old root that was not copied — separating what was left on
/// purpose from what this build has never heard of.
fn log_leftovers(source: &Path) {
    let Ok(entries) = std::fs::read_dir(source) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if COPY.contains(&name.as_ref()) || LEAVE.contains(&name.as_ref()) {
            continue;
        }
        applog::info(&format!("layout: leaving behind an unrecognised entry: {name}"));
    }
}

fn remove_any(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    let _ = if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        state: PathBuf,
        user: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("cf-migrate-{tag}-{}", uuid::Uuid::new_v4()));
            let fixture = Fixture {
                source: root.join("old"),
                state: root.join("state"),
                user: root.join("user"),
                root,
            };
            std::fs::create_dir_all(&fixture.source).unwrap();
            std::fs::create_dir_all(&fixture.user).unwrap();
            fixture
        }

        /// A real SQLite database with the one table `rewrite_rows` touches, so the checkpoint and
        /// the integrity check exercise SQLite rather than a stub.
        fn with_database(self) -> Self {
            let conn = Connection::open(self.source.join("codeflow.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO app_settings VALUES ('requirements_checked', '1');
                 CREATE TABLE projects (id TEXT PRIMARY KEY, local_path TEXT NOT NULL);",
            )
            .unwrap();
            self
        }

        fn run(&self) -> Outcome {
            migrate(&self.source, &self.state, &self.user)
        }

        fn manifest(&self) -> Manifest {
            let raw = std::fs::read_to_string(self.state.join(".codeflow-layout.json")).unwrap();
            serde_json::from_str(&raw).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    #[test]
    fn a_fresh_install_records_the_layout_and_copies_nothing() {
        let f = Fixture::new("fresh");
        assert_eq!(f.run(), Outcome::Fresh);
        assert_eq!(f.manifest().status, "complete");
        // And the second launch takes the cheap path.
        assert_eq!(f.run(), Outcome::AlreadyMigrated);
    }

    #[test]
    fn the_database_and_its_sidecars_arrive_and_verify() {
        let f = Fixture::new("copy").with_database();
        std::fs::create_dir_all(f.source.join("workspaces/w1/skills")).unwrap();
        std::fs::write(f.source.join("workspaces/w1/skills/a.md"), b"skill").unwrap();

        assert!(matches!(f.run(), Outcome::Migrated { .. }));

        assert!(f.state.join("codeflow.db").exists());
        assert_eq!(
            std::fs::read_to_string(f.state.join("workspaces/w1/skills/a.md")).unwrap(),
            "skill"
        );
        // The checkpoint folded the WAL in and the sidecars were removed from the destination.
        assert!(!f.state.join("codeflow.db-wal").exists());
        assert!(!f.state.join("codeflow.db-shm").exists());
    }

    /// The rule the whole module is built around. Hashes every file in the old root before and
    /// after, and allows exactly two differences: the breadcrumb, and the database's rename.
    #[test]
    fn the_source_is_never_written_to_except_for_the_rename_and_the_breadcrumb() {
        let f = Fixture::new("readonly").with_database();
        std::fs::create_dir_all(f.source.join("repos/mine/.git")).unwrap();
        std::fs::write(f.source.join("repos/mine/main.rs"), b"fn main() {}").unwrap();

        let before = tree(&f.source);
        assert!(matches!(f.run(), Outcome::Migrated { .. }));
        let after = tree(&f.source);

        for (path, bytes) in &before {
            if path.starts_with("codeflow.db") {
                continue; // renamed, checked below
            }
            assert_eq!(after.get(path), Some(bytes), "{path} was modified in the old root");
        }
        // The user's working copy is untouched and was never copied.
        assert_eq!(after.get("repos/mine/main.rs").map(String::as_str), Some("fn main() {}"));
        assert!(!f.state.join("repos").exists(), "repos were copied into the state root");
        // The database is renamed out of the way so an older build cannot resume on it.
        assert!(!f.source.join("codeflow.db").exists());
        assert!(after.keys().any(|k| k.starts_with("codeflow.db.migrated-")));
        assert!(f.source.join(BREADCRUMB).exists());
    }

    /// The VDI diagnosis: the old root remembers, the state root does not.
    #[test]
    fn a_state_root_that_did_not_persist_is_diagnosed_and_not_migrated_again() {
        let f = Fixture::new("vdi").with_database();
        assert!(matches!(f.run(), Outcome::Migrated { .. }));

        // The profile is discarded overnight.
        std::fs::remove_dir_all(&f.state).unwrap();

        assert_eq!(f.run(), Outcome::StateRootNotPersistent);
        assert!(!f.state.join("codeflow.db").exists(), "it migrated a second time");
    }

    /// A file that parses as JSON but is not ours must never be read as "no migration yet", because
    /// that authorises copying a database on top of it.
    #[test]
    fn an_unrecognised_layout_file_aborts_instead_of_being_overwritten() {
        let f = Fixture::new("occupant").with_database();
        std::fs::create_dir_all(&f.state).unwrap();
        std::fs::write(
            f.state.join(".codeflow-layout.json"),
            br#"{"panels":[],"sidebarWidth":240}"#,
        )
        .unwrap();

        assert_eq!(f.run(), Outcome::UnknownOccupant);
        assert!(!f.state.join("codeflow.db").exists());
    }

    /// An interrupted run leaves partial copies. They are discarded rather than trusted — safe
    /// precisely because the originals are still sitting untouched in the old root.
    #[test]
    fn an_interrupted_run_discards_its_partial_copies_and_retries() {
        let f = Fixture::new("interrupted").with_database();
        std::fs::create_dir_all(&f.state).unwrap();
        std::fs::write(f.state.join("codeflow.db"), b"half a database").unwrap();
        write_manifest(
            &f.state.join(".codeflow-layout.json"),
            &Manifest::new(
                "migrating",
                &f.source,
                vec![f.state.join("codeflow.db").to_string_lossy().into_owned()],
                "",
            ),
        )
        .unwrap();

        assert!(matches!(f.run(), Outcome::Migrated { .. }));
        // Not the 15-byte stub: a real database that opens.
        let conn = Connection::open(f.state.join("codeflow.db")).unwrap();
        let verdict: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(verdict, "ok");
    }

    /// Re-arming the requirements modal. Without this the one safety net for an unwritable new root
    /// arrives already dismissed, on the launch it exists for.
    #[test]
    fn the_requirements_check_is_re_armed_by_the_migration() {
        let f = Fixture::new("rearm").with_database();
        assert!(matches!(f.run(), Outcome::Migrated { .. }));

        let conn = Connection::open(f.state.join("codeflow.db")).unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'requirements_checked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0, "the requirements modal is still disarmed");
    }

    /// The one that reported `ok` while handing the user somebody else's data.
    ///
    /// A WAL carries no link to the database it belongs to, so SQLite replays a foreign one into
    /// whatever `codeflow.db` it finds beside it — and `integrity_check` then says `ok`, because
    /// the result *is* a valid database. It is just not the one that was copied. The stale sidecar
    /// is left by any previous launch: every quit goes through `std::process::exit`, which runs no
    /// destructors, so the connection is never closed.
    #[test]
    fn a_stale_destination_wal_is_never_replayed_into_the_copied_database() {
        let f = Fixture::new("stalewal").with_database();
        {
            let source = Connection::open(f.source.join("codeflow.db")).unwrap();
            source
                .execute("INSERT INTO app_settings VALUES ('marker', 'from-the-source')", [])
                .unwrap();
        }

        // A different database, left in the state root by an earlier launch, still holding an
        // un-checkpointed WAL because nothing ever closed it.
        std::fs::create_dir_all(&f.state).unwrap();
        let stranger = Connection::open(f.state.join("codeflow.db")).unwrap();
        stranger.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        stranger
            .execute_batch(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO app_settings VALUES ('marker', 'from-a-stranger');",
            )
            .unwrap();
        std::mem::forget(stranger); // exactly what `std::process::exit` does to the connection
        assert!(f.state.join("codeflow.db-wal").exists(), "the fixture needs a live WAL");

        assert!(matches!(f.run(), Outcome::Migrated { .. }));

        let conn = Connection::open(f.state.join("codeflow.db")).unwrap();
        let marker: String = conn
            .query_row("SELECT value FROM app_settings WHERE key = 'marker'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(marker, "from-the-source", "a foreign WAL was replayed over the migration");
    }

    /// A failed copy must not leave a partial database behind.
    ///
    /// Not tidiness: `db::init` would open it, the schema parse would return `SQLITE_CORRUPT`, and
    /// the `expect` in `run()` would panic before any window exists — on that launch and every one
    /// after it, because nothing would ever remove the file. The recovery screen that reports the
    /// failure would be unreachable forever.
    #[test]
    fn a_failed_copy_leaves_no_partial_database_behind() {
        let f = Fixture::new("partial").with_database();
        // A directory where `chain-memory` should be a directory is fine; what fails the copy is a
        // source entry that cannot be read. A directory named like the file the copier expects to
        // read does it: `fs::copy` refuses a directory source.
        std::fs::create_dir_all(f.source.join("workspaces/w1")).unwrap();
        std::fs::write(f.source.join("workspaces/w1/ok.md"), b"x").unwrap();

        // Make the destination unwritable at the point the second entry lands, by pre-creating a
        // *file* where the copier needs a directory.
        std::fs::create_dir_all(&f.state).unwrap();
        std::fs::write(f.state.join("workspaces"), b"not a directory").unwrap();

        let outcome = f.run();
        assert!(matches!(outcome, Outcome::Failed { .. }), "expected a failure, got {outcome:?}");
        assert!(
            !f.state.join("codeflow.db").exists(),
            "a partial database survived a failed migration"
        );
        assert_eq!(f.manifest().status, "failed");
    }

    /// A reset removes the breadcrumb, and the launch after a reset is not told its profile is
    /// broken.
    ///
    /// Without this the breadcrumb outlives the manifest a reset wipes, and every launch from then
    /// on reports `StateRootNotPersistent` on a perfectly healthy machine — while both recovery
    /// actions in Settings return errors, because each requires a manifest state that can no longer
    /// be reached.
    #[test]
    fn a_state_root_wiped_after_migrating_recovers_instead_of_diagnosing_forever() {
        let f = Fixture::new("afterreset").with_database();
        assert!(matches!(f.run(), Outcome::Migrated { .. }));
        assert!(f.source.join(BREADCRUMB).exists());

        // What `reset::run_if_requested` does: the state root goes, and the breadcrumb with it.
        std::fs::remove_dir_all(&f.state).unwrap();
        std::fs::remove_file(f.source.join(BREADCRUMB)).unwrap();

        // Nothing left to migrate — the source database was renamed away — so this is a clean slate.
        assert_eq!(f.run(), Outcome::Fresh);
        assert_eq!(f.manifest().status, "complete");
        assert_eq!(f.run(), Outcome::AlreadyMigrated, "the verdict must stick");
    }

    /// And when the breadcrumb *does* survive — an uninstall that removed the app data and kept the
    /// old folder — the diagnosis is reported once rather than on every launch forever.
    #[test]
    fn a_surviving_breadcrumb_is_diagnosed_once_and_then_recorded() {
        let f = Fixture::new("breadcrumb").with_database();
        assert!(matches!(f.run(), Outcome::Migrated { .. }));
        std::fs::remove_dir_all(&f.state).unwrap();

        assert_eq!(f.run(), Outcome::StateRootNotPersistent);
        assert_eq!(f.run(), Outcome::AlreadyMigrated, "it repeated the diagnosis");
    }

    /// The renamed sidecars have to be findable by the same prefix as the database, or nothing ever
    /// deletes them — and a WAL holds the most recently written pages verbatim, vault columns
    /// included, in a folder that on Windows every local account can read.
    #[test]
    fn the_renamed_sidecars_are_found_by_the_same_prefix_as_the_database() {
        let f = Fixture::new("sidecars").with_database();
        std::fs::write(f.source.join("codeflow.db-wal"), b"wal").unwrap();
        std::fs::write(f.source.join("codeflow.db-shm"), b"shm").unwrap();

        assert!(matches!(f.run(), Outcome::Migrated { .. }));

        let (copies, bytes) = migrated_copies(&f.source);
        assert_eq!(copies.len(), 3, "found {copies:?}");
        assert!(bytes > 0);
        for copy in &copies {
            let name = Path::new(copy).file_name().unwrap().to_string_lossy().into_owned();
            assert!(name.starts_with("codeflow.db.migrated-"), "{name} is not sweepable");
        }
    }

    /// A previous failure is reported, not silently retried into the same wall.
    #[test]
    fn a_recorded_failure_is_not_retried() {
        let f = Fixture::new("failed").with_database();
        std::fs::create_dir_all(&f.state).unwrap();
        write_manifest(
            &f.state.join(".codeflow-layout.json"),
            &Manifest::new("failed", &f.source, Vec::new(), "the disk was full"),
        )
        .unwrap();

        assert_eq!(
            f.run(),
            Outcome::PreviouslyFailed { error: "the disk was full".into() }
        );
    }

    /// Every file under a directory, keyed by its path relative to it.
    fn tree(root: &Path) -> std::collections::BTreeMap<String, String> {
        let mut found = std::collections::BTreeMap::new();
        fn walk(dir: &Path, root: &Path, into: &mut std::collections::BTreeMap<String, String>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, into);
                } else {
                    let key = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    let body = std::fs::read(&path).unwrap_or_default();
                    into.insert(key, String::from_utf8_lossy(&body).into_owned());
                }
            }
        }
        walk(root, root, &mut found);
        found
    }
}
