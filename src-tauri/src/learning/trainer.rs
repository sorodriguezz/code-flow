//! Training runs: LoRA on a base model, from a dataset, as a child process the app watches.
//!
//! On Apple Silicon the trainer is `mlx_lm lora`; on an NVIDIA card, a short PEFT script this module
//! writes next to the run (its own code, not something downloaded). Both print the same progress
//! lines (`Iter N: Train loss …`, `Iter N: Val loss …`, `Iter N: Saved adapter weights …`), which
//! [`parse_line`] reads into [`Progress`].
//!
//! The core ([`train_process`]) touches no database, so a live test can drive it; [`train`] wraps it
//! with the run's row, its log, events, cancellation and the adapter row a finished run files.
//!
//! One run at a time: training holds the GPU, and two would each run at half speed and twice the
//! memory.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::{root, Base, LearningEvent, Worker};

/// How a run trains.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub iters: u32,
    pub batch_size: u32,
    /// Layers that get LoRA weights, counted from the top; `-1` is all of them.
    pub num_layers: i32,
    pub learning_rate: f64,
    pub max_seq_length: u32,
}

impl Params {
    /// About three passes over the data, never fewer than 30 steps or more than 600; a batch never
    /// larger than the smallest split (`mlx_lm` refuses a split smaller than one batch).
    pub fn suggested(train: i64, valid: i64) -> Self {
        let batch = 4.min(train).min(valid).max(1) as u32;
        let iters = ((train.max(1) as f64 * 3.0) / f64::from(batch)).ceil() as u32;
        Params { iters: iters.clamp(30, 600), batch_size: batch, num_layers: 8, learning_rate: 1e-5, max_seq_length: 2048 }
    }

    /// The same, made safe for this data: an edited value never asks the impossible.
    pub fn fitted(mut self, train: i64, valid: i64) -> Self {
        let most = train.min(valid).max(1) as u32;
        self.batch_size = self.batch_size.clamp(1, most.min(64));
        self.iters = self.iters.clamp(1, 20_000);
        if self.num_layers == 0 || self.num_layers < -1 {
            self.num_layers = 8;
        }
        if !(1e-7..=1e-2).contains(&self.learning_rate) {
            self.learning_rate = 1e-5;
        }
        self.max_seq_length = self.max_seq_length.clamp(256, 16_384);
        self
    }
}

/// Where a run is.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub iter: u32,
    pub iters: u32,
    pub train_loss: Option<f64>,
    pub val_loss: Option<f64>,
    /// The validation loss before any training: what the run is judged against.
    pub first_val_loss: Option<f64>,
    pub tokens_per_sec: Option<f64>,
    pub peak_mem_gb: Option<f64>,
    /// The last step whose weights are on disk — where a resumed run picks up.
    pub saved_iter: Option<u32>,
}

fn patterns() -> &'static [Regex; 3] {
    static P: OnceLock<[Regex; 3]> = OnceLock::new();
    P.get_or_init(|| {
        [
            Regex::new(r"Iter (\d+): Train loss ([\d.]+|nan)(?:.*?Tokens/sec ([\d.]+))?(?:.*?Peak mem ([\d.]+) GB)?").expect("train"),
            Regex::new(r"Iter (\d+): Val loss ([\d.]+|nan)").expect("val"),
            Regex::new(r"Iter (\d+): Saved adapter weights").expect("saved"),
        ]
    })
}

/// Reads one line of trainer output into `progress`; `true` when it moved.
pub fn parse_line(line: &str, progress: &mut Progress) -> bool {
    let [train, val, saved] = patterns();
    let num = |s: Option<regex::Match>| s.and_then(|m| m.as_str().parse::<f64>().ok());
    if let Some(c) = train.captures(line) {
        progress.iter = c[1].parse().unwrap_or(progress.iter);
        progress.train_loss = num(c.get(2));
        progress.tokens_per_sec = num(c.get(3)).or(progress.tokens_per_sec);
        progress.peak_mem_gb = num(c.get(4)).or(progress.peak_mem_gb);
        return true;
    }
    if let Some(c) = val.captures(line) {
        let loss = num(c.get(2));
        if progress.first_val_loss.is_none() {
            progress.first_val_loss = loss;
        }
        progress.val_loss = loss;
        progress.iter = progress.iter.max(c[1].parse().unwrap_or(0));
        return true;
    }
    if let Some(c) = saved.captures(line) {
        progress.saved_iter = c[1].parse().ok();
        return true;
    }
    false
}

