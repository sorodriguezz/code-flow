//! The question a quit asks before it throws unsaved work away.
//!
//! Every way the user ends the app — the tray's Quit, ⌘Q, the Quit button in Settings — went
//! straight to `AppHandle::exit`, and whatever was held only in a webview (the editor's unsaved
//! buffers, first of all) went down with the process. Nothing asked.
//!
//! # How it asks
//!
//! Those paths now say that a *person* is quitting ([`request_quit`]) before they call `exit`. The
//! request arrives as `RunEvent::ExitRequested`, where [`on_exit_requested`] holds it with
//! `prevent_exit` and emits [`QUIT_REQUESTED_EVENT`] to the main window. The frontend
//! (`lib/quitGuard.ts`) looks at what is unsaved — its own registry and every satellite's — and
//! either quits at once, when nothing is, or asks the user. The answer comes back as
//! [`quit_app_confirmed`] or [`quit_guard_cancel`]. Only the main window answers: it is the one
//! window that is always there, and a satellite's unsaved work reaches it over the window bus.
//!
//! # What it never holds
//!
//! - **Anything programmatic.** A restart — the updater's, the tray's Restart — arrives with
//!   `RESTART_EXIT_CODE`, which Tauri will not let anyone prevent anyway; `reset_app_data` approves
//!   its own exit; the single-instance handoff exits the *second* process before any of this
//!   exists. Only an exit [`request_quit`] announced is ever held, so an `app.exit` added somewhere
//!   else later is never blocked by accident.
//! - **A quit nobody can answer.** Until the main window says it is listening
//!   ([`quit_guard_arm`]), a quit goes straight through; and when it was asked and never even
//!   acknowledged — a wedged webview — the next quit after [`ACK_GRACE`] goes through too. The guard
//!   is there to protect work, not to become the reason the app cannot be closed.
//!
//! One path it cannot see: macOS ending the app itself — Quit from the Dock menu, logging out —
//! goes through `applicationWillTerminate`, which is past the point of asking. The editor's draft
//! journal is what covers that one.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::tray::QuittingFlag;

/// What the main window hears when a quit is waiting on it.
pub const QUIT_REQUESTED_EVENT: &str = "app:quit-requested";

/// How long the main window has to acknowledge the question before a second quit stops waiting for
/// it. Generous for an IPC round trip — the acknowledgement is sent before anything else is looked
/// at — and short enough that someone pressing ⌘Q at a frozen window is not stuck for long.
const ACK_GRACE: Duration = Duration::from_secs(3);

/// The guard's state, managed once per process.
#[derive(Default)]
pub struct QuitGuard(Mutex<GuardState>);

#[derive(Default)]
struct GuardState {
    /// The main window has said it answers [`QUIT_REQUESTED_EVENT`].
    armed: bool,
    /// The next exit is let through whatever else is true: the user answered, or the exit is one
    /// that must not be asked about.
    approved: bool,
    /// Set by [`request_quit`] and consumed by the next exit request — how an exit a person asked
    /// for is told apart from every other `app.exit`.
    user_quit: bool,
    /// A question the main window has been sent and not answered yet.
    pending: Option<Pending>,
}

struct Pending {
    since: Instant,
    acked: bool,
}

/// What to do with one `ExitRequested`.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// Let it through untouched — a restart, an approved quit, anything programmatic.
    Pass,
    /// A person's quit going ahead without a question, because nobody is there to ask. Finished the
    /// way a confirmed quit is (see [`finish`]).
    Finish,
    /// Hold it and ask the main window.
    Ask,
}

impl GuardState {
    fn decide(&mut self, code: Option<i32>, main_alive: bool, now: Instant) -> Verdict {
        if code == Some(tauri::RESTART_EXIT_CODE) || self.approved {
            return Verdict::Pass;
        }
        if !std::mem::take(&mut self.user_quit) {
            return Verdict::Pass;
        }
        if !self.armed || !main_alive {
            return Verdict::Finish;
        }
        match &self.pending {
            // Asked, never acknowledged, and long enough ago: the window is not going to answer.
            Some(pending) if !pending.acked && now.duration_since(pending.since) >= ACK_GRACE => {
                self.pending = None;
                Verdict::Finish
            }
            // Still being answered — asked again, which brings the open question forward rather
            // than stacking a second one.
            Some(_) => Verdict::Ask,
            None => {
                self.pending = Some(Pending { since: now, acked: false });
                Verdict::Ask
            }
        }
    }

    /// Announces a person's quit; `false` when one is already announced and not yet requested.
    fn note_user_quit(&mut self) -> bool {
        !std::mem::replace(&mut self.user_quit, true)
    }

    fn arm(&mut self, armed: bool) {
        self.armed = armed;
        // A window that (re)arms has just loaded: whatever it was asked before is gone with the
        // page that was asked.
        self.pending = None;
    }

    fn ack(&mut self) {
        if let Some(pending) = &mut self.pending {
            pending.acked = true;
        }
    }

    fn cancel(&mut self) {
        self.pending = None;
    }

    fn approve(&mut self) {
        self.approved = true;
        self.pending = None;
    }
}

impl QuitGuard {
    fn with<T>(&self, f: impl FnOnce(&mut GuardState) -> T) -> T {
        // A poisoned lock means a panic mid-update of a few booleans; the state is still usable,
        // and refusing to quit over it would be the worst possible answer.
        let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut state)
    }

    /// Lets the next exit through unasked — for exits that must never wait on a question.
    pub fn approve(&self) {
        self.with(GuardState::approve);
    }
}

