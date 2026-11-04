//! The team runner: what makes a team run move whichever window is open, or none.
//!
//! # Why it lives here
//!
//! Until now the main window drove every team run: `teamStore.pump` claimed items and ran each turn
//! through `agentsStore.runTurn`, and every other window returned early (`isMainWindow`). So a run
//! started from an Agents island never started, an abort from an island left its turns spending, a
//! reload of the main window stranded items as «running», and the session token of a reused
//! conversation lived only in that window's memory. The turn itself already runs in this process
//! (`send_chat_message`), so the only thing the webview contributed was the loop — and the loop is
//! what moves here.
//!
//! Every change to a run goes through `team_cmd::changed`, which emits `team:changed` and calls
//! [`kick`]. A kick claims whatever is ready (`team_cmd::claim_run`), runs headless items here
//! under the [governor](governor), and hands terminal items to the main window, which owns the
//! terminal bench. Windows only watch (`team:changed`, `runner:turn`) and send orders.

pub mod governor;

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::team_cmd::{self, Dispatch};
use crate::db::{queries, Db};

#[derive(Default)]
struct State {
    /// Runs with a pump in flight, and those that were kicked again meanwhile.
    pumping: HashSet<String>,
    again: HashSet<String>,
    /// Turn run id (`ai_runs`) of every headless item in flight, by item id, with its team run.
    turns: HashMap<String, (String, String)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the windows hear about a turn the runner started or finished, so the status bar and the
/// run's view can show it live — the same thing `aiRunStore.start` did when the window ran it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TurnEvent<'a> {
    phase: &'a str,
    run_id: &'a str,
    team_run_id: &'a str,
    item_id: &'a str,
    task_id: &'a str,
    workspace_id: &'a str,
    project_id: &'a str,
    title: &'a str,
    ok: bool,
    error: &'a str,
}

/// Moves a run: claims what is ready and starts it. Cheap and idempotent — a run that is not
/// `running` claims nothing — so every change to a run calls it.
pub fn kick(app: &AppHandle, run_id: &str) {
    {
        let mut s = state();
        if s.pumping.contains(run_id) {
            s.again.insert(run_id.to_string());
            return;
        }
        s.pumping.insert(run_id.to_string());
    }
    let app = app.clone();
    let run_id = run_id.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            pump_once(&app, &run_id).await;
            let mut s = state();
            if s.again.remove(&run_id) {
                continue;
            }
            s.pumping.remove(&run_id);
            break;
        }
    });
}

async fn pump_once(app: &AppHandle, run_id: &str) {
    let limit = {
        let db = app.state::<Db>();
        governor::free_slots(db.inner())
    };
    if limit == 0 {
        return;
    }
    let dispatches = {
        let db = app.state::<Db>();
        team_cmd::claim_run(db.inner(), run_id, Some(limit)).await
    };
    let dispatches = match dispatches {
        Ok(d) => d,
        Err(error) => {
            eprintln!("runner: claim of {run_id} failed: {error}");
            return;
        }
    };
    if dispatches.is_empty() {
        return;
    }
    let _ = app.emit("team:changed", serde_json::json!({ "runId": run_id }));
    for dispatch in dispatches {
        if dispatch.run_in == "terminal" {
            // The bench lives in the main window, hidden or not; it opens the CLI and `cf done`
            // settles the item from there.
            let _ = app.emit_to("main", "team:terminal-dispatch", serde_json::json!({ "runId": run_id, "dispatch": &dispatch }));
            continue;
        }
        let app = app.clone();
        let run_id = run_id.to_string();
        tauri::async_runtime::spawn(async move { run_headless(app, run_id, dispatch).await });
    }
}

