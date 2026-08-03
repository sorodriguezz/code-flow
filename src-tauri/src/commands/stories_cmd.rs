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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedCriterion {
    /// One whole Gherkin scenario.
    pub gherkin: String,
    pub rationale: String,
    #[serde(default)]
    pub evidence: Vec<String>,
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
}

/// What one stage of the review answered. Tagged by stage so the frontend reads the shape it asked
/// for rather than guessing from which arrays came back non-empty.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "lowercase")]
pub enum WorkItemReview {
    Analyze { summary: String, invest: Vec<InvestVerdict>, findings: Vec<ReviewFinding> },
    Criteria { criteria: Vec<ProposedCriterion> },
    Tasks { tasks: Vec<ProposedTask> },
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

/// Split out from the command so it is testable without an engine.
fn parse_review(stage: ai::WorkItemReviewStage, text: &str) -> Result<WorkItemReview, String> {
    let json = ai::extract_json_block(text)
        .ok_or_else(|| format!("El modelo no devolvió JSON. Respondió:\n\n{}", text.trim()))?;
    let unreadable =
        |e: serde_json::Error| format!("El modelo devolvió un JSON que no se pudo leer ({e}). Respondió:\n\n{json}");

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
                    })
                    .collect(),
            })
        }
    }
}

/// Runs one stage of the review against a repository.
///
/// `story_text` is assembled by the frontend from the work item it fetched, because that is where
/// Azure's HTML is turned into the text the user is looking at — sending anything else would judge
/// a story the user never saw.
#[tauri::command]
pub async fn review_work_item(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: String,
    project_id: String,
    stage: ai::WorkItemReviewStage,
    story_text: String,
    run_id: Option<String>,
    agent_provider: Option<String>,
    agent_model: Option<String>,
) -> Result<WorkItemReview, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Elige el repositorio contra el que revisar la historia".to_string())?
    };

    let _repo_lease = ai_locks::acquire(&project.local_path)
        .ok_or_else(|| format!("{}{}", ai_locks::BUSY_MARKER, project.name))?;

    let prompt_kind = match stage {
        ai::WorkItemReviewStage::Analyze => "work_item_analyze",
        ai::WorkItemReviewStage::Criteria => "work_item_criteria",
        ai::WorkItemReviewStage::Tasks => "work_item_tasks",
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

    let _ = sync_skills_into_project(&skills, &workspace_id, &project.local_path);

    let enabled_contexts: Vec<(String, String)> =
        contexts.into_iter().filter(|c| c.enabled).map(|c| (c.name, c.content)).collect();
    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let result = crate::ai_runs::scoped(app, run_id, async {
        ai::review_work_item(
            &*config.engine,
            &config.binary,
            &config.model,
            stage,
            &story_text,
            &enabled_contexts,
            &config.tools,
            &project.local_path,
            &template,
            mcp_config_path.as_deref(),
        )
        .await
    })
    .await;

    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return Err(result.unwrap_err());
    }
    parse_review(stage, &result?)
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
}
