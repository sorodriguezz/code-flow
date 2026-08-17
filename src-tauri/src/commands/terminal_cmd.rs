use tauri::{AppHandle, Manager, State};

use crate::db::models::WorkspaceTerminal;
use crate::db::{queries, Db};
use crate::shell_profiles::{self, ShellProfile};
use crate::terminal::{self, TerminalRegistry};

/// Every shell the terminal can open with — detected built-ins plus the user's own profiles.
///
/// Never persisted, so a shell installed while the app is running (or a profile edited in Settings)
/// shows up in the picker without a restart. The user's own profiles are re-read from the database
/// on every call; the built-in *detection* behind them is memoised for `shell_profiles::DETECT_TTL`
/// because it spawns a subprocess on Windows and this command runs on the UI thread — see
/// `shell_profiles::detect_cached`.
#[tauri::command]
pub fn list_shell_profiles(db: State<Db>) -> Result<Vec<ShellProfile>, String> {
    shell_profiles::list(&db)
}

/// `profile_id` is the id of a profile from [`list_shell_profiles`]; omitting it opens the
/// configured default. The frontend never passes a command line — see `shell_profiles` for why.
///
/// No owner: a shell opened through this command was opened at the machine, by the person sitting at
/// it. The remote-control path goes through [`open_owned_terminal`] instead, which is the only way
/// an owner is ever set — a command a phone could reach that took an owner as an argument would let
/// it claim, or disclaim, whatever it liked.
#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    cwd: String,
    profile_id: Option<String>,
) -> Result<TerminalOpened, String> {
    open_shell(app, &registry, &db, cwd, profile_id, None)
}

/// The same shell, opened **for a paired device**.
///
/// Not a `#[tauri::command]` and deliberately not reachable from the webview: `owner` is an
/// authorisation input (see `terminal::Origin::owner`), so the only caller is
/// `remotectl::dispatch`, which fills it from the bearer token it already resolved.
///
/// Recorded, where the dock's own terminals are not. A phone is a client that disappears — a browser
/// tab evicted in the background, a screen locked, a wifi handover — and comes back to a shell that
/// has been printing the whole time. Without the recording it would reattach to a blank screen; the
/// buffer is kept in memory only, because there is no bench row behind it and a shell opened from a
/// pocket must not turn into a tab on the desktop's bench. See `terminal::Transcript::key`.
pub fn open_owned_terminal(
    app: AppHandle,
    registry: &TerminalRegistry,
    db: &State<'_, Db>,
    cwd: String,
    profile_id: Option<String>,
    owner: String,
) -> Result<TerminalOpened, String> {
    open_shell(app, registry, db, cwd, profile_id, Some(owner))
}

fn open_shell(
    app: AppHandle,
    registry: &TerminalRegistry,
    db: &State<'_, Db>,
    cwd: String,
    profile_id: Option<String>,
    owner: Option<String>,
) -> Result<TerminalOpened, String> {
    let profile = shell_profiles::resolve(db, profile_id.as_deref())?;
    let record = owner
        .is_some()
        .then(|| terminal::Recording { key: None, seed: String::new() });
    let id = terminal::open_terminal(app, registry, cwd, &profile, record, owner)?;
    // The resolved profile goes back with the session id so the tab can be titled after the shell
    // that actually started — which is not necessarily the one asked for, since an unset default
    // resolves here rather than on the frontend.
    Ok(TerminalOpened { id, profile_id: profile.id, profile_name: profile.name })
}

#[derive(serde::Serialize)]
pub struct TerminalOpened {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
}

#[tauri::command]
pub fn write_terminal(registry: State<TerminalRegistry>, id: String, data: String) -> Result<(), String> {
    terminal::write_terminal(&registry, &id, &data)
}

