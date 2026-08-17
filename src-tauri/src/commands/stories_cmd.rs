//! The user-stories workspace: read documentation, derive a backlog, publish it to a board.
//!
//! Three concerns meet here and are deliberately kept apart:
//!
//! - **Reading** the source. An Azure DevOps wiki through [`crate::boards::azure`]; local Markdown
//!   and pasted text arrive already gathered from the frontend (which has the file reader and the
//!   textarea), so this layer never has to know which one it was.
//! - **Deriving** the stories. One text-in/JSON-out call through [`crate::ai`], routed like every
//!   other AI action ([`AiTask::Stories`]) and cancellable like every other run.
//! - **Publishing**. One work item per story, through [`crate::boards`] so the same button reaches
//!   Azure Boards or Jira, with the story's own row recording what it became — which is what makes a
//!   second click on "publish" a no-op rather than a duplicate backlog.
//!
//! Nothing here touches a repository. A requirement is written before the code that satisfies it,
//! and the whole screen is usable in a workspace that has no project at all.

use std::collections::btree_map::Entry;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ai;
use crate::ai_locks;
use crate::boards::{self, azure, BoardAuth, BoardProvider};
use crate::commands::ado_cmd::pat_for_org;
use crate::secrets;
use crate::commands::claude_cmd::{load_ai_config, load_ai_config_for, AiTask};
use crate::commands::skills_cmd::sync_skills_into_project;
use crate::db::{
    models::{StoryBatch, StoryBatchDetail, StoryDraft},
    queries::{self, NewStoryDraft},
    Db,
};

// ---------- credentials for a board ----------

/// One saved Jira connection. The token is not here — it lives in the OS keychain, keyed by site.
#[derive(Debug, Clone, Deserialize)]
struct JiraConnection {
    site: String,
    #[serde(default)]
    email: String,
}

/// The account e-mail saved for a Jira site.
///
/// Jira Cloud authenticates `email:token`, and only the token half is a secret — so the e-mail rides
/// with the rest of the connection in `app_settings` rather than in the keychain, which is the same
/// split the Azure DevOps organisation list already uses. Matched case-insensitively and against the
/// normalised site, so a connection saved as `https://acme.atlassian.net/` still answers for `acme`.
fn jira_email(db: &State<Db>, site: &str) -> Result<String, String> {
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, "jira_connections").map_err(|e| e.to_string())?
    }
    .unwrap_or_default();
    let wanted = boards::jira::normalize_site(site);
    let saved: Vec<JiraConnection> = serde_json::from_str(&raw).unwrap_or_default();
    saved
        .into_iter()
        .find(|c| boards::jira::normalize_site(&c.site) == wanted)
        .map(|c| c.email)
        .ok_or_else(|| format!("No hay ninguna conexión de Jira guardada para \"{site}\" — conéctala en Ajustes"))
}

/// The credentials for one board, whichever product it is.
///
/// The one place that knows a PAT and an e-mail-plus-token are the same thing to a caller. Every
/// board command goes through it, so a provider added later has exactly one place to be taught how
/// it authenticates rather than one per command.
fn board_auth(db: &State<Db>, provider: BoardProvider, org: &str) -> Result<BoardAuth, String> {
    match provider {
        BoardProvider::Azure => Ok(BoardAuth::pat(pat_for_org(org)?)),
        // One API host for every customer, so the account slug is the key and nothing has to be
        // resolved from a URL. The token is the whole credential.
        BoardProvider::Monday => {
            let slug = org.trim();
            let token = secrets::get_secret(&secrets::monday_token_key(slug))?.ok_or_else(|| {
                format!("No hay ningún token de monday.com guardado para \"{org}\" — conéctalo en Ajustes")
            })?;
            Ok(BoardAuth::raw(token))
        }
        BoardProvider::Jira => {
            let site = boards::jira::normalize_site(org);
            let token = secrets::get_secret(&secrets::jira_token_key(&site))?.ok_or_else(|| {
                format!("No hay ningún token de Jira guardado para \"{org}\" — conéctalo en Ajustes")
            })?;
            Ok(BoardAuth::basic(jira_email(db, org)?, token))
        }
    }
}

/// Who a monday.com token belongs to.
///
/// The connect step, and the only command that takes a raw token as an argument: there is one API
/// host for every customer, so the token is the whole identity and the account slug it resolves to
/// is what everything afterwards is keyed by. Verifying it here means a token that cannot reach
/// monday is rejected in the settings form rather than at the first publish.
#[tauri::command]
pub async fn monday_whoami(token: String) -> Result<boards::monday::MondayAccount, String> {
    if token.trim().is_empty() {
        return Err("Falta el token de monday.com".to_string());
    }
    boards::monday::whoami(&BoardAuth::raw(token.trim())).await
}

/// The monday.com boards the saved account can see.
#[tauri::command]
pub async fn monday_list_boards(
    db: State<'_, Db>,
    slug: String,
) -> Result<Vec<boards::monday::MondayBoard>, String> {
    let auth = board_auth(&db, BoardProvider::Monday, &slug)?;
    boards::monday::list_boards(&auth).await
}

/// Which of a board's columns this app matched to a story's parts.
///
/// Surfaced to the panel on purpose. monday has no schema, so the mapping is detected by column
/// type — and a detection the user cannot see is one they cannot correct. Showing "descripción →
/// Notas" is what turns a guess into something checkable.
#[tauri::command]
pub async fn monday_board_schema(
    db: State<'_, Db>,
    slug: String,
    board_id: String,
) -> Result<boards::monday::BoardSchema, String> {
    let auth = board_auth(&db, BoardProvider::Monday, &slug)?;
    boards::monday::board_schema(&board_id, &auth).await
}

/// The Jira projects the saved account can see, for the target picker.
///
/// Azure's equivalent already exists as `ado_list_projects` on the pull-request side and is reused;
/// this is the one list Jira needed of its own, because there is nothing on the VCS side to borrow.
#[tauri::command]
pub async fn jira_list_projects(
    db: State<'_, Db>,
    site: String,
) -> Result<Vec<boards::jira::JiraProject>, String> {
    let auth = board_auth(&db, BoardProvider::Jira, &site)?;
    boards::jira::list_projects(&site, &auth).await
}

// ---------- reading the source ----------

#[tauri::command]
pub async fn ado_list_wikis(org: String, project: String) -> Result<Vec<azure::AdoWiki>, String> {
    let pat = pat_for_org(&org)?;
    azure::list_wikis(&org, &project, &pat).await
}

#[tauri::command]
pub async fn ado_list_wiki_pages(
    org: String,
    project: String,
    wiki: String,
) -> Result<Vec<azure::AdoWikiPage>, String> {
    let pat = pat_for_org(&org)?;
    azure::list_wiki_pages(&org, &project, &wiki, &pat).await
}

/// The selected pages' Markdown, concatenated under their own paths. One command rather than one
/// call per page so the picker's "use these six pages" is a single round trip.
#[tauri::command]
pub async fn ado_wiki_pages_content(
    org: String,
    project: String,
    wiki: String,
    paths: Vec<String>,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No hay páginas seleccionadas".to_string());
    }
    let pat = pat_for_org(&org)?;
    azure::get_wiki_pages_combined(&org, &project, &wiki, &paths, &pat).await
}

/// Publishes one page to a wiki the user picked.
///
/// The provider lives in the command name rather than in a parameter, matching how the rest of this
/// module addresses Azure. When a second host arrives it gets its own command and the frontend
/// dispatches on the target's `kind` — the same shape the VCS side already uses, and a cheaper
/// change than a `provider: String` that every call site would have to start passing today.
#[tauri::command]
pub async fn ado_publish_wiki_page(
    org: String,
    project: String,
    wiki: String,
    path: String,
    content: String,
) -> Result<azure::AdoWikiPageRef, String> {
    let pat = pat_for_org(&org)?;
    azure::put_wiki_page(&org, &project, &wiki, &path, &content, &pat).await
}

// ---------- the board target ----------

/// The kinds of work item the target project offers.
///
/// `provider` rather than a command per board: the picker is one control on one panel, and the two
/// hosts answer the same question with the same shape. Absent means Azure, which is what every saved
/// target meant before Jira existed here.
#[tauri::command]
pub async fn board_list_item_types(
    db: State<'_, Db>,
    provider: Option<String>,
    org: String,
    project: String,
) -> Result<Vec<boards::WorkItemType>, String> {
    let provider = BoardProvider::parse(provider.as_deref().unwrap_or_default());
    let auth = board_auth(&db, provider, &org)?;
    boards::list_work_item_types(provider, &org, &project, &auth).await
}

/// `structure` is `areas` or `iterations`.
#[tauri::command]
pub async fn ado_list_classification_nodes(
    org: String,
    project: String,
    structure: String,
) -> Result<Vec<azure::AdoClassificationNode>, String> {
    let pat = pat_for_org(&org)?;
    azure::list_classification_nodes(&org, &project, &structure, &pat).await
}

// ---------- reviewing a story that is already on the board ----------

/// Resolves whatever the user pasted into the organisation, project and id it names.
///
/// Kept in Rust rather than done in the frontend so there is one answer to "what counts as a work
/// item reference" — the same one that then has to fetch it.
#[tauri::command]
pub fn board_parse_item_ref(input: String) -> Result<boards::WorkItemRef, String> {
    boards::parse_work_item_ref(&input).ok_or_else(|| {
        "Pega el enlace de un work item de Azure DevOps o de una incidencia de Jira, o su número o \
         clave"
            .to_string()
    })
}

/// One work item and the children it already has, for the review screen to read.
///
/// Takes both an id and a key because the two boards address an item differently — Azure by number,
/// Jira by `PROJ-123` — and the screen holds whichever one the pasted reference yielded.
#[tauri::command]
pub async fn board_get_work_item(
    db: State<'_, Db>,
    provider: Option<String>,
    org: String,
    id: i64,
    key: Option<String>,
) -> Result<boards::WorkItem, String> {
    let provider = BoardProvider::parse(provider.as_deref().unwrap_or_default());
    let auth = board_auth(&db, provider, &org)?;
    boards::get_work_item(provider, &org, id, key.as_deref().unwrap_or_default(), &auth).await
}

/// One INVEST letter and how the story does on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestVerdict {
    pub letter: String,
    /// `ok` | `weak` | `missing`.
    pub verdict: String,
    pub note: String,
}

/// Something the story is missing, and the text that would fix it.
///
/// `proposal` is written to be pasted as-is: the user takes it, edits it, or throws it away. The
/// review never edits the story itself, which is what makes running it safe on a board other people
/// are working from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewFinding {
    /// `titulo` | `narrativa` | `descripcion` | `criterios` — which part of the story it belongs to.
    pub section: String,
    /// `alta` | `media` | `baja`.
    pub severity: String,
    pub issue: String,
    pub proposal: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// Which repository this came out of. Filled in by the merge, empty when only one was
    /// reviewed. `#[serde(default)]` because the model never sends it — a run does not know it was
    /// one of several.
    #[serde(default)]
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedCriterion {
    /// `gherkin` | `checklist` | `ambos` — which shape this criterion wants to be written in.
    ///
    /// The model's call, because the answer is a property of the behaviour: a flow with a trigger
    /// and an observable result is a scenario, and a set of conditions with no flow is a list.
    /// `ambos` is the honest "I cannot tell" — both texts come back filled and the user picks.
    /// Defaulted for the rows saved before the field existed, which were all Gherkin.
    #[serde(default = "default_criterion_format")]
    pub format: String,
    /// One whole Gherkin scenario. Empty when `format` is `checklist`.
    pub gherkin: String,
    /// The same requirement as a verification list, one condition per line. Empty when `format`
    /// is `gherkin`.
    #[serde(default)]
    pub checklist: String,
    pub rationale: String,
    /// A handful of words naming what this criterion is about — "Fijación del tipo de destino".
    ///
    /// Published as a bold first line inside the criterion, which is what lets a list of six be
    /// read at a glance on the board and collapsed to one row each on the review screen. Empty is
    /// allowed and means the criterion goes out as its text alone.
    #[serde(default)]
    pub title: String,
    /// Which vertical slice of the story this criterion belongs to — "Slice 1 – Persistencia".
    ///
    /// Not decoration: it is the order the story can be delivered in, and criteria that share a
    /// slice are the ones that have to ship together to be worth anything. Published as a bold
    /// `**Slice:**` line inside the criterion, beside its title, which is where the team that asked
    /// for this already writes it by hand.
    #[serde(default)]
    pub slice: String,
    /// `ALTO` | `MEDIO` | `BAJO` — how much it costs to get this criterion wrong.
    ///
    /// Normalised to those three words on the way in (see [`normalise_criterion`]) rather than
    /// trusted as written: a field a model spells four ways across four runs is a field nobody can
    /// sort a backlog by. Empty when the model declined to judge.
    #[serde(default)]
    pub risk: String,
    /// The 1-based number of the existing criterion this rewrites, or `0` when it is new. What
    /// lets the screen colour a correction differently from an addition — a rewrite that looks
    /// like a new criterion is how a story ends up holding both wordings.
    #[serde(default)]
    pub replaces: i64,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// See [`ReviewFinding::repo`].
    #[serde(default)]
    pub repo: String,
}

