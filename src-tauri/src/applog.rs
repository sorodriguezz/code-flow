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

// ===================== what the webviews report =====================

/// How many frontend errors reach the file per [`FRONTEND_WINDOW`]. A render loop that throws on
/// every frame would otherwise write thousands of identical lines a second and rotate away the one
/// line worth reading — the first.
const FRONTEND_BUDGET: u32 = 30;
const FRONTEND_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
/// The same message again within this long is counted, not written.
const FRONTEND_REPEAT: std::time::Duration = std::time::Duration::from_secs(10);
/// Longest message and longest stack written for one error. A stack is useful for its first frames.
const MESSAGE_MAX: usize = 500;
const DETAIL_MAX: usize = 2000;

#[derive(Default)]
struct FrontendBudget {
    window_start: Option<std::time::Instant>,
    written: u32,
    dropped: u32,
    last: Option<(String, std::time::Instant)>,
}

impl FrontendBudget {
    /// Whether this message may be written now, and — when a window just ended with messages
    /// dropped — how many, so the log says so once instead of going quiet without a trace.
    fn admit(&mut self, key: &str, now: std::time::Instant) -> (bool, Option<u32>) {
        let mut dropped_report = None;
        match self.window_start {
            Some(start) if now.duration_since(start) < FRONTEND_WINDOW => {}
            _ => {
                if self.dropped > 0 {
                    dropped_report = Some(self.dropped);
                }
                self.window_start = Some(now);
                self.written = 0;
                self.dropped = 0;
            }
        }
        if let Some((last, at)) = &self.last {
            if last == key && now.duration_since(*at) < FRONTEND_REPEAT {
                self.dropped += 1;
                return (false, dropped_report);
            }
        }
        if self.written >= FRONTEND_BUDGET {
            self.dropped += 1;
            return (false, dropped_report);
        }
        self.written += 1;
        self.last = Some((key.to_string(), now));
        (true, dropped_report)
    }
}

static FRONTEND: OnceLock<Mutex<FrontendBudget>> = OnceLock::new();

/// Cuts `text` to at most `max` characters, on a character boundary, marking the cut.
fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// Takes the obvious secrets out of a line before it reaches the file.
///
/// An error message is written by whatever threw it, and some of those carry what they were given:
/// a clone URL with the token in it, an `Authorization` header in a failed request, a connection
/// string. The log is meant to be pasted into an issue, so it must not be the place those end up.
/// Deliberately broad — a false positive costs a `***` in a log line.
pub(crate) fn scrub(text: &str) -> String {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            // `https://user:token@host` — credentials in a URL.
            (r"(?i)([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@", "${1}***@"),
            // `Bearer abc…`, `Basic abc…`
            (r"(?i)\b(bearer|basic|token)\s+[a-z0-9._~+/=-]{8,}", "$1 ***"),
            // `password=…`, `api_key: …`, `"secret":"…"` and friends.
            (
                r#"(?i)\b(pass(word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|pat|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+"#,
                "$1$3***",
            ),
            // Provider token shapes that can appear on their own.
            (r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,})", "***"),
        ]
        .into_iter()
        .filter_map(|(pattern, replacement)| regex::Regex::new(pattern).ok().map(|re| (re, replacement)))
        .collect()
    });
    let mut out = text.to_string();
    for (re, replacement) in patterns {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// One line for one frontend error: scrubbed, cut to size, newlines folded so a stack stays one
/// entry in a line-oriented file.
fn frontend_line(window: &str, kind: &str, message: &str, detail: Option<&str>) -> String {
    let flat = |text: &str| text.split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" | ");
    let mut line = format!(
        "frontend[{window}] {}: {}",
        truncate(kind, 40),
        scrub(&truncate(&flat(message), MESSAGE_MAX))
    );
    if let Some(detail) = detail.filter(|d| !d.trim().is_empty()) {
        line.push_str(" — ");
        line.push_str(&scrub(&truncate(&flat(detail), DETAIL_MAX)));
    }
    line
}

/// A frontend error, into the same file as everything else.
///
/// Before this the webviews' errors went to `console.error` and nowhere else — a render that threw
/// on a user's machine left nothing in the log they could send. Called by the global `error` /
/// `unhandledrejection` handlers and by `ErrorBoundary` (see `lib/errorReporting.ts`). Rate-limited
/// and scrubbed here, where no caller can forget to.
#[tauri::command]
pub fn log_frontend_error(webview: tauri::Webview, kind: String, message: String, detail: Option<String>) {
    let budget = FRONTEND.get_or_init(|| Mutex::new(FrontendBudget::default()));
    let (admit, dropped) = {
        let mut state = budget.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        admit_key(&mut state, &kind, &message)
    };
    if let Some(n) = dropped {
        warn(&format!("frontend: {n} further error(s) not written (rate limit)"));
    }
    if admit {
        error(&frontend_line(webview.label(), &kind, &message, detail.as_deref()));
    }
}

fn admit_key(state: &mut FrontendBudget, kind: &str, message: &str) -> (bool, Option<u32>) {
    state.admit(&format!("{kind}\u{0}{message}"), std::time::Instant::now())
}