#[tauri::command]
pub fn resize_terminal(registry: State<TerminalRegistry>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize_terminal(&registry, &id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(registry: State<TerminalRegistry>, id: String) -> Result<(), String> {
    terminal::close_terminal(&registry, &id)
}

// ---------------------------------------------------------------------------
// The agent console's terminal bench
// ---------------------------------------------------------------------------

/// One bench terminal on its way to the frontend: the stored row, plus whether a shell is currently
/// attached to it.
///
/// The two are genuinely independent and the panel needs both. A row with no `session_id` is a
/// terminal that exists but has no process — either the app restarted since it was last used, or
/// its shell exited. The panel draws it either way; what changes is whether opening it *attaches*
/// or *starts*.
#[derive(serde::Serialize)]
pub struct BenchTerminal {
    #[serde(flatten)]
    pub row: WorkspaceTerminal,
    /// The live pty session, if one is running right now. Minted fresh each time a shell opens, so
    /// it is never what anything persists.
    pub session_id: Option<String>,
}

/// The whole bench: its tabs, and the shells filed under them with their live state.
///
/// One call rather than two, because the two halves are only meaningful together — a tab with no
/// terminals and a terminal with no tab are both states the panel cannot draw, and fetching them
/// separately would put a window between the reads where either could be true.
#[derive(serde::Serialize)]
pub struct Bench {
    pub tabs: Vec<crate::db::models::BenchTab>,
    pub terminals: Vec<BenchTerminal>,
}

/// Called every time the panel opens, which is what makes "closed but still running" work: the app
/// may have been up the whole time with the shells alive behind a shut panel, and this is how the
/// panel finds them again instead of starting a second set beside them.
#[tauri::command]
pub fn list_workspace_terminals(
    registry: State<TerminalRegistry>,
    db: State<Db>,
    workspace_id: String,
) -> Result<Bench, String> {
    let (tabs, rows) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            queries::list_bench_tabs(&conn, &workspace_id).map_err(|e| e.to_string())?,
            queries::list_workspace_terminals(&conn, &workspace_id).map_err(|e| e.to_string())?,
        )
    };
    let live = terminal::recorded_state(&registry);
    let terminals = rows
        .into_iter()
        .map(|mut row| match live.get(&row.id) {
            // Attached: the live buffer replaces the stored one, which is up to a flush interval
            // behind it. See `terminal::recorded_state`.
            Some((session_id, transcript)) => {
                row.transcript = transcript.clone();
                BenchTerminal { row, session_id: Some(session_id.clone()) }
            }
            None => BenchTerminal { row, session_id: None },
        })
        .collect();
    Ok(Bench { tabs, terminals })
}

/// A new, empty tab.
#[tauri::command]
pub fn add_bench_tab(db: State<Db>, workspace_id: String) -> Result<crate::db::models::BenchTab, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_bench_tab(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Records a tab's pane arrangement. See `queries::set_bench_layout` for why it is opaque here.
#[tauri::command]
pub fn set_bench_layout(db: State<Db>, tab_id: String, layout: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_bench_layout(&conn, &tab_id, &layout).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_bench_tab(db: State<Db>, tab_id: String, title: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_bench_tab(&conn, &tab_id, &title).map_err(|e| e.to_string())
}

/// Closes a tab: every shell in it killed, every transcript in it forgotten.
#[tauri::command]
pub fn remove_bench_tab(
    registry: State<TerminalRegistry>,
    db: State<Db>,
    tab_id: String,
) -> Result<(), String> {
    let ids = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::delete_bench_tab(&conn, &tab_id).map_err(|e| e.to_string())?
    };
    terminal::close_recorded(&registry, &ids);
    Ok(())
}

/// Adds a terminal to the bench and starts its shell.
///
/// The row is written first and the shell opened against its id, so the recording has somewhere to
/// go from the very first byte — a shell that printed its prompt before the row existed would have
/// lost exactly the line saying which shell it is.
#[tauri::command]
pub fn add_workspace_terminal(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    workspace_id: String,
    tab_id: String,
    cwd: String,
    profile_id: Option<String>,
) -> Result<BenchTerminal, String> {
    let profile = shell_profiles::resolve(&db, profile_id.as_deref())?;
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::add_workspace_terminal(&conn, &workspace_id, &tab_id, &profile.name, &cwd, &profile.id)
            .map_err(|e| e.to_string())?
    };
    let recording = terminal::Recording { key: Some(row.id.clone()), seed: String::new() };
    let session_id = terminal::open_terminal(app, &registry, cwd, &profile, Some(recording), None)?;
    Ok(BenchTerminal { row, session_id: Some(session_id) })
}

