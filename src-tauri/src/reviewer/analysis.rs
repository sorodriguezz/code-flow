//! One review of a project: a local pipeline, run the way a company's CI runs its quality job.
//!
//! ```text
//!   prepare ─▶ build ─▶ test ─▶ SonarQube ─▶ Quality Gate
//!   (each optional — an empty command is a skipped stage)
//! ```
//!
//! - The local server is started **at the same time as the first stage**, not before it: its boot
//!   takes as long as a build, and a review that waited for one and then the other would take both.
//! - A failing prepare or build ends the review — there is nothing meaningful to analyse. A failing
//!   test does not, unless the user said so: a pipeline's `continueOnError` is what makes the report
//!   complete, and a red test is the most common reason to want one.
//! - Stage commands run through the platform's shell in the repository, with the login shell's `PATH`
//!   and `CODEFLOW_REPORTS_DIR` (see `detect`). The scanner runs on the downloaded JDK with its
//!   working directory and cache in the app's folder, and gets its token through the environment —
//!   never on the command line, where any process could read it.
//! - One review at a time. The local server's compute engine processes one report at a time anyway,
//!   and a second review would only queue behind the first while doubling the machine's load.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::api::SonarClient;
use super::reports::{self, TestReport};
use super::{detect, install, server, Settings};

/// The event a review reports on.
pub const EVENT: &str = "reviewer:run";

/// Lines of output a review keeps for when its panel is opened mid-run.
const LOG_KEEP: usize = 20_000;

/// The longest line kept — a minified bundle printed by a test runner is one line of megabytes.
const LINE_MAX: usize = 2_000;

/// What the scanner and server may take to process one report.
const CE_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Issues read back per review. The list is for working through, not for counting — the counts come
/// from the server's measures, which see every issue.
const ISSUE_LIMIT: usize = 2_000;

/// Test files and folders, kept out of the sources and handed to SonarQube as tests — the convention
/// of every ecosystem the Reviewer proposes commands for. A repository with its own
/// `sonar-project.properties` decides this itself.
const TEST_PATTERNS: &str = "**/*.test.*,**/*.spec.*,**/__tests__/**,**/__mocks__/**,**/test/**,**/tests/**,**/src/test/**,**/*_test.go,**/test_*.py,**/*_test.py,**/testdata/**,**/e2e/**";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StageId {
    Prepare,
    Build,
    Test,
    Sonar,
    Gate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StageStatus {
    Pending,
    Running,
    Ok,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: StageId,
    pub status: StageStatus,
    pub command: String,
    pub started_at: Option<i64>,
    pub duration_ms: Option<u64>,
    /// Why it failed, or a short result ("212/214").
    pub detail: Option<String>,
}

/// What the Revisor tab asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub project_id: String,
    pub repo_path: String,
    pub project_name: String,
    #[serde(default)]
    pub project_key: String,
    #[serde(default)]
    pub prepare: String,
    #[serde(default)]
    pub build: String,
    #[serde(default)]
    pub test: String,
    /// Extra `sonar.exclusions`, comma-separated.
    #[serde(default)]
    pub exclusions: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub stage: StageId,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateCondition {
    pub metric: String,
    pub comparator: String,
    pub threshold: String,
    pub actual: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    /// `OK`, `ERROR` or `NONE` (no gate applies).
    pub status: String,
    pub conditions: Vec<GateCondition>,
}

/// The project's measures, as the summary cards show them. Ratings are letters.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Measures {
    pub reliability_rating: Option<String>,
    pub security_rating: Option<String>,
    pub maintainability_rating: Option<String>,
    pub reliability_issues: Option<f64>,
    pub security_issues: Option<f64>,
    pub maintainability_issues: Option<f64>,
    pub coverage: Option<f64>,
    pub duplicated_lines_density: Option<f64>,
    pub ncloc: Option<f64>,
    pub debt_minutes: Option<f64>,
    pub lines_to_cover: Option<f64>,
    pub uncovered_lines: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: String,
    pub rule: String,
    pub message: String,
    /// Relative to the repository.
    pub path: String,
    pub line: Option<u32>,
    /// `reliability`, `security` or `maintainability`.
    pub quality: String,
    /// `blocker`, `high`, `medium`, `low` or `info`.
    pub severity: String,
    pub effort_minutes: Option<u32>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEntry {
    pub path: String,
    pub is_file: bool,
    pub coverage: Option<f64>,
    pub uncovered_lines: Option<f64>,
    pub lines_to_cover: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub project_id: String,
    pub project_key: String,
    pub started_at: i64,
    pub finished_at: i64,
    /// `passed`, `failed` (gate or tests), `error` (the review couldn't finish) or `cancelled`.
    pub status: String,
    pub error: Option<String>,
    pub stages: Vec<Stage>,
    pub gate: Option<Gate>,
    pub measures: Measures,
    pub issues: Vec<Issue>,
    pub issues_total: u64,
    pub tests: Option<TestReportSummary>,
    /// Top-level folders, then the files with the most uncovered lines.
    pub coverage: Vec<CoverageEntry>,
    pub commit: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub sonarqube_version: String,
}

/// [`TestReport`] as the summary keeps it — the same, serialisable both ways.
pub type TestReportSummary = TestReport;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub run_id: String,
    pub finished_at: i64,
    pub status: String,
    pub gate: Option<String>,
    pub coverage: Option<f64>,
    pub reliability_issues: Option<f64>,
    pub security_issues: Option<f64>,
    pub maintainability_issues: Option<f64>,
    pub tests_failed: Option<u32>,
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    #[serde(rename_all = "camelCase")]
    Started { run_id: String, project_id: String, project_key: String, stages: Vec<Stage>, started_at: i64 },
    #[serde(rename_all = "camelCase")]
    Stage { run_id: String, project_id: String, stage: Stage },
    #[serde(rename_all = "camelCase")]
    Log { run_id: String, project_id: String, lines: Vec<LogLine> },
    #[serde(rename_all = "camelCase")]
    Finished { run_id: String, project_id: String, summary: Box<RunSummary> },
}