/// What one training process needs.
#[derive(Clone, Debug)]
pub struct Spec {
    pub worker: Worker,
    pub base: &'static Base,
    pub dataset_dir: PathBuf,
    pub out_dir: PathBuf,
    pub params: Params,
    /// Weights to continue from (a cancelled run's last save).
    pub resume_from: Option<PathBuf>,
}

/// The file a finished run leaves, per worker.
pub fn weights_file(worker: Worker) -> &'static str {
    match worker {
        Worker::Mlx => "adapters.safetensors",
        Worker::Cuda => "adapter_model.safetensors",
    }
}

/// The adapter format a worker produces.
pub fn format_of(worker: Worker) -> &'static str {
    match worker {
        Worker::Mlx => "mlx-lora",
        Worker::Cuda => "peft-lora",
    }
}

const PEFT_SCRIPT: &str = include_str!("peft_train.py");

fn command(spec: &Spec) -> Result<tokio::process::Command, String> {
    let python = super::env::python();
    if !python.is_file() {
        return Err("the training environment isn't prepared".into());
    }
    let p = &spec.params;
    let report = (p.iters / 20).max(1);
    let eval = (p.iters / 5).max(5).min(p.iters.max(1));
    let mut cmd = tokio::process::Command::new(&python);
    match spec.worker {
        Worker::Mlx => {
            cmd.args(["-m", "mlx_lm", "lora", "--model", spec.base.mlx_repo, "--train", "--data"])
                .arg(&spec.dataset_dir)
                .args(["--fine-tune-type", "lora", "--mask-prompt", "--grad-checkpoint"])
                .args(["--iters", &p.iters.to_string(), "--batch-size", &p.batch_size.to_string()])
                .args(["--num-layers", &p.num_layers.to_string(), "--learning-rate", &format!("{:e}", p.learning_rate)])
                .args(["--max-seq-length", &p.max_seq_length.to_string()])
                .args(["--steps-per-report", &report.to_string(), "--steps-per-eval", &eval.to_string(), "--save-every", &eval.to_string()])
                .arg("--adapter-path")
                .arg(&spec.out_dir);
            if let Some(resume) = &spec.resume_from {
                cmd.arg("--resume-adapter-file").arg(resume);
            }
        }
        Worker::Cuda => {
            let script = root().join("peft_train.py");
            std::fs::write(&script, PEFT_SCRIPT).map_err(|e| e.to_string())?;
            cmd.arg("-I")
                .arg(&script)
                .args(["--model", spec.base.hf_repo, "--data"])
                .arg(&spec.dataset_dir)
                .arg("--out")
                .arg(&spec.out_dir)
                .args(["--iters", &p.iters.to_string(), "--batch", &p.batch_size.to_string()])
                .args(["--lr", &format!("{:e}", p.learning_rate), "--max-seq", &p.max_seq_length.to_string()])
                .args(["--report", &report.to_string(), "--eval", &eval.to_string()]);
            if spec.base.moe {
                cmd.arg("--exclude-experts");
            }
            if let Some(resume) = &spec.resume_from {
                cmd.arg("--resume").arg(resume);
            }
        }
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    super::env::prepare_command(&mut cmd);
    Ok(cmd)
}

/// The trainer's pid while one runs, for [`shutdown`]: the quit ends in `process::exit`, where
/// `kill_on_drop` never fires.
static PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// On quit: kills a training process outright. Its run is settled as `cancelled` (resumable) at the
/// next launch by [`settle_interrupted`].
pub fn shutdown() {
    let pid = PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid != 0 {
        let mut system = sysinfo::System::new();
        let pid = sysinfo::Pid::from_u32(pid);
        system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[pid]), true, sysinfo::ProcessRefreshKind::nothing());
        if let Some(process) = system.process(pid) {
            process.kill();
        }
    }
}