/// The engine's resume token of a conversation's last turn, read from its history rather than a
/// window's memory — which lost it on every reload and after five tasks.
fn last_engine_session(conn: &rusqlite::Connection, project_id: &str, conversation_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT engine_session_id FROM activity_log
         WHERE project_id = ?1 AND session_id = ?2 AND engine_session_id IS NOT NULL AND engine_session_id <> ''
         ORDER BY created_at DESC LIMIT 1",
        rusqlite::params![project_id, conversation_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Runs `f` on the database connection; `None` if the lock is poisoned.
fn with_conn<T>(app: &AppHandle, f: impl FnOnce(&rusqlite::Connection) -> T) -> Option<T> {
    let db = app.state::<Db>();
    let guard = db.0.lock().ok()?;
    let out = f(&guard);
    drop(guard);
    Some(out)
}

async fn run_headless(app: AppHandle, team_run_id: String, dispatch: Dispatch) {
    let item_id = dispatch.item.id.clone();
    let Some(task) = dispatch.task.clone() else {
        settle(&app, &team_run_id, &item_id, "error", "", "el ítem no tiene tarea").await;
        return;
    };
    let _permit = governor::acquire(&app, &dispatch.model).await;
    let turn_id = format!("team-{}", uuid::Uuid::new_v4());
    state().turns.insert(item_id.clone(), (turn_id.clone(), team_run_id.clone()));
    let emit = |phase: &str, ok: bool, error: &str| {
        let _ = app.emit(
            "runner:turn",
            TurnEvent {
                phase,
                run_id: &turn_id,
                team_run_id: &team_run_id,
                item_id: &item_id,
                task_id: &task.id,
                workspace_id: &task.workspace_id,
                project_id: &task.project_id,
                title: &dispatch.title,
                ok,
                error,
            },
        );
    };
    emit("start", true, "");
    let session = with_conn(&app, |c| last_engine_session(c, &task.project_id, &task.conversation_id)).flatten();
    with_conn(&app, |c| queries::update_agent_task_run(c, &task.id, "running", &task.model, task.turns, ""));
    let reply = crate::commands::claude_cmd::send_chat_message(
        app.clone(),
        app.state::<Db>(),
        task.project_id.clone(),
        dispatch.message.clone(),
        session,
        Some(task.conversation_id.clone()),
        Some(turn_id.clone()),
        Some(dispatch.provider.clone()),
        Some(if dispatch.model.is_empty() { task.model.clone() } else { dispatch.model.clone() }),
        Some(task.prompt.clone()),
        task.account_id.clone(),
        None,
        None,
        None,
        Some(dispatch.effort.clone()).filter(|e| !e.is_empty()),
        Some(false),
        None,
    )
    .await;
    state().turns.remove(&item_id);
    match reply {
        Ok(reply) => {
            let model = reply.model.clone().unwrap_or_else(|| task.model.clone());
            with_conn(&app, |c| queries::update_agent_task_run(c, &task.id, "idle", &model, task.turns + 1, ""));
            emit("end", true, "");
            settle(&app, &team_run_id, &item_id, "ok", &reply.text, "").await;
        }
        Err(error) => {
            let cancelled = error.contains(crate::ai_runs::CANCELLED_MARKER);
            let busy = error.contains(crate::ai_locks::BUSY_MARKER);
            let status = if cancelled { "cancelled" } else if busy { "idle" } else { "error" };
            let last_error = if busy || cancelled { "" } else { error.as_str() };
            with_conn(&app, |c| queries::update_agent_task_run(c, &task.id, status, &task.model, task.turns, last_error));
            emit("end", false, &error);
            if busy {
                // The conversation or the repository is taken for a moment: hand the attempt back
                // and come again shortly rather than spinning.
                settle(&app, &team_run_id, &item_id, "busy", "", &error).await;
                tokio::time::sleep(Duration::from_secs(4)).await;
                kick(&app, &team_run_id);
            } else if cancelled {
                settle(&app, &team_run_id, &item_id, "cancelled", "", "").await;
            } else {
                settle(&app, &team_run_id, &item_id, "error", "", &error).await;
            }
        }
    }
}

async fn settle(app: &AppHandle, team_run_id: &str, item_id: &str, outcome: &str, text: &str, error: &str) {
    let db = app.state::<Db>();
    if let Err(e) = team_cmd::settle_item(app, db.inner(), item_id, outcome, text, error).await {
        eprintln!("runner: settling {item_id} of {team_run_id} failed: {e}");
    }
}

/// Stops every turn of a run that is in flight — what an abort or a delete has to do from any
/// window, which only the window that started a turn could do before.
pub fn cancel_run(team_run_id: &str) -> usize {
    let turns: Vec<String> = state().turns.values().filter(|(_, run)| run == team_run_id).map(|(turn, _)| turn.clone()).collect();
    turns.iter().filter(|turn| crate::ai_runs::cancel(turn)).count()
}

/// Stops one item's turn, if it is in flight here.
pub fn cancel_item(item_id: &str) -> bool {
    let turn = state().turns.get(item_id).map(|(turn, _)| turn.clone());
    turn.map(|t| crate::ai_runs::cancel(&t)).unwrap_or(false)
}

/// How many headless turns the runner has in flight, for the resource meter.
pub fn in_flight() -> usize {
    state().turns.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_session_is_read_from_history() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        conn.execute(
            "INSERT INTO activity_log (id, project_id, session_id, engine_session_id, question, answer, created_at, response_time_ms, is_error)
             VALUES ('a', 'p', 'agent-1', 'S1', 'q', 'a', '2026-01-01T00:00:00Z', 1, 0),
                    ('b', 'p', 'agent-1', 'S2', 'q', 'a', '2026-01-02T00:00:00Z', 1, 0),
                    ('c', 'p', 'agent-2', 'X', 'q', 'a', '2026-01-03T00:00:00Z', 1, 0)",
            [],
        )
        .unwrap();
        assert_eq!(last_engine_session(&conn, "p", "agent-1").as_deref(), Some("S2"));
        assert_eq!(last_engine_session(&conn, "p", "agent-9"), None);
    }
}