/// The review in flight, readable by a panel opened after it started.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRun {
    pub run_id: String,
    pub project_id: String,
    pub project_key: String,
    pub started_at: i64,
    pub stages: Vec<Stage>,
    pub log: Vec<LogLine>,
}

struct Active {
    view: ActiveRun,
    cancel: CancellationToken,
    seq: u64,
}

static ACTIVE: LazyLock<Mutex<Option<Active>>> = LazyLock::new(|| Mutex::new(None));

fn active() -> std::sync::MutexGuard<'static, Option<Active>> {
    ACTIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn active_run() -> Option<ActiveRun> {
    active().as_ref().map(|a| a.view.clone())
}

pub fn cancel(run_id: &str) -> bool {
    match active().as_ref() {
        Some(run) if run.view.run_id == run_id => {
            run.cancel.cancel();
            true
        }
        _ => false,
    }
}

/// The process a review is waiting on right now — a stage's shell or the scanner — so the app's exit
/// can end it synchronously. Cancelling the token alone is not enough there: the task that would
/// kill it runs on a runtime that is about to stop.
static CURRENT_PID: Mutex<Option<u32>> = Mutex::new(None);

/// For the app's exit: a review's processes are in groups of their own and would outlive it.
pub fn cancel_all() {
    if let Some(run) = active().as_ref() {
        run.cancel.cancel();
    }
    let pid = CURRENT_PID.lock().ok().and_then(|slot| *slot);
    if let Some(pid) = pid {
        #[cfg(unix)]
        // SAFETY: the pid is a process group of our own (`proc::own_process_group`); a group that is
        // already gone answers ESRCH.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = crate::proc::std_command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Starts a review in the background and answers with its id; progress arrives on [`EVENT`].
pub fn start(app: AppHandle, settings: Settings, request: RunRequest) -> Result<String, String> {
    if !install::status().ready {
        return Err("The Reviewer isn't installed yet — download it in Settings › Reviewer.".into());
    }
    let repo = PathBuf::from(&request.repo_path);
    if !repo.is_dir() {
        return Err(format!("{} isn't a folder on this machine.", request.repo_path));
    }
    let project_key = detect::project_key(&repo, &request.project_name, &request.project_key);
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_ms();
    let stage = |id: StageId, command: &str| Stage {
        id,
        status: if command.trim().is_empty() && matches!(id, StageId::Prepare | StageId::Build | StageId::Test) {
            StageStatus::Skipped
        } else {
            StageStatus::Pending
        },
        command: command.trim().to_string(),
        started_at: None,
        duration_ms: None,
        detail: None,
    };
    let stages = vec![
        stage(StageId::Prepare, &request.prepare),
        stage(StageId::Build, &request.build),
        stage(StageId::Test, &request.test),
        stage(StageId::Sonar, "sonar-scanner"),
        stage(StageId::Gate, ""),
    ];
    let cancel = CancellationToken::new();
    {
        let mut slot = active();
        if let Some(running) = slot.as_ref() {
            return Err(format!("busy:{}", running.view.project_id));
        }
        *slot = Some(Active {
            view: ActiveRun {
                run_id: run_id.clone(),
                project_id: request.project_id.clone(),
                project_key: project_key.clone(),
                started_at,
                stages: stages.clone(),
                log: Vec::new(),
            },
            cancel: cancel.clone(),
            seq: 0,
        });
    }
    let _ = app.emit(
        EVENT,
        RunEvent::Started {
            run_id: run_id.clone(),
            project_id: request.project_id.clone(),
            project_key: project_key.clone(),
            stages,
            started_at,
        },
    );
    let id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let summary = pipeline(Some(&app), settings, request, id.clone(), project_key, started_at, cancel).await;
        let _ = save(&summary);
        *active() = None;
        let _ = app.emit(EVENT, RunEvent::Finished { run_id: id, project_id: summary.project_id.clone(), summary: Box::new(summary) });
    });
    Ok(run_id)
}

/// A review run to completion here and now, with nobody to report to — for the live test, which has
/// no window and no Tauri runtime of its own.
#[cfg(test)]
pub async fn run_now(settings: Settings, request: RunRequest) -> RunSummary {
    let repo = PathBuf::from(&request.repo_path);
    let project_key = detect::project_key(&repo, &request.project_name, &request.project_key);
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    let stage = |id: StageId, command: &str| Stage {
        id,
        status: if command.trim().is_empty() && matches!(id, StageId::Prepare | StageId::Build | StageId::Test) {
            StageStatus::Skipped
        } else {
            StageStatus::Pending
        },
        command: command.trim().to_string(),
        started_at: None,
        duration_ms: None,
        detail: None,
    };
    *active() = Some(Active {
        view: ActiveRun {
            run_id: run_id.clone(),
            project_id: request.project_id.clone(),
            project_key: project_key.clone(),
            started_at: now_ms(),
            stages: vec![
                stage(StageId::Prepare, &request.prepare),
                stage(StageId::Build, &request.build),
                stage(StageId::Test, &request.test),
                stage(StageId::Sonar, "sonar-scanner"),
                stage(StageId::Gate, ""),
            ],
            log: Vec::new(),
        },
        cancel: cancel.clone(),
        seq: 0,
    });
    let summary = pipeline(None, settings, request, run_id, project_key, now_ms(), cancel).await;
    let _ = save(&summary);
    *active() = None;
    summary
}

/// What a running review reports through — the event, and the copy a late panel reads.
struct Reporter<'a> {
    app: Option<&'a AppHandle>,
    run_id: String,
    project_id: String,
}

