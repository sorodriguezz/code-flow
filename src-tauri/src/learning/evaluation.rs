//! The gate between a trained adapter and the model picker.
//!
//! The candidate and its base run the same bench (`crate::evals`) on the same engine — the base
//! served without the adapter, then with it, by `mlx_lm server` for an MLX adapter or by
//! `llama-server --lora` over the base's GGUF for a PEFT one ([`super::serving::targets`]) — so the
//! only difference measured is the adapter, quantisation of the served base included. A candidate is **approved** only if it loses no task the base passed, scores at
//! least as well, and calls tools at least as well; otherwise it is **rejected** and says why.
//! Publishing an approved adapter retires the one published before it on the same base, which stays
//! on disk for [`rollback`].

use rusqlite::Connection;
use serde::Serialize;
use tokio::sync::watch;

use crate::evals::report::{compare, Comparison, Report};
use crate::hybrid::config::Settings;

use super::LearningEvent;

/// What the gate decided.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub approved: bool,
    pub reasons: Vec<String>,
    pub base_evaluation: String,
    pub candidate_evaluation: String,
    pub comparison: Comparison,
}

/// Why `candidate` must not replace `base`; empty when it may.
pub fn gate(base: &Report, candidate: &Report) -> Vec<String> {
    let mut reasons = Vec::new();
    if let Some(why) = &candidate.aborted {
        reasons.push(format!("the candidate's run did not finish ({why})"));
    }
    if let Some(why) = &base.aborted {
        reasons.push(format!("the base's run did not finish ({why})"));
    }
    let comparison = compare(base, candidate);
    if !comparison.regressions.is_empty() {
        reasons.push(format!("it loses {} that the base passed", comparison.regressions.join(", ")));
    }
    if candidate.score + 1e-9 < base.score {
        reasons.push(format!("it scores {:.0}% against the base's {:.0}%", candidate.score * 100.0, base.score * 100.0));
    }
    let tools = |r: &Report| r.conformance.as_ref().map(|c| c.passed);
    if let (Some(before), Some(after)) = (tools(base), tools(candidate)) {
        if after < before {
            reasons.push(format!("it calls tools worse ({after} against {before})"));
        }
    }
    reasons
}

/// The bench options the gate uses: every suite but speed (an adapter does not change it), twice.
pub fn gate_options(adapter: Option<&str>) -> crate::evals::Options {
    crate::evals::Options {
        runs: 2,
        suites: vec![crate::evals::corpus::Suite::Tools, crate::evals::corpus::Suite::Text, crate::evals::corpus::Suite::Agent],
        only: Vec::new(),
        app_version: None,
        adapter: adapter.map(str::to_string),
    }
}

