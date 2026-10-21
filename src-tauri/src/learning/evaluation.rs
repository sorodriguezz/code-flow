//! The gate between a trained adapter and the model picker.
//!
//! The candidate and its base run the same bench (`crate::evals`) on the same engine — the base
//! served without the adapter, then with it, by `mlx_lm server` for an MLX adapter or by
//! `llama-server --lora` over the base's GGUF for a PEFT one ([`super::serving::targets`]) — so the
//! only difference measured is the adapter, quantisation of the served base included. A candidate is **approved** only if it loses no task the base passed, scores at
//! least as well, and calls tools at least as well; otherwise it is **rejected** and says why.
//!
//! **And on the dataset's own held-out split.** The bench says the adapter did not break what the
//! base could do; it cannot say the adapter learned what it was trained for. The dataset an adapter
//! was trained on keeps a test split no training step saw (`learning::datasets::split`): base and
//! candidate answer those prompts too, and each answer is scored by how close it is to the answer the
//! user accepted ([`similarity`], token F1). A candidate that answers them further from what was
//! accepted than its base is rejected like one that loses a task. An adapter whose dataset is gone,
//! or has no test examples, is gated on the bench alone, and the record says so.
//!
//! Publishing over the gate (`publish(force = true)`) is the user's call, and it is written down:
//! the adapter's gate record says the gate was skipped or overridden, and when.
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
    /// Base and candidate on the dataset's held-out examples; `None` when there were none.
    pub held_out: Option<(HeldOut, HeldOut)>,
}

/// One model's answers to a dataset's held-out examples: how many were asked, how many answered,
/// and the mean [`similarity`] to the accepted answers (0 for one that failed).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeldOut {
    pub examples: usize,
    pub answered: usize,
    pub mean: f64,
}

/// The most held-out examples one measurement asks: each is a model run, twice per evaluation.
const HELD_OUT_MAX: usize = 20;

/// How close `answer` is to the accepted `reference`: the F1 of their words (lowercased, punctuation
/// dropped, each word counted as often as it appears). Crude, and comparable: both models are judged
/// by it on the same prompts, and what is asked is only which one is closer.
pub fn similarity(answer: &str, reference: &str) -> f64 {
    let words = |text: &str| -> std::collections::HashMap<String, usize> {
        let mut counts = std::collections::HashMap::new();
        for word in text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
            *counts.entry(word.to_lowercase()).or_insert(0) += 1;
        }
        counts
    };
    let (a, r) = (words(answer), words(reference));
    let (total_a, total_r): (usize, usize) = (a.values().sum(), r.values().sum());
    if total_a == 0 || total_r == 0 {
        return if total_a == total_r { 1.0 } else { 0.0 };
    }
    let common: usize = a.iter().map(|(word, n)| (*n).min(r.get(word).copied().unwrap_or(0))).sum();
    if common == 0 {
        return 0.0;
    }
    let precision = common as f64 / total_a as f64;
    let recall = common as f64 / total_r as f64;
    2.0 * precision * recall / (precision + recall)
}

/// The `(prompt, accepted answer)` pairs of a dataset's `test.jsonl` — the split no training step saw.
pub fn held_out_examples(dataset_dir: &std::path::Path) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(dataset_dir.join("test.jsonl")) else { return Vec::new() };
    text.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|example| {
            let messages = example["messages"].as_array()?;
            let said = |role: &str| messages.iter().rev().find(|m| m["role"] == role).and_then(|m| m["content"].as_str()).map(str::to_string);
            Some((said("user")?, said("assistant")?))
        })
        .filter(|(prompt, answer)| !prompt.trim().is_empty() && !answer.trim().is_empty())
        .take(HELD_OUT_MAX)
        .collect()
}

/// The held-out examples of the dataset `adapter` was trained on, if it still exists.
fn held_out_of(conn: &Connection, adapter: &super::trainer::AdapterRow) -> Vec<(String, String)> {
    let Some(dataset) = adapter.dataset_id.as_deref() else { return Vec::new() };
    match super::datasets::get(conn, dataset) {
        Ok(Some(row)) => held_out_examples(std::path::Path::new(&row.path)),
        _ => Vec::new(),
    }
}

/// Why the candidate's held-out answers must not replace the base's; empty when they may.
pub fn gate_held_out(base: &HeldOut, candidate: &HeldOut) -> Vec<String> {
    if base.examples == 0 {
        return Vec::new();
    }
    if candidate.mean + 1e-9 < base.mean {
        vec![format!(
            "on the {} held-out examples of its dataset it answers further from the accepted answers ({:.0}% against the base's {:.0}%)",
            base.examples,
            candidate.mean * 100.0,
            base.mean * 100.0
        )]
    } else {
        Vec::new()
    }
}