impl Reporter<'_> {
    fn stage(&self, stage: &Stage) {
        if let Some(run) = active().as_mut() {
            if let Some(slot) = run.view.stages.iter_mut().find(|s| s.id == stage.id) {
                *slot = stage.clone();
            }
        }
        if let Some(app) = self.app {
            let _ = app.emit(
                EVENT,
                RunEvent::Stage { run_id: self.run_id.clone(), project_id: self.project_id.clone(), stage: stage.clone() },
            );
        }
    }

    fn lines(&self, stage: StageId, texts: Vec<String>) {
        if texts.is_empty() {
            return;
        }
        let lines: Vec<LogLine> = {
            let mut slot = active();
            let Some(run) = slot.as_mut() else { return };
            let lines: Vec<LogLine> = texts
                .into_iter()
                .map(|text| {
                    run.seq += 1;
                    LogLine { seq: run.seq, stage, text }
                })
                .collect();
            run.view.log.extend(lines.iter().cloned());
            let excess = run.view.log.len().saturating_sub(LOG_KEEP);
            if excess > 0 {
                run.view.log.drain(..excess);
            }
            lines
        };
        if let Some(app) = self.app {
            let _ = app.emit(EVENT, RunEvent::Log { run_id: self.run_id.clone(), project_id: self.project_id.clone(), lines });
        }
    }

    fn line(&self, stage: StageId, text: impl Into<String>) {
        self.lines(stage, vec![text.into()]);
    }

    /// A line of CodeFlow's own, as a key the log translates (`cf:<key>`) — the tools' output is in
    /// whatever language they speak, but the app's own lines should be in the user's.
    fn note(&self, stage: StageId, key: &str) {
        self.line(stage, format!("cf:{key}"));
    }
}

/// Removes ANSI escapes — colour codes from test runners would otherwise reach the log as text.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c == '\r' {
            continue;
        }
        out.push(c);
    }
    if out.chars().count() > LINE_MAX {
        out = out.chars().take(LINE_MAX).collect::<String>() + " …";
    }
    out
}

enum Outcome {
    Exited(Option<i32>),
    Cancelled,
}

/// Runs `command` to completion, streaming its output to the log in batches.
async fn run_process(
    reporter: &Reporter<'_>,
    stage: StageId,
    mut command: tokio::process::Command,
    cancel: &CancellationToken,
) -> Result<Outcome, String> {
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    crate::proc::own_process_group(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Couldn't start it: {e}"))?;
    if let Ok(mut slot) = CURRENT_PID.lock() {
        *slot = child.id();
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if tx.send(strip_ansi(&line)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    // Output that isn't UTF-8: skip the line rather than end the stage's log.
                    Err(e) if e.kind() == std::io::ErrorKind::InvalidData => continue,
                    Err(_) => break,
                }
            }
        });
    }
    drop(tx);

    let mut batch: Vec<String> = Vec::new();
    let mut last = Instant::now();
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                reporter.lines(stage, std::mem::take(&mut batch));
                crate::ai_runs::kill_tree(&mut child).await;
                if let Ok(mut slot) = CURRENT_PID.lock() {
                    *slot = None;
                }
                return Ok(Outcome::Cancelled);
            }
            line = rx.recv() => match line {
                Some(line) => {
                    batch.push(line);
                    if batch.len() >= 200 || last.elapsed() >= Duration::from_millis(150) {
                        reporter.lines(stage, std::mem::take(&mut batch));
                        last = Instant::now();
                    }
                }
                None => break,
            },
            () = tokio::time::sleep(Duration::from_millis(150)), if !batch.is_empty() => {
                reporter.lines(stage, std::mem::take(&mut batch));
                last = Instant::now();
            }
        }
    }
    reporter.lines(stage, batch);
    let status = child.wait().await.map_err(|e| e.to_string());
    if let Ok(mut slot) = CURRENT_PID.lock() {
        *slot = None;
    }
    Ok(Outcome::Exited(status?.code()))
}

/// A user's stage command, through the platform's shell.
fn shell(command: &str, repo: &Path, env: &[(String, String)]) -> tokio::process::Command {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = crate::proc::command("cmd");
        // `/S /C "…"`: cmd strips the outer quotes and runs the rest exactly as typed, quotes inside
        // included — the only way to hand it a line with quoted paths in it.
        cmd.as_std_mut().raw_arg(format!("/D /S /C \"{command}\""));
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = crate::proc::command("/bin/sh");
        cmd.arg("-c").arg(command);
        cmd
    };
    cmd.current_dir(repo).envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    cmd
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

