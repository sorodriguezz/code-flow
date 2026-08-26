//! The application log: a plain text file under `paths::logs_dir()`.
//!
//! **Until v1.19 there wasn't one.** `logs_dir()` was created on every single launch and nothing in
//! the crate ever opened it — 92,000 lines of Rust and not one writer. That was survivable while
//! every failure had a window to report itself into, and it stopped being survivable the moment
//! this app started copying the user's database between directories at startup: a migration that
//! goes wrong on someone else's machine, before any window exists, leaves behind exactly nothing to
//! read. This file is the prerequisite for [`crate::migrate`], not a nicety beside it.
//!
//! Deliberately not a logging framework. `log` + `env_logger` (or `tracing`) would bring a facade,
//! a filter language and an initialisation order to get wrong, to serve a handful of call sites
//! that all want the same thing: append a line, never fail, never block for long. What is here is
//! the whole feature.
//!
//! Three properties it must have, in order of how badly it breaks things when missing:
//!
//! * **It never panics and never propagates.** Every function returns `()`. A logger that can take
//!   the process down converts a diagnosable failure into an undiagnosable one, which is the
//!   opposite of the job. Every I/O result here is deliberately discarded.
//! * **It is safe before the state root exists.** [`init`] is called ahead of the migration, which
//!   is the launch where the directory it writes into may be one this app has never created. It
//!   creates what it needs and, if it cannot, degrades to writing nothing rather than to failing.
//! * **It is bounded.** An append-only file on a desktop app that runs for months is a disk leak.
//!   See [`ROTATE_AT`].

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Rotate once the live file passes this, keeping exactly one previous generation
/// (`codeflow.log` → `codeflow.log.1`, overwriting whatever `.1` held).
///
/// 2 MB is roughly a week of ordinary use and comfortably more than any single startup or migration
/// writes, which is the span that has to survive intact: the whole point is that the user can be
/// asked for the log *after* the thing went wrong. One generation rather than five because the
/// failures this exists for are read within a day of happening; a log from three rotations ago
/// describes a version that is no longer installed.
const ROTATE_AT: u64 = 2 * 1024 * 1024;

struct Sink {
    file: Mutex<Option<File>>,
    path: PathBuf,
}

static SINK: OnceLock<Sink> = OnceLock::new();

/// Opens the log. Call once, from `run()`, before anything that might want to log — which today
/// means before the reset sweep and before the migration.
///
/// Idempotent and unfailing: called twice, the second call is ignored; unable to create the
/// directory or open the file, every later call becomes a no-op and the app proceeds. An app that
/// refused to start because it could not write its log would be a worse app than one that starts
/// without one.
pub fn init() {
    let path = crate::paths::logs_dir().join("codeflow.log");
    let file = open(&path);
    let _ = SINK.set(Sink { file: Mutex::new(file), path });

    // Written unconditionally so that every session in the file starts with something that
    // identifies the build and the layout. A support log whose first line is a stack trace with no
    // version above it costs a round trip to make sense of.
    info(&format!(
        "CodeFlow {} starting · state={} · cache={} · user={}",
        env!("CARGO_PKG_VERSION"),
        crate::paths::state_dir().to_string_lossy(),
        crate::paths::cache_dir().to_string_lossy(),
        crate::paths::user_dir().to_string_lossy(),
    ));

    // After the banner, so the log always carries the version above whatever comes next — and after
    // the caller has had its chance to read the *previous* session's marker.
    mark_running();
}

/// The marker whose *presence* at startup means the last session never got to shut down.
///
/// Written after the log opens and deleted on a clean exit, so a launch that finds it left over is
/// a launch after a crash, a force-quit or a power cut. Cheap enough to be unconditional — one
/// zero-byte file per session — and it is the only evidence that survives the kind of death that
/// leaves nothing in the log, because the process never reached a line it could write.
fn running_marker() -> PathBuf {
    crate::paths::state_dir().join("session-running")
}

/// Whether the previous session ended without saying goodbye. Call once, at startup, *before*
/// [`init`] has had a chance to write this session's own marker.
pub fn last_session_was_unclean() -> bool {
    running_marker().exists()
}

/// Records that this session is running. Idempotent.
fn mark_running() {
    let path = running_marker();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, b"");
}

/// Records a clean shutdown. Anything that does not reach this leaves the marker behind, which is
/// exactly the signal [`last_session_was_unclean`] reads on the next launch.
pub fn mark_clean_exit() {
    info("clean shutdown");
    let _ = std::fs::remove_file(running_marker());
}

