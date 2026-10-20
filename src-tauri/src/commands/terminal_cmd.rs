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
///
/// `account_provider` + `account_id` open the shell *as* one account of an AI CLI — see
/// `crate::ai_accounts`. An id that no longer exists opens an ordinary shell.
#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    cwd: String,
    profile_id: Option<String>,
    account_provider: Option<String>,
    account_id: Option<String>,
) -> Result<TerminalOpened, String> {
    let account = match (account_provider.as_deref(), account_id.as_deref()) {
        (Some(provider), Some(id)) if !id.trim().is_empty() => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            crate::ai_accounts::get(&conn, id)
                .map_err(|e| e.to_string())?
                .filter(|account| account.provider == provider)
                .map(|account| crate::ai_accounts::AccountEnv::for_account(provider, &account.id))
        }
        _ => None,
    };
    open_shell(app, &registry, &db, cwd, profile_id, None, account.as_ref())
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
    open_shell(app, registry, db, cwd, profile_id, Some(owner), None)
}

fn open_shell(
    app: AppHandle,
    registry: &TerminalRegistry,
    db: &State<'_, Db>,
    cwd: String,
    profile_id: Option<String>,
    owner: Option<String>,
    account: Option<&crate::ai_accounts::AccountEnv>,
) -> Result<TerminalOpened, String> {
    let profile = shell_profiles::resolve(db, profile_id.as_deref())?;
    let record = owner
        .is_some()
        .then(|| terminal::Recording { key: None, seed: String::new() });
    let id = terminal::open_terminal(app, registry, cwd, &profile, record, owner, account)?;
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

// All three `(async)`, which runs the sync body on a worker rather than on the main thread.
//
// Every one of them takes the global terminal registry mutex and then does something that can
// block while holding it: a pty write blocks when the child has stopped reading and the pipe is
// full, a resize is a ConPTY screen-buffer reflow on Windows, and a close waits on the child. On
// the main thread that is the window not repainting — a shell that stops draining its input would
// freeze the whole app on the next keystroke, which is one of the ways "se pega" happens.
#[tauri::command(async)]
pub fn write_terminal(registry: State<TerminalRegistry>, id: String, data: String) -> Result<(), String> {
    terminal::write_terminal(&registry, &id, &data)
}

#[tauri::command(async)]
pub fn resize_terminal(registry: State<TerminalRegistry>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize_terminal(&registry, &id, cols, rows)
}

#[tauri::command(async)]
pub fn close_terminal(registry: State<TerminalRegistry>, id: String) -> Result<(), String> {
    terminal::close_terminal(&registry, &id)
}

/// What each of `paths` is on disk — `0` missing, `1` a file, `2` a directory — so the terminal can
/// make a path printed by a command clickable only when it names something real.
///
/// A leading `~` expands to the home folder; every other path is taken as given, which in practice
/// means absolute — the pane resolves relative ones against the shell's folder before asking.
/// `std::fs::metadata` and nothing more: no opening, no reading, no canonicalising. At most
/// [`PATH_KINDS_LIMIT`] paths per call; the rest answer `0`, since a screenful of output is the
/// most anyone hovers over and a runaway caller must not turn this into a disk walk.
#[tauri::command(async)]
pub fn terminal_path_kinds(paths: Vec<String>) -> Vec<u8> {
    let home = dirs::home_dir();
    paths
        .iter()
        .enumerate()
        .map(|(i, raw)| if i < PATH_KINDS_LIMIT { path_kind(raw, home.as_deref()) } else { 0 })
        .collect()
}

const PATH_KINDS_LIMIT: usize = 64;

fn path_kind(raw: &str, home: Option<&std::path::Path>) -> u8 {
    if raw.is_empty() || raw.contains('\0') {
        return 0;
    }
    let path = if raw == "~" {
        match home {
            Some(h) => h.to_path_buf(),
            None => return 0,
        }
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        match home {
            Some(h) => h.join(rest),
            None => return 0,
        }
    } else {
        std::path::PathBuf::from(raw)
    };
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => 2,
        Ok(meta) if meta.is_file() => 1,
        _ => 0,
    }
}

/// What a terminal is busy with — the program in its foreground other than the shell — so closing
/// its tab can ask first. `None` when it sits at its prompt. Reads the process table, hence async.
#[tauri::command(async)]
pub fn terminal_foreground(registry: State<TerminalRegistry>, id: String) -> Option<String> {
    terminal::foreground_process(&registry, &id)
}

/// Every terminal with an agent in it, as the rail draws it — for a window that just opened. Later
/// changes arrive as `terminal:agent` events. See `crate::agentstatus`.
#[tauri::command]
pub fn terminal_agent_states() -> Vec<crate::agentstatus::Snapshot> {
    crate::agentstatus::states()
}

