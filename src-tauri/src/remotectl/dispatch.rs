//! What a paired phone is allowed to ask this app to do.
//!
//! # This file is the security boundary, not the auth layer
//!
//! `auth.rs` decides *whether* a request is from a device you paired. This decides *what any
//! device can do at all* — and it is the stronger of the two guarantees, because it holds even if
//! the first one fails. A stolen token, a bug in the bearer check, a device you forgot to revoke:
//! all of them are bounded by the table below. Nothing outside it is reachable over the network,
//! ever, by anyone.
//!
//! So the table is written as an explicit `match` with one arm per command, and **not** as a
//! lookup into the app's real command registry. That is a deliberate refusal of convenience: over
//! 900 commands are registered in `lib.rs`, and a design where the network could name any of them
//! would be one `generate_handler!` edit away from exposing the next one somebody adds.
//!
//! The `match` is also fenced by [`ALLOWED`], checked before it runs. Two lists for one fact is
//! normally a hole waiting for the edit that updates one of them — here it is the opposite, because
//! a command has to be in *both* to be reachable: forgetting either one refuses it. What the pair
//! buys is a list a test can read without an `AppHandle` — see `nothing_destructive_is_reachable`,
//! which pins the commands that must never appear in it.
//!
//! ## What is behind a switch of its own
//!
//! * The terminal (`open_terminal`, `write_terminal`, `resize_terminal`, `read_terminal`,
//!   `list_terminals`, `list_shell_profiles`). A PTY is an arbitrary shell, and there is no subset of
//!   "run a command" that is safe to hand to a bearer token on a home network — so these are in the
//!   table, but each one answers `NotAllowed` until the user turns on
//!   [`crate::remotectl::SETTING_ALLOW_TERMINAL`], which is off by default and re-read on every call
//!   ([`require_terminal`]). `close_terminal` is the one exception, for the reason its arm gives.
//!
//! ## What is deliberately absent, and why
//!
//! * Everything that destroys work: `discard_*`, `reset_to_commit`, `delete_branch`,
//!   `git_push_force_with_lease`, `stash_drop`, `amend_commit` and every other history rewrite —
//!   see the git section of the table.
//! * `fs_*` writes, `delete_*` of anything on disk — a phone screen is the worst possible place to
//!   confirm a destructive path, and the app has no undo for most of them.
//! * `keyvault_*` — the user's own passwords. Nothing about driving a machine from a phone needs
//!   one, and a stolen device token must not be a way into the keyring.
//! * `secrets_*`, and every `*_connections` command — these read and write the OS keychain. The
//!   phone never needs a credential; it needs the *result* of using one.
//! * `db_*` and `remote_*` — database sessions and SSH hosts carry other people's credentials and
//!   reach machines beyond this one. Out of scope for a control surface by definition.
//! * `backup_*`, `quit_app`, `reset_app_data` — install-level operations. A misfire is
//!   unrecoverable and the phone gains nothing by having them.
//! * `git_clone`, `create_project`, `delete_*` — anything that writes new trees to disk or removes
//!   configured work. Adding a repository is a desk activity.
//!
//! ## What "mutating" buys
//!
//! Every arm that changes state returns an [`Invalidate`] alongside its value. The server emits it
//! as `state:invalidate`, which is what makes the desktop window redraw for an action taken on the
//! phone — see `bridge.rs`. Read-only arms return `Invalidate::None` and the desktop hears nothing,
//! which is correct: nothing changed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::commands;
use crate::db::Db;

/// Which part of the desktop's in-memory state a call invalidated.
///
/// A domain rather than a payload on purpose. Sending the *new* value would mean this layer
/// knowing the shape of every zustand store, and would be wrong the moment two clients act at
/// once; sending "your copy of X is stale" makes the desktop re-read through the same code path it
/// already uses, so there is one loader per domain instead of two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalidate {
    None,
    /// Working tree, index, branches, commits — anything the Changes/Repository screens draw.
    Repo,
    /// Agent chains and their steps, including the human gate.
    Chains,
    /// The task tree.
    Tasks,
    /// Saved PR review runs and their findings.
    Reviews,
    /// Chat conversations and their turns.
    Chat,
    /// The workspace list and the repositories in each — created, renamed, recoloured, reordered,
    /// removed. Emitted only by the desktop's own windows (`notify_state_change`): every workspace
    /// and project command in the table above is read-only, because creating or moving one names a
    /// path on a disk the phone cannot see. It exists because the *windows* needed it: each holds
    /// its own copy of the list, loaded once, so a workspace created in the main window never
    /// appeared in a detached window's picker.
    Workspaces,
    /// The desktop's notification centre, republished by its main window whenever it changes (see
    /// `remotectl_publish_notifications`). Never raised by a phone's call: a phone can read that list
    /// and nothing else — marking, clearing and following entries stay at the desk.
    Notifications,
    //
    // No `Terminal` variant either, for a different reason: terminal state does not live in a
    // store that goes stale. Output arrives as `terminal:output` events, which both clients are
    // already subscribed to, so there is nothing to invalidate.
}

/// What a call did, as something the desktop can put in front of a person.
///
/// Separate from [`Invalidate`] because the two questions are genuinely different, and collapsing
/// them was the bug this exists to fix. `Invalidate` answers "is my copy of this stale" — a
/// mechanical question with a mechanical answer. This answers "is this worth telling the user
/// about", which is a judgement: a commit made from a phone deserves a line in the notification
/// centre, and the fourteen `write_terminal` calls it took to type the message do not.
///
/// A stable key rather than a sentence, for the same reason every notification in this app carries
/// a key: the desktop renders it in whatever language is set now, not the one that happened to be
/// active when a phone in another room pressed a button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Announce(pub Option<&'static str>);

/// Which calls are worth a line in the desktop's notification centre, and what to call them.
///
/// # Why this is a second match on the same command names
///
/// The allowlist above is deliberately *one* table, because a command missing from it must be
/// unreachable — a second list to keep in sync would be one edit away from a hole. This table has
/// the opposite failure mode: a command missing from it produces no notification, which is
/// cosmetic. That asymmetry is what makes the duplication acceptable here and not there.
///
/// The alternative was threading a third argument through twenty already-long arms, which buries
/// the one interesting bit — *which* actions deserve interrupting somebody — inside call syntax.
/// Here it is a list you can read.
///
/// Note what is absent. `write_terminal` and `resize_terminal` fire per keystroke and per rotation;
/// announcing them would turn the notification centre into a keylogger's output. Reads are absent
/// for the obvious reason. Opening and closing a shell *are* here, because a phone starting a
/// terminal session on your machine is exactly the kind of thing you want to be told about.
pub fn announce_for(cmd: &str) -> Announce {
    Announce(match cmd {
        "commit" => Some("remote.action.commit"),
        "git_push" => Some("remote.action.push"),
        "git_pull" => Some("remote.action.pull"),
        "git_fetch" => Some("remote.action.fetch"),
        "checkout_local_branch" => Some("remote.action.checkout"),
        // Same event as far as the person at the desk is concerned: HEAD moved, and the files under
        // their editor changed with it. That the branch had to be created locally first is an
        // implementation detail of following a remote ref, not a second thing that happened.
        "checkout_remote_tracking" => Some("remote.action.checkout"),
        "create_branch" => Some("remote.action.branch"),
        "approve_chain_gate" => Some("remote.action.gateApproved"),
        "skip_chain_step" => Some("remote.action.stepSkipped"),
        "abort_chain" => Some("remote.action.chainAborted"),
        "resume_chain" => Some("remote.action.chainResumed"),
        "retry_chain_step" => Some("remote.action.stepRetried"),
        "cancel_ai_run" => Some("remote.action.runCancelled"),
        "review_pull_request" => Some("remote.action.prReviewed"),
        // The three that write to somebody else's server under the user's name. Every one of them
        // is announced — a public act taken from a pocket is the single most important thing this
        // notification centre can tell the person at the desk.
        "act_on_pull_request" => Some("remote.action.prActed"),
        "post_pr_review_comment" => Some("remote.action.prCommented"),
        "resolve_pr_comment_thread" => Some("remote.action.threadResolved"),
        "discard_pr_finding" => Some("remote.action.findingDiscarded"),
        "analyze_working_changes" => Some("remote.action.analyzed"),
        "send_chat_message" => Some("remote.action.chat"),
        "open_terminal" => Some("remote.action.terminalOpened"),
        "close_terminal" => Some("remote.action.terminalClosed"),
        // Work set aside coming back into the tree under somebody's editor.
        "stash_apply" => Some("remote.action.stashApplied"),
        "stash_pop" => Some("remote.action.stashPopped"),
        // Both act on a host's pipeline under the user's name, like the pull-request actions above.
        "rerun_pipeline" => Some("remote.action.pipelineRerun"),
        "cancel_pipeline" => Some("remote.action.pipelineCancelled"),
        // A process started or stopped on this machine from somewhere else — a dev server the person
        // at the desk is using can go away under them, and they should be told why.
        "flows_decide_wait" => Some("remote.action.flowDecided"),
        "flows_run_from_phone" => Some("remote.action.flowStarted"),
        "services_start" => Some("remote.action.servicesStarted"),
        "services_stop" => Some("remote.action.servicesStopped"),
        "services_restart" => Some("remote.action.servicesRestarted"),
        // Staging is left out on purpose: it is what somebody does a dozen times while composing
        // one commit, and the commit is the event. Announcing both means the interesting line
        // arrives already buried.
        _ => None,
    })
}

