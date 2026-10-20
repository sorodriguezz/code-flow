//! Settings › Local AI › Learning, the training half — see `crate::learning`.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::watch;

use crate::db::Db;
use crate::learning::{self, datasets, env, evaluation, serving, trainer, Base, LearningEvent, Mode, Worker};

/// The key that remembers the base the supervised mode trains.
const KEY_BASE: &str = "learning_base";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRow {
    #[serde(flatten)]
    pub base: Base,
    pub downloaded: bool,
    /// `None`: never tried here. A base that is not `proven` is validated by its first run.
    pub validated: Option<bool>,
    pub fits: bool,
    /// Its GGUF (what a PEFT adapter is served over) is downloaded under Local model.
    pub gguf_installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub mode: Mode,
    pub base: Option<String>,
    pub env: env::EnvStatus,
    pub env_busy: bool,
    pub bases: Vec<BaseRow>,
    /// Approved examples a dataset would take now (workspaces that allow training).
    pub usable_examples: usize,
    pub meaningful: usize,
    pub datasets: Vec<datasets::DatasetRow>,
    pub runs: Vec<trainer::RunRow>,
    pub adapters: Vec<trainer::AdapterRow>,
    pub running: Option<String>,
    pub evaluating: Option<String>,
    /// Training is refused while the system is critically short of memory.
    pub memory_critical: bool,
    /// The battery's charge when unplugged: training drains it fast.
    pub on_battery: Option<f64>,
}

static ENV_BUSY: Mutex<bool> = Mutex::new(false);
static EVALUATING: Mutex<Option<(String, watch::Sender<bool>)>> = Mutex::new(None);

fn evaluating() -> Option<String> {
    EVALUATING.lock().ok().and_then(|slot| slot.as_ref().map(|(id, _)| id.clone()))
}

#[tauri::command]
pub async fn learning_overview(db: State<'_, Db>) -> Result<Overview, String> {
    let machine = crate::hybrid::hardware::machine().await;
    let env = env::status(&machine).await;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mode = Mode::from_setting(crate::db::queries::get_setting(&conn, learning::KEY_MODE).ok().flatten().as_deref());
    let base = crate::db::queries::get_setting(&conn, KEY_BASE).ok().flatten();
    let bases = learning::BASES
        .iter()
        .map(|b| BaseRow {
            base: *b,
            downloaded: env::downloaded(match env.worker { Some(Worker::Cuda) => b.hf_repo, _ => b.mlx_repo }),
            validated: if b.proven { Some(true) } else { env::validated(&conn, b.id) },
            fits: env.worker.is_some_and(|w| learning::fits(b, w, &machine)),
            gguf_installed: serving::base_gguf(b).is_ok(),
        })
        .collect();
    let usable_examples = datasets::collect(&conn, None).map(|(examples, _)| examples.len()).unwrap_or(0);
    Ok(Overview {
        mode,
        base,
        env,
        env_busy: ENV_BUSY.lock().map(|b| *b).unwrap_or(false),
        bases,
        usable_examples,
        meaningful: datasets::MEANINGFUL,
        datasets: datasets::list(&conn).map_err(|e| e.to_string())?,
        runs: trainer::runs(&conn).map_err(|e| e.to_string())?,
        adapters: trainer::adapters(&conn).map_err(|e| e.to_string())?,
        running: trainer::running(),
        evaluating: evaluating(),
        memory_critical: trainer::resource_refusal().is_some(),
        on_battery: crate::power::status().filter(|p| !p.plugged_in).map(|p| p.percent),
    })
}

/// What is being served, `(adapter id or none for the bare base, base repo)` — apart from the
/// overview, which holds the database lock and must not wait on the slot's.
#[tauri::command]
pub async fn learning_serving() -> Option<(Option<String>, String)> {
    serving::current().await
}

/// `(id, name)` of the published adapters — what the model pickers show for `adapter:<id>`.
#[tauri::command]
pub fn learning_adapter_names(db: State<'_, Db>) -> Result<Vec<(String, String)>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(trainer::published(&conn).map_err(|e| e.to_string())?.into_iter().map(|a| (a.id, a.name)).collect())
}

