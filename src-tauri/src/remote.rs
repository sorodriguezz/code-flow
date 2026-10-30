use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::git::merge::{OperationKind, OPERATION_CONFLICTS_PREFIX};
use crate::proc;

/// All clone/fetch/pull/push runs go through the system `git` binary so the user's
/// existing SSH keys, HTTPS credential manager, and global git config are reused as-is —
/// never through a generic shell-exec surface exposed to the frontend.
///
/// # They fail instead of waiting
///
/// None of these runs has a terminal, and anything that waits on one waits forever: an HTTPS
/// username prompt, ssh asking whether to trust a host it has never seen, a key's passphrase with no
/// agent to unlock it, a TCP connect to a host behind a dropped VPN. Each used to leave the button
/// spinning for the rest of the session. So every run gets `GIT_TERMINAL_PROMPT=0`, ssh in batch
/// mode with a connect timeout (see [`ssh_command`]), no stdin, and a deadline after which the whole
/// process group is killed (see [`timeout_for`]). What comes back is classified (see
/// [`classify_failure`]) so the UI can say *which* of those it was and what to do about it.
///
/// Credential helpers keep working — the macOS keychain, Git Credential Manager and friends are not
/// prompts on a terminal — and so does agent-based ssh: batch mode only forbids *asking*.

#[derive(Clone, Serialize)]
pub struct GitProgressEvent {
    pub op: String,
    pub line: String,
}

#[derive(Clone, Serialize)]
pub struct GitDoneEvent {
    pub op: String,
    pub success: bool,
    pub message: String,
}

/// Marks a failure [`classify_failure`] recognised. The code follows the prefix up to the first
/// newline (`auth_required`, `network`, …); git's own text follows that, for anyone who wants it.
pub const REMOTE_FAILURE_PREFIX: &str = "GIT_REMOTE: ";

/// Marks a pull git refused because the branches diverged and nothing says how to reconcile them
/// (git ≥ 2.33 asks instead of merging). The UI answers with a choice: merge, rebase or
/// fast-forward only.
pub const PULL_DIVERGED_PREFIX: &str = "PULL_DIVERGED: ";

/// Marks a push the remote rejected as not a fast-forward — the branch was rewritten (an amend) or
/// the remote has commits this one does not. The UI offers a force push *with lease* from here.
pub const PUSH_REJECTED_PREFIX: &str = "PUSH_REJECTED: ";

/// Why a remote operation failed, when it is one of the failures with a sentence of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteFailure {
    /// HTTPS wanted a username and password and nothing could supply them: no credential helper,
    /// or one with nothing stored for this host.
    AuthRequired,
    /// Credentials were offered and refused.
    AuthFailed,
    /// SSH found no key the server accepts — which is also what a passphrase-protected key looks
    /// like when no agent holds it, since batch mode cannot ask for the passphrase.
    SshKey,
    /// SSH does not know the host's key (or it changed), and will not trust it without asking.
    HostKey,
    /// The host could not be reached at all.
    Network,
    /// The server answered and has no such repository — or will not admit to it.
    RepoNotFound,
    /// Our own deadline ran out — see [`timeout_for`].
    Timeout,
    /// A force push *with lease* refused because the remote moved since this clone last looked.
    StaleLease,
    /// This git is older than `--force-if-includes` (2.30), which a safe force push needs.
    GitTooOld,
    /// The user pressed Cancel (`git_cancel_remote_op`). Not a failure: the UI says nothing.
    Cancelled,
}

impl RemoteFailure {
    pub fn code(self) -> &'static str {
        match self {
            RemoteFailure::AuthRequired => "auth_required",
            RemoteFailure::AuthFailed => "auth_failed",
            RemoteFailure::SshKey => "ssh_key",
            RemoteFailure::HostKey => "host_key",
            RemoteFailure::Network => "network",
            RemoteFailure::RepoNotFound => "repo_not_found",
            RemoteFailure::Timeout => "timeout",
            RemoteFailure::StaleLease => "stale_lease",
            RemoteFailure::GitTooOld => "git_too_old",
            RemoteFailure::Cancelled => "cancelled",
        }
    }
}

/// Recognises the common ways a remote operation fails, from git's (and ssh's, and curl's) output.
///
/// Order matters where the texts overlap: an ssh failure also says "Could not read from remote
/// repository … make sure … the repository exists", so the ssh causes are checked before "not
/// found", and that generic line is never matched on its own.
pub fn classify_failure(output: &str) -> Option<RemoteFailure> {
    let o = output.to_lowercase();
    let has = |needle: &str| o.contains(needle);

    if has("unknown option") && has("force-if-includes") {
        return Some(RemoteFailure::GitTooOld);
    }
    if has("(stale info)") || has("remote ref updated since checkout") {
        return Some(RemoteFailure::StaleLease);
    }
    if has("host key verification failed")
        || has("remote host identification has changed")
        || has("no matching host key type")
    {
        return Some(RemoteFailure::HostKey);
    }
    if has("permission denied (publickey")
        || has("permission denied (password")
        || has("too many authentication failures")
    {
        return Some(RemoteFailure::SshKey);
    }
    if has("terminal prompts disabled") || has("could not read username") || has("could not read password") {
        return Some(RemoteFailure::AuthRequired);
    }
    if has("authentication failed")
        || has("invalid username or password")
        || has("http basic: access denied")
        || has("the requested url returned error: 401")
        || has("the requested url returned error: 403")
        || (has("permission to ") && has(" denied to "))
    {
        return Some(RemoteFailure::AuthFailed);
    }
    if has("repository not found")
        || (has("repository '") && has("' not found"))
        || has("the requested url returned error: 404")
        || has("does not appear to be a git repository")
    {
        return Some(RemoteFailure::RepoNotFound);
    }
    if has("could not resolve host")
        || has("could not resolve hostname")
        || has("failed to connect to")
        || has("network is unreachable")
        || has("no route to host")
        || has("connection timed out")
        || has("operation timed out")
        || has("connection refused")
        || has("temporary failure in name resolution")
        || has("name or service not known")
        || has("nodename nor servname provided")
    {
        return Some(RemoteFailure::Network);
    }
    None
}

/// A pull git would not do because the branches have diverged and nothing configured says whether
/// to merge or rebase — or because the configuration says "fast-forward only" and it cannot.
pub fn is_divergent_pull(output: &str) -> bool {
    let o = output.to_lowercase();
    o.contains("need to specify how to reconcile divergent branches")
        || o.contains("you have divergent branches")
        || o.contains("not possible to fast-forward")
}

/// A push the remote turned down because it is not a fast-forward. Deliberately *not* the lease
/// rejections (`stale info`, `remote ref updated since checkout`): those are the force push
/// refusing to overwrite work, and answering them with another force push would defeat it.
pub fn is_push_rejected(output: &str) -> bool {
    let o = output.to_lowercase();
    (o.contains("[rejected]") && (o.contains("(non-fast-forward)") || o.contains("(fetch first)")))
        || o.contains("updates were rejected because the tip of your current branch is behind")
        || o.contains("updates were rejected because the remote contains work")
}