impl Invalidate {
    fn key(self) -> Option<&'static str> {
        match self {
            Invalidate::None => None,
            Invalidate::Repo => Some("repo"),
            Invalidate::Chains => Some("chains"),
            Invalidate::Tasks => Some("tasks"),
            Invalidate::Reviews => Some("reviews"),
            Invalidate::Chat => Some("chat"),
            Invalidate::Workspaces => Some("workspaces"),
            Invalidate::Notifications => Some("notifications"),
        }
    }

    pub fn as_payload(self) -> Option<Value> {
        self.key().map(|domain| json!({ "domain": domain }))
    }

    /// The inverse of [`key`](Self::key), for the desktop's own emitter.
    ///
    /// The webview names a domain as a string (`bridge::emit_desktop_change` is reached through a
    /// Tauri command), and this is where that string is checked. Unknown names answer `None` rather
    /// than a harmless-looking `Invalidate::None`: a typo that emits an empty frame is a sync bug
    /// that looks like a network problem, and there is no reason to guess.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "repo" => Some(Invalidate::Repo),
            "chains" => Some(Invalidate::Chains),
            "tasks" => Some(Invalidate::Tasks),
            "reviews" => Some(Invalidate::Reviews),
            "chat" => Some(Invalidate::Chat),
            "workspaces" => Some(Invalidate::Workspaces),
            "notifications" => Some(Invalidate::Notifications),
            _ => None,
        }
    }
}

/// A refused command names itself in the log but not in the response — see `server.rs`.
#[derive(Debug)]
pub enum DispatchError {
    /// The command is not in the table. Not a typo to be helpful about: the client is either out
    /// of date or probing.
    NotAllowed,
    /// The command is in the table but the arguments do not fit it.
    BadArgs(String),
    /// The command ran and failed on its own terms — a git error, a database error. This is the
    /// only variant whose text is safe to hand back, because it is the same text the desktop UI
    /// would show for the same action.
    Failed {
        /// The engine's or git's own message.
        message: String,
        /// What the *attempt* made stale, which is not always nothing.
        ///
        /// A review or an analysis that fails still writes a durable `job_history` row carrying the
        /// error, so the desktop's copy of that history is exactly as out of date as it would be
        /// after a success — and the invalidation used to live only in the `Ok` arm. A failed run
        /// from a phone therefore produced a row nobody re-read and no notification at all, which
        /// reads as the action having silently done nothing.
        ///
        /// Most failures genuinely write nothing, which is why [`From<String>`] fills this with
        /// [`Invalidate::None`] and only the two arms that file a row say otherwise.
        invalidate: Invalidate,
    },
}

impl DispatchError {
    /// A failure that left something durable behind. See [`DispatchError::Failed::invalidate`].
    fn failed(message: String, invalidate: Invalidate) -> Self {
        DispatchError::Failed { message, invalidate }
    }
}

impl From<String> for DispatchError {
    fn from(e: String) -> Self {
        DispatchError::Failed {
            message: e,
            invalidate: Invalidate::None,
        }
    }
}

/// Pulls one argument out of the request body.
///
/// Accepts `camelCase` first and `snake_case` second so the mobile client can be written against
/// the same names `src/lib/tauri/commands.ts` already uses (Tauri camel-cases command parameters
/// on the way in), while a hand-rolled request in the Rust spelling still works.
fn arg<T: for<'de> Deserialize<'de>>(args: &Value, name: &str) -> Result<T, DispatchError> {
    let snake = to_snake(name);
    let raw = args
        .get(name)
        .or_else(|| args.get(&snake))
        .ok_or_else(|| DispatchError::BadArgs(format!("missing argument `{name}`")))?;
    serde_json::from_value(raw.clone())
        .map_err(|e| DispatchError::BadArgs(format!("argument `{name}`: {e}")))
}

/// The same, for an argument the command itself treats as optional. A missing key and an explicit
/// `null` mean the same thing, which is what every `Option<T>` parameter in the command layer
/// already assumes.
fn opt<T: for<'de> Deserialize<'de>>(args: &Value, name: &str) -> Result<Option<T>, DispatchError> {
    let snake = to_snake(name);
    match args.get(name).or_else(|| args.get(&snake)) {
        None | Some(Value::Null) => Ok(None),
        Some(raw) => serde_json::from_value(raw.clone())
            .map_err(|e| DispatchError::BadArgs(format!("argument `{name}`: {e}"))),
    }
}

fn to_snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for ch in name.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// `app_settings` keys the desktop window writes on every workspace and project switch.
///
/// Owned by `src/state/workspaceStore.ts`, which is why they are string literals here rather than
/// constants imported from somewhere: nothing in Rust writes them, and pretending otherwise by
/// giving them a home in a settings module would suggest a producer that does not exist.
const LAST_WORKSPACE_KEY: &str = "last_active_workspace_id";
const LAST_PROJECT_KEY: &str = "last_active_project_id";

/// Where the desktop last was, or `None` when it has never said.
///
/// A missing row is the ordinary case on a fresh install and is answered as "no opinion" rather
/// than as an error: the caller falls back to the first entry, which is what it always did.
fn last_active(app: &AppHandle, key: &str) -> Option<String> {
    let db = app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => e.into_inner(),
    };
    crate::db::queries::get_setting(&conn, key)
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

/// The gate in front of every terminal arm.
///
/// Answers [`DispatchError::NotAllowed`] — the same refusal an unknown command gets: a 403, which
/// the client reports and does not mistake for a revoked token (see `server::rpc` for why it is no
/// longer the 401 a bad token gets). To a client, "terminals are switched off here" and "no such
/// command" are indistinguishable, so probing for the switch tells an attacker nothing about whether
/// it exists to be flipped.
///
/// The setting is read from the database on every call rather than cached, so revoking terminal
/// access takes effect on the next request with nothing to restart. See
/// [`crate::remotectl::SETTING_ALLOW_TERMINAL`].
fn require_terminal(app: &AppHandle) -> Result<(), DispatchError> {
    if crate::remotectl::terminal_allowed(&app.state::<Db>()) {
        Ok(())
    } else {
        Err(DispatchError::NotAllowed)
    }
}

/// The gate in front of every terminal arm that names an **existing session**.
///
/// # What this stops
///
/// A pty id is a bare uuid on the wire, and until this existed any of them worked. A phone could
/// write bytes into, resize, or kill *any* session on the machine: the shell somebody at the desk is
/// typing into, a bench terminal running a build, and — the sharpest case — a live `ssh -t` in the
/// Remote workspace, which the allowlist's own module docs list as deliberately out of scope. It did
/// not even need to guess ids, because every one of them used to arrive in its own event stream.
///
/// Refused as [`DispatchError::NotAllowed`] (403) rather than as a failure, because it is the same
/// class of answer as a switched-off command: the caller is authenticated, and this is a thing it may
/// not do.
///
/// An **unknown** id is deliberately allowed through to the command, which answers "no such terminal
/// session". A shell that has exited is gone from the registry (see `terminal::open_pty`), and
/// telling the client it lacks permission for a session that no longer exists would send it looking
/// for a setting to change instead of reopening the shell.
fn require_owner(app: &AppHandle, device_id: &str, id: &str) -> Result<(), DispatchError> {
    match crate::terminal::owner_of(&app.state::<crate::terminal::TerminalRegistry>(), id) {
        None => Ok(()),
        Some(Some(owner)) if owner == device_id => Ok(()),
        Some(_) => Err(DispatchError::NotAllowed),
    }
}

/// Serializes a command's return value, turning the "this cannot fail" case into a `Failed` rather
/// than a panic — a type that will not serialize is a bug here, not a reason to kill the server.
fn ok<T: serde::Serialize>(value: T) -> Result<(Value, Invalidate), DispatchError> {
    serde_json::to_value(value)
        .map(|v| (v, Invalidate::None))
        .map_err(|e| DispatchError::from(e.to_string()))
}

/// The same, for an arm that changed something.
fn ok_with<T: serde::Serialize>(value: T, inv: Invalidate) -> Result<(Value, Invalidate), DispatchError> {
    serde_json::to_value(value)
        .map(|v| (v, inv))
        .map_err(|e| DispatchError::from(e.to_string()))
}