/// How a process ended.
#[derive(Debug, PartialEq)]
pub enum Ended {
    Done,
    Cancelled,
    Failed(String),
}

/// Runs one training process to its end, handing every line to `on_line` with the progress so far.
pub async fn train_process(spec: &Spec, mut cancel: watch::Receiver<bool>, mut on_line: impl FnMut(&str, &Progress, bool)) -> (Ended, Progress) {
    use tokio::io::AsyncBufReadExt;
    let mut progress = Progress { iters: spec.params.iters, ..Progress::default() };
    if let Err(error) = std::fs::create_dir_all(&spec.out_dir) {
        return (Ended::Failed(error.to_string()), progress);
    }
    let mut cmd = match command(spec) {
        Ok(cmd) => cmd,
        Err(error) => return (Ended::Failed(error), progress),
    };
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => return (Ended::Failed(format!("could not start the trainer: {error}")), progress),
    };
    PID.store(child.id().unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let pipes: [Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>; 2] = [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
    ];
    for pipe in pipes.into_iter().flatten() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    loop {
        tokio::select! {
            line = rx.recv() => match line {
                Some(line) => {
                    let moved = parse_line(&line, &mut progress);
                    on_line(&line, &progress, moved);
                    if !line.trim().is_empty() {
                        tail.push(line);
                        if tail.len() > 8 {
                            tail.remove(0);
                        }
                    }
                }
                None => break,
            },
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    PID.store(0, std::sync::atomic::Ordering::SeqCst);
                    return (Ended::Cancelled, progress);
                }
            }
        }
    }
    let status = child.wait().await;
    PID.store(0, std::sync::atomic::Ordering::SeqCst);
    let ok = status.as_ref().is_ok_and(|s| s.success());
    let weights = spec.out_dir.join(weights_file(spec.worker)).is_file();
    let ended = if ok && weights {
        Ended::Done
    } else if ok {
        Ended::Failed("the trainer finished without leaving adapter weights".into())
    } else {
        let why = tail.iter().rev().find(|l| l.contains("Error") || l.contains("error")).cloned().unwrap_or_else(|| tail.join(" · "));
        Ended::Failed(why)
    };
    if progress.val_loss.is_some_and(f64::is_nan) || progress.train_loss.is_some_and(f64::is_nan) {
        return (Ended::Failed("the loss became NaN — lower the learning rate".into()), progress);
    }
    (ended, progress)
}

// ---------------------------------------------------------------------------
// Runs and adapters on file
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub dataset_id: Option<String>,
    pub base_model: String,
    pub family: String,
    pub worker: String,
    pub method: String,
    pub params: serde_json::Value,
    pub status: String,
    pub progress: serde_json::Value,
    pub log_path: String,
    pub out_dir: String,
    pub adapter_id: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

const RUN_COLUMNS: &str = "id, dataset_id, base_model, family, worker, method, params, status, progress, log_path, out_dir, adapter_id, error, created_at, started_at, finished_at";

fn run_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    let json = |s: String| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null);
    Ok(RunRow {
        id: r.get(0)?,
        dataset_id: r.get(1)?,
        base_model: r.get(2)?,
        family: r.get(3)?,
        worker: r.get(4)?,
        method: r.get(5)?,
        params: json(r.get(6)?),
        status: r.get(7)?,
        progress: json(r.get(8)?),
        log_path: r.get(9)?,
        out_dir: r.get(10)?,
        adapter_id: r.get(11)?,
        error: r.get(12)?,
        created_at: r.get(13)?,
        started_at: r.get(14)?,
        finished_at: r.get(15)?,
    })
}