async fn pipeline(
    app: Option<&AppHandle>,
    settings: Settings,
    request: RunRequest,
    run_id: String,
    project_key: String,
    started_at: i64,
    cancel: CancellationToken,
) -> RunSummary {
    let reporter = Reporter { app, run_id: run_id.clone(), project_id: request.project_id.clone() };
    let repo = PathBuf::from(&request.repo_path);
    let _busy = server::Busy::new();
    let (commit, branch, dirty) = git_state(&repo);
    let mut summary = RunSummary {
        run_id: run_id.clone(),
        project_id: request.project_id.clone(),
        project_key: project_key.clone(),
        started_at,
        finished_at: 0,
        status: "error".into(),
        error: None,
        stages: active_run().map(|r| r.stages).unwrap_or_default(),
        gate: None,
        measures: Measures::default(),
        issues: Vec::new(),
        issues_total: 0,
        tests: None,
        coverage: Vec::new(),
        commit,
        branch,
        dirty,
        sonarqube_version: super::catalog::SONARQUBE.version.to_string(),
    };

    // The server boots while the project builds.
    let server_task = {
        let app = app.cloned();
        let settings = settings.clone();
        tauri::async_runtime::spawn(async move { server::start(app.as_ref(), &settings).await })
    };

    let reports_dir = install::work_dir(&project_key).join("reports");
    let _ = std::fs::remove_dir_all(&reports_dir);
    let _ = std::fs::create_dir_all(&reports_dir);
    let path = tokio::task::spawn_blocking(crate::shell_env::fresh_path).await.ok().flatten();
    let mut env: Vec<(String, String)> = vec![
        ("CODEFLOW_REPORTS_DIR".into(), reports_dir.to_string_lossy().into_owned()),
        ("JEST_JUNIT_OUTPUT_DIR".into(), reports_dir.to_string_lossy().into_owned()),
        // What a CI sets: test runners stop watching and prompting, and leave colour out.
        ("CI".into(), "true".into()),
        ("FORCE_COLOR".into(), "0".into()),
        ("NO_COLOR".into(), "1".into()),
    ];
    if let Some(path) = path {
        env.push(("PATH".into(), path));
    }

    let mut aborted: Option<&'static str> = None;
    let mut test_since: Option<SystemTime> = None;
    let mut tests_failed = false;
    let commands = [
        (StageId::Prepare, request.prepare.trim().to_string()),
        (StageId::Build, request.build.trim().to_string()),
        (StageId::Test, request.test.trim().to_string()),
    ];
    for (id, command) in commands {
        let index = summary.stages.iter().position(|s| s.id == id).unwrap_or(0);
        if command.is_empty() {
            continue;
        }
        if aborted.is_some() {
            summary.stages[index].status = StageStatus::Skipped;
            reporter.stage(&summary.stages[index]);
            continue;
        }
        summary.stages[index].status = StageStatus::Running;
        summary.stages[index].started_at = Some(now_ms());
        reporter.stage(&summary.stages[index]);
        reporter.line(id, format!("$ {command}"));
        if id == StageId::Test {
            test_since = Some(SystemTime::now());
        }
        let began = Instant::now();
        let outcome = run_process(&reporter, id, shell(&command, &repo, &env), &cancel).await;
        let stage = &mut summary.stages[index];
        stage.duration_ms = Some(began.elapsed().as_millis() as u64);
        match outcome {
            Ok(Outcome::Exited(Some(0))) => stage.status = StageStatus::Ok,
            Ok(Outcome::Exited(code)) => {
                stage.status = StageStatus::Failed;
                stage.detail = Some(format!("exit:{}", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into())));
                if id == StageId::Test {
                    tests_failed = true;
                    if !settings.config.continue_on_test_failure {
                        aborted = Some("tests");
                    }
                } else {
                    aborted = Some("stage");
                }
            }
            Ok(Outcome::Cancelled) => {
                stage.status = StageStatus::Cancelled;
                aborted = Some("cancelled");
            }
            Err(message) => {
                stage.status = StageStatus::Failed;
                stage.detail = Some(message.clone());
                reporter.line(id, message);
                aborted = Some("stage");
            }
        }
        reporter.stage(&summary.stages[index]);
    }

    // What the tests left behind — read whatever happens next, so a review that stops at the tests
    // still lists the failures.
    let mut coverage = reports::Coverage::default();
    let mut junit_files = Vec::new();
    if test_since.is_some() {
        let roots: [&Path; 2] = [&reports_dir, &repo];
        junit_files = reports::find_junit(&roots, test_since);
        coverage = reports::find_coverage(&roots, test_since);
        let report = reports::read_junit(&junit_files);
        if report.files > 0 {
            if report.failed > 0 {
                tests_failed = true;
            }
            if let Some(stage) = summary.stages.iter_mut().find(|s| s.id == StageId::Test) {
                stage.detail = Some(format!("{}/{}", report.passed, report.total));
            }
            if let Some(stage) = summary.stages.iter().find(|s| s.id == StageId::Test) {
                reporter.stage(stage);
            }
        }
        summary.tests = Some(report);
    }

    let sonar = summary.stages.iter().position(|s| s.id == StageId::Sonar).unwrap_or(3);
    let gate = summary.stages.iter().position(|s| s.id == StageId::Gate).unwrap_or(4);
    if aborted.is_none() && cancel.is_cancelled() {
        aborted = Some("cancelled");
    }
    if let Some(reason) = aborted {
        for index in [sonar, gate] {
            summary.stages[index].status = if reason == "cancelled" { StageStatus::Cancelled } else { StageStatus::Skipped };
            reporter.stage(&summary.stages[index]);
        }
        summary.status = match reason {
            "cancelled" => "cancelled",
            "tests" => "failed",
            _ => "error",
        }
        .into();
        summary.finished_at = now_ms();
        return summary;
    }

    // SonarQube.
    summary.stages[sonar].status = StageStatus::Running;
    summary.stages[sonar].started_at = Some(now_ms());
    reporter.stage(&summary.stages[sonar]);
    let began = Instant::now();
    if !matches!(server::status(), server::ServerStatus::Running { .. }) {
        reporter.note(StageId::Sonar, "waitingServer");
    }
    let scanned = tokio::select! {
        biased;
        () = cancel.cancelled() => Err("cancelled".to_string()),
        started = server_task => match started {
            Ok(Ok(_)) => scan(&reporter, &repo, &request, &project_key, &coverage, &junit_files, &cancel).await,
            Ok(Err(message)) => Err(message),
            Err(e) => Err(e.to_string()),
        },
    };
    summary.stages[sonar].duration_ms = Some(began.elapsed().as_millis() as u64);
    let client = match scanned {
        Ok(client) => {
            summary.stages[sonar].status = StageStatus::Ok;
            reporter.stage(&summary.stages[sonar]);
            client
        }
        Err(message) => {
            let cancelled = message == "cancelled" || cancel.is_cancelled();
            summary.stages[sonar].status = if cancelled { StageStatus::Cancelled } else { StageStatus::Failed };
            summary.stages[sonar].detail = (!cancelled).then(|| message.clone());
            reporter.stage(&summary.stages[sonar]);
            if !cancelled {
                reporter.line(StageId::Sonar, message.clone());
            }
            summary.stages[gate].status = if cancelled { StageStatus::Cancelled } else { StageStatus::Skipped };
            reporter.stage(&summary.stages[gate]);
            summary.status = if cancelled { "cancelled" } else { "error" }.into();
            summary.error = (!cancelled).then_some(message);
            summary.finished_at = now_ms();
            return summary;
        }
    };

    // The Quality Gate, and what goes on the report.
    summary.stages[gate].status = StageStatus::Running;
    summary.stages[gate].started_at = Some(now_ms());
    reporter.stage(&summary.stages[gate]);
    let began = Instant::now();
    match results(&client, &project_key).await {
        Ok(found) => {
            summary.gate = Some(found.gate.clone());
            summary.measures = found.measures;
            summary.issues = found.issues;
            summary.issues_total = found.issues_total;
            summary.coverage = found.coverage;
            let passed = found.gate.status != "ERROR";
            summary.stages[gate].status = if passed { StageStatus::Ok } else { StageStatus::Failed };
            summary.stages[gate].detail = Some(found.gate.status.clone());
            summary.status = if passed && !tests_failed { "passed" } else { "failed" }.into();
        }
        Err(message) => {
            summary.stages[gate].status = StageStatus::Failed;
            summary.stages[gate].detail = Some(message.clone());
            summary.status = "error".into();
            summary.error = Some(message);
        }
    }
    summary.stages[gate].duration_ms = Some(began.elapsed().as_millis() as u64);
    reporter.stage(&summary.stages[gate]);
    summary.finished_at = now_ms();
    summary
}