/// Asks the served model each held-out prompt, the way a chat asks it (text mode), and scores the
/// answers. Stops early on `cancel`.
async fn answer_held_out(settings: &Settings, model: &str, examples: &[(String, String)], cancel: &Option<watch::Receiver<bool>>) -> HeldOut {
    let mut total = 0.0;
    let mut answered = 0;
    for (prompt, reference) in examples {
        if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
            break;
        }
        let mut inv = crate::ai::AiInvocation::new(prompt, "");
        inv.task = crate::ai::task::CHAT;
        inv.model = model;
        inv.read_only = true;
        let mut cancel = cancel.clone();
        if let Ok(run) = crate::local_agent::run_with(settings, &inv, &None, &mut cancel).await {
            total += similarity(&run.text, reference);
            answered += 1;
        }
    }
    HeldOut { examples: examples.len(), answered, mean: if examples.is_empty() { 0.0 } else { total / examples.len() as f64 } }
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

/// Measures what `target` serves (a base alone, or with its adapter) on the bench alone — what the
/// live tests drive; [`evaluate`] uses [`measure_with_held_out`].
#[cfg(test)]
pub async fn measure(
    base_settings: &Settings,
    target: &super::serving::Target,
    adapter_id: Option<&str>,
    options: &crate::evals::Options,
    progress: impl Fn(crate::evals::Progress),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Report, String> {
    Ok(measure_with_held_out(base_settings, target, adapter_id, options, &[], progress, cancel).await?.0)
}

/// The bench on what `target` serves, and the dataset's held-out `examples` answered by the same
/// server under the same lease — `None` when there are none.
pub async fn measure_with_held_out(
    base_settings: &Settings,
    target: &super::serving::Target,
    adapter_id: Option<&str>,
    options: &crate::evals::Options,
    examples: &[(String, String)],
    progress: impl Fn(crate::evals::Progress),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<(Report, Option<HeldOut>), String> {
    let (served, _lease) = super::serving::ensure(target, adapter_id).await?;
    let settings = super::serving::served_settings(&served, base_settings);
    let report = crate::evals::run(&settings, options, progress, cancel.clone()).await?;
    let held_out = if examples.is_empty() { None } else { Some(answer_held_out(&settings, &served.model, examples, &cancel).await) };
    Ok((report, held_out))
}

/// Evaluates adapter `id` against its base, records both reports, and moves the adapter to
/// `approved` or `rejected`.
pub async fn evaluate(app: Option<tauri::AppHandle>, id: String, cancel: Option<watch::Receiver<bool>>) -> Result<Verdict, String> {
    let adapter = crate::ai_usage::with_conn(|conn| super::trainer::adapter(conn, &id))
        .ok_or("the database is not available")?
        .map_err(|e| e.to_string())?
        .ok_or("that adapter no longer exists")?;
    let examples = crate::ai_usage::with_conn(|conn| held_out_of(conn, &adapter)).unwrap_or_default();
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
    let (base_report, base_held_out) = match measure_with_held_out(&settings, &base_target, None, &gate_options(None), &examples, tell("base"), cancel.clone()).await {
        Ok(measured) => measured,
        Err(error) => {
            finish("failed", Some(error.clone()));
            return Err(error);
        }
    };
    if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
        finish("cancelled", None);
        return Err("stopped".into());
    }
    let (candidate_report, candidate_held_out) = match measure_with_held_out(&settings, &candidate_target, Some(&id), &gate_options(Some(&id)), &examples, tell("candidate"), cancel).await {
        Ok(measured) => measured,
        Err(error) => {
            finish("failed", Some(error.clone()));
            return Err(error);
        }
    };
    let held_out = base_held_out.zip(candidate_held_out);
    let verdict = crate::ai_usage::with_conn(|conn| record_with(conn, &id, &base_report, &candidate_report, held_out))
        .ok_or("the database is not available")?
        .map_err(|e| e.to_string())?;
    finish("done", Some(if verdict.approved { "approved".into() } else { verdict.reasons.join("; ") }));
    Ok(verdict)
}

/// Files both reports and the gate's decision, on the bench alone.
#[cfg(test)]
pub fn record(conn: &Connection, adapter_id: &str, base: &Report, candidate: &Report) -> rusqlite::Result<Verdict> {
    record_with(conn, adapter_id, base, candidate, None)
}

/// [`record`], with the held-out examples' results `(base, candidate)` when there were any.
pub fn record_with(conn: &Connection, adapter_id: &str, base: &Report, candidate: &Report, held_out: Option<(HeldOut, HeldOut)>) -> rusqlite::Result<Verdict> {
    let base_evaluation = crate::model_registry::store::record_evaluation(conn, base, None)?;
    let candidate_evaluation = crate::model_registry::store::record_evaluation(conn, candidate, Some(adapter_id))?;
    let mut reasons = gate(base, candidate);
    if let Some((before, after)) = &held_out {
        reasons.extend(gate_held_out(before, after));
    }
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
        // `null`: the dataset had no held-out examples (or is gone), and the gate ran on the bench alone.
        "heldOut": held_out.as_ref().map(|(before, after)| serde_json::json!({
            "examples": before.examples,
            "before": before.mean,
            "after": after.mean,
            "answeredBefore": before.answered,
            "answeredAfter": after.answered,
        })),
    });
    super::trainer::set_adapter_gate(conn, adapter_id, &summary)?;
    Ok(Verdict { approved, reasons, base_evaluation, candidate_evaluation, comparison, held_out })
}