fn default_criterion_format() -> String {
    "gherkin".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedTask {
    /// `dev` | `qa`.
    pub kind: String,
    /// Already carries its `[DEV]` or `[QA]` prefix — see [`prefixed_title`].
    pub title: String,
    /// The three questions as one block of prose — what actually gets published to the board,
    /// since Azure has one description field and not three. Composed from the parts below when
    /// the model answered in parts, which is what the current templates ask for.
    pub detail: String,
    /// ¿Qué? — what is being built or changed.
    #[serde(default)]
    pub what: String,
    /// ¿Cómo? — the approach, and in which files.
    #[serde(default)]
    pub how: String,
    /// ¿Para qué? — which behaviour or criterion it covers.
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// See [`ReviewFinding::repo`].
    #[serde(default)]
    pub repo: String,
    /// How long the task should take, in hours, and how urgent it is on Azure's 1–4 scale.
    ///
    /// Proposed rather than decided: they go on screen as editable fields and publish as whatever
    /// the user left them at. `0` is "the model didn't say", which publishes the task without the
    /// field rather than with a number nobody stands behind.
    #[serde(default)]
    pub estimate_hours: f64,
    #[serde(default)]
    pub priority: i64,
}

/// The three questions as the one block of text a work item can hold.
///
/// Only the parts that came back are printed: a QA task whose `how` the model left empty should
/// publish as two labelled lines, not as three with a heading over nothing.
///
/// Markdown, and the label on a line of its own rather than inline: the boards store this field as
/// HTML and CodeFlow renders the Markdown on the way out, so the label arrives as a bold lead-in
/// and an answer written as a list arrives as a list. Inline (`**¿Cómo?** - a`) it would not — a
/// bullet only opens a list at the start of a line.
///
/// The frontend composes the same string when the user edits a part by hand (`TaskCard`), so the
/// two spellings have to stay identical or an edited task publishes differently from a generated one.
pub fn compose_task_detail(what: &str, how: &str, why: &str) -> String {
    [("¿Qué?", what), ("¿Cómo?", how), ("¿Para qué?", why)]
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .map(|(label, value)| format!("**{label}**\n{}", value.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What one stage of the review answered. Tagged by stage so the frontend reads the shape it asked
/// for rather than guessing from which arrays came back non-empty.
///
/// `Tasks` covers both task stages: development and QA answer the same shape, and the `kind` on
/// each task is what tells them apart — which is also what lets the screen merge a DEV run and a
/// QA run into one panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "lowercase")]
pub enum WorkItemReview {
    Analyze { summary: String, invest: Vec<InvestVerdict>, findings: Vec<ReviewFinding> },
    /// The description rewritten whole. An empty `description` is the model saying the current one
    /// is already fine — a first-class answer, and the one the screen reports as "nothing to
    /// propose" rather than as an empty result.
    Description { description: String, rationale: String, evidence: Vec<String> },
    Criteria { criteria: Vec<ProposedCriterion> },
    Tasks { tasks: Vec<ProposedTask> },
}

/// One stage's answer, plus what produced it.
///
/// The provenance travels with the answer rather than in a side channel, because a review is a
/// *judgement*: "Sonnet said this criterion is untestable" and "some model said it" are not the
/// same claim, and the second is the one a refinement session cannot argue with. The elapsed time
/// is here for the same reason a build prints its duration — it is how the user learns which of
/// the three stages is the expensive one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItemReviewResult {
    pub review: WorkItemReview,
    /// The engine's display name — "Claude Code", "Codex", …
    pub engine: String,
    /// The model that actually answered, as the CLI reported it, falling back to the configured id
    /// when the CLI said nothing. Empty only if neither is known.
    pub model: String,
    /// The engine CLI's own version. Empty for the HTTP engines, which have no CLI to ask.
    pub version: String,
    /// Wall clock for the whole stage, including every repository it read and any repair pass.
    pub elapsed_ms: u64,
    /// How many repositories the answer was grounded in. `0` is the story judged on its text.
    pub repos_read: usize,
}

#[derive(Deserialize)]
struct RawAnalysis {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    invest: Vec<InvestVerdict>,
    #[serde(default)]
    findings: Vec<ReviewFinding>,
}

#[derive(Deserialize)]
struct RawDescription {
    #[serde(default)]
    description: String,
    #[serde(default)]
    rationale: String,
    #[serde(default)]
    evidence: Vec<String>,
}

#[derive(Deserialize)]
struct RawCriteria {
    #[serde(default)]
    criteria: Vec<ProposedCriterion>,
}

#[derive(Deserialize)]
struct RawTasks {
    #[serde(default)]
    tasks: Vec<RawTask>,
}

/// One task as the model sends it: the three questions in parts, and `detail` still accepted for
/// the engine — or the customised template — that answers in one block.
#[derive(Deserialize)]
struct RawTask {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    detail: String,
    #[serde(default)]
    what: String,
    #[serde(default)]
    how: String,
    #[serde(default)]
    why: String,
    #[serde(default)]
    evidence: Vec<String>,
    /// Accepted under either spelling: the prompt asks for `estimate_hours`, and a model that has
    /// just been told to write in hours reaches for `hours` often enough to be worth catching
    /// rather than dropping the estimate and making the user type it again.
    #[serde(default, alias = "hours", alias = "estimate")]
    estimate_hours: f64,
    #[serde(default)]
    priority: i64,
}

/// Azure's priority scale is 1 (highest) to 4 (lowest), and it refuses anything outside it — so a
/// model that answered `0`, `5` or `P2` loses its answer here rather than the whole task at the
/// server. `0` means "nothing usable was said", which publishes without the field.
fn clamped_priority(value: i64) -> i64 {
    match value {
        1..=4 => value,
        _ => 0,
    }
}

/// An estimate in hours, or `0` when there is nothing worth publishing.
///
/// Bounded because the failure this guards against is not a model that is slightly optimistic but
/// one that answered in minutes, or in days, or hallucinated a four-digit number — and a task that
/// says 480 hours is worse than a task that says nothing, because somebody's sprint capacity adds
/// it up. Half an hour is the smallest unit anyone plans in; a fortnight of solid work is past the
/// point where the task should have been split.
fn sane_estimate(hours: f64) -> f64 {
    match hours.is_finite() && (0.5..=80.0).contains(&hours) {
        // To the nearest half hour: the model's 3.7 is precision it does not have.
        true => (hours * 2.0).round() / 2.0,
        false => 0.0,
    }
}

/// Puts the `[DEV]`/`[QA]` marker on, here rather than in the prompt.
///
/// The convention is the user's, and it has to hold on every run — including the one where the
/// model forgets the instruction, or helpfully writes `[Dev]`. Stripping any prefix it did emit
/// keeps a second run from producing `[QA] [QA] …`.
fn prefixed_title(kind: &str, title: &str) -> String {
    let marker = if kind.eq_ignore_ascii_case("qa") { "QA" } else { "DEV" };
    let mut bare = title.trim();
    while let Some(rest) = bare.strip_prefix('[') {
        match rest.split_once(']') {
            Some((tag, tail)) if tag.eq_ignore_ascii_case("qa") || tag.eq_ignore_ascii_case("dev") => {
                bare = tail.trim_start();
            }
            _ => break,
        }
    }
    format!("[{marker}] {bare}")
}

/// Why one stage's answer could not be read.
///
/// Kept in parts rather than as one finished sentence because the two readers want different
/// things: the user wants one line naming the problem, and the repair pass wants the parser's own
/// message — which names the exact offset — next to the payload it choked on.
#[derive(Debug)]
struct ReviewParseError {
    /// The parser's complaint.
    detail: String,
    /// What it choked on: the extracted JSON object, or the whole answer when there was none.
    payload: String,
    /// Whether there is a JSON object to hand to a repair pass at all. An answer that came back as
    /// prose has no syntax to fix — it has to be asked again, and that is the user's call.
    repairable: bool,
}

impl ReviewParseError {
    /// The one sentence the user sees when nothing could rescue the run.
    fn message(&self) -> String {
        match self.repairable {
            true => format!(
                "El modelo devolvió un JSON que no se pudo leer ({}). Respondió:\n\n{}",
                self.detail, self.payload
            ),
            false => format!("El modelo no devolvió JSON. Respondió:\n\n{}", self.payload),
        }
    }
}

/// The object each stage has to come back as.
///
/// The same line its prompt already shows the model, repeated here because the repair pass states
/// the target shape on its own — re-sending the whole review prompt would invite a fresh review
/// rather than a fix, and the review is exactly the work that must not be repeated.
fn review_shape(stage: ai::WorkItemReviewStage) -> &'static str {
    match stage {
        ai::WorkItemReviewStage::Analyze => {
            r#"{"summary":"","invest":[{"letter":"I","verdict":"ok","note":""}],"findings":[{"section":"titulo","severity":"media","issue":"","proposal":"","evidence":["ruta/archivo.ext:12"]}]}"#
        }
        ai::WorkItemReviewStage::Description => {
            r#"{"description":"","rationale":"","evidence":["ruta/archivo.ext:12"]}"#
        }
        ai::WorkItemReviewStage::Criteria => {
            r#"{"criteria":[{"format":"gherkin","gherkin":"Dado ...\nCuando ...\nEntonces ...","checklist":"","rationale":"","replaces":0,"evidence":[]}]}"#
        }
        ai::WorkItemReviewStage::Tasks => {
            r#"{"tasks":[{"kind":"dev","title":"","what":"","how":"","why":"","evidence":[]}]}"#
        }
        ai::WorkItemReviewStage::TasksQa => {
            r#"{"tasks":[{"kind":"qa","title":"","what":"","how":"","why":"","evidence":[]}]}"#
        }
    }
}

/// A second chance for a stage whose answer would not parse, after the deterministic salvage in
/// [`ai::json_answer`] has already had its go.
///
/// The same bargain the review has always made, extended to the two stages that never had it:
/// generating a backlog reads a specification and verifying one reads a repository, and both are
/// minutes of work that is already done and sitting in the text that would not parse. One cheap,
/// tool-less call to close a bracket beats re-running either, and beats handing the user an error
/// about a character offset they cannot see.
///
/// Only attempted when there is a JSON object to fix. An answer given in prose — "no he podido
/// revisar el repositorio" — has no syntax to repair, and asking again is the user's call.
async fn parse_or_repair<T>(
    config: &crate::commands::claude_cmd::AiConfig,
    text: &str,
    shape: &str,
    parse: impl Fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    let first = match parse(text) {
        Ok(value) => return Ok(value),
        Err(reported) => reported,
    };
    let Some(json) = ai::json_answer(text) else { return Err(first) };

    match ai::repair_json(&*config.engine, &config.binary, &config.model, &json, shape, &first).await {
        // The repaired answer still has to satisfy the stage's own rules, and when it does not,
        // what the user reads is the original complaint: the second failure is about a document
        // they never saw.
        Ok(repaired) => parse(&repaired).map_err(|_| first),
        // A stopped repair is the user stopping the run, and has to stay distinguishable from one
        // that failed.
        Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER) => Err(e),
        Err(_) => Err(first),
    }
}

/// Split out from the command so it is testable without an engine.
fn parse_review(stage: ai::WorkItemReviewStage, text: &str) -> Result<WorkItemReview, ReviewParseError> {
    // Repaired on the way in where it can be — an unescaped quote in a sentence or an answer cut
    // off two keys from the end is not worth a round trip to a model, let alone a re-run.
    let Some(json) = ai::json_answer(text) else {
        return Err(ReviewParseError {
            detail: "no hay ningún objeto JSON en la respuesta".to_string(),
            payload: text.trim().to_string(),
            repairable: false,
        });
    };
    let json = json.as_ref();
    let unreadable = |e: serde_json::Error| ReviewParseError {
        detail: e.to_string(),
        payload: json.to_string(),
        repairable: true,
    };

    match stage {
        ai::WorkItemReviewStage::Analyze => {
            let parsed: RawAnalysis = serde_json::from_str(json).map_err(unreadable)?;
            Ok(WorkItemReview::Analyze {
                summary: parsed.summary.trim().to_string(),
                invest: parsed.invest,
                // A finding with nothing to paste is an observation, and this screen is for the
                // ones the user can act on.
                findings: parsed
                    .findings
                    .into_iter()
                    .filter(|f| !f.proposal.trim().is_empty() || !f.issue.trim().is_empty())
                    .collect(),
            })
        }
        ai::WorkItemReviewStage::Description => {
            let parsed: RawDescription = serde_json::from_str(json).map_err(unreadable)?;
            Ok(WorkItemReview::Description {
                description: parsed.description.trim().to_string(),
                rationale: parsed.rationale.trim().to_string(),
                evidence: parsed.evidence,
            })
        }
        ai::WorkItemReviewStage::Criteria => {
            let parsed: RawCriteria = serde_json::from_str(json).map_err(unreadable)?;
            Ok(WorkItemReview::Criteria {
                criteria: parsed
                    .criteria
                    .into_iter()
                    .map(normalise_criterion)
                    // Both texts empty is a criterion with nothing in it whichever format it
                    // claimed — the same emptiness filter the old shape applied to `gherkin`.
                    .filter(|c| !c.gherkin.trim().is_empty() || !c.checklist.trim().is_empty())
                    .collect(),
            })
        }
        // Same shape either way: what makes a task a QA task is its `kind`, which the QA stage
        // forces below rather than trusting the model to have remembered.
        ai::WorkItemReviewStage::Tasks | ai::WorkItemReviewStage::TasksQa => {
            let parsed: RawTasks = serde_json::from_str(json).map_err(unreadable)?;
            let forced_qa = matches!(stage, ai::WorkItemReviewStage::TasksQa);
            Ok(WorkItemReview::Tasks {
                tasks: parsed
                    .tasks
                    .into_iter()
                    .filter(|t| !t.title.trim().is_empty())
                    .map(|t| {
                        let kind = match forced_qa || t.kind.eq_ignore_ascii_case("qa") {
                            true => "qa",
                            false => "dev",
                        };
                        let composed = compose_task_detail(&t.what, &t.how, &t.why);
                        ProposedTask {
                            title: prefixed_title(kind, &t.title),
                            kind: kind.to_string(),
                            // The composed block when the model answered in parts, its own prose
                            // when it answered in one — a customised template is allowed to.
                            detail: match composed.is_empty() {
                                true => t.detail.trim().to_string(),
                                false => composed,
                            },
                            what: t.what.trim().to_string(),
                            how: t.how.trim().to_string(),
                            why: t.why.trim().to_string(),
                            evidence: t.evidence,
                            // Stamped by the merge once it knows whether more than one repository ran.
                            repo: String::new(),
                            estimate_hours: sane_estimate(t.estimate_hours),
                            priority: clamped_priority(t.priority),
                        }
                    })
                    .collect(),
            })
        }
    }
}

/// The three words a risk is allowed to be, out of everything a model might write.
///
/// Spanish and English both, because a model asked for `ALTO` returns `High` often enough that
/// dropping it would lose a judgement that was actually made. Anything else comes back empty:
/// a risk field holding `Medio-Alto` is worse than one holding nothing, because the first sorts
/// wrong and the second admits it.
fn normalised_risk(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "alto" | "alta" | "high" => "ALTO",
        "medio" | "media" | "medium" | "moderado" | "moderada" => "MEDIO",
        "bajo" | "baja" | "low" => "BAJO",
        _ => "",
    }
    .to_string()
}

/// One criterion with its format and its two texts made to agree.
///
/// The model is asked for `format` plus whichever text that format names, and it is the field it
/// slips on most: `ambos` with only the scenario filled in, or `checklist` with the list written
/// into `gherkin`. Rather than dropping the criterion — the text is right there and the user can
/// read it — the format is re-derived from what actually came back.
fn normalise_criterion(mut criterion: ProposedCriterion) -> ProposedCriterion {
    let has_gherkin = !criterion.gherkin.trim().is_empty();
    let has_checklist = !criterion.checklist.trim().is_empty();
    criterion.format = match (has_gherkin, has_checklist) {
        (true, true) => "ambos",
        (false, true) => "checklist",
        (true, false) => "gherkin",
        // Nothing to go on; the emptiness filter drops it either way.
        (false, false) => "gherkin",
    }
    .to_string();
    if criterion.replaces < 0 {
        criterion.replaces = 0;
    }
    criterion.slice = criterion.slice.trim().to_string();
    criterion.risk = normalised_risk(&criterion.risk);
    criterion
}

/// How the six checklist verdicts of several repositories reconcile into one.
///
/// The checklist is a property of the *story*, not of a repository, so N runs answering it N times
/// is an artefact of how the review is executed. The worst verdict wins: one repository finding the
/// story untestable is not cancelled out by another that had nothing to say about it.
fn worst_verdict(a: &str, b: &str) -> String {
    let rank = |verdict: &str| match verdict {
        "missing" => 2,
        "weak" => 1,
        _ => 0,
    };
    if rank(b) > rank(a) { b.to_string() } else { a.to_string() }
}

