//! One chat asking another to continue: the `chat_send` tool.
//!
//! The turn is the target chat's own, visible where that chat lives: this module emits
//! [`DELEGATE_EVENT`], the window holding the conversation (its island, else the main window)
//! accepts it, sends it as an ordinary turn — on screen, stoppable, filed like any other — and
//! settles the request with the answer. The asking run waits for it.
//!
//! Three guards: a conversation that is itself answering a delegated turn cannot delegate again
//! (depth 1 — two chats cannot keep each other running), a chat cannot ask itself, and a chat that
//! is busy is refused rather than queued behind a turn nobody is watching for.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use super::refs::ChatRef;

pub const DELEGATE_EVENT: &str = "chat:delegate";
/// How long a window has to say it took the request.
pub const ACCEPT_WAIT: Duration = Duration::from_secs(20);
/// How long the delegated turn may take.
pub const ANSWER_WAIT: Duration = Duration::from_secs(600);

struct Pending {
    accepted: Option<oneshot::Sender<()>>,
    answered: Option<oneshot::Sender<Result<String, String>>>,
    #[cfg_attr(not(test), allow(dead_code))]
    target: String,
}

static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Conversations answering a delegated turn right now.
static DELEGATED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
/// Run id → (conversation, workspace): which chat a run is a turn of, so a tool call made by that
/// run knows who is asking. Filled by both chats around their engine run.
static RUNS: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Marks a run as a turn of `conversation` for as long as it is held.
pub struct RunMark(String);

impl Drop for RunMark {
    fn drop(&mut self) {
        if let Ok(mut runs) = RUNS.lock() {
            runs.remove(&self.0);
        }
    }
}

pub fn mark_run(run_id: &str, conversation_id: &str, workspace_id: &str) -> RunMark {
    if let Ok(mut runs) = RUNS.lock() {
        runs.insert(run_id.to_string(), (conversation_id.to_string(), workspace_id.to_string()));
    }
    RunMark(run_id.to_string())
}

/// `(conversation, workspace)` of a run, when it is a chat's turn.
pub fn conversation_of_run(run_id: &str) -> Option<(String, String)> {
    RUNS.lock().ok()?.get(run_id).cloned()
}

fn is_delegated(conversation_id: &str) -> bool {
    DELEGATED.lock().map(|set| set.contains(conversation_id)).unwrap_or(false)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateRequest {
    pub request_id: String,
    pub surface: String,
    pub conversation_id: String,
    pub project_id: Option<String>,
    pub workspace_id: String,
    /// What the target chat is sent, the asker's name already in front of it.
    pub message: String,
    pub from_id: String,
    pub from_title: String,
}

/// Whether the target's turn lease is free right now (taken and dropped at once).
fn target_free(target: &ChatRef) -> bool {
    let key = if target.surface == "panel" { format!("panel::{}", target.id) } else { target.id.clone() };
    crate::ai_locks::acquire_key(&key).is_some()
}

/// The checks before anything is emitted. Pure but for the two registries.
pub fn check(target: &ChatRef, from: &str) -> Result<(), String> {
    if target.surface == "chat" {
        return Err("chat_send solo escribe en chats de repositorio o de workspace; los del Chat se leen con chat_read".into());
    }
    if target.id == from {
        return Err("es esta misma conversación".into());
    }
    if is_delegated(from) {
        return Err("este turno lo pidió otro chat: un chat al que se le delegó no puede delegar a su vez".into());
    }
    if is_delegated(&target.id) {
        return Err(format!("«{}» ya está atendiendo otro pedido", target.title));
    }
    Ok(())
}

/// Asks `target` to answer `message` as a turn of its own and waits for that answer.
pub async fn request(app: &AppHandle, target: &ChatRef, message: &str, from_id: &str, from_title: &str) -> Result<String, String> {
    check(target, from_id)?;
    if !target_free(target) {
        return Err(format!("«{}» está respondiendo ahora mismo; prueba cuando termine", target.title));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let (accept_tx, accept_rx) = oneshot::channel();
    let (answer_tx, answer_rx) = oneshot::channel();
    {
        let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
        pending.insert(request_id.clone(), Pending { accepted: Some(accept_tx), answered: Some(answer_tx), target: target.id.clone() });
        DELEGATED.lock().map_err(|e| e.to_string())?.insert(target.id.clone());
    }
    let _cleanup = Cleanup(request_id.clone(), target.id.clone());
    let from_label = if from_title.trim().is_empty() { from_id.to_string() } else { from_title.trim().to_string() };
    let payload = DelegateRequest {
        request_id: request_id.clone(),
        surface: target.surface.clone(),
        conversation_id: target.id.clone(),
        project_id: target.project_id.clone(),
        workspace_id: target.workspace_id.clone(),
        message: format!("[Pedido desde el chat «{from_label}»]\n\n{}", message.trim()),
        from_id: from_id.to_string(),
        from_title: from_label,
    };
    app.emit(DELEGATE_EVENT, payload).map_err(|e| e.to_string())?;
    wait(accept_rx, answer_rx, ACCEPT_WAIT, ANSWER_WAIT, &target.title).await
}

/// The two waits, apart so the tests can drive them with short timeouts.
async fn wait(
    accept_rx: oneshot::Receiver<()>,
    answer_rx: oneshot::Receiver<Result<String, String>>,
    accept_for: Duration,
    answer_for: Duration,
    title: &str,
) -> Result<String, String> {
    match tokio::time::timeout(accept_for, accept_rx).await {
        Ok(Ok(())) => {}
        _ => return Err(format!("ninguna ventana abrió «{title}» para continuar; ¿está abierta la app?")),
    }
    match tokio::time::timeout(answer_for, answer_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("el pedido se perdió".into()),
        Err(_) => Err(format!("«{title}» no terminó a tiempo; su respuesta quedará en ese chat")),
    }
}

struct Cleanup(String, String);

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut pending) = PENDING.lock() {
            pending.remove(&self.0);
        }
        if let Ok(mut set) = DELEGATED.lock() {
            set.remove(&self.1);
        }
    }
}