/// The last `n` lines of the log, read from the end of the file rather than all of it.
pub(crate) fn tail(n: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = crate::paths::logs_dir().join("codeflow.log");
    let Ok(mut file) = File::open(&path) else { return Vec::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    // Two hundred lines are rarely more than 40 KB; 256 KB leaves room for long ones.
    let from = len.saturating_sub(256 * 1024);
    if file.seek(SeekFrom::Start(from)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    // Started mid-file: the first line is probably a fragment.
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(n);
    lines[skip..].iter().map(|line| line.to_string()).collect()
}

/// What Settings › About shows, and the head of a copied diagnosis.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiagnostics {
    pub version: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub locale: Option<String>,
    pub state_dir: String,
    pub logs_dir: String,
}

#[tauri::command]
pub fn app_diagnostics(app: tauri::AppHandle) -> AppDiagnostics {
    AppDiagnostics {
        version: app.package_info().version.to_string(),
        os: tauri_plugin_os::type_().to_string(),
        os_version: tauri_plugin_os::version().to_string(),
        arch: tauri_plugin_os::arch().to_string(),
        locale: tauri_plugin_os::locale(),
        state_dir: crate::paths::state_dir().to_string_lossy().into_owned(),
        logs_dir: crate::paths::logs_dir().to_string_lossy().into_owned(),
    }
}

/// How many log lines a copied diagnosis carries.
const REPORT_LINES: usize = 200;

/// The text "Copy diagnostics" puts on the clipboard: the build and the machine, then the log's
/// last lines — scrubbed again on the way out, and with the home directory written as `~`, so what
/// gets pasted into a public issue names no account.
#[tauri::command]
pub fn diagnostics_report(app: tauri::AppHandle) -> String {
    let facts = app_diagnostics(app);
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    let private = |text: &str| {
        let text = scrub(text);
        match &home {
            Some(home) if !home.is_empty() => text.replace(home.as_str(), "~"),
            _ => text,
        }
    };
    let mut report = format!(
        "CodeFlow {}\n{} {} ({})\nlocale: {}\nstate: {}\n\n--- last {} log lines ---\n",
        facts.version,
        facts.os,
        facts.os_version,
        facts.arch,
        facts.locale.as_deref().unwrap_or("?"),
        private(&facts.state_dir),
        REPORT_LINES,
    );
    for line in tail(REPORT_LINES) {
        report.push_str(&private(&line));
        report.push('\n');
    }
    report
}

/// The third-party notices, compiled into the binary and shown in Settings › About.
///
/// MIT, Apache-2.0, MPL-2.0 and the OFL all ask for their notice to travel *with* the software.
/// A file in the repository travels with the source, not with the installer. `include_str!` puts
/// the generated `THIRD-PARTY-NOTICES.md` inside every build, so a copy goes wherever the app goes.
/// And a build whose notices file has gone missing fails to compile instead of shipping without it.
/// Regenerate with `pnpm notices`; CI's `notices:check` keeps it from going stale.
#[tauri::command]
pub fn third_party_notices() -> &'static str {
    include_str!("../../THIRD-PARTY-NOTICES.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The notices are the generated file itself, not a stub, and include the components with
    /// obligations of their own.
    #[test]
    fn the_third_party_notices_are_compiled_in() {
        let notices = third_party_notices();
        assert!(notices.starts_with("# Third-party notices"), "unexpected header");
        for component in ["libgit2", "noVNC", "draw.io"] {
            assert!(notices.contains(component), "{component} missing from the notices");
        }
    }

    /// What the log must never hold, whatever an error message carried in.
    #[test]
    fn secrets_are_scrubbed_before_they_are_written() {
        let line = scrub("clone failed: https://me:ghp_abcdefghijklmnopqrstuvwx@github.com/o/r.git");
        assert!(!line.contains("ghp_"), "{line}");
        assert!(line.contains("https://***@github.com/o/r.git"), "{line}");

        let header = scrub("Authorization: Bearer abc.def.ghi-123");
        assert!(!header.contains("abc.def"), "{header}");
        assert!(!scrub("request failed with password=hunter22&x=1").contains("hunter22"));
        assert!(!scrub(r#"{"api_key":"sk-live-1234567890abcdef"}"#).contains("1234567890"));
        assert!(!scrub("token glpat-abcdefghijklmnop1234 was refused").contains("glpat-"));
        // Ordinary words survive.
        assert_eq!(scrub("TypeError: x is undefined"), "TypeError: x is undefined");
    }

    /// A render loop throwing every frame writes a budget's worth, then counts the rest once.
    #[test]
    fn a_burst_of_errors_is_budgeted_and_repeats_are_counted() {
        let mut budget = FrontendBudget::default();
        let start = std::time::Instant::now();
        // The same message twice in a row: the second is a repeat.
        assert_eq!(budget.admit("a", start), (true, None));
        assert_eq!(budget.admit("a", start), (false, None));
        // Distinct messages up to the budget.
        for i in 1..FRONTEND_BUDGET {
            assert!(budget.admit(&format!("m{i}"), start).0);
        }
        assert!(!budget.admit("over", start).0, "past the budget nothing is written");
        // The next window says how many were dropped, once.
        let later = start + FRONTEND_WINDOW;
        assert_eq!(budget.admit("fresh", later), (true, Some(2)));
        assert_eq!(budget.admit("fresh2", later), (true, None));
    }

    #[test]
    fn one_error_is_one_bounded_line() {
        let long = "x".repeat(MESSAGE_MAX + 50);
        let line = frontend_line("main", "error", &long, Some("at a\n  at b\n"));
        assert!(!line.contains('\n'));
        assert!(line.contains("at a | at b"));
        assert!(line.chars().count() < MESSAGE_MAX + 100);
        assert_eq!(truncate("héllo", 2), "hé…");
        assert_eq!(truncate("hi", 5), "hi");
    }

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