/// A pull, rebase step or sequencer command that *started* and stopped on conflicts — which leaves
/// the repository mid-operation, for the conflicts banner rather than for an error toast. The kind
/// of operation it stopped in.
pub fn stopped_on_conflicts(output: &str) -> Option<&'static str> {
    let o = output.to_lowercase();
    if o.contains("git rebase --continue") || (o.contains("could not apply") && o.contains("rebase")) {
        return Some(OperationKind::Rebase.as_str());
    }
    if o.contains("git cherry-pick --continue") || (o.contains("could not apply") && o.contains("cherry-pick")) {
        return Some(OperationKind::CherryPick.as_str());
    }
    if o.contains("git revert --continue") || o.contains("could not revert") {
        return Some(OperationKind::Revert.as_str());
    }
    if o.contains("automatic merge failed") {
        return Some(OperationKind::Merge.as_str());
    }
    None
}

/// The error a failed run reports: tagged when it is one of the cases the UI answers with a choice
/// or a specific sentence, git's own text otherwise.
///
/// `output` is everything the run printed, stdout and stderr both — a conflicted pull announces its
/// "Automatic merge failed" on stdout while stderr holds only the fetch's progress. `detail` is what
/// is shown when nothing more specific applies.
pub fn failure_message(op: &str, output: &str, detail: &str) -> String {
    let plain = format!("git {op} failed: {detail}");
    if op == "pull" && is_divergent_pull(output) {
        return format!("{PULL_DIVERGED_PREFIX}{plain}");
    }
    if op == "push" && is_push_rejected(output) {
        return format!("{PUSH_REJECTED_PREFIX}{plain}");
    }
    if let Some(kind) = stopped_on_conflicts(output) {
        return format!("{OPERATION_CONFLICTS_PREFIX}{kind}");
    }
    match classify_failure(output) {
        Some(failure) => format!("{REMOTE_FAILURE_PREFIX}{}\n{plain}", failure.code()),
        None => plain,
    }
}

/// How long a run may take before it is killed.
///
/// Five minutes is far past any fetch, pull or push that is merely slow, and short enough that a
/// hung one gives the buttons back within the same sitting. A clone moves the whole history, so it
/// gets an hour. This is a bound on the pathological case, not an estimate.
pub fn timeout_for(op: &str) -> Duration {
    match op {
        // A submodule update can be a clone too — of every submodule at once, recursively.
        "clone" | "submodule" => Duration::from_secs(60 * 60),
        _ => Duration::from_secs(5 * 60),
    }
}

/// What batch mode adds to ssh: no prompt of any kind (host key, passphrase, password), and a
/// deadline on the TCP connect itself.
const SSH_BATCH_OPTIONS: &str = "-o BatchMode=yes -o ConnectTimeout=30";

/// The program of a command line: the first word, or the first quoted run when the path has spaces
/// in it (`"C:\Program Files\Git\usr\bin\ssh.exe" -i key`).
fn first_word(command: &str) -> Option<&str> {
    let command = command.trim_start();
    if let Some(rest) = command.strip_prefix('"') {
        return rest.split('"').next();
    }
    if let Some(rest) = command.strip_prefix('\'') {
        return rest.split('\'').next();
    }
    command.split_whitespace().next()
}

/// The `GIT_SSH_COMMAND` to run with, or `None` to leave ssh exactly as the user has it.
///
/// `configured` is the user's own command — `GIT_SSH_COMMAND`, else `core.sshCommand` — and it is
/// kept, with the batch options appended, when it runs OpenSSH: a `-i ~/.ssh/work` in it is how
/// somebody picks the key for this host, and replacing it would break exactly the setups that are
/// configured with care. Options go after theirs because ssh takes the *first* value it sees for
/// each, so an explicit choice of their own still wins. Anything that is not OpenSSH (plink, a
/// wrapper script) takes other arguments and is left alone, as is `GIT_SSH`, which names a program
/// git runs without a shell.
pub fn ssh_command(configured: Option<&str>, git_ssh_set: bool) -> Option<String> {
    match configured.map(str::trim).filter(|c| !c.is_empty()) {
        None if git_ssh_set => None,
        None => Some(format!("ssh {SSH_BATCH_OPTIONS}")),
        Some(command) => {
            let program = first_word(command)?;
            let base = program.rsplit(['/', '\\']).next().unwrap_or(program).to_lowercase();
            (base == "ssh" || base == "ssh.exe").then(|| format!("{command} {SSH_BATCH_OPTIONS}"))
        }
    }
}

/// `core.sshCommand` from the repository's config (which includes the global one), or from the
/// global config alone for a clone, which has no repository yet.
fn configured_ssh_command(cwd: Option<&str>) -> Option<String> {
    let config = match cwd.and_then(|dir| git2::Repository::open(dir).ok()) {
        Some(repo) => repo.config().ok()?,
        None => git2::Config::open_default().ok()?,
    };
    config.get_string("core.sshCommand").ok()
}

/// The environment every run gets — see the module note.
pub(crate) fn network_env(cwd: Option<&str>) -> Vec<(&'static str, String)> {
    let mut env = vec![("GIT_TERMINAL_PROMPT", "0".to_string())];
    let configured = std::env::var("GIT_SSH_COMMAND")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| configured_ssh_command(cwd));
    if let Some(command) = ssh_command(configured.as_deref(), std::env::var_os("GIT_SSH").is_some()) {
        env.push(("GIT_SSH_COMMAND", command));
    }
    env
}

async fn run_streamed(app: &AppHandle, op: &str, cwd: Option<&str>, args: &[&str]) -> Result<(), String> {
    run_git(app, op, cwd, args, &[]).await
}

