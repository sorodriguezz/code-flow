//! The Service node's way into the Services supervisor (`crate::services`): the same start, stop and
//! restart the dock's buttons use, so a flow that brings an API up before testing it sees the same
//! readiness gate the person would — and leaves the same row in the dock.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::services::supervisor::{RuntimeView, Status, Supervisor};

fn view(state: &RuntimeView) -> Value {
    json!({
        "service": state.name,
        "id": state.id,
        "status": serde_json::to_value(state.status).unwrap_or(Value::Null),
        "alive": state.alive,
        "pid": state.pid,
        "ports": state.ports,
        "error": state.error,
        "exitCode": state.exit_code,
    })
}

fn find(supervisor: &Supervisor, id: &str) -> Option<RuntimeView> {
    supervisor.snapshot().into_iter().find(|state| state.id == id)
}

/// Does `action` to service `id` and answers with where it ended up. With `wait`, a start or a
/// restart returns once the service is ready (or has finished, for a one-shot) and fails when it
/// fails or the time runs out.
pub async fn act(app: &AppHandle, workspace_id: &str, id: &str, action: &str, wait: bool, timeout: Duration) -> Result<Value, String> {
    let supervisor = Supervisor::of(app);
    let ids = vec![id.to_string()];
    match action {
        "stop" => supervisor.stop(app, &ids).await,
        "restart" => supervisor.restart(app, workspace_id, &ids).await?,
        "status" => {}
        _ => supervisor.start(app, workspace_id, &ids)?,
    }
    if action == "stop" || action == "status" || !wait {
        return find(&supervisor, id).map(|state| view(&state)).ok_or_else(|| "No service with that id runs here".to_string());
    }
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(state) = find(&supervisor, id) {
            match state.status {
                Status::Ready | Status::Completed => return Ok(view(&state)),
                Status::Failed => {
                    return Err(format!(
                        "The service \"{}\" failed{}",
                        state.name,
                        state.error.as_deref().map(|e| format!(": {e}")).unwrap_or_default()
                    ))
                }
                _ => {}
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("The service was not ready after {} s", timeout.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}
