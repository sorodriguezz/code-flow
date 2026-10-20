//! The bench: one corpus every local model is measured on, here and on any other machine.
//!
//! Every layer the AI platform adds — a model, a context budget, retrieval, memory, a fine-tuned
//! adapter — has to win here or it is not worth its complexity. So the bench runs the paths the app
//! really runs: tasks go through [`crate::local_agent::run_with`] (the «CodeFlow» provider, agent and
//! text mode alike), tool conformance asks the server directly, and speed is the same measurement
//! **Probar** shows.
//!
//! A run produces a [`report::Report`]: JSON that names the model by content (SHA-256 or digest),
//! the machine and the settings, so a report from this Mac and one from a 4090 can be compared, and
//! a base model can be compared with its adapter before the adapter is published.
//!
//! Drive it from the app (Settings › Local model › Diagnóstico) or, in a checkout:
//! `CODEFLOW_EVAL=1 CODEFLOW_EVAL_MODEL=<id> cargo test --lib evals::bench -- --ignored --nocapture`
//! (see [`bench`] for the other variables).

pub mod conformance;
pub mod corpus;
pub mod fixtures;
pub mod report;
pub mod speed;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::watch;

use crate::ai::AiInvocation;
use crate::hybrid::config::Settings;
use crate::hybrid::local_llm::{self, BackendKind};
use crate::hybrid::runtime::{self, Freshness};
use corpus::{EvalTask, Suite, TASKS};
use report::{MachineSummary, Report, TaskResult};

/// What to run.
#[derive(Clone, Debug)]
pub struct Options {
    pub runs: usize,
    pub suites: Vec<Suite>,
    /// Task ids to run; empty runs every task of the selected suites.
    pub only: Vec<String>,
    pub app_version: Option<String>,
    /// Recorded in the report when an adapter is being measured.
    pub adapter: Option<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self { runs: 1, suites: Suite::ALL.to_vec(), only: Vec::new(), app_version: None, adapter: None }
    }
}

/// Where a run is, for a progress line.
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub step: String,
    pub done: usize,
    pub total: usize,
}

fn selected<'a>(options: &'a Options) -> impl Iterator<Item = &'static EvalTask> + 'a {
    TASKS
        .iter()
        .filter(|t| options.suites.contains(&t.suite))
        .filter(|t| options.only.is_empty() || options.only.iter().any(|id| id == t.id))
}

/// Steps the run will take, for the progress total.
pub fn planned_steps(options: &Options) -> usize {
    let tasks = selected(options).count() * options.runs.max(1);
    tasks + usize::from(options.suites.contains(&Suite::Speed)) + usize::from(options.suites.contains(&Suite::Tools))
}

fn cancelled(cancel: &Option<watch::Receiver<bool>>) -> bool {
    cancel.as_ref().is_some_and(|rx| *rx.borrow())
}