#[tauri::command]
pub fn learning_set_mode(db: State<'_, Db>, mode: Mode, base: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let raw = match mode {
        Mode::Manual => "manual",
        Mode::Assisted => "assisted",
        Mode::Supervised => "supervised",
    };
    crate::db::queries::set_setting(&conn, learning::KEY_MODE, raw).map_err(|e| e.to_string())?;
    if let Some(base) = base.filter(|b| learning::base(b).is_some()) {
        crate::db::queries::set_setting(&conn, KEY_BASE, &base).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Creates the venv and installs the trainer. Returns at once; lines arrive on `ai:learning`.
#[tauri::command]
pub async fn learning_prepare_env(app: AppHandle) -> Result<(), String> {
    let machine = crate::hybrid::hardware::machine().await;
    let worker = learning::worker_here(&machine).ok_or("this machine can't train: it needs Apple Silicon or an NVIDIA card")?;
    {
        let mut busy = ENV_BUSY.lock().map_err(|e| e.to_string())?;
        if *busy {
            return Err("busy".into());
        }
        *busy = true;
    }
    tauri::async_runtime::spawn(async move {
        let outcome = env::prepare(&app, worker).await;
        if let Ok(mut busy) = ENV_BUSY.lock() {
            *busy = false;
        }
        if let Err(error) = outcome {
            learning::emit(&app, LearningEvent { kind: "env", id: "env".into(), state: "failed", line: Some(error), progress: None });
        }
    });
    Ok(())
}

#[tauri::command]
pub fn learning_build_dataset(db: State<'_, Db>, name: String, workspace_id: Option<String>) -> Result<datasets::DatasetRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let name = name.trim();
    let name = if name.is_empty() { chrono::Local::now().format("%Y-%m-%d %H:%M").to_string() } else { name.to_string() };
    datasets::build(&conn, &learning::root(), &name, "any", workspace_id.as_deref())
}

#[tauri::command]
pub fn learning_delete_dataset(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    datasets::delete(&conn, &id)
}

fn spawn_training(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        // Errors arrive on `ai:learning` as `failed`; this only keeps them in the log.
        if let Err(error) = trainer::train(Some(app), id).await {
            eprintln!("training run ended: {error}");
        }
    });
}

/// Files a run and starts it.
#[tauri::command]
pub async fn learning_start_run(
    app: AppHandle,
    db: State<'_, Db>,
    dataset_id: String,
    base_id: String,
    params: Option<trainer::Params>,
) -> Result<trainer::RunRow, String> {
    if trainer::running().is_some() {
        return Err("busy: another training run is going".into());
    }
    if let Some(why) = trainer::resource_refusal() {
        return Err(why);
    }
    let machine = crate::hybrid::hardware::machine().await;
    let worker = learning::worker_here(&machine).ok_or("this machine can't train: it needs Apple Silicon or an NVIDIA card")?;
    if !env::python().is_file() {
        return Err("prepare the training environment first".into());
    }
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        trainer::create_run(&conn, &dataset_id, &base_id, worker, params)?
    };
    spawn_training(app, row.id.clone());
    Ok(row)
}

/// Continues a stopped or failed run from its last saved weights.
#[tauri::command]
pub fn learning_resume_run(app: AppHandle, id: String) -> Result<(), String> {
    if trainer::running().is_some() {
        return Err("busy: another training run is going".into());
    }
    spawn_training(app, id);
    Ok(())
}

#[tauri::command]
pub fn learning_cancel_run(id: String) -> bool {
    trainer::cancel(&id)
}

#[tauri::command]
pub fn learning_delete_run(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    trainer::delete_run(&conn, &id)
}