/// The window just typed `agent`'s CLI into session `id`: name it before the program has a chance
/// to, so the card shows who is there from the first keystroke.
#[tauri::command]
pub fn terminal_set_agent(id: String, agent: String) -> bool {
    crate::agentstatus::set_agent(&id, agent.trim())
}

/// The Claude Code events whose hooks tell the rail what the agent is doing.
const CLAUDE_HOOK_EVENTS: &[&str] =
    &["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/// The `hooks` block of Claude Code's settings, each event a `<cf> hook claude <event>`. The tool
/// events take a `matcher`; the others have none to take.
fn claude_hook_settings(cf: &str) -> serde_json::Value {
    let entry = |event: &str| {
        let command = serde_json::json!({ "type": "command", "command": format!("{cf} hook claude {event}"), "timeout": 10 });
        if matches!(event, "PreToolUse" | "PostToolUse" | "PermissionRequest") {
            serde_json::json!([{ "matcher": "*", "hooks": [command] }])
        } else {
            serde_json::json!([{ "hooks": [command] }])
        }
    };
    let hooks: serde_json::Map<String, serde_json::Value> =
        CLAUDE_HOOK_EVENTS.iter().map(|event| (event.to_string(), entry(event))).collect();
    serde_json::json!({ "hooks": hooks })
}

/// What an agent started from the «Worktrees» rail is told about `cf`, so it uses it on its own: asks
/// before anything irreversible, says when it is done or stuck. One line, plain ASCII and free of
/// quotes, `$` and backticks — Codex takes it as a command-line argument in whatever shell the
/// terminal runs.
pub const CF_NOTE: &str = "You are running inside a CodeFlow terminal, which gives you the cf command to reach the user. \
Before anything destructive or irreversible (deleting files or data, force-pushing, rewriting history, dropping tables, \
installing system-wide) run cf ask <question> and go ahead only if it exits 0, which means the user said yes; \
it prints whatever the user typed. When you finish, or when you are blocked and need the user, run cf notify <one line>. \
cf review opens the diff of your work in the app, and cf status prints what the app has open as JSON.";

/// Where a launch reads its extras from — see [`agent_launch_files`].
#[derive(serde::Serialize)]
pub struct AgentLaunchFiles {
    /// Claude Code's `--settings`: its status hooks.
    settings: String,
    /// Claude Code's `--append-system-prompt-file`: [`CF_NOTE`].
    note_file: String,
    /// [`CF_NOTE`] itself, for the CLIs that take it some other way.
    note: String,
}

/// The files an agent CLI started from the «Worktrees» rail is given:
///
/// - **`--settings`** for Claude Code: its status hooks, each one a `cf hook claude <event>`.
/// - **`--append-system-prompt-file`** for Claude Code: what `cf` is for — appended to its system
///   prompt, not replacing it.
///
/// Passed per launch rather than written into `~/.claude`: the user's own settings are theirs, and a
/// `claude` typed by hand in one of this app's shells still reports its state through the terminal
/// (OSC 7501) — the hooks only add the prompt and the reply. Written on every call, so a moved or
/// updated app never leaves a file pointing at an old `cf`.
#[tauri::command]
pub fn agent_launch_files(app: AppHandle) -> Result<AgentLaunchFiles, String> {
    let cf = match terminal::cf_binary(&app) {
        Some(path) => {
            let path = path.display().to_string();
            if cfg!(windows) {
                format!("\"{path}\"")
            } else {
                format!("'{}'", path.replace('\'', "'\\''"))
            }
        }
        None => "cf".to_string(),
    };
    let dir = crate::paths::state_dir().join("agent-hooks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let settings = dir.join("claude-settings.json");
    let text = serde_json::to_string_pretty(&claude_hook_settings(&cf)).map_err(|e| e.to_string())?;
    std::fs::write(&settings, text).map_err(|e| e.to_string())?;
    let note_file = dir.join("cf-note.md");
    std::fs::write(&note_file, CF_NOTE).map_err(|e| e.to_string())?;
    Ok(AgentLaunchFiles {
        settings: settings.display().to_string(),
        note_file: note_file.display().to_string(),
        note: CF_NOTE.to_string(),
    })
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

/// Modes a resumed terminal must not inherit from the process it is replacing.
///
/// **The bug this exists for.** A transcript is replayed into a fresh xterm verbatim — colour,
/// cursor moves and progress bars redraw exactly as they did, which is the point of recording raw
/// bytes. But the recording is cut wherever the app stopped, so it routinely ends *inside* a
/// full-screen program: `claude`, `nvim`, `htop`. Every DEC private mode that program switched on
/// is switched on again by the replay, on a terminal whose shell is a brand new one that never
/// asked for any of it.
///
/// Pointer reporting is the one that draws blood. Those programs set `?1003h` (report every pointer
/// move) with `?1006h` (report it in SGR), so after a resume the pane reports to a shell prompt:
/// resting the mouse over the terminal types `35;104;39M35;105;38M…` at it — the printable
/// remainder of each `ESC[<35;col;row M` report, once the line editor has eaten the escape —
/// hundreds of them, into a shell trying to read a command. The alternate screen is the same fault
/// in disguise: a replay that ends on it leaves the pane showing an empty buffer with the new
/// prompt at the top and no scrollback, which reads as "my terminal lost my history".
///
/// **Written into the seed here, rather than by the pane after every replay.** A pane also replays
/// the *live* buffer of a session that is still running — that is how the bench survives a
/// workspace switch — and a terminal running `htop` right now needs exactly these modes left alone.
/// This function is the one place in the app that knows the process which set them has ended and
/// that something else is taking its place. Baking the reset into the transcript also persists it
/// at the seam, so every later replay of this row gets it in the right position rather than tacked
/// onto the end.
///
/// Not a full `ESC c`: that clears the screen and the scrollback, which is the history the replay
/// just spent a write on. What is stale is the modes, not the text.
const RESET_TTY_MODES: &str = concat!(
    // Pointer reporting, and the three encodings that carry it. First, because it is the one that
    // turns a mouse resting over the pane into typing.
    "\x1b[?1000l\x1b[?1002l\x1b[?1003l",
    "\x1b[?1005l\x1b[?1006l\x1b[?1015l",
    // Back to the main buffer, which brings the history above the last full-screen program back
    // with it. Before the scroll region below, deliberately: margins are per-buffer, and the one
    // worth fixing is the buffer the new shell is about to print into.
    "\x1b[?1049l",
    // Scroll region back to the whole screen, wrap back on.
    "\x1b[r\x1b[?7h",
    // Bracketed paste off, cursor keys and keypad back to normal. A shell that wants any of these
    // sets them itself at its first prompt; inheriting them from a dead process only garbles arrows.
    "\x1b[?2004l\x1b[?1l\x1b>",
    // Cursor visible, attributes default: a full-screen program hides the one and leaves the other
    // mid-colour, and a prompt with no cursor is the clearest possible way to look hung.
    "\x1b[?25h\x1b[0m",
);

/// A terminal that has just had a shell started under its stored output.
///
/// The transcript comes back with the session because the caller's copy is now stale in a way it
/// cannot see: resuming *rewrites* the history — see [`RESET_TTY_MODES`] and the rule below it —
/// and a panel that mounted its pane against the copy it was already holding would replay the
/// version without them, which is the whole bug this second field exists to avoid.
#[derive(serde::Serialize)]
pub struct ResumedTerminal {
    pub session_id: String,
    pub transcript: String,
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
    let session_id = terminal::open_terminal(app, &registry, cwd, &profile, Some(recording), None, None)?;
    Ok(BenchTerminal { row, session_id: Some(session_id) })
}

/// What a resumed terminal starts its recording from: everything it had already printed, put back
/// into a state a prompt can live in, and marked off with a rule.
///
/// The seed is what stops the next flush from overwriting the history with the new shell's first
/// two lines — see [`terminal::Recording`].
///
/// The reset is what stops the new shell from inheriting the modes of whatever program the
/// recording happened to be cut inside — see [`RESET_TTY_MODES`]. It goes **before** the rule so
/// that the rule lands on the restored main screen, rather than on an alternate one some dead
/// full-screen program left showing.
///
/// The rule is for the reader: the text above it came from a process that has since ended, and
/// without a seam the new shell's prompt reads as the next line of the old one, which is exactly
/// the misreading that ends in "why did my command not run". Dim, and drawn with the same box
/// character the app's own dividers use.
///
/// An empty history stays empty. There is no earlier process to mark off from, and a terminal that
/// opens on a horizontal rule is one claiming a past it does not have.
fn resume_seed(transcript: &str) -> String {
    if transcript.is_empty() {
        return String::new();
    }
    format!("{transcript}{RESET_TTY_MODES}\r\n\x1b[2m{}\x1b[0m\r\n", "─".repeat(40))
}

/// Starts a shell for a row that has none — the restart case, and the "it exited and I want it
/// back" case. The panel replays the history and the new shell writes after it, which is what makes
/// a restarted bench read as the same one continued.
///
/// **The history comes back with the session, and the caller must use it.** Resuming is not a
/// read: it rewrites the stored transcript, appending the terminal-mode reset and the seam that
/// [`resume_seed`] documents. A panel that kept the copy it read before this call would mount its
/// pane against a version with neither.
#[tauri::command]
pub fn resume_workspace_terminal(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    id: String,
) -> Result<ResumedTerminal, String> {
    // Asked first, because the common answer costs nothing further. Already attached — hand back
    // the session it has rather than opening a rival shell into the same transcript: two writers on
    // one row would interleave into something neither of them said. Its live buffer comes back
    // beside it, untouched: nothing ended here, so there is nothing to put back.
    if let Some((existing, live)) = terminal::recorded_state(&registry).get(&id) {
        return Ok(ResumedTerminal { session_id: existing.clone(), transcript: live.clone() });
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
    let seed = resume_seed(&transcript);
    let session_id = terminal::open_terminal(
        app,
        &registry,
        cwd,
        &profile,
        Some(terminal::Recording { key: Some(id), seed: seed.clone() }),
        None,
        None,
    )?;
    Ok(ResumedTerminal { session_id, transcript: seed })
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
pub fn flush_transcripts<R: tauri::Runtime>(app: &AppHandle<R>) {
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

#[cfg(test)]
mod tests {

    /// Codex gets the note as a command-line argument: nothing in it may mean something to a shell.
    #[test]
    fn the_cf_note_is_one_shell_safe_line() {
        assert!(!CF_NOTE.contains('\n'));
        assert!(CF_NOTE.is_ascii());
        for forbidden in ['"', '\'', '$', '`', '\\', '!'] {
            assert!(!CF_NOTE.contains(forbidden), "{forbidden:?} in the note");
        }
        assert!(CF_NOTE.contains("cf ask") && CF_NOTE.contains("cf notify"));
    }

    /// The shape Claude Code reads: an array of matcher groups per event, each with its commands.
    #[test]
    fn claude_hooks_call_cf_for_every_event_with_a_matcher_only_on_tool_events() {
        let settings = claude_hook_settings("'/Applications/Code Flow.app/cf'");
        let hooks = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), CLAUDE_HOOK_EVENTS.len());
        let stop = &hooks["Stop"][0];
        assert!(stop.get("matcher").is_none());
        assert_eq!(stop["hooks"][0]["type"], "command");
        assert_eq!(stop["hooks"][0]["command"], "'/Applications/Code Flow.app/cf' hook claude Stop");
        assert_eq!(hooks["PreToolUse"][0]["matcher"], "*");
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 10);
    }

    use super::*;

    #[test]
    fn path_kinds_tell_files_from_folders_and_cap_the_batch() {
        let dir = std::env::temp_dir().join(format!("cf-path-kinds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let kinds = terminal_path_kinds(vec![
            file.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            dir.join("missing").to_string_lossy().into_owned(),
            String::new(),
        ]);
        assert_eq!(kinds, vec![1, 2, 0, 0]);
        assert_eq!(path_kind("~", Some(&dir)), 2);
        assert_eq!(path_kind("~/a.txt", Some(&dir)), 1);
        assert_eq!(path_kind("~/a.txt", None), 0);
        let many = terminal_path_kinds(vec![dir.to_string_lossy().into_owned(); 70]);
        assert_eq!(many.len(), 70);
        assert!(many[..64].iter().all(|k| *k == 2) && many[64..].iter().all(|k| *k == 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole point of the seed: a history that was cut inside a full-screen program must not
    /// arm that program's modes on the shell replacing it.
    ///
    /// Asserted by *position* rather than by presence, because presence is not the property that
    /// matters — a reset written after the rule would still be in the string and would still leave
    /// the rule drawn on a dead program's alternate screen.
    #[test]
    fn seed_disarms_the_previous_process_before_drawing_the_seam() {
        // A transcript cut mid-`claude`: alternate screen, any-event mouse tracking, SGR encoding,
        // cursor hidden. None of it ever turned off, because the process never got to exit.
        let cut_mid_tui = "\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?25lsome full-screen ui";
        let seed = resume_seed(cut_mid_tui);

        let mouse_off = seed.find("\x1b[?1003l").expect("any-event mouse tracking is turned off");
        let sgr_off = seed.find("\x1b[?1006l").expect("the SGR encoding carrying it is turned off");
        let main_screen = seed.find("\x1b[?1049l").expect("the alternate screen is left");
        let cursor_back = seed.find("\x1b[?25h").expect("the cursor is made visible again");
        let rule = seed.find('─').expect("the seam is drawn");

        assert!(seed.starts_with(cut_mid_tui), "the history itself is kept, verbatim");
        for (what, at) in [("mouse", mouse_off), ("sgr", sgr_off), ("main screen", main_screen), ("cursor", cursor_back)] {
            assert!(at > cut_mid_tui.len(), "{what} is reset after the history, not inside it");
            assert!(at < rule, "{what} is reset before the rule, so the rule lands on a sane screen");
        }
    }

    /// A terminal that never printed anything has no earlier process to mark off from, and opening
    /// on a horizontal rule would be claiming a past it does not have.
    #[test]
    fn seed_of_an_empty_history_is_empty() {
        assert_eq!(resume_seed(""), "");
    }
}
