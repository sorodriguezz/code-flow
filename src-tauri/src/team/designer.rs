//! A team made from a chat: two tools of the map server (`codemap::mcp`) — `team_brief` (what this
//! workspace has to build a team from, and how a team works) and `team_create` (a team's whole
//! definition, checked and saved with the agents it needs).
//!
//! The door to the whole app (`app_gateway`) already reaches `team_save`, but it takes the record
//! the editor saves — member ids, agent ids, project ids, forty policy fields — and a model that
//! has to guess that shape writes a team that saves and does not run. Here the model says what it
//! means in names (this agent, that repository, this seat answers to that one) and everything a
//! run would refuse later is refused now, all at once, with what to send instead:
//!
//! - **Nothing is invented.** A provider must be one that is ready on this computer, a model one
//!   its CLI lists (or one the roster already runs on), a repository one of the workspace's.
//! - **Nothing thin.** A new agent's standing prompt and a seat's role have a floor: the lead
//!   routes work by reading the roles, and an agent with a one-line prompt is a generic one.
//! - **Nothing half-made.** The new agents and the team are saved in one transaction, or neither.
//! - **Nothing runs.** A team does nothing until the user launches it.
//!
//! A turn that may not act — plan mode, a CLI whose token sits in a file — gets the same checks
//! and creates nothing: the team waits in the window as a [`Proposal`] for the user's own yes.
//!
//! Past what can be refused, [`quality`] says how well the design fits the workspace — whether a
//! prompt names real paths and the real test command, whether two seats do one job — and what
//! would raise it. `tests::eval_*` measure a real model with the same number.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::Emitter;
use uuid::Uuid;

use super::{hierarchy, Check, Member, PlanStep, Policy, Team};
use crate::db::models::{AgentDraft, Project, WorkspaceAgent};
use crate::db::queries;

pub const BRIEF_TOOL: &str = "team_brief";
pub const CREATE_TOOL: &str = "team_create";

pub fn is_tool(name: &str) -> bool {
    name == BRIEF_TOOL || name == CREATE_TOOL
}

/// The least a new agent's standing prompt may be, in characters.
pub const MIN_PROMPT: usize = 300;
const MAX_PROMPT: usize = 12_000;
/// The least a seat's role may be: a sentence the lead can route work by.
pub const MIN_ROLE: usize = 20;
const MAX_ROLE: usize = 240;
const MIN_DESCRIPTION: usize = 30;
const MAX_NAME: usize = 60;
/// The colours an agent can wear (`src/lib/agents/agentColors.ts`).
const COLORS: [&str; 12] = ["indigo", "blue", "cyan", "teal", "green", "lime", "amber", "orange", "rose", "magenta", "purple", "slate"];
/// Some of the icons an agent can be drawn with (`src/lib/agents/agentIcons.ts`); one the window
/// does not know is drawn as one derived from the agent, so this is a suggestion, not a gate.
const ICONS: &str = "crown, landmark, server, database, code, code-xml, terminal, monitor-smartphone, palette, shield, shield-check, bug, test-tube, file-text, glasses, eye, rocket, cloud, container, git-merge, workflow, search-code";
/// What Claude Code resolves by itself to the newest of each tier: always valid, never stale.
const CLAUDE_ALIASES: [&str; 3] = ["opus", "sonnet", "haiku"];

/// The definitions. Short on purpose — they ride along on every turn — so the spec itself is in
/// `team_brief`'s answer, paid for only by a turn that designs a team.
pub fn schemas(acts: bool) -> Vec<Value> {
    let create = if acts {
        "Creates a team of agents in this workspace from a definition — seats, who leads, checks, review, policy — making the roster agents it needs. Everything is checked first and every problem comes back at once; nothing runs until the user launches the team. Call team_brief first: it has the spec and what this workspace offers. dry_run checks without creating."
    } else {
        "Checks a team's definition for this workspace and leaves it in the window as a proposal the user creates with one click — this turn may not change the app itself. Call team_brief first: it has the spec and what this workspace offers. dry_run only checks."
    };
    vec![
        json!({
            "name": BRIEF_TOOL,
            "description": "Everything needed to design a team of agents for this workspace: its repositories with their stack and test suites, the agents and teams it already has, the providers and models ready on this computer, how a team works, and team_create's spec. Read it before proposing or creating a team.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }),
        json!({
            "name": CREATE_TOOL,
            "description": create,
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string"},
                "description": {"type": "string", "description": "What the team is for and when to use it"},
                "members": {"type": "array", "items": {"type": "object"}, "description": "The seats, as team_brief specifies"},
                "lead": {"type": "string", "description": "The key of the seat that leads"},
                "plan": {"type": "array", "items": {"type": "object"}, "description": "Fixed steps, for a team with no lead"},
                "checks": {"type": "array", "items": {"type": "object"}},
                "review": {"type": "object"},
                "policy": {"type": "object"},
                "update": {"type": "string", "description": "An existing team's name, to replace its definition"},
                "dry_run": {"type": "boolean"}
            }, "required": ["members"]},
            "annotations": {"readOnlyHint": !acts, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}
        }),
    ]
}

// ---------------------------------------------------------------- what this computer offers

#[derive(Debug, Clone, Default)]
pub struct Provider {
    pub id: String,
    pub label: String,
    /// Its CLI is installed (or, for the model that runs in the app, loaded).
    pub ready: bool,
    /// What its CLI says it offers. Empty for one that cannot list (Claude Code).
    pub models: Vec<String>,
    pub read_only: bool,
    pub metered: bool,
    pub loop_guard: bool,
    /// Its CLI has not answered yet what it offers: nothing to check a model against for now.
    pub pending: bool,
}

/// What a team here can be made of that is not in the database: the engines and the container
/// engine. Gathered once and passed in, so the checks themselves need no process and no network.
#[derive(Debug, Clone, Default)]
pub struct Known {
    pub providers: Vec<Provider>,
    /// The container engine checks can run isolated in, when one answers.
    pub sandbox: Option<String>,
    pub sandbox_problem: String,
}

impl Known {
    fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }

    /// The models a new agent on `provider` may name: what the CLI lists, what the roster already
    /// runs on, and Claude's tier aliases. The bool: the list is the CLI's own, so a model that
    /// is not in it does not exist.
    fn models(&self, provider: &str, roster: &[WorkspaceAgent]) -> (Vec<String>, bool) {
        let listed = self.provider(provider).map(|p| p.models.clone()).unwrap_or_default();
        let strict = !listed.is_empty();
        let mut all = listed;
        for model in roster.iter().filter(|a| a.provider == provider).map(|a| a.model.trim()).filter(|m| !m.is_empty()) {
            if !all.iter().any(|known| known == model) {
                all.push(model.to_string());
            }
        }
        if provider == "claude" {
            for alias in CLAUDE_ALIASES {
                if !all.iter().any(|known| known == alias) {
                    all.push(alias.to_string());
                }
            }
        }
        (all, strict)
    }
}

/// What each CLI said it offers, and when. Kept in memory and in a setting, so the first call
/// after the app opens answers from the last listing instead of waiting on a process per CLI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Listing {
    /// Seconds since the epoch.
    at: u64,
    models: HashMap<String, Vec<String>>,
}

const LISTING_SETTING: &str = "team_designer_models";
/// How old a listing may be before it is asked for again — behind the call, never in front of it.
const LISTING_FRESH_SECS: u64 = 600;
/// The most a call waits for a CLI that has never been listed: past it the call goes on and that
/// provider's models are simply not checked this once.
const FIRST_WAIT: Duration = Duration::from_secs(3);
static LISTING: Mutex<Option<Listing>> = Mutex::new(None);
static REFRESHING: AtomicBool = AtomicBool::new(false);
static REFRESHED: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

fn stored_listing() -> Option<Listing> {
    let mut held = LISTING.lock().unwrap_or_else(|e| e.into_inner());
    if held.is_none() {
        *held = crate::ai_usage::setting(LISTING_SETTING).and_then(|raw| serde_json::from_str(&raw).ok());
    }
    held.clone()
}

/// Whether the CLIs in `ready` have to be asked what they offer (`.0`), and whether the caller has
/// nothing at all to go by for one of them and should wait a moment for the answer (`.1`). A
/// listing that is merely old is used as it is and refreshed behind the call.
fn listing_needs(listing: Option<&Listing>, ready: &[String], now: u64) -> (bool, bool) {
    let missing = ready.iter().any(|id| listing.is_none_or(|l| !l.models.contains_key(id)));
    let stale = listing.is_none_or(|l| now.saturating_sub(l.at) > LISTING_FRESH_SECS);
    (missing || stale, missing)
}

/// A provider's engine and the binary it runs, as the settings have them.
fn cli_of(id: &str) -> Option<(Box<dyn crate::ai::AiEngine>, String)> {
    let (engine, binary) = crate::ai_usage::with_conn(|conn| {
        let account = crate::ai_accounts::resolve(conn, id, None, None, crate::ai_accounts::Choice::System);
        let engine = crate::ai::engine_as(id, account);
        let binary = queries::get_setting(conn, &format!("{id}_binary_path")).ok().flatten().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| engine.default_binary().to_string());
        (engine, binary)
    })?;
    (!binary.trim().is_empty()).then_some((engine, binary))
}

/// Asks every CLI in `ids` what it offers, at once, and keeps the answers. One that fails or
/// takes too long keeps what it said last time.
async fn refresh_listing(ids: Vec<String>) {
    let lookups = ids.into_iter().map(|id| async move {
        let listed = match cli_of(&id) {
            Some((engine, binary)) => tokio::time::timeout(Duration::from_secs(8), crate::ai::list_models(&*engine, &binary)).await.ok().and_then(Result::ok),
            None => None,
        };
        (id, listed)
    });
    let answers = futures_util::future::join_all(lookups).await;
    let mut listing = stored_listing().unwrap_or_default();
    for (id, listed) in answers {
        match listed {
            Some(models) => {
                listing.models.insert(id, models);
            }
            None => {
                listing.models.entry(id).or_default();
            }
        }
    }
    listing.at = now_secs();
    if let Ok(raw) = serde_json::to_string(&listing) {
        let _ = crate::ai_usage::with_conn(|conn| queries::set_setting(conn, LISTING_SETTING, &raw));
    }
    *LISTING.lock().unwrap_or_else(|e| e.into_inner()) = Some(listing);
    REFRESHING.store(false, Ordering::SeqCst);
    REFRESHED.notify_waiters();
}

/// [`Known`], without making the caller wait on the CLIs: whether each is installed is looked up
/// now (a path lookup), what each offers comes from the last listing — this session's or the one
/// saved by the last — and a listing that is old is asked for again behind the call. Only a CLI
/// that was never listed is waited for, and for [`FIRST_WAIT`] at most.
pub async fn known() -> Known {
    let local = crate::local_agent::PROVIDER_ID;
    let caps = crate::provider_caps::all();
    let mut ready: HashMap<String, bool> = HashMap::new();
    for provider in &caps {
        let is = if provider.id == local {
            tokio::time::timeout(Duration::from_millis(1500), crate::local_agent::status()).await.map(|status| status.0).unwrap_or(false)
        } else {
            cli_of(&provider.id).is_some_and(|(_, binary)| crate::ai::probe(&binary).0)
        };
        ready.insert(provider.id.clone(), is);
    }
    let listable: Vec<String> = caps.iter().filter(|c| c.id != local && ready.get(&c.id).copied().unwrap_or(false)).map(|c| c.id.clone()).collect();
    let (refresh, wait) = listing_needs(stored_listing().as_ref(), &listable, now_secs());
    if refresh {
        // Listening before the refresh can finish, so its end is never missed.
        let done = REFRESHED.notified();
        tokio::pin!(done);
        done.as_mut().enable();
        if !REFRESHING.swap(true, Ordering::SeqCst) {
            tauri::async_runtime::spawn(refresh_listing(listable.clone()));
        }
        if wait {
            let _ = tokio::time::timeout(FIRST_WAIT, done).await;
        }
    }
    let listing = stored_listing().unwrap_or_default();
    let providers = caps
        .into_iter()
        .map(|c| {
            let is_ready = ready.get(&c.id).copied().unwrap_or(false);
            Provider {
                models: listing.models.get(&c.id).cloned().unwrap_or_default(),
                pending: is_ready && c.id != local && !listing.models.contains_key(&c.id),
                ready: is_ready,
                read_only: c.guarantees.read_only,
                metered: c.guarantees.metered,
                loop_guard: c.guarantees.loop_guard,
                id: c.id,
                label: c.label,
            }
        })
        .collect();
    let sandbox = super::sandbox::status(false).await;
    Known { providers, sandbox: sandbox.available.then(|| sandbox.engine.clone()), sandbox_problem: sandbox.problem }
}