fn open(path: &PathBuf) -> Option<File> {
    let dir = path.parent()?;
    std::fs::create_dir_all(dir).ok()?;
    OpenOptions::new().create(true).append(true).open(path).ok()
}

pub fn info(message: &str) {
    write("INFO ", message);
}

pub fn warn(message: &str) {
    write("WARN ", message);
}

/// Routes every panic into the log file before the default handler runs.
///
/// Panics unwind here rather than aborting — `Cargo.toml` says why, at length — so a panic on a
/// worker thread kills that thread and leaves the app running, and a panic inside a Tauri command
/// leaves the caller's promise hanging forever. Both are *invisible* without this: there is no
/// console on Windows and no window early enough to show one, so the single most useful piece of
/// evidence about a hang went nowhere at all.
///
/// The default hook is kept and chained rather than replaced: it is what prints to stderr under
/// `tauri dev`, and losing that would trade one blind spot for another.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // `payload_as_str` is still unstable, so the two shapes a panic payload actually takes are
        // matched by hand.
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let at = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>").to_string();
        error(&format!("panic on thread '{name}' at {at}: {payload}"));
        previous(info);
    }));
}

pub fn error(message: &str) {
    write("ERROR", message);
}

/// Appends one line, or silently does nothing.
///
/// `Local` rather than `Utc` for the timestamp, against the usual instinct. This log is read by one
/// person on one machine, correlating it with "it broke when I opened the app this morning"; a UTC
/// stamp makes them do arithmetic to answer the only question they have. The offset is printed too,
/// so a log pasted into an issue is still unambiguous.
///
/// A poisoned mutex is recovered from rather than propagated, the same way `terminal.rs` and
/// `secrets.rs` do: a thread that panicked while holding the log is not a reason for the next
/// thread to panic too, and unwinding is kept process-wide precisely so this is possible (see the
/// note on `panic = "abort"` in `Cargo.toml`).
fn write(level: &str, message: &str) {
    let Some(sink) = SINK.get() else { return };
    let mut guard = match sink.file.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(file) = guard.as_mut() else { return };

    if file.metadata().map(|m| m.len()).unwrap_or(0) >= ROTATE_AT {
        // Drop the handle before renaming: on Windows a file with an open handle cannot be renamed,
        // and a failed rotation that left the handle open would retry on every line from here on.
        *guard = None;
        let _ = std::fs::rename(&sink.path, sink.path.with_extension("log.1"));
        *guard = open(&sink.path);
        let Some(_) = guard.as_mut() else { return };
    }

    let Some(file) = guard.as_mut() else { return };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f%:z");
    let _ = writeln!(file, "{stamp}  {level}  {message}");
    let _ = file.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property everything else here is subordinate to: no call can fail, at any point in the
    /// lifecycle. Written as one test over the uninitialised state because that is the window that
    /// actually exists in `run()` — the reset sweep and the migration both run close enough to
    /// `init()` that an ordering mistake would put a call on the wrong side of it.
    #[test]
    fn logging_before_init_is_a_no_op_rather_than_a_panic() {
        // Deliberately does not call `init`: `SINK` is a process-wide `OnceLock` and this suite
        // runs in one process, so a test that initialised it would decide the outcome of every
        // other test in this module.
        info("before");
        warn("before");
        error("before");
    }

    /// Rotation replaces the live file and keeps exactly one generation. Exercised against a
    /// temporary sink rather than the real one for the reason above.
    #[test]
    fn rotation_keeps_one_generation_and_reopens() {
        let dir = std::env::temp_dir().join(format!("cf-applog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("codeflow.log");

        std::fs::write(&path, vec![b'x'; (ROTATE_AT + 1) as usize]).unwrap();
        let sink = Sink { file: Mutex::new(open(&path)), path: path.clone() };

        // The same sequence `write` performs, against a sink this test owns.
        {
            let mut guard = sink.file.lock().unwrap();
            *guard = None;
            std::fs::rename(&sink.path, sink.path.with_extension("log.1")).unwrap();
            *guard = open(&sink.path);
            writeln!(guard.as_mut().unwrap(), "after").unwrap();
        }

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
        assert_eq!(
            std::fs::metadata(dir.join("codeflow.log.1")).unwrap().len(),
            ROTATE_AT + 1,
            "the previous generation was not kept intact"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
