use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::shell_profiles::ShellProfile;

/// How much of a session's output is kept.
///
/// A cap rather than a whole history, because the thing being recorded is unbounded and mostly
/// worthless: one `cargo build` or a watch mode left running overnight would put megabytes into a
/// row nobody will read past the last screen of. A quarter of a megabyte is a few thousand lines —
/// far more than the scrollback anyone scrolls back through, and small enough to write on a timer
/// without thinking about it.
const TRANSCRIPT_LIMIT: usize = 256 * 1024;

/// The most often a session may emit — one frame.
///
/// A `cargo build` in a pty produces hundreds of reads a second, and each one used to be its own
/// IPC message, its own JS callback and its own `xterm.write`. xterm parses one large write far
/// more cheaply than twenty small ones, so under sustained output the reader hands it a frame's
/// worth at a time. One frame and no more: this is an interactive terminal, and a keystroke's echo
/// arriving 16ms late is imperceptible while 50ms is not.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// A pending chunk this big goes out without waiting for the frame to end. Past a certain size the
/// win from coalescing is already banked and all that is left is latency.
const FLUSH_MAX_BYTES: usize = 32 * 1024;

/// What the reader has read and the emitter has not yet sent.
///
/// The two are separate threads for one reason: `Read::read` on a pty master blocks with no
/// timeout, so a reader that decided on its own when to flush could only decide *while holding
/// output it had just read* — and if the program then went quiet, that output would sit
/// unflushed until the next byte arrived, which might be never. Output shown late is a bug; output
/// shown only after the user presses a key is a worse one. Splitting it means the emitter's clock
/// runs whether or not the child says anything.
#[derive(Default)]
struct Outbox {
    pending: String,
    /// The pty closed: the child is gone and no more will be read. The emitter sends what is left
    /// and only then announces the exit, so nothing a program printed on its way out can be lost
    /// or arrive after the pane has been told the session ended.
    closed: bool,
}

/// A bounded copy of what a session has printed, and which stored terminal it belongs to.
///
/// Kept here rather than on the frontend for the one reason that decides it: the pane is a React
/// component and this has to survive the pane being unmounted. Closing the bench is exactly the
/// case the feature exists for — the shells keep running, they keep printing, and whatever they
/// print while nothing is on screen is precisely the output somebody backgrounded them to collect.
struct Transcript {
    /// The `workspace_terminals` row this belongs to. Stable across restarts, unlike the pty
    /// session id, which is minted fresh every time a shell is opened.
    ///
    /// `None` for a recording that is kept **only in memory**, which is what a phone's session gets:
    /// there is no bench row behind it and there must not be one — a shell opened from a pocket has
    /// no business appearing as a tab on the desktop's bench, and persisting it would outlive the
    /// pairing that created it. The buffer is still worth keeping, because a browser tab evicted in
    /// the background comes back to a live shell it has printed nothing of yet.
    key: Option<String>,
    buf: String,
    /// Whether `buf` has changed since it was last written to the database. The flush walks every
    /// session on a timer, and a bench of six idle shells should cost it six comparisons, not six
    /// writes.
    dirty: bool,
}

/// What to record, and what the recording already contains.
///
/// `seed` is not a convenience. The flush writes the buffer *whole* (see [`drain_transcripts`]), so
/// a resumed terminal starting from an empty buffer would, four seconds later, replace its own
/// stored history with the two lines its new shell had printed. Everything the user came back for
/// would be gone, and gone from the only copy — the point of the feature, deleted by the act of
/// using it. Seeding makes the new session a continuation of the record rather than a replacement.
pub struct Recording {
    /// The `workspace_terminals` row. Stable across restarts, unlike the pty session id. `None`
    /// records into memory only — see [`Transcript::key`].
    pub key: Option<String>,
    pub seed: String,
}