// ---------------------------------------------------------------- the spec

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Spec {
    pub name: String,
    pub description: String,
    pub update: String,
    pub lead: String,
    pub members: Vec<Seat>,
    pub plan: Vec<Step>,
    pub checks: Option<Vec<CheckSpec>>,
    pub review: Option<ReviewSpec>,
    pub policy: Map<String, Value>,
    pub dry_run: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Seat {
    pub key: String,
    pub name: String,
    pub role: String,
    pub agent: String,
    pub new_agent: Option<NewAgent>,
    pub edits: Option<bool>,
    pub repos: Vec<String>,
    pub reports_to: String,
    pub leads: bool,
    pub hands_on: bool,
    pub advisor: bool,
    pub escalate_to: String,
    pub talks_to: Vec<String>,
    pub max_parallel: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NewAgent {
    pub name: String,
    pub role: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub prompt: String,
    pub icon: String,
    pub color: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Step {
    pub key: String,
    pub member: String,
    pub kind: String,
    pub title: String,
    pub instruction: String,
    pub repo: String,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CheckSpec {
    pub repo: String,
    pub command: String,
    pub when: String,
    pub kind: String,
    pub label: String,
    pub write: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ReviewSpec {
    pub reviewer: String,
    pub of: Vec<String>,
    pub exigence: String,
    pub laps: Option<i64>,
}

/// The policy's choices, for a value that is none of them to be refused instead of quietly
/// becoming the default (`Policy::sane`).
const CHOICES: &[(&str, &[&str])] = &[
    ("approve_code", &["never", "first", "each"]),
    ("questions", &["allow", "plan", "never"]),
    ("commit", &["item", "squash", "none"]),
    ("commit_style", &["conventional", "free"]),
    ("integrate", &["merge", "branch", "pr"]),
    ("comms", &["open", "tree", "tree_siblings"]),
    ("baseline_failures", &["ignore", "fix"]),
    ("dod", &["off", "warn", "block"]),
    ("sandbox", &["off", "checks"]),
    ("guarantees", &["off", "warn", "block"]),
];

// ---------------------------------------------------------------- the design

/// A spec that passed: the team as it will be saved, and the agents to make first.
#[derive(Debug, Clone)]
pub struct Design {
    pub team: Team,
    /// The roster agents to create. A member that runs as the n-th names it `new:<n>` until
    /// [`commit`] has its id.
    pub agents: Vec<AgentDraft>,
    pub updating: bool,
    /// What the user should hear about: it will run, but not as one might assume.
    pub warnings: Vec<String>,
    /// What was filled in or adjusted.
    pub notes: Vec<String>,
    /// The warnings again, as the window says them in the user's language: what, about whom.
    pub flags: Vec<Flag>,
    /// One line per seat, for the answer.
    seats: Vec<String>,
    /// What each member runs as, in the members' order.
    pub routes: Vec<Route>,
}

/// One of [`Design::warnings`] in a form the window can word itself.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Flag {
    /// `model_unchecked`, `agent_off`, `sublead_alone`, `no_engine`, `nobody_writes`,
    /// `read_only_unenforced`, `unmetered`, `guarantees_block`, `merge_unasked`.
    pub kind: &'static str,
    /// The seat or the agent it is about; empty when it is about the team.
    pub who: String,
    /// The provider, the model, the engine's problem.
    pub what: String,
}

fn flag(kind: &'static str, who: &str, what: &str) -> Flag {
    Flag { kind, who: who.to_string(), what: what.to_string() }
}

/// The agent behind a member, as the design found it.
#[derive(Debug, Clone)]
pub struct Route {
    pub member_id: String,
    pub agent: String,
    pub provider: String,
    pub model: String,
    /// The agent is one this design makes.
    pub fresh: bool,
    pub icon: String,
    pub color: String,
}

fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn chars(text: &str) -> usize {
    text.trim().chars().count()
}

fn quoted(names: impl IntoIterator<Item = impl AsRef<str>>, most: usize) -> String {
    let all: Vec<String> = names.into_iter().map(|n| format!("«{}»", n.as_ref())).collect();
    if all.is_empty() {
        return "none".into();
    }
    let shown = all.len().min(most);
    let mut text = all[..shown].join(", ");
    if all.len() > shown {
        text.push_str(&format!(" and {} more", all.len() - shown));
    }
    text
}

/// Checks `spec` against the workspace and builds what [`commit`] saves. Every problem is
/// collected: a model told about one field at a time pays a turn per field.
pub fn design(conn: &Connection, workspace_id: &str, spec: &Spec, known: &Known) -> Result<Design, Vec<String>> {
    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut flags: Vec<Flag> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let read = |problem: rusqlite::Error| vec![format!("the workspace could not be read: {problem}")];
    let roster = queries::list_workspace_agents(conn, workspace_id).map_err(read)?;
    let projects = queries::list_projects(conn, workspace_id).map_err(read)?;
    let teams = super::list_teams(conn, workspace_id).map_err(read)?;

    // ---- the team itself
    let existing = if spec.update.trim().is_empty() {
        None
    } else {
        let found = teams.iter().find(|t| t.id == spec.update.trim() || same(&t.name, &spec.update));
        if found.is_none() {
            problems.push(format!("update: there is no team «{}» here. Teams: {}.", spec.update.trim(), quoted(teams.iter().map(|t| &t.name), 12)));
        }
        found
    };
    let name = if spec.name.trim().is_empty() { existing.map(|t| t.name.clone()).unwrap_or_default() } else { spec.name.trim().to_string() };
    if name.is_empty() {
        problems.push("name: the team needs a name.".into());
    } else if name.chars().count() > MAX_NAME {
        problems.push(format!("name: at most {MAX_NAME} characters."));
    } else if teams.iter().any(|t| same(&t.name, &name) && existing.is_none_or(|e| e.id != t.id)) {
        problems.push(format!("name: there is already a team «{name}». Pick another name, or send \"update\": \"{name}\" to replace its definition."));
    }
    let description = if spec.description.trim().is_empty() { existing.map(|t| t.description.clone()).unwrap_or_default() } else { spec.description.trim().to_string() };
    if chars(&description) < MIN_DESCRIPTION {
        problems.push(format!("description: say what the team is for and when to use it — at least {MIN_DESCRIPTION} characters."));
    }

    // ---- the seats
    if spec.members.is_empty() {
        problems.push("members: a team needs at least one seat.".into());
    }
    if spec.members.len() > super::MAX_MEMBERS {
        problems.push(format!("members: at most {} seats.", super::MAX_MEMBERS));
    }
    let keys: Vec<String> = spec.members.iter().map(|s| if s.key.trim().is_empty() { s.name.trim().to_lowercase() } else { s.key.trim().to_lowercase() }).collect();
    let ids: Vec<String> = spec.members.iter().map(|_| Uuid::new_v4().to_string()).collect();
    for (at, key) in keys.iter().enumerate() {
        if key.is_empty() {
            problems.push(format!("members[{at}]: give the seat a key (its handle in lead, reports_to, review) or a name."));
        } else if keys[..at].contains(key) {
            problems.push(format!("members[{at}]: the key «{key}» is used by another seat."));
        }
    }
    let seat_of = |key: &str| -> Option<usize> { keys.iter().position(|k| !k.is_empty() && k == &key.trim().to_lowercase()) };
    let repo_id = |name: &str| -> Result<String, String> {
        projects
            .iter()
            .find(|p| p.id == name.trim() || same(&p.name, name))
            .map(|p| p.id.clone())
            .ok_or_else(|| format!("«{}» is not a repository of this workspace. Repositories: {}.", name.trim(), quoted(projects.iter().map(|p| &p.name), 12)))
    };

    // New agents first: a seat may be filled by one another seat declares.
    let mut drafts: Vec<AgentDraft> = Vec::new();
    let mut draft_of_seat: HashMap<usize, usize> = HashMap::new();
    for (at, seat) in spec.members.iter().enumerate() {
        let Some(new) = &seat.new_agent else { continue };
        let at_field = |field: &str| format!("members[{at}].new_agent.{field}");
        let mut ok = true;
        let agent_name = new.name.trim();
        if agent_name.is_empty() {
            problems.push(format!("{}: the agent needs a name.", at_field("name")));
            ok = false;
        } else if agent_name.chars().count() > MAX_NAME {
            problems.push(format!("{}: at most {MAX_NAME} characters.", at_field("name")));
            ok = false;
        } else if roster.iter().any(|a| same(&a.name, agent_name)) {
            problems.push(format!("{}: the roster already has an agent «{agent_name}». Seat it with \"agent\": \"{agent_name}\", or give the new one another name.", at_field("name")));
            ok = false;
        } else if drafts.iter().any(|d| same(&d.name, agent_name)) {
            problems.push(format!("{}: another seat already makes «{agent_name}». To seat the same new agent twice, the second seat says \"agent\": \"{agent_name}\".", at_field("name")));
            ok = false;
        }
        let provider = new.provider.trim();
        match known.provider(provider) {
            None => {
                problems.push(format!("{}: «{provider}» is not a provider. Ready here: {}.", at_field("provider"), ready_list(known)));
                ok = false;
            }
            Some(found) if !found.ready => {
                problems.push(format!("{}: {} is not installed or not signed in on this computer. Ready here: {}.", at_field("provider"), found.label, ready_list(known)));
                ok = false;
            }
            Some(_) => {
                let model = new.model.trim();
                let (models, strict) = known.models(provider, &roster);
                if model.is_empty() {
                    problems.push(format!("{}: name the model. For {provider}: {}.", at_field("model"), if models.is_empty() { "the id as its CLI takes it".to_string() } else { models.iter().take(24).cloned().collect::<Vec<_>>().join(", ") }));
                    ok = false;
                } else if !models.iter().any(|m| m == model) {
                    if strict {
                        problems.push(format!("{}: {provider} does not list «{model}». It lists: {}.", at_field("model"), models.iter().take(24).cloned().collect::<Vec<_>>().join(", ")));
                        ok = false;
                    } else {
                        flags.push(flag("model_unchecked", agent_name, &format!("{provider}/{model}")));
                        warnings.push(format!("«{agent_name}» runs on {provider}/{model}, which could not be checked here: {provider}'s CLI lists no models. If it does not exist, its turns fail — the user can change it in Agentes."));
                    }
                }
            }
        }
        let effort = new.effort.trim();
        if !effort.is_empty() && !crate::ai::effort::valid(effort) {
            problems.push(format!("{}: «{effort}» is not a level. One of low, medium, high, max — or leave it out for the CLI's own.", at_field("effort")));
            ok = false;
        }
        let prompt = new.prompt.trim();
        if chars(prompt) < MIN_PROMPT {
            problems.push(format!(
                "{}: {} characters is too thin for an agent's standing instructions (at least {MIN_PROMPT}). Say who it is, the stack and the paths it owns in this workspace, the conventions it follows, how it verifies its work (the real commands), what it must not touch, and what done means.",
                at_field("prompt"),
                chars(prompt)
            ));
            ok = false;
        } else if chars(prompt) > MAX_PROMPT {
            problems.push(format!("{}: at most {MAX_PROMPT} characters.", at_field("prompt")));
            ok = false;
        }
        let color = new.color.trim();
        if !color.is_empty() && !COLORS.contains(&color) {
            problems.push(format!("{}: one of {} — or leave it out.", at_field("color"), COLORS.join(", ")));
            ok = false;
        }
        if !ok {
            continue;
        }
        draft_of_seat.insert(at, drafts.len());
        drafts.push(AgentDraft {
            id: None,
            workspace_id: workspace_id.to_string(),
            name: agent_name.to_string(),
            role: if new.role.trim().is_empty() { seat.name.trim().to_string() } else { new.role.trim().chars().take(80).collect() },
            provider: provider.to_string(),
            model: new.model.trim().to_string(),
            prompt: prompt.to_string(),
            enabled: true,
            account_id: None,
            effort: effort.to_string(),
            icon: new.icon.trim().chars().take(40).collect(),
            color: color.to_string(),
            edits: !seat.advisor && seat.edits.unwrap_or(true),
            repos: Vec::new(),
            run_in: "headless".into(),
            max_parallel: 1,
            ..Default::default()
        });
    }

    /// Who fills a seat.
    enum Filled<'a> {
        Roster(&'a WorkspaceAgent),
        New(usize),
    }
    let mut members: Vec<Member> = Vec::new();
    let mut seats: Vec<String> = Vec::new();
    // Provider and whether it writes, per member — what the guarantees are read from.
    let mut engines: Vec<(String, bool, String)> = Vec::new();
    let mut routes: Vec<Route> = Vec::new();
    for (at, seat) in spec.members.iter().enumerate() {
        let here = |field: &str| format!("members[{at}].{field}");
        let filled = match (&seat.new_agent, seat.agent.trim()) {
            (Some(_), agent) if !agent.is_empty() => {
                problems.push(format!("members[{at}]: give \"agent\" (one that exists) or \"new_agent\" (one to make), not both."));
                None
            }
            (Some(_), _) => draft_of_seat.get(&at).map(|n| Filled::New(*n)),
            (None, "") => {
                problems.push(format!("members[{at}]: say who fills the seat — \"agent\": a roster agent's name, or \"new_agent\": one to make."));
                None
            }
            (None, agent) => {
                let matches: Vec<&WorkspaceAgent> = roster.iter().filter(|a| a.id == agent || same(&a.name, agent)).collect();
                match matches.as_slice() {
                    [one] => Some(Filled::Roster(*one)),
                    [] => match drafts.iter().position(|d| same(&d.name, agent)) {
                        Some(n) => Some(Filled::New(n)),
                        None => {
                            problems.push(format!("{}: there is no agent «{agent}» in the roster. Agents: {}. To make one, use \"new_agent\".", here("agent"), quoted(roster.iter().map(|a| &a.name), 16)));
                            None
                        }
                    },
                    several => {
                        problems.push(format!("{}: {} agents are called «{agent}»: name it by id ({}).", here("agent"), several.len(), several.iter().map(|a| a.id.as_str()).collect::<Vec<_>>().join(", ")));
                        None
                    }
                }
            }
        };
        let role = seat.role.trim();
        if chars(role) < MIN_ROLE {
            problems.push(format!("{}: one sentence the lead can route work by — what this seat owns here and what it is asked for (at least {MIN_ROLE} characters).", here("role")));
        } else if chars(role) > MAX_ROLE {
            problems.push(format!("{}: at most {MAX_ROLE} characters — the rest belongs in the agent's prompt.", here("role")));
        }
        let mut repos = Vec::new();
        for repo in &seat.repos {
            match repo_id(repo) {
                Ok(id) => repos.push(id),
                Err(why) => problems.push(format!("{}: {why}", here("repos"))),
            }
        }
        if seat.advisor && seat.leads {
            problems.push(format!("members[{at}]: an advisor never leads."));
        }
        let Some(filled) = filled else { continue };
        let (agent_id, agent_name, provider, model, agent_edits, agent_repos, run_in, parallel, ladder, fresh) = match filled {
            Filled::Roster(agent) => {
                if agent.provider.trim().is_empty() || agent.model.trim().is_empty() {
                    problems.push(format!("{}: «{}» has no provider and model yet, so a run would not start. The user completes it in Agentes, or seat another agent.", here("agent"), agent.name));
                }
                if !agent.enabled {
                    flags.push(flag("agent_off", &agent.name, ""));
                    warnings.push(format!("«{}» is switched off in the roster.", agent.name));
                }
                (agent.id.clone(), agent.name.clone(), agent.provider.clone(), agent.model.clone(), agent.edits, agent.repos.clone(), agent.run_in.clone(), agent.max_parallel, agent.model_ladder.clone(), false)
            }
            Filled::New(n) => {
                let draft = &drafts[n];
                (format!("new:{n}"), draft.name.clone(), draft.provider.clone(), draft.model.clone(), draft.edits, Vec::new(), "headless".to_string(), 1, Vec::new(), true)
            }
        };
        let edits = !seat.advisor && seat.edits.unwrap_or(agent_edits);
        let max_parallel = seat.max_parallel.unwrap_or(parallel);
        if !(1..=super::MAX_PARALLEL_CAP).contains(&max_parallel) {
            notes.push(format!("{}: {max_parallel} → {}.", here("max_parallel"), max_parallel.clamp(1, super::MAX_PARALLEL_CAP)));
        }
        let name = if seat.name.trim().is_empty() { agent_name.clone() } else { seat.name.trim().to_string() };
        let mut marks: Vec<&str> = Vec::new();
        if seat.advisor {
            marks.push("advisor");
        }
        if seat.leads {
            marks.push("sub-lead");
        }
        marks.push(if edits { "may write" } else { "read-only" });
        let scope = if repos.is_empty() && agent_repos.is_empty() {
            "every repository".to_string()
        } else {
            let scoped = if repos.is_empty() { &agent_repos } else { &repos };
            scoped.iter().filter_map(|id| projects.iter().find(|p| &p.id == id)).map(|p| p.name.clone()).collect::<Vec<_>>().join(", ")
        };
        seats.push(format!("«{name}» — {} «{agent_name}» · {provider}/{model} · {} · {scope}\n    {role}", if fresh { "new agent" } else { "agent" }, marks.join(", ")));
        let (icon, color) = match agent_id.strip_prefix("new:").and_then(|n| n.parse::<usize>().ok()).and_then(|n| drafts.get(n)) {
            Some(draft) => (draft.icon.clone(), draft.color.clone()),
            None => roster.iter().find(|a| a.id == agent_id).map(|a| (a.icon.clone(), a.color.clone())).unwrap_or_default(),
        };
        routes.push(Route { member_id: ids[at].clone(), agent: agent_name.clone(), provider: provider.clone(), model: model.clone(), fresh, icon, color });
        engines.push((provider, edits, name.clone()));
        members.push(Member {
            id: ids[at].clone(),
            agent_id,
            name,
            role: role.to_string(),
            edits,
            max_parallel: max_parallel.clamp(1, super::MAX_PARALLEL_CAP),
            run_in: if run_in == "terminal" { "terminal".into() } else { "headless".into() },
            repos: if repos.is_empty() { agent_repos } else { repos },
            leads: seat.leads,
            hands_on: seat.hands_on,
            advisor: seat.advisor,
            model_ladder: ladder,
            ..Default::default()
        });
    }
    let advisors = spec.members.iter().filter(|s| s.advisor).count();
    if advisors > 1 {
        problems.push(format!("members: {advisors} advisors — a team hears one."));
    }

    // ---- who leads, who answers to whom
    let lead_at = if spec.lead.trim().is_empty() { None } else { seat_of(&spec.lead) };
    if !spec.lead.trim().is_empty() && lead_at.is_none() {
        problems.push(format!("lead: «{}» is not the key of a seat. Keys: {}.", spec.lead.trim(), keys.join(", ")));
    }
    if spec.lead.trim().is_empty() && spec.plan.is_empty() {
        problems.push("lead: say which seat leads (its key) — it plans the goal and hands out the work. A team of one leads itself: \"lead\" its key and \"hands_on\": true. Only a routine that never changes has no lead and a \"plan\" instead.".into());
    }
    if !spec.lead.trim().is_empty() && !spec.plan.is_empty() {
        problems.push("plan: a team with a lead plans each goal itself and never reads a fixed plan. Send one or the other.".into());
    }
    if let Some(lead) = lead_at {
        let seat = &spec.members[lead];
        if seat.advisor {
            problems.push("lead: the advisor cannot lead — it is never given work.".into());
        }
        let hands = spec.members.iter().enumerate().filter(|(at, s)| *at != lead && !s.advisor).count();
        if hands == 0 && !seat.hands_on {
            problems.push("lead: this lead has nobody to hand work to. Add seats, or set \"hands_on\": true on it so it does the work itself.".into());
        }
    }
    let lead_id = lead_at.map(|at| ids[at].clone()).unwrap_or_default();
    for (at, seat) in spec.members.iter().enumerate() {
        let mut link = |field: &str, key: &str| -> Option<String> {
            if key.trim().is_empty() {
                return None;
            }
            match seat_of(key) {
                Some(other) if other == at => {
                    problems.push(format!("members[{at}].{field}: a seat cannot name itself."));
                    None
                }
                Some(other) => Some(ids[other].clone()),
                None => {
                    problems.push(format!("members[{at}].{field}: «{}» is not the key of a seat. Keys: {}.", key.trim(), keys.join(", ")));
                    None
                }
            }
        };
        let boss = link("reports_to", &seat.reports_to);
        let escalate = link("escalate_to", &seat.escalate_to);
        let talks: Vec<String> = seat.talks_to.iter().filter_map(|key| link("talks_to", key)).collect();
        if let Some(member) = members.iter_mut().find(|m| m.id == ids[at]) {
            // Answering to the lead is stored as nobody: it is where every seat answers by default.
            member.reports_to = if seat.advisor { String::new() } else { boss.filter(|id| *id != lead_id).unwrap_or_default() };
            member.escalate_to = escalate.unwrap_or_default();
            member.talks_to = talks;
        }
    }
    for (at, seat) in spec.members.iter().enumerate() {
        if seat.leads && !spec.members.iter().any(|other| seat_of(&other.reports_to) == Some(at)) {
            flags.push(flag("sublead_alone", if seat.name.trim().is_empty() { keys[at].as_str() } else { seat.name.trim() }, ""));
            warnings.push(format!("«{}» is marked as a sub-lead and no seat reports to it, so it leads nobody.", if seat.name.trim().is_empty() { keys[at].as_str() } else { seat.name.trim() }));
        }
    }
    if problems.is_empty() {
        let mut tree = members.clone();
        if let Err(why) = hierarchy::normalize(&mut tree, &lead_id) {
            problems.push(format!("members: {why}"));
        }
    }

    // ---- a fixed plan
    let mut plan: Vec<PlanStep> = Vec::new();
    let step_keys: Vec<String> = spec.plan.iter().enumerate().map(|(at, s)| if s.key.trim().is_empty() { format!("p{}", at + 1) } else { s.key.trim().to_lowercase() }).collect();
    for (at, step) in spec.plan.iter().enumerate() {
        let here = |field: &str| format!("plan[{at}].{field}");
        if step_keys[..at].contains(&step_keys[at]) {
            problems.push(format!("{}: «{}» is used by another step.", here("key"), step_keys[at]));
        }
        let member = match seat_of(&step.member) {
            Some(seat) => ids[seat].clone(),
            None => {
                problems.push(format!("{}: «{}» is not the key of a seat. Keys: {}.", here("member"), step.member.trim(), keys.join(", ")));
                String::new()
            }
        };
        if step.instruction.trim().is_empty() {
            problems.push(format!("{}: say what the step does.", here("instruction")));
        }
        let kind = match step.kind.trim() {
            "" | "work" => "work",
            "investigate" => "investigate",
            other => {
                problems.push(format!("{}: «{other}» — one of work, investigate.", here("kind")));
                "work"
            }
        };
        let repo = match step.repo.trim() {
            "" => String::new(),
            "*" => "*".to_string(),
            name => repo_id(name).unwrap_or_else(|why| {
                problems.push(format!("{}: {why} Or \"*\" for one task per repository, or leave it out for the first.", here("repo")));
                String::new()
            }),
        };
        for dep in &step.depends_on {
            if !step_keys.iter().any(|k| k == &dep.trim().to_lowercase()) {
                problems.push(format!("{}: «{}» is not the key of a step.", here("depends_on"), dep.trim()));
            }
        }
        plan.push(PlanStep {
            key: step_keys[at].clone(),
            member,
            repo,
            kind: kind.into(),
            title: step.title.trim().to_string(),
            instruction: step.instruction.trim().to_string(),
            depends_on: step.depends_on.iter().map(|d| d.trim().to_lowercase()).collect(),
        });
    }

    // ---- the policy
    // What its members may do unasked is the user's to say, in the team's editor: a design starts
    // restricted, and a redesign — new seats, new prompts — goes back to it.
    let mut policy = existing.map(|t| t.policy.clone()).unwrap_or_default().untrusted();
    if existing.is_some() {
        // The seats are new ones: what named the old ones by id is gone with them.
        policy.review = super::ReviewPolicy::default();
        if policy.conflicts != "author" && policy.conflicts != "user" {
            policy.conflicts = "author".into();
        }
    }
    let fields = serde_json::to_value(&policy).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut overlay = fields.clone();
    for (key, value) in &spec.policy {
        match key.as_str() {
            "checks" => problems.push("policy.checks: the checks are their own field — \"checks\": [...] beside \"policy\".".into()),
            "review" => problems.push("policy.review: review is its own field — \"review\": {...} beside \"policy\".".into()),
            "permissions" => problems.push("policy.permissions: what the members may do without asking is set by the user, in the team's editor (Permisos y aislamiento) — leave it out.".into()),
            "conflicts" => {
                let text = value.as_str().unwrap_or_default().trim();
                match (text, seat_of(text)) {
                    ("author" | "user", _) => {
                        overlay.insert(key.clone(), json!(text));
                    }
                    (_, Some(seat)) => {
                        overlay.insert(key.clone(), json!(ids[seat]));
                    }
                    _ => problems.push(format!("policy.conflicts: «{text}» — author (whoever wrote the task), user, or the key of a seat.")),
                }
            }
            known_key if fields.contains_key(known_key) => {
                if let Some((_, allowed)) = CHOICES.iter().find(|(name, _)| *name == known_key) {
                    if !value.as_str().is_some_and(|v| allowed.contains(&v)) {
                        problems.push(format!("policy.{known_key}: {value} — one of {}.", allowed.join(", ")));
                        continue;
                    }
                }
                overlay.insert(key.clone(), value.clone());
            }
            unknown => {
                let mut names: Vec<&String> = fields.keys().filter(|k| *k != "checks" && *k != "review" && *k != "permissions").collect();
                names.sort();
                problems.push(format!("policy.{unknown}: not a policy field. Fields: {}.", names.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", ")));
            }
        }
    }
    match serde_json::from_value::<Policy>(Value::Object(overlay.clone())) {
        Ok(read) => policy = read,
        Err(why) => problems.push(format!("policy: {why}.")),
    }
    // Checks.
    if let Some(checks) = &spec.checks {
        policy.checks.clear();
        for (at, check) in checks.iter().enumerate() {
            let here = |field: &str| format!("checks[{at}].{field}");
            if check.command.trim().is_empty() {
                problems.push(format!("{}: the command the app runs, as typed in a terminal at the repository's root.", here("command")));
            }
            let repo = match check.repo.trim() {
                "" | "*" => "*".to_string(),
                name => repo_id(name).unwrap_or_else(|why| {
                    problems.push(format!("{}: {why} Or \"*\" for every repository.", here("repo")));
                    "*".into()
                }),
            };
            let pick = |field: &str, value: &str, allowed: &[&str], default: &str, problems: &mut Vec<String>| -> String {
                match value.trim() {
                    "" => default.to_string(),
                    given if allowed.contains(&given) => given.to_string(),
                    given => {
                        problems.push(format!("{}: «{given}» — one of {}.", here(field), allowed.join(", ")));
                        default.to_string()
                    }
                }
            };
            let kind = pick("kind", &check.kind, &["unit", "integration", "e2e", "lint", "other"], "other", &mut problems);
            let default_when = match kind.as_str() {
                "unit" | "lint" => "item",
                "e2e" => "agent",
                _ => "final",
            };
            let when = pick("when", &check.when, &["item", "final", "agent"], default_when, &mut problems);
            policy.checks.push(Check { repo, command: check.command.trim().to_string(), when, kind, label: check.label.trim().to_string(), write: check.write });
        }
    }
    // Review.
    if let Some(review) = &spec.review {
        let here = |field: &str| format!("review.{field}");
        let reviewer = seat_of(&review.reviewer);
        match reviewer {
            None => problems.push(format!("{}: «{}» is not the key of a seat. Keys: {}.", here("reviewer"), review.reviewer.trim(), keys.join(", "))),
            Some(seat) if spec.members[seat].advisor => problems.push(format!("{}: the advisor is never given work, reviews included. Seat a reviewer.", here("reviewer"))),
            Some(_) => {}
        }
        let mut of = Vec::new();
        for key in &review.of {
            match seat_of(key) {
                Some(seat) if Some(seat) == reviewer => problems.push(format!("{}: the reviewer does not review its own work.", here("of"))),
                Some(seat) => of.push(ids[seat].clone()),
                None => problems.push(format!("{}: «{}» is not the key of a seat.", here("of"), key.trim())),
            }
        }
        let exigence = match review.exigence.trim() {
            "" | "correct" => "correct",
            "polished" => "polished",
            other => {
                problems.push(format!("{}: «{other}» — correct (it works and is right) or polished (also clean and consistent).", here("exigence")));
                "correct"
            }
        };
        if let Some(seat) = reviewer {
            let authors = spec.members.iter().enumerate().filter(|(at, s)| *at != seat && !s.advisor && s.edits.unwrap_or(true)).count();
            if authors == 0 {
                problems.push(format!("{}: nobody but the reviewer writes, so there is nothing for it to review.", here("reviewer")));
            }
            policy.review = super::ReviewPolicy { enabled: true, reviewer: ids[seat].clone(), of, exigence: exigence.into(), laps: review.laps.unwrap_or(crate::chain_review::DEFAULT_MAX_LAPS) };
        }
    }
    // «One pass per agent» folds reviews, the advisor's reading and the lead's last look away
    // when a run starts (`Policy::for_run`): a team that asks for any of them cannot also keep it.
    let asks_laps = policy.review.enabled || advisors > 0;
    match (asks_laps, spec.policy.get("single_pass").and_then(Value::as_bool)) {
        (true, Some(true)) => problems.push("policy.single_pass: with it on each agent works once — no review laps, no advisor on the plan, no last look — so the review or the advisor this team has would never happen. Send false, or drop them.".into()),
        (true, None) if policy.single_pass => {
            policy.single_pass = false;
            notes.push("single_pass turned off: the team has a review or an advisor, and one pass per agent would skip them.".into());
        }
        (false, None) if policy.single_pass && existing.is_none() => notes.push("single_pass is on (the default): each agent works once — one plan, one attempt per task, no last look. Right for a task of a few edits; send policy.single_pass false for a team meant to iterate.".into()),
        _ => {}
    }
    // Isolated checks: on for a new team where an engine answers, as the window does.
    if !spec.policy.contains_key("sandbox") && existing.is_none() {
        policy.sandbox = if known.sandbox.is_some() { "checks" } else { "off" }.into();
        notes.push(match &known.sandbox {
            Some(engine) => format!("sandbox: checks — the app runs this team's checks isolated, in {engine}."),
            None => "sandbox: off — no container engine answers here, so the checks run on this computer.".into(),
        });
    }
    if policy.sandbox == "checks" && known.sandbox.is_none() {
        flags.push(flag("no_engine", "", &known.sandbox_problem));
        warnings.push(format!("The team asks for isolated checks and no container engine answers here ({}): a run will stop and ask the user before it checks anything.", if known.sandbox_problem.is_empty() { "none found" } else { known.sandbox_problem.as_str() }));
    }
    let asked = policy.clone();
    let policy = policy.sane();
    for (label, before, after) in [
        ("max_parallel", asked.max_parallel, policy.max_parallel),
        ("max_attempts", asked.max_attempts, policy.max_attempts),
        ("max_dispatches", asked.max_dispatches, policy.max_dispatches),
        ("lead_rounds", asked.lead_rounds, policy.lead_rounds),
        ("sub_lead_rounds", asked.sub_lead_rounds, policy.sub_lead_rounds),
        ("budget_minutes", asked.budget_minutes, policy.budget_minutes),
        ("turn_minutes", asked.turn_minutes, policy.turn_minutes),
        ("max_session_pct", asked.max_session_pct, policy.max_session_pct),
    ] {
        if before != after {
            notes.push(format!("policy.{label}: {before} → {after} (its limit)."));
        }
    }

    // ---- what it will run like
    if !members.is_empty() && !members.iter().any(|m| m.edits) {
        flags.push(flag("nobody_writes", "", ""));
        warnings.push("No seat may write: this team can investigate and review, not change code.".into());
    }
    if policy.guarantees != "off" {
        let bounded = policy.unmetered_minutes > 0 || policy.budget_minutes > 0;
        let mut open = Vec::new();
        for (provider, edits, name) in &engines {
            // Read from what was gathered for this computer, as `provider_caps::gaps` reads it.
            let Some(engine) = known.provider(provider) else { continue };
            if !*edits && !engine.read_only {
                flags.push(flag("read_only_unenforced", name, &engine.label));
                open.push(format!("«{name}» must not write, and {} does not enforce read-only — it is only asked not to.", engine.label));
            }
            if !engine.metered && !bounded {
                flags.push(flag("unmetered", name, &engine.label));
                open.push(format!("«{name}» runs on {}, which publishes no consumption, and the team sets no cap on minutes.", engine.label));
            }
        }
        if !open.is_empty() && policy.guarantees == "block" {
            flags.push(flag("guarantees_block", "", ""));
            warnings.push("With guarantees: block this team will not start until these are closed:".into());
        }
        warnings.extend(open);
    }
    if policy.integrate == "merge" && !policy.approve_merge {
        flags.push(flag("merge_unasked", "", ""));
        warnings.push("approve_merge is off with integrate: merge — finished work lands on the target branch without asking the user.".into());
    }

    if !problems.is_empty() {
        return Err(problems);
    }
    let team = Team {
        id: existing.map(|t| t.id.clone()).unwrap_or_default(),
        workspace_id: workspace_id.to_string(),
        name,
        description,
        lead: lead_id,
        policy,
        plan,
        members,
        created_at: existing.map(|t| t.created_at.clone()).unwrap_or_default(),
        updated_at: String::new(),
    };
    Ok(Design { team, agents: drafts, updating: existing.is_some(), warnings, flags, notes, seats, routes })
}

fn ready_list(known: &Known) -> String {
    let ready: Vec<&str> = known.providers.iter().filter(|p| p.ready).map(|p| p.id.as_str()).collect();
    if ready.is_empty() { "none".into() } else { ready.join(", ") }
}

/// What [`commit`] made.
#[derive(Debug, Clone)]
pub struct Made {
    pub team: Team,
    pub agents: Vec<WorkspaceAgent>,
}

/// Saves the design: its new agents, then the team that seats them — both, or neither.
pub fn commit(conn: &Connection, design: &Design) -> Result<Made, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut agents = Vec::new();
    for draft in &design.agents {
        agents.push(queries::save_workspace_agent(&tx, draft).map_err(|e| e.to_string())?);
    }
    let mut team = design.team.clone();
    for member in &mut team.members {
        if let Some(n) = member.agent_id.strip_prefix("new:").and_then(|n| n.parse::<usize>().ok()) {
            member.agent_id = agents.get(n).map(|a| a.id.clone()).ok_or("the team names an agent that was not made")?;
        }
    }
    let team = super::save_team(&tx, team)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Made { team, agents })
}

/// The design in words, for the model to tell the user from.
fn describe(design: &Design, projects: &[Project]) -> String {
    let team = &design.team;
    let mut out = Vec::new();
    out.push(format!("Team «{}» — {}", team.name, team.description));
    let lead = team.members.iter().find(|m| m.id == team.lead).map(|m| m.name.clone());
    out.push(match &lead {
        Some(name) => format!("Lead: «{name}»{}", if team.members.iter().any(|m| m.id == team.lead && m.hands_on) { " (also takes work)" } else { "" }),
        None => format!("No lead: a fixed plan of {} steps", team.plan.len()),
    });
    out.push(format!("Seats ({}):", design.seats.len()));
    out.extend(design.seats.iter().map(|line| format!("- {line}")));
    let policy = &team.policy;
    let repo_name = |id: &str| if id == "*" { "every repository".to_string() } else { projects.iter().find(|p| p.id == id).map(|p| p.name.clone()).unwrap_or_else(|| id.to_string()) };
    if policy.checks.is_empty() {
        out.push(if policy.auto_checks { "Checks: none listed — each repository's own suites, detected when a run starts.".into() } else { "Checks: none, and detection is off (policy.auto_checks).".to_string() });
    } else {
        out.push("Checks:".into());
        for check in &policy.checks {
            let when = match check.when.as_str() {
                "item" => "after every task that writes",
                "agent" => "run by the members themselves",
                _ => "once everything is integrated",
            };
            out.push(format!("- `{}` · {} · {} · {when}{}", check.command, check.name(), repo_name(&check.repo), if check.write { " · members add tests of this kind" } else { "" }));
        }
    }
    if policy.review.enabled {
        let reviewer = team.members.iter().find(|m| m.id == policy.review.reviewer).map(|m| m.name.as_str()).unwrap_or("?");
        out.push(format!("Review: «{reviewer}» reads every task that writes ({}, up to {} laps).", policy.review.exigence, policy.review.laps));
    }
    let on = |flag: bool| if flag { "asks you" } else { "does not ask" };
    out.push(format!(
        "How it runs: the plan {} · code {} · integrating {} ({}) · up to {} tasks at once · checks {} · done is {} · questions {}.",
        on(policy.approve_plan),
        match policy.approve_code.as_str() {
            "each" => "asks you on every task",
            "first" => "asks you on the first task",
            _ => "does not ask",
        },
        on(policy.approve_merge),
        match policy.integrate.as_str() {
            "branch" => "left on a branch",
            "pr" => "a pull request",
            _ => "merged into the target branch",
        },
        policy.max_parallel,
        if policy.sandbox == "checks" { "isolated in a container" } else { "on this computer" },
        match policy.dod.as_str() {
            "block" => "enforced with evidence",
            "off" => "the member's word",
            _ => "flagged when unproven",
        },
        match policy.questions.as_str() {
            "never" => "never",
            "plan" => "only from the lead while planning",
            _ => "allowed",
        },
    ));
    if !design.notes.is_empty() {
        out.push("Filled in:".into());
        out.extend(design.notes.iter().map(|n| format!("- {n}")));
    }
    if !design.warnings.is_empty() {
        out.push("Tell the user:".into());
        out.extend(design.warnings.iter().map(|w| format!("- {w}")));
    }
    out.join("\n")
}

// ---------------------------------------------------------------- how good it is

/// How well a design that passed fits the workspace it is for — what the checks above cannot
/// refuse without being wrong some of the time, so it is said instead: a score, and what would
/// raise it. The model gets it with the answer; the evaluation (`tests::eval_score_the_specs`)
/// reads the same number.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Quality {
    /// 0–100.
    pub score: u32,
    pub findings: Vec<String>,
}

