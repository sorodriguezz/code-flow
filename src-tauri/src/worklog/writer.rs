//! The summary written by a model: the engine the user picked where they asked for it (the
//! form's model picker, a flow node's engine) or, left automatic, the Notes row's — a summary is
//! written into a note, the way Reuniones follows that row too. Text only and read-only: the facts
//! go on stdin and Markdown comes back (`ai::worklog_write`, a lean run).
//!
//! **Never invent** (user, 2026-10-23: «nunca inventar»): the prompt says so, and the facts are the
//! only thing the engine is handed. When there is no engine, or it fails, the deterministic text of
//! [`super::render::fallback`] is the summary and the reason is said.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::render::{self, Request};
use super::{Format, WorkLog};
use crate::ai_accounts::Choice;
use crate::commands::claude_cmd::{load_ai_config_as, load_ai_config_in, AiTask};
use crate::db::Db;

pub fn system_prompt(lang: &str) -> &'static str {
    if lang == "en" {
        "You write a software developer's work summary from a list of facts (commits, pull requests, reviews, \
meetings, tickets). Rules: use only the facts given; never invent tasks, names, numbers or blockers; when a \
section has no facts, write «None.». First person, concise, Markdown, no preamble and no closing line. A pull \
request with a url is written as [#id title](url). Group commits by what they were about instead of listing each."
    } else {
        "Redactas el resumen de trabajo de una persona desarrolladora a partir de una lista de hechos (commits, \
pull requests, revisiones, reuniones, tickets). Reglas: usa solo los hechos dados; nunca inventes tareas, \
nombres, cifras ni bloqueos; si una sección no tiene hechos, escribe «Ninguno.». Primera persona, conciso, \
Markdown, sin preámbulo ni cierre. Un pull request con url se escribe [#id título](url). Agrupa los commits por \
tema en vez de listar cada uno."
    }
}

pub fn ask(log: &WorkLog, lang: &str) -> String {
    let today_period = log.period.kind == super::PeriodKind::Today;
    match (log.format, lang == "en") {
        (Format::Daily, false) => format!(
            "Escribe el daily con exactamente tres secciones: {}. Lo hecho: lo que muestran los hechos, agrupado. \
{}: solo lo que se infiere de mis PRs abiertos, ramas sin mergear, revisiones que me pidieron y tickets en curso. \
`## Bloqueos`: checks fallando y PRs míos esperando revisión o con cambios pedidos; si no hay, «Ninguno.». \
Máximo 12 viñetas en total.",
            if today_period { "`## Hoy`, `## Siguiente`, `## Bloqueos`" } else { "`## Ayer`, `## Hoy`, `## Bloqueos`" },
            if today_period { "`## Siguiente`" } else { "`## Hoy`" }
        ),
        (Format::Daily, true) => format!(
            "Write the standup with exactly three sections: {}. What was done: what the facts show, grouped. {}: only \
what follows from my open PRs, unmerged branches, reviews asked of me and tickets in progress. `## Blockers`: failing \
checks and my PRs waiting for review or with changes requested; if there are none, «None.». At most 12 bullets in all.",
            if today_period { "`## Today`, `## Next`, `## Blockers`" } else { "`## Yesterday`, `## Today`, `## Blockers`" },
            if today_period { "`## Next`" } else { "`## Today`" }
        ),
        (Format::Weekly, false) => "Escribe el informe semanal: `## Resumen` (dos o tres frases con las cifras), `## Por proyecto` con un \
`### nombre del repositorio` por cada repositorio con actividad (lo destacado y sus cifras), `## Reuniones` si hubo, y \
`## Pendiente y bloqueos` (si no hay, «Ninguno.»)."
            .into(),
        (Format::Weekly, true) => "Write the weekly report: `## Summary` (two or three sentences with the numbers), `## By project` with \
one `### repository name` per repository with activity (highlights and numbers), `## Meetings` if there were any, and \
`## Pending and blockers` (if none, «None.»)."
            .into(),
    }
}

/// What came out, and who wrote it.
pub struct Written {
    pub markdown: String,
    /// `none` when the deterministic text is the summary.
    pub engine: String,
    /// Why there is no model's text, when there is not.
    pub fallback_reason: Option<String>,
}