/// Runs the scanner and waits for the server to process its report. Answers with a client signed in
/// to the local server, for reading the results.
async fn scan(
    reporter: &Reporter<'_>,
    repo: &Path,
    request: &RunRequest,
    project_key: &str,
    coverage: &reports::Coverage,
    junit_files: &[PathBuf],
    cancel: &CancellationToken,
) -> Result<SonarClient, String> {
    let (client, token) = server::signed_in().await?;
    let java = install::java().ok_or("The JDK isn't installed.")?;
    let scanner_home = install::scanner_home();
    let work = install::work_dir(project_key).join("scanner");
    let user_home = install::scanner_user_home();
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&user_home).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(work.join("report-task.txt"));

    let own = detect::project_properties(repo);
    let mut properties: Vec<(String, String)> = Vec::new();
    if !own.contains_key("sonar.projectKey") {
        properties.push(("sonar.projectKey".into(), project_key.to_string()));
    }
    if !own.contains_key("sonar.projectName") {
        properties.push(("sonar.projectName".into(), request.project_name.clone()));
    }
    if !own.contains_key("sonar.sources") {
        let mut exclusions = TEST_PATTERNS.to_string();
        for extra in request.exclusions.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            exclusions.push(',');
            exclusions.push_str(extra);
        }
        properties.push(("sonar.sources".into(), ".".into()));
        properties.push(("sonar.tests".into(), ".".into()));
        properties.push(("sonar.test.inclusions".into(), TEST_PATTERNS.into()));
        properties.push(("sonar.exclusions".into(), exclusions));
    }
    for (key, value) in coverage.properties() {
        if !own.contains_key(&key) {
            properties.push((key, value));
        }
    }
    let junit_dirs = reports::junit_dirs(junit_files);
    if !junit_dirs.is_empty() && !own.contains_key("sonar.junit.reportPaths") {
        properties.push((
            "sonar.junit.reportPaths".into(),
            junit_dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>().join(","),
        ));
    }
    if !own.contains_key("sonar.java.binaries") && detect::has_java(repo) {
        let binaries = detect::java_binaries(repo);
        let value = if binaries.is_empty() {
            // The Java analyzer refuses to start without classes. An empty folder lets it run on the
            // sources alone, with the rules that need bytecode off — said in the log.
            reporter.note(StageId::Sonar, "noJavaClasses");
            let empty = install::work_dir(project_key).join("no-classes");
            let _ = std::fs::create_dir_all(&empty);
            vec![empty]
        } else {
            binaries
        };
        properties.push((
            "sonar.java.binaries".into(),
            value.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>().join(","),
        ));
    }
    if repo.join(".git").exists() {
        properties.push(("sonar.scm.provider".into(), "git".into()));
    }
    properties.push(("sonar.working.directory".into(), work.to_string_lossy().into_owned()));
    properties.push(("sonar.userHome".into(), user_home.to_string_lossy().into_owned()));
    properties.push(("sonar.scanner.skipJreProvisioning".into(), "true".into()));

    let mut command = crate::proc::command(&java);
    command
        .arg("-Djava.awt.headless=true")
        .arg("-Djdk.http.auth.tunneling.disabledSchemes=")
        .arg("-classpath")
        .arg(scanner_home.join(super::catalog::scanner_jar()))
        .arg(format!("-Dscanner.home={}", scanner_home.display()))
        .arg(format!("-Dproject.home={}", repo.display()))
        .arg("org.sonarsource.scanner.cli.Main");
    for (key, value) in &properties {
        command.arg(format!("-D{key}={value}"));
    }
    command
        .current_dir(repo)
        .env("SONAR_TOKEN", token)
        .env("SONAR_HOST_URL", client.base())
        .env_remove("JAVA_TOOL_OPTIONS")
        .env_remove("SONAR_SCANNER_OPTS");
    reporter.line(StageId::Sonar, format!("$ sonar-scanner -Dsonar.projectKey={project_key}"));
    match run_process(reporter, StageId::Sonar, command, cancel).await? {
        Outcome::Cancelled => return Err("cancelled".into()),
        Outcome::Exited(Some(0)) => {}
        Outcome::Exited(code) => {
            return Err(format!(
                "scanner:{}",
                code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
            ))
        }
    }

    let task = std::fs::read_to_string(work.join("report-task.txt"))
        .ok()
        .and_then(|text| text.lines().find_map(|l| l.strip_prefix("ceTaskId=").map(str::to_string)))
        .ok_or("The scanner finished without leaving its report-task.txt.")?;
    reporter.note(StageId::Sonar, "processing");
    let began = Instant::now();
    loop {
        if cancel.is_cancelled() {
            let _ = client.post("api/ce/cancel", &[("id", task.clone())]).await;
            return Err("cancelled".into());
        }
        if began.elapsed() > CE_TIMEOUT {
            return Err("The server took more than twenty minutes to process the analysis.".into());
        }
        let value = client.get("api/ce/task", &[("id", task.clone())]).await.map_err(String::from)?;
        let state = value.get("task").and_then(|t| t.get("status")).and_then(Value::as_str).unwrap_or_default();
        match state {
            "SUCCESS" => break,
            "FAILED" | "CANCELED" => {
                let reason = value
                    .get("task")
                    .and_then(|t| t.get("errorMessage"))
                    .and_then(Value::as_str)
                    .unwrap_or("no reason given");
                return Err(format!("The server couldn't process the analysis: {reason}"));
            }
            _ => tokio::time::sleep(Duration::from_millis(800)).await,
        }
    }
    server::touch();
    Ok(client)
}

