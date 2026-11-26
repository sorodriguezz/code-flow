//! «Relacionadas» in the Notes view: the notes a note is related to, comparing it with the rest,
//! asking a model which continue it, and linking or separating two by hand. The rules are in
//! [`crate::note_relations`].

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::claude_cmd::{load_ai_config_in, AiTask};
use crate::db::Db;
use crate::meetings::ai::Runner;
use crate::note_relations::{self as relations, judge, prep, RelationView};

/// A note's relations changed: `{ noteId }`.
pub const CHANGED_EVENT: &str = "notes:relations";

fn db_err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// The notes this one is related to: the ones it continues or that continue it, with what was
/// settled or left open between them, and the ones that are about the same thing.
#[tauri::command]
pub fn notes_list_relations(db: State<Db>, note_id: String, workspace_id: Option<String>) -> Result<Vec<RelationView>, String> {
    let conn = db.0.lock().map_err(db_err)?;
    relations::list_for(&conn, &note_id, workspace_id.as_deref()).map_err(db_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    relations: Vec<RelationView>,
    /// Which engine read them: a provider id, `local`, or empty when no model was asked.
    engine: String,
    /// A model was to read them and there was nothing alike to read.
    nothing: bool,
}

/// Compares a note with the rest of its workspace and links the ones about the same thing; with
/// `ai`, a model then reads the note and its look-alikes and says which it continues, what was
/// settled since and what is still open — on the «Reuniones» or «Notas» engine, or on the local
/// model when the note's book is local-only (other local-only notes are never sent to a service).
///
/// Without `force`, the comparison is skipped while nothing was written since the last one.
#[tauri::command]
pub async fn notes_relate(
    app: AppHandle,
    note_id: String,
    ai: bool,
    force: Option<bool>,
    language: Option<String>,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<Related, String> {
    let list = |app: &AppHandle| -> Result<Vec<RelationView>, String> {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        relations::list_for(&conn, &note_id, workspace_id.as_deref()).map_err(db_err)
    };
    let brief = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        if force.unwrap_or(false) || ai || relations::stale(&conn, &note_id).map_err(db_err)? {
            relations::scan(&conn, &note_id)?;
        }
        if !ai {
            None
        } else {
            let local_only = crate::db::meeting_queries::note_is_local_only(&conn, &note_id).map_err(db_err)?;
            relations::brief(&conn, &note_id, !local_only)?
        }
    };
    let Some(brief) = brief else {
        let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "noteId": note_id }));
        return Ok(Related { relations: list(&app)?, engine: String::new(), nothing: ai });
    };
    let asked: Vec<String> = brief.candidates.iter().map(|(shown, _)| shown.id.clone()).collect();
    let ask = judge::ask(language.as_deref().unwrap_or_default());
    let task = if brief.meeting { AiTask::Meetings } else { AiTask::Notes };
    let (written, engine) =
        ask_model(&app, brief.local_only, task, workspace_id.as_deref(), run_id, judge::SYSTEM, &ask, |budget| judge::context(&brief.main, &brief.candidates, budget.min(30_000))).await?;
    let verdicts = judge::parse(&written, &asked)?;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        relations::apply(&conn, &note_id, &verdicts)?;
    }
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "noteId": note_id }));
    Ok(Related { relations: list(&app)?, engine, nothing: false })
}