impl Transcript {
    fn push(&mut self, chunk: &str) {
        self.buf.push_str(chunk);
        self.dirty = true;
        if self.buf.len() <= TRANSCRIPT_LIMIT {
            return;
        }
        // Trimmed from the front to the start of a *line* rather than to the byte the limit fell
        // on. Cutting mid-line is not merely untidy in a terminal: half an escape sequence at the
        // top of the replay is an unterminated colour or cursor move that repaints the rest of the
        // screen with it. Falling back to the whole buffer is the degenerate case of one line
        // longer than the limit, which is a `curl` progress bar or a minified file — nothing worth
        // keeping a fragment of.
        let overflow = self.buf.len() - TRANSCRIPT_LIMIT;
        let cut = self.buf[overflow..].find('\n').map(|at| overflow + at + 1).unwrap_or(self.buf.len());
        self.buf.drain(..cut);
    }
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// `Some` for the agent console's bench and for a phone's session. The repository dock's
    /// terminals and the Remote workspace's `ssh` sessions are not recorded: neither has anywhere to
    /// be replayed into, and a remote host's output is somebody else's machine talking.
    transcript: Option<Arc<Mutex<Transcript>>>,
    /// What this session is, for whoever has to describe one they did not open. See [`Origin`].
    origin: Origin,
}

/// What a session is, told by whoever opened it.
///
/// The three fields exist for callers that have to reason about a session they did not create: the
/// remote-control dispatcher deciding whether a phone may write to an id, and the settings panel
/// listing the shells a phone has left running on this machine. None of it is derivable after the
/// fact — a pty knows its file descriptors and nothing else.
pub struct Origin {
    /// Where the process started, as the caller understands it. Empty for `ssh`, whose local
    /// working directory means nothing to anybody reading the list.
    pub cwd: String,
    /// The shell profile's name, or the program for anything that is not a shell.
    pub profile: String,
    /// The paired device that asked for this session, or `None` for one opened at the desk.
    ///
    /// **This is an authorisation input**, and the only one in this module. `remotectl/dispatch.rs`
    /// refuses a `write`/`resize`/`close` for an id whose owner is not the caller — without it a
    /// phone could drive any pty on the machine by id, including the person-at-the-desk's shell and
    /// a live `ssh -t` into somebody else's server. It is set exclusively by the remote-control
    /// path; nothing a phone sends can reach this field.
    pub owner: Option<String>,
}

/// One live session, as something that can be listed.
///
/// Deliberately without the transcript: a listing of six shells carrying a quarter of a megabyte
/// each is not a listing. See [`transcript_of`] for the replay, which is asked for one session at a
/// time and only by whoever is about to draw it.
#[derive(Clone, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub cwd: String,
    pub profile: String,
    /// The device that opened it. Always `Some` in every list this type is used for — both the
    /// desktop panel and a phone's own listing are about remote sessions — but carried rather than
    /// implied, because "whose" is the entire question the panel is answering.
    pub owner: Option<String>,
}

#[derive(Default)]
pub struct TerminalRegistry(Mutex<HashMap<String, TerminalSession>>);

/// The bytes one session printed, and who is entitled to them.
///
/// `owner` travels on the event rather than being looked up when the event is routed, and both
/// halves of that are deliberate. Looking it up would mean taking the registry lock for every frame
/// of a `cargo build` — and, worse, it would be *impossible* for the exit: a session is struck from
/// the registry before `terminal:exit` is emitted (see [`open_pty`]), so the lookup would answer "no
/// owner" for precisely the frame that says the shell is gone, and a phone would sit forever on a
/// terminal whose process had ended. Stamped at spawn, it is correct at both ends of the session's
/// life.
///
/// `None` is a shell opened at the desk, which no paired device may see. See
/// `remotectl::bridge::TERMINAL_EVENTS`.
#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    id: String,
    data: String,
    owner: Option<String>,
}

#[derive(Clone, Serialize)]
struct TerminalExitEvent {
    id: String,
    owner: Option<String>,
}

/// Which shell to run is decided by [`crate::shell_profiles`]; this only turns the answer into a
/// pty command. Nothing here reaches for `$SHELL` or a hardcoded path any more.
/// `record` names the `workspace_terminals` row to record into, for a shell on the agent console's
/// bench; `None` for the repository dock, which keeps no history.
/// A blank `cwd` means "the user's home", not "wherever this process happens to be".
///
/// The distinction matters because the app's own working directory on a GUI launch is launchd's —
/// `/` on macOS — and a shell that opens there is a shell nobody asked for. Home is what every
/// terminal emulator on the machine does when it is not told otherwise, so it is the answer that
/// needs no explaining. Resolved here rather than at each call site so a caller that has no
/// directory to offer can simply say so.
fn start_dir(cwd: &str) -> Option<String> {
    if !cwd.trim().is_empty() {
        return Some(cwd.to_string());
    }
    dirs::home_dir().map(|path| path.to_string_lossy().into_owned())
}

