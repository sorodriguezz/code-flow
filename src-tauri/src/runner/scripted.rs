//! A [`Host`] with a scripted engine, and what only it can prove: a run moved by the runner itself
//! — claim, slot, turn, settle, the next claim — with nobody at a window and no CLI behind it.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::governor::{self, Slots};
use super::host::{Host, Turn, TurnReply};
use super::{cancel_run_on, kick_on, wait_idle};
use crate::db::{queries, Db};
use crate::team::engine::tests::{fixture, led_team, Dir};
use crate::team::engine::{control, decide, start_run, RepoPick};
use crate::team::{self, Item, Policy, RunState};

/// What the scripted engine does with one turn.
enum Step {
    Reply(String),
    Fail(String),
    /// Never answers on its own: it ends when the turn is stopped.
    Hang,
}

type Script = dyn Fn(&Item, &Turn) -> Step + Send + Sync;

struct Inner {
    db: Db,
    slots: Slots,
    script: Box<Script>,
    /// Every turn that reached the engine, in order.
    turns: Mutex<Vec<Turn>>,
    events: Mutex<Vec<(String, serde_json::Value)>>,
}

#[derive(Clone)]
struct Scripted(Arc<Inner>);

impl Scripted {
    fn new(db: Db, script: impl Fn(&Item, &Turn) -> Step + Send + Sync + 'static) -> Self {
        Self(Arc::new(Inner { db, slots: Slots::default(), script: Box::new(script), turns: Mutex::default(), events: Mutex::default() }))
    }

    fn turns(&self) -> Vec<Turn> {
        self.0.turns.lock().unwrap().clone()
    }

    fn heard(&self, event: &str, phase: &str) -> usize {
        self.0.events.lock().unwrap().iter().filter(|(name, payload)| name == event && payload["phase"] == phase).count()
    }

    fn state(&self, run_id: &str) -> RunState {
        crate::team::engine::state_of(&self.0.db, run_id).unwrap()
    }

    /// Waits for the run to get somewhere, the way a window would: by looking.
    async fn until(&self, run_id: &str, what: &str, reached: impl Fn(&RunState) -> bool) -> RunState {
        for _ in 0..600 {
            let state = self.state(run_id);
            if reached(&state) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let state = self.state(run_id);
        panic!(
            "the run never got to «{what}»: status {} gate {:?} note {:?} items {:?}",
            state.run.status,
            state.run.gate,
            state.run.gate_note,
            state.items.iter().map(|i| format!("{}:{}:{}", i.key, i.kind, i.status)).collect::<Vec<_>>()
        );
    }
}

impl Host for Scripted {
    fn db(&self) -> &Db {
        &self.0.db
    }

    fn slots(&self) -> &Slots {
        &self.0.slots
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.0.events.lock().unwrap().push((event.to_string(), payload));
    }

    fn emit_to_main(&self, event: &str, payload: serde_json::Value) {
        self.emit(event, payload);
    }

    fn reserve(&self, _turn_id: &str) -> Option<Box<dyn std::any::Any + Send>> {
        None
    }

    fn stop(&self, _turn_id: &str) {}

