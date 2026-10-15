//! What the threads that read a microphone or the computer's audio (`dictation::capture`,
//! `meetings::recorder`) share about keeping a cpal stream alive — and quiet in the log.
//!
//! **COM on Windows.** cpal initialises COM on whatever thread first touches WASAPI, asking for a
//! single-threaded apartment and shrugging off `RPC_E_CHANGED_MODE` when the thread already is in
//! the multithreaded one. Its default devices are activated with `ActivateAudioInterfaceAsync`,
//! which fails with that very `RPC_E_CHANGED_MODE` ("cannot change thread mode after it is set")
//! on such a single-threaded thread — every open of the microphone and of the system audio did, on
//! a user's Windows machine. So every capture thread is one this app spawns itself (never a Tauri
//! command thread, a tokio worker or the main thread, which WebView2 and the dialogs make STA) and
//! enters the multithreaded apartment ([`enter_mta`]) before anything of cpal runs on it; and
//! should a thread still meet the clash, the default device is opened again by its concrete id
//! ([`concrete`]), which goes through `IMMDevice::Activate` and works in either apartment.
//!
//! **Not every stream error ends the stream.** cpal reports a glitch — a buffer under- or overrun
//! (`Xrun`, which WASAPI loopback raises whenever playback resumes after silence), the route moving
//! under a default device, a refused real-time priority — through the same callback as a device
//! that went away. Only the latter is worth reopening ([`is_fatal`]); reopening on a glitch made a
//! fresh stream that glitched in turn, once a second for a whole meeting, and nothing was recorded.
//! Reopening backs off ([`Backoff`]) and repeated lines are rate-limited ([`LogGate`]).

use std::time::{Duration, Instant};

/// Puts the calling thread in COM's multithreaded apartment, before cpal asks for a
/// single-threaded one (which it then tolerates being refused). Call first thing on a thread of
/// our own. Never balanced with `CoUninitialize`: cpal's device enumerator is a process-wide
/// static and must outlive the thread that happened to create it. A no-op off Windows.
pub fn enter_mta() {
    #[cfg(windows)]
    // SAFETY: plain COM initialisation of the current thread.
    unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        let result = CoInitializeEx(None, COINIT_MULTITHREADED);
        if result.is_err() {
            // RPC_E_CHANGED_MODE: something made this thread single-threaded first. The open still
            // gets its fallback (`concrete`).
            crate::applog::warn(&format!("audio: COM on {:?}: {}", std::thread::current().name(), windows::core::Error::from(result)));
        }
    }
}

/// `RPC_E_CHANGED_MODE` (0x80010106) in an error's text — cpal prints it as the signed OS error.
pub fn is_apartment_clash(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("-2147417850") || lower.contains("0x80010106") || lower.contains("rpc_e_changed_mode")
}

/// The device a default handle points at right now, by its id: on Windows a default handle is
/// activated asynchronously (the call that clashes with a single-threaded apartment), a concrete
/// one is not. `None` when there is no such device or its id cannot be read.
pub fn concrete(host: &cpal::Host, device: &cpal::Device) -> Option<cpal::Device> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let id = device.id().ok()?;
    host.device_by_id(&id)
}

/// Whether a stream error means the stream is gone and has to be opened again. A glitch is not:
/// the stream keeps running and the audio keeps coming.
pub fn is_fatal(kind: cpal::ErrorKind) -> bool {
    !matches!(kind, cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied)
}

/// Waits between attempts to reopen: `first`, doubled each time, never more than `cap`.
#[derive(Debug, Clone)]
pub struct Backoff {
    first: Duration,
    cap: Duration,
    attempts: u32,
}

impl Backoff {
    pub fn new(first: Duration, cap: Duration) -> Self {
        Backoff { first, cap, attempts: 0 }
    }

    /// The wait before the next attempt.
    pub fn next_wait(&mut self) -> Duration {
        let wait = self.first.saturating_mul(1u32 << self.attempts.min(16)).min(self.cap);
        self.attempts = self.attempts.saturating_add(1);
        wait
    }

    /// Back to `first`: the stream ran long enough to call the device healthy again.
    pub fn reset(&mut self) {
        self.attempts = 0;
    }
}

/// Lets a repeated log line through at most once per `every`, counting what it held back.
#[derive(Debug, Clone)]
pub struct LogGate {
    every: Duration,
    last: Option<Instant>,
    held: u64,
}

impl LogGate {
    pub fn new(every: Duration) -> Self {
        LogGate { every, last: None, held: 0 }
    }

    /// `Some(n)` when a line may be written now — `n` lines were held back since the last one —
    /// `None` when this one is held back.
    pub fn allow(&mut self, now: Instant) -> Option<u64> {
        if self.last.is_some_and(|last| now.saturating_duration_since(last) < self.every) {
            self.held += 1;
            return None;
        }
        self.last = Some(now);
        Some(std::mem::take(&mut self.held))
    }
}

/// " (+n more)" for a line that stands for `held` others, "" for none.
pub fn more(held: u64) -> String {
    if held == 0 {
        String::new()
    } else {
        format!(" (+{held} more)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_lost_stream_is_fatal() {
        assert!(!is_fatal(cpal::ErrorKind::Xrun));
        assert!(!is_fatal(cpal::ErrorKind::DeviceChanged));
        assert!(!is_fatal(cpal::ErrorKind::RealtimeDenied));
        assert!(is_fatal(cpal::ErrorKind::DeviceNotAvailable));
        assert!(is_fatal(cpal::ErrorKind::StreamInvalidated));
        assert!(is_fatal(cpal::ErrorKind::BackendError));
        assert!(is_fatal(cpal::ErrorKind::Other));
    }

    #[test]
    fn an_under_or_overrun_from_cpal_is_a_glitch() {
        let error: cpal::Error = cpal::ErrorKind::Xrun.into();
        assert!(!is_fatal(error.kind()));
    }

    #[test]
    fn the_backoff_doubles_up_to_its_cap_and_resets() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        let waits: Vec<u64> = (0..8).map(|_| backoff.next_wait().as_secs()).collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 30, 30, 30]);
        for _ in 0..100 {
            backoff.next_wait();
        }
        assert_eq!(backoff.next_wait(), Duration::from_secs(30));
        backoff.reset();
        assert_eq!(backoff.next_wait(), Duration::from_secs(1));
    }

    #[test]
    fn the_gate_lets_one_line_through_per_period_and_counts_the_rest() {
        let mut gate = LogGate::new(Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(gate.allow(t0), Some(0));
        assert_eq!(gate.allow(t0 + Duration::from_secs(1)), None);
        assert_eq!(gate.allow(t0 + Duration::from_secs(59)), None);
        assert_eq!(gate.allow(t0 + Duration::from_secs(60)), Some(2));
        assert_eq!(gate.allow(t0 + Duration::from_secs(61)), None);
        assert_eq!(more(0), "");
        assert_eq!(more(3), " (+3 more)");
    }

    #[test]
    fn the_apartment_clash_is_recognised_as_cpal_prints_it() {
        assert!(is_apartment_clash(
            "Failed to get audio client: No se puede cambiar el modo de subproceso después de establecerlo (os error -2147417850)"
        ));
        assert!(is_apartment_clash("SYSTEM_AUDIO_DENIED: HRESULT 0x80010106"));
        assert!(!is_apartment_clash("MIC_DENIED"));
        assert!(!is_apartment_clash("Failed to get audio client (os error -2147024891)"));
    }
}