pub fn open_terminal(
    app: AppHandle,
    registry: &TerminalRegistry,
    cwd: String,
    profile: &ShellProfile,
    record: Option<Recording>,
    owner: Option<String>,
) -> Result<String, String> {
    let start = start_dir(&cwd);
    open_pty(
        app,
        registry,
        &profile.command,
        &profile.args,
        start.as_deref(),
        record,
        Origin {
            // The resolved directory rather than the argument, so a session opened with a blank
            // `cwd` lists as the home directory it actually started in instead of as nothing.
            cwd: start.clone().unwrap_or_default(),
            profile: profile.name.clone(),
            owner,
        },
    )
}

/// Any program, in a pty, registered as a terminal session.
///
/// Extracted from [`open_terminal`] so the Remote workspace can put `ssh` in a pty and get, for
/// free, everything a local shell already has: the `terminal:output` / `terminal:exit` events the
/// xterm pane listens to, and the write/resize/close commands that drive it. A remote session is
/// therefore not a second kind of terminal — it is the same kind, running a different program, and
/// the frontend needs no branch for it.
///
/// `cwd` is where the *local* process starts. It means something for a shell and nothing for
/// `ssh`, hence the `Option`.
pub fn open_pty(
    app: AppHandle,
    registry: &TerminalRegistry,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    record: Option<Recording>,
    origin: Origin,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    // `CommandBuilder` seeds the child's environment from *this process's* — which on a GUI app is
    // launchd's, and launchd sets no `TERM`. So every program that asks the terminfo database what
    // it is talking to got nothing: `clear` answered "TERM environment variable not set", and
    // `tput`, `less`, `vim` and anything else built on curses failed the same way.
    //
    // Set here rather than passed in by the caller because it is not a property of the *shell*, it
    // is a property of the emulator on the other end of the pty — xterm.js, in the panel — and that
    // is the same emulator whichever profile is running. `xterm-256color` is what it implements and
    // what every other host declares for it; `COLORTERM` is the out-of-band flag the 24-bit-colour
    // programs look for, since terminfo has no entry that means truecolor.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();

    // `dirty: true` from the start, so the seeded history reaches the database even if this shell
    // never prints anything — a terminal resumed and then left alone must not lose what it had.
    let transcript = record
        .map(|Recording { key, seed }| Arc::new(Mutex::new(Transcript { key, buf: seed, dirty: true })));

    // Copied out before the origin moves into the registry: the emitter thread stamps it on every
    // frame it sends, and it must go on being able to do so after the session is gone from the map.
    let emitter_owner = origin.owner.clone();

    {
        let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            TerminalSession {
                writer,
                master: pair.master,
                child,
                transcript: transcript.clone(),
                origin,
            },
        );
    }

    let outbox = Arc::new((Mutex::new(Outbox::default()), Condvar::new()));

    let reader_outbox = Arc::clone(&outbox);
    std::thread::spawn(move || {
        // 64 KB rather than 4 KB: a `read` returns as soon as *any* byte is available, so a lone
        // keystroke still comes back as one byte and echoes instantly, while a build that has
        // filled the pty's buffer comes back in one call instead of sixteen.
        let mut buf = [0u8; 64 * 1024];
        let (lock, ready) = &*reader_outbox;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    // Recorded before it is queued, and holding the lock for no longer than the
                    // append: a `poisoned` lock (a panic in the flush) must not take the terminal
                    // down with it, so the record is skipped and the output still reaches the pane.
                    if let Some(transcript) = &transcript {
                        if let Ok(mut recorded) = transcript.lock() {
                            recorded.push(&data);
                        }
                    }
                    lock_outbox(lock).pending.push_str(&data);
                    ready.notify_one();
                }
                Err(_) => break,
            }
        }
        lock_outbox(lock).closed = true;
        ready.notify_one();
    });

    let emitter_id = id.clone();
    let emitter_app = app;
    std::thread::spawn(move || {
        let (lock, ready) = &*outbox;
        // Far enough in the past that the very first byte of a session is emitted on sight rather
        // than held for a frame — a shell's prompt must not appear to arrive late.
        let mut last_flush = Instant::now() - FLUSH_INTERVAL;
        loop {
            let mut queued = lock_outbox(lock);
            // Parked, not polled: an idle terminal costs nothing at all, and an idle bench of six
            // shells costs six times nothing. The thread only wakes when there is output.
            while queued.pending.is_empty() && !queued.closed {
                queued = ready.wait(queued).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            // Empty and closed: the pty is gone and everything it printed has been sent.
            if queued.pending.is_empty() {
                break;
            }
            // Coalesce only when something was *just* sent. That is the whole trick: typing into a
            // shell flushes every keystroke on sight (nothing went out 16ms ago), while a build
            // firing continuously collects a frame's worth per event. The wait is bounded by the
            // frame either way, so output is never held longer than that — and the exit path below
            // cannot run until this buffer is empty, so nothing can be left behind.
            let since = last_flush.elapsed();
            if since < FLUSH_INTERVAL && queued.pending.len() < FLUSH_MAX_BYTES {
                queued = ready
                    .wait_timeout(queued, FLUSH_INTERVAL - since)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
            let data = std::mem::take(&mut queued.pending);
            drop(queued);
            last_flush = Instant::now();
            let _ = emitter_app.emit(
                "terminal:output",
                TerminalOutputEvent {
                    id: emitter_id.clone(),
                    data,
                    owner: emitter_owner.clone(),
                },
            );
        }
        // **Struck from the registry before the exit is announced**, and the ordering is the whole
        // point of doing it here rather than leaving it to whoever notices.
        //
        // Until this existed a naturally-exited shell stayed in the map forever: `close_terminal` is
        // the only thing that removed a row, so a session the user simply typed `exit` into leaked
        // its entry — and, worse, kept answering. A `write_terminal` to that id found a live
        // `TerminalSession`, wrote into a master fd whose child was gone, and returned `Ok`. Every
        // keystroke a phone sent to a dead shell therefore vanished silently and looked like a
        // network problem. Removing first means the next write says "no such terminal session",
        // which is both true and actionable.
        //
        // `try_state` rather than `state`: this thread outlives nothing in particular, and a panic
        // here would take the exit announcement with it.
        //
        // **The transcript is written down first.** `drain_transcripts` walks this same registry and
        // is the only path that persists a recorded session, on a four-second timer — so removing
        // the row here without flushing meant everything printed since the last tick was never
        // written. The shape that costs: a bench shell prints `BUILD SUCCESSFUL` and exits, all
        // within microseconds of the reader pushing those bytes into the `Transcript`, and the next
        // tick finds nothing to save. `resume_workspace_terminal` would then reseed from a truncated
        // record — losing exactly the tail somebody backgrounded the shell to collect, which is the
        // thing the `Transcript` doc comment says the feature exists to prevent. Remote sessions
        // carry no key and are unaffected; this is the desktop bench's guarantee.
        crate::commands::terminal_cmd::flush_transcripts(&emitter_app);
        if let Some(registry) = emitter_app.try_state::<TerminalRegistry>() {
            if let Ok(mut sessions) = registry.0.lock() {
                sessions.remove(&emitter_id);
            }
        }
        let _ = emitter_app.emit(
            "terminal:exit",
            TerminalExitEvent { id: emitter_id, owner: emitter_owner },
        );
    });

    Ok(id)
}

/// The outbox, poisoning ignored.
///
/// Unlike the transcript — where a poisoned lock means "skip the recording, keep the terminal
/// alive" — there is no skipping this one: a reader that gave up on the lock would silently stop
/// delivering output, and an emitter that gave up would never announce the exit. The guarded data
/// is a `String` and a `bool` with no invariant between them, so a panicking holder leaves nothing
/// half-updated to be careful about.
fn lock_outbox(lock: &Mutex<Outbox>) -> std::sync::MutexGuard<'_, Outbox> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn write_terminal(registry: &TerminalRegistry, id: &str, data: &str) -> Result<(), String> {
    let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(id).ok_or("no such terminal session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resize_terminal(registry: &TerminalRegistry, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = registry.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(id).ok_or("no such terminal session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn close_terminal(registry: &TerminalRegistry, id: &str) -> Result<(), String> {
    let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Every recorded session's output that has changed since the last call, as `(row id, transcript)`.
///
/// Takes the *whole* buffer rather than the tail appended since last time, and that is deliberate:
/// the buffer is capped, so it can shrink from the front as well as grow at the end, and an
/// append-only writer would have to reason about how much of what it wrote is still there. Writing
/// the current state whole is one `UPDATE` per changed session and cannot drift.
///
/// Clears the dirty flags as it goes, so a bench of idle shells costs the flush nothing.
pub fn drain_transcripts(registry: &TerminalRegistry) -> Vec<(String, String)> {
    let Ok(sessions) = registry.0.lock() else { return Vec::new() };
    let mut changed = Vec::new();
    for session in sessions.values() {
        let Some(transcript) = &session.transcript else { continue };
        let Ok(mut recorded) = transcript.lock() else { continue };
        // A recording with no row is a phone's session: there is nothing to write it *to*, and
        // clearing the dirty flag for it would be a lie the bench never reads anyway. Skipped
        // before the flag rather than after, so the in-memory buffer stays the live one.
        let Some(key) = recorded.key.clone() else { continue };
        if !recorded.dirty {
            continue;
        }
        recorded.dirty = false;
        changed.push((key, recorded.buf.clone()));
    }
    changed
}

/// What one live session has printed, for a client that is attaching to it rather than opening it.
///
/// The reason a remote session is recorded at all. A phone's browser tab is evicted the moment it
/// goes into the background on a device under memory pressure, and a wifi handover costs the socket
/// — in both cases the shell is still running and still printing, and reattaching to it without this
/// would show a blank screen with a cursor in it, which is indistinguishable from a broken terminal.
///
/// `None` for a session that is not recorded (the desktop dock, an `ssh` pane) and for one that no
/// longer exists, which are the same answer to the only caller: there is nothing to replay.
pub fn transcript_of(registry: &TerminalRegistry, id: &str) -> Option<String> {
    let sessions = registry.0.lock().ok()?;
    let transcript = sessions.get(id)?.transcript.as_ref()?;
    let recorded = transcript.lock().ok()?;
    Some(recorded.buf.clone())
}

/// Who opened session `id`, or `None` when there is no such session.
///
/// Two nested `Option`s because the two answers are genuinely different and the caller acts on the
/// difference: an unknown id must fall through to the command itself (so a write to a shell that has
/// exited reads as the failure it is), while a known id with somebody else's owner is a refusal. See
/// `remotectl::dispatch`.
#[allow(clippy::option_option)]
pub fn owner_of(registry: &TerminalRegistry, id: &str) -> Option<Option<String>> {
    let sessions = registry.0.lock().ok()?;
    Some(sessions.get(id)?.origin.owner.clone())
}

/// Every session a device opened, or — with `owner: None` — every session *any* device opened.
///
/// The second form is what the settings panel draws: shells a phone left running on this machine,
/// which nothing on the desktop would otherwise show. Sessions opened at the desk are never in
/// either list; they belong to the dock and the bench, which draw their own.
pub fn list_owned(registry: &TerminalRegistry, owner: Option<&str>) -> Vec<TerminalInfo> {
    let Ok(sessions) = registry.0.lock() else { return Vec::new() };
    sessions
        .iter()
        .filter(|(_, session)| match (&session.origin.owner, owner) {
            (Some(held), Some(wanted)) => held == wanted,
            (Some(_), None) => true,
            (None, _) => false,
        })
        .map(|(id, session)| TerminalInfo {
            id: id.clone(),
            cwd: session.origin.cwd.clone(),
            profile: session.origin.profile.clone(),
            owner: session.origin.owner.clone(),
        })
        .collect()
}

/// Kills every shell one device opened, and reports how many were running.
///
/// The counterpart to [`close_recorded`], keyed on the owner rather than on stored rows, and the
/// answer to the question a phone cannot answer for itself: a device that is revoked, that has its
/// shell access withdrawn, or that simply walks out of wifi range leaves live processes behind with
/// nothing on either side still able to reach them. The desktop has no tab for them and the phone
/// has no token, so without this a `cargo watch` started from a pocket runs until the app is quit.
///
/// Deliberately *not* called the moment a socket drops — see `remotectl::DeviceConnection`, where
/// the grace window lives. A phone locking its screen disconnects constantly, and killing a build
/// because somebody put their phone down would be the same class of bug as an effect cleanup doing
/// it.
pub fn close_owned(registry: &TerminalRegistry, owner: &str) -> usize {
    let Ok(mut sessions) = registry.0.lock() else { return 0 };
    let doomed: Vec<String> = sessions
        .iter()
        .filter(|(_, session)| session.origin.owner.as_deref() == Some(owner))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &doomed {
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
        }
    }
    doomed.len()
}

/// Kills every shell opened by *any* device. The switch being turned off, and the server being
/// stopped: both mean "no phone drives this machine any more", and a shell nobody can reach is not
/// a shell anybody meant to keep.
pub fn close_all_owned(registry: &TerminalRegistry) -> usize {
    let owners: Vec<String> = {
        let Ok(sessions) = registry.0.lock() else { return 0 };
        let mut owners: Vec<String> = sessions
            .values()
            .filter_map(|session| session.origin.owner.clone())
            .collect();
        owners.sort();
        owners.dedup();
        owners
    };
    owners.iter().map(|owner| close_owned(registry, owner)).sum()
}

/// Every live recording, keyed by `workspace_terminals` row: its pty session id and what it has
/// printed *so far*.
///
/// The bench asks this on the way in, and needs both halves. The session id is how reopening
/// **reattaches** to a shell that has been running behind a closed panel rather than starting a
/// second one beside it. The buffer is why the answer must come from here and not from the
/// database: the flush runs on a four-second timer, so the stored copy trails the live one, and a
/// panel that replayed the stored copy over a still-running session would open with a visible hole
/// in it — the last few seconds missing, then the live stream resuming mid-sentence.
///
/// A row absent from this map has no shell: the app restarted, or its shell exited. Its stored
/// transcript is then the whole truth, and there is nothing more recent to miss.
pub fn recorded_state(registry: &TerminalRegistry) -> HashMap<String, (String, String)> {
    let Ok(sessions) = registry.0.lock() else { return HashMap::new() };
    let mut found = HashMap::new();
    for (id, session) in sessions.iter() {
        let Some(transcript) = &session.transcript else { continue };
        let Ok(recorded) = transcript.lock() else { continue };
        // Only the bench's own recordings are keyed by a row, and this map *is* the bench's lookup.
        // A phone's in-memory recording has no row to be found under.
        let Some(key) = recorded.key.clone() else { continue };
        found.insert(key, (id.clone(), recorded.buf.clone()));
    }
    found
}

/// Kills every shell recording into one of `keys`, and reports how many were actually running.
///
/// By row id rather than by session id because that is what the caller has: "delete this bench"
/// starts from the stored rows, and some of them may have no live shell at all — a bench restored
/// from the database and never reopened is exactly that.
pub fn close_recorded(registry: &TerminalRegistry, keys: &[String]) -> usize {
    let Ok(mut sessions) = registry.0.lock() else { return 0 };
    let doomed: Vec<String> = sessions
        .iter()
        .filter(|(_, session)| {
            session
                .transcript
                .as_ref()
                .and_then(|t| {
                    t.lock()
                        .ok()
                        .map(|recorded| recorded.key.as_ref().is_some_and(|key| keys.contains(key)))
                })
                .unwrap_or(false)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in &doomed {
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
        }
    }
    doomed.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript() -> Transcript {
        Transcript { key: Some("row".into()), buf: String::new(), dirty: false }
    }

    /// The ordinary case: output accumulates, and appending marks the row for the next flush.
    #[test]
    fn output_accumulates_and_marks_the_row_dirty() {
        let mut recorded = transcript();
        recorded.push("$ cargo build\n");
        recorded.push("   Compiling codeflow\n");
        assert_eq!(recorded.buf, "$ cargo build\n   Compiling codeflow\n");
        assert!(recorded.dirty);
    }

    /// Past the cap, the *front* goes — and it goes to a line boundary, so the replay never opens
    /// halfway through an escape sequence.
    #[test]
    fn the_cap_is_enforced_at_a_line_boundary() {
        let mut recorded = transcript();
        let line = "x".repeat(1023);
        for _ in 0..300 {
            recorded.push(&format!("{line}\n"));
        }
        assert!(recorded.buf.len() <= TRANSCRIPT_LIMIT, "kept {} bytes", recorded.buf.len());
        assert!(recorded.buf.starts_with('x'), "the survivor starts at a line, not mid-line");
        assert!(recorded.buf.ends_with('\n'));
    }

    /// One line longer than the whole allowance — a progress bar rewriting itself, a minified
    /// bundle echoed by mistake. There is no line boundary to cut at, so the buffer starts over
    /// rather than keeping a fragment of it.
    #[test]
    fn a_single_line_longer_than_the_cap_does_not_grow_forever() {
        let mut recorded = transcript();
        recorded.push(&"y".repeat(TRANSCRIPT_LIMIT * 2));
        assert!(recorded.buf.is_empty());
        recorded.push("back to normal\n");
        assert_eq!(recorded.buf, "back to normal\n");
    }
}