struct Found {
    gate: Gate,
    measures: Measures,
    issues: Vec<Issue>,
    issues_total: u64,
    coverage: Vec<CoverageEntry>,
}

const METRICS: &[&str] = &[
    "software_quality_reliability_rating",
    "software_quality_security_rating",
    "software_quality_maintainability_rating",
    "reliability_rating",
    "security_rating",
    "sqale_rating",
    "software_quality_reliability_issues",
    "software_quality_security_issues",
    "software_quality_maintainability_issues",
    "bugs",
    "vulnerabilities",
    "code_smells",
    "coverage",
    "duplicated_lines_density",
    "ncloc",
    "software_quality_maintainability_remediation_effort",
    "sqale_index",
    "lines_to_cover",
    "uncovered_lines",
];

async fn results(client: &SonarClient, key: &str) -> Result<Found, String> {
    let status = client
        .get("api/qualitygates/project_status", &[("projectKey", key.to_string())])
        .await
        .map_err(String::from)?;
    let project = status.get("projectStatus").cloned().unwrap_or(Value::Null);
    let gate = Gate {
        status: project.get("status").and_then(Value::as_str).unwrap_or("NONE").to_string(),
        conditions: project
            .get("conditions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|c| GateCondition {
                metric: c.get("metricKey").and_then(Value::as_str).unwrap_or_default().to_string(),
                comparator: c.get("comparator").and_then(Value::as_str).unwrap_or_default().to_string(),
                threshold: c.get("errorThreshold").and_then(Value::as_str).unwrap_or_default().to_string(),
                actual: c.get("actualValue").and_then(Value::as_str).map(str::to_string),
                status: c.get("status").and_then(Value::as_str).unwrap_or_default().to_string(),
            })
            .collect(),
    };

    let known: Vec<String> = client
        .get_all("api/metrics/search", &[], "metrics", 5_000)
        .await
        .map_err(String::from)?
        .iter()
        .filter_map(|m| m.get("key").and_then(Value::as_str).map(str::to_string))
        .collect();
    let wanted: Vec<&str> = METRICS.iter().copied().filter(|m| known.iter().any(|k| k == m)).collect();
    let measured = client
        .get("api/measures/component", &[("component", key.to_string()), ("metricKeys", wanted.join(","))])
        .await
        .map_err(String::from)?;
    let values: std::collections::HashMap<String, String> = measured
        .get("component")
        .and_then(|c| c.get("measures"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m.get("metric")?.as_str()?.to_string(), m.get("value")?.as_str()?.to_string())))
        .collect();
    let measures = measures_from(&values);

    let raw = client
        .get_all("api/issues/search", &[("components", key.to_string()), ("resolved", "false".into())], "issues", ISSUE_LIMIT)
        .await
        .map_err(String::from)?;
    let total = client
        .get("api/issues/search", &[("components", key.to_string()), ("resolved", "false".into()), ("ps", "1".into())])
        .await
        .ok()
        .and_then(|v| v.get("paging").and_then(|p| p.get("total")).and_then(Value::as_u64))
        .unwrap_or(raw.len() as u64);
    let mut issues: Vec<Issue> = raw.iter().filter_map(|i| issue_from(i, key)).collect();
    issues.sort_by(|a, b| severity_rank(&a.severity).cmp(&severity_rank(&b.severity)).then(a.path.cmp(&b.path)).then(a.line.cmp(&b.line)));

    let mut coverage = Vec::new();
    for (strategy, extra) in [
        ("children", vec![]),
        (
            "leaves",
            vec![
                ("qualifiers", "FIL".to_string()),
                ("s", "metric".to_string()),
                ("metricSort", "uncovered_lines".to_string()),
                ("asc", "false".to_string()),
                ("metricSortFilter", "withMeasuresOnly".to_string()),
            ],
        ),
    ] {
        let mut query = vec![
            ("component", key.to_string()),
            ("metricKeys", "coverage,uncovered_lines,lines_to_cover".to_string()),
            ("strategy", strategy.to_string()),
            ("ps", if strategy == "children" { "100" } else { "15" }.to_string()),
        ];
        query.extend(extra);
        if let Ok(tree) = client.get("api/measures/component_tree", &query).await {
            for component in tree.get("components").and_then(Value::as_array).into_iter().flatten() {
                let metric = |name: &str| {
                    component
                        .get("measures")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .find(|m| m.get("metric").and_then(Value::as_str) == Some(name))
                        .and_then(|m| m.get("value").and_then(Value::as_str))
                        .and_then(|v| v.parse::<f64>().ok())
                };
                let lines = metric("lines_to_cover");
                if strategy == "leaves" && lines.unwrap_or(0.0) == 0.0 {
                    continue;
                }
                coverage.push(CoverageEntry {
                    path: component.get("path").or_else(|| component.get("name")).and_then(Value::as_str).unwrap_or_default().to_string(),
                    is_file: component.get("qualifier").and_then(Value::as_str) == Some("FIL"),
                    coverage: metric("coverage"),
                    uncovered_lines: metric("uncovered_lines"),
                    lines_to_cover: lines,
                });
            }
        }
    }
    Ok(Found { gate, measures, issues, issues_total: total, coverage })
}

