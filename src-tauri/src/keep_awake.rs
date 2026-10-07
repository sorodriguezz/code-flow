//! «Evitar que el equipo se suspenda» — Settings › General.
//!
//! A computer that goes to sleep stops everything CodeFlow runs: an AI turn halfway through its
//! answer, a flow waiting for its 03:00 schedule, a service. Locking the screen or turning the display
//! off does not — only sleep does — and a company laptop is often set to sleep after a few idle
//! minutes. This keeps the *system* awake and nothing else: the display still turns off and the
//! screen still locks, so it costs what an idle machine with its screen off costs.
//!
//! Three modes, stored as `keep_awake`: `off` (the default), `busy` — awake only while something is
//! at work: an AI run, a flow running or armed (a schedule cannot fire on a sleeping machine), a
//! service — and `always`, for as long as CodeFlow is open. A small loop re-reads the work every
//! [`TICK`] and takes or lets go of the hold; turning the option off lets go at once.
//!
//! What it uses:
//! - **macOS** — `NSProcessInfo.beginActivity(options: .userInitiated)`: no idle system sleep, and
//!   no App Nap either, which otherwise slows a hidden app's timers. The display may still sleep.
//! - **Windows** — a power request (`PowerCreateRequest`) with `SystemRequired`, plus
//!   `ExecutionRequired` so a laptop with Modern Standby does not pause the app when its screen goes
//!   off. An administrator's policy can refuse both; nothing here can override that.
//!
//! Neither can stop a laptop from sleeping when its lid is closed — the system decides that, and
//! says so in its own power settings. Both holds die with the process, so a crash leaves nothing on.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::{queries, Db};

/// The setting: `off`, `busy` or `always`.
pub const MODE_KEY: &str = "keep_awake";

/// How often `busy` looks at the work again. A run that starts between two looks is covered within
/// this; sleep needs minutes of idleness, so a few seconds of delay cost nothing.
const TICK: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Off,
    Busy,
    Always,
}

impl Mode {
    fn parse(raw: &str) -> Mode {
        match raw.trim() {
            "busy" => Mode::Busy,
            "always" => Mode::Always,
            _ => Mode::Off,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Busy => "busy",
            Mode::Always => "always",
        }
    }
    fn to_u8(self) -> u8 {
        match self {
            Mode::Off => 0,
            Mode::Busy => 1,
            Mode::Always => 2,
        }
    }
    fn from_u8(raw: u8) -> Mode {
        match raw {
            1 => Mode::Busy,
            2 => Mode::Always,
            _ => Mode::Off,
        }
    }
}

static MODE: AtomicU8 = AtomicU8::new(0);
static HOLD: Mutex<Option<platform::Hold>> = Mutex::new(None);

/// Something at work that keeps the machine awake in `busy` mode — a kind and how many.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    /// `ai`, `flowRuns`, `flowsArmed`, `services`.
    pub kind: &'static str,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    pub mode: &'static str,
    /// The system is being kept awake right now.
    pub holding: bool,
    /// This system has a way to do it (macOS, Windows).
    pub supported: bool,
    /// What is at work — what `busy` is keeping it awake for, or would.
    pub reasons: Vec<Reason>,
}

/// Reads the stored choice and starts the loop. Called once, from `setup`.
pub fn start(app: &AppHandle) {
    let stored = app
        .try_state::<Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| queries::get_setting(&conn, MODE_KEY).ok().flatten()));
    MODE.store(Mode::parse(stored.as_deref().unwrap_or("off")).to_u8(), Ordering::SeqCst);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            reconcile(&handle);
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Takes or lets go of the hold for the mode and the work there is now, and says what it found.
fn reconcile(app: &AppHandle) -> Vec<Reason> {
    let mode = Mode::from_u8(MODE.load(Ordering::SeqCst));
    let reasons = if mode == Mode::Off { Vec::new() } else { at_work(app) };
    let want = match mode {
        Mode::Off => false,
        Mode::Always => true,
        Mode::Busy => !reasons.is_empty(),
    };
    let Ok(mut hold) = HOLD.lock() else { return reasons };
    match (want, hold.is_some()) {
        (true, false) => {
            *hold = platform::acquire("CodeFlow: trabajo en curso (IA, flujos o servicios)");
            if hold.is_some() {
                crate::applog::info(&format!("keep awake: on ({})", mode.as_str()));
            }
        }
        (false, true) => {
            if let Some(taken) = hold.take() {
                platform::release(taken);
            }
            crate::applog::info("keep awake: off");
        }
        _ => {}
    }
    reasons
}

/// What is running that a sleeping machine would stop.
fn at_work(app: &AppHandle) -> Vec<Reason> {
    let ai = crate::ai_runs::active().len().max(crate::ai_runs::live_processes());
    let flow_runs = crate::flows::runs::active_ids(None).len();
    let flows_armed = crate::flows::triggers::armed_names().len();
    let services = app
        .try_state::<std::sync::Arc<crate::services::supervisor::Supervisor>>()
        .map(|supervisor| supervisor.snapshot().iter().filter(|service| service.alive).count())
        .unwrap_or(0);
    reasons_from(ai, flow_runs, flows_armed, services)
}

fn reasons_from(ai: usize, flow_runs: usize, flows_armed: usize, services: usize) -> Vec<Reason> {
    [("ai", ai), ("flowRuns", flow_runs), ("flowsArmed", flows_armed), ("services", services)]
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(kind, count)| Reason { kind, count })
        .collect()
}

