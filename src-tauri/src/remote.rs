use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

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
fn network_env(cwd: Option<&str>) -> Vec<(&'static str, String)> {
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
    let mut cmd = proc::command("git");
    cmd.args(args);
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

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let app_out = app.clone();
    let op_out = op.to_string();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("git:progress", GitProgressEvent { op: op_out.clone(), line: line.clone() });
            collected.push(line);
        }
        collected
    });

    let app_err = app.clone();
    let op_err = op.to_string();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("git:progress", GitProgressEvent { op: op_err.clone(), line: line.clone() });
            collected.push(line);
        }
        collected
    });

    let limit = timeout_for(op);
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => Some(status.map_err(|e| e.to_string())?),
        Err(_) => {
            crate::ai_runs::kill_tree(&mut child).await;
            None
        }
    };
    // The pipes close once the group is gone. Bounded anyway: a straggler that escaped the group
    // and kept a pipe open must not be able to hold this call — and the buttons — hostage.
    let drain = Duration::from_secs(5);
    let stdout_lines = tokio::time::timeout(drain, stdout_task).await.ok().and_then(Result::ok).unwrap_or_default();
    let stderr_lines = tokio::time::timeout(drain, stderr_task).await.ok().and_then(Result::ok).unwrap_or_default();

    let success = status.as_ref().is_some_and(|s| s.success());

    // git writes most error detail to stderr, but some commands (rare misconfigurations)
    // only explain themselves on stdout — fall back so the UI never shows a bare
    // "git fetch failed" with no reason.
    let detail = if status.is_none() {
        format!("stopped after {} minutes with no answer", limit.as_secs() / 60)
    } else if !stderr_lines.is_empty() {
        stderr_lines.join("\n")
    } else if !stdout_lines.is_empty() {
        stdout_lines.join("\n")
    } else {
        format!("git {op} exited with {}", status.as_ref().map(|s| s.to_string()).unwrap_or_default())
    };

    let _ = app.emit(
        "git:done",
        GitDoneEvent {
            op: op.to_string(),
            success,
            message: if success { "ok".to_string() } else { detail.clone() },
        },
    );

    if success {
        return Ok(());
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

pub async fn push(app: AppHandle, repo_path: String, set_upstream: bool) -> Result<(), String> {
    // `git push` publishes whatever branch is checked out, so the lock is checked against HEAD.
    crate::git::branch::guard_head_unlocked_at(&repo_path)?;
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
}
