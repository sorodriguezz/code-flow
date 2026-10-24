//! Codi's «¿qué hice ayer?», «resumen de mi semana», «arma mi daily» (user, 2026-10-23): the
//! summary written and kept in Notas like the form makes it, a short version said aloud, and the
//! note opened unless the work is to stay out of sight.
//!
//! A native action (`codi::native`) rather than one of the Notes window's: it runs whatever window
//! is on screen, and the slow part — the hosts, the model — is the backend's anyway.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::render::{self, Request};
use super::{Format, PeriodKind};
use crate::codi::native::{within_turn, Failure};
use crate::codi::ui::{ActResult, ActionSpec};

pub const ID: &str = "worklog.summary";

/// The action as the catalogue lists it.
pub fn spec() -> ActionSpec {
    serde_json::from_value(json!({
        "id": ID,
        "title": {
            "en": "Write the user's work summary — the daily standup (Yesterday / Today / Blockers) or the weekly report — from their commits, pull requests, reviews, meetings and tickets, keep it as a note in Notes and say a short version. `period`: previousWorkday (yesterday; Monday looks at Friday), today, thisWeek, lastWeek.",
            "es": "Escribe el resumen de trabajo del usuario —el daily (Ayer / Hoy / Bloqueos) o el informe semanal— desde sus commits, pull requests, revisiones, reuniones y tickets, lo guarda como nota en Notas y dice una versión corta. `period`: previousWorkday (ayer; el lunes mira el viernes), today, thisWeek, lastWeek."
        },
        "aliases": {
            "es": ["arma mi daily", "arma el daily", "hazme el daily", "prepara mi daily", "prepara el daily", "escribe mi daily", "mi daily", "el daily",
                   "resumen de mi trabajo", "resumen de mi", "resume mi", "informe semanal", "reporte semanal", "mi standup"],
            "en": ["write my standup", "prepare my standup", "my standup", "my daily", "write my daily", "summary of my work", "summarize my", "weekly report", "my weekly report"]
        },
        "questions": {
            "es": ["que hice", "que he hecho", "que hicimos", "en que trabaje", "que trabaje"],
            "en": ["what did i do", "what have i done", "what did i work on", "what i did"]
        },
        "vocabulary": {
            "period": {
                "previousWorkday": { "es": ["ayer", "el viernes", "dia anterior"], "en": ["yesterday", "friday"] },
                "today": { "es": ["hoy"], "en": ["today"] },
                "thisWeek": { "es": ["semana", "esta semana", "mi semana"], "en": ["week", "this week", "my week"] },
                "lastWeek": { "es": ["semana pasada", "la semana pasada"], "en": ["last week"] }
            }
        },
        "params": {
            "type": "object",
            "properties": {
                "period": { "type": "string", "enum": ["previousWorkday", "today", "thisWeek", "lastWeek"], "description": "Which stretch of time. Left out: yesterday's standup." },
                "format": { "type": "string", "enum": ["daily", "weekly"], "description": "daily (Yesterday / Today / Blockers) or weekly (by project). Left out: what the period reads as." },
                "show": { "type": "boolean", "description": "Open the note too: true only when the user asked to see it, false when they asked not to. Left out: the user's setting decides." }
            },
            "required": []
        },
        "risk": "write",
        "where": crate::codi::native::PLACE
    }))
    .expect("the worklog action's spec is written right")
}

fn period_of(params: &Value) -> PeriodKind {
    match params.get("period").and_then(Value::as_str) {
        Some("today") => PeriodKind::Today,
        Some("thisWeek") => PeriodKind::ThisWeek,
        Some("lastWeek") => PeriodKind::LastWeek,
        _ => PeriodKind::PreviousWorkday,
    }
}

fn format_of(params: &Value) -> Option<Format> {
    match params.get("format").and_then(Value::as_str) {
        Some("daily") => Some(Format::Daily),
        Some("weekly") => Some(Format::Weekly),
        _ => None,
    }
}

