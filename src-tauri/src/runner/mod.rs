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
//! Every change to a run goes through `engine::changed`, which emits `team:changed` and calls
//! [`kick`]. A kick claims whatever is ready (`engine::claim_run`), runs headless items here
//! under the [governor](governor), and hands terminal items to the main window, which owns the
//! terminal bench. Windows only watch (`team:changed`, `runner:turn`) and send orders.
//!
//! # What it runs in
//!
//! Everything here takes a [`Host`] rather than the app: its database, its slots, how it tells the
//! windows and how it runs a turn. The app is one host ([`AppHost`]); the tests bring another with a
//! scripted engine ([`scripted`]) and drive whole runs through this same code — claim, slot, turn,
//! settle, the next claim — with no window and no CLI.

pub mod governor;
pub mod host;
#[cfg(test)]
mod scripted;

pub use host::{AppHost, Host, Turn};

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::db::queries;
use crate::team::engine::{self, Dispatch};

/// One headless dispatch from the moment it is claimed until its turn is over — queued for a slot
/// or running. Registered *before* the wait for a slot, so stopping a run reaches a turn that has
/// not started yet as surely as one that has.
struct Flight {
    team_run_id: String,
    dispatch_id: String,
    /// The turn's id in `ai_runs`: what stops the engine once it runs.
    turn_id: String,
    /// What stops the wait for a slot.
    cancel: CancellationToken,
}

/// The dispatches in flight, by item id. The app has one ([`FLIGHTS`]); a test makes its own.
#[derive(Default)]
pub struct Flights {
    map: Mutex<HashMap<String, Flight>>,
    landed: Notify,
}

impl Flights {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Flight>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a dispatch and returns what calls off its wait for a slot.
    pub fn take_off(&self, item_id: &str, team_run_id: &str, dispatch_id: &str, turn_id: &str) -> CancellationToken {
        let cancel = CancellationToken::new();
        self.map().insert(
            item_id.to_string(),
            Flight { team_run_id: team_run_id.to_string(), dispatch_id: dispatch_id.to_string(), turn_id: turn_id.to_string(), cancel: cancel.clone() },
        );
        cancel
    }

    /// The dispatch is over. Only the dispatch that registered removes itself: a late one must not
    /// take down the entry of the attempt that replaced it.
    pub fn land(&self, item_id: &str, dispatch_id: &str) {
        {
            let mut map = self.map();
            if map.get(item_id).is_some_and(|flight| flight.dispatch_id == dispatch_id) {
                map.remove(item_id);
            }
        }
        self.landed.notify_waiters();
    }

    /// Calls off every dispatch of a run: the queued ones stop waiting, and the turn ids of all of
    /// them come back for the engine to be told.
    pub fn cancel_run(&self, team_run_id: &str) -> Vec<String> {
        self.map()
            .values()
            .filter(|flight| flight.team_run_id == team_run_id)
            .map(|flight| {
                flight.cancel.cancel();
                flight.turn_id.clone()
            })
            .collect()
    }

    pub fn in_flight(&self, team_run_id: &str) -> usize {
        self.map().values().filter(|flight| flight.team_run_id == team_run_id).count()
    }

    /// Waits until nothing of the run is in flight, or `limit` passes. `true` when it emptied: its
    /// worktrees are nobody's any more and can go.
    pub async fn wait_idle(&self, team_run_id: &str, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let landed = self.landed.notified();
            if self.in_flight(team_run_id) == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, landed).await.is_err() {
                return self.in_flight(team_run_id) == 0;
            }
        }
    }
}

static FLIGHTS: LazyLock<Flights> = LazyLock::new(Flights::default);

#[derive(Default)]
struct State {
    /// Runs with a pump in flight, and those that were kicked again meanwhile.
    pumping: HashSet<String>,
    again: HashSet<String>,
    quota_wakes: HashMap<String, i64>,
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
    kick_on(&AppHost(app.clone()), run_id);
}

/// [`kick`] on any [`Host`].
pub fn kick_on<H: Host>(host: &H, run_id: &str) {
    {
        let mut s = state();
        if s.pumping.contains(run_id) {
            s.again.insert(run_id.to_string());
            return;
        }
        s.pumping.insert(run_id.to_string());
    }
    let host = host.clone();
    let run_id = run_id.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            pump_once(&host, &run_id).await;
            schedule_quota_wake(&host, &run_id);
            let mut s = state();
            if s.again.remove(&run_id) {
                continue;
            }
            s.pumping.remove(&run_id);
            break;
        }
    });
}