    async fn turn(&self, turn: Turn) -> Result<TurnReply, String> {
        let item = {
            let conn = self.0.db.0.lock().unwrap();
            team::get_item(&conn, &turn.item_id).unwrap().unwrap()
        };
        self.0.turns.lock().unwrap().push(turn.clone());
        match (self.0.script)(&item, &turn) {
            Step::Reply(text) => Ok(TurnReply { text, model: Some("guion".into()) }),
            Step::Fail(error) => Err(error),
            Step::Hang => {
                turn.cancel.cancelled().await;
                Err(format!("{}detenido", crate::ai_runs::CANCELLED_MARKER))
            }
        }
    }
}

const PLAN: &str = "Reparto.\n```equipo\n{\"mensaje\":\"a y luego b\",\"items\":[\
    {\"id\":\"a\",\"miembro\":\"dev\",\"tarea\":\"crea a.txt\"},\
    {\"id\":\"b\",\"miembro\":\"dev\",\"tarea\":\"crea b.txt\",\"depende_de\":[\"a\"]}]}\n```";

/// A member that does what it is asked: the lead plans two tasks, the developer writes each file,
/// the lead closes.
fn diligent(item: &Item, turn: &Turn) -> Step {
    match item.kind.as_str() {
        "plan" => Step::Reply(PLAN.into()),
        "work" => {
            std::fs::write(Path::new(&turn.cwd).join(format!("{}.txt", item.key)), "x\n").unwrap();
            Step::Reply(format!("Hecho {}.", item.key))
        }
        "review" => Step::Reply("VERDICT: OK".into()),
        _ => Step::Reply("Completo.\n```equipo\n{\"terminar\":true}\n```".into()),
    }
}

async fn led_run(host: &Scripted, ws: &str, project: &str, lead: &str, dev: &str, policy: Policy) -> (String, String) {
    let tm = led_team(host.db(), ws, lead, dev, policy);
    let state = start_run(host.db(), ws.into(), tm.id.clone(), "Crea a y b".into(), None, vec![RepoPick { project_id: project.into(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    (state.run.id.clone(), state.repos[0].local_path.clone())
}

fn keep(_dir: &Dir) {}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_goes_from_its_first_claim_to_main_with_nobody_at_the_window() {
    let (_serial, dir, db, ws, project, [lead, dev, _qa]) = fixture();
    keep(&dir);
    let host = Scripted::new(db, diligent);
    let (run_id, repo) = led_run(&host, &ws, &project, &lead, &dev, Policy { single_pass: false, ..Default::default() }).await;

    // One kick is all it takes: the lead plans and the run stops for the plan's approval.
    kick_on(&host, &run_id);
    let state = host.until(&run_id, "plan gate", |s| s.run.gate == "plan").await;
    assert_eq!(host.turns().len(), 1, "only the lead has spoken");
    assert_eq!(state.items.iter().filter(|i| i.kind == "work").count(), 2);

    // Approved: a, then b on top of it, then the lead's last look — each claimed by the settle of
    // the one before, never by a window.
    decide(host.db(), &run_id, true, "").await.unwrap();
    kick_on(&host, &run_id);
    let state = host.until(&run_id, "merge gate", |s| s.run.gate == "merge").await;
    let order: Vec<String> = host.turns().iter().map(|t| state.items.iter().find(|i| i.id == t.item_id).map(|i| i.kind.clone()).unwrap_or_default()).collect();
    assert_eq!(order, vec!["plan", "work", "work", "final"]);
    let b = host.turns().into_iter().nth(2).unwrap();
    assert!(Path::new(&b.cwd).join("a.txt").exists(), "b starts from a's integrated work");
    assert!(state.items.iter().filter(|i| i.kind == "work").all(|i| i.merged && !i.commit_sha.is_empty()));
    assert_eq!((host.heard("runner:turn", "start"), host.heard("runner:turn", "end")), (4, 4), "every turn was announced and closed");
    assert_eq!((host.slots().running(), host.slots().waiting()), (0, 0), "no slot is left held");

    let state = decide(host.db(), &run_id, true, "").await.unwrap();
    assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
    assert!(Path::new(&repo).join("a.txt").exists() && Path::new(&repo).join("b.txt").exists(), "both files landed on main");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_that_fails_is_tried_again_by_the_runner_itself() {
    let (_serial, dir, db, ws, project, [lead, dev, _qa]) = fixture();
    keep(&dir);
    let tripped = std::sync::atomic::AtomicBool::new(false);
    let host = Scripted::new(db, move |item, turn| {
        if item.kind == "work" && item.key == "a" && !tripped.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Step::Fail("el motor se cayó".into());
        }
        diligent(item, turn)
    });
    let policy = Policy { single_pass: false, approve_plan: false, max_attempts: 2, ..Default::default() };
    let (run_id, _repo) = led_run(&host, &ws, &project, &lead, &dev, policy).await;
    kick_on(&host, &run_id);
    let state = host.until(&run_id, "merge gate", |s| s.run.gate == "merge").await;
    let a = state.items.iter().find(|i| i.key == "a").unwrap();
    assert_eq!((a.status.as_str(), a.attempts), ("done", 2), "the failed attempt counted, and the second one closed it");
    let turns_on_a = host.turns().iter().filter(|t| t.item_id == a.id).count();
    assert_eq!(turns_on_a, 2);
    assert_eq!(host.heard("runner:turn", "end"), host.turns().len());
}

#[tokio::test(flavor = "multi_thread")]
async fn aborting_stops_the_turn_that_runs_and_the_one_that_queues_before_any_folder_goes() {
    let (_serial, dir, db, ws, project, [lead, dev, _qa]) = fixture();
    keep(&dir);
    // Two parallel tasks on one model that admits a single turn: one runs, the other queues.
    {
        let conn = db.0.lock().unwrap();
        queries::set_setting(&conn, governor::SETTING_KEY, r#"{"max_turns":4,"per_model":{"sonnet":1}}"#).unwrap();
    }
    let host = Scripted::new(db, |item, _turn| match item.kind.as_str() {
        "plan" => Step::Reply(
            "Reparto.\n```equipo\n{\"items\":[{\"id\":\"a\",\"miembro\":\"dev\",\"tarea\":\"crea a.txt\"},{\"id\":\"b\",\"miembro\":\"dev\",\"tarea\":\"crea b.txt\"}]}\n```".into(),
        ),
        _ => Step::Hang,
    });
    let tm = {
        let member = |id: &str, agent: &str, name: &str, edits: bool| team::Member { id: id.into(), agent_id: agent.into(), name: name.into(), edits, max_parallel: 2, ..Default::default() };
        let conn = host.db().0.lock().unwrap();
        team::save_team(
            &conn,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy: Policy { single_pass: false, approve_plan: false, ..Default::default() },
                members: vec![member("l", &lead, "Líder", false), member("d", &dev, "Dev", true)],
                ..Default::default()
            },
        )
        .unwrap()
    };
    let state = start_run(host.db(), ws.clone(), tm.id.clone(), "Crea a y b".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();
    kick_on(&host, &run_id);
    let state = host
        .until(&run_id, "one running, one queued", |s| {
            let work: Vec<&Item> = s.items.iter().filter(|i| i.kind == "work" && i.status == "running").collect();
            work.len() == 2 && work.iter().any(|i| i.intelligence.phase == "running") && work.iter().any(|i| i.intelligence.phase == "queued")
        })
        .await;
    assert_eq!((host.slots().running(), host.slots().waiting()), (1, 1));
    let folders: Vec<String> = state.items.iter().filter(|i| i.kind == "work").map(|i| i.worktree_path.clone()).collect();
    assert!(folders.iter().all(|f| Path::new(f).exists()));

    // The abort returns only once both turns are over; nothing is deleted under a turn that runs.
    control(&host, &run_id, "abort").await.unwrap();
    assert!(wait_idle(&run_id, Duration::from_millis(10)).await, "nothing of the run is in flight any more");
    let state = host.state(&run_id);
    assert_eq!(state.run.status, "aborted");
    assert!(state.items.iter().filter(|i| i.kind == "work").all(|i| i.status == "cancelled"));
    assert_eq!(host.turns().len(), 2, "the lead and one developer turn: the queued one never reached the engine");
    assert_eq!((host.slots().running(), host.slots().waiting()), (0, 0));
    assert!(folders.iter().all(|f| !Path::new(f).exists()), "the folders went once nobody wrote into them");
    assert_eq!(cancel_run_on(&host, &run_id), 0, "nothing is left to stop");
}