fn rating_letter(value: Option<&String>) -> Option<String> {
    let number: f64 = value?.parse().ok()?;
    let index = (number.round() as i64).clamp(1, 5) as u8;
    Some(((b'A' + index - 1) as char).to_string())
}

pub fn measures_from(values: &std::collections::HashMap<String, String>) -> Measures {
    let number = |key: &str| values.get(key).and_then(|v| v.parse::<f64>().ok());
    let first = |keys: &[&str]| keys.iter().find_map(|k| number(k));
    let rating = |keys: &[&str]| keys.iter().find_map(|k| rating_letter(values.get(*k)));
    Measures {
        reliability_rating: rating(&["software_quality_reliability_rating", "reliability_rating"]),
        security_rating: rating(&["software_quality_security_rating", "security_rating"]),
        maintainability_rating: rating(&["software_quality_maintainability_rating", "sqale_rating"]),
        reliability_issues: first(&["software_quality_reliability_issues", "bugs"]),
        security_issues: first(&["software_quality_security_issues", "vulnerabilities"]),
        maintainability_issues: first(&["software_quality_maintainability_issues", "code_smells"]),
        coverage: number("coverage"),
        duplicated_lines_density: number("duplicated_lines_density"),
        ncloc: number("ncloc"),
        debt_minutes: first(&["software_quality_maintainability_remediation_effort", "sqale_index"]),
        lines_to_cover: number("lines_to_cover"),
        uncovered_lines: number("uncovered_lines"),
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "blocker" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    }
}

/// An issue in either of SonarQube's two vocabularies: the impacts of its multi-quality mode (the
/// default), or the type and severity of the standard experience.
pub fn issue_from(value: &Value, project_key: &str) -> Option<Issue> {
    let impacts: Vec<(String, String)> = value
        .get("impacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|i| {
            Some((
                i.get("softwareQuality")?.as_str()?.to_ascii_lowercase(),
                i.get("severity")?.as_str()?.to_ascii_lowercase(),
            ))
        })
        .collect();
    let (quality, severity) = match impacts.into_iter().min_by_key(|(_, s)| severity_rank(s)) {
        Some(found) => found,
        None => {
            let quality = match value.get("type").and_then(Value::as_str) {
                Some("BUG") => "reliability",
                Some("VULNERABILITY") => "security",
                _ => "maintainability",
            };
            let severity = match value.get("severity").and_then(Value::as_str) {
                Some("BLOCKER") => "blocker",
                Some("CRITICAL") => "high",
                Some("MAJOR") => "medium",
                Some("MINOR") => "low",
                _ => "info",
            };
            (quality.to_string(), severity.to_string())
        }
    };
    let component = value.get("component")?.as_str()?;
    let path = component.strip_prefix(&format!("{project_key}:")).unwrap_or(component).to_string();
    let effort_minutes = value.get("effort").and_then(Value::as_str).and_then(effort_minutes);
    Some(Issue {
        key: value.get("key")?.as_str()?.to_string(),
        rule: value.get("rule").and_then(Value::as_str).unwrap_or_default().to_string(),
        message: value.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
        path,
        line: value.get("line").and_then(Value::as_u64).map(|l| l as u32),
        quality,
        severity,
        effort_minutes,
        tags: value
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| t.as_str().map(str::to_string))
            .collect(),
    })
}

/// SonarQube's effort strings: `5min`, `1h30min`, `2d` (a day is eight hours there).
fn effort_minutes(text: &str) -> Option<u32> {
    let mut total = 0u32;
    let mut number = String::new();
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            number.push(c);
            continue;
        }
        let value: u32 = number.parse().ok()?;
        number.clear();
        match c {
            'd' => total += value * 8 * 60,
            'h' => total += value * 60,
            'm' => {
                // "min"
                while chars.peek().is_some_and(|n| n.is_ascii_alphabetic()) {
                    chars.next();
                }
                total += value;
            }
            _ => return None,
        }
        any = true;
    }
    any.then_some(total)
}

fn git_state(repo: &Path) -> (Option<String>, Option<String>, bool) {
    let Ok(repository) = git2::Repository::open(repo) else { return (None, None, false) };
    let head = repository.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().map(str::to_string));
    let commit = head.and_then(|h| h.peel_to_commit().ok()).map(|c| c.id().to_string()[..7].to_string());
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false).include_ignored(false);
    let dirty = repository.statuses(Some(&mut options)).map(|s| !s.is_empty()).unwrap_or(false);
    (commit, branch, dirty)
}