/// Runs the bench against the model `settings` resolve to. `settings` should name the backend and
/// the model: the bench measures one model, never whatever detection happens to find.
pub async fn run(
    settings: &Settings,
    options: &Options,
    progress: impl Fn(Progress),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Report, String> {
    // Measuring is background work: a chat that starts meanwhile goes first (and slows the run,
    // which the report's times then show).
    crate::hybrid::scheduler::background(run_inner(settings, options, progress, cancel)).await
}

async fn run_inner(
    settings: &Settings,
    options: &Options,
    progress: impl Fn(Progress),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Report, String> {
    let started_at = chrono::Utc::now().to_rfc3339();
    let resolved = runtime::resolve(settings, Freshness::Now).await;
    if let Some(code) = resolved.error_code {
        return Err(format!("{code}: {}", resolved.error.clone().unwrap_or_default()));
    }
    let model = resolved.model.clone().ok_or("no-models: there is no local model to measure")?;
    let live = runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
    let _in_flight = live.engine.as_ref().map(|engine| engine.begin());
    let think = crate::model_registry::think_for(&resolved, crate::model_registry::TaskClass::Agent);
    let num_ctx = (resolved.kind == BackendKind::Ollama).then_some(resolved.ctx);

    let total = planned_steps(options);
    let mut done = 0;
    let mut step = |name: String| {
        progress(Progress { step: name, done, total });
        done += 1;
    };

    let peak = Arc::new(AtomicU64::new(0));
    let stop_sampling = Arc::new(AtomicBool::new(false));
    let sampler = spawn_memory_sampler(&live, &model, peak.clone(), stop_sampling.clone());

    let mut aborted = None;
    let speed = if options.suites.contains(&Suite::Speed) {
        step("speed".to_string());
        let probe = speed::Probe {
            endpoint: &live.endpoint,
            model: &live.model,
            kind: resolved.kind,
            ctx: resolved.ctx,
            input_budget: resolved.budget.input,
            think,
        };
        match speed::measure(&probe).await {
            Ok(sample) => Some(sample),
            Err(error) => {
                aborted = Some(format!("speed: {}", error.sentence()));
                None
            }
        }
    } else {
        None
    };

    let conformance = if aborted.is_none() && options.suites.contains(&Suite::Tools) && !cancelled(&cancel) {
        step("tools".to_string());
        Some(conformance::run(&live.endpoint, &live.model, num_ctx, think).await)
    } else {
        None
    };

    let node = fixtures::node_available();
    let mut tasks = Vec::new();
    for task in selected(options) {
        if task.needs_node && !node {
            tasks.push(skipped(task, "node is not installed"));
            continue;
        }
        if let Some(why) = &aborted {
            tasks.push(skipped(task, why));
            continue;
        }
        let mut result = TaskResult {
            id: task.id.to_string(),
            suite: task.suite,
            runs: 0,
            passed: 0,
            seconds: Vec::new(),
            failures: Vec::new(),
            prompt_tokens: 0,
            completion_tokens: 0,
            skipped: None,
        };
        for _ in 0..options.runs.max(1) {
            if cancelled(&cancel) {
                aborted = Some("stopped".to_string());
                break;
            }
            step(task.id.to_string());
            let outcome = run_task(settings, task, &model, cancel.clone()).await;
            result.runs += 1;
            result.seconds.push(outcome.seconds);
            result.prompt_tokens += outcome.prompt_tokens;
            result.completion_tokens += outcome.completion_tokens;
            match outcome.verdict {
                Ok(()) => result.passed += 1,
                Err(why) => result.failures.push(why),
            }
        }
        if result.runs == 0 {
            result.skipped = aborted.clone();
        }
        tasks.push(result);
    }

    stop_sampling.store(true, Ordering::SeqCst);
    let _ = sampler.await;
    let peak = peak.load(Ordering::SeqCst);
    let digest = crate::model_registry::digest_of(resolved.kind, &resolved.url, &model).await;
    Ok(Report {
        format: report::FORMAT,
        app_version: options.app_version.clone(),
        started_at,
        finished_at: chrono::Utc::now().to_rfc3339(),
        backend: resolved.kind.as_str().to_string(),
        model,
        model_digest: digest,
        adapter: options.adapter.clone(),
        ctx: resolved.ctx,
        machine: MachineSummary::of(&resolved.machine),
        speed,
        conformance,
        score: Report::compute_score(&tasks),
        tasks,
        peak_rss_bytes: (peak > 0).then_some(peak),
        aborted,
    })
}

fn skipped(task: &EvalTask, why: &str) -> TaskResult {
    TaskResult {
        id: task.id.to_string(),
        suite: task.suite,
        runs: 0,
        passed: 0,
        seconds: Vec::new(),
        failures: Vec::new(),
        prompt_tokens: 0,
        completion_tokens: 0,
        skipped: Some(why.to_string()),
    }
}

struct TaskOutcome {
    verdict: Result<(), String>,
    seconds: f64,
    prompt_tokens: u64,
    completion_tokens: u64,
}

async fn run_task(settings: &Settings, task: &EvalTask, model: &str, cancel: Option<watch::Receiver<bool>>) -> TaskOutcome {
    let dir = task.fixture.map(|fixture| fixture.create());
    let root = dir.as_ref().map(|d| d.to_string_lossy().to_string());
    let mut inv = AiInvocation::new(task.prompt, task.stdin);
    inv.cwd = root.as_deref();
    inv.task = task.task;
    inv.model = model;
    inv.auto_approve_edits = task.write;
    inv.read_only = !task.write;
    inv.json_schema = task.schema;
    let mut cancel = cancel;
    let started = std::time::Instant::now();
    let outcome = crate::local_agent::run_with(settings, &inv, &None, &mut cancel).await;
    let seconds = started.elapsed().as_secs_f64();
    let (verdict, prompt_tokens, completion_tokens) = match outcome {
        Ok(run) => {
            let usage = run.usage.as_ref();
            let check_dir = dir.clone().unwrap_or_else(std::env::temp_dir);
            (
                (task.check)(&check_dir, &run.text),
                usage.map_or(0, |u| u.input_tokens.max(0) as u64),
                usage.map_or(0, |u| u.output_tokens.max(0) as u64),
            )
        }
        Err(error) => (Err(corpus::clip(&error)), 0, 0),
    };
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    TaskOutcome { verdict, seconds, prompt_tokens, completion_tokens }
}

/// Reads the model server's resident memory every half second and keeps the highest: the bundled
/// engine's process, or what Ollama reports the model occupies.
fn spawn_memory_sampler(live: &runtime::Live, model: &str, peak: Arc<AtomicU64>, stop: Arc<AtomicBool>) -> tokio::task::JoinHandle<()> {
    let pid = live.engine.as_ref().and_then(|engine| engine.pid());
    let endpoint = live.endpoint.clone();
    let model = model.to_string();
    tokio::spawn(async move {
        let mut system = sysinfo::System::new();
        while !stop.load(Ordering::SeqCst) {
            let bytes = match pid {
                Some(pid) => {
                    let pid = sysinfo::Pid::from_u32(pid);
                    system.refresh_processes_specifics(
                        sysinfo::ProcessesToUpdate::Some(&[pid]),
                        true,
                        sysinfo::ProcessRefreshKind::nothing().with_memory(),
                    );
                    system.process(pid).map_or(0, |p| p.memory())
                }
                None if endpoint.kind == BackendKind::Ollama => local_llm::ollama_residency(&endpoint)
                    .await
                    .into_iter()
                    .find(|(name, _, _)| name == &model)
                    .map_or(0, |(_, size, _)| size),
                None => 0,
            };
            peak.fetch_max(bytes, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    })
}

/// The bench from a checkout, against a real server — ignored by default.
///
/// `CODEFLOW_EVAL=1` turns it on. `CODEFLOW_EVAL_BACKEND` = `bundled` (default) | `ollama` | `openai`;
/// `CODEFLOW_EVAL_MODEL` = a catalogue id (bundled) or the server's model name; `CODEFLOW_EVAL_URL`,
/// `CODEFLOW_EVAL_CTX`, `CODEFLOW_EVAL_RUNS` (default 1), `CODEFLOW_EVAL_SUITES` (comma list of
/// speed,tools,text,agent), `CODEFLOW_EVAL_ONLY` (task ids), `CODEFLOW_EVAL_OUT` (JSON path).
#[cfg(test)]
mod bench {
    use super::*;
    use crate::hybrid::config::{OnFail, ReviewMode};

    fn env(key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.trim().is_empty())
    }

    pub(super) fn settings_from_env() -> Option<Settings> {
        env("CODEFLOW_EVAL")?;
        let backend = env("CODEFLOW_EVAL_BACKEND").and_then(|b| BackendKind::from_setting(&b)).unwrap_or(BackendKind::Bundled);
        let model = env("CODEFLOW_EVAL_MODEL");
        let url = env("CODEFLOW_EVAL_URL");
        Some(Settings {
            backend: Some(backend),
            url_ollama: if backend == BackendKind::Ollama { url.clone() } else { None },
            url_openai: if backend == BackendKind::Openai { url } else { None },
            model_bundled: if backend == BackendKind::Bundled { model.clone() } else { None },
            model_ollama: if backend == BackendKind::Ollama { model.clone() } else { None },
            model_openai: if backend == BackendKind::Openai { model } else { None },
            ctx: env("CODEFLOW_EVAL_CTX").and_then(|c| c.parse().ok()),
            delegate: None,
            on_fail: OnFail::Review,
            unload: false,
            review_mode: ReviewMode::Local,
        })
    }

    #[tokio::test]
    #[ignore]
    async fn bench() {
        let Some(settings) = settings_from_env() else { return };
        let suites = env("CODEFLOW_EVAL_SUITES")
            .map(|list| {
                list.split(',')
                    .filter_map(|s| serde_json::from_value::<Suite>(serde_json::json!(s.trim())).ok())
                    .collect::<Vec<_>>()
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Suite::ALL.to_vec());
        let options = Options {
            runs: env("CODEFLOW_EVAL_RUNS").and_then(|r| r.parse().ok()).unwrap_or(1),
            suites,
            only: env("CODEFLOW_EVAL_ONLY").map(|o| o.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default(),
            app_version: None,
            adapter: None,
        };
        let report = run(&settings, &options, |p| eprintln!("[{}/{}] {}", p.done + 1, p.total, p.step), None).await;
        // The engines live in statics that a test process never drops: without this every run left
        // its llama-server behind, and the next one ran out of GPU memory ("Compute error").
        crate::localai::executor::shutdown().await;
        crate::localai::embedder::shutdown().await;
        let report = report.expect("the bench should run");
        eprintln!("\n{}", report.summary());
        let out = env("CODEFLOW_EVAL_OUT").map(std::path::PathBuf::from).unwrap_or_else(|| {
            std::env::temp_dir().join(format!("codeflow-eval-{}-{}.json", report.model.replace([':', '/'], "_"), chrono::Utc::now().timestamp()))
        });
        std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        eprintln!("report: {}", out.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planned_steps_count_runs_and_the_two_probes() {
        let all = Options { runs: 2, ..Options::default() };
        let tasks = TASKS.len();
        assert_eq!(planned_steps(&all), tasks * 2 + 2);
        let text_only = Options { suites: vec![Suite::Text], ..Options::default() };
        assert_eq!(planned_steps(&text_only), TASKS.iter().filter(|t| t.suite == Suite::Text).count());
        let one = Options { suites: vec![Suite::Agent], only: vec!["fix-single-file".into()], ..Options::default() };
        assert_eq!(planned_steps(&one), 1);
    }
}