pub fn runs(conn: &Connection) -> rusqlite::Result<Vec<RunRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {RUN_COLUMNS} FROM ai_training_runs ORDER BY created_at DESC"))?;
    let rows = stmt.query_map([], run_from)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn run(conn: &Connection, id: &str) -> rusqlite::Result<Option<RunRow>> {
    conn.query_row(&format!("SELECT {RUN_COLUMNS} FROM ai_training_runs WHERE id = ?1"), params![id], run_from).optional()
}

fn worker_name(worker: Worker) -> &'static str {
    match worker {
        Worker::Mlx => "mlx",
        Worker::Cuda => "cuda",
    }
}

fn worker_from(name: &str) -> Option<Worker> {
    match name {
        "mlx" => Some(Worker::Mlx),
        "cuda" => Some(Worker::Cuda),
        _ => None,
    }
}

/// Files a run (queued): nothing starts until [`train`].
pub fn create_run(conn: &Connection, dataset_id: &str, base_id: &str, worker: Worker, params: Option<Params>) -> Result<RunRow, String> {
    let dataset = super::datasets::get(conn, dataset_id).map_err(|e| e.to_string())?.ok_or("that dataset no longer exists")?;
    let base = super::base(base_id).ok_or_else(|| format!("unknown base model {base_id}"))?;
    let params = params.unwrap_or_else(|| Params::suggested(dataset.train_count, dataset.valid_count)).fitted(dataset.train_count, dataset.valid_count);
    let id = uuid::Uuid::new_v4().to_string();
    let out_dir = root().join("adapters").join(&id);
    let log_path = root().join("runs").join(format!("{id}.log"));
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO ai_training_runs (id, dataset_id, base_model, base_sha, family, worker, method, params, status, progress, log_path, out_dir, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'lora', ?7, 'queued', ?8, ?9, ?10, ?11)",
        params![
            id,
            dataset_id,
            base.id,
            match worker { Worker::Mlx => base.mlx_repo, Worker::Cuda => base.hf_repo },
            base.family,
            worker_name(worker),
            serde_json::to_string(&params).unwrap_or_default(),
            serde_json::to_string(&Progress { iters: params.iters, ..Progress::default() }).unwrap_or_default(),
            log_path.to_string_lossy(),
            out_dir.to_string_lossy(),
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    run(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "the run was not filed".into())
}

fn set_run(conn: &Connection, id: &str, status: &str, progress: Option<&Progress>, error: Option<&str>) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let finished = matches!(status, "done" | "failed" | "cancelled").then_some(now);
    let started = (status == "running").then_some(now);
    conn.execute(
        "UPDATE ai_training_runs SET status = ?2,
             progress = COALESCE(?3, progress),
             error = ?4,
             started_at = COALESCE(?5, started_at),
             finished_at = ?6
         WHERE id = ?1",
        params![id, status, progress.map(|p| serde_json::to_string(p).unwrap_or_default()), error, started, finished],
    )?;
    Ok(())
}

/// Deletes a run, its log and — unless an adapter row still points at them — its weights.
pub fn delete_run(conn: &Connection, id: &str) -> Result<(), String> {
    if running().as_deref() == Some(id) {
        return Err("stop the run before deleting it".into());
    }
    if let Some(row) = run(conn, id).map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(&row.log_path);
        if row.adapter_id.is_none() {
            let _ = std::fs::remove_dir_all(&row.out_dir);
        }
    }
    conn.execute("DELETE FROM ai_training_runs WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRow {
    pub id: String,
    pub name: String,
    pub base_model: String,
    pub family: String,
    pub dataset_id: Option<String>,
    pub run_id: Option<String>,
    pub path: String,
    pub format: String,
    pub framework_version: String,
    pub metrics: serde_json::Value,
    /// `candidate` → `approved` | `rejected` (the evaluation gate) → `published` → `retired`.
    pub status: String,
    pub evaluation_id: Option<String>,
    pub created_at: i64,
    pub published_at: Option<i64>,
}

