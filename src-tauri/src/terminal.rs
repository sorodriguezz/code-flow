use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
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

/// A bounded copy of what a session has printed, and which stored terminal it belongs to.
///
/// Kept here rather than on the frontend for the one reason that decides it: the pane is a React
/// component and this has to survive the pane being unmounted. Closing the bench is exactly the
/// case the feature exists for — the shells keep running, they keep printing, and whatever they
/// print while nothing is on screen is precisely the output somebody backgrounded them to collect.
struct Transcript {
    /// The `workspace_terminals` row this belongs to. Stable across restarts, unlike the pty
    /// session id, which is minted fresh every time a shell is opened.
    key: String,
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
    /// The `workspace_terminals` row. Stable across restarts, unlike the pty session id.
    pub key: String,
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
    /// `Some` only for the agent console's bench. The repository dock's terminals and the Remote
    /// workspace's `ssh` sessions are not recorded: neither has anywhere to be replayed into, and
    /// a remote session's output is somebody else's machine talking.
    transcript: Option<Arc<Mutex<Transcript>>>,
}

#[derive(Default)]
pub struct TerminalRegistry(Mutex<HashMap<String, TerminalSession>>);

#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitEvent {
    id: String,
}

/// Which shell to run is decided by [`crate::shell_profiles`]; this only turns the answer into a
/// pty command. Nothing here reaches for `$SHELL` or a hardcoded path any more.
/// `record` names the `workspace_terminals` row to record into, for a shell on the agent console's
/// bench; `None` for the repository dock, which keeps no history.
pub fn open_terminal(
    app: AppHandle,
    registry: &TerminalRegistry,
    cwd: String,
    profile: &ShellProfile,
    record: Option<Recording>,
) -> Result<String, String> {
    open_pty(app, registry, &profile.command, &profile.args, Some(&cwd), record)
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

    {
        let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            TerminalSession {
                writer,
                master: pair.master,
                child,
                transcript: transcript.clone(),
            },
        );
    }

    let reader_id = id.clone();
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    // Recorded before it is emitted, and holding the lock for no longer than the
                    // append: a `poisoned` lock (a panic in the flush) must not take the terminal
                    // down with it, so the record is skipped and the output still reaches the pane.
                    if let Some(transcript) = &transcript {
                        if let Ok(mut recorded) = transcript.lock() {
                            recorded.push(&data);
                        }
                    }
                    let _ = reader_app.emit(
                        "terminal:output",
                        TerminalOutputEvent {
                            id: reader_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = reader_app.emit("terminal:exit", TerminalExitEvent { id: reader_id });
    });

    Ok(id)
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
        if !recorded.dirty {
            continue;
        }
        recorded.dirty = false;
        changed.push((recorded.key.clone(), recorded.buf.clone()));
    }
    changed
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
        found.insert(recorded.key.clone(), (id.clone(), recorded.buf.clone()));
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
                .and_then(|t| t.lock().ok().map(|recorded| keys.contains(&recorded.key)))
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
        Transcript { key: "row".into(), buf: String::new(), dirty: false }
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
