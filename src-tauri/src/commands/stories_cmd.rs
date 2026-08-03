//! The user-stories workspace: read documentation, derive a backlog, publish it to Azure Boards.
//!
//! Three concerns meet here and are deliberately kept apart:
//!
//! - **Reading** the source. An Azure DevOps wiki through [`crate::boards`]; local Markdown and
//!   pasted text arrive already gathered from the frontend (which has the file reader and the
//!   textarea), so this layer never has to know which one it was.
//! - **Deriving** the stories. One text-in/JSON-out call through [`crate::ai`], routed like every
//!   other AI action ([`AiTask::Stories`]) and cancellable like every other run.
//! - **Publishing**. One work item per story, with the story's own row recording what it became —
//!   which is what makes a second click on "publish" a no-op rather than a duplicate backlog.
//!
//! Nothing here touches a repository. A requirement is written before the code that satisfies it,
//! and the whole screen is usable in a workspace that has no project at all.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ai;
use crate::ai_locks;
use crate::boards;
use crate::commands::ado_cmd::{build_mcp_config, pat_for_org};
use crate::commands::claude_cmd::{load_ai_config, load_ai_config_for, AiTask};
use crate::commands::skills_cmd::sync_skills_into_project;
use crate::db::{
    models::{StoryBatch, StoryBatchDetail, StoryDraft},
    queries::{self, NewStoryDraft},
    Db,
};

// ---------- reading the source ----------

#[tauri::command]
pub async fn ado_list_wikis(org: String, project: String) -> Result<Vec<boards::AdoWiki>, String> {
    let pat = pat_for_org(&org)?;
    boards::list_wikis(&org, &project, &pat).await
}

#[tauri::command]
pub async fn ado_list_wiki_pages(
    org: String,
    project: String,
    wiki: String,
) -> Result<Vec<boards::AdoWikiPage>, String> {
    let pat = pat_for_org(&org)?;
    boards::list_wiki_pages(&org, &project, &wiki, &pat).await
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
    boards::get_wiki_pages_combined(&org, &project, &wiki, &paths, &pat).await
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
) -> Result<boards::AdoWikiPageRef, String> {
    let pat = pat_for_org(&org)?;
    boards::put_wiki_page(&org, &project, &wiki, &path, &content, &pat).await
}

// ---------- the Azure Boards target ----------

#[tauri::command]
pub async fn ado_list_work_item_types(
    org: String,
    project: String,
) -> Result<Vec<boards::AdoWorkItemType>, String> {
    let pat = pat_for_org(&org)?;
    boards::list_work_item_types(&org, &project, &pat).await
}

/// `structure` is `areas` or `iterations`.
#[tauri::command]
pub async fn ado_list_classification_nodes(
    org: String,
    project: String,
    structure: String,
) -> Result<Vec<boards::AdoClassificationNode>, String> {
    let pat = pat_for_org(&org)?;
    boards::list_classification_nodes(&org, &project, &structure, &pat).await
}

// ---------- reviewing a story that is already on the board ----------

/// Resolves whatever the user pasted into the organisation, project and id it names.
///
/// Kept in Rust rather than done in the frontend so there is one answer to "what counts as a work
/// item reference" — the same one that then has to fetch it.
#[tauri::command]
pub fn ado_parse_work_item_ref(input: String) -> Result<boards::WorkItemRef, String> {
    boards::parse_work_item_ref(&input)
        .ok_or_else(|| "Pega el enlace de un work item de Azure DevOps, o su número".to_string())
}