/// Publishes an approved adapter; the one published before on the same base is retired. `force`
/// publishes one the gate rejected, or one never evaluated — the user's call, written into the
/// adapter's gate record (`overridden` with the reasons it overrode, or `skipped`), so the pane and
/// anyone reading the adapter later know it reached the picker without passing.
pub fn publish(conn: &Connection, id: &str, force: bool) -> Result<(), String> {
    let adapter = super::trainer::adapter(conn, id).map_err(|e| e.to_string())?.ok_or("that adapter no longer exists")?;
    let now = chrono::Utc::now().to_rfc3339();
    match adapter.status.as_str() {
        "approved" | "retired" => {}
        "rejected" if force => {
            let mut gate = adapter.metrics.get("gate").cloned().filter(serde_json::Value::is_object).unwrap_or_else(|| serde_json::json!({}));
            gate["overridden"] = serde_json::json!(true);
            gate["overriddenAt"] = serde_json::json!(now);
            super::trainer::set_adapter_gate(conn, id, &gate).map_err(|e| e.to_string())?;
        }
        "rejected" => return Err("the evaluation rejected this adapter".into()),
        "published" => return Ok(()),
        _ if force => {
            let gate = serde_json::json!({ "approved": false, "skipped": true, "skippedAt": now, "reasons": ["published without an evaluation"] });
            super::trainer::set_adapter_gate(conn, id, &gate).map_err(|e| e.to_string())?;
        }
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

    /// Publishing over the gate used to leave no trace: the adapter read as published like any other.
    #[test]
    fn publishing_over_the_gate_is_written_into_its_record() {
        let conn = db();
        let gate_of = |id: &str| super::super::trainer::adapter(&conn, id).unwrap().unwrap().metrics["gate"].clone();
        let base = report(&[("a", 2)], 7);
        record(&conn, "a1", &base, &report(&[("a", 0)], 7)).unwrap();
        publish(&conn, "a1", true).unwrap();
        let overridden = gate_of("a1");
        assert_eq!(overridden["overridden"], true);
        assert_eq!(overridden["approved"], false, "what the gate found is kept");
        assert!(overridden["reasons"].as_array().is_some_and(|r| !r.is_empty()));
        // Never evaluated: refused without force, recorded as skipped with it.
        assert!(publish(&conn, "a2", false).is_err());
        publish(&conn, "a2", true).unwrap();
        let skipped = gate_of("a2");
        assert_eq!(skipped["skipped"], true);
        assert_eq!(super::super::trainer::adapter(&conn, "a2").unwrap().unwrap().status, "published");
    }

    #[test]
    fn the_held_out_split_gates_what_the_bench_cannot_see() {
        assert!((similarity("usa sqlite en data", "Usa SQLite en data.") - 1.0).abs() < 1e-9);
        assert_eq!(similarity("nada que ver", "usa sqlite"), 0.0);
        assert!(similarity("usa sqlite", "usa sqlite en data") > similarity("usa postgres", "usa sqlite en data"));
        let measured = |mean: f64| HeldOut { examples: 4, answered: 4, mean };
        assert!(gate_held_out(&measured(0.4), &measured(0.5)).is_empty());
        assert!(gate_held_out(&measured(0.5), &measured(0.4))[0].contains("held-out"));
        assert!(gate_held_out(&HeldOut { examples: 0, answered: 0, mean: 0.0 }, &measured(0.0)).is_empty(), "nothing held out, nothing to gate");
        // The bench passed; the held-out answers moved away from what the user accepted.
        let conn = db();
        let base = report(&[("a", 2)], 7);
        let verdict = record_with(&conn, "a1", &base, &report(&[("a", 2)], 7), Some((measured(0.6), measured(0.3)))).unwrap();
        assert!(!verdict.approved);
        let kept = super::super::trainer::adapter(&conn, "a1").unwrap().unwrap().metrics["gate"].clone();
        assert_eq!(kept["heldOut"]["examples"], 4);
        assert!(record(&conn, "a2", &base, &report(&[("a", 2)], 7)).unwrap().approved, "no split: the bench alone");
    }

    #[test]
    fn held_out_examples_are_read_from_the_test_split() {
        let dir = std::env::temp_dir().join(format!("codeflow-heldout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let line = |p: &str, a: &str| serde_json::json!({ "messages": [{ "role": "system", "content": "s" }, { "role": "user", "content": p }, { "role": "assistant", "content": a }] }).to_string();
        std::fs::write(dir.join("test.jsonl"), format!("{}\n{}\nnot json\n", line("q1", "a1"), line("q2", ""))).unwrap();
        assert_eq!(held_out_examples(&dir), vec![("q1".to_string(), "a1".to_string())], "an empty answer is no reference");
        assert!(held_out_examples(&dir.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
