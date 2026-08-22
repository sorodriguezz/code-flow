//! Inline code completion from a model running on this machine.
//!
//! # What this is not
//!
//! It is not [`crate::ai`]. That module drives *agents* — Claude Code, Codex, Cline, Gemini — which
//! read a repository, reason about it, and write a review or a patch over seconds to minutes. This
//! one has a single job with a single shape: given the code before the caret and the code after it,
//! produce the few tokens that go between, in under a fifth of a second, without leaving the
//! machine. Nothing here talks to a provider, spends a quota, or belongs to a workspace.
//!
//! # Two halves, and only one of them ships
//!
//! **The engine ships.** `llama-server` from llama.cpp lives in the app's resources next to the
//! Java runtime the IRIS driver uses, put there at build time by `scripts/build-llama-runtime.mjs`
//! exactly as `scripts/build-iris-runtime.mjs` puts the JRE there. Trimmed to the binary and its
//! own `@rpath` closure it is ~22 MB on macOS and ~37 MB on Windows — smaller than the 36 MB JRE
//! that is already in the bundle.
//!
//! **The weights do not.** They are gigabytes, most users will not want them, and a model is a
//! choice rather than a component — so [`catalogue`] describes what can be fetched and
//! [`download`] fetches it into `paths::models_dir()` when the user asks. That directory was
//! reserved for this before there was anything to put in it, and the reset plan already knows not
//! to delete it.
//!
//! # Lazy means the process
//!
//! Nothing in this module runs at startup. `llama-server` is not spawned when the app opens, not
//! when the setting is switched on, and not when a model finishes downloading — only when an
//! editor holding a real project file is actually in front of the user, and it is shut down again
//! after [`engine::IDLE_TIMEOUT`] with no requests. Measured on this hardware a 0.5B model is
//! serving in 540 ms and answers `/infill` in 173 ms, because llama.cpp mmaps the GGUF rather than
//! reading it — cold start is cheap enough that keeping the process alive "just in case" would be
//! the wrong trade for a gigabyte of resident memory.

pub mod catalogue;
pub mod complete;
pub mod download;
pub mod engine;
pub mod models;

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

/// The cancel channels for whatever this feature currently has in flight.
///
/// `.manage()`d in `lib.rs` beside `ApiRegistry`, `DbRegistry` and the rest, and shaped after
/// `ApiRegistry` on purpose — a reader who knows how a request is cancelled in the API client
/// knows how one is cancelled here.
///
/// The two halves are not symmetrical, and the asymmetry is the interesting part:
///
/// * **Downloads are a map.** Several can legitimately run at once — a user can start the 1.5B,
///   decide they want the 7B too, and leave both going — so each is cancelled by its own id.
/// * **A completion is a single slot.** Only the newest one can still be wanted: by the time the
///   answer to the previous keystroke arrives the caret has moved, and rendering it would put
///   ghost text where the user is not looking. So starting one *cancels* the one before it, which
///   is both the correct semantics and the reason this cannot leak entries the way a map would if
///   a request ended without anyone clearing its key.
#[derive(Default)]
pub struct LocalAiRegistry {
    downloads: Mutex<HashMap<String, oneshot::Sender<()>>>,
    completion: Mutex<Option<(String, oneshot::Sender<()>)>>,
}

impl LocalAiRegistry {
    pub fn register_download(&self, id: String) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.downloads.lock() {
            map.insert(id, tx);
        }
        rx
    }

    /// Fires the download's cancel channel. Safe on an id that is not running — a Cancel click can
    /// legitimately race a download that just finished.
    pub fn cancel_download(&self, id: &str) {
        if let Ok(mut map) = self.downloads.lock() {
            if let Some(tx) = map.remove(id) {
                let _ = tx.send(());
            }
        }
    }

    /// Drops the entry without firing it, for a download that ended on its own.
    ///
    /// Dropping rather than firing matters: [`cancelled`] reads a dropped sender as "nothing can
    /// cancel this any more" rather than as a cancellation, so a late `clear` cannot turn a
    /// finished download into a reported one.
    pub fn clear_download(&self, id: &str) {
        if let Ok(mut map) = self.downloads.lock() {
            map.remove(id);
        }
    }

    /// Claims the single completion slot, cancelling whatever was in it.
    pub fn begin_completion(&self, id: String) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut slot) = self.completion.lock() {
            if let Some((_, previous)) = slot.replace((id, tx)) {
                let _ = previous.send(());
            }
        }
        rx
    }

    /// Cancels the in-flight completion if it is still `id`.
    ///
    /// The id check is what keeps a late cancel for keystroke *n* from killing the request for
    /// keystroke *n+1* that has already replaced it.
    pub fn cancel_completion(&self, id: &str) {
        if let Ok(mut slot) = self.completion.lock() {
            if slot.as_ref().is_some_and(|(current, _)| current == id) {
                if let Some((_, tx)) = slot.take() {
                    let _ = tx.send(());
                }
            }
        }
    }

    /// Releases the slot if it is still `id`, without firing it.
    pub fn finish_completion(&self, id: &str) {
        if let Ok(mut slot) = self.completion.lock() {
            if slot.as_ref().is_some_and(|(current, _)| current == id) {
                slot.take();
            }
        }
    }
}

/// A future that resolves when the user cancels, and **never** resolves when they cannot.
///
/// Wrapping `oneshot::Receiver` rather than selecting on it directly, because the bare receiver has
/// a trap in it: once the sender is dropped without firing it resolves immediately, and it keeps
/// resolving immediately every time it is polled thereafter. Inside a `tokio::select!` that is a
/// silent, full-speed spin — the loop in [`download`] would stop reading from the socket and burn a
/// core instead.
///
/// A dropped sender means the registry entry was cleared and nothing can cancel this work any more,
/// so parking forever is the correct reading of it: finish the job. That is the same call
/// `crate::api::http` makes in the same situation, spelled once here instead of at each call site.
pub async fn cancelled(rx: tokio::sync::oneshot::Receiver<()>) {
    if rx.await.is_err() {
        std::future::pending::<()>().await;
    }
}
