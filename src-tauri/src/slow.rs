//! What took long enough to be felt, written to the app log — so "it froze for a second" has an
//! answer in the log instead of a guess.
//!
//! Two places report here: the database lock ([`crate::db::DbMutex`]: how long a caller waited for
//! the connection, and how long it held it) and the IPC dispatcher (`lib.rs` `invoke_handler`: how
//! long a command kept the thread it was dispatched on, which for a sync command is the main
//! thread, i.e. the window). Only names, places and milliseconds: never arguments, rows or paths.
//!
//! Rate-limited per site, because a slow spot tends to be slow every time it runs and the log should
//! say so once a minute, not flood.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Waiting for the connection, or holding it, longer than this is worth a line.
pub const DB_THRESHOLD: Duration = Duration::from_millis(250);

/// A command that keeps its dispatching thread this long is a hitch the user can see.
pub const IPC_THRESHOLD: Duration = Duration::from_millis(150);

const QUIET_FOR: Duration = Duration::from_secs(60);

/// Writes `message` under `site` unless the same site wrote in the last minute; the lines skipped
/// meanwhile are counted into the next one.
pub fn report(site: String, message: impl FnOnce() -> String) {
    static LAST: Mutex<Option<HashMap<String, (Instant, u32)>>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let sites = last.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    let skipped = match sites.get_mut(&site) {
        Some((at, skipped)) if now.duration_since(*at) < QUIET_FOR => {
            *skipped += 1;
            return;
        }
        Some((at, skipped)) => {
            *at = now;
            std::mem::take(skipped)
        }
        None => {
            sites.insert(site, (now, 0));
            0
        }
    };
    drop(last);
    let tail = if skipped > 0 { format!(" (and {skipped} more since the last line)") } else { String::new() };
    crate::applog::warn(&format!("slow: {}{tail}", message()));
}

pub fn ms(d: Duration) -> u128 {
    d.as_millis()
}

/// The main thread not answering for this long is a freeze, whatever held it.
pub const MAIN_THREAD_THRESHOLD: Duration = Duration::from_millis(750);

/// Asks the main thread for a no-op once a second and writes how long the answer took when it is a
/// freeze. The IPC line above only sees a sync command; this sees anything that holds the thread the
/// window runs on — an event the webview is handed, a native dialog, a window call — and says
/// whether a freeze reported on Windows (user, 2026-11-02: the container tabs) was there at all, or
/// in the webview's own thread (`lib/diagnostics.ts`, long tasks).
pub fn watch_main_thread(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new().name("main-thread-watch".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let (tx, rx) = std::sync::mpsc::channel();
        let asked = Instant::now();
        if app.run_on_main_thread(move || {
            let _ = tx.send(());
        }).is_err() {
            return; // The event loop is gone: the app is closing.
        }
        // Waits for the answer however long it takes, so one freeze is one line with its length.
        if rx.recv().is_err() {
            return;
        }
        let took = asked.elapsed();
        if took > MAIN_THREAD_THRESHOLD {
            report("main thread".into(), || format!("main thread: did not answer for {} ms", ms(took)));
        }
    });
    if let Err(error) = spawned {
        crate::applog::warn(&format!("slow: the main-thread watch did not start — {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_reports_once_a_minute() {
        let site = format!("test-site-{}", uuid::Uuid::new_v4());
        let mut written = 0;
        for _ in 0..3 {
            report(site.clone(), || {
                written += 1;
                "x".to_string()
            });
        }
        assert_eq!(written, 1);
    }
}