fn schedule_quota_wake<H: Host>(host: &H, run_id: &str) {
    let now = chrono::Utc::now().timestamp();
    let next = with_conn(host, |conn| {
        let run = crate::team::get_run(conn, run_id).ok().flatten()?;
        if run.status != "running" {
            return None;
        }
        crate::team::list_items(conn, run_id).ok()?.iter()
            .filter(|item| item.status == "waiting")
            .filter_map(|item| item.intelligence.recovery.as_ref()?.resume_at)
            .filter(|at| *at > now)
            .min()
    }).flatten();
    {
        let mut state = state();
        if state.quota_wakes.get(run_id).copied() == next {
            return;
        }
        state.quota_wakes.remove(run_id);
        if let Some(at) = next {
            state.quota_wakes.insert(run_id.to_string(), at);
        }
    }
    let Some(at) = next else { return };
    let host = host.clone();
    let run_id = run_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs((at - now) as u64)).await;
        let due = {
            let mut state = state();
            state.quota_wakes.get(&run_id) == Some(&at) && state.quota_wakes.remove(&run_id).is_some()
        };
        if due {
            kick_on(&host, &run_id);
        }
    });
}

async fn pump_once<H: Host>(host: &H, run_id: &str) {
    let limit = governor::free_slots(host.db(), host.slots());
    if limit == 0 {
        return;
    }
    let changed = || host.emit("team:changed", serde_json::json!({ "runId": run_id }));
    let dispatches = match engine::claim_run(host.db(), run_id, Some(limit)).await {
        Ok(d) => d,
        Err(error) => {
            // A claim that fails is the run not moving, and nobody watching a console: it stops
            // where the user sees it, with what went wrong.
            eprintln!("runner: claim of {run_id} failed: {error}");
            engine::engine_failure(host.db(), run_id, "", &format!("no se pudo repartir el trabajo: {error}"));
            changed();
            return;
        }
    };
    changed();
    for dispatch in dispatches {
        if dispatch.run_in == crate::collab::team::RUN_IN_REMOTE {
            // A seat someone else took: it goes out with the shared run's next round and settles
            // when their machine answers (`collab::team`).
            if let Err(error) = crate::collab::team::queue_offer(host.db(), run_id, &dispatch) {
                settle(host, run_id, &dispatch.item.id, &dispatch.item.intelligence.dispatch_id, "error", "", &format!("no se pudo entregar al puesto: {error}")).await;
            }
            continue;
        }
        if dispatch.run_in == "terminal" {
            // The bench lives in the main window, hidden or not; it opens the CLI and `cf done`
            // settles the item from there.
            host.emit_to_main("team:terminal-dispatch", serde_json::json!({ "runId": run_id, "dispatch": &dispatch }));
            continue;
        }
        // In flight from here, before the task that waits for a slot even starts: an abort that
        // lands in between still finds it.
        let turn_id = format!("team-{}", uuid::Uuid::new_v4());
        let cancel = FLIGHTS.take_off(&dispatch.item.id, run_id, &dispatch.item.intelligence.dispatch_id, &turn_id);
        let host = host.clone();
        let run_id = run_id.to_string();
        tauri::async_runtime::spawn(async move { run_headless(host, run_id, dispatch, turn_id, cancel).await });
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
fn with_conn<H: Host, T>(host: &H, f: impl FnOnce(&rusqlite::Connection) -> T) -> Option<T> {
    let guard = host.db().0.lock().ok()?;
    let out = f(&guard);
    drop(guard);
    Some(out)
}

async fn run_headless<H: Host>(host: H, team_run_id: String, dispatch: Dispatch, turn_id: String, cancel: CancellationToken) {
    let item_id = dispatch.item.id.clone();
    let dispatch_id = dispatch.item.intelligence.dispatch_id.clone();
    let Some(task) = dispatch.task.clone() else {
        FLIGHTS.land(&item_id, &dispatch_id);
        settle(&host, &team_run_id, &item_id, &dispatch_id, "error", "", "el ítem no tiene tarea").await;
        return;
    };
    // Reserved for the whole flight: a Stop that arrives while the turn prepares is kept, not lost.
    let _reservation = host.reserve(&turn_id);
    let Some(_permit) = governor::acquire_on(&host, &dispatch.model, &cancel).await else {
        // Called off while it queued: the turn never started and spent nothing.
        FLIGHTS.land(&item_id, &dispatch_id);
        settle(&host, &team_run_id, &item_id, &dispatch_id, "unstarted", "", "").await;
        return;
    };
    // The slot may have taken a while: the run could have been paused, aborted or re-planned, and
    // the item handed to another dispatch. Only the dispatch that is still the item's starts.
    if !engine::turn_started(host.db(), &item_id, &dispatch_id) || cancel.is_cancelled() {
        FLIGHTS.land(&item_id, &dispatch_id);
        settle(&host, &team_run_id, &item_id, &dispatch_id, "unstarted", "", "").await;
        return;
    }
    host.emit("team:changed", serde_json::json!({ "runId": team_run_id }));
    let emit = |phase: &str, ok: bool, error: &str| {
        let event = TurnEvent {
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
        };
        host.emit("runner:turn", serde_json::to_value(event).unwrap_or_default());
    };
    emit("start", true, "");
    let session = with_conn(&host, |c| last_engine_session(c, &task.project_id, &task.conversation_id)).flatten();
    let mut message = dispatch.message.clone();
    if dispatch.item.intelligence.substitute.is_some() && !dispatch.item.worktree_path.is_empty() {
        let cwd = dispatch.cwd.clone();
        let base = dispatch.item.intelligence.base_sha.clone();
        if let Ok(diff) = tokio::task::spawn_blocking(move || crate::team::gitops::handoff_diff(&cwd, &base)).await {
            if !diff.is_empty() {
                message.push_str("\n\n## Cambios del intento anterior\n");
                message.push_str(&diff);
            }
        }
    }
    with_conn(&host, |c| queries::update_agent_task_run(c, &task.id, "running", &task.model, task.turns, ""));
    // The run's per-turn ceiling (`Policy::turn_minutes`): past it the turn is stopped like a
    // cancel, but settled as a failed attempt — a cancel hands the attempt back, and a turn that
    // never finishes would then be retried forever.
    let limit = with_conn(&host, |c| crate::team::get_run(c, &team_run_id).ok().flatten().map(|run| run.policy.turn_minutes))
        .flatten()
        .unwrap_or(0);
    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watchdog = (limit > 0).then(|| {
        let flag = timed_out.clone();
        let turn = turn_id.clone();
        let (host, cancel) = (host.clone(), cancel.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(limit as u64 * 60)).await;
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            host.stop(&turn);
            cancel.cancel();
        })
    });
    let reply = host
        .turn(Turn {
            turn_id: turn_id.clone(),
            team_run_id: team_run_id.clone(),
            item_id: item_id.clone(),
            project_id: task.project_id.clone(),
            conversation_id: task.conversation_id.clone(),
            session,
            message,
            prompt: task.prompt.clone(),
            provider: dispatch.provider.clone(),
            model: if dispatch.model.is_empty() { task.model.clone() } else { dispatch.model.clone() },
            account_id: dispatch.account_id.clone(),
            effort: Some(dispatch.effort.clone()).filter(|e| !e.is_empty()),
            cwd: dispatch.cwd.clone(),
            cancel: cancel.clone(),
        })
        .await;
    if let Some(watchdog) = watchdog {
        watchdog.abort();
    }
    FLIGHTS.land(&item_id, &dispatch_id);
    let reply = if timed_out.load(std::sync::atomic::Ordering::SeqCst) {
        Err(format!("El turno superó {limit} minutos y se detuvo (límite por turno del equipo)."))
    } else {
        reply
    };
    match reply {
        Ok(reply) => {
            let model = reply.model.clone().unwrap_or_else(|| task.model.clone());
            with_conn(&host, |c| queries::update_agent_task_run(c, &task.id, "idle", &model, task.turns + 1, ""));
            emit("end", true, "");
            settle(&host, &team_run_id, &item_id, &dispatch_id, "ok", &reply.text, "").await;
        }
        Err(error) => {
            let cancelled = error.contains(crate::ai_runs::CANCELLED_MARKER);
            let busy = error.contains(crate::ai_locks::BUSY_MARKER);
            let status = if cancelled { "cancelled" } else if busy { "idle" } else { "error" };
            let last_error = if busy || cancelled { "" } else { error.as_str() };
            with_conn(&host, |c| queries::update_agent_task_run(c, &task.id, status, &task.model, task.turns, last_error));
            emit("end", false, &error);
            if busy {
                // The conversation or the repository is taken for a moment: hand the attempt back
                // and come again shortly rather than spinning.
                settle(&host, &team_run_id, &item_id, &dispatch_id, "busy", "", &error).await;
                tokio::time::sleep(Duration::from_secs(4)).await;
                kick_on(&host, &team_run_id);
            } else if cancelled {
                settle(&host, &team_run_id, &item_id, &dispatch_id, "cancelled", "", "").await;
            } else {
                settle(&host, &team_run_id, &item_id, &dispatch_id, "error", "", &error).await;
            }
        }
    }
}