async fn run_git(
    app: &AppHandle,
    op: &str,
    cwd: Option<&str>,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<(), String> {
    let app = app.clone();
    let emit: Emit = Arc::new(move |event| match event {
        Emitted::Progress(e) => {
            let _ = app.emit("git:progress", e);
        }
        Emitted::Remote(e) => {
            let _ = app.emit("git:remote-progress", e);
        }
        Emitted::Done(e) => {
            let _ = app.emit("git:done", e);
        }
    });
    run_git_with(emit, op, cwd, args, extra_env).await
}

/// Where a run's events go. A closure over the `AppHandle` in production; a collector in tests.
type Emit = Arc<dyn Fn(Emitted) + Send + Sync>;

enum Emitted {
    Progress(GitProgressEvent),
    Remote(RemoteProgressEvent),
    Done(GitDoneEvent),
}

/// The subcommands that print their progress meters only when stderr is a terminal — which a pipe
/// never is — unless told `--progress`.
fn wants_progress_flag(args: &[&str]) -> bool {
    matches!(args.first().copied(), Some("fetch" | "pull" | "push" | "clone")) && !args.contains(&"--progress")
}

async fn run_git_with(
    emit: Emit,
    op: &str,
    cwd: Option<&str>,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<(), String> {
    let mut cmd = proc::command("git");
    if wants_progress_flag(args) {
        cmd.arg(args[0]).arg("--progress").args(&args[1..]);
    } else {
        cmd.args(args);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (key, value) in network_env(cwd) {
        cmd.env(key, value);
    }
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    // Nothing to read a password from, and nothing that could wait on one.
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // A group of its own, so the deadline below can stop ssh or `git-remote-https` along with git —
    // killing git alone would leave the helper that is actually stuck still holding the pipes.
    proc::own_process_group(&mut cmd);
    cmd.kill_on_drop(true);

    // Registered before the process exists, so a Cancel pressed during startup is not lost.
    let registered = cwd.map(|dir| register_op(dir, op));
    let started_at = std::time::SystemTime::now();
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let emit_out = emit.clone();
    let op_out = op.to_string();
    let stdout_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        for_each_segment(stdout, |line| {
            emit_out(Emitted::Progress(GitProgressEvent { op: op_out.clone(), line: crate::applog::scrub(&line) }));
            collected.push(line);
        })
        .await;
        collected
    });

    let emit_err = emit.clone();
    let op_err = op.to_string();
    let repo_key = cwd.map(norm_repo).unwrap_or_default();
    let stderr_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        let mut throttle = Throttle::new(PROGRESS_INTERVAL);
        // git redraws a meter with `\r`, so a "line" here is one redraw, not one line of text.
        for_each_segment(stderr, |line| {
            let shown = crate::applog::scrub(&line);
            let progress = parse_progress(&shown);
            if throttle.allow(std::time::Instant::now(), progress.as_ref().and_then(|p| p.percent) == Some(100)) {
                emit_err(Emitted::Remote(RemoteProgressEvent {
                    repo_path: repo_key.clone(),
                    operation: op_err.clone(),
                    line: shown.clone(),
                    phase: progress.as_ref().map(|p| p.phase.clone()),
                    percent: progress.as_ref().and_then(|p| p.percent),
                }));
            }
            // Meters are not part of the story of a failure: kept out of the error text (and out of
            // the older `git:progress` stream, which has never carried them).
            if progress.is_none() {
                emit_err(Emitted::Progress(GitProgressEvent { op: op_err.clone(), line: shown }));
                collected.push(line);
            }
        })
        .await;
        collected
    });

    let limit = timeout_for(op);
    let cancel = registered.as_ref().map(|r| r.cancel.clone());
    let ended = tokio::select! {
        waited = tokio::time::timeout(limit, child.wait()) => match waited {
            Ok(status) => Ended::Exited(status.map_err(|e| e.to_string())?),
            Err(_) => Ended::TimedOut,
        },
        _ = async {
            match &cancel {
                Some(cancel) => cancel.notified().await,
                None => std::future::pending::<()>().await,
            }
        } => Ended::Cancelled,
    };
    // SIGTERM first (see `ai_runs::kill_tree`): git removes its own lock files on it.
    if !matches!(ended, Ended::Exited(_)) {
        crate::ai_runs::kill_tree(&mut child).await;
    }
    // The pipes close once the group is gone. Bounded anyway: a straggler that escaped the group
    // and kept a pipe open must not be able to hold this call — and the buttons — hostage.
    let drain = Duration::from_secs(5);
    let stdout_lines = tokio::time::timeout(drain, stdout_task).await.ok().and_then(Result::ok).unwrap_or_default();
    let stderr_lines = tokio::time::timeout(drain, stderr_task).await.ok().and_then(Result::ok).unwrap_or_default();
    drop(registered);

    let cancelled = matches!(ended, Ended::Cancelled);
    if cancelled && op == "pull" {
        if let Some(dir) = cwd {
            clear_stale_index_lock(dir, started_at);
        }
    }
    let status = match &ended {
        Ended::Exited(status) => Some(*status),
        _ => None,
    };
    let success = status.as_ref().is_some_and(|s| s.success());

    // git writes most error detail to stderr, but some commands (rare misconfigurations)
    // only explain themselves on stdout — fall back so the UI never shows a bare
    // "git fetch failed" with no reason.
    let detail = if cancelled {
        format!("git {op} cancelled")
    } else if status.is_none() {
        format!("stopped after {} minutes with no answer", limit.as_secs() / 60)
    } else if !stderr_lines.is_empty() {
        stderr_lines.join("\n")
    } else if !stdout_lines.is_empty() {
        stdout_lines.join("\n")
    } else {
        format!("git {op} exited with {}", status.as_ref().map(|s| s.to_string()).unwrap_or_default())
    };

    emit(Emitted::Done(GitDoneEvent {
        op: op.to_string(),
        success,
        message: if success { "ok".to_string() } else { detail.clone() },
    }));

    if success {
        return Ok(());
    }
    if cancelled {
        return Err(cancelled_message(op));
    }
    if status.is_none() {
        return Err(format!(
            "{REMOTE_FAILURE_PREFIX}{}\ngit {op} failed: {detail}",
            RemoteFailure::Timeout.code()
        ));
    }
    let output = format!("{}\n{}", stderr_lines.join("\n"), stdout_lines.join("\n"));
    Err(failure_message(op, &output, &detail))
}

enum Ended {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

/// What a run the user stopped resolves with — the same tagged shape as every other classified
/// failure (`remoteFailure(error) === "cancelled"` on the frontend), so a stop is told apart from a
/// failure without parsing git's text.
pub fn cancelled_message(op: &str) -> String {
    format!("{REMOTE_FAILURE_PREFIX}{}\ngit {op} cancelled", RemoteFailure::Cancelled.code())
}

// ---------- in-flight operations: cancel and progress ----------

/// A fetch, pull or push that is running, so a Cancel can find it.
struct LiveOp {
    repo: String,
    op: String,
    cancel: Arc<Notify>,
}

fn live_ops() -> &'static Mutex<HashMap<u64, LiveOp>> {
    static OPS: OnceLock<Mutex<HashMap<u64, LiveOp>>> = OnceLock::new();
    OPS.get_or_init(Default::default)
}

/// Leaves the registry when the run ends, by any route.
struct OpGuard {
    id: u64,
    cancel: Arc<Notify>,
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        if let Ok(mut ops) = live_ops().lock() {
            ops.remove(&self.id);
        }
    }
}

/// A repository path as the registry keys it: trailing separators do not make a different repo.
fn norm_repo(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() { path.to_string() } else { trimmed.to_string() }
}

fn register_op(repo: &str, op: &str) -> OpGuard {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(Notify::new());
    if let Ok(mut ops) = live_ops().lock() {
        ops.insert(id, LiveOp { repo: norm_repo(repo), op: op.to_string(), cancel: cancel.clone() });
    }
    OpGuard { id, cancel }
}

/// Stops every remote operation running in `repo`, returning their names (`["pull"]`) — empty when
/// none was. Each resolves its own call with [`cancelled_message`]; this only signals.
pub fn cancel_ops(repo: &str) -> Vec<String> {
    let key = norm_repo(repo);
    let Ok(ops) = live_ops().lock() else { return Vec::new() };
    ops.values()
        .filter(|live| live.repo == key)
        .map(|live| {
            // `notify_one` keeps a permit if the run has not reached its wait yet.
            live.cancel.notify_one();
            live.op.clone()
        })
        .collect()
}