/// Folds one repository's answer into the running result.
fn merge_review(into: &mut WorkItemReview, from: WorkItemReview, repo: &str, tag_repo: bool) {
    let tag = if tag_repo { repo } else { "" };
    match (into, from) {
        (
            WorkItemReview::Analyze { summary, invest, findings },
            WorkItemReview::Analyze { summary: next_summary, invest: next_invest, findings: next },
        ) => {
            if !next_summary.trim().is_empty() {
                if !summary.is_empty() {
                    summary.push('\n');
                }
                summary.push_str(&match tag_repo {
                    true => format!("{repo}: {next_summary}"),
                    false => next_summary,
                });
            }
            for letter in next_invest {
                match invest.iter_mut().find(|held| held.letter == letter.letter) {
                    Some(held) => {
                        held.verdict = worst_verdict(&held.verdict, &letter.verdict);
                        // The note that explains the worse verdict is the one worth keeping.
                        if held.note.trim().is_empty() || held.verdict == letter.verdict {
                            held.note = letter.note;
                        }
                    }
                    None => invest.push(letter),
                }
            }
            findings.extend(next.into_iter().map(|f| ReviewFinding { repo: tag.to_string(), ..f }));
        }
        (
            WorkItemReview::Description { description, rationale, evidence },
            WorkItemReview::Description { description: next, rationale: next_why, evidence: next_ev },
        ) => {
            // One field, N repositories, one answer: the first repository that had something to
            // say about the prose wins. Concatenating would produce a description written twice,
            // which is worse than a description grounded in one of the two repositories — and the
            // rewrite is about the *story*, which does not change per checkout.
            if description.trim().is_empty() && !next.trim().is_empty() {
                *description = next;
                *rationale = match tag_repo {
                    true => format!("{repo}: {next_why}"),
                    false => next_why,
                };
                *evidence = next_ev;
            }
        }
        (WorkItemReview::Criteria { criteria }, WorkItemReview::Criteria { criteria: next }) => {
            criteria
                .extend(next.into_iter().map(|c| ProposedCriterion { repo: tag.to_string(), ..c }));
        }
        (WorkItemReview::Tasks { tasks }, WorkItemReview::Tasks { tasks: next }) => {
            tasks.extend(next.into_iter().map(|t| ProposedTask { repo: tag.to_string(), ..t }));
        }
        // Unreachable: every run in one call is the same stage. Dropping rather than panicking
        // because a mismatched shape is not worth taking the user's review down for.
        _ => {}
    }
}

fn empty_review(stage: ai::WorkItemReviewStage) -> WorkItemReview {
    match stage {
        ai::WorkItemReviewStage::Analyze => WorkItemReview::Analyze {
            summary: String::new(),
            invest: Vec::new(),
            findings: Vec::new(),
        },
        ai::WorkItemReviewStage::Description => WorkItemReview::Description {
            description: String::new(),
            rationale: String::new(),
            evidence: Vec::new(),
        },
        ai::WorkItemReviewStage::Criteria => WorkItemReview::Criteria { criteria: Vec::new() },
        ai::WorkItemReviewStage::Tasks | ai::WorkItemReviewStage::TasksQa => {
            WorkItemReview::Tasks { tasks: Vec::new() }
        }
    }
}

/// The QA template with the workspace's estimation model in it.
///
/// Appended rather than dropped when the template has no slot, because the templates that lack one
/// are exactly the customised ones — a team that rewrote its ladder before the model existed — and
/// a QA run that quietly stops estimating is a worse outcome than one whose sections arrive in an
/// order nobody chose. Anyone who wants the numbers somewhere else puts the slot there.
///
/// An empty model is honoured as "no table": [`queries::get_workspace_prompt`] never returns one
/// today (blank means "use the built-in"), but a caller that hands over an empty string is asking
/// for the ladder alone, and leaving the raw `{{ESTIMACION_QA}}` in the prompt would be the model
/// reading an instruction that never arrived.
fn with_qa_estimation(template: &str, estimation: &str) -> String {
    let estimation = estimation.trim();
    if estimation.is_empty() {
        return template.replace(ai::QA_ESTIMATION_SLOT, "").trim_end().to_string();
    }
    match template.contains(ai::QA_ESTIMATION_SLOT) {
        true => template.replace(ai::QA_ESTIMATION_SLOT, estimation),
        false => format!("{}\n\n{estimation}", template.trim_end()),
    }
}

/// Runs one stage of the review against zero or more repositories.
///
/// `story_text` is assembled by the frontend from the work item it fetched, because that is where
/// Azure's HTML is turned into the text the user is looking at — sending anything else would judge
/// a story the user never saw.
///
/// **Zero repositories is a real mode, not a missing argument.** A workspace is a *project*, and a
/// story is often written before the code that satisfies it or against a system this app has no
/// checkout of. Refusing to review it until a repository is attached made the screen useless for
/// exactly the moment refinement happens. With none attached the run gets no working directory and
/// no file tools, and is told so ([`ai::NO_REPO_NOTE`]) — the difference between "no evidence
/// found" and "no evidence possible" has to reach the model, or it invents paths.
///
/// **One engine run per repository, merged here.** The alternative — a single run pointed at several
/// directories at once — only exists on some of the engines this app dispatches to (`--add-dir` on
/// one, `--dir` on another, nothing at all on the hosted ones), so it would quietly review one
/// repository out of three depending on which provider the workspace happens to be configured with.
/// The cost is real and worth stating: no single run ever sees two repositories, so an inconsistency
/// *between* them — the front calling an endpoint the back does not expose — cannot be found this
/// way. What the user gets is one merged list, with each item saying which repository it came from.
///
/// Every repository is leased for the whole call. A story reviewed against a working copy another
/// agent is editing would be judged against a tree that changes underneath it.
///
/// `use_context` decides whether the workspace's review contexts travel with the story. Opt-in
/// rather than always-on: a team that wrote a page of architecture notes wants them read on a
/// backend story and not on a copy change, and only the person running it knows which this is.
#[tauri::command]
pub async fn review_work_item(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: String,
    project_ids: Vec<String>,
    stage: ai::WorkItemReviewStage,
    kind: ai::WorkItemKind,
    story_text: String,
    use_context: bool,
    run_id: Option<String>,
    agent_provider: Option<String>,
    agent_model: Option<String>,
) -> Result<WorkItemReviewResult, String> {
    let projects = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut found = Vec::with_capacity(project_ids.len());
        for id in &project_ids {
            let project = queries::get_project(&conn, id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Ese repositorio ya no está en el espacio de trabajo".to_string())?;
            found.push(project);
        }
        found
    };

    // Taken as a batch: one busy repository refuses the whole review rather than half of it, and
    // the same folder listed twice is one repository rather than a conflict with itself.
    let paths: Vec<String> = projects.iter().map(|p| p.local_path.clone()).collect();
    let _repo_leases = ai_locks::acquire_all(&paths)
        .map_err(|at| format!("{}{}", ai_locks::BUSY_MARKER, projects[at].name))?;

    let prompt_kind = match (stage, kind) {
        (ai::WorkItemReviewStage::Analyze, ai::WorkItemKind::Bug) => "work_item_bug_analyze",
        (ai::WorkItemReviewStage::Analyze, ai::WorkItemKind::Story) => "work_item_analyze",
        (ai::WorkItemReviewStage::Description, _) => "work_item_description",
        (ai::WorkItemReviewStage::Criteria, _) => "work_item_criteria",
        (ai::WorkItemReviewStage::Tasks, _) => "work_item_tasks",
        (ai::WorkItemReviewStage::TasksQa, _) => "work_item_tasks_qa",
    };

    let (contexts, skills, config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::WorkItemReview)?,
        };
        let mut template =
            queries::get_workspace_prompt(&conn, &workspace_id, prompt_kind).map_err(|e| e.to_string())?;
        // The QA ladder is written in one text and estimated with another. They meet here rather
        // than in the editor, so a team that recalibrates its hours does not have to find them
        // inside a page of writing rules — and so the five steps it rewrote keep the calibration.
        if matches!(stage, ai::WorkItemReviewStage::TasksQa) {
            let estimation = queries::get_workspace_prompt(&conn, &workspace_id, "work_item_qa_estimation")
                .map_err(|e| e.to_string())?;
            template = with_qa_estimation(&template, &estimation);
        }
        (contexts, skills, config, template)
    };

    let enabled_contexts: Vec<(String, String)> = match use_context {
        true => contexts.into_iter().filter(|c| c.enabled).map(|c| (c.name, c.content)).collect(),
        false => Vec::new(),
    };
    let tag_repo = projects.len() > 1;
    // Which model actually answered, as the last run reported it. Every run in this call shares one
    // config, so they agree — this only exists because the *resolved* id is not knowable up front
    // when no `--model` was forced and the CLI picked for itself.
    let mut answered_by = String::new();

    let started = std::time::Instant::now();
    // One scope for the whole call, so the run log reads as one review rather than as N runs the
    // user did not ask for, and so a single Stop halts all of it.
    let result: Result<WorkItemReview, String> = crate::ai_runs::scoped(app, run_id, async {
        let mut merged = empty_review(stage);
        // No repositories still runs once, against nothing. `.max(1)` rather than a branch so the
        // repair pass, the merge and the stamping below stay written once.
        for at in 0..projects.len().max(1) {
            let project = projects.get(at);
            if let Some(project) = project {
                let _ = sync_skills_into_project(&skills, &workspace_id, &project.local_path);
            }
            let run = ai::review_work_item(
                &*config.engine,
                &config.binary,
                &config.model,
                stage,
                kind,
                &story_text,
                &enabled_contexts,
                &config.tools,
                project.map(|p| p.local_path.as_str()),
                &template,
                )
            .await?;
            if let Some(model) = run.model {
                answered_by = model;
            }
            let text = run.text;

            // A malformed answer gets one repair pass before it costs the user the run.
            //
            // This is where the engines actually slip: six INVEST verdicts with real notes run to
            // thousands of characters on one line, and a bracket closed a key too late fails the
            // whole thing. Re-running the review would pay again for the minutes it spent reading
            // the repository — and could slip again — while the answer itself is sitting right
            // there, complete, in the text that would not parse.
            let review = match parse_review(stage, &text) {
                Ok(review) => review,
                Err(first) if first.repairable => {
                    match ai::repair_json(
                        &*config.engine,
                        &config.binary,
                        &config.model,
                        &first.payload,
                        review_shape(stage),
                        &first.detail,
                    )
                    .await
                    {
                        Ok(repaired) => parse_review(stage, &repaired).map_err(|_| first.message())?,
                        // A stopped repair is the user stopping the review, and has to stay
                        // distinguishable from one that failed. Any other reason to fail the
                        // repair is less informative than what went wrong in the first place.
                        Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER) => return Err(e),
                        Err(_) => return Err(first.message()),
                    }
                }
                Err(first) => return Err(first.message()),
            };
            merge_review(&mut merged, review, project.map_or("", |p| p.name.as_str()), tag_repo);
        }
        Ok(merged)
    })
    .await;

    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return Err(result.unwrap_err());
    }
    let review = result?;

    Ok(WorkItemReviewResult {
        review,
        engine: config.engine.label().to_string(),
        // The CLI's own answer when it gave one, the configured id otherwise. Both beat leaving
        // the stamp blank, and the two only differ when no model was forced.
        model: match answered_by.is_empty() {
            true => config.model.clone(),
            false => answered_by,
        },
        version: ai::engine_version(&config.binary).await.unwrap_or_default(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        repos_read: projects.len(),
    })
}

// ---------- technical documentation ----------

/// A generated document, plus what produced it.
#[derive(Debug, Clone, Serialize)]
pub struct DocResult {
    pub content: String,
    pub engine: String,
    pub model: String,
    pub version: String,
    pub elapsed_ms: u64,
    /// How many repositories were actually read. For a workspace document this is how many
    /// grounded passes fed the synthesis, which is the difference between an architecture page and
    /// an opinion.
    pub repos_read: usize,
}