async fn settle<H: Host>(host: &H, team_run_id: &str, item_id: &str, dispatch_id: &str, outcome: &str, text: &str, error: &str) {
    let changed = |run_id: &str| host.emit("team:changed", serde_json::json!({ "runId": run_id }));
    // The checks may take minutes: the windows hear that the turn is over and what runs now.
    match engine::settle_inner(host.db(), item_id, Some(dispatch_id), outcome, text, error, Some(&changed)).await {
        Ok(state) => {
            changed(&state.run.id);
            // Whatever closed may have made something ready.
            kick_on(host, &state.run.id);
        }
        Err(e) => {
            // The turn is over but the run does not know: left alone, the item would sit «running»
            // with nobody on it. It stops for the user instead, with the reason.
            eprintln!("runner: settling {item_id} of {team_run_id} failed: {e}");
            engine::engine_failure(host.db(), team_run_id, item_id, &format!("no se pudo registrar el resultado de un turno: {e}"));
            changed(team_run_id);
        }
    }
}

/// Stops every turn of a run that is in flight — queued for a slot or running — which is what an
/// abort or a delete has to do from any window. Returns how many there were.
pub fn cancel_run(team_run_id: &str) -> usize {
    let turns = FLIGHTS.cancel_run(team_run_id);
    for turn in &turns {
        crate::ai_runs::cancel(turn);
    }
    turns.len()
}