/// One question to a model about notes: on the local model when the note's book is local-only,
/// else on `task`'s engine. `context` is what goes on standard input, for the characters the model
/// has room for. Answers with what it wrote and which engine it was — a provider id, or `local`.
async fn ask_model(
    app: &AppHandle,
    local_only: bool,
    task: AiTask,
    workspace_id: Option<&str>,
    run_id: Option<String>,
    system: &str,
    ask: &str,
    context: impl FnOnce(usize) -> String,
) -> Result<(String, String), String> {
    if local_only {
        let settings = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(db_err)?;
            crate::hybrid::config::read(&conn)?
        };
        let resolved = crate::hybrid::runtime::resolve(&settings, crate::hybrid::runtime::Freshness::Recent).await;
        if let Some(error) = resolved.error.clone() {
            return Err(format!("MEETINGS_LOCAL_UNAVAILABLE: {error}"));
        }
        let model = resolved.model.clone().ok_or("MEETINGS_LOCAL_UNAVAILABLE: no local model is set up")?;
        let live = crate::hybrid::runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
        let runner = Runner::Local { endpoint: live.endpoint.clone(), model: live.model.clone(), ctx: resolved.ctx, label: "Local model" };
        let context = context(runner.budget());
        let written = crate::ai_runs::scoped(app.clone(), run_id, async { runner.call_as(system, ask, &context).await }).await?;
        return Ok((written, "local".to_string()));
    }
    let config = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        load_ai_config_in(&conn, task, workspace_id)?
    };
    let context = context(600_000);
    let provider = config.provider.clone();
    let written = crate::ai_runs::scoped(app.clone(), run_id, async {
        let runner = Runner::Cli { engine: &*config.engine, binary: &config.binary, model: &config.model };
        runner.call_as(system, ask, &context).await
    })
    .await?;
    Ok((written, provider))
}

/// One of the earlier notes a preparation read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepSource {
    id: String,
    title: String,
    /// `YYYY-MM-DD`.
    date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// What to know, ask and decide, each line with the title of the note it came from.
    proposal: prep::Proposal,
    /// The earlier notes the model was shown.
    sources: Vec<PrepSource>,
    /// Which engine read them: a provider id, `local`, or empty when no model was asked.
    engine: String,
    /// No earlier note speaks of the subject: no model was asked.
    nothing: bool,
}

/// «Preparar reunión»: finds the earlier notes and meetings that speak of `topic` and asks a model
/// what is already known, what to ask, what has to be decided and what is still at risk — on the
/// «Notas» engine, or on the local model when the note's book is local-only (other local-only notes
/// are never sent to a service). Writes nothing: the window puts the answer in the note.
#[tauri::command]
pub async fn notes_prepare_meeting(app: AppHandle, note_id: String, topic: String, language: Option<String>, run_id: Option<String>, workspace_id: Option<String>) -> Result<Prepared, String> {
    let brief = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(db_err)?;
        let local_only = crate::db::meeting_queries::note_is_local_only(&conn, &note_id).map_err(db_err)?;
        relations::prep_brief(&conn, &note_id, &topic, !local_only)?
    };
    let sources: Vec<PrepSource> = brief.sources.iter().map(|shown| PrepSource { id: shown.id.clone(), title: shown.title.clone(), date: shown.date.clone() }).collect();
    if brief.sources.is_empty() {
        return Ok(Prepared { proposal: prep::Proposal::default(), sources, engine: String::new(), nothing: true });
    }
    let ask = prep::ask(language.as_deref().unwrap_or_default());
    let (topic, _) = crate::secret_scan::redact(&topic);
    let (written, engine) =
        ask_model(&app, brief.local_only, AiTask::Notes, workspace_id.as_deref(), run_id, prep::SYSTEM, &ask, |budget| prep::context(&topic, &brief.own, &brief.sources, &brief.open, budget.min(40_000))).await?;
    let proposal = prep::parse(&written, &brief.sources)?;
    Ok(Prepared { proposal, sources, engine, nothing: false })
}

/// Links two notes by hand, as related: a pair that comparing them never undoes.
#[tauri::command]
pub fn notes_add_relation(app: AppHandle, db: State<Db>, note_id: String, other_id: String) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(db_err)?;
        relations::link(&conn, &note_id, &other_id)?;
    }
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "noteId": note_id }));
    Ok(())
}

/// Separates two related notes: the pair is not offered again. Neither note is touched.
#[tauri::command]
pub fn notes_remove_relation(app: AppHandle, db: State<Db>, note_id: String, other_id: String) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(db_err)?;
        relations::unlink(&conn, &note_id, &other_id)?;
    }
    let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "noteId": note_id }));
    Ok(())
}