#[tauri::command]
pub fn list_doc_pages(
    db: State<Db>,
    workspace_id: String,
) -> Result<Vec<crate::db::models::DocPage>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_doc_pages(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Creates an empty document. Its content arrives when the generation runs, or when the user types.
///
/// The scope invariant is enforced here because the schema cannot enforce it (this database uses no
/// CHECK constraints) and getting it wrong one way is silently destructive: a workspace document
/// that carried a `project_id` would be cascade-deleted the day somebody removes that one
/// repository from the workspace, taking the architecture page with it.
#[tauri::command]
pub fn create_doc_page(
    db: State<Db>,
    workspace_id: String,
    project_id: Option<String>,
    scope: String,
    title: String,
) -> Result<crate::db::models::DocPage, String> {
    let project_id = match scope.as_str() {
        "repo" => Some(
            project_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Un documento de repositorio tiene que decir cuál".to_string())?,
        ),
        "workspace" => None,
        other => return Err(format!("Alcance de documento desconocido: {other}")),
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_doc_page(&conn, &workspace_id, project_id.as_deref(), &scope, &title)
        .map_err(|e| e.to_string())
}

/// Reads one wiki page by its exact path, content and history alike.
///
/// Used twice, for the same reason both times: before importing a page, so the user can see they
/// pasted the path they meant; and behind a document that already has a target, so "this page was
/// last changed by somebody else on Tuesday" is on screen *before* the publish that overwrites it.
#[tauri::command]
pub async fn ado_wiki_page_detail(
    org: String,
    project: String,
    wiki: String,
    path: String,
) -> Result<azure::AdoWikiPageDetail, String> {
    let pat = pat_for_org(&org)?;
    azure::get_wiki_page_detail(&org, &project, &wiki, &path, &pat).await
}

/// Brings a page that already exists in the wiki into the app as a document.
///
/// The page comes in whole and lands with its target already pointing back at where it came from,
/// which is what makes the round trip work: read it here, edit it (or have the model rewrite it),
/// publish it back over the same path. Nothing is written to Azure by this command.
///
/// Scope follows what the caller passes, exactly as [`create_doc_page`] enforces it: a page tied to
/// one repository can be regenerated against that checkout, and one that isn't stays a workspace
/// document whose regeneration reads whatever the user ticks.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_wiki_page(
    db: State<'_, Db>,
    workspace_id: String,
    project_id: Option<String>,
    scope: String,
    org: String,
    project: String,
    wiki_id: String,
    wiki_name: String,
    path: String,
    title: Option<String>,
) -> Result<crate::db::models::DocPage, String> {
    let project_id = match scope.as_str() {
        "repo" => Some(
            project_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Un documento de repositorio tiene que decir cuál".to_string())?,
        ),
        "workspace" => None,
        other => return Err(format!("Alcance de documento desconocido: {other}")),
    };

    // Read before writing anything: a path that does not resolve should leave no half-made
    // document behind in the list.
    let pat = pat_for_org(&org)?;
    let detail = azure::get_wiki_page_detail(&org, &project, &wiki_id, &path, &pat).await?;
    if detail.content.trim().is_empty() {
        return Err(
            "Esa ruta existe pero no tiene contenido — en Azure DevOps una página puede ser solo \
             una carpeta. Comprueba la ruta exacta."
                .to_string(),
        );
    }

    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| detail.title.clone());

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let page = queries::create_doc_page(&conn, &workspace_id, project_id.as_deref(), &scope, &title)
        .map_err(|e| e.to_string())?;
    queries::set_doc_page_content(&conn, &page.id, &detail.content, "ready", "")
        .map_err(|e| e.to_string())?;
    queries::set_doc_page_target(&conn, &page.id, &org, &project, &wiki_id, &wiki_name, &detail.path)
        .map_err(|e| e.to_string())?;
    queries::get_doc_page(&conn, &page.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El documento importado desapareció al crearlo".to_string())
}

#[tauri::command]
pub fn set_doc_page_content(db: State<Db>, id: String, content: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_doc_page_content(&conn, &id, &content, "ready", "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_doc_page_title(db: State<Db>, id: String, title: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_doc_page_title(&conn, &id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_doc_page_target(
    db: State<Db>,
    id: String,
    org: String,
    project: String,
    wiki_id: String,
    wiki_name: String,
    page_path: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_doc_page_target(&conn, &id, &org, &project, &wiki_id, &wiki_name, &page_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_doc_page(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_doc_page(&conn, &id).map_err(|e| e.to_string())
}

/// Publishes a document to its wiki and records that it landed.
#[tauri::command]
pub async fn publish_doc_page(
    db: State<'_, Db>,
    id: String,
) -> Result<azure::AdoWikiPageRef, String> {
    let page = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_doc_page(&conn, &id).map_err(|e| e.to_string())?
    }
    .ok_or_else(|| "Ese documento ya no existe".to_string())?;

    if page.ado_org.trim().is_empty()
        || page.ado_project.trim().is_empty()
        || page.wiki_id.trim().is_empty()
        || page.page_path.trim().is_empty()
    {
        return Err("Elige a qué wiki y a qué ruta publicar antes de publicar".to_string());
    }
    if page.content.trim().is_empty() {
        return Err("Este documento está vacío".to_string());
    }

    let pat = pat_for_org(&page.ado_org)?;
    let published = azure::put_wiki_page(
        &page.ado_org,
        &page.ado_project,
        &page.wiki_id,
        &page.page_path,
        &page.content,
        &pat,
    )
    .await?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::mark_doc_page_published(&conn, &id, &published.url).map_err(|e| e.to_string())?;
    Ok(published)
}

/// Generates a document's content by reading the code.
///
/// Two shapes behind one command, because the user makes one choice ("document this repo" /
/// "document how the workspace fits together") and the split is an artefact of how the engines work:
///
/// - **repo** — one grounded run in that repository's checkout.
/// - **workspace** — one grounded run *per* repository, then a synthesis run over their output. No
///   single run can see two checkouts (see [`ai::synthesize_workspace_doc`]), so the alternative
///   would be describing six services from inside one of them.
///
/// The whole thing is one run scope, so the log reads as one job and a single Stop halts all of it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_doc_page(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: String,
    doc_id: String,
    scope: ai::DocScope,
    project_ids: Vec<String>,
    instructions: String,
    use_context: bool,
    run_id: Option<String>,
    agent_provider: Option<String>,
    agent_model: Option<String>,
) -> Result<DocResult, String> {
    if project_ids.is_empty() {
        return Err("Elige al menos un repositorio que documentar".to_string());
    }

    let (projects, workspace_name) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut found = Vec::with_capacity(project_ids.len());
        for id in &project_ids {
            found.push(
                queries::get_project(&conn, id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Ese repositorio ya no está en el espacio de trabajo".to_string())?,
            );
        }
        // Named from the list rather than by id: there is no single-workspace read, and the list
        // is a handful of rows. The name is only a label inside the prompt, so a workspace renamed
        // mid-run costing nothing is exactly the right amount of care.
        let name = queries::list_workspaces(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id == workspace_id)
            .map(|w| w.name)
            .unwrap_or_default();
        (found, name)
    };

    let paths: Vec<String> = projects.iter().map(|p| p.local_path.clone()).collect();
    let _repo_leases = ai_locks::acquire_all(&paths)
        .map_err(|at| format!("{}{}", ai_locks::BUSY_MARKER, projects[at].name))?;

    let (contexts, skills, config, repo_template, workspace_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::Wiki)?,
        };
        let repo_template =
            queries::get_workspace_prompt(&conn, &workspace_id, "repo_doc").map_err(|e| e.to_string())?;
        let workspace_template = queries::get_workspace_prompt(&conn, &workspace_id, "workspace_doc")
            .map_err(|e| e.to_string())?;
        (contexts, skills, config, repo_template, workspace_template)
    };

    let enabled_contexts: Vec<(String, String)> = match use_context {
        true => contexts.into_iter().filter(|c| c.enabled).map(|c| (c.name, c.content)).collect(),
        false => Vec::new(),
    };

    // Status only — emphatically not the content. Blanking the body here and restoring it in the
    // failure arm was the first shape of this, and it meant stopping a regeneration replaced a
    // document the user had written, and possibly already published, with nothing.
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = queries::set_doc_page_status(&conn, &doc_id, "generating", "");
    }

    let mut answered_by = String::new();
    let started = std::time::Instant::now();
    let result: Result<String, String> = crate::ai_runs::scoped(app, run_id, async {
        let mut per_repo: Vec<(String, String)> = Vec::with_capacity(projects.len());
        for project in &projects {
            let _ = sync_skills_into_project(&skills, &workspace_id, &project.local_path);
            let run = ai::generate_repo_doc(
                &*config.engine,
                &config.binary,
                &config.model,
                &project.name,
                &instructions,
                &enabled_contexts,
                &config.tools,
                &project.local_path,
                &repo_template,
                )
            .await?;
            if let Some(model) = run.model {
                answered_by = model;
            }
            per_repo.push((project.name.clone(), strip_code_fence(&run.text)));
        }

        match scope {
            // One repository asked for, one document produced — no synthesis to do, and running one
            // would only paraphrase what the grounded pass already said better.
            //
            // Joined rather than headed: the template forbids a level-1 heading (the wiki takes the
            // page title from its path), so stamping `# {name}` here would contradict the contract
            // the document was written to. The UI only ever sends one repository for this scope
            // anyway — the join is what keeps a hand-made call from silently losing documents.
            ai::DocScope::Repo => {
                Ok(per_repo.into_iter().map(|(_, document)| document).collect::<Vec<_>>().join("\n\n---\n\n"))
            }
            ai::DocScope::Workspace => {
                let run = ai::synthesize_workspace_doc(
                    &*config.engine,
                    &config.binary,
                    &config.model,
                    &workspace_name,
                    &instructions,
                    &per_repo,
                    &workspace_template,
                )
                .await?;
                if let Some(model) = run.model {
                    answered_by = model;
                }
                Ok(strip_code_fence(&run.text))
            }
        }
    })
    .await;

    let version = ai::engine_version(&config.binary).await.unwrap_or_default();
    let engine_label = config.engine.label().to_string();
    let model = match answered_by.is_empty() {
        true => config.model.clone(),
        false => answered_by,
    };

    match result {
        Ok(content) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::set_doc_page_content(&conn, &doc_id, &content, "ready", "")
                .map_err(|e| e.to_string())?;
            queries::set_doc_page_provenance(&conn, &doc_id, &engine_label, &model, &version)
                .map_err(|e| e.to_string())?;
            Ok(DocResult {
                content,
                engine: engine_label,
                model,
                version,
                elapsed_ms: started.elapsed().as_millis() as u64,
                repos_read: projects.len(),
            })
        }
        Err(e) => {
            // A cancelled run is not an error state for the row: the user stopped it, and whatever
            // the document already said is still what it says. Only the status moves.
            let cancelled = e.starts_with(crate::ai_runs::CANCELLED_MARKER);
            let conn = db.0.lock().map_err(|err| err.to_string())?;
            let _ = queries::set_doc_page_status(
                &conn,
                &doc_id,
                if cancelled { "draft" } else { "error" },
                if cancelled { "" } else { &e },
            );
            Err(e)
        }
    }
}

/// Markdown that arrived wrapped in a ```markdown fence, unwrapped.
///
/// The engines are told to answer with the document itself and mostly do, but a fenced answer is
/// common enough that publishing it verbatim would put three backticks at the top of a wiki page.
/// Only a fence that wraps the *whole* answer is removed — an inner code block is content.
fn strip_code_fence(text: &str) -> String {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else { return trimmed.to_string() };
    let Some((first_line, body)) = rest.split_once('\n') else { return trimmed.to_string() };
    // The opening fence may carry a language tag and nothing else; anything else means this is a
    // code block that happens to start the document.
    if !first_line.trim().chars().all(|c| c.is_alphanumeric() || c == '-' || c == '+') {
        return trimmed.to_string();
    }
    match body.trim_end().strip_suffix("```") {
        Some(inner) => inner.trim_end().to_string(),
        None => trimmed.to_string(),
    }
}

// ---------- publishing a review back to the board ----------

/// Writes the reviewed text back onto the work item it came from.
///
/// Every field is optional and absent means "don't touch it": the screen publishes description,
/// criteria and tasks as three separate decisions, and each has to be able to land without
/// disturbing the other two.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn board_update_work_item(
    db: State<'_, Db>,
    provider: Option<String>,
    org: String,
    // `project` is the container as the host addresses it. Only monday needs it — a column write
    // there is addressed by board *and* item — but it travels for all three so the command has one
    // shape.
    project: Option<String>,
    id: i64,
    key: Option<String>,
    title: Option<String>,
    description: Option<String>,
    repro_steps: Option<String>,
    acceptance_criteria: Option<Vec<String>>,
    effort: Option<f64>,
    effort_field: Option<String>,
    prose_is_html: Option<bool>,
) -> Result<boards::ItemRef, String> {
    let provider = BoardProvider::parse(provider.as_deref().unwrap_or_default());
    let auth = board_auth(&db, provider, &org)?;
    let edit = boards::WorkItemEdit {
        title,
        description,
        repro_steps,
        acceptance_criteria,
        // Negative is a typo nobody wants published; `0` is the user clearing the estimate, which
        // is a real thing to want and is not the same as not sending the field at all.
        effort: effort.map(|value| if value.is_finite() { value.max(0.0) } else { 0.0 }),
        effort_field: effort_field.unwrap_or_default(),
        prose_is_html: prose_is_html.unwrap_or(false),
    };
    boards::update_work_item(
        provider,
        &org,
        project.as_deref().unwrap_or_default(),
        id,
        key.as_deref().unwrap_or_default(),
        &edit,
        &auth,
    )
    .await
}

/// What one proposed task becomes on the board.
///
/// The planning fields arrive from the screen rather than being decided here: a run proposes them,
/// the user overrides whichever they disagree with, and what publishes is what was on screen. All
/// of them default, so a caller that sends only a title and a detail still publishes a task.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChildTask {
    pub title: String,
    #[serde(default)]
    pub detail: String,
    /// `dev` | `qa` — which decides the two fields that say what kind of work this is, rather than
    /// the screen having to know Azure's vocabulary for them.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub priority: i64,
    /// Hours. `0` publishes the task without an estimate rather than with a made-up one.
    #[serde(default)]
    pub estimate_hours: f64,
}

/// Azure's Activity picklist value for a kind of task, and the team's own word for the same thing.
///
/// The English values are Azure's own: Activity is a picklist and refuses anything else, whatever
/// language the org's UI is in. The second half is free text on a custom field, and `QA` is what
/// the tasks are labelled with everywhere else in this app — the `[QA]` on the title included.
fn task_kind_fields(kind: &str) -> (&'static str, &'static str) {
    match kind.eq_ignore_ascii_case("qa") {
        true => ("Testing", "QA"),
        false => ("Development", "DEV"),
    }
}

/// Creates the accepted tasks as children of the story, in the order the user arranged them.
///
/// Sequential rather than concurrent, and it stops at the first failure reporting what did land.
/// Both hosts rate-limit per account and a burst of twelve creates is exactly the shape that trips
/// them — and a partial publish the user can *see* is recoverable, while twelve half-created tasks
/// in an unknown order is not.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn board_create_child_tasks(
    db: State<'_, Db>,
    provider: Option<String>,
    org: String,
    project: String,
    parent_id: i64,
    parent_key: Option<String>,
    work_item_type: String,
    tasks: Vec<NewChildTask>,
) -> Result<Vec<boards::ItemRef>, String> {
    if tasks.is_empty() {
        return Err("No hay tareas que publicar".to_string());
    }
    let provider = BoardProvider::parse(provider.as_deref().unwrap_or_default());
    let auth = board_auth(&db, provider, &org)?;
    let parent_key = parent_key.unwrap_or_default();

    // One probe for the whole batch, exactly as the story publish does it: every task is the same
    // type, so asking per task would be a wasted round trip each. A probe that fails is not fatal —
    // the fields go out unfiltered and Azure gets to be the one that objects.
    let available_fields = match provider {
        BoardProvider::Azure => {
            azure::work_item_type_fields(&org, &project, &work_item_type, &auth.secret).await.ok()
        }
        BoardProvider::Jira | BoardProvider::Monday => None,
    };

    // Where the story is filed, so its tasks land in the same sprint. Azure inherits neither field
    // through the parent link, and a task on the project root never shows on the board the team is
    // standing in front of. Read once for the batch, and a failed read is not fatal: the tasks are
    // still worth creating unfiled.
    let (area_path, iteration_path) = match provider {
        BoardProvider::Azure => azure::classification_of(&org, parent_id, &auth.secret)
            .await
            .unwrap_or_default(),
        BoardProvider::Jira | BoardProvider::Monday => Default::default(),
    };

    let mut created = Vec::with_capacity(tasks.len());
    for task in &tasks {
        let (activity, task_type) = task_kind_fields(&task.kind);
        let child = boards::NewChildItem {
            title: &task.title,
            detail: &task.detail,
            activity,
            task_type,
            priority: task.priority,
            original_estimate: task.estimate_hours,
            // The same number at creation: nothing has been done yet, so everything estimated is
            // still to do. They part company on the board, as the person doing the work burns it down.
            remaining_work: task.estimate_hours,
            area_path: &area_path,
            iteration_path: &iteration_path,
        };
        match boards::create_child_work_item(
            provider,
            &org,
            &project,
            parent_id,
            &parent_key,
            &work_item_type,
            &child,
            available_fields.as_ref(),
            &auth,
        )
        .await
        {
            Ok(reference) => created.push(reference),
            Err(e) => {
                return Err(match created.len() {
                    0 => e,
                    done => format!(
                        "Se crearon {done} tarea(s) y la siguiente falló: {e}. Quita las que ya \
                         están y vuelve a publicar el resto."
                    ),
                })
            }
        }
    }
    Ok(created)
}

// ---------- review history ----------