/// [`cancel_run`] through a [`Host`], which knows how its own engine is told to stop.
pub fn cancel_run_on<H: Host>(host: &H, team_run_id: &str) -> usize {
    let turns = FLIGHTS.cancel_run(team_run_id);
    for turn in &turns {
        host.stop(turn);
    }
    turns.len()
}

/// Waits until no turn of the run is in flight, up to `limit` — before its worktrees are removed,
/// so no agent is left writing into a folder that is being deleted. `false` when some turn is
/// still going: its folder stays.
pub async fn wait_idle(team_run_id: &str, limit: Duration) -> bool {
    FLIGHTS.wait_idle(team_run_id, limit).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopping_a_run_reaches_a_turn_that_is_still_queued() {
        let flights = Flights::default();
        let queued = flights.take_off("item-1", "run-1", "d1", "turn-1");
        let other = flights.take_off("item-2", "run-2", "d2", "turn-2");
        assert_eq!(flights.cancel_run("run-1"), vec!["turn-1".to_string()]);
        assert!(queued.is_cancelled(), "the queued turn of the stopped run is called off");
        assert!(!other.is_cancelled(), "another run's turn is left alone");
    }

    #[tokio::test]
    async fn a_run_is_idle_only_once_its_turns_have_landed() {
        let flights = std::sync::Arc::new(Flights::default());
        flights.take_off("item-1", "run-1", "d1", "turn-1");
        assert!(!flights.wait_idle("run-1", Duration::from_millis(20)).await, "a turn still going keeps the run busy");
        let waiter = {
            let flights = flights.clone();
            tokio::spawn(async move { flights.wait_idle("run-1", Duration::from_secs(5)).await })
        };
        tokio::task::yield_now().await;
        // A dispatch that is no longer the item's does not land it…
        flights.land("item-1", "stale");
        assert_eq!(flights.in_flight("run-1"), 1);
        // …the one that registered does.
        flights.land("item-1", "d1");
        assert!(waiter.await.unwrap());
    }

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