/// Starts a shell for a row that has none — the restart case, and the "it exited and I want it
/// back" case. The stored transcript is untouched: the panel replays it and the new shell writes
/// after it, which is what makes a restarted bench read as the same one continued.
#[tauri::command]
pub fn resume_workspace_terminal(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    id: String,
) -> Result<String, String> {
    // Asked first, because the common answer costs nothing further. Already attached — hand back
    // the session it has rather than opening a rival shell into the same transcript: two writers on
    // one row would interleave into something neither of them said.
    if let Some((existing, _)) = terminal::recorded_state(&registry).get(&id) {
        return Ok(existing.clone());
    }
    let (cwd, profile_id, transcript) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT cwd, profile_id, transcript FROM workspace_terminals WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|_| "that terminal is no longer on the bench".to_string())?
    };
    // A stored profile that has since been uninstalled falls back to the configured default rather
    // than refusing to open — the same rule `shell_profiles::choose` follows for a stale default.
    let wanted = (!profile_id.is_empty()).then_some(profile_id.as_str());
    let profile = shell_profiles::resolve(&db, wanted).or_else(|_| shell_profiles::resolve(&db, None))?;
    // Seeded with what this terminal had already printed, and marked off with a rule.
    //
    // The seed is what stops the next flush from overwriting the history with this shell's first
    // two lines — see `terminal::Recording`. The rule is for the reader: the text above it came
    // from a process that has since ended, and without a seam the new shell's prompt reads as the
    // next line of the old one, which is exactly the misreading that ends in "why did my command
    // not run". Dim, and drawn with the same box character the app's own dividers use.
    let seed = if transcript.is_empty() {
        transcript
    } else {
        format!("{transcript}\r\n\x1b[2m{}\x1b[0m\r\n", "─".repeat(40))
    };
    terminal::open_terminal(
        app,
        &registry,
        cwd,
        &profile,
        Some(terminal::Recording { key: Some(id), seed }),
        None,
    )
}

#[tauri::command]
pub fn rename_workspace_terminal(db: State<Db>, id: String, title: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_workspace_terminal(&conn, &id, &title).map_err(|e| e.to_string())
}

/// Removes one terminal: its shell is killed and its row and output are forgotten.
#[tauri::command]
pub fn remove_workspace_terminal(
    registry: State<TerminalRegistry>,
    db: State<Db>,
    id: String,
) -> Result<(), String> {
    terminal::close_recorded(&registry, std::slice::from_ref(&id));
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace_terminal(&conn, &id).map_err(|e| e.to_string())
}

/// Empties the bench: every shell killed, every transcript forgotten. The irreversible one, which
/// is why the panel puts a confirmation in front of it.
#[tauri::command]
pub fn clear_workspace_terminals(
    registry: State<TerminalRegistry>,
    db: State<Db>,
    workspace_id: String,
) -> Result<(), String> {
    let ids = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let ids = queries::clear_workspace_terminals(&conn, &workspace_id).map_err(|e| e.to_string())?;
        queries::clear_bench_tabs(&conn, &workspace_id).map_err(|e| e.to_string())?;
        ids
    };
    terminal::close_recorded(&registry, &ids);
    Ok(())
}

/// Writes every changed transcript to the database.
///
/// Called on a timer (see [`spawn_transcript_flush`]) and once more on the way out, and safe to
/// call at any moment: an unchanged session costs it a flag check. Errors are swallowed — this runs
/// where there is nobody to tell, and a failed flush costs the last few seconds of scrollback
/// rather than anything the user is holding.
pub fn flush_transcripts(app: &AppHandle) {
    let registry = app.state::<TerminalRegistry>();
    let changed = terminal::drain_transcripts(&registry);
    if changed.is_empty() {
        return;
    }
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return };
    for (id, transcript) in changed {
        let _ = queries::save_workspace_terminal_transcript(&conn, &id, &transcript);
    }
}

/// How often the recorded output is written down.
///
/// A compromise, and worth naming as one. Writing on every chunk would put a SQLite transaction in
/// the path of every line a build prints; writing only when the panel closes would lose everything
/// a crash interrupted, which is precisely the case somebody left a long job running for. Four
/// seconds bounds the loss to something nobody notices and the writes to something nobody feels.
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(4);

/// Starts the flusher. One thread for the life of the app, doing nothing at all while the bench is
/// empty or idle.
pub fn spawn_transcript_flush(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(FLUSH_INTERVAL);
        flush_transcripts(&app);
    });
}