/// Measures what `target` serves (a base alone, or with its adapter).
pub async fn measure(
    base_settings: &Settings,
    target: &super::serving::Target,
    adapter_id: Option<&str>,
    options: &crate::evals::Options,
    progress: impl Fn(crate::evals::Progress),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Report, String> {
    let (served, _lease) = super::serving::ensure(target, adapter_id).await?;
    let settings = super::serving::served_settings(&served, base_settings);
    crate::evals::run(&settings, options, progress, cancel).await
}

/// Evaluates adapter `id` against its base, records both reports, and moves the adapter to
/// `approved` or `rejected`.
pub async fn evaluate(app: Option<tauri::AppHandle>, id: String, cancel: Option<watch::Receiver<bool>>) -> Result<Verdict, String> {
    let adapter = crate::ai_usage::with_conn(|conn| super::trainer::adapter(conn, &id))
        .ok_or("the database is not available")?
        .map_err(|e| e.to_string())?
        .ok_or("that adapter no longer exists")?;
    let settings = match crate::ai_usage::with_conn(crate::hybrid::config::read) {
        Some(Ok(settings)) => settings,
        Some(Err(error)) => return Err(error),
        None => return Err("the database is not available".into()),
    };
    let tell = |label: &'static str| {
        let app = app.clone();
        let id = id.clone();
        move |p: crate::evals::Progress| {
            if let Some(app) = &app {
                super::emit(
                    app,
                    LearningEvent {
                        kind: "eval",
                        id: id.clone(),
                        state: "running",
                        line: Some(format!("{label}: {}", p.step)),
                        progress: serde_json::to_value(serde_json::json!({ "phase": label, "done": p.done, "total": p.total })).ok(),
                    },
                );
            }
        }
    };
    let finish = |state: &'static str, line: Option<String>| {
        if let Some(app) = &app {
            super::emit(app, LearningEvent { kind: "eval", id: id.clone(), state, line, progress: None });
        }
    };
    // A PEFT adapter is converted here, before either measurement: a conversion that fails says so
    // without first spending a bench run on the base.
    let (base_target, candidate_target) = match super::serving::targets(&adapter, super::serving::window(&settings)) {
        Ok(targets) => targets,
        Err(error) => {
            finish("failed", Some(error.clone()));
            return Err(error);
        }
    };
    let base_report = match measure(&settings, &base_target, None, &gate_options(None), tell("base"), cancel.clone()).await {
        Ok(report) => report,
        Err(error) => {
            finish("failed", Some(error.clone()));
            return Err(error);
        }
    };
    if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
        finish("cancelled", None);
        return Err("stopped".into());
    }
    let candidate_report = match measure(&settings, &candidate_target, Some(&id), &gate_options(Some(&id)), tell("candidate"), cancel).await {
        Ok(report) => report,
        Err(error) => {
            finish("failed", Some(error.clone()));
            return Err(error);
        }
    };
    let verdict = crate::ai_usage::with_conn(|conn| record(conn, &id, &base_report, &candidate_report))
        .ok_or("the database is not available")?
        .map_err(|e| e.to_string())?;
    finish("done", Some(if verdict.approved { "approved".into() } else { verdict.reasons.join("; ") }));
    Ok(verdict)
}

/// Files both reports and the gate's decision.
pub fn record(conn: &Connection, adapter_id: &str, base: &Report, candidate: &Report) -> rusqlite::Result<Verdict> {
    let base_evaluation = crate::model_registry::store::record_evaluation(conn, base, None)?;
    let candidate_evaluation = crate::model_registry::store::record_evaluation(conn, candidate, Some(adapter_id))?;
    let reasons = gate(base, candidate);
    let approved = reasons.is_empty();
    super::trainer::set_adapter_status(conn, adapter_id, if approved { "approved" } else { "rejected" }, Some(&candidate_evaluation))?;
    let comparison = compare(base, candidate);
    // Kept on the adapter so the pane can say what the gate found without re-reading both reports.
    let summary = serde_json::json!({
        "approved": approved,
        "reasons": reasons,
        "baseEvaluation": base_evaluation,
        "candidateEvaluation": candidate_evaluation,
        "scoreBefore": comparison.score_before,
        "scoreAfter": comparison.score_after,
        "toolsBefore": comparison.tools_before,
        "toolsAfter": comparison.tools_after,
        "regressions": comparison.regressions,
        "aborted": base.aborted.is_some() || candidate.aborted.is_some(),
    });
    super::trainer::set_adapter_gate(conn, adapter_id, &summary)?;
    Ok(Verdict { approved, reasons, base_evaluation, candidate_evaluation, comparison })
}

/// Publishes an approved adapter; the one published before on the same base is retired. `force`
/// publishes a rejected one too — the user's call, and the pane says what the gate found.
pub fn publish(conn: &Connection, id: &str, force: bool) -> Result<(), String> {
    let adapter = super::trainer::adapter(conn, id).map_err(|e| e.to_string())?.ok_or("that adapter no longer exists")?;
    match adapter.status.as_str() {
        "approved" | "retired" => {}
        "rejected" if force => {}
        "rejected" => return Err("the evaluation rejected this adapter".into()),
        "published" => return Ok(()),
        _ => return Err("evaluate the adapter before publishing it".into()),
    }
    for other in super::trainer::published(conn).map_err(|e| e.to_string())? {
        if other.id != id && other.base_model == adapter.base_model {
            super::trainer::set_adapter_status(conn, &other.id, "retired", None).map_err(|e| e.to_string())?;
        }
    }
    super::trainer::set_adapter_status(conn, id, "published", None).map_err(|e| e.to_string())
}

