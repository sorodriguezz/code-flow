//! What a run asks of the main window — the work that lives in its webview and nowhere else.
//!
//! **One implementation, in TypeScript, that must not get a second.** A saved request of the API
//! client is only ever built by `resolveRequest` (the API client's invariant: the backend is a
//! transport), and a schema is only ever written as DBML by `schemaToDbml` (one emitter, one answer
//! to how a `bit` column is spelled). A node that needs either asks: `flows:ask` goes to the main
//! window with an id, a kind and a payload, and the window answers with `flows_bridge_answer`.
//!
//! **Exactly one answer.** Only the main window runs flows and only it listens (`lib/flows/bridge.ts`),
//! so a question is answered once. One nobody answers in time — a webview that hung, a page that
//! never loaded — fails the node with a reason rather than holding the run forever; a run stopped
//! meanwhile tells the window (`flows:ask-cancel`), which drops what it was doing.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const ASK_EVENT: &str = "flows:ask";
pub const CANCEL_EVENT: &str = "flows:ask-cancel";

type Answer = Result<Value, String>;

static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<Answer>>>> = LazyLock::new(Default::default);

fn pending() -> std::sync::MutexGuard<'static, HashMap<String, oneshot::Sender<Answer>>> {
    PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Asks the main window for `kind` with `payload`, and waits — up to `timeout`, or until `cancel`.
pub async fn ask(app: &AppHandle, kind: &str, payload: Value, timeout: Duration, cancel: CancellationToken) -> Answer {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    pending().insert(id.clone(), sender);
    if let Err(error) = app.emit_to("main", ASK_EVENT, json!({"id": id, "kind": kind, "payload": payload})) {
        pending().remove(&id);
        return Err(format!("CodeFlow's window could not be asked: {error}"));
    }
    let answer = tokio::select! {
        answer = receiver => answer.unwrap_or_else(|_| Err("CodeFlow's window dropped the question".to_string())),
        _ = tokio::time::sleep(timeout) => Err(format!("CodeFlow's window did not answer in {} s", timeout.as_secs())),
        _ = cancel.cancelled() => Err(crate::ai_runs::CANCELLED_MARKER.to_string()),
    };
    if pending().remove(&id).is_some() {
        // Not answered: whatever the window started for it is no longer wanted.
        let _ = app.emit_to("main", CANCEL_EVENT, json!({"id": id}));
    }
    answer
}

/// The window's answer to the question `id` — `false` when nobody is waiting for it any more.
pub fn answer(id: &str, result: Answer) -> bool {
    match pending().remove(id) {
        Some(sender) => sender.send(result).is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_reaches_the_question_once() {
        let (sender, mut receiver) = oneshot::channel();
        pending().insert("q1".into(), sender);
        assert!(answer("q1", Ok(json!({"dbml": "Table a {}"}))));
        assert!(!answer("q1", Ok(json!(1))), "a second answer finds nobody waiting");
        assert_eq!(receiver.try_recv().unwrap().unwrap()["dbml"], "Table a {}");
        assert!(!answer("never-asked", Err("x".into())));
    }
}