const ADAPTER_COLUMNS: &str = "id, name, base_model, family, dataset_id, run_id, path, format, framework_version, metrics, status, evaluation_id, created_at, published_at";

fn adapter_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<AdapterRow> {
    let metrics: String = r.get(9)?;
    Ok(AdapterRow {
        id: r.get(0)?,
        name: r.get(1)?,
        base_model: r.get(2)?,
        family: r.get(3)?,
        dataset_id: r.get(4)?,
        run_id: r.get(5)?,
        path: r.get(6)?,
        format: r.get(7)?,
        framework_version: r.get(8)?,
        metrics: serde_json::from_str(&metrics).unwrap_or(serde_json::Value::Null),
        status: r.get(10)?,
        evaluation_id: r.get(11)?,
        created_at: r.get(12)?,
        published_at: r.get(13)?,
    })
}

pub fn adapters(conn: &Connection) -> rusqlite::Result<Vec<AdapterRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {ADAPTER_COLUMNS} FROM ai_model_adapters ORDER BY created_at DESC"))?;
    let rows = stmt.query_map([], adapter_from)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn adapter(conn: &Connection, id: &str) -> rusqlite::Result<Option<AdapterRow>> {
    conn.query_row(&format!("SELECT {ADAPTER_COLUMNS} FROM ai_model_adapters WHERE id = ?1"), params![id], adapter_from).optional()
}

/// The adapters the provider offers: published ones.
pub fn published(conn: &Connection) -> rusqlite::Result<Vec<AdapterRow>> {
    Ok(adapters(conn)?.into_iter().filter(|a| a.status == "published").collect())
}