/// Whether the note goes on screen: what the order said, else Settings › Codi › «Trabajar en
/// segundo plano» (on unless turned off — `outOfSight` in the frontend reads the same key).
fn shows(params: &Value) -> bool {
    match params.get("show").and_then(Value::as_bool) {
        Some(show) => show,
        None => crate::ai_usage::setting("codi_background").is_some_and(|v| v.trim() == "off"),
    }
}

/// Asks the main window to open the note — the frame `notesBridge.revealNote` sends between windows.
fn reveal(app: &AppHandle, workspace_id: &str, note_id: &str) {
    let _ = app.emit(
        "windows:bus",
        json!({ "from": "backend", "message": { "kind": "open-note", "to": "main", "workspaceId": workspace_id, "noteId": note_id } }),
    );
    let _ = app.emit("windows:bus", json!({ "from": "backend", "message": { "kind": "focus-main" } }));
}

pub async fn act(app: &AppHandle, params: &Value) -> ActResult {
    let es = crate::codi::lang(app) == "es";
    let Some(workspace) = crate::ai_usage::setting("last_active_workspace_id").filter(|id| !id.trim().is_empty()) else {
        let say = if es { "Primero elige un workspace: ahí dejo la nota." } else { "Pick a workspace first: the note goes there." };
        return ActResult { ok: false, error: Some("no workspace is selected".into()), say: Some(say.into()), ..ActResult::default() };
    };
    // A standup is about the person, not one workspace: every repository is read.
    let request = Request { period: period_of(params), format: format_of(params), workspace_id: None, ..Default::default() };
    let show = shows(params);
    let worker = app.clone();
    let work = async move {
        let outcome = super::run::generate_into_note(&worker, request, &workspace, None).await.map_err(|error| Failure {
            say: if crate::codi::lang(&worker) == "es" { format!("No pude armar el resumen: {error}") } else { format!("I couldn't write the summary: {error}") },
            error,
            offer: None,
        })?;
        if show {
            if let Some(note) = &outcome.note {
                reveal(&worker, &note.workspace_id, &note.id);
            }
        }
        Ok(render::spoken(&outcome.log, &outcome.language))
    };
    let still = if es { "Estoy armando tu resumen, te aviso cuando esté." } else { "Writing your summary, I'll tell you when it's ready." };
    within_turn(app, "worklog".into(), still.into(), work).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codi::router::route;

    #[test]
    fn the_spoken_orders_reach_the_summary() {
        let specs = crate::codi::native::specs();
        let cases: &[(&str, &str)] = &[
            ("¿qué hice ayer?", "previousWorkday"),
            ("Codi, ¿qué hice ayer?", "previousWorkday"),
            ("what did I do yesterday?", "previousWorkday"),
            ("resumen de mi semana", "thisWeek"),
            ("¿qué hice la semana pasada?", "lastWeek"),
            ("arma mi daily", ""),
            ("hazme el daily de hoy", "today"),
            ("what did I do this week?", "thisWeek"),
        ];
        for (order, period) in cases {
            let got = route(order, &specs);
            let (id, params) = got.unwrap_or_else(|| panic!("{order:?} was not routed"));
            assert_eq!(id, ID, "{order:?}");
            if period.is_empty() {
                assert!(params.get("period").is_none(), "{order:?}: {params}");
            } else {
                assert_eq!(params.get("period").and_then(Value::as_str), Some(*period), "{order:?}");
            }
        }
        for order in ["¿qué es un commit?", "abre las notas"] {
            assert_ne!(route(order, &specs).map(|(id, _)| id), Some(ID.to_string()), "{order:?}");
        }
    }

    #[test]
    fn params_read_with_their_defaults() {
        assert_eq!(period_of(&json!({})), PeriodKind::PreviousWorkday);
        assert_eq!(period_of(&json!({ "period": "lastWeek" })), PeriodKind::LastWeek);
        assert_eq!(format_of(&json!({ "format": "weekly" })), Some(Format::Weekly));
        assert_eq!(format_of(&json!({})), None);
        assert!(shows(&json!({ "show": true })));
        assert!(!shows(&json!({ "show": false })));
    }
}