/// A window took the request. `false` when another window already did, or it is gone.
pub fn accept(request_id: &str) -> bool {
    let Ok(mut pending) = PENDING.lock() else { return false };
    match pending.get_mut(request_id).and_then(|p| p.accepted.take()) {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

/// The delegated turn ended: its answer, or why it did not.
pub fn settle(request_id: &str, result: Result<String, String>) -> bool {
    let Ok(mut pending) = PENDING.lock() else { return false };
    match pending.get_mut(request_id).and_then(|p| p.answered.take()) {
        Some(tx) => tx.send(result).is_ok(),
        None => false,
    }
}

/// The conversation a pending request targets — for tests and diagnostics.
#[cfg(test)]
fn target_of(request_id: &str) -> Option<String> {
    PENDING.lock().ok()?.get(request_id).map(|p| p.target.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, surface: &str) -> ChatRef {
        ChatRef {
            id: id.into(),
            surface: surface.into(),
            title: id.into(),
            project_id: None,
            project_name: None,
            workspace_id: "w".into(),
            updated_at: String::new(),
            turns: 0,
        }
    }

    #[test]
    fn guards() {
        assert!(check(&chat("a", "ws"), "a").is_err());
        assert!(check(&chat("a", "chat"), "b").is_err());
        assert!(check(&chat("a", "panel"), "b").is_ok());
        DELEGATED.lock().unwrap().insert("busy-from".into());
        assert!(check(&chat("x", "ws"), "busy-from").unwrap_err().contains("no puede delegar"));
        assert!(check(&chat("busy-from", "ws"), "y").is_err());
        DELEGATED.lock().unwrap().remove("busy-from");
    }

    #[tokio::test]
    async fn settle_after_accept_returns_the_answer() {
        let id = "req-ok".to_string();
        let (atx, arx) = oneshot::channel();
        let (btx, brx) = oneshot::channel();
        PENDING.lock().unwrap().insert(id.clone(), Pending { accepted: Some(atx), answered: Some(btx), target: "t".into() });
        assert_eq!(target_of(&id).as_deref(), Some("t"));
        assert!(accept(&id));
        assert!(!accept(&id), "only one window takes it");
        assert!(settle(&id, Ok("hecho".into())));
        let got = wait(arx, brx, Duration::from_millis(50), Duration::from_millis(50), "t").await;
        assert_eq!(got.unwrap(), "hecho");
        PENDING.lock().unwrap().remove(&id);
    }

    #[tokio::test]
    async fn nobody_accepting_or_answering_times_out() {
        let (_atx, arx) = oneshot::channel::<()>();
        let (_btx, brx) = oneshot::channel::<Result<String, String>>();
        let got = wait(arx, brx, Duration::from_millis(10), Duration::from_millis(10), "t").await;
        assert!(got.unwrap_err().contains("ninguna ventana"));
        let (atx, arx) = oneshot::channel::<()>();
        let (_btx, brx) = oneshot::channel::<Result<String, String>>();
        atx.send(()).unwrap();
        let got = wait(arx, brx, Duration::from_millis(10), Duration::from_millis(10), "t").await;
        assert!(got.unwrap_err().contains("no terminó a tiempo"));
    }

    #[test]
    fn run_marks_are_scoped() {
        {
            let _mark = mark_run("run-1", "conv", "w");
            assert_eq!(conversation_of_run("run-1"), Some(("conv".into(), "w".into())));
        }
        assert_eq!(conversation_of_run("run-1"), None);
    }
}