pub fn set_adapter_status(conn: &Connection, id: &str, status: &str, evaluation_id: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE ai_model_adapters SET status = ?2, evaluation_id = COALESCE(?3, evaluation_id),
             published_at = CASE WHEN ?2 = 'published' THEN ?4 ELSE published_at END
         WHERE id = ?1",
        params![id, status, evaluation_id, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// Files the evaluation gate's summary in the adapter's metrics, under `gate`.
pub fn set_adapter_gate(conn: &Connection, id: &str, summary: &serde_json::Value) -> rusqlite::Result<()> {
    let metrics: String = conn.query_row("SELECT metrics FROM ai_model_adapters WHERE id = ?1", params![id], |r| r.get(0))?;
    let mut metrics: serde_json::Value = serde_json::from_str(&metrics).unwrap_or_else(|_| serde_json::json!({}));
    if !metrics.is_object() {
        metrics = serde_json::json!({});
    }
    metrics["gate"] = summary.clone();
    conn.execute("UPDATE ai_model_adapters SET metrics = ?2 WHERE id = ?1", params![id, metrics.to_string()])?;
    Ok(())
}

pub fn rename_adapter(conn: &Connection, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a name is needed".into());
    }
    conn.execute("UPDATE ai_model_adapters SET name = ?2 WHERE id = ?1", params![id, name]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes an adapter and its weights.
pub fn delete_adapter(conn: &Connection, id: &str) -> Result<(), String> {
    if let Some(row) = adapter(conn, id).map_err(|e| e.to_string())? {
        let _ = std::fs::remove_dir_all(&row.path);
    }
    conn.execute("UPDATE ai_training_runs SET adapter_id = NULL WHERE adapter_id = ?1", params![id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ai_model_adapters WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn file_adapter(conn: &Connection, run: &RunRow, progress: &Progress, framework_version: &str) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let base = super::base(&run.base_model);
    let dataset_name: Option<String> = run
        .dataset_id
        .as_deref()
        .and_then(|d| conn.query_row("SELECT name FROM ai_datasets WHERE id = ?1", params![d], |r| r.get(0)).optional().ok().flatten());
    let name = format!(
        "{} · {}",
        base.map(|b| b.label).unwrap_or(run.base_model.as_str()),
        dataset_name.unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string())
    );
    let format = worker_from(&run.worker).map(format_of).unwrap_or("mlx-lora");
    conn.execute(
        "INSERT INTO ai_model_adapters (id, name, base_model, base_sha, family, dataset_id, run_id, path, format, framework_version, metrics, status, created_at)
         VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'candidate', ?11)",
        params![
            id,
            name,
            run.base_model,
            run.family,
            run.dataset_id,
            run.id,
            run.out_dir,
            format,
            framework_version,
            serde_json::to_string(progress).unwrap_or_default(),
            chrono::Utc::now().timestamp_millis()
        ],
    )?;
    conn.execute("UPDATE ai_training_runs SET adapter_id = ?2 WHERE id = ?1", params![run.id, id])?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// The running run
// ---------------------------------------------------------------------------

fn active() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static A: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The run training now, if any.
pub fn running() -> Option<String> {
    active().lock().ok()?.keys().next().cloned()
}

/// Stops a run; it ends `cancelled` and can be resumed from its last save.
pub fn cancel(id: &str) -> bool {
    active().lock().ok().and_then(|map| map.get(id).map(|tx| tx.send(true).is_ok())).unwrap_or(false)
}

/// Why a run should not start now, if anything: memory the system is already short of.
pub fn resource_refusal() -> Option<String> {
    (crate::hybrid::hardware::memory_pressure() == crate::hybrid::hardware::Pressure::Critical)
        .then(|| "the system is critically short of memory — close something and try again".to_string())
}

/// Trains run `id` to its end: the row moves `running` → `done` | `failed` | `cancelled`, a finished
/// run files a `candidate` adapter, and every step goes out on `ai:learning`. A run that was stopped
/// resumes from its last saved weights.
pub async fn train(app: Option<tauri::AppHandle>, id: String) -> Result<(), String> {
    let row = crate::ai_usage::with_conn(|conn| run(conn, &id)).ok_or("the database is not available")?.map_err(|e| e.to_string())?.ok_or("that run no longer exists")?;
    if row.status == "running" || row.status == "done" {
        return Err(format!("the run is already {}", row.status));
    }
    if let Some(why) = resource_refusal() {
        return Err(why);
    }
    let worker = worker_from(&row.worker).ok_or("unknown worker")?;
    let base = super::base(&row.base_model).ok_or("unknown base model")?;
    let dataset_dir = match row.dataset_id.as_deref() {
        Some(dataset) => crate::ai_usage::with_conn(|conn| super::datasets::get(conn, dataset))
            .and_then(Result::ok)
            .flatten()
            .map(|d| PathBuf::from(d.path))
            .ok_or("the run's dataset no longer exists")?,
        None => return Err("the run's dataset no longer exists".into()),
    };
    let mut params: Params = serde_json::from_value(row.params.clone()).map_err(|e| e.to_string())?;
    let out_dir = PathBuf::from(&row.out_dir);
    let previous: Progress = serde_json::from_value(row.progress.clone()).unwrap_or_default();
    let resume_file = out_dir.join(weights_file(worker));
    let resume_from = (resume_file.is_file() && previous.saved_iter.is_some()).then_some(resume_file);
    if let (Some(_), Some(saved)) = (&resume_from, previous.saved_iter) {
        params.iters = params.iters.saturating_sub(saved).max(1);
    }
    let (tx, rx) = watch::channel(false);
    {
        let mut map = active().lock().map_err(|_| "busy")?;
        if !map.is_empty() {
            return Err("busy: another training run is going".into());
        }
        map.insert(id.clone(), tx);
    }
    let spec = Spec { worker, base, dataset_dir, out_dir, params, resume_from };
    let log_path = PathBuf::from(&row.log_path);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let _ = crate::ai_usage::with_conn(|conn| set_run(conn, &id, "running", None, None));
    say(&app, &id, "running", None, None);
    let mut last_saved = std::time::Instant::now();
    let offset = previous.saved_iter.filter(|_| spec.resume_from.is_some()).unwrap_or(0);
    let total = offset + spec.params.iters;
    let (ended, mut progress) = train_process(&spec, rx, |line, progress, moved| {
        if let Some(file) = log.as_mut() {
            use std::io::Write;
            let _ = writeln!(file, "{line}");
        }
        let mut shown = progress.clone();
        shown.iter += offset;
        shown.iters = total;
        shown.saved_iter = shown.saved_iter.map(|s| s + offset);
        if moved && last_saved.elapsed().as_millis() > 800 {
            last_saved = std::time::Instant::now();
            let _ = crate::ai_usage::with_conn(|conn| set_run(conn, &id, "running", Some(&shown), None));
        }
        say(&app, &id, "running", Some(line), moved.then_some(&shown));
    })
    .await;
    progress.iter += offset;
    progress.iters = total;
    progress.saved_iter = progress.saved_iter.map(|s| s + offset);
    if let Ok(mut map) = active().lock() {
        map.remove(&id);
    }
    let base_validated = |ok: bool| {
        if !base.proven {
            let _ = crate::ai_usage::with_conn(|conn| crate::db::queries::set_setting(conn, &super::env::validated_key(base.id), if ok { "1" } else { "0" }));
        }
    };
    match ended {
        Ended::Done => {
            let version = super::env::trainer_version().await.unwrap_or_default();
            let filed = crate::ai_usage::with_conn(|conn| {
                set_run(conn, &id, "done", Some(&progress), None)?;
                let row = run(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                file_adapter(conn, &row, &progress, &version)
            });
            base_validated(true);
            say(&app, &id, "done", None, Some(&progress));
            match filed {
                Some(Ok(_)) => Ok(()),
                Some(Err(error)) => Err(error.to_string()),
                None => Err("the database is not available".into()),
            }
        }
        Ended::Cancelled => {
            let _ = crate::ai_usage::with_conn(|conn| set_run(conn, &id, "cancelled", Some(&progress), None));
            say(&app, &id, "cancelled", None, Some(&progress));
            Ok(())
        }
        Ended::Failed(why) => {
            let _ = crate::ai_usage::with_conn(|conn| set_run(conn, &id, "failed", Some(&progress), Some(&why)));
            // A validation run that failed for a reason other than the machine says the base does
            // not train here.
            if !why.contains("not prepared") {
                base_validated(false);
            }
            say(&app, &id, "failed", Some(&why), Some(&progress));
            Err(why)
        }
    }
}

fn say(app: &Option<tauri::AppHandle>, id: &str, state: &'static str, line: Option<&str>, progress: Option<&Progress>) {
    if let Some(app) = app {
        super::emit(
            app,
            LearningEvent {
                kind: "train",
                id: id.to_string(),
                state,
                line: line.map(str::to_string),
                progress: progress.and_then(|p| serde_json::to_value(p).ok()),
            },
        );
    }
}

/// On startup: a run left `running` by a quit or a crash is `cancelled` (resumable), not running.
pub fn settle_interrupted(conn: &Connection) {
    let _ = conn.execute(
        "UPDATE ai_training_runs SET status = 'cancelled', error = 'interrupted when CodeFlow closed' WHERE status = 'running'",
        [],
    );
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mlx_lines_move_the_progress() {
        let mut p = Progress { iters: 30, ..Progress::default() };
        assert!(parse_line("Iter 1: Val loss 2.912, Val took 0.311s", &mut p));
        assert!(parse_line(
            "Iter 5: Train loss 2.501, Learning Rate 1.000e-05, It/sec 3.1, Tokens/sec 812.4, Trained Tokens 1290, Peak mem 1.204 GB",
            &mut p
        ));
        assert!(parse_line("Iter 10: Val loss 1.833, Val took 0.290s", &mut p));
        assert!(parse_line("Iter 10: Saved adapter weights to /x/adapters.safetensors and /x/0000010_adapters.safetensors.", &mut p));
        assert!(!parse_line("Loading pretrained model", &mut p));
        assert_eq!(p.iter, 10);
        assert_eq!(p.first_val_loss, Some(2.912));
        assert_eq!(p.val_loss, Some(1.833));
        assert_eq!(p.train_loss, Some(2.501));
        assert_eq!(p.tokens_per_sec, Some(812.4));
        assert_eq!(p.peak_mem_gb, Some(1.204));
        assert_eq!(p.saved_iter, Some(10));
    }

    #[test]
    fn the_peft_script_speaks_the_same_lines() {
        let mut p = Progress::default();
        assert!(parse_line("Iter 5: Train loss 1.250, Tokens/sec 2048.0, Peak mem 9.100 GB", &mut p));
        assert_eq!(p.peak_mem_gb, Some(9.1));
        assert!(PEFT_SCRIPT.contains("Train loss") && PEFT_SCRIPT.contains("Val loss") && PEFT_SCRIPT.contains("Saved adapter weights"));
    }

    #[test]
    fn params_never_ask_more_than_the_data_has() {
        let p = Params::suggested(2, 1);
        assert_eq!(p.batch_size, 1);
        assert!(p.iters >= 30);
        let wild = Params { iters: 0, batch_size: 99, num_layers: 0, learning_rate: 5.0, max_seq_length: 10 }.fitted(10, 3);
        assert_eq!(wild.batch_size, 3);
        assert_eq!(wild.iters, 1);
        assert_eq!(wild.num_layers, 8);
        assert_eq!(wild.learning_rate, 1e-5);
        assert_eq!(wild.max_seq_length, 256);
        assert_eq!(Params::suggested(400, 40).iters, 300);
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);").unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO ai_datasets (id, name, family, path, train_count, valid_count, test_count, manifest, created_at) VALUES ('d1', 'mine', 'any', '/nowhere', 8, 2, 2, '{}', 1)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_run_files_and_a_finished_one_files_a_candidate() {
        let conn = db();
        let run_row = create_run(&conn, "d1", "qwen2.5-0.5b-instruct", Worker::Mlx, None).unwrap();
        assert_eq!(run_row.status, "queued");
        assert_eq!(run_row.params["batchSize"], 2);
        set_run(&conn, &run_row.id, "running", None, None).unwrap();
        let progress = Progress { iter: 30, iters: 30, val_loss: Some(1.0), ..Progress::default() };
        set_run(&conn, &run_row.id, "done", Some(&progress), None).unwrap();
        let done = run(&conn, &run_row.id).unwrap().unwrap();
        assert!(done.started_at.is_some() && done.finished_at.is_some());
        let adapter_id = file_adapter(&conn, &done, &progress, "0.29.1").unwrap();
        let adapter_row = adapter(&conn, &adapter_id).unwrap().unwrap();
        assert_eq!(adapter_row.status, "candidate");
        assert_eq!(adapter_row.format, "mlx-lora");
        assert!(adapter_row.name.contains("mine"));
        assert!(published(&conn).unwrap().is_empty());
        set_adapter_status(&conn, &adapter_id, "published", Some("e1")).unwrap();
        let published_rows = published(&conn).unwrap();
        assert_eq!(published_rows.len(), 1);
        assert!(published_rows[0].published_at.is_some());
        assert_eq!(run(&conn, &run_row.id).unwrap().unwrap().adapter_id.as_deref(), Some(adapter_id.as_str()));
        delete_adapter(&conn, &adapter_id).unwrap();
        assert!(run(&conn, &run_row.id).unwrap().unwrap().adapter_id.is_none());
        assert!(create_run(&conn, "nope", "qwen2.5-0.5b-instruct", Worker::Mlx, None).is_err());
        assert!(create_run(&conn, "d1", "nope", Worker::Mlx, None).is_err());
    }

    #[test]
    fn an_interrupted_run_is_resumable_not_running() {
        let conn = db();
        let row = create_run(&conn, "d1", "qwen2.5-0.5b-instruct", Worker::Mlx, None).unwrap();
        set_run(&conn, &row.id, "running", None, None).unwrap();
        settle_interrupted(&conn);
        assert_eq!(run(&conn, &row.id).unwrap().unwrap().status, "cancelled");
    }
}