/// One work item and the children it already has, for the review screen to read.
#[tauri::command]
pub async fn ado_get_work_item(org: String, id: i64) -> Result<boards::AdoWorkItem, String> {
    let pat = pat_for_org(&org)?;
    boards::get_work_item(&org, id, &pat).await
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
    /// One whole Gherkin scenario.
    pub gherkin: String,
    pub rationale: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// See [`ReviewFinding::repo`].
    #[serde(default)]
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedTask {
    /// `dev` | `qa`.
    pub kind: String,
    /// Already carries its `[DEV]` or `[QA]` prefix — see [`prefixed_title`].
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    /// See [`ReviewFinding::repo`].
    #[serde(default)]
    pub repo: String,
}

/// What one stage of the review answered. Tagged by stage so the frontend reads the shape it asked
/// for rather than guessing from which arrays came back non-empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "lowercase")]
pub enum WorkItemReview {
    Analyze { summary: String, invest: Vec<InvestVerdict>, findings: Vec<ReviewFinding> },
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
struct RawCriteria {
    #[serde(default)]
    criteria: Vec<ProposedCriterion>,
}

#[derive(Deserialize)]
struct RawTasks {
    #[serde(default)]
    tasks: Vec<ProposedTask>,
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
        ai::WorkItemReviewStage::Criteria => {
            r#"{"criteria":[{"gherkin":"Dado ...\nCuando ...\nEntonces ...","rationale":"","evidence":[]}]}"#
        }
        ai::WorkItemReviewStage::Tasks => r#"{"tasks":[{"kind":"dev","title":"","detail":"","evidence":[]}]}"#,
    }
}

/// Split out from the command so it is testable without an engine.
fn parse_review(stage: ai::WorkItemReviewStage, text: &str) -> Result<WorkItemReview, ReviewParseError> {
    let Some(json) = ai::extract_json_block(text) else {
        return Err(ReviewParseError {
            detail: "no hay ningún objeto JSON en la respuesta".to_string(),
            payload: text.trim().to_string(),
            repairable: false,
        });
    };
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
        ai::WorkItemReviewStage::Criteria => {
            let parsed: RawCriteria = serde_json::from_str(json).map_err(unreadable)?;
            Ok(WorkItemReview::Criteria {
                criteria: parsed.criteria.into_iter().filter(|c| !c.gherkin.trim().is_empty()).collect(),
            })
        }
        ai::WorkItemReviewStage::Tasks => {
            let parsed: RawTasks = serde_json::from_str(json).map_err(unreadable)?;
            Ok(WorkItemReview::Tasks {
                tasks: parsed
                    .tasks
                    .into_iter()
                    .filter(|t| !t.title.trim().is_empty())
                    .map(|t| ProposedTask {
                        title: prefixed_title(&t.kind, &t.title),
                        kind: if t.kind.eq_ignore_ascii_case("qa") { "qa".to_string() } else { "dev".to_string() },
                        detail: t.detail.trim().to_string(),
                        evidence: t.evidence,
                        // Stamped by the merge once it knows whether more than one repository ran.
                        repo: String::new(),
                    })
                    .collect(),
            })
        }
    }
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
        ai::WorkItemReviewStage::Criteria => WorkItemReview::Criteria { criteria: Vec::new() },
        ai::WorkItemReviewStage::Tasks => WorkItemReview::Tasks { tasks: Vec::new() },
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
        (ai::WorkItemReviewStage::Criteria, _) => "work_item_criteria",
        (ai::WorkItemReviewStage::Tasks, _) => "work_item_tasks",
    };

    let (contexts, mcps, skills, config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            // Same routing as the verification run: both read code to judge a requirement, so a
            // team that picked a model for one meant it for the other.
            _ => load_ai_config(&conn, AiTask::StoryVerify)?,
        };
        let template =
            queries::get_workspace_prompt(&conn, &workspace_id, prompt_kind).map_err(|e| e.to_string())?;
        (contexts, mcps, skills, config, template)
    };

    let enabled_contexts: Vec<(String, String)> = match use_context {
        true => contexts.into_iter().filter(|c| c.enabled).map(|c| (c.name, c.content)).collect(),
        false => Vec::new(),
    };
    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;
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
                mcp_config_path.as_deref(),
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
        version: ai::engine_version(&*config.engine, &config.binary).await.unwrap_or_default(),
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
) -> Result<boards::AdoWikiPageRef, String> {
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
    let published = boards::put_wiki_page(
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

    let (contexts, mcps, skills, config, repo_template, workspace_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            // Same routing as the review: both read a whole repository to say something about it.
            _ => load_ai_config(&conn, AiTask::StoryVerify)?,
        };
        let repo_template =
            queries::get_workspace_prompt(&conn, &workspace_id, "repo_doc").map_err(|e| e.to_string())?;
        let workspace_template = queries::get_workspace_prompt(&conn, &workspace_id, "workspace_doc")
            .map_err(|e| e.to_string())?;
        (contexts, mcps, skills, config, repo_template, workspace_template)
    };

    let enabled_contexts: Vec<(String, String)> = match use_context {
        true => contexts.into_iter().filter(|c| c.enabled).map(|c| (c.name, c.content)).collect(),
        false => Vec::new(),
    };
    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

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
                mcp_config_path.as_deref(),
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

    let version = ai::engine_version(&*config.engine, &config.binary).await.unwrap_or_default();
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
pub async fn ado_update_work_item(
    org: String,
    id: i64,
    title: Option<String>,
    description: Option<String>,
    repro_steps: Option<String>,
    acceptance_criteria: Option<Vec<String>>,
) -> Result<boards::AdoWorkItemRef, String> {
    let pat = pat_for_org(&org)?;
    let edit = boards::WorkItemEdit { title, description, repro_steps, acceptance_criteria };
    boards::update_work_item(&org, id, &edit, &pat).await
}

/// What one proposed task becomes on the board.
#[derive(Debug, Clone, Deserialize)]
pub struct NewChildTask {
    pub title: String,
    #[serde(default)]
    pub detail: String,
}

/// Creates the accepted tasks as children of the story, in the order the user arranged them.
///
/// Sequential rather than concurrent, and it stops at the first failure reporting what did land.
/// Azure's rate limits are per-organisation and a burst of twelve creates is exactly the shape that
/// trips them — and a partial publish the user can *see* is recoverable, while twelve half-created
/// tasks in an unknown order is not.
#[tauri::command]
pub async fn ado_create_child_tasks(
    org: String,
    project: String,
    parent_id: i64,
    work_item_type: String,
    tasks: Vec<NewChildTask>,
) -> Result<Vec<boards::AdoWorkItemRef>, String> {
    if tasks.is_empty() {
        return Err("No hay tareas que publicar".to_string());
    }
    let pat = pat_for_org(&org)?;
    let mut created = Vec::with_capacity(tasks.len());
    for task in &tasks {
        match boards::create_child_work_item(
            &org,
            &project,
            parent_id,
            &work_item_type,
            &task.title,
            &task.detail,
            &pat,
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
    ado_org: String,
    ado_project: String,
    work_item_type: String,
    area_path: String,
    iteration_path: String,
    tags: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_story_batch_target(
        &conn,
        &id,
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

/// The repository whose code this batch's criteria are checked against. `None` clears it.
///
/// Deliberately not the same field as the batch's `project_id`: that one records where the source
/// Markdown was read from, and a backlog derived from a product wiki is routinely verified against
/// a service repository that had nothing to do with writing it.
#[tauri::command]
pub fn set_story_batch_verify_project(
    db: State<Db>,
    id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let project_id = project_id.filter(|p| !p.trim().is_empty());
    queries::set_story_batch_verify_project(&conn, &id, project_id.as_deref()).map_err(|e| e.to_string())
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

/// Turns the model's answer into rows.
///
/// Split out from the command so it is testable without an engine: this is where a plausible-looking
/// reply that is actually empty (`{"stories": []}`) has to be caught, because everything downstream
/// would otherwise report a successful generation of nothing.
fn parse_generated(text: &str) -> Result<(Vec<NewStoryDraft>, Vec<String>), String> {
    let json = ai::extract_json_block(text)
        .ok_or_else(|| format!("El modelo no devolvió JSON. Respondió:\n\n{}", text.trim()))?;
    let parsed: GeneratedBatch = serde_json::from_str(json)
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
    count: i64,
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

    let result = crate::ai_runs::scoped(app, run_id, async {
        ai::generate_user_stories(
            &*config.engine,
            &config.binary,
            &config.model,
            &batch.source_text,
            &batch.instructions,
            count,
            &template,
        )
        .await
    })
    .await;

    // A stopped run leaves the batch exactly as it was, like every other cancellable run in the app.
    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_story_batch_status(&conn, &batch_id, "draft", "").map_err(|e| e.to_string())?;
        return Err(result.unwrap_err());
    }

    let parsed = result.and_then(|text| parse_generated(&text));
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match parsed {
        Ok((stories, questions)) => {
            queries::replace_story_drafts(&conn, &batch_id, &stories).map_err(|e| e.to_string())?;
            let questions_json = serde_json::to_string(&questions).unwrap_or_else(|_| "[]".to_string());
            queries::set_story_batch_run(&conn, &batch_id, &config.provider, &config.model, &questions_json)
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

/// One story's verdicts, ready to be written to its row.
struct ParsedVerification {
    /// Zero-based index into the list of stories that were sent.
    story: usize,
    status: &'static str,
    summary: String,
    /// JSON array, exactly one entry per criterion of that story.
    criteria_json: String,
}

/// Turns the model's answer into rows.
///
/// Split out from the command so it is testable without an engine, and defensive in the two ways
/// that matter: a criterion the model skipped stays `unknown` rather than disappearing, and a story
/// or criterion number outside what was actually sent is dropped rather than writing a verdict onto
/// the wrong row.
fn parse_verification(text: &str, criteria_counts: &[usize]) -> Result<Vec<ParsedVerification>, String> {
    let json = ai::extract_json_block(text)
        .ok_or_else(|| format!("El modelo no devolvió JSON. Respondió:\n\n{}", text.trim()))?;
    let parsed: ReportedVerification = serde_json::from_str(json)
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
        let status = roll_up(&verdicts.iter().map(|v| v.verdict.as_str()).collect::<Vec<_>>());
        out.push(ParsedVerification {
            story: index,
            status,
            summary: reported.summary.trim().to_string(),
            criteria_json: serde_json::to_string(&verdicts).unwrap_or_else(|_| "[]".to_string()),
        });
    }

    if out.is_empty() {
        return Err("El modelo no devolvió ningún veredicto".to_string());
    }
    Ok(out)
}

/// Checks the batch's acceptance criteria against the code of the repository it points at.
///
/// Read-only: the engine is pointed at the working copy to *look*. It still takes the repository's
/// AI lease like every other engine run against that folder — skills are synced into
/// `<repo>/.claude/skills` here too, and an agent turn on the same folder would delete and recreate
/// them underneath this run.
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

    let project_id = batch
        .verify_project_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "Elige el repositorio contra el que verificar los criterios".to_string())?;
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Ese repositorio ya no existe en este espacio de trabajo".to_string())?
    };

    let targets: Vec<&StoryDraft> = stories
        .iter()
        .filter(|s| story_ids.is_empty() || story_ids.iter().any(|id| id == &s.id))
        .filter(|s| !criteria_of(s).is_empty())
        .collect();
    if targets.is_empty() {
        return Err("No hay criterios de aceptación que verificar".to_string());
    }

    let _repo_lease = ai_locks::acquire(&project.local_path)
        .ok_or_else(|| format!("{}{}", ai_locks::BUSY_MARKER, project.name))?;

    let (contexts, mcps, skills, config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &batch.workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &batch.workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &batch.workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::StoryVerify)?,
        };
        let template = queries::get_workspace_prompt(&conn, &batch.workspace_id, "story_verify")
            .map_err(|e| e.to_string())?;
        (contexts, mcps, skills, config, template)
    };

    // Best-effort, like the analysis path: an unwritable skills directory shouldn't block a run
    // whose actual job is to read source files.
    let _ = sync_skills_into_project(&skills, &batch.workspace_id, &project.local_path);

    let enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    let mcp_config_path = build_mcp_config(&mcps, &batch.workspace_id)?;
    let payload = build_verification_payload(&targets);
    let criteria_counts: Vec<usize> = targets.iter().map(|s| criteria_of(s).len()).collect();
    let target_ids: Vec<String> = targets.iter().map(|s| s.id.clone()).collect();

    let result = crate::ai_runs::scoped(app, run_id, async {
        ai::verify_stories_against_code(
            &*config.engine,
            &config.binary,
            &config.model,
            &payload,
            &enabled_contexts,
            &config.tools,
            &project.local_path,
            &template,
            mcp_config_path.as_deref(),
        )
        .await
    })
    .await;

    // A stopped run leaves every previous verdict exactly as it was — nothing has been written yet.
    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return Err(result.unwrap_err());
    }

    let parsed = result.and_then(|text| parse_verification(&text, &criteria_counts))?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for verification in parsed {
        queries::save_story_verification(
            &conn,
            &target_ids[verification.story],
            verification.status,
            &verification.summary,
            &verification.criteria_json,
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

/// Writes the batch's `.feature` file into the repository it is verified against.
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
        let project_id = detail
            .batch
            .verify_project_id
            .clone()
            .filter(|id| !id.trim().is_empty())
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

    if batch.ado_org.trim().is_empty() || batch.ado_project.trim().is_empty() {
        return Err("Elige la organización y el proyecto de Azure DevOps antes de publicar".to_string());
    }
    if batch.work_item_type.trim().is_empty() {
        return Err("Elige el tipo de work item antes de publicar".to_string());
    }
    let pat = pat_for_org(&batch.ado_org)?;

    // One probe for the whole batch: every story publishes as the same type, so asking per story
    // would be one wasted round trip each. A probe that fails is not fatal — see `create_work_item`.
    let available_fields =
        boards::work_item_type_fields(&batch.ado_org, &batch.ado_project, &batch.work_item_type, &pat)
            .await
            .ok();

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
        };
        let created = boards::create_work_item(
            &batch.ado_org,
            &batch.ado_project,
            &batch.work_item_type,
            &item,
            available_fields.as_ref(),
            &pat,
        )
        .await;

        let conn = db.0.lock().map_err(|e| e.to_string())?;
        match created {
            Ok(reference) => {
                queries::mark_story_published(&conn, &story.id, reference.id, &reference.url)
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
        // One failure drags the whole story down, regardless of what the summary claims.
        assert_eq!(parsed[0].status, "fail");
        assert_eq!(parsed[0].summary, "Implementada salvo el límite");
        let verdicts: serde_json::Value = serde_json::from_str(&parsed[0].criteria_json).unwrap();
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
        let verdicts: serde_json::Value = serde_json::from_str(&parsed[0].criteria_json).unwrap();
        assert_eq!(verdicts.as_array().unwrap().len(), 3);
        assert_eq!(verdicts[0]["verdict"], "pass");
        // Criteria 2 and 3 were never answered — nobody checked them, and that is what they say.
        assert_eq!(verdicts[1]["verdict"], "unknown");
        assert_eq!(verdicts[2]["verdict"], "unknown");
        assert_eq!(parsed[0].status, "partial");
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
            tags: String::new(),
            notes: String::new(),
            work_item_id: 0,
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
                        evidence: vec![],
                        repo: String::new(),
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

    /// A `[QA]` title that already carries its marker must not collect a second one.
    #[test]
    fn the_prefix_is_put_on_once_however_the_model_wrote_it() {
        assert_eq!(prefixed_title("qa", "Probar el alta"), "[QA] Probar el alta");
        assert_eq!(prefixed_title("qa", "[QA] Probar el alta"), "[QA] Probar el alta");
        assert_eq!(prefixed_title("qa", "[Dev] Probar el alta"), "[QA] Probar el alta");
        assert_eq!(prefixed_title("dev", "[DEV] [QA] Mover"), "[DEV] Mover");
        assert_eq!(prefixed_title("cualquier-cosa", "Mover"), "[DEV] Mover", "unknown kinds are dev");
    }
}