fn text(value: Option<&Value>, key: &str) -> String {
    value.and_then(|v| v.get(key)).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

async fn local(app: &AppHandle, facts: &str, system: &str, ask: &str) -> Result<String, String> {
    use crate::hybrid::local_llm::{self, BackendKind, ChatRequest, LocalError};
    let settings = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::hybrid::config::read(&conn)?
    };
    let resolved = crate::hybrid::runtime::resolve(&settings, crate::hybrid::runtime::Freshness::Recent).await;
    if let Some(error) = resolved.error.clone() {
        return Err(error);
    }
    let model = resolved.model.clone().ok_or("no local model is set up")?;
    let live = crate::hybrid::runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
    let user = format!("{ask}\n\n{facts}");
    let request = ChatRequest {
        model: &live.model,
        system,
        user: &user,
        num_ctx: (live.endpoint.kind == BackendKind::Ollama).then_some(resolved.ctx),
        max_tokens: 1200,
        temperature: 0.2,
        think: None,
        keep_alive: (live.endpoint.kind == BackendKind::Ollama).then_some("5m"),
        schema: None,
    };
    match crate::hybrid::scheduler::background(local_llm::chat(&live.endpoint, &request, |_| {}, std::future::pending::<()>())).await {
        Ok(outcome) => {
            let usage = crate::ai::AiUsage {
                input_tokens: outcome.prompt_tokens.unwrap_or(0) as i64,
                output_tokens: outcome.completion_tokens.unwrap_or(0) as i64,
                ..Default::default()
            };
            crate::ai_usage::record("local", &live.model, crate::ai::task::WORKLOG, None, &usage);
            Ok(outcome.text.trim().to_string())
        }
        Err(LocalError::Cancelled) => Err(crate::ai_runs::CANCELLED_MARKER.to_string()),
        Err(error) => Err(error.sentence()),
    }
}

async fn by_model(app: &AppHandle, log: &WorkLog, request: &Request, lang: &str) -> Result<(String, String), String> {
    let facts = render::facts(log, lang);
    let system = system_prompt(lang);
    let ask = ask(log, lang);
    let provider = text(request.engine.as_ref(), "provider");
    if provider == "local" {
        return Ok((local(app, &facts, system, &ask).await?, "local".into()));
    }
    let config = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if provider.is_empty() {
            load_ai_config_in(&conn, AiTask::Notes, request.workspace_id.as_deref())?
        } else {
            if !crate::flows::ai_host::CLI_PROVIDERS.contains(&provider.as_str()) {
                return Err(format!("\"{provider}\" is not an AI engine CodeFlow knows"));
            }
            let model = text(request.engine.as_ref(), "model");
            let account = text(request.engine.as_ref(), "account");
            load_ai_config_as(&conn, &provider, &model, Choice::parse(Some(account.as_str())), Some(AiTask::Notes), request.workspace_id.as_deref())?
        }
    };
    let markdown = crate::ai::worklog_write(&*config.engine, &config.binary, &config.model, system, &ask, &facts).await?;
    Ok((markdown, config.provider.clone()))
}

/// The summary: the model's when it answers with something, the deterministic text otherwise.
pub async fn write(app: &AppHandle, log: &WorkLog, request: &Request, lang: &str) -> Written {
    let plain = || render::fallback(log, lang);
    if request.plain {
        return Written { markdown: plain(), engine: "none".into(), fallback_reason: None };
    }
    // Nothing happened: there is nothing for a model to write, and asking one invites invention.
    if log.is_empty() {
        return Written { markdown: plain(), engine: "none".into(), fallback_reason: None };
    }
    match by_model(app, log, request, lang).await {
        Ok((markdown, engine)) if !markdown.trim().is_empty() => Written { markdown: clean(&markdown), engine, fallback_reason: None },
        Ok(_) => Written { markdown: plain(), engine: "none".into(), fallback_reason: Some("the engine answered nothing".into()) },
        Err(error) => Written { markdown: plain(), engine: "none".into(), fallback_reason: Some(error) },
    }
}

/// The model's Markdown without a title line of its own (the note has one).
pub fn clean(markdown: &str) -> String {
    let trimmed = markdown.trim();
    let body = match trimmed.split_once('\n') {
        Some((first, rest)) if first.starts_with("# ") => rest.trim_start(),
        _ => trimmed,
    };
    format!("{}\n", body.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worklog::render::tests::sample;

    #[test]
    fn the_prompt_forbids_inventing_and_names_the_sections() {
        assert!(system_prompt("es").contains("nunca inventes"));
        assert!(system_prompt("en").contains("never invent"));
        let daily = ask(&sample(Format::Daily), "es");
        assert!(daily.contains("`## Ayer`, `## Hoy`, `## Bloqueos`") && daily.contains("«Ninguno.»"));
        assert!(ask(&sample(Format::Weekly), "en").contains("`## By project`"));
    }

    #[test]
    fn a_title_of_the_models_own_is_dropped() {
        assert_eq!(clean("# Daily\n\n## Ayer\n- x\n"), "## Ayer\n- x\n");
        assert_eq!(clean("## Ayer\n- x"), "## Ayer\n- x\n");
    }
}