/// Every command a phone may name — the fence in front of the table in [`dispatch`].
///
/// A command must be here **and** have an arm below to be reachable; see the module docs for why two
/// lists for one fact make a hole harder, not easier. Grouped as the table is.
pub const ALLOWED: &[&str] = &[
    // Bootstrap, workspaces and projects — read only.
    "remote_bootstrap",
    "list_workspaces",
    "list_projects",
    "get_project",
    "watch_project",
    // Git — read.
    "get_status",
    "list_commits",
    "list_unpushed_commits",
    "list_branches",
    "list_stashes",
    "get_working_diff",
    "get_staged_diff",
    "get_file_diff",
    "get_commit_diff",
    // Git — finishing work already on the disk.
    "stage_file",
    "stage_all",
    "unstage_file",
    "unstage_all",
    "commit",
    "checkout_local_branch",
    "checkout_remote_tracking",
    "create_branch",
    "git_fetch",
    "git_pull",
    "git_push",
    "stash_apply",
    "stash_pop",
    // Agent chains, tasks and runs.
    "list_agent_chains",
    "get_chain_detail",
    "list_workspace_chain_steps",
    "approve_chain_gate",
    "skip_chain_step",
    "retry_chain_step",
    "resume_chain",
    "abort_chain",
    "list_agent_tasks",
    "get_agent_task",
    "set_agent_task_pinned",
    "cancel_ai_run",
    "list_active_runs",
    // Meters and history.
    "ai_usage_stats",
    "ai_quota_status",
    "list_job_history",
    "get_job_result",
    "list_workspace_activity",
    // The pre-commit pass.
    "scan_staged_secrets",
    "analyze_working_changes",
    // Pull requests and acting on a review.
    "list_pull_requests",
    "pr_review_decision",
    "list_pr_comment_threads",
    "review_pull_request",
    "list_review_runs",
    "get_review_run",
    "act_on_pull_request",
    "post_pr_review_comment",
    "discard_pr_finding",
    "resolve_pr_comment_thread",
    // Pipelines.
    "pipeline_availability",
    "list_pipeline_runs",
    "pipeline_run_detail",
    "rerun_pipeline",
    "cancel_pipeline",
    // Flujos: the runs waiting for someone, and the flows a phone trigger lets it start.
    "flows_list_waits",
    "flows_decide_wait",
    "flows_phone_flows",
    "flows_run_from_phone",
    // Services.
    "list_services",
    "services_runtime",
    "services_start",
    "services_stop",
    "services_restart",
    // Chat.
    "send_chat_message",
    "list_chat_conversations",
    "get_chat_conversation",
    // The notification centre — read only.
    "list_notifications",
    // Terminals — every one but `close_terminal` behind `SETTING_ALLOW_TERMINAL`.
    "list_shell_profiles",
    "list_terminals",
    "read_terminal",
    "open_terminal",
    "write_terminal",
    "resize_terminal",
    "close_terminal",
];

/// Whether a phone may name `cmd` at all. See [`ALLOWED`].
pub fn is_allowed(cmd: &str) -> bool {
    ALLOWED.contains(&cmd)
}

/// What a stash action answers when the list moved under the phone: a code the client turns into
/// its own sentence, not a message for a person. See the stash arm.
pub const STASH_MOVED: &str = "stash_moved";