fn words_of(text: &str) -> HashSet<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() > 3).map(str::to_string).collect()
}

fn alike(a: &str, b: &str) -> f64 {
    let (a, b) = (words_of(a), words_of(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    a.intersection(&b).count() as f64 / a.union(&b).count() as f64
}

/// `word` in `text` as a word of its own, whatever the case: «Go» is not in «Django».
fn names(text: &str, word: &str) -> bool {
    let (text, word) = (text.to_lowercase(), word.to_lowercase());
    if word.is_empty() {
        return false;
    }
    text.match_indices(&word).any(|(at, found)| {
        let before = text[..at].chars().next_back();
        let after = text[at + found.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// How many things `text` names that exist in one of `roots`: a folder, a file — written as a
/// path (`src/team`, `package.json`).
fn real_paths(text: &str, roots: &[&Path]) -> usize {
    let mut found: HashSet<String> = HashSet::new();
    for token in text.split_whitespace() {
        let token = token.trim_matches(|c: char| "`\"'«»()[]{}.,;:!?*<>".contains(c));
        let token = token.trim_start_matches("./").trim_end_matches("/**").trim_end_matches("/*").trim_end_matches('/');
        if token.len() < 3 || !(token.contains('/') || token.contains('.')) || token.starts_with('/') || token.contains("..") || token.contains("://") {
            continue;
        }
        if roots.iter().any(|root| root.join(token).exists()) {
            found.insert(token.to_string());
        }
    }
    found.len()
}

/// Whether `text` says how the work is verified: one of `commands` whole, one link of a chained
/// one (`cd src-tauri && cargo test --lib`), or what it starts with (`cargo test`).
fn names_command(text: &str, commands: &[String]) -> bool {
    commands.iter().flat_map(|command| command.split("&&")).map(str::trim).filter(|part| !part.is_empty() && !part.starts_with("cd ")).any(|part| {
        let head: Vec<&str> = part.split_whitespace().take(2).collect();
        text.contains(part) || (head.len() == 2 && text.contains(&head.join(" ")))
    })
}

/// The technologies a repository's stack line names, one by one.
fn stack_words(stack: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in stack {
        // `src-tauri/ (Rust, Tauri)` — the folder is a path, not a technology.
        let line = line.split_once("/ (").map(|(_, inner)| inner).unwrap_or(line);
        for word in line.split(|c: char| ",;()·".contains(c)).map(str::trim) {
            if word.chars().count() >= 2 && !["monorepo", "workspace"].contains(&word) && !out.iter().any(|known| known == word) {
                out.push(word.to_string());
            }
        }
    }
    out
}

/// Whether a check starts something that keeps running — a dev server, a watcher — instead of
/// ending with pass or fail. Run by the engine it holds the item until it times out; told to a
/// member it holds that member's turn.
fn never_ends(command: &str) -> bool {
    const KEEPS_RUNNING: [&str; 7] = ["dev", "serve", "start", "watch", "--watch", "preview", "storybook"];
    command.split(|c| c == '&' || c == ';' || c == '|').any(|part| {
        let words: Vec<&str> = part.split_whitespace().collect();
        // `cd dev && …`, `git checkout dev`: a folder or a branch of that name starts nothing.
        let runs = !matches!(words.first(), Some(&"cd") | Some(&"git") | None);
        runs && (words.first() == Some(&"nodemon") || words.iter().skip(1).any(|w| KEEPS_RUNNING.contains(w)))
    })
}

/// See [`Quality`].
pub fn quality(design: &Design, projects: &[Project]) -> Quality {
    let team = &design.team;
    let mut findings: Vec<String> = Vec::new();
    let roots_of = |repos: &[String]| -> Vec<&Project> { projects.iter().filter(|p| repos.is_empty() || repos.contains(&p.id)).collect() };
    let stacks: HashMap<&str, Vec<String>> = projects.iter().map(|p| (p.id.as_str(), stack_of(Path::new(&p.local_path)))).collect();
    let commands_of = |scope: &[&Project]| -> Vec<String> {
        let mut all: Vec<String> = team.policy.checks.iter().filter(|c| c.repo == "*" || scope.iter().any(|p| p.id == c.repo)).map(|c| c.command.clone()).collect();
        for project in scope {
            all.extend(super::intelligence::detect_suites(Path::new(&project.local_path)).into_iter().map(|c| c.command));
        }
        all
    };
    // What ties a text to this workspace: a real path, a real command, the stack by name.
    let grounding = |text: &str, repos: &[String]| -> (usize, bool, bool, Vec<String>, Vec<String>) {
        let scope = roots_of(repos);
        let roots: Vec<&Path> = scope.iter().map(|p| Path::new(&p.local_path)).collect();
        let commands = commands_of(&scope);
        let stack: Vec<String> = scope.iter().flat_map(|p| stack_words(stacks.get(p.id.as_str()).map(Vec::as_slice).unwrap_or_default())).collect();
        let repo_named = scope.iter().any(|p| names(text, &p.name));
        (real_paths(text, &roots), names_command(text, &commands), repo_named || stack.iter().any(|w| names(text, w)), commands, stack)
    };
    let works = |m: &Member| !m.advisor && (m.id != team.lead || m.hands_on);
    let writes = |m: &Member| works(m) && m.edits;

    // 1. A new agent's prompt is about this workspace (35).
    let mut prompt_points = 0.0;
    for (n, draft) in design.agents.iter().enumerate() {
        let seat = team.members.iter().find(|m| m.agent_id == format!("new:{n}"));
        let repos = seat.map(|m| m.repos.clone()).unwrap_or_default();
        let (paths, command, stack, commands, stack_names) = grounding(&draft.prompt, &repos);
        if seat.is_some_and(|m| writes(m)) {
            prompt_points += match paths { 0 => 0.0, 1 => 0.3, _ => 0.5 } + if command { 0.3 } else { 0.0 } + if stack { 0.2 } else { 0.0 };
            if paths == 0 {
                findings.push(format!("«{}»'s prompt names no folder or file that exists in the repository: say which paths it owns.", draft.name));
            }
            if !command && !commands.is_empty() {
                findings.push(format!("«{}»'s prompt does not name the command it verifies its work with (here: `{}`).", draft.name, commands[0]));
            }
            if !stack && !stack_names.is_empty() {
                findings.push(format!("«{}»'s prompt never names the stack it works in ({}).", draft.name, stack_names.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
            }
        } else {
            // A seat that plans, reviews or advises: it has to know where it is, not own a folder.
            prompt_points += if paths > 0 || stack { 0.7 } else { 0.0 } + if command || commands.is_empty() { 0.3 } else { 0.0 };
            if paths == 0 && !stack {
                findings.push(format!("«{}»'s prompt could be for any project: name this workspace's stack or its layout.", draft.name));
            }
        }
    }
    let prompts = if design.agents.is_empty() { 35.0 } else { 35.0 * prompt_points / design.agents.len() as f64 };

    // 2. A role says what part of the code the seat owns (10) — of a seat that writes: one that
    // reviews or investigates owns none.
    let hands: Vec<&Member> = team.members.iter().filter(|m| works(m)).collect();
    let owners: Vec<&Member> = hands.iter().copied().filter(|m| m.edits).collect();
    let grounded = owners.iter().filter(|m| {
        let (paths, _, stack, _, _) = grounding(&m.role, &m.repos);
        let ok = paths > 0 || stack;
        if !ok {
            findings.push(format!("«{}»'s role does not say what part of the code it owns — a folder, a layer, a repository — and the lead routes work by it.", m.name));
        }
        ok
    }).count();
    let roles = if owners.is_empty() { 10.0 } else { 10.0 * grounded as f64 / owners.len() as f64 };

    // 3. No two seats for one job (15).
    let mut twins = 0;
    for (at, a) in hands.iter().enumerate() {
        for b in &hands[at + 1..] {
            if alike(&a.role, &b.role) >= 0.7 {
                twins += 1;
                findings.push(format!("«{}» and «{}» have the same job by their roles: merge them, or say what tells them apart.", a.name, b.name));
            }
        }
    }
    for (at, a) in design.agents.iter().enumerate() {
        for b in &design.agents[at + 1..] {
            if alike(&a.prompt, &b.prompt) >= 0.8 {
                twins += 1;
                findings.push(format!("«{}» and «{}» have nearly the same prompt: one agent can fill both seats.", a.name, b.name));
            }
        }
    }
    let distinct = (15.0 - 8.0 * twins as f64).max(0.0);

    // 4. Seats that write are kept apart where there is more than one repository (10).
    let writers: Vec<&Member> = team.members.iter().filter(|m| writes(m)).collect();
    let scope = if projects.len() >= 2 && writers.len() >= 2 && writers.iter().all(|m| m.repos.is_empty()) {
        findings.push("Every seat that writes may write in every repository: scope them with \"repos\" so two never change the same files.".into());
        0.0
    } else {
        10.0
    };

    // 5. Small (10).
    let size = match team.members.len() {
        0..=6 => 10.0,
        7..=8 => {
            findings.push(format!("{} seats: each one is planning and coordination the run pays for. Keep the ones the need cannot do without.", team.members.len()));
            5.0
        }
        n => {
            findings.push(format!("{n} seats is a department, not a team: split it, or keep the few the need cannot do without."));
            0.0
        }
    };

    // 6. Somebody reads what is written (10).
    let mut review: f64 = 10.0;
    if team.policy.review.enabled {
        if let Some(reviewer) = team.members.iter().find(|m| m.id == team.policy.review.reviewer) {
            if reviewer.edits {
                review -= 3.0;
                findings.push(format!("«{}» reviews and may also write: a reviewer that cannot change the code (\"edits\": false) can only say what it found.", reviewer.name));
            }
            let route = |m: &Member| design.routes.iter().find(|r| r.member_id == m.id).map(|r| (r.provider.clone(), r.model.clone()));
            let same: Vec<&str> = writers.iter().filter(|m| m.id != reviewer.id && route(m).is_some() && route(m) == route(reviewer)).map(|m| m.name.as_str()).collect();
            if !same.is_empty() && same.len() == writers.iter().filter(|m| m.id != reviewer.id).count() {
                review -= 3.0;
                findings.push(format!("«{}» reviews work written on the very model it runs on: another model catches what this one misses.", reviewer.name));
            }
        }
    } else if writers.len() >= 2 && !team.members.iter().any(|m| m.advisor) {
        review = 4.0;
        findings.push("Several seats write and nobody reads their work before it is integrated: name a reviewer in \"review\".".into());
    }

    // 7. The suites that exist are run, and every check ends (10).
    let mut checks: f64 = 10.0;
    for check in team.policy.checks.iter().filter(|c| never_ends(&c.command)) {
        checks = 5.0;
        findings.push(format!(
            "The check `{}` starts something that keeps running (a server, a watcher) and never says pass or fail: name a command that ends, or leave it out and say in the prompt how to look by hand.",
            check.command
        ));
    }
    let in_use: Vec<&Project> = projects.iter().filter(|p| team.members.iter().any(|m| writes(m) && (m.repos.is_empty() || m.repos.contains(&p.id)))).collect();
    for project in in_use {
        for line in stacks.get(project.id.as_str()).map(Vec::as_slice).unwrap_or_default() {
            let Some((folder, _)) = line.split_once("/ (") else { continue };
            // Only where the team says it works there: a team for the interface owes nothing to
            // the backend's suite.
            // (By the roles, which say what a seat owns — a prompt also names what it must not touch.)
            let touched = team.members.iter().filter(|m| writes(m)).any(|m| m.role.contains(folder));
            if !touched {
                continue;
            }
            let listed = team.policy.checks.iter().any(|c| (c.repo == "*" || c.repo == project.id) && c.command.contains(folder));
            if !listed {
                checks = (checks - 5.0).max(0.0);
                findings.push(format!("{}/ in {} has its own suite and no check runs it: add one (`cd {folder} && …`).", folder, project.name));
            }
        }
    }

    Quality { score: (prompts + roles + distinct + scope + size + review + checks).round().clamp(0.0, 100.0) as u32, findings }
}

fn quality_text(quality: &Quality, created: bool) -> String {
    let mut out = vec![format!("Fit for this workspace: {}/100.", quality.score)];
    if !quality.findings.is_empty() {
        out.push(if created { "What would make it better — fix it with \"update\" before the user launches it:".to_string() } else { "What would make it better — fix it before creating:".to_string() });
        out.extend(quality.findings.iter().take(10).map(|f| format!("- {f}")));
    }
    out.join("\n")
}

// ---------------------------------------------------------------- the brief

/// What a repository is made of, from the manifests at its root and one level down.
fn stack_of(root: &Path) -> Vec<String> {
    fn of_folder(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let text = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
        let exists = |name: &str| dir.join(name).exists();
        if let Some(package) = text("package.json").and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            let mut deps: HashSet<String> = HashSet::new();
            for field in ["dependencies", "devDependencies", "peerDependencies"] {
                if let Some(map) = package[field].as_object() {
                    deps.extend(map.keys().cloned());
                }
            }
            let mut parts = vec![if deps.contains("typescript") || exists("tsconfig.json") { "TypeScript" } else { "JavaScript" }.to_string()];
            for (dep, label) in [
                ("next", "Next.js"), ("react", "React"), ("vue", "Vue"), ("nuxt", "Nuxt"), ("svelte", "Svelte"), ("@angular/core", "Angular"), ("solid-js", "Solid"),
                ("react-native", "React Native"), ("expo", "Expo"), ("electron", "Electron"), ("@tauri-apps/api", "Tauri"),
                ("@nestjs/core", "NestJS"), ("express", "Express"), ("fastify", "Fastify"), ("hono", "Hono"),
                ("vite", "Vite"), ("tailwindcss", "Tailwind"), ("prisma", "Prisma"), ("drizzle-orm", "Drizzle"), ("typeorm", "TypeORM"),
                ("vitest", "Vitest"), ("jest", "Jest"), ("@playwright/test", "Playwright"), ("cypress", "Cypress"),
            ] {
                if deps.contains(dep) && !(label == "React" && parts.iter().any(|p| p == "Next.js" || p == "React Native")) {
                    parts.push(label.to_string());
                }
            }
            // A `pnpm-workspace.yaml` with no packages is only where pnpm keeps its settings.
            let pnpm_packages = text("pnpm-workspace.yaml").is_some_and(|yaml| yaml.lines().any(|line| line.trim_start().starts_with("packages:")));
            if package["workspaces"].is_array() || package["workspaces"].is_object() || pnpm_packages || exists("turbo.json") || exists("nx.json") {
                parts.push("monorepo".into());
            }
            out.push(parts.join(", "));
        }
        if let Some(cargo) = text("Cargo.toml") {
            let mut parts = vec!["Rust".to_string()];
            for (dep, label) in [("tauri", "Tauri"), ("axum", "Axum"), ("actix-web", "Actix"), ("tokio", "Tokio"), ("sqlx", "sqlx"), ("rusqlite", "SQLite"), ("diesel", "Diesel")] {
                if cargo.lines().any(|line| line.trim_start().starts_with(&format!("{dep} ")) || line.trim_start().starts_with(&format!("{dep}="))) {
                    parts.push(label.to_string());
                }
            }
            if cargo.contains("[workspace]") {
                parts.push("workspace".into());
            }
            out.push(parts.join(", "));
        }
        if exists("go.mod") {
            out.push("Go".into());
        }
        let python = [text("pyproject.toml"), text("requirements.txt")].into_iter().flatten().collect::<Vec<_>>().join("\n").to_lowercase();
        if !python.is_empty() || exists("setup.py") {
            let mut parts = vec!["Python".to_string()];
            for (dep, label) in [("django", "Django"), ("fastapi", "FastAPI"), ("flask", "Flask"), ("pytest", "pytest"), ("pyspark", "PySpark"), ("pandas", "pandas")] {
                if python.contains(dep) {
                    parts.push(label.to_string());
                }
            }
            out.push(parts.join(", "));
        }
        if let Some(pom) = text("pom.xml") {
            out.push(if pom.contains("spring-boot") { "Java, Spring Boot, Maven" } else { "Java, Maven" }.into());
        } else if exists("build.gradle") || exists("build.gradle.kts") {
            let gradle = [text("build.gradle"), text("build.gradle.kts")].into_iter().flatten().collect::<String>();
            out.push(match (gradle.contains("kotlin"), gradle.contains("spring"), gradle.contains("com.android")) {
                (_, _, true) => "Android, Gradle",
                (true, true, _) => "Kotlin, Spring, Gradle",
                (true, false, _) => "Kotlin, Gradle",
                (false, true, _) => "Java, Spring, Gradle",
                _ => "Java, Gradle",
            }.into());
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            if entries.flatten().any(|e| e.file_name().to_string_lossy().ends_with(".csproj") || e.file_name().to_string_lossy().ends_with(".sln")) {
                out.push(".NET".into());
            }
        }
        if let Some(gemfile) = text("Gemfile") {
            out.push(if gemfile.contains("rails") { "Ruby on Rails" } else { "Ruby" }.into());
        }
        if let Some(composer) = text("composer.json") {
            out.push(if composer.contains("laravel/framework") { "PHP, Laravel" } else { "PHP" }.into());
        }
        if exists("pubspec.yaml") {
            out.push("Flutter".into());
        }
        out
    }
    let mut out = of_folder(root);
    const SKIP: [&str; 9] = ["node_modules", "target", "dist", "build", "vendor", "out", "coverage", "tmp", "bin"];
    let mut folders: Vec<std::path::PathBuf> = std::fs::read_dir(root)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    folders.sort();
    // One level more for the folders a monorepo keeps its packages in.
    let mut nested: Vec<std::path::PathBuf> = Vec::new();
    for group in ["apps", "packages", "services", "libs", "crates"] {
        if let Ok(entries) = std::fs::read_dir(root.join(group)) {
            let mut inner: Vec<std::path::PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            inner.sort();
            nested.extend(inner);
        }
    }
    let mut also = 0;
    for folder in folders.into_iter().chain(nested) {
        let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) || also >= 12 {
            continue;
        }
        let found = of_folder(&folder);
        if !found.is_empty() {
            let rel = folder.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or(name);
            out.push(format!("{rel}/ ({})", found.join("; ")));
            also += 1;
        }
    }
    let mut extras = Vec::new();
    if root.join("Dockerfile").exists() || root.join("docker-compose.yml").exists() || root.join("compose.yaml").exists() || root.join("docker-compose.yaml").exists() {
        extras.push("Docker");
    }
    if root.join(".github/workflows").is_dir() {
        extras.push("GitHub Actions");
    }
    if root.join("azure-pipelines.yml").exists() {
        extras.push("Azure Pipelines");
    }
    if root.join(".gitlab-ci.yml").exists() {
        extras.push("GitLab CI");
    }
    if !extras.is_empty() {
        out.push(extras.join(", "));
    }
    out
}

fn first_words(text: &str, most: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= most {
        return flat;
    }
    format!("{}…", flat.chars().take(most).collect::<String>())
}

/// `team_brief`: the workspace as a team would be made from it, and how to make one.
pub fn brief(conn: &Connection, workspace_id: &str, here: Option<&Project>, known: &Known) -> Result<String, String> {
    let e = |problem: rusqlite::Error| problem.to_string();
    let roster = queries::list_workspace_agents(conn, workspace_id).map_err(e)?;
    let projects = queries::list_projects(conn, workspace_id).map_err(e)?;
    let teams = super::list_teams(conn, workspace_id).map_err(e)?;
    let workspace = queries::list_workspaces(conn).map_err(e)?.into_iter().find(|w| w.id == workspace_id).map(|w| w.name).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();

    out.push(format!("WORKSPACE «{workspace}»{}", here.map(|p| format!(" — this chat is in the repository «{}»", p.name)).unwrap_or_default()));
    out.push(String::new());
    out.push(format!("REPOSITORIES ({})", projects.len()));
    if projects.is_empty() {
        out.push("None yet: a team needs at least one repository to work in.".into());
    }
    for project in &projects {
        let root = Path::new(&project.local_path);
        let stack = stack_of(root);
        out.push(format!("- {} — {}", project.name, if stack.is_empty() { "no manifest recognised at its root".to_string() } else { stack.join(" · ") }));
        let suites = super::intelligence::detect_suites(root);
        if !suites.is_empty() {
            out.push(format!("  suites found: {}", suites.iter().map(|c| format!("`{}` ({}, {})", c.command, c.kind, c.when)).collect::<Vec<_>>().join(", ")));
        }
        // Only the root's suites are found: a package one folder down has its own, and nobody
        // will run them unless the team lists them.
        if stack.iter().any(|part| part.contains("/ (")) {
            out.push("  the folders named above have suites of their own that are not detected: list them in \"checks\" (e.g. `cd <folder> && <its test command>`)".into());
        }
        let rules: Vec<&str> = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".cursorrules"].into_iter().filter(|name| root.join(name).is_file()).collect();
        if !rules.is_empty() {
            out.push(format!("  its own rules: {} — read them before writing a prompt", rules.join(", ")));
        }
    }

    out.push(String::new());
    out.push(format!("AGENTS IN THE ROSTER ({})", roster.len()));
    if roster.is_empty() {
        out.push("None yet: every seat will be a new_agent.".into());
    }
    for agent in &roster {
        let scope = if agent.repos.is_empty() { "every repository".to_string() } else { agent.repos.iter().filter_map(|id| projects.iter().find(|p| &p.id == id)).map(|p| p.name.clone()).collect::<Vec<_>>().join(", ") };
        out.push(format!(
            "- «{}»{} — {} — {}/{}{} · {} · {scope}",
            agent.name,
            if agent.enabled { "" } else { " (off)" },
            if agent.role.trim().is_empty() { "no role" } else { agent.role.trim() },
            if agent.provider.is_empty() { "no provider" } else { &agent.provider },
            if agent.model.is_empty() { "no model" } else { &agent.model },
            if agent.effort.is_empty() { String::new() } else { format!(" ({})", agent.effort) },
            if agent.edits { "may write" } else { "read-only" },
        ));
        if !agent.prompt.trim().is_empty() {
            out.push(format!("  prompt: {}", first_words(&agent.prompt, 220)));
        }
    }

    out.push(String::new());
    out.push(format!("TEAMS ({})", teams.len()));
    for team in &teams {
        let lead = team.members.iter().find(|m| m.id == team.lead).map(|m| m.name.as_str()).unwrap_or("fixed plan");
        let seats: Vec<String> = team
            .members
            .iter()
            .map(|m| {
                let agent = roster.iter().find(|a| a.id == m.agent_id).map(|a| a.name.as_str()).unwrap_or("?");
                if same(agent, &m.name) { m.name.clone() } else { format!("{} ({agent})", m.name) }
            })
            .collect();
        out.push(format!("- «{}» — lead: {lead} — seats: {}{}", team.name, seats.join(", "), if team.policy.review.enabled { " — with review" } else { "" }));
        if !team.description.trim().is_empty() {
            out.push(format!("  {}", first_words(&team.description, 200)));
        }
    }
    if teams.is_empty() {
        out.push("None yet.".into());
    }

    out.push(String::new());
    out.push("PROVIDERS ON THIS COMPUTER".into());
    for provider in known.providers.iter().filter(|p| p.ready) {
        let (models, strict) = known.models(&provider.id, &roster);
        let shown: Vec<String> = models.iter().take(30).cloned().collect();
        out.push(format!(
            "- {} ({}) — models: {}{}{} — read-only {} · consumption {} · loop guard {}",
            provider.id,
            provider.label,
            if shown.is_empty() { "as its CLI names them".to_string() } else { shown.join(", ") },
            if models.len() > shown.len() { format!(" (+{})", models.len() - shown.len()) } else { String::new() },
            if provider.pending { " (its CLI has not answered yet: call team_brief again in a moment for the list)" } else if strict { "" } else if provider.id == "claude" { " — or a full id such as claude-…" } else { " (not a full list)" },
            if provider.read_only { "enforced" } else { "only asked" },
            if provider.metered { "seen" } else { "not published" },
            if provider.loop_guard { "yes" } else { "no" },
        ));
    }
    let missing: Vec<&str> = known.providers.iter().filter(|p| !p.ready).map(|p| p.id.as_str()).collect();
    if !missing.is_empty() {
        out.push(format!("Not ready here (do not use): {}.", missing.join(", ")));
    }
    out.push(match &known.sandbox {
        Some(engine) => format!("Isolated checks: available ({engine}) — a new team gets sandbox: checks."),
        None => format!("Isolated checks: no container engine answers ({}) — a new team gets sandbox: off.", if known.sandbox_problem.is_empty() { "none found" } else { known.sandbox_problem.as_str() }),
    });

    out.push(String::new());
    out.push(GUIDE.replace("{MIN_PROMPT}", &MIN_PROMPT.to_string()).replace("{MIN_ROLE}", &MIN_ROLE.to_string()).replace("{COLORS}", &COLORS.join(", ")).replace("{ICONS}", ICONS));
    Ok(out.join("\n"))
}

/// How a team works and what `team_create` takes. In the brief's answer rather than in the tools'
/// descriptions: only a turn that designs a team pays for it.
const GUIDE: &str = r#"HOW A TEAM WORKS
- A team is seats. A seat is filled by a roster agent — the provider, model, effort and standing prompt are the agent's — and adds what the seat is for in this team (role), whether it may write, in which repositories, and whom it answers to.
- The user launches the team with a goal and the repositories. The lead plans the goal into tasks and gives each to a seat by reading the roles; tasks run in parallel, each in its own worktree; the app runs the checks, the reviewer (if any) reads each task that writes, the work is integrated, and the user approves where the policy says so.
- The lead plans and delegates; it takes tasks itself only with hands_on. A team of one is a lead with hands_on.
- leads: true makes a seat a sub-lead: it plans inside its own branch (the seats that report to it). Worth it from about six seats.
- advisor: true — at most one, never given work, read-only: it reads the lead's plan and the result and says what was missed.
- A reviewer is a seat named in "review". It should be read-only, on a provider that enforces read-only, and best on another model than the authors.
- With no lead the team runs a fixed "plan" — the same steps every time. For a routine, not for goals.

WHAT MAKES A TEAM GOOD — hold the design to this
1. Look before you design: project_map, the README and each repository's own rules. A team is for THIS workspace; a generic one is a failure.
2. The smallest team that covers the need — usually 2 to 5 seats. Every seat has a reason you can state from the code. No seat "just in case".
3. One seat per part that changes on its own (a repository, a layer, a concern such as tests or migrations), scoped with "repos". Two seats writing the same files collide.
4. Reuse a roster agent that fits ("agent"); make one ("new_agent") only when none does. Never two agents for one job.
5. A new agent's prompt is its standing instructions for every task, in the user's language, at least {MIN_PROMPT} characters: who it is; the stack and the real paths it owns here; the conventions it follows (from the repository's own rules); how it verifies its work — the real commands; what it must not touch; what done means. Nothing about one goal: the goal arrives when the team is launched.
6. A role is one sentence the lead can route by, at least {MIN_ROLE} characters: what the seat owns and what it is asked for.
7. The strongest model on the lead and the reviewer; a faster one on mechanical seats. Only providers and models listed above.
8. Checks come from the suites found above: unit and lint after every task (item), the slow ones once at the end (final), what needs a browser or a running service left to the members (agent). Leave "checks" out and each repository's suites are detected when a run starts.
9. Leave the policy alone unless the need says otherwise, and say why you changed what you changed.
10. dry_run first when unsure; fix every problem it returns in one go. Then tell the user what you built and why each seat exists, in their language. The user launches it from Agentes › Equipos.

team_create — THE SPEC
{
  "name": "…",                     // unique in the workspace
  "description": "…",              // what it is for and when to use it
  "lead": "lead",                  // a seat's key
  "members": [{
    "key": "lead",                 // your handle for the seat, used in lead / reports_to / review
    "name": "…",                   // the seat's name in the team; the agent's when left out
    "role": "…",                   // rule 6
    "agent": "an agent's name",    // one of the roster — OR:
    "new_agent": {"name": "…", "provider": "…", "model": "…", "effort": "low|medium|high|max", "prompt": "…", "role": "a short label", "icon": "…", "color": "…"},
    "edits": true,                 // false: read-only (a reviewer, an analyst)
    "repos": ["a repository's name"],   // where it may work; left out: everywhere
    "reports_to": "key",           // left out: the lead
    "hands_on": false, "leads": false, "advisor": false,
    "escalate_to": "key",          // who takes a task this seat failed
    "max_parallel": 1              // tasks it takes at once
  }],
  "checks": [{"repo": "name or *", "command": "…", "kind": "unit|integration|e2e|lint|other", "when": "item|final|agent", "label": "…", "write": true}],   // write: members add tests of this kind for what they change
  "review": {"reviewer": "key", "of": ["keys; left out: everyone who writes"], "exigence": "correct|polished", "laps": 2},
  "policy": {…},                   // only what differs from the defaults below
  "plan": [{"key": "a", "member": "key", "kind": "work|investigate", "title": "…", "instruction": "…", "repo": "name, * or left out", "depends_on": ["keys"]}],   // only with no lead
  "update": "an existing team's name",   // replaces its seats, lead, plan and review; policy fields and checks you leave out are kept
  "dry_run": true                  // check and preview, create nothing
}
icon, one of: {ICONS}. color, one of: {COLORS}. Both may be left out.

POLICY — field: values (default)
- approve_plan: the lead's plan waits for the user (true)
- approve_code: never | first | each — the user approves the code of tasks that write (never)
- approve_merge: integrating waits for the user (true)
- integrate: merge into the target branch | branch (leave it on one) | pr (open a pull request) (merge); pr_draft (true); push (false)
- commit: item (one per task) | squash (one per repository) | none (item); commit_style: conventional | free (conventional)
- single_pass: each agent works once — one plan, one attempt per task, no review laps, no last look (true). Turned off for you when the team has a review or an advisor.
- max_parallel: tasks at once, 1–8 (3); max_attempts: tries per task, 1–6 (3); lead_rounds: planning rounds (3); lead_final_check: the lead's last look (true)
- questions: allow | plan | never — who may ask the user (allow); escalate_questions: a seat asks its manager first (false)
- comms: open | tree | tree_siblings — who may message whom (open)
- dod: off | warn | block — what done asks for beyond the member's word (warn)
- baseline_failures: ignore | fix — a test that already failed before the change (ignore)
- sandbox: off | checks — the app runs the checks in a container (set for you from this computer)
- guarantees: off | warn | block — what a run does about a seat whose provider cannot be held to what it needs (warn)
- conflicts: author | user | a seat's key — who resolves merge conflicts (author)
- impact_approval (false) with impact_paths: ["src/payments/**"] — changes there wait for the user
- budget_usd, budget_tokens, budget_minutes: caps for a whole run, 0 none (0); turn_minutes: one turn's limit (30); max_session_pct: share of a plan's window one run may use (30)
- auto_checks: detect each repository's suites when none are listed (true); cleanup: remove the worktrees after integrating (true)"#;

// ---------------------------------------------------------------- the tools

// ---------------------------------------------------------------- a team waiting for a yes

/// A seat of a proposed team, as the window draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatView {
    pub name: String,
    pub role: String,
    pub agent: String,
    /// The agent does not exist yet: accepting the proposal makes it.
    pub fresh: bool,
    pub provider: String,
    pub model: String,
    pub edits: bool,
    pub lead: bool,
    pub hands_on: bool,
    pub advisor: bool,
    pub sub_lead: bool,
    pub reviewer: bool,
    /// The seat it answers to, by name; empty is the lead.
    pub reports_to: String,
    /// Repository names; empty is every one.
    pub repos: Vec<String>,
    pub icon: String,
    pub color: String,
}

/// A team a turn that may not change the app designed: it waits here, in memory, for the user to
/// create it from the window — or to throw it away. Gone when the app closes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub workspace_id: String,
    pub created_at: String,
    /// Accepting it replaces a team that exists.
    pub updating: bool,
    pub team: Team,
    pub seats: Vec<SeatView>,
    /// The agents accepting it adds to the roster.
    pub agents: Vec<AgentDraft>,
    /// What the user should know before saying yes — see [`Flag`].
    pub flags: Vec<Flag>,
    #[serde(skip)]
    spec: Value,
}

/// The most that wait per workspace: an older one makes room.
const MAX_PROPOSALS: usize = 6;
static PROPOSALS: Mutex<Vec<Proposal>> = Mutex::new(Vec::new());

fn seat_views(design: &Design, projects: &[Project]) -> Vec<SeatView> {
    let team = &design.team;
    team.members
        .iter()
        .map(|m| {
            let route = design.routes.iter().find(|r| r.member_id == m.id);
            SeatView {
                name: m.name.clone(),
                role: m.role.clone(),
                agent: route.map(|r| r.agent.clone()).unwrap_or_default(),
                fresh: route.is_some_and(|r| r.fresh),
                provider: route.map(|r| r.provider.clone()).unwrap_or_default(),
                model: route.map(|r| r.model.clone()).unwrap_or_default(),
                edits: m.edits,
                lead: m.id == team.lead,
                hands_on: m.hands_on,
                advisor: m.advisor,
                sub_lead: m.leads,
                reviewer: team.policy.review.enabled && team.policy.review.reviewer == m.id,
                reports_to: team.members.iter().find(|boss| boss.id == m.reports_to).map(|boss| boss.name.clone()).unwrap_or_default(),
                repos: m.repos.iter().filter_map(|id| projects.iter().find(|p| &p.id == id)).map(|p| p.name.clone()).collect(),
                icon: route.map(|r| r.icon.clone()).unwrap_or_default(),
                color: route.map(|r| r.color.clone()).unwrap_or_default(),
            }
        })
        .collect()
}

/// Keeps `design` for the user to decide on. One that proposed the same team before is replaced.
fn propose(workspace_id: &str, spec: Value, design: &Design, projects: &[Project]) -> Proposal {
    let proposal = Proposal {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        created_at: queries::now(),
        updating: design.updating,
        team: design.team.clone(),
        seats: seat_views(design, projects),
        agents: design.agents.clone(),
        flags: design.flags.clone(),
        spec,
    };
    let mut held = PROPOSALS.lock().unwrap_or_else(|e| e.into_inner());
    held.retain(|p| !(p.workspace_id == workspace_id && same(&p.team.name, &proposal.team.name)));
    while held.iter().filter(|p| p.workspace_id == workspace_id).count() >= MAX_PROPOSALS {
        let Some(oldest) = held.iter().position(|p| p.workspace_id == workspace_id) else { break };
        held.remove(oldest);
    }
    held.push(proposal.clone());
    proposal
}

/// The teams waiting for a yes in `workspace_id`, newest first.
pub fn proposals(workspace_id: &str) -> Vec<Proposal> {
    let mut all: Vec<Proposal> = PROPOSALS.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|p| p.workspace_id == workspace_id).cloned().collect();
    all.reverse();
    all
}

/// Throws a proposal away. `None` when it was already gone.
pub fn dismiss(id: &str) -> Option<Proposal> {
    let mut held = PROPOSALS.lock().unwrap_or_else(|e| e.into_inner());
    let at = held.iter().position(|p| p.id == id)?;
    let gone = held.remove(at);
    drop(held);
    if let Some(app) = crate::ai_usage::app() {
        let _ = app.emit("crew:team-proposals", json!({ "workspaceId": gone.workspace_id }));
    }
    Some(gone)
}

/// The user's yes: the proposal is checked again against the workspace as it is now — an agent
/// may have been renamed, a repository removed — and made.
pub async fn accept(id: &str) -> Result<Team, String> {
    let proposal = PROPOSALS.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|p| p.id == id).cloned().ok_or("Esa propuesta ya no está.")?;
    let spec: Spec = serde_json::from_value(proposal.spec.clone()).map_err(|e| e.to_string())?;
    let known = known().await;
    let (design, made) = crate::ai_usage::with_conn(|conn| {
        let design = design(conn, &proposal.workspace_id, &spec, &known).map_err(|problems| format!("La propuesta ya no encaja con el workspace:\n{}", problems.join("\n")))?;
        let made = commit(conn, &design)?;
        Ok::<_, String>((design, made))
    })
    .ok_or("CodeFlow no está listo todavía.")??;
    dismiss(id);
    announce(&made, design.updating, false);
    Ok(made.team)
}

/// Tells every window what was made. `by_chat`: a chat made it by itself, so the user is told —
/// a team they accepted themselves needs no notice.
fn announce(made: &Made, updating: bool, by_chat: bool) {
    let Some(app) = crate::ai_usage::app() else { return };
    if !made.agents.is_empty() {
        let _ = app.emit("crew:roster", json!({ "workspaceId": made.team.workspace_id }));
    }
    let _ = app.emit("crew:team-imported", &made.team);
    if by_chat {
        let _ = app.emit("crew:team-designed", json!({ "team": made.team, "updated": updating, "newAgents": made.agents.len() }));
    }
}

// ---------------------------------------------------------------- the tools

/// Where a call comes from.
pub struct Scope {
    pub workspace_id: Option<String>,
    pub project: Option<Project>,
    pub acts: bool,
}

/// `team_brief` and `team_create`, as the map server calls them.
pub async fn call(scope: &Scope, name: &str, args: &Value) -> Result<String, String> {
    let Some(workspace_id) = scope.workspace_id.clone() else {
        return Err("this chat is not in a workspace of CodeFlow, so there is nowhere to keep a team".into());
    };
    let known = known().await;
    if name == BRIEF_TOOL {
        return crate::ai_usage::with_conn(|conn| brief(conn, &workspace_id, scope.project.as_ref(), &known)).unwrap_or_else(|| Err("CodeFlow is not ready yet".into()));
    }
    let spec: Spec = serde_json::from_value(args.clone()).map_err(|why| format!("The definition could not be read: {why}. team_brief has the spec."))?;
    let preview = spec.dry_run || !scope.acts;
    let outcome = crate::ai_usage::with_conn(|conn| -> Result<(Design, Option<Made>, Vec<Project>), Vec<String>> {
        let design = design(conn, &workspace_id, &spec, &known)?;
        let projects = queries::list_projects(conn, &workspace_id).unwrap_or_default();
        if preview {
            return Ok((design, None, projects));
        }
        let made = commit(conn, &design).map_err(|why| vec![why])?;
        Ok((design, Some(made), projects))
    });
    let (design, made, projects) = match outcome {
        None => return Err("CodeFlow is not ready yet".into()),
        Some(Err(problems)) => {
            return Err(format!(
                "Nothing was created. {} to fix — send the whole definition again with all of them fixed:\n{}",
                if problems.len() == 1 { "One problem".to_string() } else { format!("{} problems", problems.len()) },
                problems.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n")
            ));
        }
        Some(Ok(done)) => done,
    };
    let fit = quality(&design, &projects);
    let body = format!("{}\n\n{}", describe(&design, &projects), quality_text(&fit, made.is_some()));
    let agents = if design.agents.is_empty() { "no new agents".to_string() } else { format!("{} new agents ({})", design.agents.len(), quoted(design.agents.iter().map(|a| &a.name), 8)) };
    let Some(made) = made else {
        if spec.dry_run {
            return Ok(format!("dry_run: nothing was created. The definition is sound; creating it would make {agents} and {} the team.\n\n{body}", if design.updating { "replace" } else { "add" }));
        }
        // A turn that may not change the app: the team waits for the user's own yes.
        let mut asked = args.clone();
        if let Some(fields) = asked.as_object_mut() {
            fields.remove("dry_run");
        }
        let proposal = propose(&workspace_id, asked, &design, &projects);
        if let Some(app) = crate::ai_usage::app() {
            let _ = app.emit("crew:team-proposals", json!({ "workspaceId": workspace_id }));
            let _ = app.emit("crew:team-proposed", json!({ "id": proposal.id, "workspaceId": workspace_id, "name": proposal.team.name, "seats": proposal.seats.len(), "newAgents": proposal.agents.len(), "updating": proposal.updating }));
        }
        return Ok(format!(
            "This turn may not change the app, so the team was not created: it is waiting in the window as a proposal, and the user creates it with one click (a notice, and Agentes › Equipos). Tell them it is there, what it is, and why each seat exists. Accepting it would make {agents}.\n\n{body}"
        ));
    };
    announce(&made, design.updating, true);
    Ok(format!(
        "{} in this workspace{}. Nothing runs until the user launches it from Agentes › Equipos — tell them what you built and why each seat is there.\n\n{body}",
        if design.updating { "Team updated" } else { "Team created" },
        if made.agents.is_empty() { String::new() } else { format!(", with {} new agents in the roster ({})", made.agents.len(), quoted(made.agents.iter().map(|a| &a.name), 8)) },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known_here() -> Known {
        let provider = |id: &str, ready: bool, models: &[&str], read_only: bool, metered: bool| Provider {
            id: id.into(),
            label: id.into(),
            ready,
            models: models.iter().map(|m| m.to_string()).collect(),
            read_only,
            metered,
            loop_guard: false,
            pending: false,
        };
        Known {
            providers: vec![
                provider("claude", true, &[], true, true),
                provider("codex", true, &["gpt-5.5", "gpt-5.6-sol"], true, true),
                provider("grok", true, &["grok-4"], false, false),
                provider("gemini", false, &[], true, true),
            ],
            sandbox: Some("docker".into()),
            sandbox_problem: String::new(),
        }
    }

    /// A workspace with two repositories — one with a Node manifest — and one agent in the roster.
    fn workspace() -> (Connection, String, tempdir::Dir) {
        let dir = tempdir::Dir::new();
        std::fs::create_dir_all(dir.0.join("web")).unwrap();
        std::fs::create_dir_all(dir.0.join("api")).unwrap();
        std::fs::write(
            dir.0.join("web/package.json"),
            r#"{"scripts":{"test":"vitest run","lint":"eslint ."},"dependencies":{"react":"19"},"devDependencies":{"typescript":"5","vite":"6","vitest":"2"}}"#,
        )
        .unwrap();
        std::fs::write(dir.0.join("api/go.mod"), "module api\n").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = queries::create_workspace(&conn, "Tienda", "folder", "#fff").unwrap();
        for name in ["web", "api"] {
            let project: crate::db::models::NewProject = serde_json::from_value(json!({
                "workspace_id": ws.id, "name": name, "local_path": dir.0.join(name).to_string_lossy(), "remote_url": null, "color": "#fff", "icon": "folder"
            }))
            .unwrap();
            queries::create_project(&conn, project).unwrap();
        }
        queries::upsert_workspace_agent(&conn, None, &ws.id, "Arquitecta", "Diseña y reparte", "claude", "opus", "Eres la arquitecta.", true, None).unwrap();
        (conn, ws.id, dir)
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!("cf-designer-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn prompt(about: &str) -> String {
        format!(
            "Eres el responsable de {about} en la tienda. Trabajas solo dentro de tu carpeta y sigues las convenciones del repositorio: nombres en inglés, \
             funciones pequeñas, sin dependencias nuevas sin avisar. Antes de dar una tarea por hecha corres las pruebas y el lint del repositorio y pegas su \
             salida como evidencia. No tocas la configuración de despliegue ni los archivos de otro equipo. Hecho significa: pruebas en verde, cambios \
             mínimos y una nota de qué cambiaste y por qué."
        )
    }

    fn sound() -> Value {
        json!({
            "name": "Tienda web",
            "description": "Cambios de la tienda que tocan el front en React y la API en Go a la vez.",
            "lead": "lead",
            "members": [
                {"key": "lead", "name": "Líder", "role": "Planifica el objetivo y reparte entre front y API", "agent": "Arquitecta"},
                {"key": "front", "name": "Front", "role": "Dueño de web/: componentes React, estilos y sus pruebas con Vitest", "repos": ["web"],
                 "new_agent": {"name": "Front React", "provider": "claude", "model": "sonnet", "effort": "medium", "prompt": prompt("la interfaz en React"), "color": "teal", "icon": "monitor-smartphone"}},
                {"key": "api", "name": "API", "role": "Dueño de api/: handlers en Go, contratos y pruebas con go test", "repos": ["api"],
                 "new_agent": {"name": "API Go", "provider": "codex", "model": "gpt-5.5", "prompt": prompt("la API en Go")}},
                {"key": "qa", "name": "Revisor", "role": "Lee cada cambio buscando regresiones y contratos rotos entre front y API", "edits": false,
                 "new_agent": {"name": "Revisor", "provider": "claude", "model": "opus", "prompt": prompt("la revisión de cambios")}}
            ],
            "checks": [
                {"repo": "web", "command": "npm test", "kind": "unit", "write": true},
                {"repo": "web", "command": "npm run lint", "kind": "lint"},
                {"repo": "api", "command": "go test ./...", "kind": "unit"}
            ],
            "review": {"reviewer": "qa", "exigence": "polished"},
            "policy": {"integrate": "pr", "max_parallel": 2}
        })
    }

    fn spec(value: Value) -> Spec {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_model_cannot_design_a_team_with_full_permissions() {
        let (conn, ws, _dir) = workspace();
        let mut asked = sound();
        asked["policy"]["permissions"] = json!("full");
        let problems = design(&conn, &ws, &spec(asked), &known_here()).unwrap_err();
        assert!(problems.iter().any(|p| p.starts_with("policy.permissions:")), "{problems:?}");
        let made = design(&conn, &ws, &spec(sound()), &known_here()).unwrap();
        assert!(!made.team.policy.full_access());
    }

    #[test]
    fn a_sound_definition_becomes_a_team_that_can_run_with_the_agents_it_needed() {
        let (conn, ws, _dir) = workspace();
        let design = design(&conn, &ws, &spec(sound()), &known_here()).unwrap();
        assert_eq!(design.agents.len(), 3, "the lead reuses the roster's agent");
        assert!(design.agents.iter().all(|a| a.enabled && a.workspace_id == ws));
        assert!(!design.agents.iter().find(|a| a.name == "Revisor").unwrap().edits, "a read-only seat makes a read-only agent");

        let made = commit(&conn, &design).unwrap();
        let team = super::super::get_team(&conn, &made.team.id).unwrap().unwrap();
        super::super::runnable(&team).unwrap();
        let roster = queries::list_workspace_agents(&conn, &ws).unwrap();
        assert_eq!(roster.len(), 4);
        // Every seat is a real roster agent with what a run needs of it.
        for member in &team.members {
            let agent = roster.iter().find(|a| a.id == member.agent_id).unwrap_or_else(|| panic!("{} has no agent", member.name));
            assert!(!agent.provider.is_empty() && !agent.model.is_empty());
        }
        let lead = team.members.iter().find(|m| m.id == team.lead).unwrap();
        assert_eq!(lead.name, "Líder");
        // Seats answer to the lead by default, and are scoped to the repository they named.
        let projects = queries::list_projects(&conn, &ws).unwrap();
        let web = projects.iter().find(|p| p.name == "web").unwrap();
        let front = team.members.iter().find(|m| m.name == "Front").unwrap();
        assert_eq!((front.reports_to.as_str(), front.repos.clone()), ("", vec![web.id.clone()]));
        // The checks name repositories by id and take their kind's usual moment.
        assert_eq!(team.policy.checks.iter().map(|c| (c.command.as_str(), c.when.as_str(), c.repo == web.id)).collect::<Vec<_>>(), vec![("npm test", "item", true), ("npm run lint", "item", true), ("go test ./...", "item", false)]);
        // Review is on, by the seat — and one pass per agent, which would skip it, is off.
        let reviewer = team.members.iter().find(|m| m.name == "Revisor").unwrap();
        assert!(team.policy.review.enabled && team.policy.review.reviewer == reviewer.id && !reviewer.edits);
        assert!(!team.policy.single_pass);
        assert_eq!((team.policy.integrate.as_str(), team.policy.max_parallel, team.policy.sandbox.as_str()), ("pr", 2, "checks"));
    }

    #[test]
    fn every_problem_comes_back_at_once_and_nothing_is_made() {
        let (conn, ws, _dir) = workspace();
        let mut bad = sound();
        bad["members"][1]["new_agent"]["prompt"] = json!("Haz el front.");
        bad["members"][1]["repos"] = json!(["mobile"]);
        bad["members"][2]["new_agent"]["model"] = json!("gpt-9");
        bad["members"][3]["new_agent"]["provider"] = json!("gemini");
        bad["members"][0]["role"] = json!("Lidera");
        bad["review"]["reviewer"] = json!("nadie");
        bad["policy"]["integrate"] = json!("rebase");
        bad["policy"]["velocidad"] = json!(3);
        let problems = design(&conn, &ws, &spec(bad), &known_here()).unwrap_err();
        let has = |needle: &str| problems.iter().any(|p| p.contains(needle));
        assert!(has("members[1].new_agent.prompt") && has("too thin"), "{problems:#?}");
        assert!(has("«mobile» is not a repository") && has("«web», «api»"), "{problems:#?}");
        assert!(has("codex does not list «gpt-9»") && has("gpt-5.5"), "{problems:#?}");
        assert!(has("gemini is not installed") && has("claude, codex, grok"), "{problems:#?}");
        assert!(has("members[0].role"), "{problems:#?}");
        assert!(has("review.reviewer: «nadie»"), "{problems:#?}");
        assert!(has("policy.integrate") && has("merge, branch, pr"), "{problems:#?}");
        assert!(has("policy.velocidad: not a policy field"), "{problems:#?}");
        assert_eq!(queries::list_workspace_agents(&conn, &ws).unwrap().len(), 1);
        assert!(super::super::list_teams(&conn, &ws).unwrap().is_empty());
    }

    #[test]
    fn a_team_needs_someone_to_lead_and_a_lead_needs_someone_to_hand_work_to() {
        let (conn, ws, _dir) = workspace();
        let one = |extra: Value| {
            let mut value = json!({
                "name": "Solo", "description": "Una sola persona para arreglos pequeños del front.",
                "members": [{"key": "dev", "role": "Hace arreglos pequeños en cualquier parte del código", "agent": "Arquitecta"}]
            });
            for (key, v) in extra.as_object().unwrap() {
                if key == "hands_on" { value["members"][0][key] = v.clone() } else { value[key] = v.clone() }
            }
            design(&conn, &ws, &spec(value), &known_here())
        };
        assert!(one(json!({})).unwrap_err().iter().any(|p| p.starts_with("lead: say which seat leads")));
        assert!(one(json!({"lead": "dev"})).unwrap_err().iter().any(|p| p.contains("nobody to hand work to")));
        let solo = one(json!({"lead": "dev", "hands_on": true})).unwrap();
        assert!(solo.team.members[0].hands_on && solo.team.lead == solo.team.members[0].id);
        // A fixed plan is the other way to have no one to plan — and never both.
        let fixed = one(json!({"plan": [{"member": "dev", "instruction": "Actualiza las dependencias y corre las pruebas"}]})).unwrap();
        assert!(fixed.team.lead.is_empty() && fixed.team.plan.len() == 1);
        assert!(one(json!({"lead": "dev", "hands_on": true, "plan": [{"member": "dev", "instruction": "x"}]})).unwrap_err().iter().any(|p| p.starts_with("plan:")));
    }

    #[test]
    fn the_user_hears_what_a_provider_cannot_be_held_to() {
        let (conn, ws, _dir) = workspace();
        let mut value = sound();
        value["members"][3]["new_agent"]["provider"] = json!("grok");
        value["members"][3]["new_agent"]["model"] = json!("grok-4");
        value["policy"]["unmetered_minutes"] = json!(0);
        let design = design(&conn, &ws, &spec(value), &known_here()).unwrap();
        assert!(design.warnings.iter().any(|w| w.contains("«Revisor» must not write") && w.contains("does not enforce read-only")), "{:#?}", design.warnings);
        assert!(design.warnings.iter().any(|w| w.contains("publishes no consumption")), "{:#?}", design.warnings);
        // The same, for the window to say in the user's language.
        assert_eq!(design.flags, vec![flag("read_only_unenforced", "Revisor", "grok"), flag("unmetered", "Revisor", "grok")]);
    }

    #[test]
    fn a_name_that_is_taken_is_refused_and_update_replaces_that_team_in_place() {
        let (conn, ws, _dir) = workspace();
        let first = commit(&conn, &design(&conn, &ws, &spec(sound()), &known_here()).unwrap()).unwrap();
        // The agents exist now: the same definition would make them twice.
        let again = design(&conn, &ws, &spec(sound()), &known_here()).unwrap_err();
        assert!(again.iter().any(|p| p.contains("already a team «Tienda web»")), "{again:#?}");
        assert!(again.iter().any(|p| p.contains("roster already has an agent «Front React»")), "{again:#?}");

        let mut next = sound();
        next["update"] = json!("tienda web");
        for (at, name) in [(1, "Front React"), (2, "API Go"), (3, "Revisor")] {
            next["members"][at].as_object_mut().unwrap().remove("new_agent");
            next["members"][at]["agent"] = json!(name);
        }
        next["members"].as_array_mut().unwrap().truncate(3);
        next.as_object_mut().unwrap().remove("review");
        next.as_object_mut().unwrap().remove("checks");
        next["policy"] = json!({"max_parallel": 4});
        let design = design(&conn, &ws, &spec(next), &known_here()).unwrap();
        assert!(design.updating && design.agents.is_empty());
        let made = commit(&conn, &design).unwrap();
        assert_eq!(made.team.id, first.team.id);
        assert_eq!(super::super::list_teams(&conn, &ws).unwrap().len(), 1);
        // Seats and review are what was sent; the policy fields and checks left out are kept.
        assert_eq!(made.team.members.len(), 3);
        assert!(!made.team.policy.review.enabled);
        assert_eq!((made.team.policy.integrate.as_str(), made.team.policy.max_parallel, made.team.policy.checks.len()), ("pr", 4, 3));
    }

    #[test]
    fn the_brief_says_what_the_workspace_has_and_how_to_ask_for_a_team() {
        let (conn, ws, _dir) = workspace();
        let text = brief(&conn, &ws, None, &known_here()).unwrap();
        assert!(text.contains("WORKSPACE «Tienda»"));
        assert!(text.contains("- web — TypeScript, React, Vite, Vitest"), "{text}");
        assert!(text.contains("`npm test` (unit, item)") && text.contains("`npm run lint` (lint, item)"), "{text}");
        assert!(text.contains("- api — Go") && text.contains("`go test ./...`"), "{text}");
        assert!(text.contains("«Arquitecta» — Diseña y reparte — claude/opus"), "{text}");
        // Claude lists nothing: its tier names and what the roster runs on stand in.
        assert!(text.contains("- claude (claude) — models: opus, sonnet, haiku"), "{text}");
        assert!(text.contains("- codex (codex) — models: gpt-5.5, gpt-5.6-sol"), "{text}");
        assert!(text.contains("Not ready here (do not use): gemini."), "{text}");
        assert!(text.contains("Isolated checks: available (docker)"));
        assert!(text.contains("team_create — THE SPEC") && text.contains(&format!("at least {MIN_PROMPT} characters")));
        assert!(!text.contains("{MIN_") && !text.contains("{COLORS}") && !text.contains("{ICONS}"));
    }

    /// What the tool saves is what the engine starts: the lead gets the goal to plan.
    #[tokio::test]
    async fn a_team_made_from_a_chat_starts_a_run() {
        use crate::team::engine::{start_run, with, RepoPick};
        let (_serial, _dir, db, ws, project, _) = crate::team::engine::tests::fixture();
        let made = with(&db, |c| {
            let definition = spec(json!({
                "name": "Mantenimiento",
                "description": "Arreglos pequeños del repositorio web, con un líder que reparte.",
                "lead": "l",
                "members": [
                    {"key": "l", "role": "Planifica cada objetivo y lo reparte al desarrollador", "agent": "Líder", "edits": false},
                    {"key": "d", "role": "Hace los cambios en el código y corre sus pruebas", "agent": "Dev", "repos": ["web"]}
                ],
                "policy": {"sandbox": "off"}
            }));
            let design = design(c, &ws, &definition, &known_here()).map_err(|problems| problems.join("\n"))?;
            commit(c, &design)
        })
        .unwrap();
        let state = start_run(&db, ws, made.team.id.clone(), "Corrige el título del README".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
        assert_eq!(state.run.status, "running");
        let lead = made.team.members.iter().find(|m| m.id == made.team.lead).unwrap();
        assert_eq!(state.items.iter().map(|i| (i.kind.as_str(), i.member_id.as_str())).collect::<Vec<_>>(), vec![("plan", lead.id.as_str())]);
        assert_eq!(state.run.members.len(), 2);
    }

    /// The guide names the policy's fields by hand: one that is renamed or dropped must not stay
    /// there as advice to send a field the tool refuses.
    #[test]
    fn the_guide_only_names_policy_fields_that_exist() {
        let fields = serde_json::to_value(Policy::default()).unwrap();
        let fields = fields.as_object().unwrap();
        let policy = GUIDE.split("POLICY — field").nth(1).unwrap();
        for line in policy.lines().filter(|l| l.starts_with("- ")) {
            let name = line[2..].split(':').next().unwrap().split(' ').next().unwrap().trim_end_matches(',');
            assert!(fields.contains_key(name), "the guide names policy.{name}, which is not a field");
        }
        for (name, _) in CHOICES {
            assert!(fields.contains_key(*name), "{name}");
        }
    }

    /// The fit says what the checks cannot refuse: a prompt that could be for any project, two
    /// seats for one job, several writers and nobody reading.
    #[test]
    fn a_check_that_never_ends_is_told_apart_from_one_that_does() {
        for endless in ["pnpm tauri dev", "npm run dev", "cd web && pnpm vitest --watch", "yarn start", "nodemon src/index.ts", "pnpm test && pnpm dev"] {
            assert!(never_ends(endless), "{endless}");
        }
        for ends in ["pnpm test", "cd src-tauri && cargo test --lib", "pnpm exec tsc --noEmit", "cd dev && go test ./...", "node scripts/check-translations.mjs", "pnpm build", "pnpm vitest run --watch=false"] {
            assert!(!never_ends(ends), "{ends}");
        }

        let (conn, ws, _dir) = workspace();
        let projects = queries::list_projects(&conn, &ws).unwrap();
        let fine = quality(&design(&conn, &ws, &spec(sound()), &known_here()).unwrap(), &projects);
        let mut held = sound();
        held["checks"] = json!([{ "repo": "*", "command": "npm run dev", "kind": "e2e", "when": "agent" }]);
        let held = quality(&design(&conn, &ws, &spec(held), &known_here()).unwrap(), &projects);
        assert!(held.findings.iter().any(|f| f.contains("`npm run dev`") && f.contains("keeps running")), "{:#?}", held.findings);
        assert!(!fine.findings.iter().any(|f| f.contains("keeps running")), "{:#?}", fine.findings);
    }

    #[test]
    fn the_fit_tells_a_team_made_for_this_workspace_from_one_made_for_any() {
        let (conn, ws, _dir) = workspace();
        std::fs::create_dir_all(_dir.0.join("web/src/components")).unwrap();
        std::fs::create_dir_all(_dir.0.join("api/internal/handlers")).unwrap();
        let projects = queries::list_projects(&conn, &ws).unwrap();
        let mut fitted = sound();
        fitted["members"][1]["new_agent"]["prompt"] = json!(
            "Eres quien mantiene la interfaz de la tienda: los componentes de src/components, en React con TypeScript, y lo que package.json declara. \
             Escribes componentes pequeños, sin estado global nuevo, y cada cambio visible lleva su prueba con Vitest. Antes de dar una tarea por hecha \
             corres `npm test` y `npm run lint` y pegas la salida. No tocas la API ni el despliegue. Hecho: pruebas en verde y una nota de lo que cambió."
        );
        fitted["members"][2]["new_agent"]["prompt"] = json!(
            "Llevas el servicio en Go: los handlers de internal/handlers y las dependencias de go.mod. Cada endpoint valida su entrada, devuelve errores \
             con código y mensaje, y tiene una prueba de tabla. Verificas con `go test ./...` y dejas el resultado como evidencia. Un cambio de contrato \
             se avisa al líder antes de escribirlo. Jamás editas el front. Terminado quiere decir compilando, probado y con el contrato documentado."
        );
        fitted["members"][3]["new_agent"]["prompt"] = json!(
            "Revisas lo que otros escribieron en la tienda, tanto la parte en React como la de Go, sin modificar nada. Buscas regresiones, contratos \
             rotos entre front y API, casos borde y pruebas que faltan; miras si `npm test` cubre el cambio. Devuelves hallazgos con archivo y línea, \
             de más grave a menos, y dices si se puede integrar. Si algo es cuestión de gusto, lo marcas como sugerencia y no bloqueas por ello."
        );
        let good = quality(&design(&conn, &ws, &spec(fitted), &known_here()).unwrap(), &projects);
        assert!(good.score >= 90, "{good:#?}");

        // The same team with prompts and roles that name nothing of the workspace, the two
        // developers doing one job everywhere, and nobody reviewing.
        let mut generic = sound();
        for at in [1, 2] {
            generic["members"][at]["role"] = json!("Desarrollador que implementa las tareas que le asigna el líder");
            generic["members"][at].as_object_mut().unwrap().remove("repos");
        }
        generic["members"][3]["role"] = json!("Desarrollador que implementa las tareas que le asigna el líder");
        generic["members"][3]["edits"] = json!(true);
        generic.as_object_mut().unwrap().remove("review");
        let poor = quality(&design(&conn, &ws, &spec(generic), &known_here()).unwrap(), &projects);
        assert!(poor.score <= 45, "{poor:#?}");
        let says = |needle: &str| poor.findings.iter().any(|f| f.contains(needle));
        assert!(says("names no folder or file that exists"), "{poor:#?}");
        assert!(says("does not name the command it verifies"), "{poor:#?}");
        assert!(says("have the same job"), "{poor:#?}");
        assert!(says("may write in every repository"), "{poor:#?}");
        assert!(says("nobody reads their work"), "{poor:#?}");
        assert!(says("does not say what part of the code it owns"), "{poor:#?}");
        // «Go» is a word, not three letters of «Django»; a path is one that exists.
        assert!(names("handlers en Go.", "Go") && !names("un proyecto Django", "Go"));
        assert_eq!(real_paths("toca `src/components`, package.json y src/inventado/x.ts.", &[_dir.0.join("web").as_path()]), 2);
    }

    /// A call never waits on a CLI it has already heard from: an old listing is used and asked
    /// for again behind it. Only one that was never listed is worth a moment's wait.
    #[test]
    fn only_a_cli_never_listed_makes_a_call_wait() {
        let ready = vec!["claude".to_string(), "codex".to_string()];
        let listing = |at: u64, ids: &[&str]| Listing { at, models: ids.iter().map(|id| (id.to_string(), vec!["m".to_string()])).collect() };
        let now = 10_000;
        assert_eq!(listing_needs(None, &ready, now), (true, true), "first time ever");
        assert_eq!(listing_needs(Some(&listing(now - 30, &["claude", "codex"])), &ready, now), (false, false), "fresh");
        assert_eq!(listing_needs(Some(&listing(now - LISTING_FRESH_SECS - 1, &["claude", "codex"])), &ready, now), (true, false), "old: refreshed behind the call");
        assert_eq!(listing_needs(Some(&listing(now - 30, &["claude"])), &ready, now), (true, true), "a CLI installed since");
        assert_eq!(listing_needs(None, &[], now), (true, false), "nothing to list, nothing to wait for");
        // What was listed survives the app closing: it is what the setting holds.
        let saved = serde_json::to_string(&listing(now, &["codex"])).unwrap();
        assert_eq!(serde_json::from_str::<Listing>(&saved).unwrap().models["codex"], vec!["m".to_string()]);
    }

    /// A design from a turn that may not act waits for the user, drawn seat by seat; proposing
    /// the same team again replaces it, and throwing it away leaves nothing.
    #[test]
    fn a_proposed_team_waits_as_the_window_draws_it() {
        let (conn, ws, _dir) = workspace();
        let projects = queries::list_projects(&conn, &ws).unwrap();
        let design = design(&conn, &ws, &spec(sound()), &known_here()).unwrap();
        let first = propose(&ws, sound(), &design, &projects);
        let again = propose(&ws, sound(), &design, &projects);
        let waiting = proposals(&ws);
        assert_eq!(waiting.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec![again.id.as_str()], "{} was replaced", first.id);
        let seen = serde_json::to_value(&waiting[0]).unwrap();
        assert!(seen.get("spec").is_none(), "what the model sent stays here");
        assert_eq!(seen["team"]["name"], "Tienda web");
        assert_eq!(seen["agents"].as_array().unwrap().len(), 3);
        let seat = |name: &str| seen["seats"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
        assert_eq!((seat("Líder")["lead"].clone(), seat("Líder")["fresh"].clone(), seat("Líder")["agent"].clone()), (json!(true), json!(false), json!("Arquitecta")));
        assert_eq!((seat("Front")["fresh"].clone(), seat("Front")["repos"].clone(), seat("Front")["color"].clone()), (json!(true), json!(["web"]), json!("teal")));
        assert_eq!((seat("Revisor")["reviewer"].clone(), seat("Revisor")["edits"].clone(), seat("Revisor")["provider"].clone()), (json!(true), json!(false), json!("claude")));
        // Nothing was made by proposing.
        assert!(super::super::list_teams(&conn, &ws).unwrap().is_empty());
        assert_eq!(queries::list_workspace_agents(&conn, &ws).unwrap().len(), 1);
        assert!(dismiss(&again.id).is_some() && dismiss(&again.id).is_none());
        assert!(proposals(&ws).is_empty());
    }

    // ---- measuring what a real model makes of all this
    //
    // Two steps, both off by default. `CODEFLOW_TEAM_EVAL_REPOS` (paths, comma-separated) prints
    // the brief a model would get for those repositories, and the two tools' definitions; hand
    // that and a request to a model, save each definition it would send to `team_create` as a
    // `.json` in a folder, and `CODEFLOW_TEAM_EVAL_SPECS` (that folder) says for each whether it
    // would have been created, what was wrong with it, and how it scores.

    fn eval_known() -> Known {
        let provider = |id: &str, label: &str, ready: bool, models: &[&str], read_only: bool, metered: bool| Provider {
            id: id.into(), label: label.into(), ready, models: models.iter().map(|m| m.to_string()).collect(), read_only, metered, loop_guard: true, pending: false,
        };
        // What Codex lists on this computer, as the app reads it — a model it does not have would
        // be designed into a team no run can start. The fixed list is for a computer without it.
        let codex: Vec<String> = crate::ai::AiEngine::cached_models(&crate::codex::CodexEngine)
            .filter(|listed| !listed.is_empty())
            .unwrap_or_else(|| vec!["gpt-5.6-sol".into(), "gpt-5.6-terra".into()]);
        let codex: Vec<&str> = codex.iter().map(String::as_str).collect();
        Known {
            providers: vec![
                provider("claude", "Claude Code", true, &[], true, true),
                provider("codex", "Codex", true, &codex, true, true),
                provider("gemini", "Gemini", false, &[], true, true),
                provider("grok", "Grok", false, &[], false, false),
            ],
            sandbox: Some("OrbStack".into()),
            sandbox_problem: String::new(),
        }
    }

    fn eval_workspace(repos: &str) -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = queries::create_workspace(&conn, "Evaluación", "folder", "#fff").unwrap();
        for path in repos.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
            let project: crate::db::models::NewProject =
                serde_json::from_value(json!({ "workspace_id": ws.id, "name": name, "local_path": path, "remote_url": null, "color": "#fff", "icon": "folder" })).unwrap();
            queries::create_project(&conn, project).unwrap();
        }
        let reviewer = AgentDraft {
            workspace_id: ws.id.clone(),
            name: "Revisor de código".into(),
            role: "Revisa cambios antes de integrar".into(),
            provider: "claude".into(),
            model: "opus".into(),
            effort: "high".into(),
            prompt: "Eres un revisor de código exigente. Lees cada cambio buscando errores de lógica, regresiones, casos borde sin cubrir y pruebas que faltan. No escribes código: devuelves hallazgos concretos con archivo y línea, ordenados por gravedad, y dices con claridad si el cambio se puede integrar.".into(),
            enabled: true,
            edits: false,
            run_in: "headless".into(),
            max_parallel: 1,
            ..Default::default()
        };
        queries::save_workspace_agent(&conn, &reviewer).unwrap();
        (conn, ws.id)
    }

    #[test]
    #[ignore]
    fn eval_print_the_brief() {
        let Ok(repos) = std::env::var("CODEFLOW_TEAM_EVAL_REPOS") else { return };
        let (conn, ws) = eval_workspace(&repos);
        println!("=== TOOLS ===\n{}", serde_json::to_string_pretty(&schemas(true)).unwrap());
        println!("=== team_brief ===\n{}", brief(&conn, &ws, None, &eval_known()).unwrap());
    }

    #[test]
    #[ignore]
    fn eval_score_the_specs() {
        let (Ok(repos), Ok(folder)) = (std::env::var("CODEFLOW_TEAM_EVAL_REPOS"), std::env::var("CODEFLOW_TEAM_EVAL_SPECS")) else { return };
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&folder).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        for file in files {
            // Each on a workspace of its own: one's agents must not be another's name clash.
            let (conn, ws) = eval_workspace(&repos);
            let projects = queries::list_projects(&conn, &ws).unwrap();
            let name = file.file_stem().unwrap().to_string_lossy().into_owned();
            // As the tool reads it: a JSON value first, so a key sent twice is the last one sent.
            let parsed = std::fs::read_to_string(&file).map_err(|e| e.to_string()).and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())).and_then(|value| serde_json::from_value::<Spec>(value).map_err(|e| e.to_string()));
            let report = match parsed {
                Err(why) => json!({ "spec": name, "created": false, "problems": [format!("could not be read: {why}")] }),
                Ok(definition) => match design(&conn, &ws, &definition, &eval_known()) {
                    Err(problems) => json!({ "spec": name, "created": false, "problems": problems }),
                    Ok(design) => {
                        let fit = quality(&design, &projects);
                        json!({
                            "spec": name, "created": true, "fit": fit.score, "findings": fit.findings, "warnings": design.warnings,
                            "seats": design.team.members.len(), "new_agents": design.agents.len(),
                            "reused": design.routes.iter().filter(|r| !r.fresh).map(|r| r.agent.clone()).collect::<Vec<_>>(),
                            "models": design.routes.iter().map(|r| format!("{}/{}", r.provider, r.model)).collect::<Vec<_>>(),
                            "review": design.team.policy.review.enabled, "checks": design.team.policy.checks.iter().map(|c| c.command.clone()).collect::<Vec<_>>(),
                            "prompt_chars": design.agents.iter().map(|a| a.prompt.chars().count()).collect::<Vec<_>>(),
                        })
                    }
                },
            };
            println!("EVAL {report}");
        }
    }

    #[test]
    fn the_tools_are_short_and_a_read_only_turn_is_told_it_only_checks() {
        let acting = schemas(true);
        let reading = schemas(false);
        assert_eq!(acting.iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(), vec![BRIEF_TOOL, CREATE_TOOL]);
        assert_eq!(acting[1]["annotations"]["readOnlyHint"], false);
        assert_eq!(reading[1]["annotations"]["readOnlyHint"], true);
        assert!(reading[1]["description"].as_str().unwrap().contains("as a proposal the user creates"));
        // They ride on every turn: the spec lives in the brief, not here.
        assert!(serde_json::to_string(&acting).unwrap().len() < 2600);
    }
}