/// Takes a published adapter back: it is retired, and the one retired most recently on the same
/// base (if any) is published again.
pub fn rollback(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let adapter = super::trainer::adapter(conn, id).map_err(|e| e.to_string())?.ok_or("that adapter no longer exists")?;
    if adapter.status != "published" {
        return Err("only a published adapter can be rolled back".into());
    }
    super::trainer::set_adapter_status(conn, id, "retired", None).map_err(|e| e.to_string())?;
    let previous = super::trainer::adapters(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|a| a.id != id && a.base_model == adapter.base_model && a.status == "retired" && a.published_at.is_some())
        .max_by_key(|a| a.published_at);
    if let Some(previous) = &previous {
        super::trainer::set_adapter_status(conn, &previous.id, "published", None).map_err(|e| e.to_string())?;
    }
    Ok(previous.map(|p| p.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evals::corpus::Suite;
    use crate::evals::report::{MachineSummary, TaskResult, FORMAT};

    fn report(passes: &[(&str, usize)], tools: usize) -> Report {
        let tasks: Vec<TaskResult> = passes
            .iter()
            .map(|(id, passed)| TaskResult {
                id: id.to_string(),
                suite: Suite::Agent,
                runs: 2,
                passed: *passed,
                seconds: vec![1.0, 1.0],
                failures: Vec::new(),
                prompt_tokens: 0,
                completion_tokens: 0,
                skipped: None,
            })
            .collect();
        Report {
            format: FORMAT,
            app_version: None,
            started_at: String::new(),
            finished_at: String::new(),
            backend: "openai".into(),
            model: "m".into(),
            model_digest: None,
            adapter: None,
            ctx: 16_384,
            machine: MachineSummary { os: "macos".into(), arch: "aarch64".into(), ram_gb: 16.0, gpu: "integrated".into(), gpu_name: None, gpu_gb: None },
            speed: None,
            conformance: Some(crate::evals::conformance::Conformance { cases: Vec::new(), passed: tools, total: 7, parallel: false }),
            score: Report::compute_score(&tasks),
            tasks,
            peak_rss_bytes: None,
            aborted: None,
        }
    }

    #[test]
    fn the_gate_refuses_a_regression_even_when_the_score_rises() {
        let base = report(&[("a", 2), ("b", 0), ("c", 0)], 7);
        let better = report(&[("a", 2), ("b", 2), ("c", 0)], 7);
        assert!(gate(&base, &better).is_empty());
        let trade = report(&[("a", 0), ("b", 2), ("c", 2)], 7);
        let reasons = gate(&base, &trade);
        assert!(reasons.iter().any(|r| r.contains("loses a")), "{reasons:?}");
        let clumsy = report(&[("a", 2), ("b", 2), ("c", 0)], 5);
        assert!(gate(&base, &clumsy).iter().any(|r| r.contains("tools")));
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);").unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        for (id, at) in [("a1", 1), ("a2", 2)] {
            conn.execute(
                "INSERT INTO ai_model_adapters (id, name, base_model, family, path, format, status, created_at) VALUES (?1, ?1, 'qwen2.5-0.5b-instruct', 'qwen', '/x', 'mlx-lora', 'candidate', ?2)",
                rusqlite::params![id, at],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn publishing_retires_the_previous_and_rollback_restores_it() {
        let conn = db();
        assert!(publish(&conn, "a1", false).is_err(), "a candidate is evaluated first");
        let base = report(&[("a", 2)], 7);
        let verdict = record(&conn, "a1", &base, &report(&[("a", 2)], 7)).unwrap();
        assert!(verdict.approved);
        let gate_kept = super::super::trainer::adapter(&conn, "a1").unwrap().unwrap().metrics["gate"].clone();
        assert_eq!(gate_kept["approved"], true);
        assert_eq!(gate_kept["toolsBefore"], 7);
        publish(&conn, "a1", false).unwrap();
        let rejected = record(&conn, "a2", &base, &report(&[("a", 0)], 7)).unwrap();
        assert!(!rejected.approved);
        assert!(publish(&conn, "a2", false).is_err());
        publish(&conn, "a2", true).unwrap();
        let status = |id: &str| super::super::trainer::adapter(&conn, id).unwrap().unwrap().status;
        assert_eq!(status("a1"), "retired");
        assert_eq!(status("a2"), "published");
        assert_eq!(rollback(&conn, "a2").unwrap().as_deref(), Some("a1"));
        assert_eq!(status("a1"), "published");
        assert_eq!(status("a2"), "retired");
    }
}