/// Runs one allowed command.
///
/// Deliberately takes `&AppHandle` rather than the individual states: several arms need the handle
/// itself (the git network operations emit progress through it), and pulling `State<Db>` off the
/// handle per arm keeps the lock held for exactly as long as the command holds it.
///
/// `device_id` is *who is asking*, and it is here for the arms whose effect is per-device rather
/// than global — today that is `watch_project`, which registers a claim released when this device's
/// socket closes. It is never used as an authorisation input: `auth.rs` has already decided that
/// this is a device you paired, and the table below is the same table for every one of them.
pub async fn dispatch(
    app: &AppHandle,
    device_id: &str,
    cmd: &str,
    args: &Value,
) -> Result<(Value, Invalidate), DispatchError> {
    if !is_allowed(cmd) {
        return Err(DispatchError::NotAllowed);
    }
    match cmd {
        // ---------------------------------------------------------------
        // Bootstrap
        // ---------------------------------------------------------------
        //
        // Not a command the desktop has. A phone opening cold needs the workspace list, the
        // projects in the active one and the chains that are waiting on a human — three round
        // trips over a home wifi that may well be one bar. This is those three in one.
        "remote_bootstrap" => {
            let workspaces = commands::repos::list_workspaces(app.state::<Db>())?;
            let active: Option<String> = opt(args, "workspaceId")?;
            // The scope the *desktop* is in, when the client did not name one of its own.
            //
            // `workspaces.first()` was the old default, and it is the reason the two screens
            // disagreed on a machine with more than one workspace: the phone opened on whichever
            // workspace happened to sort first and the desk was somewhere else entirely, so
            // "muéstrame lo que estoy haciendo" showed a different repository's chains. These are
            // the same two keys `workspaceStore.ts` writes on every switch, so following them is
            // literally landing where the person left off.
            //
            // Read, never written: the phone picking a workspace must not drag the desktop's window
            // to it. Its selection stays local, exactly as it is today.
            let workspace_id = active
                .or_else(|| last_active(app, LAST_WORKSPACE_KEY))
                // Validated against the list, because the stored id can name a workspace that was
                // deleted since — a dangling default would answer empty projects for a machine that
                // has plenty.
                .filter(|id| workspaces.iter().any(|w| &w.id == id))
                .or_else(|| workspaces.first().map(|w| w.id.clone()))
                .unwrap_or_default();

            // Whether this install grants shells, told rather than discovered.
            //
            // The client used to find out by *calling* a terminal command and seeing whether it was
            // refused. That is the single most expensive line of code in the feature: a refusal and
            // a bad token were the same 401, so on the default configuration — terminals off — the
            // probe convinced every phone it had been revoked, and it deleted its own token at
            // startup. The refusal now answers 403 (see `server::rpc`), and this field means the
            // probe does not have to happen at all.
            //
            // Read here rather than cached anywhere: the value is one indexed lookup, and the
            // switch has to be able to change between two bootstraps.
            let allow_terminal = crate::remotectl::terminal_allowed(&app.state::<Db>());

            if workspace_id.is_empty() {
                return ok(json!({
                    "workspaces": workspaces,
                    "workspaceId": null,
                    "projects": [],
                    "projectId": null,
                    "chains": [],
                    "allowTerminal": allow_terminal,
                }));
            }

            let projects = commands::repos::list_projects(app.state::<Db>(), workspace_id.clone())?;
            let chains = commands::agents_cmd::list_agent_chains(app.state::<Db>(), workspace_id.clone())?;
            // The same alignment one level down, and the same validation: the desk's project only
            // when it is in the workspace being answered, because the two settings move
            // independently and the stored project may well belong to another one.
            let project_id = last_active(app, LAST_PROJECT_KEY)
                .filter(|id| projects.iter().any(|p| &p.id == id))
                .or_else(|| projects.first().map(|p| p.id.clone()));
            ok(json!({
                "workspaces": workspaces,
                "workspaceId": workspace_id,
                "projects": projects,
                "projectId": project_id,
                "chains": chains,
                "allowTerminal": allow_terminal,
            }))
        }

        // ---------------------------------------------------------------
        // Workspaces and projects — read only
        // ---------------------------------------------------------------
        //
        // Creating, deleting, moving and recolouring are all absent. A project is a path on a disk
        // the phone cannot see, so there is nothing useful it could set.
        "list_workspaces" => ok(commands::repos::list_workspaces(app.state::<Db>())?),
        "list_projects" => ok(commands::repos::list_projects(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
        )?),
        "get_project" => ok(commands::repos::get_project(app.state::<Db>(), arg(args, "id")?)?),

        // Which repository *this device* wants filesystem events for.
        //
        // # Why a phone has to ask
        //
        // `repo:fs-changed` is what makes an edit made anywhere — the desk's editor, an external
        // `git` command, an agent rewriting the tree — appear without anybody pressing refresh. It
        // comes from a native watcher, and until this arm existed the only thing that could start
        // one was the desktop window, on the project *it* had open. A phone on any other project
        // therefore had no watcher behind it at all: its Repo tab was live for exactly one
        // repository, the one somebody at the desk happened to have selected.
        //
        // Registered under this device's own holder, so it is reference counted alongside the
        // window's claim (see `watcher::WatcherRegistry`) and released when this socket closes.
        // `follow` and not `start_watching`: this client shows one project at a time, so asking for
        // a new one means letting go of the last.
        //
        // `Invalidate::None` and absent from `announce_for` — it changes nothing anyone holds a
        // copy of, and "a phone opened a project" is not news.
        "watch_project" => {
            let id: String = arg(args, "projectId")?;
            let project = commands::repos::get_project(app.state::<Db>(), id.clone())?
                .ok_or_else(|| DispatchError::BadArgs(format!("no such project `{id}`")))?;
            crate::watcher::follow(
                app.clone(),
                &app.state::<crate::watcher::WatcherRegistry>(),
                &crate::watcher::device_holder(device_id),
                project.local_path,
            )?;
            ok(true)
        }

        // ---------------------------------------------------------------
        // Git — read
        // ---------------------------------------------------------------
        "get_status" => ok(commands::git_ops::get_status(arg(args, "repoPath")?)?),
        "list_commits" => ok(commands::git_ops::list_commits(
            arg(args, "repoPath")?,
            opt(args, "allRefs")?.unwrap_or(false),
            // Clamped rather than trusted: this is the one read whose cost scales with an argument
            // the client picks, and a phone has no reason to ask for ten thousand commits.
            opt::<usize>(args, "limit")?.unwrap_or(50).min(200),
        )?),
        "list_unpushed_commits" => ok(commands::git_ops::list_unpushed_commits(arg(args, "repoPath")?)?),
        "list_branches" => ok(commands::git_ops::list_branches(arg(args, "repoPath")?)?),
        "list_stashes" => ok(commands::git_ops::list_stashes(arg(args, "repoPath")?)?),
        // Context defaults to a screenful rather than the desktop's full-file: the phone renders a
        // unified diff in a narrow column and never reconstructs both sides of a file.
        "get_working_diff" => ok(commands::git_ops::get_working_diff(
            arg(args, "repoPath")?,
            Some(opt::<u32>(args, "contextLines")?.unwrap_or(3)),
        )?),
        "get_staged_diff" => ok(commands::git_ops::get_staged_diff(
            arg(args, "repoPath")?,
            Some(opt::<u32>(args, "contextLines")?.unwrap_or(3)),
        )?),
        // The same screenful default as the two above, and it is this arm that made it matter: the
        // phone was already sending `contextLines: 3` and the argument was being dropped on the
        // floor, so opening one file's diff downloaded the whole file — every line of it, as JSON
        // line objects, over wifi, to draw a handful of changed lines. Safe to narrow here and
        // nowhere else because this client renders a unified diff and reconstructs no sides.
        "get_file_diff" => ok(commands::git_ops::get_file_diff(
            arg(args, "repoPath")?,
            arg(args, "path")?,
            opt(args, "staged")?.unwrap_or(false),
            Some(opt::<u32>(args, "contextLines")?.unwrap_or(3)),
        )?),
        "get_commit_diff" => ok(commands::git_ops::get_commit_diff(
            arg(args, "repoPath")?,
            arg(args, "oid")?,
        )?),

        // ---------------------------------------------------------------
        // Git — mutating
        // ---------------------------------------------------------------
        //
        // The set is "what you would do to finish work already on the disk": stage it, commit it,
        // send it, or move to another branch to look at something. Deliberately no
        // `discard_*`, no `reset_to_commit`, no `delete_branch`, no history rewriting — every one
        // of those destroys work, and a phone in a pocket is the wrong place to confirm it.
        "stage_file" => ok_with(
            commands::git_ops::stage_file(arg(args, "repoPath")?, arg(args, "filePath")?)?,
            Invalidate::Repo,
        ),
        "stage_all" => ok_with(commands::git_ops::stage_all(arg(args, "repoPath")?)?, Invalidate::Repo),
        "unstage_file" => ok_with(
            commands::git_ops::unstage_file(arg(args, "repoPath")?, arg(args, "filePath")?)?,
            Invalidate::Repo,
        ),
        "unstage_all" => ok_with(commands::git_ops::unstage_all(arg(args, "repoPath")?)?, Invalidate::Repo),
        "commit" => ok_with(
            commands::git_ops::commit(
                arg(args, "repoPath")?,
                arg(args, "message")?,
                opt(args, "authorName")?,
                opt(args, "authorEmail")?,
            )?,
            Invalidate::Repo,
        ),
        "checkout_local_branch" => ok_with(
            commands::git_ops::checkout_local_branch(arg(args, "repoPath")?, arg(args, "name")?)?,
            Invalidate::Repo,
        ),
        // The remote-only half of the branch picker. Without it the list a phone can *see* is
        // strictly larger than the list it can switch to: `list_branches` returns every
        // remote-tracking ref, and tapping one had no command behind it. This creates the local
        // branch tracking it (or reuses one) and checks it out — exactly what "connect to this
        // branch" means everywhere else in the app, and it writes nothing that `create_branch`
        // plus `checkout_local_branch` would not have written by hand.
        "checkout_remote_tracking" => ok_with(
            commands::git_ops::checkout_remote_tracking(arg(args, "repoPath")?, arg(args, "remoteBranch")?)?,
            Invalidate::Repo,
        ),
        "create_branch" => ok_with(
            commands::git_ops::create_branch(
                arg(args, "repoPath")?,
                arg(args, "name")?,
                opt(args, "startPoint")?,
            )?,
            Invalidate::Repo,
        ),
        "git_fetch" => ok_with(
            commands::git_ops::git_fetch(app.clone(), arg(args, "repoPath")?, opt(args, "remoteName")?).await?,
            Invalidate::Repo,
        ),
        "git_pull" => ok_with(
            commands::git_ops::git_pull(app.clone(), arg(args, "repoPath")?).await?,
            Invalidate::Repo,
        ),
        "git_push" => ok_with(
            commands::git_ops::git_push(
                app.clone(),
                arg(args, "repoPath")?,
                opt(args, "setUpstream")?.unwrap_or(false),
            )
            .await?,
            Invalidate::Repo,
        ),

        // ---------------------------------------------------------------
        // Agent chains — including the human gate
        // ---------------------------------------------------------------
        //
        // This is the reason the whole feature exists. A chain parks on a gate and stays parked
        // until somebody answers it; being able to answer from a phone is the difference between a
        // run finishing over lunch and a run finishing when you get back.
        "list_agent_chains" => ok(commands::agents_cmd::list_agent_chains(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
        )?),
        "get_chain_detail" => ok(commands::agents_cmd::get_chain_detail(
            app.state::<Db>(),
            arg(args, "chainId")?,
        )?),
        "list_workspace_chain_steps" => ok(commands::agents_cmd::list_workspace_chain_steps(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
        )?),
        // `stepId` is a precondition, not an argument: it names the step the phone had on screen,
        // and the command refuses when the chain has moved past it. A phone is the client this
        // matters most for — its copy of a gate can be minutes old, and the tap that clears it is
        // one thumb away from a chain the desk is mid-run.
        "approve_chain_gate" => ok_with(
            commands::agents_cmd::approve_chain_gate(
                app.state::<Db>(),
                arg(args, "chainId")?,
                opt::<String>(args, "input")?.unwrap_or_default(),
                opt(args, "stepId")?,
            )?,
            Invalidate::Chains,
        ),
        "skip_chain_step" => ok_with(
            commands::agents_cmd::skip_chain_step(app.state::<Db>(), arg(args, "chainId")?)?,
            Invalidate::Chains,
        ),
        "retry_chain_step" => ok_with(
            commands::agents_cmd::retry_chain_step(app.state::<Db>(), arg(args, "chainId")?)?,
            Invalidate::Chains,
        ),
        "resume_chain" => ok_with(
            commands::agents_cmd::resume_chain(app.state::<Db>(), arg(args, "chainId")?)?,
            Invalidate::Chains,
        ),
        "abort_chain" => ok_with(
            commands::agents_cmd::abort_chain(app.state::<Db>(), arg(args, "chainId")?)?,
            Invalidate::Chains,
        ),

        // ---------------------------------------------------------------
        // Agent tasks — read, plus the two flags that are pure filing
        // ---------------------------------------------------------------
        "list_agent_tasks" => ok(commands::agents_cmd::list_agent_tasks(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
        )?),
        "get_agent_task" => ok(commands::agents_cmd::get_agent_task(app.state::<Db>(), arg(args, "id")?)?),
        "set_agent_task_pinned" => ok_with(
            commands::agents_cmd::set_agent_task_pinned(
                app.state::<Db>(),
                arg(args, "id")?,
                arg(args, "pinned")?,
            )?,
            Invalidate::Tasks,
        ),

        // ---------------------------------------------------------------
        // Runs in flight
        // ---------------------------------------------------------------
        //
        // Cancelling is allowed and starting is not. Stopping something already running is
        // recoverable and is exactly what you want from a phone when a run has gone wrong; picking
        // an engine, a model, a repository and a prompt is a desk decision, and a mistake there
        // spends real money on somebody's API.
        "cancel_ai_run" => ok_with(
            commands::claude_cmd::cancel_ai_run(arg(args, "runId")?),
            Invalidate::Chains,
        ),
        // Which runs are still going, as ids and nothing else.
        //
        // The reconciliation a reconnecting phone needs. It builds its run list from `ai:engine`
        // and `ai:output-batch` frames and closes each card on `ai:done` — so a run that ended
        // while the screen was locked leaves a card spinning forever over a dead stop button,
        // because the one frame that would have closed it was dropped with the socket. Comparing
        // its own list against this settles every such card in one call.
        //
        // Deliberately no transcript, no engine, no start time: those would make this a second,
        // parallel description of a run, and the frames are already the one description. This
        // answers a single question — is it still going — and `Invalidate::None`, because asking
        // changed nothing.
        "list_active_runs" => ok(crate::ai_runs::active()),

        // ---------------------------------------------------------------
        // Meters and history — read only
        // ---------------------------------------------------------------
        "ai_usage_stats" => ok(commands::app_cmd::ai_usage_stats(
            app.state::<Db>(),
            opt(args, "windowHours")?.unwrap_or(24),
            opt(args, "account")?,
        )?),
        // `trigger` is forced to `poll`: `open` and `refresh` let a provider read its quota by
        // *running its CLI*, and a phone polling in somebody's pocket must never spawn a
        // subprocess on the desktop — on Windows that flashes a console window over whatever the
        // user is doing. See `ai_quota::Trigger`.
        "ai_quota_status" => ok(
            commands::app_cmd::ai_quota_status(app.state::<Db>(), Some("poll".into())).await?,
        ),
        "list_job_history" => ok(commands::activity_cmd::list_job_history(
            app.state::<Db>(),
            arg(args, "projectId")?,
            Some(opt::<i64>(args, "limit")?.unwrap_or(30).min(100)),
            opt(args, "offset")?,
            opt(args, "withResult")?,
        )?),
        "get_job_result" => ok(commands::activity_cmd::get_job_result(
            app.state::<Db>(),
            arg(args, "id")?,
        )?),
        "list_workspace_activity" => ok(commands::activity_cmd::list_workspace_activity(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
            Some(opt::<i64>(args, "limit")?.unwrap_or(30).min(100)),
            opt(args, "offset")?,
            opt(args, "withResult")?,
        )?),

        // ---------------------------------------------------------------
        // The pre-commit pass
        // ---------------------------------------------------------------
        //
        // The two checks that run over a working tree before anything is committed, and the reason
        // the diff reads above are in this table at all: reading a diff on a phone is only useful
        // if you can act on what it says.
        //
        // `scan_staged_secrets` is pure local pattern-matching over the index — no engine, no
        // network, no cost — so it is a plain read. `analyze_working_changes` spawns an engine, and
        // like every other engine call here it passes `None` for provider/model/prompt so the run
        // routes exactly as the desktop would route it.
        //
        // Neither one writes to the tree. The findings land in the activity log, which is why the
        // invalidation is `Reviews` rather than `Repo` — nothing about the working copy moved.
        "scan_staged_secrets" => ok(commands::secret_scan_cmd::scan_staged_secrets(
            arg(args, "repoPath")?,
        )?),
        // One of the two arms whose *failure* is durable — see `DispatchError::Failed`. The engine
        // erroring still files a `job_history` row under the job id the phone minted, so the
        // desktop has something new to read either way. The one refusal that files nothing is an
        // empty working tree (`NOTHING_TO_ANALYZE_MARKER`): no engine ran, so there is no run.
        "analyze_working_changes" => ok_with(
            commands::claude_cmd::analyze_working_changes(
                app.clone(),
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "jobId")?,
                None,
                None,
                None,
            )
            .await
            .map_err(|e| DispatchError::failed(e, Invalidate::Reviews))?,
            Invalidate::Reviews,
        ),

        // ---------------------------------------------------------------
        // Pull requests and their reviews
        // ---------------------------------------------------------------
        //
        // No new class of risk: these are the same reads and the same writes the desktop performs,
        // against hosts the user already linked, with credentials that never leave this machine.
        // The phone names a project id and a PR number; every token is resolved on this side.
        //
        // Reviewing costs money — it starts an engine — which is exactly why `review_pull_request`
        // is here and *creating* a pull request is not. Re-reviewing something that already exists
        // is a repeatable, bounded act; opening a PR is a public one.
        "list_pull_requests" => ok(commands::ado_cmd::list_pull_requests(
            app.state::<Db>(),
            arg(args, "projectId")?,
        )
        .await?),
        "pr_review_decision" => ok(commands::ado_cmd::pr_review_decision(
            app.state::<Db>(),
            arg(args, "projectId")?,
            arg(args, "prId")?,
        )
        .await?),
        "list_pr_comment_threads" => ok(commands::ado_cmd::list_pr_comment_threads(
            app.state::<Db>(),
            arg(args, "projectId")?,
            arg(args, "prId")?,
        )
        .await?),
        // The engine picked for this run is deliberately *not* taken from the phone: `None` for all
        // three agent fields means "use whatever this workspace is configured to route to", which
        // is the same decision the desktop button makes. A phone naming its own provider and model
        // would be a device on a home network choosing what somebody's API bill looks like.
        "review_pull_request" => ok_with(
            commands::ado_cmd::review_pull_request(
                app.clone(),
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "prId")?,
                arg(args, "jobId")?,
                opt::<String>(args, "level")?.unwrap_or_else(|| "standard".into()),
                opt(args, "force")?.unwrap_or(false),
                None,
                None,
                None,
            )
            .await
            // The other durable failure. A review that dies halfway still leaves its row.
            .map_err(|e| DispatchError::failed(e, Invalidate::Reviews))?,
            Invalidate::Reviews,
        ),
        "list_review_runs" => ok(commands::settings::list_review_runs(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
        )?),
        "get_review_run" => ok(commands::settings::get_review_run(app.state::<Db>(), arg(args, "id")?)?),

        // ---------------------------------------------------------------
        // Acting on a review — the point of a *control* surface
        // ---------------------------------------------------------------
        //
        // Reading a review from a phone and then having to walk to the desk to act on it is half a
        // feature. These are the three things you do with a finished review, and all three write
        // to the host under the user's own identity.
        //
        // That is the line worth naming: everything above this block either reads, or writes
        // locally, or spends money on the user's own engine. These are **public**, and permanent
        // in the sense that other people see them and get notified. They are offered anyway —
        // approving a pull request from a phone is exactly what somebody wants a control surface
        // for — but the mobile client puts each one behind an explicit confirmation rather than a
        // single tap, which is the same treatment `abort_chain` gets.
        //
        // `create_pull_request` is deliberately still absent, and the distinction is not
        // squeamishness: approving or commenting is an act on something that already exists and
        // that somebody already chose to publish, while opening a pull request publishes work.
        "act_on_pull_request" => ok_with(
            commands::ado_cmd::act_on_pull_request(
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "prId")?,
                arg(args, "action")?,
                opt(args, "body")?,
            )
            .await?,
            // Files a local Activity row of its own, so the desktop has something new to read.
            Invalidate::Reviews,
        ),
        "post_pr_review_comment" => ok_with(
            commands::ado_cmd::post_pr_review_comment(
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "prId")?,
                arg(args, "runId")?,
                arg(args, "items")?,
                opt(args, "postSummary")?.unwrap_or(false),
                opt(args, "summary")?,
            )
            .await?,
            Invalidate::Reviews,
        ),
        // Marking a finding as a false positive or ignoring it. Local first and always; it only
        // reaches the host when `notifyHost` is set *and* the finding has a thread there, which
        // the phone leaves off by default — see the mobile screen.
        "discard_pr_finding" => ok_with(
            commands::ado_cmd::discard_pr_finding(
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "prId")?,
                arg(args, "runId")?,
                arg(args, "findingId")?,
                arg(args, "estado")?,
                opt(args, "motivo")?,
                opt(args, "scopeRepo")?.unwrap_or(false),
                opt(args, "notifyHost")?.unwrap_or(false),
            )
            .await?,
            Invalidate::Reviews,
        ),
        "resolve_pr_comment_thread" => ok_with(
            commands::ado_cmd::resolve_pr_comment_thread(
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "prId")?,
                arg(args, "threadId")?,
                opt(args, "body")?,
                opt(args, "wontFix")?.unwrap_or(false),
            )
            .await?,
            Invalidate::Reviews,
        ),

        // ---------------------------------------------------------------
        // Chat with an engine
        // ---------------------------------------------------------------
        //
        // Same rule as the review above and for the same reason: the provider, model and prompt are
        // `None`, so the turn routes exactly as the desktop would route it. The phone contributes
        // the message and nothing else.
        //
        // `send_chat_message` holds a per-repository lease while it runs, so a phone and the desk
        // cannot start two engines in one working copy — that guard already existed and needed no
        // help from here.
        "send_chat_message" => ok_with(
            commands::claude_cmd::send_chat_message(
                app.clone(),
                app.state::<Db>(),
                arg(args, "projectId")?,
                arg(args, "message")?,
                opt(args, "sessionId")?,
                opt(args, "conversationId")?,
                opt(args, "runId")?,
                None,
                None,
                None,
                None,
                // No streaming: deltas are never forwarded to a phone.
                None,
                // The phone has no skill picker.
                None,
                // Nor an attachment picker.
                None,
            )
            .await?,
            Invalidate::Chat,
        ),
        "list_chat_conversations" => ok(commands::activity_cmd::list_chat_conversations(
            app.state::<Db>(),
            arg(args, "projectId")?,
            opt(args, "search")?,
        )?),
        "get_chat_conversation" => ok(commands::activity_cmd::get_chat_conversation(
            app.state::<Db>(),
            arg(args, "projectId")?,
            arg(args, "sessionId")?,
            opt(args, "withTrace")?,
        )?),

        // ---------------------------------------------------------------
        // Terminals — behind their own switch
        // ---------------------------------------------------------------
        //
        // Every arm here is gated on `SETTING_ALLOW_TERMINAL`, checked per call so revoking takes
        // effect on the next request. See that constant for why a shell is not merely another
        // entry in this table.
        //
        // Note what the API does *not* accept: a command line. `open_terminal` takes a working
        // directory and a profile id, and the profile is resolved against the user's own list on
        // this side (`shell_profiles::resolve`). There is nothing here to inject — the execution
        // arrives later, as keystrokes, which is the same power by a slower route but does mean the
        // surface itself is small.
        "list_shell_profiles" => {
            require_terminal(app)?;
            ok(commands::terminal_cmd::list_shell_profiles(app.state::<Db>())?)
        }
        // The shells *this* device has running, so a client that lost its page can find them again.
        //
        // Everything about a phone is temporary in a way a desktop window is not: the browser tab is
        // evicted under memory pressure, the wifi hands over, the screen locks for long enough that
        // the socket dies. Each of those used to strand a pty — nothing on the desktop drew it, and
        // the phone had forgotten the id — so the shell ran until the app was quit. With this and the
        // session id the client remembers per project, coming back **reattaches** instead of opening
        // a second shell beside the first.
        //
        // Scoped to the caller, not to the machine: the answer names sessions, and a session id is
        // exactly the thing `require_owner` refuses to let another device use. A list of everybody's
        // would be handing out the ids that gate is protecting.
        "list_terminals" => {
            require_terminal(app)?;
            ok(crate::terminal::list_owned(
                &app.state::<crate::terminal::TerminalRegistry>(),
                Some(device_id),
            ))
        }
        // What a session has printed so far, for a client that is attaching rather than opening.
        //
        // The other half of reattaching, and the reason a remote session is recorded at all: without
        // it a phone coming back to a live shell would show an empty screen with a cursor in it,
        // which reads as a broken terminal rather than as a working one whose scrollback lives on the
        // other device.
        //
        // Its own call rather than a field on `list_terminals` — a listing of six shells carrying a
        // quarter of a megabyte each is not a listing, and this is asked for exactly one session, by
        // whoever is about to draw it.
        "read_terminal" => {
            require_terminal(app)?;
            let id: String = arg(args, "id")?;
            require_owner(app, device_id, &id)?;
            ok(crate::terminal::transcript_of(
                &app.state::<crate::terminal::TerminalRegistry>(),
                &id,
            ))
        }
        "open_terminal" => {
            require_terminal(app)?;
            // `open_owned_terminal` and not the plain command: the session is stamped with this
            // device, which is what every arm below checks and what lets the desktop show — and
            // kill — the shells a phone left running. See `terminal::Origin::owner`.
            ok(commands::terminal_cmd::open_owned_terminal(
                app.clone(),
                &app.state::<crate::terminal::TerminalRegistry>(),
                &app.state::<Db>(),
                arg(args, "cwd")?,
                opt(args, "profileId")?,
                device_id.to_string(),
            )?)
        }
        "write_terminal" => {
            require_terminal(app)?;
            let id: String = arg(args, "id")?;
            require_owner(app, device_id, &id)?;
            ok(commands::terminal_cmd::write_terminal(
                app.state::<crate::terminal::TerminalRegistry>(),
                id,
                arg(args, "data")?,
            )?)
        }
        "resize_terminal" => {
            require_terminal(app)?;
            let id: String = arg(args, "id")?;
            require_owner(app, device_id, &id)?;
            ok(commands::terminal_cmd::resize_terminal(
                app.state::<crate::terminal::TerminalRegistry>(),
                id,
                arg(args, "cols")?,
                arg(args, "rows")?,
            )?)
        }
        // **The one terminal arm with no `require_terminal`**, and the omission is the fix.
        //
        // Teardown must always be permitted. Gated like the others, turning the switch off did the
        // opposite of what it says: the shells a phone had already opened kept running — nothing on
        // the desktop draws them — and the one client that still knew their ids was refused when it
        // tried to close them. Withdrawing a permission stranded the very processes it was withdrawn
        // over.
        //
        // `require_owner` still applies, so this is not a hole: a device may close what it opened and
        // nothing else. The reaping paths (`terminal::close_owned`) cover the sessions of a device
        // that never comes back.
        "close_terminal" => {
            let id: String = arg(args, "id")?;
            require_owner(app, device_id, &id)?;
            ok(commands::terminal_cmd::close_terminal(
                app.state::<crate::terminal::TerminalRegistry>(),
                id,
            )?)
        }

        // ---------------------------------------------------------------
        // Stash — bringing work back, and nothing that throws it away
        // ---------------------------------------------------------------
        //
        // `stash_drop` stays out for the reason `discard_*` does. Popping is in: git drops the entry
        // only once its changes are back in the tree — a pop that conflicts leaves the stash where it
        // was — so nothing is lost that is not now on disk, where every other write here lands.
        //
        // `oid` is a precondition, like a gate's `stepId`. `stash@{2}` is a position, and the list a
        // phone is holding can be minutes old: a stash pushed at the desk since then moves every index
        // by one, and the tap that meant "that one" would apply its neighbour.
        "stash_apply" | "stash_pop" => {
            let repo_path: String = arg(args, "repoPath")?;
            let index: usize = arg(args, "index")?;
            let oid: String = arg(args, "oid")?;
            let listed = commands::git_ops::list_stashes(repo_path.clone())?;
            if listed.get(index).map(|stash| stash.oid.as_str()) != Some(oid.as_str()) {
                return Err(DispatchError::from(STASH_MOVED.to_string()));
            }
            if cmd == "stash_pop" {
                commands::git_ops::stash_pop(repo_path, index)?;
            } else {
                commands::git_ops::stash_apply(repo_path, index)?;
            }
            ok_with(true, Invalidate::Repo)
        }

        // ---------------------------------------------------------------
        // Pipelines — a repository's runs, and the two verbs on one
        // ---------------------------------------------------------------
        //
        // The Pipelines tab's own reads and two of its writes, against the host the project is
        // already linked to, with the token already on this machine: the phone names a project and a
        // run and nothing else. Starting a run from scratch, answering a deployment gate and
        // downloading artifacts stay at the desk — a new run with inputs is a decision about what to
        // ship, and an artifact is a file a phone has nowhere useful to put.
        //
        // `Invalidate::None` for the two writes: what changed is on the host, which the Pipelines tab
        // polls, and not in any row this machine holds. Announced all the same — see `announce_for`.
        "pipeline_availability" => ok(commands::ci_cmd::pipeline_availability(
            app.state::<Db>(),
            arg(args, "projectId")?,
        )
        .await?),
        "list_pipeline_runs" => ok(commands::ci_cmd::list_pipeline_runs(
            app.state::<Db>(),
            arg(args, "projectId")?,
            opt(args, "branch")?,
            // Clamped like `list_commits`: a screenful, well under the desktop's ceiling, because every
            // run past it is another request against a rate-limited host.
            opt::<usize>(args, "limit")?.unwrap_or(30).clamp(1, 50),
        )
        .await?),
        "pipeline_run_detail" => ok(commands::ci_cmd::pipeline_run_detail(
            app.state::<Db>(),
            arg(args, "projectId")?,
            arg(args, "runId")?,
        )
        .await?),
        "rerun_pipeline" => ok(commands::ci_cmd::rerun_pipeline(
            app.state::<Db>(),
            arg(args, "projectId")?,
            arg(args, "runId")?,
            opt(args, "failedOnly")?.unwrap_or(false),
        )
        .await?),
        "cancel_pipeline" => ok(commands::ci_cmd::cancel_pipeline(
            app.state::<Db>(),
            arg(args, "projectId")?,
            arg(args, "runId")?,
        )
        .await?),

        // ---------------------------------------------------------------
        // Services — what is running, and the panel's three verbs
        // ---------------------------------------------------------------
        //
        // Starting a service runs a command line, which is the terminal's risk in a smaller shape —
        // but only one the user wrote at the desk, in the service's definition. The phone names ids;
        // what they run, where and with which environment is fixed by definitions this table cannot
        // create or edit. The supervisor resolves `ids` against the named workspace's own services,
        // so an id from anywhere else starts nothing.
        //
        // `Invalidate::None`: the supervisor emits `services:runtime` for every change, which the
        // desktop already listens to and `bridge.rs` forwards to the phones.
        // Flujos. A phone sees the open waits of every workspace (it is the machine's owner deciding)
        // in a shape of its own (`waits::phone_view`), decides them as `phone`, and starts only the
        // flows an armed phone trigger offers — `fire_from_phone` refuses anything else.
        //
        // `Invalidate::None`: the runs announce themselves (`flows:run`, `flows:wait`), which the
        // desktop already listens to and `bridge.rs` forwards to the phones.
        "flows_list_waits" => ok(crate::flows::waits::open_waits(app, None)?.iter().map(crate::flows::waits::phone_view).collect::<Vec<_>>()),
        "flows_decide_wait" => {
            let comment: Option<String> = opt(args, "comment")?;
            let payload = comment.filter(|c| !c.trim().is_empty()).map_or(Value::Null, Value::String);
            let row = crate::flows::waits::decide(app, &arg::<String>(args, "id")?, &arg::<String>(args, "decision")?, "phone", payload)?;
            ok(crate::flows::waits::phone_view(&row))
        }
        "flows_phone_flows" => ok(crate::flows::triggers::phone_buttons()),
        "flows_run_from_phone" => {
            let text: Option<String> = opt(args, "text")?;
            ok(crate::flows::triggers::fire_from_phone(
                app,
                &arg::<String>(args, "flowId")?,
                &arg::<String>(args, "nodeId")?,
                text.as_deref().unwrap_or_default(),
            )?)
        }
        "list_services" => ok(commands::services_cmd::list_services(
            app.state::<Db>(),
            arg(args, "workspaceId")?,
        )?),
        "services_runtime" => ok(commands::services_cmd::services_runtime(app.clone())),
        "services_start" => {
            commands::services_cmd::services_start(app.clone(), arg(args, "workspaceId")?, arg(args, "ids")?)?;
            ok(true)
        }
        "services_stop" => {
            commands::services_cmd::services_stop(app.clone(), arg(args, "ids")?).await?;
            ok(true)
        }
        "services_restart" => {
            commands::services_cmd::services_restart(app.clone(), arg(args, "workspaceId")?, arg(args, "ids")?)
                .await?;
            ok(true)
        }

        // ---------------------------------------------------------------
        // The notification centre — read only
        // ---------------------------------------------------------------
        //
        // The list the desktop's main window last published (`RemoteCtl::publish_notices`).
        // Following an entry, marking it seen and clearing the list stay at the desk: they act on the
        // desk's own panel, which is not the phone's to rearrange.
        "list_notifications" => ok(app.state::<crate::remotectl::RemoteCtl>().notices()),

        _ => Err(DispatchError::NotAllowed),
    }
}