/// A person asked to quit: announced, then requested. What the tray's Quit, the app menu's ⌘Q and
/// the `quit_app` command call instead of `app.exit(0)`.
///
/// **Once per announcement.** Tauri hands every menu event to every global menu listener, and on
/// macOS there are two — the tray's and the app menu's. Their Quit items used to share the id
/// `quit`, so one click arrived here twice; the tray's ids are prefixed now (`tray::tray_action`) and
/// each handler answers only for its own. The rule stays as the backstop: two exit requests would
/// spend the announcement on the first and let the second through unasked, which is the whole guard
/// gone, so a second call before the first was requested is dropped.
pub fn request_quit(app: &AppHandle) {
    if app.state::<QuitGuard>().with(GuardState::note_user_quit) {
        app.exit(0);
    }
}

/// The last steps of a quit that is really happening — what the quit paths used to do themselves
/// before calling `exit`: the closing backup (the session that just ended is the one a scheduled
/// backup is least likely to have caught), and the flag that stops the close handler from hiding the
/// window instead of letting it go.
fn finish(app: &AppHandle) {
    crate::backup::auto::flush_on_exit(app);
    app.state::<QuittingFlag>().mark_quitting();
}

/// `RunEvent::ExitRequested`, decided. Called from the run loop in `lib.rs`.
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    let main_alive = app.get_webview_window("main").is_some();
    let verdict = app
        .state::<QuitGuard>()
        .with(|state| state.decide(code, main_alive, Instant::now()));
    match verdict {
        Verdict::Pass => {}
        Verdict::Finish => finish(app),
        Verdict::Ask => {
            api.prevent_exit();
            let _ = app.emit_to("main", QUIT_REQUESTED_EVENT, ());
        }
    }
}

/// The main window saying it answers the question (`true`, once its listener is attached) or no
/// longer does (`false`, as it unloads).
#[tauri::command]
pub fn quit_guard_arm(app: AppHandle, armed: bool) {
    app.state::<QuitGuard>().with(|state| state.arm(armed));
}

/// The main window heard the question — sent before it looks at anything, so a window that is busy
/// working out what is unsaved is not mistaken for one that is frozen.
#[tauri::command]
pub fn quit_guard_ack(app: AppHandle) {
    app.state::<QuitGuard>().with(GuardState::ack);
}

/// The user chose to stay.
#[tauri::command]
pub fn quit_guard_cancel(app: AppHandle) {
    app.state::<QuitGuard>().with(GuardState::cancel);
}

/// The answer that ends the app: nothing was unsaved, or the user saved it or chose to lose it.
#[tauri::command]
pub fn quit_app_confirmed(app: AppHandle) {
    app.state::<QuitGuard>().approve();
    finish(&app);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed() -> GuardState {
        GuardState { armed: true, ..GuardState::default() }
    }

    /// Only a person's quit is ever held; everything else goes through as it always did.
    #[test]
    fn holds_only_the_quits_a_person_asked_for() {
        let now = Instant::now();
        let mut state = armed();
        // A programmatic exit — `reset_app_data`, anything added later — was never announced.
        assert_eq!(state.decide(Some(0), true, now), Verdict::Pass);
        // The last window closing.
        assert_eq!(state.decide(None, true, now), Verdict::Pass);
        // A restart, even right after a quit was announced: Tauri would not honour a hold anyway.
        state.note_user_quit();
        assert_eq!(state.decide(Some(tauri::RESTART_EXIT_CODE), true, now), Verdict::Pass);

        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, now), Verdict::Ask);
        // The announcement is spent by the request it announced.
        assert_eq!(state.decide(Some(0), true, now), Verdict::Pass);
    }

    /// Nobody to ask means no question: before the main window listens, or once it is gone.
    #[test]
    fn a_quit_with_nobody_to_ask_goes_through() {
        let now = Instant::now();
        let mut state = GuardState::default();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, now), Verdict::Finish);

        let mut state = armed();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), false, now), Verdict::Finish);
    }

    /// A window that answers keeps the question open however often ⌘Q is pressed; one that never
    /// even acknowledged it stops holding the app after the grace period.
    #[test]
    fn a_window_that_never_answers_stops_holding_the_quit() {
        let start = Instant::now();
        let mut state = armed();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start), Verdict::Ask);
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start + Duration::from_secs(1)), Verdict::Ask);
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start + ACK_GRACE), Verdict::Finish);

        let mut state = armed();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start), Verdict::Ask);
        state.ack();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start + ACK_GRACE * 10), Verdict::Ask);
    }

    /// The two answers: stay, which clears the question so the next quit asks afresh, and quit,
    /// which lets the exit through.
    #[test]
    fn the_answer_decides_the_next_exit() {
        let start = Instant::now();
        let mut state = armed();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start), Verdict::Ask);
        state.cancel();
        // Long after — a fresh question, not a stale one timing out.
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start + ACK_GRACE * 2), Verdict::Ask);

        state.approve();
        assert_eq!(state.decide(Some(0), true, start), Verdict::Pass);
    }

    /// One click on Quit reaches both of macOS's menu listeners. The second announcement, made before
    /// the first was requested, is not another request — or the second exit would pass unasked.
    #[test]
    fn one_quit_announced_twice_is_one_request() {
        let now = Instant::now();
        let mut state = armed();
        assert!(state.note_user_quit());
        assert!(!state.note_user_quit());
        assert_eq!(state.decide(Some(0), true, now), Verdict::Ask);
        // A later ⌘Q, while the question is up, is a request of its own again.
        assert!(state.note_user_quit());
        assert_eq!(state.decide(Some(0), true, now), Verdict::Ask);
    }

    /// A reloaded main window starts from nothing pending.
    #[test]
    fn rearming_forgets_a_question_the_old_page_was_asked() {
        let start = Instant::now();
        let mut state = armed();
        state.note_user_quit();
        assert_eq!(state.decide(Some(0), true, start), Verdict::Ask);
        state.arm(true);
        assert!(state.pending.is_none());
    }
}