/// The last lines of a run's log.
#[tauri::command]
pub fn learning_run_log(db: State<'_, Db>, id: String) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let row = trainer::run(&conn, &id).map_err(|e| e.to_string())?.ok_or("that run no longer exists")?;
    let text = std::fs::read_to_string(&row.log_path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    Ok(lines[lines.len().saturating_sub(200)..].join("\n"))
}

/// Measures an adapter against its base and moves it to `approved` or `rejected`. Returns at once;
/// the verdict arrives on `ai:learning` (`eval`).
#[tauri::command]
pub fn learning_evaluate(app: AppHandle, id: String) -> Result<(), String> {
    if crate::commands::evals_cmd::busy() {
        return Err("busy: a bench run is going under Diagnostics".into());
    }
    if trainer::running().is_some() {
        return Err("busy: wait for the training run to finish".into());
    }
    let (tx, rx) = watch::channel(false);
    {
        let mut slot = EVALUATING.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("busy".into());
        }
        *slot = Some((id.clone(), tx));
    }
    tauri::async_runtime::spawn(async move {
        let outcome = evaluation::evaluate(Some(app), id, Some(rx)).await;
        if let Ok(mut slot) = EVALUATING.lock() {
            *slot = None;
        }
        // The bare base is no longer needed once both reports are in.
        serving::stop(false).await;
        if let Err(error) = outcome {
            eprintln!("adapter evaluation ended: {error}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn learning_cancel_evaluation() -> bool {
    EVALUATING.lock().ok().and_then(|slot| slot.as_ref().map(|(_, tx)| tx.send(true).is_ok())).unwrap_or(false)
}

#[tauri::command]
pub fn learning_publish(db: State<'_, Db>, id: String, force: Option<bool>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    evaluation::publish(&conn, &id, force.unwrap_or(false))
}

#[tauri::command]
pub fn learning_rollback(db: State<'_, Db>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    evaluation::rollback(&conn, &id)
}

#[tauri::command]
pub fn learning_rename_adapter(db: State<'_, Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    trainer::rename_adapter(&conn, &id, &name)
}

#[tauri::command]
pub async fn learning_delete_adapter(db: State<'_, Db>, id: String) -> Result<(), String> {
    if serving::current().await.is_some_and(|(key, _)| key.as_deref() == Some(id.as_str())) {
        serving::stop(true).await;
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    trainer::delete_adapter(&conn, &id)
}

#[tauri::command]
pub async fn learning_stop_serving() {
    serving::stop(true).await;
}

/// Launch-time work: settle interrupted runs, reap an idle adapter server, and give the assisted and
/// supervised modes their turn.
pub fn start(app: &AppHandle) {
    let _ = crate::ai_usage::with_conn(trainer::settle_interrupted);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticks: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            serving::reap_idle().await;
            ticks += 1;
            // Every half hour, starting five minutes after launch.
            if ticks % 30 == 5 {
                autopilot(&app).await;
            }
        }
    });
}

/// The assisted mode prepares datasets when enough new approved examples have gathered; the
/// supervised mode also trains and evaluates a candidate when the machine is plugged in and has
/// memory to spare. Neither ever publishes: that stays the user's click.
async fn autopilot(app: &AppHandle) {
    let Some(Ok(mode)) = crate::ai_usage::with_conn(|conn| {
        crate::db::queries::get_setting(conn, learning::KEY_MODE).map(|raw| Mode::from_setting(raw.as_deref()))
    }) else {
        return;
    };
    if mode == Mode::Manual {
        return;
    }
    let built = crate::ai_usage::with_conn(|conn| -> Option<datasets::DatasetRow> {
        let usable = datasets::collect(conn, None).ok()?.0.len();
        let last = datasets::list(conn).ok()?.into_iter().next();
        let last_count = last.as_ref().map_or(0, |d| (d.train_count + d.valid_count + d.test_count) as usize);
        let due = if last.is_none() { usable >= datasets::MEANINGFUL } else { usable >= last_count + 10 };
        if !due {
            return None;
        }
        let name = format!("auto {}", chrono::Local::now().format("%Y-%m-%d"));
        datasets::build(conn, &learning::root(), &name, "any", None).ok()
    })
    .flatten();
    let Some(dataset) = built else { return };
    learning::emit(app, LearningEvent { kind: "dataset", id: dataset.id.clone(), state: "done", line: None, progress: None });
    if mode != Mode::Supervised || trainer::running().is_some() || evaluating().is_some() || crate::commands::evals_cmd::busy() {
        return;
    }
    let plugged = crate::power::status().is_none_or(|p| p.plugged_in);
    if !plugged || crate::hybrid::hardware::memory_pressure() != crate::hybrid::hardware::Pressure::Normal || !env::python().is_file() {
        return;
    }
    let machine = crate::hybrid::hardware::machine().await;
    let Some(worker) = learning::worker_here(&machine) else { return };
    let chosen = crate::ai_usage::with_conn(|conn| crate::db::queries::get_setting(conn, KEY_BASE).ok().flatten()).flatten();
    let base = chosen
        .as_deref()
        .and_then(learning::base)
        .or_else(|| learning::BASES.iter().find(|b| b.proven && learning::fits(b, worker, &machine)));
    let Some(base) = base else { return };
    let Some(Ok(run)) = crate::ai_usage::with_conn(|conn| trainer::create_run(conn, &dataset.id, base.id, worker, None)) else { return };
    if trainer::train(Some(app.clone()), run.id.clone()).await.is_err() {
        return;
    }
    let adapter = crate::ai_usage::with_conn(|conn| trainer::run(conn, &run.id).ok().flatten().and_then(|r| r.adapter_id)).flatten();
    if let (Some(adapter), Worker::Mlx) = (adapter, worker) {
        let (tx, rx) = watch::channel(false);
        if let Ok(mut slot) = EVALUATING.lock() {
            if slot.is_some() {
                return;
            }
            *slot = Some((adapter.clone(), tx));
        }
        let _ = evaluation::evaluate(Some(app.clone()), adapter, Some(rx)).await;
        if let Ok(mut slot) = EVALUATING.lock() {
            *slot = None;
        }
        serving::stop(false).await;
    }
}