/// The workspace's saved reviews, newest first.
#[tauri::command]
pub fn list_work_item_reviews(
    db: State<Db>,
    workspace_id: String,
) -> Result<Vec<crate::db::models::WorkItemReviewRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_work_item_reviews(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Saves a review session under its own id, overwriting the previous save of that same session.
///
/// The id is minted by the screen when a work item is loaded, which is what makes the three stages
/// of one sitting update a single row while a review run next sprint starts a new one.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_work_item_review(
    db: State<Db>,
    id: String,
    workspace_id: String,
    org: String,
    work_item_id: i64,
    work_item_type: String,
    work_item_url: String,
    title: String,
    payload: String,
    engine: String,
    model: String,
    version: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::save_work_item_review(
        &conn,
        &id,
        &workspace_id,
        &org,
        work_item_id,
        &work_item_type,
        &work_item_url,
        &title,
        &payload,
        &engine,
        &model,
        &version,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_work_item_review(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_work_item_review(&conn, &id).map_err(|e| e.to_string())
}

// ---------- batches ----------

#[tauri::command]
pub fn list_story_batches(db: State<Db>, workspace_id: String) -> Result<Vec<StoryBatch>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_story_batches(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_story_batch(db: State<Db>, id: String) -> Result<Option<StoryBatchDetail>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_story_batch(&conn, &id).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn create_story_batch(
    db: State<Db>,
    workspace_id: String,
    project_id: Option<String>,
    title: String,
    source_kind: String,
    source_ref: String,
    source_text: String,
    instructions: String,
) -> Result<StoryBatch, String> {
    if source_text.trim().is_empty() {
        return Err("No hay documentación de la que derivar historias".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_story_batch(
        &conn,
        &workspace_id,
        project_id.as_deref(),
        title.trim(),
        &source_kind,
        &source_ref,
        &source_text,
        &instructions,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_story_batch(db: State<Db>, id: String, title: String) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("El nombre no puede estar vacío".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_story_batch(&conn, &id, trimmed).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn set_story_batch_target(
    db: State<Db>,
    id: String,
    board_provider: Option<String>,
    ado_org: String,
    ado_project: String,
    work_item_type: String,
    area_path: String,
    iteration_path: String,
    tags: String,
) -> Result<(), String> {
    // Normalised through the enum rather than stored as typed, so a value the frontend has not
    // heard of lands as Azure — the same rule the reader applies — instead of as a string no client
    // will ever match.
    let board_provider = BoardProvider::parse(board_provider.as_deref().unwrap_or_default());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_story_batch_target(
        &conn,
        &id,
        board_provider.as_str(),
        ado_org.trim(),
        ado_project.trim(),
        work_item_type.trim(),
        area_path.trim(),
        iteration_path.trim(),
        tags.trim(),
    )
    .map_err(|e| e.to_string())
}

/// The extra instructions the *next* generation runs with — "más detalle en los errores", "sepáralo
/// por módulo". The source text is untouched, which is what makes re-running a comparison rather
/// than a fresh start.
#[tauri::command]
pub fn set_story_batch_instructions(db: State<Db>, id: String, instructions: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_story_batch_instructions(&conn, &id, instructions.trim()).map_err(|e| e.to_string())
}

/// The repositories whose code this batch's criteria are checked against. An empty list clears them.
///
/// Deliberately not the same field as the batch's `project_id`: that one records where the source
/// Markdown was read from, and a backlog derived from a product wiki is routinely verified against
/// service repositories that had nothing to do with writing it. Several of them, because one
/// capability is normally split across a service, its BFF and its scheduled jobs — checked against
/// only one of those, a criterion comes back failing for the wrong reason.
#[tauri::command]
pub fn set_story_batch_verify_projects(
    db: State<Db>,
    id: String,
    project_ids: Vec<String>,
) -> Result<(), String> {
    let ids: Vec<String> = project_ids
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_story_batch_verify_projects(&conn, &id, &json).map_err(|e| e.to_string())?;

    // A destination that just left the set stops being one. Enforced here rather than in the view
    // so the rule survives the next caller: the export would otherwise keep writing into a
    // repository this batch no longer claims to have anything to do with.
    let detail = queries::get_story_batch(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())?;
    if let Some(current) = detail.batch.feature_project_id.filter(|p| !p.trim().is_empty()) {
        if !ids.contains(&current) {
            queries::set_story_batch_feature_project(&conn, &id, None).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Which of those repositories the `.feature` file is written into. `None` clears it, and the export
/// then falls back to the first of the set — so a batch that never touches this still exports.
#[tauri::command]
pub fn set_story_batch_feature_project(
    db: State<Db>,
    id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let project_id = project_id.filter(|p| !p.trim().is_empty());
    queries::set_story_batch_feature_project(&conn, &id, project_id.as_deref()).map_err(|e| e.to_string())
}

/// The answers to this batch's open questions, as the modal edits them.
///
/// The whole list is written at once rather than one answer at a time: what the user is editing is
/// a form, and half-saved forms are how two answers end up contradicting each other. Answers to
/// questions that no longer appear in `open_questions` are kept — the documentation was still
/// missing that fact, and the next generation deserves it as much as this one did.
#[tauri::command]
pub fn set_story_batch_answers(
    db: State<Db>,
    id: String,
    answers: Vec<QuestionAnswer>,
) -> Result<(), String> {
    let kept: Vec<QuestionAnswer> = answers
        .into_iter()
        .map(|qa| QuestionAnswer {
            question: qa.question.trim().to_string(),
            answer: qa.answer.trim().to_string(),
        })
        .filter(|qa| !qa.question.is_empty() && !qa.answer.is_empty())
        .collect();
    let json = serde_json::to_string(&kept).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_story_batch_answers(&conn, &id, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_story_batch(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_story_batch(&conn, &id).map_err(|e| e.to_string())
}

// ---------- generating ----------

/// The shape the model is asked for. Every field is defaulted: a model that omits `tags` or writes
/// `notes: null` has still answered usefully, and failing the whole batch over one absent key would
/// throw away nine good stories for the sake of the tenth.
#[derive(Debug, Deserialize)]
struct GeneratedStory {
    #[serde(default)]
    title: String,
    #[serde(default)]
    narrative: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    acceptance_criteria: Vec<String>,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    story_points: f64,
    /// Hours, under either spelling — see [`RawTask::estimate_hours`] for why the aliases.
    #[serde(default, alias = "hours", alias = "estimate")]
    estimate_hours: f64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Deserialize)]
struct GeneratedBatch {
    #[serde(default)]
    stories: Vec<GeneratedStory>,
    #[serde(default)]
    open_questions: Vec<String>,
}

/// The object the generation stage has to come back as, for the repair pass.
///
/// The same line its prompt already shows the model, repeated here because the repair states the
/// target shape on its own — re-sending the whole generation prompt would invite a fresh backlog
/// rather than a fix, and that backlog is exactly the work that must not be repeated.
const GENERATED_SHAPE: &str = r#"{"stories":[{"title":"","narrative":"","description":"","acceptance_criteria":[""],"priority":0,"story_points":0,"estimate_hours":0,"tags":[""],"notes":""}],"open_questions":[""]}"#;

/// An answer with no JSON object anywhere in it — prose where a document was asked for.
///
/// Separated from the malformed-JSON message because it is a different failure with a different
/// fix: a broken document means the model did the work and stumbled on the syntax (that is what the
/// repair pass is for), while prose means it never attempted the task. That is nearly always a
/// model too small or too old to follow a long instruction, and the reply on its own — "Hola,
/// ¿en qué puedo ayudarte?" — reads as a bug in the app rather than as what it is.
fn no_json_error(text: &str) -> String {
    format!(
        "El modelo no devolvió JSON. Respondió:\n\n{}\n\nContestar con prosa a un prompt que pide \
         únicamente JSON suele significar que el modelo se queda corto para esta tarea. Prueba con \
         un modelo de instrucciones más capaz (8B o más si es local) o con otro proveedor.",
        text.trim()
    )
}

/// Turns the model's answer into rows.
///
/// Split out from the command so it is testable without an engine: this is where a plausible-looking
/// reply that is actually empty (`{"stories": []}`) has to be caught, because everything downstream
/// would otherwise report a successful generation of nothing.
fn parse_generated(text: &str) -> Result<(Vec<NewStoryDraft>, Vec<String>), String> {
    let json = ai::json_answer(text).ok_or_else(|| no_json_error(text))?;
    let parsed: GeneratedBatch = serde_json::from_str(&json)
        .map_err(|e| format!("El modelo devolvió un JSON que no se pudo leer ({e}). Respondió:\n\n{json}"))?;

    let stories: Vec<NewStoryDraft> = parsed
        .stories
        .into_iter()
        // A story with no title is not a story; it is the model padding the array.
        .filter(|s| !s.title.trim().is_empty())
        .map(|s| NewStoryDraft {
            title: s.title.trim().to_string(),
            narrative: s.narrative.trim().to_string(),
            description: s.description.trim().to_string(),
            acceptance_criteria: serde_json::to_string(
                &s.acceptance_criteria
                    .iter()
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty())
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_else(|_| "[]".to_string()),
            // Both scales are clamped rather than trusted: Azure rejects a priority outside 1-4,
            // and a negative estimate is a typo nobody wants published.
            priority: s.priority.clamp(0, 4),
            story_points: if s.story_points.is_finite() { s.story_points.max(0.0) } else { 0.0 },
            original_estimate: sane_estimate(s.estimate_hours),
            tags: s
                .tags
                .iter()
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("; "),
            notes: s.notes.trim().to_string(),
        })
        .collect();

    if stories.is_empty() {
        return Err("El modelo no devolvió ninguna historia".to_string());
    }
    let questions = parsed
        .open_questions
        .into_iter()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .collect();
    Ok((stories, questions))
}

/// Derives the batch's stories and writes them.
///
/// Re-runnable on purpose: the source text is stored on the batch, so "generate again" — with the
/// instructions edited, or pointed at another model — re-reads exactly the documentation the first
/// run saw. Stories already published survive it (see `replace_story_drafts`).
#[tauri::command]
pub async fn generate_stories(
    app: AppHandle,
    db: State<'_, Db>,
    batch_id: String,
    run_id: Option<String>,
    agent_provider: Option<String>,
    agent_model: Option<String>,
) -> Result<StoryBatchDetail, String> {
    let (batch, config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let detail = queries::get_story_batch(&conn, &batch_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::Stories)?,
        };
        let template = queries::get_workspace_prompt(&conn, &detail.batch.workspace_id, "user_stories")
            .map_err(|e| e.to_string())?;
        (detail.batch, config, template)
    };

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_story_batch_status(&conn, &batch_id, "generating", "").map_err(|e| e.to_string())?;
    }

    // Built once and reused for the snapshot below, so what gets recorded is what actually ran
    // rather than a second composition of the same pieces.
    let preamble = ai::user_stories_preamble(&batch.instructions, &answers_of(&batch.question_answers));

    // The parse and its repair live inside the scope, not after it: a repair outside would be a
    // second engine run the Stop button could not reach.
    let result = crate::ai_runs::scoped(app, run_id, async {
        let text = ai::generate_user_stories(
            &*config.engine,
            &config.binary,
            &config.model,
            &batch.source_text,
            &preamble,
            &template,
        )
        .await?;
        parse_or_repair(&config, &text, GENERATED_SHAPE, parse_generated).await
    })
    .await;

    // A stopped run leaves the batch exactly as it was, like every other cancellable run in the app.
    if let Err(stopped) = &result {
        if stopped.starts_with(crate::ai_runs::CANCELLED_MARKER) {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::set_story_batch_status(&conn, &batch_id, "draft", "").map_err(|e| e.to_string())?;
            return Err(stopped.clone());
        }
    }

    let parsed = result;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match parsed {
        Ok((stories, questions)) => {
            queries::replace_story_drafts(&conn, &batch_id, &stories).map_err(|e| e.to_string())?;
            let questions_json = serde_json::to_string(&questions).unwrap_or_else(|_| "[]".to_string());
            // The prompt is frozen alongside the answer, and the *resolved* template is what gets
            // stored: a workspace whose override is blank runs on the built-in one, and recording
            // the blank would leave the snapshot pointing at a default that a later release can
            // change underneath it.
            queries::set_story_batch_run(
                &conn,
                &batch_id,
                &config.provider,
                &config.model,
                &questions_json,
                ai::user_stories_prompt(&template),
                &preamble,
            )
            .map_err(|e| e.to_string())?;
            queries::set_story_batch_status(&conn, &batch_id, "ready", "").map_err(|e| e.to_string())?;
        }
        Err(e) => {
            // The failure is filed on the batch, not only returned: the user may well have switched
            // away from the screen, and "why is this one empty?" has to be answerable later.
            queries::set_story_batch_status(&conn, &batch_id, "error", &e).map_err(|e| e.to_string())?;
            return Err(e);
        }
    }
    queries::get_story_batch(&conn, &batch_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())
}

/// Exactly what a generation sent to the model, rebuilt for reading.
///
/// Two fields rather than one blob because they travel on two different channels and mean different
/// things: `prompt` is the CLI's `-p` argument (the standing instructions), `stdin` is this set's
/// own payload. Flattening them would misrepresent the run for every CLI engine.
#[derive(Debug, Clone, Serialize)]
pub struct StoryBatchPrompt {
    pub prompt: String,
    pub stdin: String,
    /// `true` when these are the pieces the run actually used, `false` when the batch predates the
    /// snapshot (or has never generated) and this is today's template and today's instructions —
    /// a reconstruction the screen has to label as such.
    pub from_snapshot: bool,
    pub generated_at: String,
    pub provider: String,
    pub model: String,
    /// The documentation was longer than one payload and got cut at the ceiling.
    pub truncated: bool,
}

/// The prompt a set's stories came out of.
///
/// Reads the snapshot taken by [`generate_stories`], and falls back to composing today's pieces for
/// sets generated before that snapshot existed — marked `from_snapshot: false`, because the whole
/// value of this view is that it is trustworthy. Built through the same [`ai`] helpers the run
/// itself uses, so the two cannot drift.
#[tauri::command]
pub fn story_batch_prompt(db: State<Db>, id: String) -> Result<StoryBatchPrompt, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let batch = queries::get_story_batch(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())?
        .batch;

    let from_snapshot = !batch.prompt_template.trim().is_empty();
    let (template, preamble) = if from_snapshot {
        (batch.prompt_template.clone(), batch.prompt_instructions.clone())
    } else {
        let current = queries::get_workspace_prompt(&conn, &batch.workspace_id, "user_stories")
            .map_err(|e| e.to_string())?;
        let preamble =
            ai::user_stories_preamble(&batch.instructions, &answers_of(&batch.question_answers));
        (current, preamble)
    };

    Ok(StoryBatchPrompt {
        prompt: ai::user_stories_prompt(&template).to_string(),
        stdin: ai::user_stories_stdin(&batch.source_text, &preamble),
        from_snapshot,
        generated_at: batch.generated_at,
        provider: batch.provider,
        model: batch.model,
        truncated: batch.source_text.chars().count() > ai::MAX_STORIES_SOURCE_CHARS,
    })
}

// ---------- editing one story ----------

#[tauri::command]
pub fn add_story_draft(db: State<Db>, batch_id: String) -> Result<StoryDraft, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_story_draft(&conn, &batch_id).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_story_draft(
    db: State<Db>,
    id: String,
    title: String,
    narrative: String,
    description: String,
    acceptance_criteria: Vec<String>,
    priority: i64,
    story_points: f64,
    original_estimate: f64,
    tags: String,
    notes: String,
) -> Result<StoryDraft, String> {
    let criteria: Vec<String> = acceptance_criteria
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    let criteria_json = serde_json::to_string(&criteria).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::save_story_draft(
        &conn,
        &id,
        title.trim(),
        narrative.trim(),
        description.trim(),
        &criteria_json,
        priority.clamp(0, 4),
        if story_points.is_finite() { story_points.max(0.0) } else { 0.0 },
        // Unbounded above, unlike the model's own answer: this number is the user's, typed on
        // purpose, and a story they say is ninety hours is a story they meant to say that about.
        if original_estimate.is_finite() { original_estimate.max(0.0) } else { 0.0 },
        tags.trim(),
        notes.trim(),
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Esa historia ya no existe".to_string())
}

#[tauri::command]
pub fn delete_story_draft(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_story_draft(&conn, &id).map_err(|e| e.to_string())
}

// ---------- verifying the criteria against the code ----------

/// The criteria of one story, decoded. A row whose JSON is unreadable yields no criteria rather
/// than failing the run: one corrupt story must not cost the other nine their verification.
fn criteria_of(story: &StoryDraft) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&story.acceptance_criteria).unwrap_or_default()
}

/// One open question and what the team answered. Crosses the wire in both directions: the view
/// edits a list of these and hands the whole list back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionAnswer {
    pub question: String,
    pub answer: String,
}

/// The batch's answered questions, decoded. An unreadable column yields none rather than failing the
/// generation: answers are an enrichment, and losing them must not cost the run.
fn answers_of(raw: &str) -> Vec<(String, String)> {
    serde_json::from_str::<Vec<QuestionAnswer>>(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|qa| (qa.question, qa.answer))
        .collect()
}

/// The repositories a batch is checked against, decoded from its JSON column. Unreadable or empty
/// both mean "none chosen", which the caller turns into the same message either way.
fn parse_project_ids(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

/// The stories as the model is asked to read them: numbered from 1, criteria numbered from 1
/// within each story. The numbering *is* the addressing scheme — it is what comes back in the
/// answer — so it is built here, once, rather than left to the prompt to describe.
fn build_verification_payload(stories: &[&StoryDraft]) -> String {
    let mut out = String::new();
    for (i, story) in stories.iter().enumerate() {
        out.push_str(&format!("HISTORIA {}: {}\n", i + 1, story.title));
        if !story.narrative.trim().is_empty() {
            out.push_str(&format!("Narrativa: {}\n", story.narrative.trim()));
        }
        if !story.description.trim().is_empty() {
            out.push_str(&format!("Contexto: {}\n", story.description.trim()));
        }
        for (c, criterion) in criteria_of(story).iter().enumerate() {
            out.push_str(&format!("\nCriterio {}:\n{}\n", c + 1, criterion.trim()));
        }
        out.push_str("\n---\n\n");
    }
    out
}

/// One criterion's verdict as it is stored on the story row. Serialized (never deserialized from
/// the model directly) so the shape the frontend reads is this one, not whatever the engine wrote.
#[derive(Debug, Clone, Serialize)]
struct CriterionVerdict {
    /// `pass` | `partial` | `fail` | `unknown`.
    verdict: String,
    /// Repository-relative `path:line` references. Empty is allowed — and for a `pass`, suspicious.
    evidence: Vec<String>,
    note: String,
    covered_by_test: bool,
}

#[derive(Debug, Deserialize)]
struct ReportedCriterion {
    /// 1-based, as numbered in the payload above.
    #[serde(default)]
    criterion: i64,
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    note: String,
    #[serde(default)]
    covered_by_test: bool,
}

#[derive(Debug, Deserialize)]
struct ReportedStory {
    /// 1-based, as numbered in the payload above.
    #[serde(default)]
    story: i64,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    criteria: Vec<ReportedCriterion>,
}

#[derive(Debug, Deserialize)]
struct ReportedVerification {
    #[serde(default)]
    stories: Vec<ReportedStory>,
}

/// Anything outside the four known verdicts becomes `unknown`.
///
/// Models improvise here — `"yes"`, `"ok"`, `"cumple"`, `"PASS"` — and every improvisation that
/// isn't recognised has to land on the *cautious* side. Silently treating an unrecognised word as
/// a pass is the one failure mode this whole feature exists to prevent.
fn normalize_verdict(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "pass" => "pass",
        "fail" => "fail",
        "partial" => "partial",
        _ => "unknown",
    }
}

/// The story's own verdict, derived from its criteria rather than taken from the model.
///
/// Computed here so the badge on the card can never contradict the criteria underneath it — a
/// model that reports four failures and then summarises the story as "cumple" is a real answer
/// shape, and the summary is the part that would be believed at a glance.
fn roll_up(verdicts: &[&str]) -> &'static str {
    if verdicts.is_empty() {
        return "unknown";
    }
    if verdicts.contains(&"fail") {
        return "fail";
    }
    if verdicts.contains(&"partial") {
        return "partial";
    }
    if verdicts.iter().all(|v| *v == "pass") {
        return "pass";
    }
    // What is left is a mix of `pass` and `unknown`: partly proven, and the rest genuinely open.
    if verdicts.contains(&"pass") {
        "partial"
    } else {
        "unknown"
    }
}

/// One story's verdicts from one repository, before they are folded together.
struct ParsedVerification {
    /// Zero-based index into the list of stories that were sent.
    story: usize,
    summary: String,
    /// Exactly one entry per criterion of that story.
    criteria: Vec<CriterionVerdict>,
}

/// How much a verdict claims, for picking between what two repositories said about one criterion.
///
/// `pass` outranks `fail` rather than the other way round, which is the whole reason the set exists:
/// a repository that doesn't implement a capability honestly reports `fail`, and letting that
/// outvote the repository that *does* implement it would make every criterion fail as soon as the
/// set had more than one member.
fn verdict_rank(verdict: &str) -> u8 {
    match verdict {
        "pass" => 3,
        "partial" => 2,
        "fail" => 1,
        _ => 0,
    }
}

/// Folds one repository's answer for a criterion into the running one.
///
/// A stronger verdict replaces what is there, evidence and all: the `fail` from the repository that
/// was never going to contain the behaviour is noise once another one has been shown to implement
/// it. Two repositories that agree keep both sets of evidence, because "implemented in both" is
/// something QA needs to see.
fn merge_verdict(into: &mut CriterionVerdict, found: CriterionVerdict) {
    let rank_found = verdict_rank(&found.verdict);
    let rank_into = verdict_rank(&into.verdict);
    if rank_found > rank_into {
        *into = found;
        return;
    }
    if rank_found < rank_into {
        return;
    }
    into.evidence.extend(found.evidence);
    into.covered_by_test |= found.covered_by_test;
    if into.note.is_empty() {
        into.note = found.note;
    }
}

/// The object the verification stage has to come back as, for the repair pass. See
/// [`GENERATED_SHAPE`] for why the shape is repeated rather than the prompt re-sent.
const VERIFY_SHAPE: &str = r#"{"stories":[{"story":1,"summary":"","criteria":[{"criterion":1,"verdict":"pass","evidence":["ruta/archivo.ext:120"],"note":"","covered_by_test":false}]}]}"#;

/// Turns the model's answer into rows.
///
/// Split out from the command so it is testable without an engine, and defensive in the two ways
/// that matter: a criterion the model skipped stays `unknown` rather than disappearing, and a story
/// or criterion number outside what was actually sent is dropped rather than writing a verdict onto
/// the wrong row.
fn parse_verification(text: &str, criteria_counts: &[usize]) -> Result<Vec<ParsedVerification>, String> {
    let json = ai::json_answer(text).ok_or_else(|| no_json_error(text))?;
    let parsed: ReportedVerification = serde_json::from_str(&json)
        .map_err(|e| format!("El modelo devolvió un JSON que no se pudo leer ({e}). Respondió:\n\n{json}"))?;

    let mut out = Vec::new();
    for reported in parsed.stories {
        let Some(index) = usize::try_from(reported.story - 1).ok().filter(|i| *i < criteria_counts.len())
        else {
            continue;
        };
        let count = criteria_counts[index];
        // Everything starts unknown: a criterion the model quietly skipped is one nobody checked,
        // and that is exactly what `unknown` means.
        let mut verdicts = vec![
            CriterionVerdict {
                verdict: "unknown".to_string(),
                evidence: Vec::new(),
                note: String::new(),
                covered_by_test: false,
            };
            count
        ];
        for criterion in reported.criteria {
            let Some(at) = usize::try_from(criterion.criterion - 1).ok().filter(|i| *i < count) else {
                continue;
            };
            verdicts[at] = CriterionVerdict {
                verdict: normalize_verdict(&criterion.verdict).to_string(),
                evidence: criterion
                    .evidence
                    .iter()
                    .map(|e| e.trim().to_string())
                    .filter(|e| !e.is_empty())
                    .collect(),
                note: criterion.note.trim().to_string(),
                covered_by_test: criterion.covered_by_test,
            };
        }
        out.push(ParsedVerification {
            story: index,
            summary: reported.summary.trim().to_string(),
            criteria: verdicts,
        });
    }

    if out.is_empty() {
        return Err("El modelo no devolvió ningún veredicto".to_string());
    }
    Ok(out)
}

/// Checks the batch's acceptance criteria against the code of every repository it points at.
///
/// Read-only: the engine is pointed at each working copy to *look*. It still takes that
/// repository's AI lease like every other engine run against the folder — skills are synced into
/// `<repo>/.claude/skills` here too, and an agent turn on the same folder would delete and recreate
/// them underneath this run.
///
/// One run per repository, folded into a single verdict per criterion. The alternative — asking the
/// user to pick the one repository a criterion lives in — is a question they cannot answer before
/// the check: which of a service, its BFF and its jobs implements a given behaviour is exactly what
/// is being looked up. See [`merge_verdict`] for why `pass` beats `fail` when they disagree.
///
/// `story_ids` narrows the run; empty means "every story that has criteria". Stories with no
/// criteria are skipped either way — there is nothing to verify, and sending them would invite the
/// model to invent something to say about them.
#[tauri::command]
pub async fn verify_stories(
    app: AppHandle,
    db: State<'_, Db>,
    batch_id: String,
    run_id: Option<String>,
    story_ids: Vec<String>,
    agent_provider: Option<String>,
    agent_model: Option<String>,
) -> Result<StoryBatchDetail, String> {
    let (batch, stories) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let detail = queries::get_story_batch(&conn, &batch_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())?;
        (detail.batch, detail.stories)
    };

    let project_ids = parse_project_ids(&batch.verify_project_ids);
    if project_ids.is_empty() {
        return Err("Elige al menos un repositorio contra el que verificar los criterios".to_string());
    }
    let projects = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut resolved = Vec::with_capacity(project_ids.len());
        for project_id in &project_ids {
            resolved.push(
                queries::get_project(&conn, project_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Ese repositorio ya no existe en este espacio de trabajo".to_string())?,
            );
        }
        resolved
    };

    let targets: Vec<&StoryDraft> = stories
        .iter()
        .filter(|s| story_ids.is_empty() || story_ids.iter().any(|id| id == &s.id))
        .filter(|s| !criteria_of(s).is_empty())
        .collect();
    if targets.is_empty() {
        return Err("No hay criterios de aceptación que verificar".to_string());
    }

    let (contexts, skills, config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &batch.workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &batch.workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::StoryVerify)?,
        };
        let template = queries::get_workspace_prompt(&conn, &batch.workspace_id, "story_verify")
            .map_err(|e| e.to_string())?;
        (contexts, skills, config, template)
    };

    let enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    let payload = build_verification_payload(&targets);
    let criteria_counts: Vec<usize> = targets.iter().map(|s| criteria_of(s).len()).collect();
    let target_ids: Vec<String> = targets.iter().map(|s| s.id.clone()).collect();
    // Evidence comes back relative to the repository root, which is ambiguous the moment there are
    // two roots — so with a set, and only with a set, each path is stamped with the repo it is in.
    let label_repos = projects.len() > 1;

    // One run per repository, inside the scope so Stop reaches all of them. Sequential rather than
    // concurrent on purpose: each run takes that repository's AI lease and reads it with an engine,
    // and two engines answering at once would interleave into one log nobody can follow.
    let result = crate::ai_runs::scoped(app, run_id, async {
        let mut merged: BTreeMap<usize, ParsedVerification> = BTreeMap::new();
        for project in &projects {
            let _repo_lease = ai_locks::acquire(&project.local_path)
                .ok_or_else(|| format!("{}{}", ai_locks::BUSY_MARKER, project.name))?;
            // Best-effort, like the analysis path: an unwritable skills directory shouldn't block a
            // run whose actual job is to read source files.
            let _ = sync_skills_into_project(&skills, &batch.workspace_id, &project.local_path);

            let text = ai::verify_stories_against_code(
                &*config.engine,
                &config.binary,
                &config.model,
                &payload,
                &enabled_contexts,
                &config.tools,
                &project.local_path,
                &template,
                )
            .await?;
            let parsed = parse_or_repair(&config, &text, VERIFY_SHAPE, |answer| {
                parse_verification(answer, &criteria_counts)
            })
            .await?;

            for mut one in parsed {
                if label_repos {
                    for criterion in &mut one.criteria {
                        criterion.evidence = criterion
                            .evidence
                            .iter()
                            .map(|e| format!("{}/{}", project.name, e))
                            .collect();
                    }
                }
                let summary = match (label_repos, one.summary.trim()) {
                    (_, "") => String::new(),
                    (true, text) => format!("{}: {}", project.name, text),
                    (false, text) => text.to_string(),
                };
                match merged.entry(one.story) {
                    Entry::Vacant(slot) => {
                        slot.insert(ParsedVerification {
                            story: one.story,
                            summary,
                            criteria: one.criteria,
                        });
                    }
                    Entry::Occupied(entry) => {
                        let running = entry.into_mut();
                        for (slot, found) in running.criteria.iter_mut().zip(one.criteria) {
                            merge_verdict(slot, found);
                        }
                        if !summary.is_empty() {
                            if !running.summary.is_empty() {
                                running.summary.push('\n');
                            }
                            running.summary.push_str(&summary);
                        }
                    }
                }
            }
        }
        Ok::<Vec<ParsedVerification>, String>(merged.into_values().collect())
    })
    .await;

    // A stopped run leaves every previous verdict exactly as it was — nothing has been written yet.
    // `?` on the next line reports it the same way; the branch exists so the reason is named.
    let parsed = result?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for verification in parsed {
        let status = roll_up(
            &verification.criteria.iter().map(|v| v.verdict.as_str()).collect::<Vec<_>>(),
        );
        let criteria_json =
            serde_json::to_string(&verification.criteria).unwrap_or_else(|_| "[]".to_string());
        queries::save_story_verification(
            &conn,
            &target_ids[verification.story],
            status,
            &verification.summary,
            &criteria_json,
        )
        .map_err(|e| e.to_string())?;
    }
    queries::set_story_batch_verification_run(&conn, &batch_id, &config.provider, &config.model)
        .map_err(|e| e.to_string())?;
    queries::get_story_batch(&conn, &batch_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())
}

// ---------- exporting the criteria as a Cucumber feature ----------

/// Writes the batch's `.feature` file into the one repository chosen to hold it.
///
/// The Gherkin itself is assembled on the frontend (where it is also previewed and copied), so this
/// command only decides *where* it may land: inside `<repo>/features`, under a name with no path in
/// it. A feature file next to the code is the whole point — it is what makes the criteria something
/// QA runs rather than something QA reads.
#[tauri::command]
pub fn write_story_feature_file(
    db: State<Db>,
    batch_id: String,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    let name = file_name.trim();
    // A name is a name, not a path: anything with a separator in it could write outside `features/`
    // (or outside the repository entirely), and no legitimate caller needs to.
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.ends_with(".feature")
    {
        return Err("Nombre de archivo no válido para un .feature".to_string());
    }

    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let detail = queries::get_story_batch(&conn, &batch_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())?;
        // The explicit choice, or the first repository of the verification set when there is none:
        // a set of one has no interesting decision to make, and making the user repeat it there
        // would be a second dropdown that only ever has one option.
        let project_id = detail
            .batch
            .feature_project_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .or_else(|| parse_project_ids(&detail.batch.verify_project_ids).into_iter().next())
            .ok_or_else(|| "Elige el repositorio en el que guardar el .feature".to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Ese repositorio ya no existe en este espacio de trabajo".to_string())?
    };

    let dir = std::path::Path::new(&project.local_path).join("features");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(name);
    std::fs::write(&path, contents).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------- publishing ----------

/// What a publish did, story by story. The whole list comes back rather than only the successes so
/// the view can re-render from one answer — including the rows that failed, which now carry their
/// own reason.
#[derive(Debug, Clone, Serialize)]
pub struct StoryPublishOutcome {
    pub stories: Vec<StoryDraft>,
    pub published: usize,
    pub failed: usize,
}

/// Creates one Azure Boards work item per selected story.
///
/// Every story is attempted even when an earlier one fails — a wrong area path on story three must
/// not strand stories four through ten — and each failure is recorded on its own row instead of
/// aborting the batch. Already-published stories are skipped outright: their `work_item_id` is the
/// record that they exist on the host, and re-publishing would silently double the backlog.
#[tauri::command]
pub async fn publish_stories(
    db: State<'_, Db>,
    batch_id: String,
    story_ids: Vec<String>,
) -> Result<StoryPublishOutcome, String> {
    let (batch, stories) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let detail = queries::get_story_batch(&conn, &batch_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Ese conjunto de historias ya no existe".to_string())?;
        (detail.batch, detail.stories)
    };

    let provider = BoardProvider::parse(&batch.board_provider);
    if batch.ado_org.trim().is_empty() || batch.ado_project.trim().is_empty() {
        return Err(match provider {
            BoardProvider::Azure => {
                "Elige la organización y el proyecto de Azure DevOps antes de publicar".to_string()
            }
            BoardProvider::Jira => "Elige el sitio y el proyecto de Jira antes de publicar".to_string(),
            BoardProvider::Monday => {
                "Elige la cuenta y el tablero de monday.com antes de publicar".to_string()
            }
        });
    }
    if batch.work_item_type.trim().is_empty() {
        return Err(match provider {
            BoardProvider::Azure => "Elige el tipo de work item antes de publicar".to_string(),
            BoardProvider::Jira => "Elige el tipo de incidencia antes de publicar".to_string(),
            BoardProvider::Monday => "Elige el grupo del tablero antes de publicar".to_string(),
        });
    }
    let auth = board_auth(&db, provider, &batch.ado_org)?;

    // One probe for the whole batch: every story publishes as the same type, so asking per story
    // would be one wasted round trip each. A probe that fails is not fatal — see `create_work_item`.
    // Azure only: it is the one that rejects a patch naming a field its type doesn't define.
    let available_fields = match provider {
        BoardProvider::Azure => azure::work_item_type_fields(
            &batch.ado_org,
            &batch.ado_project,
            &batch.work_item_type,
            &auth.secret,
        )
        .await
        .ok(),
        // Neither of the others rejects a whole item over one field it doesn't define, so neither
        // needs the probe: Jira ignores what it doesn't know, and monday is told which columns to
        // write by its own detection pass.
        BoardProvider::Jira | BoardProvider::Monday => None,
    };

    let targets: Vec<&StoryDraft> = stories
        .iter()
        .filter(|s| story_ids.iter().any(|id| id == &s.id))
        .filter(|s| s.work_item_id == 0)
        .collect();
    if targets.is_empty() {
        return Err("No hay historias sin publicar en la selección".to_string());
    }

    let mut published = 0usize;
    let mut failed = 0usize;
    for story in targets {
        let criteria: Vec<String> = serde_json::from_str(&story.acceptance_criteria).unwrap_or_default();
        // The batch's tags apply to every story it publishes, on top of the story's own — that is
        // what the field on the target panel is for.
        let tags = [batch.tags.trim(), story.tags.trim()]
            .iter()
            .filter(|t| !t.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        let item = boards::NewWorkItem {
            title: &story.title,
            narrative: &story.narrative,
            description: &story.description,
            acceptance_criteria: &criteria,
            area_path: &batch.area_path,
            iteration_path: &batch.iteration_path,
            tags: &tags,
            priority: story.priority,
            story_points: story.story_points,
            original_estimate: story.original_estimate,
            remaining_work: story.original_estimate,
        };
        let created = boards::create_work_item(
            provider,
            &batch.ado_org,
            &batch.ado_project,
            &batch.work_item_type,
            &item,
            available_fields.as_ref(),
            &auth,
        )
        .await;

        let conn = db.0.lock().map_err(|e| e.to_string())?;
        match created {
            Ok(reference) => {
                queries::mark_story_published(
                    &conn,
                    &story.id,
                    reference.id,
                    &reference.key,
                    &reference.url,
                )
                .map_err(|e| e.to_string())?;
                published += 1;
            }
            Err(e) => {
                queries::mark_story_error(&conn, &story.id, &e).map_err(|e| e.to_string())?;
                failed += 1;
            }
        }
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let stories = queries::list_story_drafts(&conn, &batch_id).map_err(|e| e.to_string())?;
    Ok(StoryPublishOutcome { stories, published, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The happy path, plus the two shapes a model actually answers in: fenced JSON, and a story
    /// missing half its optional fields.
    #[test]
    fn a_models_answer_becomes_rows() {
        let text = r#"```json
{"stories":[
  {"title":"  Pagar con tarjeta  ","narrative":"Como cliente, quiero pagar, para comprar",
   "description":"contexto","acceptance_criteria":["Dado …\nCuando …\nEntonces …","  "],
   "priority":2,"story_points":3,"tags":["checkout"," "],"notes":""},
  {"title":"Sin extras"}
],"open_questions":["¿Qué pasarela?"," "]}
```"#;
        let (stories, questions) = parse_generated(text).expect("parsed");
        assert_eq!(stories.len(), 2);
        assert_eq!(stories[0].title, "Pagar con tarjeta");
        // Blank criteria and blank tags are dropped rather than published as empty strings.
        assert_eq!(stories[0].acceptance_criteria, r#"["Dado …\nCuando …\nEntonces …"]"#);
        assert_eq!(stories[0].tags, "checkout");
        assert_eq!(stories[1].acceptance_criteria, "[]");
        assert_eq!(stories[1].priority, 0);
        assert_eq!(questions, vec!["¿Qué pasarela?"]);
    }

    /// Out-of-range values would be rejected by Azure at publish time, one story at a time, long
    /// after the generation looked successful.
    #[test]
    fn scales_are_clamped_to_what_azure_accepts() {
        let text = r#"{"stories":[{"title":"X","priority":9,"story_points":-4}]}"#;
        let (stories, _) = parse_generated(text).expect("parsed");
        assert_eq!(stories[0].priority, 4);
        assert_eq!(stories[0].story_points, 0.0);
    }

    /// Three ways a generation can look successful and be worthless. Each has to fail loudly, or
    /// the batch would sit there reporting "ready" with nothing in it.
    #[test]
    fn an_empty_or_unparseable_answer_is_an_error() {
        assert!(parse_generated("No he podido generar historias").is_err());
        assert!(parse_generated(r#"{"stories":[]}"#).is_err());
        assert!(parse_generated(r#"{"stories":[{"title":"   "}]}"#).is_err());
    }

    /// A story's badge is derived, never quoted: whatever the model says in `summary`, the status
    /// has to follow the criteria underneath it.
    #[test]
    fn a_storys_status_follows_its_worst_criterion() {
        assert_eq!(roll_up(&["pass", "pass"]), "pass");
        assert_eq!(roll_up(&["pass", "fail"]), "fail");
        assert_eq!(roll_up(&["partial", "pass"]), "partial");
        // Proven in part, open in the rest — not a pass, and not a total unknown either.
        assert_eq!(roll_up(&["pass", "unknown"]), "partial");
        assert_eq!(roll_up(&["unknown", "unknown"]), "unknown");
        assert_eq!(roll_up(&[]), "unknown");
    }

    /// The improvisations models actually answer with. Every one that isn't a known verdict has to
    /// land on `unknown` — a "sí" read as a pass is a gap QA would stop looking for.
    #[test]
    fn an_unrecognised_verdict_is_never_a_pass() {
        assert_eq!(normalize_verdict("PASS"), "pass");
        assert_eq!(normalize_verdict(" partial "), "partial");
        assert_eq!(normalize_verdict("cumple"), "unknown");
        assert_eq!(normalize_verdict("yes"), "unknown");
        assert_eq!(normalize_verdict(""), "unknown");
    }

    /// The two values `verify_stories` derives from a parsed story before writing the row. Spelled
    /// out here rather than asserted on fields, because `ParsedVerification` stopped carrying them:
    /// the roll-up and the JSON are computed at the write, so a test that reads them off the parse
    /// would be asserting against a shape the production path no longer has.
    fn rolled_up(parsed: &ParsedVerification) -> (&'static str, serde_json::Value) {
        let status =
            roll_up(&parsed.criteria.iter().map(|v| v.verdict.as_str()).collect::<Vec<_>>());
        let json = serde_json::to_value(&parsed.criteria).unwrap();
        (status, json)
    }

    #[test]
    fn a_verification_answer_becomes_verdicts() {
        let text = r#"```json
{"stories":[
  {"story":1,"summary":"  Implementada salvo el límite  ","criteria":[
    {"criterion":1,"verdict":"pass","evidence":[" src/pago.ts:12 ","  "],"note":"","covered_by_test":true},
    {"criterion":2,"verdict":"fail","evidence":[],"note":"No hay validación de importe"}
  ]}
]}
```"#;
        let parsed = parse_verification(text, &[2]).expect("parsed");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].story, 0);
        let (status, verdicts) = rolled_up(&parsed[0]);
        // One failure drags the whole story down, regardless of what the summary claims.
        assert_eq!(status, "fail");
        assert_eq!(parsed[0].summary, "Implementada salvo el límite");
        assert_eq!(verdicts[0]["verdict"], "pass");
        // Blank evidence entries are dropped rather than stored as empty citations.
        assert_eq!(verdicts[0]["evidence"], serde_json::json!(["src/pago.ts:12"]));
        assert_eq!(verdicts[0]["covered_by_test"], true);
        assert_eq!(verdicts[1]["verdict"], "fail");
    }

    /// The two ways a well-formed answer can still be about the wrong rows: a criterion the model
    /// silently skipped, and a number that refers to something that was never sent.
    #[test]
    fn skipped_criteria_stay_unknown_and_stray_numbers_are_dropped() {
        let text = r#"{"stories":[
            {"story":1,"criteria":[{"criterion":1,"verdict":"pass","evidence":["a.ts:1"]},
                                   {"criterion":9,"verdict":"pass","evidence":["b.ts:1"]}]},
            {"story":7,"criteria":[{"criterion":1,"verdict":"pass"}]}
        ]}"#;
        let parsed = parse_verification(text, &[3]).expect("parsed");
        // Story 7 was never sent, so it is dropped rather than written onto some other row.
        assert_eq!(parsed.len(), 1);
        let (status, verdicts) = rolled_up(&parsed[0]);
        assert_eq!(verdicts.as_array().unwrap().len(), 3);
        assert_eq!(verdicts[0]["verdict"], "pass");
        // Criteria 2 and 3 were never answered — nobody checked them, and that is what they say.
        assert_eq!(verdicts[1]["verdict"], "unknown");
        assert_eq!(verdicts[2]["verdict"], "unknown");
        assert_eq!(status, "partial");
    }

    #[test]
    fn an_empty_or_unparseable_verification_is_an_error() {
        assert!(parse_verification("No he podido revisar el repositorio", &[1]).is_err());
        assert!(parse_verification(r#"{"stories":[]}"#, &[1]).is_err());
    }

    /// The payload's numbering is the addressing scheme the answer comes back on, so it has to be
    /// exactly what the prompt promises: stories from 1, criteria from 1 within each story.
    #[test]
    fn the_payload_numbers_stories_and_criteria_from_one() {
        let story = StoryDraft {
            id: "a".into(),
            batch_id: "b".into(),
            seq: 0,
            title: "Pagar".into(),
            narrative: "Como cliente, quiero pagar, para comprar".into(),
            description: "".into(),
            acceptance_criteria: r#"["Escenario: feliz\nDado …","Escenario: error\nDado …"]"#.into(),
            priority: 0,
            story_points: 0.0,
            original_estimate: 0.0,
            tags: String::new(),
            notes: String::new(),
            work_item_id: 0,
            work_item_key: String::new(),
            work_item_url: String::new(),
            verify_status: String::new(),
            verify_summary: String::new(),
            verify_criteria: "[]".into(),
            verified_at: String::new(),
            status: "draft".into(),
            last_error: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let payload = build_verification_payload(&[&story]);
        assert!(payload.contains("HISTORIA 1: Pagar"));
        assert!(payload.contains("Criterio 1:"));
        assert!(payload.contains("Criterio 2:"));
        // A story with no description contributes no empty label to confuse the numbering.
        assert!(!payload.contains("Contexto:"));
    }

    fn finding(issue: &str) -> ReviewFinding {
        ReviewFinding {
            section: "descripcion".to_string(),
            severity: "media".to_string(),
            issue: issue.to_string(),
            proposal: "algo".to_string(),
            evidence: vec![],
            repo: String::new(),
        }
    }

    fn letter(name: &str, verdict: &str, note: &str) -> InvestVerdict {
        InvestVerdict { letter: name.to_string(), verdict: verdict.to_string(), note: note.to_string() }
    }

    /// The checklist belongs to the story, not to a repository, so N answers have to become one —
    /// and the repository that found the story untestable must not be outvoted by the one that had
    /// nothing to say about it.
    #[test]
    fn the_worst_verdict_survives_the_merge() {
        let mut merged = empty_review(ai::WorkItemReviewStage::Analyze);
        merge_review(
            &mut merged,
            WorkItemReview::Analyze {
                summary: "sin problemas".to_string(),
                invest: vec![letter("T", "ok", "")],
                findings: vec![],
            },
            "front",
            true,
        );
        merge_review(
            &mut merged,
            WorkItemReview::Analyze {
                summary: "falta el borde".to_string(),
                invest: vec![letter("T", "missing", "no hay forma de verificarlo")],
                findings: vec![],
            },
            "back",
            true,
        );
        match merged {
            WorkItemReview::Analyze { summary, invest, .. } => {
                assert_eq!(invest.len(), 1, "one letter stays one letter");
                assert_eq!(invest[0].verdict, "missing");
                assert_eq!(invest[0].note, "no hay forma de verificarlo", "the note explains the verdict that won");
                assert_eq!(summary, "front: sin problemas\nback: falta el borde");
            }
            _ => panic!("stage changed under the merge"),
        }
    }

    /// The shape the engines actually get wrong, verbatim: the `invest` array closed one key too
    /// late, so `"findings"` is read as a seventh verdict. It has to come back as *repairable* —
    /// the answer is all there, and failing the run here is what threw away minutes of work.
    #[test]
    fn a_bracket_closed_too_late_is_worth_repairing() {
        let broken = r#"{"summary":"Le falta el camino de error.","invest":[{"letter":"I","verdict":"ok","note":"Independiente."},"findings":[{"section":"criterios","severity":"alta","issue":"x","proposal":"y","evidence":[]}]}"#;
        let error = parse_review(ai::WorkItemReviewStage::Analyze, broken).unwrap_err();
        assert!(error.repairable, "there is a JSON object here, just a malformed one");
        assert!(error.detail.contains("InvestVerdict"), "the parser's own message names the offset");
        assert!(error.message().contains("no se pudo leer"));
    }

    /// The other outcome, which no repair pass can help: the model answered in prose. There is no
    /// syntax to fix, so it must not be sent round again — asking it afresh is the user's call.
    #[test]
    fn an_answer_with_no_json_at_all_is_not_repairable() {
        let error = parse_review(ai::WorkItemReviewStage::Analyze, "La historia me parece correcta.")
            .unwrap_err();
        assert!(!error.repairable);
        assert!(error.message().contains("no devolvió JSON"));
    }

    /// With several repositories each proposal has to say where it came from; with one, saying so
    /// would be noise on every row.
    #[test]
    fn findings_are_tagged_only_when_more_than_one_repository_ran() {
        let mut many = empty_review(ai::WorkItemReviewStage::Analyze);
        merge_review(
            &mut many,
            WorkItemReview::Analyze { summary: String::new(), invest: vec![], findings: vec![finding("a")] },
            "api",
            true,
        );
        let mut one = empty_review(ai::WorkItemReviewStage::Analyze);
        merge_review(
            &mut one,
            WorkItemReview::Analyze { summary: String::new(), invest: vec![], findings: vec![finding("a")] },
            "api",
            false,
        );
        match (many, one) {
            (
                WorkItemReview::Analyze { findings: tagged, .. },
                WorkItemReview::Analyze { findings: untagged, .. },
            ) => {
                assert_eq!(tagged[0].repo, "api");
                assert_eq!(untagged[0].repo, "", "a single repository needs no label");
            }
            _ => panic!("stage changed under the merge"),
        }
    }

    #[test]
    fn every_repository_contributes_its_own_tasks() {
        let mut merged = empty_review(ai::WorkItemReviewStage::Tasks);
        for repo in ["front", "back"] {
            merge_review(
                &mut merged,
                WorkItemReview::Tasks {
                    tasks: vec![ProposedTask {
                        kind: "dev".to_string(),
                        title: format!("[DEV] tocar {repo}"),
                        detail: String::new(),
                        what: String::new(),
                        how: String::new(),
                        why: String::new(),
                        evidence: vec![],
                        repo: String::new(),
                        estimate_hours: 0.0,
                        priority: 0,
                    }],
                },
                repo,
                true,
            );
        }
        match merged {
            WorkItemReview::Tasks { tasks } => {
                assert_eq!(tasks.len(), 2);
                assert_eq!(tasks[0].repo, "front");
                assert_eq!(tasks[1].repo, "back");
            }
            _ => panic!("stage changed under the merge"),
        }
    }

    /// The format field is the one the engines slip on, and the slip is always the same: a format
    /// that names a text the answer did not fill in. The text that *is* there decides.
    #[test]
    fn a_criterion_format_is_re_derived_from_the_text_that_came_back() {
        let text = r#"{"criteria":[
            {"format":"ambos","gherkin":"Dado …","checklist":"","rationale":"","replaces":2},
            {"format":"gherkin","gherkin":"","checklist":"- El campo es obligatorio","rationale":""},
            {"format":"checklist","gherkin":"Dado …","checklist":"- Otra cosa","rationale":""},
            {"format":"gherkin","gherkin":"  ","checklist":"","rationale":"vacío"}
        ]}"#;
        match parse_review(ai::WorkItemReviewStage::Criteria, text).expect("parsed") {
            WorkItemReview::Criteria { criteria } => {
                assert_eq!(criteria.len(), 3, "the one with neither text is dropped");
                assert_eq!(criteria[0].format, "gherkin", "`ambos` with only a scenario is a scenario");
                assert_eq!(criteria[0].replaces, 2, "it rewrites the story's second criterion");
                assert_eq!(criteria[1].format, "checklist");
                assert_eq!(criteria[2].format, "ambos", "both texts filled is genuinely both");
                assert_eq!(criteria[2].replaces, 0, "no number means a new criterion");
            }
            _ => panic!("stage changed under the parse"),
        }
    }

    /// The three questions are what the task is *for*; the board has one field to put them in.
    #[test]
    fn the_three_questions_become_the_detail_that_gets_published() {
        let text = r#"{"tasks":[
            {"kind":"dev","title":"Validar el cupón","what":" El validador ","how":"En checkout.ts","why":"Cubre el criterio 2"},
            {"kind":"dev","title":"Sin cómo","what":"Algo","how":"  ","why":"Por algo"},
            {"kind":"dev","title":"A la antigua","detail":"Una frase suelta"}
        ]}"#;
        match parse_review(ai::WorkItemReviewStage::Tasks, text).expect("parsed") {
            WorkItemReview::Tasks { tasks } => {
                // Markdown, with the label on its own line: the boards render it, and an answer
                // written as a list only *is* a list when its bullets start a line.
                assert_eq!(
                    tasks[0].detail,
                    "**¿Qué?**\nEl validador\n\n**¿Cómo?**\nEn checkout.ts\n\n\
                     **¿Para qué?**\nCubre el criterio 2"
                );
                assert_eq!(tasks[0].what, "El validador", "the parts survive for the editor");
                assert!(!tasks[1].detail.contains("¿Cómo?"), "an empty part gets no heading");
                assert_eq!(tasks[2].detail, "Una frase suelta", "a one-block answer is still read");
            }
            _ => panic!("stage changed under the parse"),
        }
    }

    /// The QA stage owns the `kind`. A model that answered `dev` on the QA run wrote a QA task and
    /// mislabelled it — taking its word would file the ladder under development.
    #[test]
    fn the_qa_stage_forces_the_kind_whatever_the_model_said() {
        let text = r#"{"tasks":[{"kind":"dev","title":"Diseñar casos de prueba","what":"x"}]}"#;
        match parse_review(ai::WorkItemReviewStage::TasksQa, text).expect("parsed") {
            WorkItemReview::Tasks { tasks } => {
                assert_eq!(tasks[0].kind, "qa");
                assert_eq!(tasks[0].title, "[QA] Diseñar casos de prueba");
            }
            _ => panic!("stage changed under the parse"),
        }
    }

    /// "Nothing to propose" is an answer, not a failed run: the description stage is allowed to
    /// come back empty and the screen says so rather than showing a blank panel.
    #[test]
    fn an_empty_description_parses_as_nothing_to_propose() {
        let text = r#"{"description":"","rationale":"","evidence":[]}"#;
        match parse_review(ai::WorkItemReviewStage::Description, text).expect("parsed") {
            WorkItemReview::Description { description, .. } => assert!(description.is_empty()),
            _ => panic!("stage changed under the parse"),
        }
    }

    /// One field, N repositories: the first repository with something to say writes it, and the
    /// second does not append a second description under the first.
    #[test]
    fn only_one_repository_gets_to_rewrite_the_description() {
        let mut merged = empty_review(ai::WorkItemReviewStage::Description);
        for (repo, text) in [("front", ""), ("back", "La descripción buena")] {
            merge_review(
                &mut merged,
                WorkItemReview::Description {
                    description: text.to_string(),
                    rationale: "porque sí".to_string(),
                    evidence: vec![],
                },
                repo,
                true,
            );
        }
        match merged {
            WorkItemReview::Description { description, rationale, .. } => {
                assert_eq!(description, "La descripción buena");
                assert_eq!(rationale, "back: porque sí", "the repository that answered is named");
            }
            _ => panic!("stage changed under the merge"),
        }
    }

    /// The answer that used to cost a whole review, end to end.
    ///
    /// Reported as "expected `,` or `}` at line 1 column 748" and thrown away entirely — minutes
    /// of reading a repository, lost to a quote inside a sentence about two work-item states. It
    /// has to come back through the ordinary parse now, with nothing asked of any model.
    #[test]
    fn the_answer_that_used_to_be_thrown_away_now_parses() {
        let broken = "{\"criteria\":[{\"format\":\"gherkin\",\"gherkin\":\"Dado una OT \"Por planificar\"\nCuando se libera\nEntonces se asigna\",\"checklist\":\"\",\"rationale\":\"Falta el desempate cuando hay una \"Por planificar\" y otra \"Planificado\", y unificar qué es la \"hora de liberación\" vs la \"hora actual\"\",\"replaces\":0,\"evidence\":[]}]}";
        match parse_review(ai::WorkItemReviewStage::Criteria, broken).expect("recovered") {
            WorkItemReview::Criteria { criteria } => {
                assert_eq!(criteria.len(), 1);
                assert!(criteria[0].gherkin.contains("OT \"Por planificar\""));
                assert!(criteria[0].gherkin.contains("\nCuando se libera"), "the newline survived too");
                assert!(criteria[0].rationale.ends_with("vs la \"hora actual\""));
            }
            _ => panic!("stage changed under the parse"),
        }
    }

    /// The other half of the same rescue: a run that hit the token limit keeps every task that
    /// arrived instead of reporting that none did.
    #[test]
    fn a_truncated_task_list_keeps_the_tasks_that_arrived() {
        let cut = r#"{"tasks":[{"kind":"dev","title":"Validar el cupón","what":"El validador","how":"En checkout.ts","why":"Cubre el 2"},{"kind":"dev","title":"Persistir el canje","what":"La tabla de can"#;
        match parse_review(ai::WorkItemReviewStage::Tasks, cut).expect("recovered") {
            WorkItemReview::Tasks { tasks } => {
                assert_eq!(tasks.len(), 2);
                assert_eq!(tasks[0].title, "[DEV] Validar el cupón");
                assert_eq!(tasks[1].what, "La tabla de can", "the half-written task is kept as it stands");
            }
            _ => panic!("stage changed under the parse"),
        }
    }

    /// A `[QA]` title that already carries its marker must not collect a second one.
    #[test]
    fn the_prefix_is_put_on_once_however_the_model_wrote_it() {
        assert_eq!(prefixed_title("qa", "Probar el alta"), "[QA] Probar el alta");
        assert_eq!(prefixed_title("qa", "[QA] Probar el alta"), "[QA] Probar el alta");
        assert_eq!(prefixed_title("qa", "[Dev] Probar el alta"), "[QA] Probar el alta");
        assert_eq!(prefixed_title("dev", "[DEV] [QA] Mover"), "[DEV] Mover");
        assert_eq!(prefixed_title("cualquier-cosa", "Mover"), "[DEV] Mover", "unknown kinds are dev");
    }

    /// The estimation model has to reach the prompt whichever shape the team left its ladder in —
    /// including the ladder somebody customised before the model was a separate text, which has no
    /// slot to put it in.
    #[test]
    fn the_estimation_model_reaches_the_qa_prompt_with_or_without_a_slot() {
        let with_slot = "Devuelve cinco tareas.\n\n{{ESTIMACION_QA}}\n\n=== SALIDA ===";
        let spliced = with_qa_estimation(with_slot, "TABLA");
        assert!(spliced.contains("TABLA"));
        assert!(!spliced.contains(ai::QA_ESTIMATION_SLOT), "the slot is consumed, not left behind");
        assert!(spliced.ends_with("=== SALIDA ==="), "the slot is where the team put it");

        let customised = "Mi escalera de QA de cuatro pasos.";
        assert_eq!(
            with_qa_estimation(customised, "TABLA"),
            "Mi escalera de QA de cuatro pasos.\n\nTABLA",
            "a template with no slot still gets the hours"
        );
    }

    /// A blanked model is a team estimating by hand — it must not leave the unreplaced placeholder
    /// in the prompt, which is the model being told to read a table nobody sent.
    #[test]
    fn a_blank_estimation_model_takes_the_slot_with_it() {
        let template = "Devuelve cinco tareas.\n\n{{ESTIMACION_QA}}";
        assert_eq!(with_qa_estimation(template, "   \n  "), "Devuelve cinco tareas.");
    }

    /// The default ladder has to carry the slot: without it every run would append the table after
    /// the output rules, which is the one place it reads worst.
    #[test]
    fn the_default_qa_ladder_carries_the_slot() {
        assert!(ai::DEFAULT_WORK_ITEM_TASKS_QA_TEMPLATE.contains(ai::QA_ESTIMATION_SLOT));
    }

    /// The `[QA]` on the title and the fields the board files the task under have to say the same
    /// thing — they are the same fact, and a task labelled QA that lands under Development is one
    /// nobody's testing query will ever find.
    #[test]
    fn a_qa_task_is_filed_as_testing_and_a_dev_task_is_not() {
        assert_eq!(task_kind_fields("qa"), ("Testing", "QA"));
        assert_eq!(task_kind_fields("QA"), ("Testing", "QA"));
        assert_eq!(task_kind_fields("dev"), ("Development", "DEV"));
        assert_eq!(task_kind_fields(""), ("Development", "DEV"), "unknown kinds are dev");
    }

    /// The estimate is the model's guess and the field is somebody's sprint capacity, so anything
    /// that is not a number of hours a person could work has to lose its answer rather than the
    /// board gain a wrong one.
    #[test]
    fn only_an_estimate_a_person_could_work_survives() {
        assert_eq!(sane_estimate(4.0), 4.0);
        assert_eq!(sane_estimate(3.7), 3.5, "rounded to the half hour it actually knows");
        assert_eq!(sane_estimate(0.0), 0.0, "unset stays unset");
        assert_eq!(sane_estimate(0.1), 0.0, "answered in minutes, or in days");
        assert_eq!(sane_estimate(480.0), 0.0, "a number nobody plans a sprint with");
        assert_eq!(sane_estimate(f64::NAN), 0.0);

        assert_eq!(clamped_priority(1), 1);
        assert_eq!(clamped_priority(4), 4);
        assert_eq!(clamped_priority(0), 0);
        assert_eq!(clamped_priority(5), 0, "outside Azure's scale is no answer at all");
        assert_eq!(clamped_priority(-2), 0);
    }
}