/// The `index.lock` a killed pull may leave behind. git removes its lock files when it is
/// terminated by SIGTERM, so one still there after the group was stopped is either from the
/// SIGKILL that follows a slow exit or somebody else's — and only a file written since this run
/// began is taken to be ours. Pull is the only operation here that writes the index (the merge,
/// rebase or fast-forward after its fetch); fetch and push never take it.
fn clear_stale_index_lock(repo: &str, since: std::time::SystemTime) -> bool {
    let Ok(repository) = git2::Repository::open(repo) else { return false };
    let lock = repository.path().join("index.lock");
    let ours = std::fs::metadata(&lock)
        .and_then(|meta| meta.modified())
        .is_ok_and(|modified| modified + Duration::from_secs(1) >= since);
    ours && std::fs::remove_file(&lock).is_ok()
}

/// One redraw of git's progress, or one line of its text, from a running fetch, pull or push.
/// camelCase, as the TS side reads it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProgressEvent {
    pub repo_path: String,
    /// `"fetch"`, `"pull"`, `"push"` — the same names `git:done` carries.
    pub operation: String,
    /// Credentials in a URL are already masked (`applog::scrub`).
    pub line: String,
    /// `"Receiving objects"`, `"Resolving deltas"`… for a progress meter; `None` for other text.
    pub phase: Option<String>,
    /// 0–100 when the meter has one (`Enumerating objects: 5, done.` does not).
    pub percent: Option<u8>,
}

/// At most five events a second reach the webview; see [`Throttle`].
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Rate limit for the progress stream. A fetch of a large repository redraws its meter hundreds of
/// times a second, and every event is a trip across the IPC boundary.
struct Throttle {
    interval: Duration,
    last: Option<std::time::Instant>,
}

impl Throttle {
    fn new(interval: Duration) -> Self {
        Self { interval, last: None }
    }

    /// Whether an event at `now` may go out. `force` (a meter reaching 100%) always may, so the
    /// bar is never left at 97% by the redraw that fell inside the window.
    fn allow(&mut self, now: std::time::Instant, force: bool) -> bool {
        let due = self.last.is_none_or(|last| now.duration_since(last) >= self.interval);
        if due || force {
            self.last = Some(now);
            return true;
        }
        false
    }
}

struct Meter {
    phase: String,
    percent: Option<u8>,
}

/// git's progress meters: `Receiving objects:  45% (45/100), 1.2 MiB | 2.3 MiB/s`,
/// `remote: Counting objects: 100% (5/5), done.`, `Enumerating objects: 5, done.`. Matched by the
/// phase names git prints rather than by shape, so an ordinary `remote:` message is not mistaken
/// for one.
fn parse_progress(line: &str) -> Option<Meter> {
    const PHASES: [&str; 11] = [
        "enumerating objects",
        "counting objects",
        "compressing objects",
        "receiving objects",
        "writing objects",
        "resolving deltas",
        "unpacking objects",
        "updating files",
        "checking out files",
        "finding sources",
        "analyzing objects",
    ];
    let text = line.trim();
    let text = text.strip_prefix("remote:").map(str::trim_start).unwrap_or(text);
    let (phase, rest) = text.split_once(':')?;
    if !PHASES.contains(&phase.trim().to_lowercase().as_str()) {
        return None;
    }
    let percent = rest.find('%').and_then(|at| {
        let digits: String = rest[..at].chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
        digits.parse::<u8>().ok().filter(|p| *p <= 100)
    });
    Some(Meter { phase: phase.trim().to_string(), percent })
}

/// Calls `f` for each line of `reader`, where a line ends at `\n` **or** `\r` — git redraws a meter
/// in place with a bare carriage return, which `lines()` would glue into one enormous line that
/// only arrives when the transfer is over. Empty segments (`\r\n`) are skipped.
async fn for_each_segment<R: tokio::io::AsyncRead + Unpin>(mut reader: R, mut f: impl FnMut(String)) {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    let flush = |pending: &mut Vec<u8>, f: &mut dyn FnMut(String)| {
        if !pending.is_empty() {
            f(String::from_utf8_lossy(pending).into_owned());
            pending.clear();
        }
    };
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &byte in &buf[..n] {
                    if byte == b'\n' || byte == b'\r' {
                        flush(&mut pending, &mut f);
                    } else {
                        pending.push(byte);
                    }
                }
            }
        }
    }
    flush(&mut pending, &mut f);
}

pub async fn clone(app: AppHandle, url: String, dest: String) -> Result<(), String> {
    run_streamed(&app, "clone", None, &["clone", &url, &dest]).await
}

pub async fn fetch(app: AppHandle, repo_path: String, remote: Option<String>) -> Result<(), String> {
    // "The" remote when none is named — see `default_remote` — rather than a hardcoded `origin`,
    // which a repository whose only remote is `upstream` does not have. No remote at all comes back
    // tagged, instead of as git's "'origin' does not appear to be a git repository".
    let remote = match remote {
        Some(remote) => remote,
        None => crate::git::remotes::default_remote(&repo_path)?,
    };
    run_streamed(&app, "fetch", Some(&repo_path), &["fetch", &remote]).await
}

/// `git lfs pull`: downloads the LFS objects the checked-out files point at and puts them in the
/// working tree in place of their pointers — for a clone made without LFS installed, or files whose
/// objects were never fetched.
pub async fn lfs_pull(app: AppHandle, repo_path: String) -> Result<(), String> {
    run_streamed(&app, "lfs", Some(&repo_path), &["lfs", "pull"]).await
}

/// Fetches a single explicit refspec (e.g. a GitHub `refs/pull/<n>/head` pull-request ref)
/// rather than the remote's default branches — used to pull a PR's exact head commit for
/// review, which works even when the PR comes from a fork.
pub async fn fetch_refspec(app: AppHandle, repo_path: String, remote: String, refspec: String) -> Result<(), String> {
    run_streamed(&app, "fetch", Some(&repo_path), &["fetch", &remote, &refspec]).await
}

/// How a pull reconciles a branch that has diverged from its upstream — the three answers git ≥ 2.33
/// insists on before it will pull one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullMode {
    Merge,
    Rebase,
    FfOnly,
}

/// The command line for a pull. `None` is a bare `git pull`, which follows whatever the user's
/// config says — including a choice remembered for this repository.
///
/// A merge is `--no-rebase --ff`, not just `--no-rebase`: `--ff` is what overrides a `pull.ff=only`
/// in the user's global config, which older gits would otherwise honour and refuse the merge the
/// user just asked for.
pub fn pull_args(mode: Option<PullMode>) -> Vec<&'static str> {
    match mode {
        None => vec!["pull"],
        Some(PullMode::Merge) => vec!["pull", "--no-rebase", "--ff"],
        Some(PullMode::Rebase) => vec!["pull", "--rebase"],
        Some(PullMode::FfOnly) => vec!["pull", "--ff-only"],
    }
}