fn save(summary: &RunSummary) -> Result<(), String> {
    let dir = install::runs_dir(&summary.project_key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("last.json"), serde_json::to_string(summary).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut history = history(&summary.project_key);
    history.push(HistoryEntry {
        run_id: summary.run_id.clone(),
        finished_at: summary.finished_at,
        status: summary.status.clone(),
        gate: summary.gate.as_ref().map(|g| g.status.clone()),
        coverage: summary.measures.coverage,
        reliability_issues: summary.measures.reliability_issues,
        security_issues: summary.measures.security_issues,
        maintainability_issues: summary.measures.maintainability_issues,
        tests_failed: summary.tests.as_ref().map(|t| t.failed),
        commit: summary.commit.clone(),
    });
    let excess = history.len().saturating_sub(30);
    history.drain(..excess);
    std::fs::write(dir.join("history.json"), serde_json::to_string(&history).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn last(project_key: &str) -> Option<RunSummary> {
    let text = std::fs::read_to_string(install::runs_dir(project_key).join("last.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn history(project_key: &str) -> Vec<HistoryEntry> {
    std::fs::read_to_string(install::runs_dir(project_key).join("history.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mqr_impacts_win_over_the_standard_vocabulary() {
        let value = serde_json::json!({
            "key": "k1", "rule": "typescript:S1854", "severity": "MAJOR", "type": "CODE_SMELL",
            "component": "demo-1:src/orders.ts", "line": 20, "message": "Remove this useless assignment.",
            "effort": "1min", "tags": ["unused"],
            "impacts": [{"softwareQuality": "MAINTAINABILITY", "severity": "MEDIUM"}, {"softwareQuality": "RELIABILITY", "severity": "HIGH"}]
        });
        let issue = issue_from(&value, "demo-1").unwrap();
        assert_eq!(issue.path, "src/orders.ts");
        assert_eq!(issue.quality, "reliability");
        assert_eq!(issue.severity, "high");
        assert_eq!(issue.line, Some(20));
        assert_eq!(issue.effort_minutes, Some(1));
    }

    #[test]
    fn the_standard_vocabulary_still_maps() {
        let value = serde_json::json!({ "key": "k", "severity": "CRITICAL", "type": "VULNERABILITY", "component": "p:a.py" });
        let issue = issue_from(&value, "p").unwrap();
        assert_eq!((issue.quality.as_str(), issue.severity.as_str()), ("security", "high"));
    }

    #[test]
    fn effort_strings_become_minutes() {
        assert_eq!(effort_minutes("5min"), Some(5));
        assert_eq!(effort_minutes("1h30min"), Some(90));
        assert_eq!(effort_minutes("2d"), Some(960));
        assert_eq!(effort_minutes(""), None);
    }

    #[test]
    fn ratings_become_letters_and_mqr_metrics_come_first() {
        let values: std::collections::HashMap<String, String> = [
            ("software_quality_reliability_rating", "3.0"),
            ("reliability_rating", "1.0"),
            ("sqale_rating", "1.0"),
            ("coverage", "71.4"),
            ("bugs", "4"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let measures = measures_from(&values);
        assert_eq!(measures.reliability_rating.as_deref(), Some("C"));
        assert_eq!(measures.maintainability_rating.as_deref(), Some("A"));
        assert_eq!(measures.security_rating, None);
        assert_eq!(measures.coverage, Some(71.4));
        assert_eq!(measures.reliability_issues, Some(4.0));
    }

    /// The whole thing against a real SonarQube: downloads the JDK and the scanner, starts the server,
    /// applies the strict rules and reviews a repository.
    ///
    /// ```sh
    /// CODEFLOW_HOME=/tmp/cf-reviewer-live CODEFLOW_TEST_REVIEWER_REPO=/path/to/a/small/repo \
    ///   cargo test --lib reviewer::analysis::tests::a_review_runs_end_to_end -- --ignored --nocapture
    /// ```
    ///
    /// `CODEFLOW_HOME` is required, so the run can never land in a developer's real app data. Put a
    /// verified `sonarqube-<version>.zip` in `$CODEFLOW_HOME/state/reviewer/downloads/` first to skip
    /// its 900 MB download — a file there is taken as already checked, which is the rule.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "downloads a JDK and runs SonarQube"]
    async fn a_review_runs_end_to_end() {
        assert!(std::env::var_os("CODEFLOW_HOME").is_some(), "set CODEFLOW_HOME to a scratch folder");
        let repo = std::env::var("CODEFLOW_TEST_REVIEWER_REPO").expect("CODEFLOW_TEST_REVIEWER_REPO");
        let test_command = std::env::var("CODEFLOW_TEST_REVIEWER_TEST").unwrap_or_default();
        println!("reviewer root: {}", install::root().display());

        let status = install::install(None, CancellationToken::new()).await.expect("install");
        assert!(status.ready, "{status:?}");

        let settings = Settings::default();
        let started = std::time::Instant::now();
        let running = server::start(None, &settings).await.expect("start");
        println!("server: {running:?} in {:?}", started.elapsed());
        let report = super::super::rules::last_report().expect("rules applied at start");
        println!("rules: {} languages, {} activated, gate {}", report.languages, report.activated, report.gate);
        assert!(report.languages > 10);
        assert_eq!(report.gate, super::super::rules::STRICT_GATE);

        let summary = run_now(
            settings.clone(),
            RunRequest {
                project_id: "live".into(),
                repo_path: repo.clone(),
                project_name: "Reviewer live test".into(),
                project_key: String::new(),
                prepare: String::new(),
                build: String::new(),
                test: test_command,
                exclusions: String::new(),
            },
        )
        .await;
        println!("status: {} error: {:?}", summary.status, summary.error);
        for stage in &summary.stages {
            println!("  {:?} {:?} {:?} {:?}", stage.id, stage.status, stage.duration_ms, stage.detail);
        }
        println!("gate: {:?}", summary.gate);
        println!("measures: {:?}", summary.measures);
        println!("issues: {} (showing {})", summary.issues_total, summary.issues.len());
        for issue in summary.issues.iter().take(10) {
            println!("  {} {} {}:{:?} {}", issue.severity, issue.quality, issue.path, issue.line, issue.message);
        }
        println!("tests: {:?}", summary.tests.as_ref().map(|t| (t.total, t.failed, t.files)));
        println!("coverage: {:?}", summary.coverage);
        assert!(summary.gate.is_some(), "the gate was read");
        assert!(matches!(summary.status.as_str(), "passed" | "failed"), "{}", summary.status);
        assert!(last(&summary.project_key).is_some());
        assert!(!PathBuf::from(&repo).join(".scannerwork").exists(), "nothing written into the repository");

        server::stop().await.unwrap();
        assert_eq!(server::status(), server::ServerStatus::Stopped);
    }

    #[test]
    fn ansi_is_stripped_and_long_lines_cut() {
        assert_eq!(strip_ansi("\u{1b}[32m✓\u{1b}[39m passed\r"), "✓ passed");
        assert!(strip_ansi(&"x".repeat(5_000)).ends_with(" …"));
    }
}