// ---------------------------------------------------------------------------
// Replays — the same request twice is one action
// ---------------------------------------------------------------------------

/// How long the answer to a keyed call is kept for a retry to find.
///
/// Long enough for the slowest thing a phone can ask for: a review or a chat turn runs an engine for
/// minutes, and a retry of one arriving after its answer was dropped would run it all again.
pub const REPLAY_WINDOW: Duration = Duration::from_secs(10 * 60);

/// How many answers are kept at most. Past it the oldest *settled* ones go first; a call still
/// running is never dropped, because its retry is exactly what this exists for.
const REPLAY_CAPACITY: usize = 256;

/// What one call answered: the status and the body, exactly as the first request got them.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

impl Answer {
    pub fn new(status: u16, body: Value) -> Self {
        Self { status, body }
    }
}

/// What [`Replays::claim`] decided about a keyed request.
pub enum Claim {
    /// The first time this key was seen: run the call and send its answer here. Held by whatever
    /// runs the call rather than by the request, so the call finishes — and is remembered — even
    /// when the phone that asked has gone.
    Fresh(watch::Sender<Option<Answer>>),
    /// Seen before: the first request's answer arrives here, now or when that call finishes.
    Replay(watch::Receiver<Option<Answer>>),
    /// The same key naming a different request — a client bug, refused rather than guessed at.
    Mismatch,
}