/// The repository-level config that makes the choice stick — the same keys git's own hint
/// suggests (`git config pull.rebase false`…), so a plain `git pull` in a terminal remembers it
/// too. `None` removes the key.
pub fn pull_config(mode: PullMode) -> [(&'static str, Option<&'static str>); 2] {
    match mode {
        PullMode::Merge => [("pull.rebase", Some("false")), ("pull.ff", Some("true"))],
        PullMode::Rebase => [("pull.rebase", Some("true")), ("pull.ff", None)],
        PullMode::FfOnly => [("pull.rebase", Some("false")), ("pull.ff", Some("only"))],
    }
}

fn remember_pull_mode(repo_path: &str, mode: PullMode) -> Result<(), String> {
    let repo = crate::git::repo::open(repo_path)?;
    let mut config = repo
        .config()
        .and_then(|c| c.open_level(git2::ConfigLevel::Local))
        .map_err(|e| e.message().to_string())?;
    for (key, value) in pull_config(mode) {
        match value {
            Some(value) => config.set_str(key, value).map_err(|e| e.message().to_string())?,
            None => {
                if let Err(e) = config.remove(key) {
                    if e.code() != git2::ErrorCode::NotFound {
                        return Err(e.message().to_string());
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn pull(app: AppHandle, repo_path: String) -> Result<(), String> {
    run_streamed(&app, "pull", Some(&repo_path), &pull_args(None)).await
}

/// A pull with the reconciliation spelled out — the answer to [`PULL_DIVERGED_PREFIX`]. With
/// `remember`, the choice is written to the repository's config first, so the next pull (from here
/// or from a terminal) does not have to ask.
pub async fn pull_with(app: AppHandle, repo_path: String, mode: PullMode, remember: bool) -> Result<(), String> {
    if remember {
        remember_pull_mode(&repo_path, mode)?;
    }
    run_streamed(&app, "pull", Some(&repo_path), &pull_args(Some(mode))).await
}

/// Brings one branch's remote-tracking ref up to date and nothing else — no working tree touched,
/// no local branch moved.
///
/// Narrow on purpose. The whole point of the per-row button in the branch list is to ask about
/// *that* branch from wherever you happen to be standing, rather than waiting on every ref the
/// remote has just to find out whether one of them moved.
pub async fn fetch_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    let (remote, merge_ref) = crate::git::branch::upstream_of(&repo_path, &branch)?;
    let short = merge_ref.strip_prefix("refs/heads/").unwrap_or(&merge_ref);
    let refspec = format!("+{merge_ref}:refs/remotes/{remote}/{short}");
    run_streamed(&app, "fetch", Some(&repo_path), &["fetch", &remote, &refspec]).await
}

/// Updates a branch from its upstream, checked out or not.
///
/// Two different commands behind one button, because git has no way to pull into a branch you are
/// not standing on. The checked-out branch takes the ordinary `git pull`, so it keeps whatever
/// merge-or-rebase the user's own config says; any other branch is fast-forwarded in place by
/// fetching straight into its ref.
///
/// No `+` on that refspec, and that is the safety of the whole feature: without force git refuses
/// anything that isn't a fast-forward, so a branch nobody is looking at is never rewritten behind
/// their back — it either moves forward or the pull fails and says why.
pub async fn pull_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    // `git fetch` flatly refuses to write the ref of a branch that is checked out, so this is not
    // an optimisation — it is the only route for the current branch.
    if crate::git::branch::is_head_branch(&repo_path, &branch)? {
        return pull(app, repo_path).await;
    }
    let (remote, merge_ref) = crate::git::branch::upstream_of(&repo_path, &branch)?;
    let short = merge_ref.strip_prefix("refs/heads/").unwrap_or(&merge_ref);
    let into_branch = format!("{merge_ref}:refs/heads/{branch}");
    // The tracking ref moves alongside the branch. git does update it opportunistically for an
    // explicit refspec, but only where the remote's own refspec covers it — and a list that still
    // says "3 behind" after a pull that worked is worse than one extra refspec here.
    let into_tracking = format!("+{merge_ref}:refs/remotes/{remote}/{short}");
    // Reported as "pull" rather than "fetch": the op name is what the progress lines and the
    // failure message are labelled with, and the user asked for a pull.
    run_streamed(&app, "pull", Some(&repo_path), &["fetch", &remote, &into_branch, &into_tracking]).await
}

/// Publishes one branch by name, whether or not it is the one checked out.
///
/// `push` publishes HEAD, which is the right shape for the status bar's button and the wrong one
/// everywhere a branch is *named* — the pull-request form most of all, where the branch you are
/// opening a PR from is picked from a list and is routinely not the one you are standing on.
///
/// Always `-u`. The only caller is "this branch has no upstream, publish it", so the tracking link
/// is the point rather than an option: a push that left the branch untracked would put the commits
/// on the remote and leave the form still saying the branch is local-only.
pub async fn push_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    // Against the named branch, not HEAD — see `guard_branch_unlocked_at`.
    crate::git::branch::guard_branch_unlocked_at(&repo_path, &branch)?;
    // Refuse a name that is not a local branch here rather than letting git answer with a refspec
    // error: this is reached from a picker, so the branch existing is the caller's claim to check.
    if !crate::git::branch::local_branch_exists(&repo_path, &branch)? {
        return Err(format!("no local branch named {branch}"));
    }
    let remote = crate::git::remotes::default_remote(&repo_path)?;
    run_streamed(&app, "push", Some(&repo_path), &["push", "-u", &remote, &branch]).await
}

/// `first_publish` is the push right after a repository was connected to its first remote (the
/// publish flow added it a moment ago): the branch lock does not apply, because a lock protects a
/// branch other people share and a repository with no remote until now has nothing shared yet.
pub async fn push(app: AppHandle, repo_path: String, set_upstream: bool, first_publish: bool) -> Result<(), String> {
    // No remote at all is said first — before the lock — so publishing a new repository's `main`
    // reaches the publish flow instead of being refused as a locked branch.
    if set_upstream {
        crate::git::remotes::default_remote(&repo_path)?;
    }
    // `git push` publishes whatever branch is checked out, so the lock is checked against HEAD.
    if !first_publish {
        crate::git::branch::guard_head_unlocked_at(&repo_path)?;
    }
    if set_upstream {
        let branch = {
            let repo = crate::git::repo::open(&repo_path)?;
            let head = repo.head().map_err(|e| e.message().to_string())?;
            head.shorthand()
                .ok_or("cannot push -u from a detached HEAD")?
                .to_string()
        };
        // `default_remote` answers `NO_REMOTE` for a repository with none, which the publish flow
        // turns into "add one" rather than a failure.
        let remote = crate::git::remotes::default_remote(&repo_path)?;
        run_streamed(&app, "push", Some(&repo_path), &["push", "-u", &remote, &branch]).await
    } else {
        run_streamed(&app, "push", Some(&repo_path), &["push"]).await
    }
}

/// The first push of a repository just created by the publish flow (`commands::publish_cmd`): the
/// current branch to `origin` with `-u`, authenticated by `header` for URLs under `prefix`.
///
/// The header rides as an `http.<prefix>.extraHeader` handed to this one process through
/// `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` — never on the command line (where `ps` would show it) and
/// never in the repository's config or its remote URL. A machine with no credential helper can
/// still publish; later pushes use whatever the user's git normally uses, like every other remote.
///
/// No branch lock here: this is a repository's first publish — see [`push`]'s `first_publish`.
pub async fn publish_push_with_header(app: AppHandle, repo_path: String, prefix: String, header: String) -> Result<(), String> {
    let branch = {
        let repo = crate::git::repo::open(&repo_path)?;
        let head = repo.head().map_err(|e| e.message().to_string())?;
        head.shorthand().ok_or("cannot push -u from a detached HEAD")?.to_string()
    };
    let key = format!("http.{prefix}.extraHeader");
    let env = [("GIT_CONFIG_COUNT", "1"), ("GIT_CONFIG_KEY_0", key.as_str()), ("GIT_CONFIG_VALUE_0", header.as_str())];
    run_git(&app, "push", Some(&repo_path), &["push", "-u", "origin", &branch], &env).await
}

/// The force push this app offers — only ever *with lease*, never a bare `--force`.
///
/// `--force-with-lease` alone overwrites the remote only if it is still where our remote-tracking
/// ref says it was. That protects nothing in *this* app, which fetches in the background: the
/// tracking ref is moved to the remote's new tip without the user having seen a single one of those
/// commits, and the lease then happily lets the push delete them. `--force-if-includes` closes that
/// gap — the push is refused unless the remote tip is somewhere in the local branch's reflog, i.e.
/// unless it was actually integrated here (the pushed commit an amend replaced is; a colleague's
/// commit that only arrived by fetch is not).
pub fn force_push_args() -> [&'static str; 3] {
    ["push", "--force-with-lease", "--force-if-includes"]
}

pub async fn push_force_with_lease(app: AppHandle, repo_path: String) -> Result<(), String> {
    crate::git::branch::guard_head_unlocked_at(&repo_path)?;
    run_streamed(&app, "push", Some(&repo_path), &force_push_args()).await
}

/// Continue or abort, for [`sequencer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SequencerAction {
    Continue,
    Abort,
}

/// The command line that continues or aborts an operation git's own sequencer is running — a
/// rebase, or a revert or cherry-pick of several commits (see `git::merge::is_sequenced`).
pub fn sequencer_args(kind: OperationKind, action: SequencerAction) -> [&'static str; 2] {
    let command = match kind {
        OperationKind::Rebase => "rebase",
        OperationKind::Revert => "revert",
        OperationKind::CherryPick => "cherry-pick",
        OperationKind::Merge => "merge",
    };
    let flag = match action {
        SequencerAction::Continue => "--continue",
        SequencerAction::Abort => "--abort",
    };
    [command, flag]
}

/// `git rebase --continue` and friends, through the CLI because only git knows how to walk its own
/// to-do list.
///
/// `GIT_EDITOR=true`: `--continue` opens an editor on the commit message, and with no terminal and
/// no window that editor would be waited on until the deadline killed it. `true` accepts the message
/// git prepared, which is what the banner's Continue means. (Git for Windows runs the editor through
/// its own `sh`, where `true` is a builtin, so this holds there too.)
pub async fn sequencer(app: AppHandle, repo_path: String, kind: OperationKind, action: SequencerAction) -> Result<(), String> {
    let args = sequencer_args(kind, action);
    run_git(&app, "rebase", Some(&repo_path), &args, &[("GIT_EDITOR", "true")]).await
}

// ---------- tags and branches on the remote, and submodules ----------
//
// The command lines are `git::remote_refs`' and `git::submodule`'s, where they are tested against a
// real local remote; these only run them through the network runner above. Reported as "push" (and
// "submodule"), so a refused credential or an unreachable host reads the same as on any other push.

async fn run_args(app: &AppHandle, op: &str, repo_path: &str, args: Vec<String>) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_streamed(app, op, Some(repo_path), &refs).await
}

/// Publishes one tag. `remote: None` is the repository's default remote.
pub async fn push_tag(app: AppHandle, repo_path: String, remote: Option<String>, tag: String) -> Result<(), String> {
    let remote = crate::git::remote_refs::remote_or_default(&repo_path, remote)?;
    run_args(&app, "push", &repo_path, crate::git::remote_refs::push_tag_args(&remote, &tag)).await
}

/// Publishes every tag the remote does not have yet.
pub async fn push_all_tags(app: AppHandle, repo_path: String, remote: Option<String>) -> Result<(), String> {
    let remote = crate::git::remote_refs::remote_or_default(&repo_path, remote)?;
    run_args(&app, "push", &repo_path, crate::git::remote_refs::push_all_tags_args(&remote)).await
}

/// Deletes a tag on the remote. The local tag is left alone — that is `delete_tag`'s to do.
pub async fn delete_remote_tag(app: AppHandle, repo_path: String, remote: String, tag: String) -> Result<(), String> {
    run_args(&app, "push", &repo_path, crate::git::remote_refs::delete_remote_tag_args(&remote, &tag)).await
}

/// Deletes a branch on the remote, named as its remote-tracking ref (`origin/feature/x`). A locked
/// branch name is refused — the lock keeps pushes off a branch, and a deletion is the most final push
/// there is.
pub async fn delete_remote_branch(app: AppHandle, repo_path: String, remote_branch: String) -> Result<(), String> {
    let (remote, branch) = crate::git::remote_refs::split_remote_branch_at(&repo_path, &remote_branch)?;
    crate::git::branch::guard_branch_unlocked_at(&repo_path, &branch)?;
    run_args(&app, "push", &repo_path, crate::git::remote_refs::delete_remote_branch_args(&remote, &branch)).await
}

/// `git submodule update --init [--recursive] [-- <path>]` — see `git::submodule::update_args`.
pub async fn submodule_update(app: AppHandle, repo_path: String, path: Option<String>, recursive: bool) -> Result<(), String> {
    let args = crate::git::submodule::update_args(path.as_deref(), recursive);
    run_args(&app, "submodule", &repo_path, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_spells_out_each_reconciliation() {
        assert_eq!(pull_args(None), vec!["pull"]);
        assert_eq!(pull_args(Some(PullMode::Merge)), vec!["pull", "--no-rebase", "--ff"]);
        assert_eq!(pull_args(Some(PullMode::Rebase)), vec!["pull", "--rebase"]);
        assert_eq!(pull_args(Some(PullMode::FfOnly)), vec!["pull", "--ff-only"]);
    }

    /// The remembered choice is the config git's own hint suggests, so a terminal pull follows it.
    #[test]
    fn remembering_writes_the_keys_git_reads() {
        assert_eq!(pull_config(PullMode::Merge), [("pull.rebase", Some("false")), ("pull.ff", Some("true"))]);
        assert_eq!(pull_config(PullMode::Rebase), [("pull.rebase", Some("true")), ("pull.ff", None)]);
        assert_eq!(pull_config(PullMode::FfOnly), [("pull.rebase", Some("false")), ("pull.ff", Some("only"))]);
    }

    #[test]
    fn remembering_a_mode_lands_in_the_repository_config() {
        let dir = std::env::temp_dir().join(format!("cf-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        let path = dir.to_str().unwrap();

        remember_pull_mode(path, PullMode::FfOnly).unwrap();
        remember_pull_mode(path, PullMode::Rebase).unwrap();

        let config = git2::Repository::open(&dir).unwrap().config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
        assert_eq!(config.get_string("pull.rebase").unwrap(), "true");
        assert!(config.get_string("pull.ff").is_err(), "the earlier ff-only is cleared, not left to fight");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Never a bare `--force`, and never a lease without the reflog check that makes it safe
    /// alongside a background fetch.
    #[test]
    fn the_force_push_is_leased_and_checks_what_was_integrated() {
        let args = force_push_args();
        assert!(args.contains(&"--force-with-lease"));
        assert!(args.contains(&"--force-if-includes"));
        assert!(!args.contains(&"--force") && !args.contains(&"-f"));
    }

    #[test]
    fn the_sequencer_runs_the_operations_own_subcommand() {
        assert_eq!(sequencer_args(OperationKind::Rebase, SequencerAction::Continue), ["rebase", "--continue"]);
        assert_eq!(sequencer_args(OperationKind::CherryPick, SequencerAction::Abort), ["cherry-pick", "--abort"]);
        assert_eq!(sequencer_args(OperationKind::Revert, SequencerAction::Continue), ["revert", "--continue"]);
    }

    #[test]
    fn ssh_runs_in_batch_mode_unless_the_user_chose_something_else() {
        // Nothing configured: plain ssh, in batch mode.
        assert_eq!(ssh_command(None, false).as_deref(), Some("ssh -o BatchMode=yes -o ConnectTimeout=30"));
        // Their own OpenSSH command keeps its key choice and gains the options.
        assert_eq!(
            ssh_command(Some("ssh -i ~/.ssh/work -o IdentitiesOnly=yes"), false).as_deref(),
            Some("ssh -i ~/.ssh/work -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30"),
        );
        assert!(ssh_command(Some("/usr/bin/ssh"), false).is_some());
        assert!(ssh_command(Some("\"C:\\Program Files\\Git\\usr\\bin\\ssh.exe\" -i key"), false).is_some());
        // Anything else speaks other arguments and is left exactly as it is.
        assert_eq!(ssh_command(Some("plink -batch"), false), None);
        assert_eq!(ssh_command(Some("/opt/bin/my-ssh-wrapper.sh"), false), None);
        // `GIT_SSH` is a program git runs as-is; setting `GIT_SSH_COMMAND` would override it.
        assert_eq!(ssh_command(None, true), None);
        assert_eq!(ssh_command(Some("   "), true), None);
    }

    #[test]
    fn clone_gets_a_longer_deadline_than_the_rest() {
        assert_eq!(timeout_for("fetch"), Duration::from_secs(300));
        assert_eq!(timeout_for("push"), Duration::from_secs(300));
        assert!(timeout_for("clone") > timeout_for("pull"));
    }

    /// Real output, trimmed, for each failure that has a sentence of its own.
    #[test]
    fn common_failures_are_recognised() {
        let cases = [
            (
                "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
                RemoteFailure::AuthRequired,
            ),
            ("remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/o/r.git/'", RemoteFailure::AuthFailed),
            ("remote: HTTP Basic: Access denied", RemoteFailure::AuthFailed),
            ("fatal: unable to access 'https://example.com/o/r.git/': The requested URL returned error: 403", RemoteFailure::AuthFailed),
            (
                "git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
                RemoteFailure::SshKey,
            ),
            ("Host key verification failed.\nfatal: Could not read from remote repository.", RemoteFailure::HostKey),
            ("@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @", RemoteFailure::HostKey),
            ("fatal: unable to access 'https://example.com/o/r.git/': Could not resolve host: example.com", RemoteFailure::Network),
            ("ssh: Could not resolve hostname example.com: nodename nor servname provided, or not known", RemoteFailure::Network),
            ("fatal: unable to access 'https://example.com/': Failed to connect to example.com port 443 after 75004 ms: Couldn't connect to server", RemoteFailure::Network),
            ("ssh: connect to host example.com port 22: Operation timed out", RemoteFailure::Network),
            ("remote: Repository not found.\nfatal: repository 'https://example.com/o/r.git/' not found", RemoteFailure::RepoNotFound),
            ("ERROR: Repository not found.\nfatal: Could not read from remote repository.", RemoteFailure::RepoNotFound),
            (" ! [rejected]        main -> main (stale info)", RemoteFailure::StaleLease),
            (" ! [rejected]        main -> main (remote ref updated since checkout)", RemoteFailure::StaleLease),
            ("error: unknown option `force-if-includes'", RemoteFailure::GitTooOld),
        ];
        for (output, expected) in cases {
            assert_eq!(classify_failure(output), Some(expected), "for: {output}");
        }
        assert_eq!(classify_failure("error: pathspec 'x' did not match any file(s) known to git"), None);
    }

    #[test]
    fn a_divergent_pull_and_a_rejected_push_are_tagged() {
        let diverged = "hint: You have divergent branches and need to specify how to reconcile them.\nfatal: Need to specify how to reconcile divergent branches.";
        assert!(failure_message("pull", diverged, diverged).starts_with(PULL_DIVERGED_PREFIX));
        let ff_only = "fatal: Not possible to fast-forward, aborting.";
        assert!(failure_message("pull", ff_only, ff_only).starts_with(PULL_DIVERGED_PREFIX));

        let rejected = " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://example.com/o/r.git'\nhint: Updates were rejected because the tip of your current branch is behind";
        assert!(failure_message("push", rejected, rejected).starts_with(PUSH_REJECTED_PREFIX));
        let fetch_first = " ! [rejected]        main -> main (fetch first)";
        assert!(failure_message("push", fetch_first, fetch_first).starts_with(PUSH_REJECTED_PREFIX));

        // A lease refusal is the force push protecting someone's work: it must never be answered
        // with another force push, so it is not a plain rejection.
        let stale = " ! [rejected]        main -> main (stale info)";
        assert!(!is_push_rejected(stale));
        assert!(failure_message("push", stale, stale).starts_with(&format!("{REMOTE_FAILURE_PREFIX}stale_lease")));
    }

    #[test]
    fn a_run_that_stopped_on_conflicts_is_an_operation_not_an_error() {
        let merge = "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.";
        assert_eq!(failure_message("pull", merge, "From example.com"), format!("{OPERATION_CONFLICTS_PREFIX}merge"));
        let rebase = "error: could not apply 1234567... change\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: \"git add/rm <conflicted_files>\", then run \"git rebase --continue\".";
        assert_eq!(failure_message("pull", rebase, rebase), format!("{OPERATION_CONFLICTS_PREFIX}rebase"));
    }

    #[test]
    fn a_classified_failure_keeps_gits_text_after_the_code() {
        let output = "fatal: could not read Username for 'https://example.com': terminal prompts disabled";
        let message = failure_message("fetch", output, output);
        let rest = message.strip_prefix(REMOTE_FAILURE_PREFIX).unwrap();
        let (code, detail) = rest.split_once('\n').unwrap();
        assert_eq!(code, "auth_required");
        assert!(detail.contains("terminal prompts disabled"));
        // Nothing recognised: the plain sentence, as before.
        assert_eq!(failure_message("fetch", "boom", "boom"), "git fetch failed: boom");
    }

    #[test]
    fn git_progress_meters_are_parsed_by_phase_and_percent() {
        let m = parse_progress("Receiving objects:  45% (45/100), 1.2 MiB | 2.3 MiB/s").unwrap();
        assert_eq!((m.phase.as_str(), m.percent), ("Receiving objects", Some(45)));
        let m = parse_progress("remote: Counting objects: 100% (5/5), done.").unwrap();
        assert_eq!((m.phase.as_str(), m.percent), ("Counting objects", Some(100)));
        let m = parse_progress("Enumerating objects: 5, done.").unwrap();
        assert_eq!((m.phase.as_str(), m.percent), ("Enumerating objects", None));
        assert!(parse_progress("remote: Resolving the thing is not a meter").is_none());
        assert!(parse_progress("fatal: could not read Username: terminal prompts disabled").is_none());
        assert!(parse_progress("From https://example.com/o/r").is_none());
    }

    #[test]
    fn progress_is_limited_to_about_five_events_a_second() {
        let mut throttle = Throttle::new(PROGRESS_INTERVAL);
        let t0 = std::time::Instant::now();
        assert!(throttle.allow(t0, false), "the first always goes");
        assert!(!throttle.allow(t0 + Duration::from_millis(50), false));
        assert!(!throttle.allow(t0 + Duration::from_millis(199), false));
        assert!(throttle.allow(t0 + Duration::from_millis(250), false));
        assert!(throttle.allow(t0 + Duration::from_millis(260), true), "100% is never swallowed");
    }

    #[test]
    fn progress_flag_is_added_only_where_git_prints_meters() {
        assert!(wants_progress_flag(&["fetch", "origin"]));
        assert!(wants_progress_flag(&["pull", "--rebase"]));
        assert!(wants_progress_flag(&["push"]));
        assert!(!wants_progress_flag(&["push", "--progress"]));
        assert!(!wants_progress_flag(&["lfs", "pull"]));
        assert!(!wants_progress_flag(&["rebase", "--continue"]));
        assert!(!wants_progress_flag(&["submodule", "update"]));
    }

    #[tokio::test]
    async fn carriage_return_redraws_become_separate_segments() {
        let input: &[u8] = b"Receiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\r\nfatal: boom\n";
        let mut seen = Vec::new();
        for_each_segment(input, |line| seen.push(line)).await;
        assert_eq!(seen, ["Receiving objects:  10% (1/10)", "Receiving objects: 100% (10/10), done.", "fatal: boom"]);
    }

    #[test]
    fn a_cancelled_run_is_tagged_as_such() {
        let message = cancelled_message("push");
        assert!(message.starts_with("GIT_REMOTE: cancelled\n"), "{message}");
        assert_eq!(RemoteFailure::Cancelled.code(), "cancelled");
    }

    #[test]
    fn cancel_finds_only_runs_of_that_repository() {
        let a = register_op("/tmp/cf-cancel-a/", "fetch");
        let _b = register_op("/tmp/cf-cancel-b", "push");
        assert_eq!(cancel_ops("/tmp/cf-cancel-a"), ["fetch"], "a trailing slash is the same repository");
        assert!(cancel_ops("/tmp/cf-cancel-none").is_empty());
        drop(a);
        assert!(cancel_ops("/tmp/cf-cancel-a").is_empty(), "a finished run leaves the registry");
    }

    #[test]
    fn a_stale_index_lock_is_cleared_only_when_it_is_newer_than_the_run() {
        let dir = std::env::temp_dir().join(format!("cf-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        let lock = dir.join(".git").join("index.lock");
        let before = std::time::SystemTime::now() - Duration::from_secs(3600);
        std::fs::write(&lock, "").unwrap();
        assert!(!clear_stale_index_lock(repo, std::time::SystemTime::now() + Duration::from_secs(3600)), "older than the run: not ours");
        assert!(lock.exists());
        assert!(clear_stale_index_lock(repo, before));
        assert!(!lock.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A local bare remote whose `pre-receive` hook sleeps stands in for a slow server.
    #[cfg(unix)]
    fn slow_remote() -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("cf-slow-{}", uuid::Uuid::new_v4()));
        let bare = root.join("remote.git");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&root, &["init", "--bare", "remote.git"]);
        let hook = bare.join("hooks").join("pre-receive");
        std::fs::write(&hook, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(&work, &["init"]);
        std::fs::write(work.join("a.txt"), "a").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "one"]);
        git(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        (root, work)
    }

    fn collector() -> (Emit, Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<Option<String>>>>) {
        let done = Arc::new(Mutex::new(Vec::new()));
        let phases = Arc::new(Mutex::new(Vec::new()));
        let (d, p) = (done.clone(), phases.clone());
        let emit: Emit = Arc::new(move |event| match event {
            Emitted::Done(e) => d.lock().unwrap().push(e.message),
            Emitted::Remote(e) => p.lock().unwrap().push(e.phase),
            Emitted::Progress(_) => {}
        });
        (emit, done, phases)
    }

    /// Cancel kills the whole tree — git, receive-pack and the sleeping hook — and the call
    /// resolves at once with the cancelled tag rather than at the five-minute deadline.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_a_slow_push_resolves_it_as_cancelled() {
        let (root, work) = slow_remote();
        let repo = work.to_str().unwrap().to_string();
        let (emit, done, _) = collector();
        let canceller = {
            let repo = repo.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                cancel_ops(&repo)
            })
        };
        let started = std::time::Instant::now();
        let result = run_git_with(emit, "push", Some(&repo), &["push", "origin", "HEAD:refs/heads/main"], &[]).await;
        assert_eq!(canceller.await.unwrap(), ["push"]);
        let err = result.unwrap_err();
        assert!(err.starts_with("GIT_REMOTE: cancelled\n"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(15), "did not wait for the hook: {:?}", started.elapsed());
        assert_eq!(done.lock().unwrap().len(), 1, "git:done still fires once");
        assert!(cancel_ops(&repo).is_empty(), "the run left the registry");
        assert!(!work.join(".git").join("index.lock").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    /// An ordinary push streams its meters as phases, and `--progress` is what makes git print them
    /// into a pipe at all.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_push_reports_progress_phases() {
        use std::os::unix::fs::PermissionsExt;
        let (root, work) = slow_remote();
        let hook = root.join("remote.git").join("hooks").join("pre-receive");
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (emit, _, phases) = collector();
        let repo = work.to_str().unwrap();
        run_git_with(emit, "push", Some(repo), &["push", "origin", "HEAD:refs/heads/main"], &[]).await.unwrap();
        assert!(phases.lock().unwrap().iter().any(Option::is_some), "no progress meter seen: {:?}", phases.lock().unwrap());
        std::fs::remove_dir_all(&root).ok();
    }
}
