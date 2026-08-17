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
//! lookup into the app's real command registry. That is a deliberate refusal of convenience: 550
//! commands are registered in `lib.rs`, and a design where the network could name any of them
//! would be one `generate_handler!` edit away from exposing the next one somebody adds.
//!
//! ## What is deliberately absent, and why
//!
//! * `terminal_*` — a PTY is an arbitrary shell. There is no subset of "run a command" that is
//!   safe to hand to a bearer token on a home network.
//! * `fs_*` writes, `delete_*` of anything on disk — a phone screen is the worst possible place to
//!   confirm a destructive path, and the app has no undo for most of them.
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

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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
    // No `Workspaces` variant, and that is not an oversight: every workspace and project command
    // in the table above is read-only, because creating or moving one names a path on a disk the
    // phone cannot see. Add it the day a mutating arm needs it.
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
/// Answers [`DispatchError::NotAllowed`] — the same refusal an unknown command gets, which the
/// server turns into the same 401 a bad token gets. That is deliberate: to a client, "terminals are
/// switched off here" and "no such command" are indistinguishable, so probing for the switch tells
/// an attacker nothing about whether it exists to be flipped.
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
        // desktop has something new to read either way.
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

        _ => Err(DispatchError::NotAllowed),
    }
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
}