fn status_now(app: &AppHandle) -> KeepAwakeStatus {
    let reasons = reconcile(app);
    let mode = Mode::from_u8(MODE.load(Ordering::SeqCst));
    KeepAwakeStatus {
        mode: mode.as_str(),
        holding: HOLD.lock().map(|hold| hold.is_some()).unwrap_or(false),
        supported: platform::SUPPORTED,
        // Shown even when off: "would keep it awake for…" is what makes the choice an informed one.
        reasons: if mode == Mode::Off { at_work(app) } else { reasons },
    }
}

#[tauri::command(async)]
pub fn keep_awake_status(app: AppHandle) -> KeepAwakeStatus {
    status_now(&app)
}

#[tauri::command(async)]
pub fn set_keep_awake(app: AppHandle, db: tauri::State<'_, Db>, mode: String) -> Result<KeepAwakeStatus, String> {
    let mode = Mode::parse(&mode);
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, MODE_KEY, mode.as_str()).map_err(|e| e.to_string())?;
    }
    MODE.store(mode.to_u8(), Ordering::SeqCst);
    Ok(status_now(&app))
}

/// Lets go before the process does — not needed for correctness (both holds die with the process),
/// but it keeps the log honest on a normal quit.
pub fn release_on_exit() {
    if let Ok(mut hold) = HOLD.lock() {
        if let Some(taken) = hold.take() {
            platform::release(taken);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    pub const SUPPORTED: bool = true;

    /// The activity token `beginActivity` hands back; ending it ends the hold.
    pub struct Hold(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: the token is an opaque object that is only ever handed back to `NSProcessInfo`, which
    // Apple documents as thread-safe; nothing reads or mutates it in between.
    unsafe impl Send for Hold {}

    pub fn acquire(reason: &str) -> Option<Hold> {
        // `UserInitiated` includes `IdleSystemSleepDisabled` and keeps App Nap away; it does not
        // include `IdleDisplaySleepDisabled`, so the screen still turns off and locks.
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, &NSString::from_str(reason));
        Some(Hold(token))
    }

    pub fn release(hold: Hold) {
        // SAFETY: the token came from `beginActivityWithOptions_reason` and is ended exactly once.
        unsafe { NSProcessInfo::processInfo().endActivity(&hold.0) };
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestExecutionRequired, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

    pub const SUPPORTED: bool = true;

    /// `POWER_REQUEST_CONTEXT_VERSION` (= `DIAGNOSTIC_REASON_VERSION`), which windows-sys does not export.
    const CONTEXT_VERSION: u32 = 0;

    pub struct Hold {
        handle: HANDLE,
        /// `ExecutionRequired` exists from Windows 8 and is refused on some editions — kept apart so
        /// only what was set is cleared.
        execution: bool,
        /// The reason the request was made with; Windows shows it in `powercfg /requests`.
        _reason: Vec<u16>,
    }

    // SAFETY: a power request handle is a kernel object handle, usable from any thread.
    unsafe impl Send for Hold {}

    pub fn acquire(reason: &str) -> Option<Hold> {
        let mut wide: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        let context = REASON_CONTEXT {
            Version: CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 { SimpleReasonString: wide.as_mut_ptr() },
        };
        // SAFETY: `context` and the string it points at outlive the call.
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: `handle` is the request just created.
        if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
            unsafe { CloseHandle(handle) };
            return None;
        }
        // Modern Standby suspends desktop apps once the screen is off; this keeps CodeFlow running.
        let execution = unsafe { PowerSetRequest(handle, PowerRequestExecutionRequired) } != 0;
        Some(Hold { handle, execution, _reason: wide })
    }

    pub fn release(hold: Hold) {
        // SAFETY: the handle is the one `acquire` created, cleared and closed exactly once.
        unsafe {
            PowerClearRequest(hold.handle, PowerRequestSystemRequired);
            if hold.execution {
                PowerClearRequest(hold.handle, PowerRequestExecutionRequired);
            }
            CloseHandle(hold.handle);
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub const SUPPORTED: bool = false;
    pub struct Hold;
    pub fn acquire(_reason: &str) -> Option<Hold> {
        None
    }
    pub fn release(_hold: Hold) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_mode_is_off() {
        assert_eq!(Mode::parse("busy"), Mode::Busy);
        assert_eq!(Mode::parse("always"), Mode::Always);
        assert_eq!(Mode::parse(""), Mode::Off);
        assert_eq!(Mode::parse("yes"), Mode::Off);
        for mode in [Mode::Off, Mode::Busy, Mode::Always] {
            assert_eq!(Mode::from_u8(mode.to_u8()), mode);
            assert_eq!(Mode::parse(mode.as_str()), mode);
        }
    }

    #[test]
    fn only_what_is_at_work_is_a_reason() {
        assert!(reasons_from(0, 0, 0, 0).is_empty());
        assert_eq!(
            reasons_from(2, 0, 3, 0),
            vec![Reason { kind: "ai", count: 2 }, Reason { kind: "flowsArmed", count: 3 }]
        );
    }

    /// The real hold on this machine: taken, seen by the system, let go. On macOS `pmset -g
    /// assertions` lists it while held; on Windows `powercfg /requests` (elevated) does.
    #[test]
    #[ignore = "takes a real power hold"]
    fn a_hold_can_be_taken_and_released() {
        let hold = platform::acquire("CodeFlow keep-awake test").expect("hold");
        #[cfg(target_os = "macos")]
        {
            let listed = |reason: &str| {
                let out = std::process::Command::new("/usr/bin/pmset").args(["-g", "assertions"]).output().expect("pmset");
                String::from_utf8_lossy(&out.stdout).contains(reason)
            };
            assert!(listed("CodeFlow keep-awake test"), "macOS does not list the hold");
            platform::release(hold);
            std::thread::sleep(Duration::from_millis(300));
            assert!(!listed("CodeFlow keep-awake test"), "the hold outlived its release");
        }
        #[cfg(not(target_os = "macos"))]
        platform::release(hold);
    }
}