struct Replay {
    /// [`request_fingerprint`] of what the key was first used for.
    request: String,
    answer: watch::Receiver<Option<Answer>>,
    claimed: Instant,
}

/// The answers to recent keyed calls, by device and idempotency key.
///
/// # What it closes
///
/// A phone's network is the worst kind for a request/response protocol: a request reaches the
/// desktop, runs, and its *answer* is lost on the way back — the lift, the handover to cellular. The
/// client then does what clients do and asks again, and without this the desktop did it again: two
/// commits, two pushes, the same review comment twice under the user's name on somebody else's pull
/// request.
///
/// So a mutating call carries a key the client mints once per intent and reuses on every retry of it
/// (`transport.ts`). The first request with a key runs the call; every later one gets that call's
/// answer — waiting for it if it is still running. Per device, so two phones can never collide.
#[derive(Default)]
pub struct Replays {
    entries: Mutex<HashMap<(String, String), Replay>>,
}

impl Replays {
    pub fn claim(&self, device: &str, key: &str, request: &str, now: Instant) -> Claim {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        prune(&mut entries, now);
        let id = (device.to_string(), key.to_string());
        if let Some(entry) = entries.get(&id) {
            return if entry.request == request {
                Claim::Replay(entry.answer.clone())
            } else {
                Claim::Mismatch
            };
        }
        let (sender, answer) = watch::channel(None);
        entries.insert(id, Replay { request: request.to_string(), answer, claimed: now });
        Claim::Fresh(sender)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

/// Whether a call's answer is in — or can never come, because whatever ran it is gone.
fn settled(entry: &Replay) -> bool {
    entry.answer.borrow().is_some() || entry.answer.has_changed().is_err()
}

fn prune(entries: &mut HashMap<(String, String), Replay>, now: Instant) {
    entries.retain(|_, entry| !(settled(entry) && now.duration_since(entry.claimed) > REPLAY_WINDOW));
    if entries.len() < REPLAY_CAPACITY {
        return;
    }
    let mut oldest: Vec<((String, String), Instant)> = entries
        .iter()
        .filter(|(_, entry)| settled(entry))
        .map(|(id, entry)| (id.clone(), entry.claimed))
        .collect();
    oldest.sort_by_key(|(_, claimed)| *claimed);
    let excess = entries.len() + 1 - REPLAY_CAPACITY;
    for (id, _) in oldest.into_iter().take(excess) {
        entries.remove(&id);
    }
}

/// What a key was first used for: the command and its arguments, hashed. A retry sends the very
/// same body, so the same key with anything else in it is not a retry.
pub fn request_fingerprint(cmd: &str, args: &Value) -> String {
    hex::encode(Sha256::digest(format!("{cmd}\n{args}").as_bytes()))
}

/// The answer a claimed request is owed — its own call's, or the first request's.
pub async fn answer_of(mut answer: watch::Receiver<Option<Answer>>) -> Answer {
    match answer.wait_for(Option::is_some).await {
        Ok(settled) => (*settled).clone().unwrap_or_else(unfinished),
        Err(_) => unfinished(),
    }
}

/// What a request gets when the call it is waiting on died without answering. Not retried: whether
/// it did anything before it died is exactly what nobody knows.
fn unfinished() -> Answer {
    Answer::new(500, json!({ "ok": false, "error": "the call did not finish" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_are_accepted_in_either_spelling() {
        let camel = json!({ "repoPath": "/tmp/x" });
        let snake = json!({ "repo_path": "/tmp/x" });
        assert_eq!(arg::<String>(&camel, "repoPath").unwrap(), "/tmp/x");
        assert_eq!(arg::<String>(&snake, "repoPath").unwrap(), "/tmp/x");
    }

    #[test]
    fn a_missing_optional_and_an_explicit_null_agree() {
        let absent = json!({});
        let null = json!({ "limit": null });
        assert_eq!(opt::<i64>(&absent, "limit").unwrap(), None);
        assert_eq!(opt::<i64>(&null, "limit").unwrap(), None);
    }

    #[test]
    fn a_missing_required_argument_is_bad_args_not_a_panic() {
        let err = arg::<String>(&json!({}), "repoPath").unwrap_err();
        assert!(matches!(err, DispatchError::BadArgs(_)));
    }

    #[test]
    fn camel_case_maps_to_snake_case() {
        assert_eq!(to_snake("repoPath"), "repo_path");
        assert_eq!(to_snake("workspaceId"), "workspace_id");
        assert_eq!(to_snake("id"), "id");
        assert_eq!(to_snake("withResult"), "with_result");
    }

    /// `key` and `from_key` are two matches over one list, and the desktop's own emitter goes
    /// through the second one — a domain that serializes to a name the parser does not know would
    /// mean the window emitting an invalidation that this side refuses, silently, on a code path
    /// nobody is watching.
    #[test]
    fn every_domain_survives_the_round_trip_through_its_name() {
        for inv in [
            Invalidate::Repo,
            Invalidate::Chains,
            Invalidate::Tasks,
            Invalidate::Reviews,
            Invalidate::Chat,
            Invalidate::Workspaces,
            Invalidate::Notifications,
        ] {
            let key = inv.key().expect("a real domain always names itself");
            assert_eq!(Invalidate::from_key(key), Some(inv));
        }
        // And the one that must not: `None` has no name, so nothing can ask for it by one.
        assert_eq!(Invalidate::None.key(), None);
        assert_eq!(Invalidate::from_key("nonsense"), None);
    }

    /// The list of read-only domains is a claim this file makes to the rest of the app, so it is
    /// worth one assertion: a read must never tell the desktop to reload.
    #[test]
    fn only_mutating_domains_carry_a_payload() {
        assert!(Invalidate::None.as_payload().is_none());
        for inv in [Invalidate::Repo, Invalidate::Chains, Invalidate::Tasks] {
            assert!(inv.as_payload().is_some());
        }
    }

    // -----------------------------------------------------------------------
    // The allowlist
    // -----------------------------------------------------------------------

    /// Real commands (each one is registered in `lib.rs` — checked below, so a typo here cannot make
    /// this pass by naming nothing) that destroy work, read or write a credential, reach past this
    /// machine, or administer the install. None of them may ever be nameable from a phone.
    const NEVER_REACHABLE: &[&str] = &[
        // Work and history.
        "reset_to_commit",
        "discard_all_changes",
        "discard_file_changes",
        "discard_hunk",
        "discard_lines",
        "delete_branch",
        "git_delete_remote_branch",
        "git_delete_remote_tag",
        "git_push_force_with_lease",
        "stash_drop",
        "stash_save",
        "rename_stash",
        "amend_commit",
        "revert_commit",
        "cherry_pick_commit",
        "restore_reflog_entry",
        "restore_ai_checkpoint",
        "remove_worktree",
        "bisect_reset",
        // The disk.
        "delete_path",
        "move_path",
        "rename_path",
        "write_file_text",
        "write_file_bytes",
        "sandbox_wipe",
        "git_clone",
        // Configured work.
        "delete_project",
        "delete_workspace",
        "delete_service",
        "services_free_port",
        "set_setting",
        // Credentials and the keyring.
        "get_github_token",
        "get_gitlab_token",
        "get_ado_pat",
        "set_github_token",
        "remote_get_password",
        "db_set_password",
        "supabase_share_token",
        "keyvault_get_item",
        "keyvault_read_blob",
        "keyvault_load_tree",
        "keyvault_export",
        "keyvault_reset",
        "keyvault_purge_item",
        "keyvault_empty_trash",
        "notes_empty_trash",
        // Other people's machines.
        "db_execute",
        // The install.
        "reset_app_data",
        "quit_app",
        "quit_app_confirmed",
        "backup_run_now",
        "backup_export_to_file",
        "backup_restore_file",
        "backup_set_passphrase",
        // Administering this very feature, which is a thing you do at the machine.
        "remotectl_set_enabled",
        "remotectl_set_tls",
        "remotectl_set_allow_terminal",
        "remotectl_start_pairing",
        "remotectl_revoke_all",
        "remotectl_publish_notifications",
        "notify_state_change",
    ];

    /// The guarantee this file exists for, pinned: none of the above is reachable, whatever the table
    /// grows into. Adding one of them to [`ALLOWED`] fails here, loudly, before it ships.
    #[test]
    fn nothing_destructive_is_reachable() {
        let registered = include_str!("../lib.rs");
        for cmd in NEVER_REACHABLE {
            assert!(
                registered.contains(&format!("::{cmd},")),
                "`{cmd}` is not a registered command any more — update this list rather than let it pass by naming nothing"
            );
            assert!(!is_allowed(cmd), "`{cmd}` must never be reachable from a phone");
        }
    }

    /// The `match` arms of [`dispatch`], read out of this file.
    fn dispatch_arms(source: &str) -> Vec<String> {
        let start = source.find("pub async fn dispatch(").expect("the dispatch function");
        let end = start + source[start..].find("        _ => Err(DispatchError::NotAllowed)").expect("its fallback arm");
        source[start..end]
            .lines()
            .filter(|line| line.starts_with("        \"") && line.contains(" =>"))
            .flat_map(|line| {
                line.split(" =>").next().unwrap_or_default().split('|').map(|name| name.trim().trim_matches('"').to_string()).collect::<Vec<_>>()
            })
            .collect()
    }

    /// The text of one arm, from its pattern to the next arm's.
    fn arm_body<'a>(source: &'a str, name: &str) -> &'a str {
        let start = source.find("pub async fn dispatch(").unwrap();
        let region = &source[start..];
        let at = region.find(&format!("\n        \"{name}\" =>")).unwrap_or_else(|| panic!("no arm for `{name}`")) + 1;
        let rest = &region[at..];
        let next = rest[1..].find("\n        \"").or_else(|| rest[1..].find("\n        _ =>")).map(|i| i + 1).unwrap_or(rest.len());
        &rest[..next]
    }

    /// The list and the table agree. A name with no arm would fall through to a refusal, and an arm
    /// with no name would be dead code dressed up as a feature — both are safe, and both are mistakes
    /// worth hearing about.
    #[test]
    fn the_fence_and_the_table_name_the_same_commands() {
        let arms = dispatch_arms(include_str!("dispatch.rs"));
        assert!(arms.len() > 50, "the arm scanner found {} arms — has the layout changed?", arms.len());
        for arm in &arms {
            assert!(is_allowed(arm), "`{arm}` has an arm but is not in ALLOWED, so it can never run");
        }
        for name in ALLOWED {
            assert!(arms.iter().any(|arm| arm == name), "`{name}` is allowed but has no arm");
        }
        let mut unique = ALLOWED.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ALLOWED.len(), "a command is listed twice");
    }

    /// A shell is only ever one switch away, and that switch is off by default
    /// (`remotectl::tests::terminals_are_denied_until_explicitly_granted`). Every terminal arm but
    /// teardown asks for it — see the module docs, and `close_terminal` for why that one does not.
    #[test]
    fn every_shell_arm_but_teardown_asks_for_the_switch() {
        let source = include_str!("dispatch.rs");
        for name in ["list_shell_profiles", "list_terminals", "read_terminal", "open_terminal", "write_terminal", "resize_terminal"] {
            assert!(arm_body(source, name).contains("require_terminal(app)?"), "`{name}` must be behind the shell switch");
        }
        assert!(!arm_body(source, "close_terminal").contains("require_terminal(app)?"));
        // And pushing never forces: the one flag `git_push` reads is the upstream.
        assert!(!arm_body(source, "git_push").contains("\"force"));
    }

    // -----------------------------------------------------------------------
    // Replays
    // -----------------------------------------------------------------------

    fn answered(status: u16) -> Option<Answer> {
        Some(Answer::new(status, json!({ "ok": status == 200 })))
    }

    /// A retry — while the first request is still running, or after it answered — gets the first
    /// request's answer and runs nothing.
    #[tokio::test]
    async fn a_retry_gets_the_first_answer_instead_of_running_again() {
        let replays = Replays::default();
        let now = Instant::now();
        let Claim::Fresh(sender) = replays.claim("phone", "k1", "commit", now) else {
            panic!("the first request with a key runs");
        };
        let Claim::Replay(waiting) = replays.claim("phone", "k1", "commit", now) else {
            panic!("a retry while it runs must wait, not run a second time");
        };
        sender.send(answered(200)).unwrap();
        assert_eq!(answer_of(waiting).await.status, 200);

        let Claim::Replay(later) = replays.claim("phone", "k1", "commit", now + Duration::from_secs(60)) else {
            panic!("a retry after it answered gets the answer");
        };
        assert_eq!(answer_of(later).await, answered(200).unwrap());
    }

    /// Keys are per device and per intent: a second phone, or a new key, is a new request.
    #[test]
    fn another_device_or_another_key_is_a_new_request() {
        let replays = Replays::default();
        let now = Instant::now();
        assert!(matches!(replays.claim("phone", "k1", "commit", now), Claim::Fresh(_)));
        assert!(matches!(replays.claim("tablet", "k1", "commit", now), Claim::Fresh(_)));
        assert!(matches!(replays.claim("phone", "k2", "commit", now), Claim::Fresh(_)));
    }

    /// The same key on a different body is not a retry of anything.
    #[test]
    fn a_key_reused_for_another_request_is_refused() {
        let replays = Replays::default();
        let now = Instant::now();
        let _running = replays.claim("phone", "k1", &request_fingerprint("commit", &json!({ "message": "a" })), now);
        let other = request_fingerprint("commit", &json!({ "message": "b" }));
        assert!(matches!(replays.claim("phone", "k1", &other, now), Claim::Mismatch));
    }

    /// Settled answers expire; a call still running never does, however long it takes.
    #[test]
    fn answers_expire_but_a_running_call_is_never_forgotten() {
        let replays = Replays::default();
        let now = Instant::now();
        let Claim::Fresh(done) = replays.claim("phone", "done", "x", now) else { panic!() };
        done.send(answered(200)).unwrap();
        let Claim::Fresh(_running) = replays.claim("phone", "running", "x", now) else { panic!() };

        let later = now + REPLAY_WINDOW + Duration::from_secs(1);
        assert!(matches!(replays.claim("phone", "done", "x", later), Claim::Fresh(_)), "expired");
        assert!(matches!(replays.claim("phone", "running", "x", later), Claim::Replay(_)), "still running");
    }

    /// A call whose runner vanished — a panic — answers that it did not finish, rather than hanging
    /// the request or running the call a second time.
    #[tokio::test]
    async fn a_call_that_died_says_so() {
        let replays = Replays::default();
        let now = Instant::now();
        let Claim::Fresh(sender) = replays.claim("phone", "k", "x", now) else { panic!() };
        let Claim::Replay(waiting) = replays.claim("phone", "k", "x", now) else { panic!() };
        drop(sender);
        assert_eq!(answer_of(waiting).await.status, 500);
    }

    /// Bounded: a phone firing keyed calls all day cannot grow this without limit.
    #[test]
    fn the_cache_is_bounded() {
        let replays = Replays::default();
        let now = Instant::now();
        for index in 0..(REPLAY_CAPACITY * 2) {
            if let Claim::Fresh(sender) = replays.claim("phone", &format!("k{index}"), "x", now) {
                sender.send(answered(200)).unwrap();
            }
        }
        assert!(replays.len() <= REPLAY_CAPACITY);
    }
}
