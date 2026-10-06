//! The PR analyzer as operations a flow can ask CodeFlow for — list and read pull requests, decide
//! on one, work its comment threads, read and mark the review memory, and the analyzer's two AI
//! helpers ("Resolver con IA" and drafting a reply).
//!
//! **The analyzer's own commands.** Every operation calls what the PR panel calls, so a flow leaves
//! the same traces a person does: the decision filed in Activity, a rejected finding carried into
//! the next review, a false positive promoted to the repository's rules, the thread on the host
//! answered and closed. What the panel composes in TypeScript — the decision summary, the fix
//! prompts — is asked of the main window (`flows::bridge`), so there is one wording, not two.
//!
//! **A fix edits the working copy**, on the pull request's branch: switching to it is refused while
//! the checkout has uncommitted changes, exactly as the panel refuses it.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

use super::app_ops::{arg, arg_i64, db, to_json};
use super::runs::AppHost;
use crate::commands::{ado_cmd, claude_cmd, settings};
use crate::db::queries;
use crate::review_memory::MemoryFinding;

pub(super) async fn call(host: &AppHost, op: &str, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    match op {
        "pr.list" => list(host, args).await,
        "pr.get" => get(host, args).await,
        "pr.decide" => decide(host, args, cancel).await,
        "pr.threads" => to_json(ado_cmd::list_pr_comment_threads(db(host), arg(args, "projectId"), arg_i64(args, "prId")?).await?),
        "pr.threadResolve" => {
            let reply = Some(arg(args, "reply")).filter(|r| !r.trim().is_empty());
            let wont_fix = args.get("wontFix").and_then(Value::as_bool).unwrap_or(false);
            let outcome = ado_cmd::resolve_pr_comment_thread(db(host), arg(args, "projectId"), arg_i64(args, "prId")?, arg_i64(args, "threadId")?, reply, wont_fix).await?;
            to_json(outcome)
        }
        "pr.memoryRuns" => memory_runs(host, args),
        "pr.memoryFindings" => memory_findings(host, args),
        "pr.findingMark" => finding_mark(host, args).await,
        "pr.memoryRules" => memory_rules(host, args),
        "pr.fix" => fix(host, args, cancel).await,
        "pr.replyDraft" => reply_draft(host, args, cancel).await,
        other => Err(format!("{other} is not something a flow can ask CodeFlow for")),
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 3,
        "warning" => 2,
        _ => 1,
    }
}

/// The findings that still stand: open or published — what the Quality Gate judges.
fn is_active(finding: &MemoryFinding) -> bool {
    matches!(finding.estado.as_str(), "abierto" | "posteado")
}

/// The gate a decision "by the review" follows — the panel's `computeQualityGatePassed`: no
/// critical finding still standing.
pub fn gate_passes(findings: &[MemoryFinding]) -> bool {
    !findings.iter().any(|f| is_active(f) && f.severity == "critical")
}

/// Which of a run's findings a state filter keeps: `active`, `resolved`, `discarded` or `all`.
pub fn keeps(state: &str, finding: &MemoryFinding) -> bool {
    match state {
        "resolvedFindings" => finding.estado == "resuelto",
        "discardedFindings" => matches!(finding.estado.as_str(), "falso_positivo" | "ignorado"),
        "allFindings" => true,
        _ => is_active(finding),
    }
}

/// The checks of a pull request in three counts and a verdict — what a flow branches on.
pub fn checks_summary(checks: &[Value]) -> Value {
    let state = |c: &Value| c.get("state").and_then(Value::as_str).unwrap_or_default().to_string();
    let failed = checks.iter().filter(|c| matches!(state(c).as_str(), "failed" | "cancelled")).count();
    let pending = checks.iter().filter(|c| matches!(state(c).as_str(), "queued" | "running")).count();
    json!({"checksPassing": failed == 0 && pending == 0, "checksFailed": failed, "checksPending": pending})
}

/// The latest saved review run of a pull request, or the one named.
fn run_of(host: &AppHost, project_id: &str, pr_id: i64, run_id: &str) -> Result<Option<crate::db::models::ReviewRunDetail>, String> {
    let state = db(host);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = if run_id.trim().is_empty() {
        match queries::latest_review_run_id(&conn, project_id, pr_id).map_err(|e| e.to_string())? {
            Some(id) => id,
            None => return Ok(None),
        }
    } else {
        run_id.trim().to_string()
    };
    queries::get_review_run(&conn, &id).map_err(|e| e.to_string())
}

fn findings_of(run: &crate::db::models::ReviewRunDetail) -> Vec<MemoryFinding> {
    serde_json::from_str(&run.findings).unwrap_or_default()
}

fn no_review(pr_id: i64) -> String {
    format!("Pull request #{pr_id} has no saved review yet — run «Analizar PR» on it first")
}

/// Strings, numbers or a comma list → ids.
pub fn ids_of(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(list)) => list.iter().filter_map(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string()))).collect(),
        Some(Value::Number(n)) => vec![n.to_string()],
        Some(Value::String(s)) => s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect(),
        _ => Vec::new(),
    }
    .into_iter()
    .map(|id| id.trim().trim_start_matches('#').to_string())
    .filter(|id| !id.is_empty())
    .collect()
}

fn engine(args: &Value) -> Option<(String, String)> {
    let provider = arg(args, "provider");
    (!provider.trim().is_empty()).then(|| (provider, arg(args, "model")))
}

fn tell(host: &AppHost, inv: crate::remotectl::dispatch::Invalidate, project_id: &str) {
    crate::remotectl::bridge::emit_desktop_change(&host.app, "flows", inv, Some(project_id), None);
}

// ------------------------------------------------------------------------------- reading PRs

async fn list(host: &AppHost, args: &Value) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let scope = match arg(args, "scope").as_str() {
        "closedPrs" => "closed",
        "allPrs" => "all",
        _ => "open",
    };
    let max = args.get("max").and_then(Value::as_u64).filter(|n| *n > 0).unwrap_or(20) as usize;
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let answer = ado_cmd::list_pull_requests_page(db(host), project_id.clone(), Some(scope.to_string()), Some(page)).await?;
        let more = answer.has_more;
        for pr in answer.items {
            if out.len() >= max {
                break;
            }
            out.push(to_json(pr)?);
        }
        if !more || out.len() >= max || page >= 20 {
            break;
        }
        page += 1;
    }
    Ok(Value::Array(out))
}

async fn get(host: &AppHost, args: &Value) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr_id = arg_i64(args, "prId")?;
    let mut pr = to_json(ado_cmd::get_pull_request(db(host), project_id.clone(), pr_id).await?)?;
    // A host that cannot say leaves the field empty with why — the pull request itself was read.
    match ado_cmd::pr_checks(db(host), project_id.clone(), pr_id).await {
        Ok(checks) => {
            let list = to_json(&checks.checks)?;
            let summary = checks_summary(list.as_array().map(Vec::as_slice).unwrap_or_default());
            pr["checks"] = list;
            pr["headSha"] = json!(checks.head_sha);
            for (key, value) in summary.as_object().into_iter().flatten() {
                pr[key] = value.clone();
            }
        }
        Err(error) => pr["checksError"] = json!(error),
    }
    pr["myDecision"] = match ado_cmd::pr_review_decision(db(host), project_id.clone(), pr_id).await {
        Ok(decision) => json!(decision),
        Err(_) => json!("unknown"),
    };
    let run = run_of(host, &project_id, pr_id, "")?;
    if let Some(run) = run {
        let findings = findings_of(&run);
        pr["review"] = json!({
            "runId": run.id,
            "iteration": run.iter,
            "level": run.level,
            "gate": if gate_passes(&findings) { "pass" } else { "fail" },
            "openFindings": findings.iter().filter(|f| is_active(f)).count(),
        });
    }
    Ok(pr)
}

// --------------------------------------------------------------------------------- deciding

async fn decide(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr_id = arg_i64(args, "prId")?;
    let run = run_of(host, &project_id, pr_id, "")?;
    let gate = run.as_ref().map(|run| gate_passes(&findings_of(run)));
    let action = match arg(args, "decision").as_str() {
        "byReview" => match gate {
            Some(true) => "approve",
            Some(false) => "request_changes",
            None => return Err(no_review(pr_id)),
        },
        "requestChanges" => "request_changes",
        "closePr" => "close",
        _ => "approve",
    };
    let note = Some(arg(args, "note")).filter(|n| !n.trim().is_empty());
    let outcome = ado_cmd::act_on_pull_request(db(host), project_id.clone(), pr_id, action.to_string(), note).await?;
    tell(host, crate::remotectl::dispatch::Invalidate::Reviews, &project_id);

    let mut answer = json!({
        "prId": outcome.pr.id,
        "title": outcome.pr.title,
        "url": outcome.pr.url,
        "decision": action,
        "status": outcome.pr.status,
        "gate": gate.map(|pass| if pass { "pass" } else { "fail" }),
    });
    // The record of why, on the pull request — the panel's "comentar al decidir". The decision is
    // already on the host and cannot be taken back, so a summary that fails is said, not thrown.
    if args.get("postSummary").and_then(Value::as_bool).unwrap_or(false) {
        match &run {
            None => answer["summaryError"] = json!(no_review(pr_id)),
            Some(run) => {
                let summary = async {
                    let body = super::bridge::ask(&host.app, "pr.decisionComment", json!({"runId": run.id, "decision": action}), Duration::from_secs(60), cancel.clone()).await?;
                    let body = body.as_str().ok_or("The window answered without a summary")?.to_string();
                    let posted = ado_cmd::publish_pr_review(db(host), project_id.clone(), pr_id, run.id.clone(), Vec::new(), true, Some(body)).await?;
                    match posted.summary_error {
                        Some(error) => Err(error),
                        None => Ok(()),
                    }
                };
                match summary.await {
                    Ok(()) => answer["summaryPosted"] = json!(true),
                    Err(error) => {
                        answer["summaryPosted"] = json!(false);
                        answer["summaryError"] = json!(error);
                    }
                }
            }
        }
    }
    Ok(answer)
}

// ---------------------------------------------------------------------------------- memory

fn memory_runs(host: &AppHost, args: &Value) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr = arg(args, "prId");
    let pr_id: Option<i64> = pr.trim().trim_start_matches('#').parse().ok();
    let runs = settings::list_review_runs(db(host), host.workspace_id.clone())?;
    let kept: Vec<Value> = runs
        .into_iter()
        .filter(|run| run.project_id == project_id && pr_id.is_none_or(|id| run.pr_id == id))
        .map(|run| {
            json!({
                "runId": run.id,
                "prId": run.pr_id,
                "prTitle": run.pr_title,
                "iteration": run.iter,
                "level": run.level,
                "findings": run.findings_count,
                "createdAt": run.created_at,
            })
        })
        .collect();
    Ok(Value::Array(kept))
}

fn memory_findings(host: &AppHost, args: &Value) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr_id = arg_i64(args, "prId")?;
    let Some(run) = run_of(host, &project_id, pr_id, &arg(args, "runId"))? else { return Err(no_review(pr_id)) };
    let state = arg(args, "state");
    let kept: Vec<Value> = findings_of(&run)
        .into_iter()
        .filter(|f| keeps(&state, f))
        .map(|f| {
            let mut item = serde_json::to_value(&f).unwrap_or(Value::Null);
            item["runId"] = json!(run.id);
            item["prId"] = json!(run.pr_id);
            item["iteration"] = json!(run.iter);
            item
        })
        .collect();
    Ok(Value::Array(kept))
}

async fn finding_mark(host: &AppHost, args: &Value) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr_id = arg_i64(args, "prId")?;
    let Some(run) = run_of(host, &project_id, pr_id, &arg(args, "runId"))? else { return Err(no_review(pr_id)) };
    let estado = match arg(args, "markAs").as_str() {
        "falsePositive" => "falso_positivo",
        "ignored" => "ignorado",
        _ => "abierto",
    };
    let motivo = Some(arg(args, "reason")).filter(|r| !r.trim().is_empty());
    let mut out = Vec::new();
    for finding_id in ids_of(args.get("findingIds")) {
        let outcome = ado_cmd::discard_pr_finding(
            db(host),
            project_id.clone(),
            pr_id,
            run.id.clone(),
            finding_id.clone(),
            estado.to_string(),
            motivo.clone(),
            args.get("wholeRepo").and_then(Value::as_bool).unwrap_or(false),
            args.get("notifyPr").and_then(Value::as_bool).unwrap_or(false),
        )
        .await?;
        let mut item = to_json(&outcome)?;
        item["findingId"] = json!(finding_id);
        item["estado"] = json!(estado);
        item["runId"] = json!(run.id);
        out.push(item);
    }
    if out.is_empty() {
        return Err("Write the findings' ids (F-001…) — a review's findings carry them".into());
    }
    tell(host, crate::remotectl::dispatch::Invalidate::Reviews, &project_id);
    Ok(Value::Array(out))
}

fn memory_rules(host: &AppHost, args: &Value) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let repo = {
        let state = db(host);
        let project = ado_cmd::load_project(&state, &project_id)?;
        ado_cmd::repo_key(&ado_cmd::linked_repo(&project)?)
    };
    let rules = settings::list_fp_suppressions(db(host), host.workspace_id.clone())?;
    to_json(rules.into_iter().filter(|rule| rule.repo_key == repo).collect::<Vec<_>>())
}

// --------------------------------------------------------------------------------- AI helpers

/// The checkout on the pull request's branch — switched to when allowed and clean, refused
/// otherwise. True when it switched.
async fn on_branch(host: &AppHost, path: &str, branch: &str, may_switch: bool) -> Result<bool, String> {
    let status = crate::git::repo::get_status(path)?;
    if status.current_branch.as_deref() == Some(branch) {
        return Ok(false);
    }
    if !may_switch {
        return Err(format!(
            "The checkout is on {} and the pull request on {branch} — let the node switch, or switch first",
            status.current_branch.as_deref().unwrap_or("a detached HEAD")
        ));
    }
    let dirty = !status.staged.is_empty() || !status.unstaged.is_empty() || !status.untracked.is_empty() || !status.conflicted.is_empty();
    if dirty {
        return Err(format!("The checkout has uncommitted changes — commit or stash them before switching to {branch}"));
    }
    // Fetched first, so a branch this clone has not seen yet is there to switch to.
    let _ = crate::commands::git_ops::git_fetch_branch(host.app.clone(), path.to_string(), branch.to_string()).await;
    crate::git::branch::checkout_local_branch(path, branch)
        .or_else(|_| crate::git::branch::checkout_remote_tracking(path, &format!("origin/{branch}")).map(|_| ()))?;
    tell(host, crate::remotectl::dispatch::Invalidate::Repo, "");
    Ok(true)
}

/// The threads a helper works on: the ids asked for, or every open one.
async fn threads_for(host: &AppHost, project_id: &str, pr_id: i64, ids: &[String]) -> Result<Vec<Value>, String> {
    let threads = to_json(ado_cmd::list_pr_comment_threads(db(host), project_id.to_string(), pr_id).await?)?;
    Ok(threads
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| ids.is_empty() || ids.iter().any(|id| t.get("id").map(|v| v.to_string()) == Some(id.clone())))
        .collect())
}

async fn fix(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr_id = arg_i64(args, "prId")?;
    let ids = ids_of(args.get("ids"));
    let from_threads = arg(args, "source") == "fixThreads";
    let pr = ado_cmd::get_pull_request(db(host), project_id.clone(), pr_id).await?;
    let path = {
        let state = db(host);
        ado_cmd::load_project(&state, &project_id)?.local_path
    };

    // What to fix: the review's findings still standing (at least `minSeverity`), or the threads.
    let mut run_id = String::new();
    let mut finding_ids = Vec::new();
    let mut threads = Vec::new();
    if from_threads {
        threads = threads_for(host, &project_id, pr_id, &ids).await?;
    } else {
        let Some(run) = run_of(host, &project_id, pr_id, "")? else { return Err(no_review(pr_id)) };
        let floor = severity_rank(&arg(args, "minSeverity"));
        finding_ids = findings_of(&run)
            .into_iter()
            .filter(|f| if ids.is_empty() { is_active(f) && severity_rank(&f.severity) >= floor } else { ids.contains(&f.id) })
            .map(|f| f.id)
            .collect();
        run_id = run.id;
    }
    if finding_ids.is_empty() && threads.is_empty() {
        return Ok(json!([]));
    }

    let switched = on_branch(host, &path, &pr.source_branch, args.get("switchBranch").and_then(Value::as_bool).unwrap_or(true)).await?;
    let payload = json!({"runId": if run_id.is_empty() { Value::Null } else { json!(run_id) }, "findingIds": finding_ids, "threads": threads, "extra": arg(args, "instructions")});
    let prompts = super::bridge::ask(&host.app, "pr.prompts", payload, Duration::from_secs(60), cancel.clone()).await?;
    let mut jobs: Vec<(String, String, Value)> = Vec::new();
    for finding in prompts["findings"].as_array().into_iter().flatten() {
        let prompt = finding["prompt"].as_str().unwrap_or_default().to_string();
        jobs.push(("finding".into(), prompt, json!({"findingId": finding["id"], "title": finding["title"], "severity": finding["severity"], "location": finding["location"]})));
    }
    for thread in prompts["threads"].as_array().into_iter().flatten() {
        let prompt = thread["fixPrompt"].as_str().unwrap_or_default().to_string();
        jobs.push(("thread".into(), prompt, json!({"threadId": thread["id"], "location": thread["location"]})));
    }

    let mut out = Vec::new();
    for (kind, prompt, mut item) in jobs {
        let job = uuid::Uuid::new_v4().to_string();
        let work = claude_cmd::resolve_finding_on(host.app.clone(), host.app.state::<crate::db::Db>(), project_id.clone(), prompt, Some(job.clone()), engine(args));
        let result = tokio::select! {
            result = work => result,
            _ = cancel.cancelled() => {
                crate::ai_runs::cancel(&job);
                return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
            }
        };
        item["kind"] = json!(kind);
        item["prId"] = json!(pr_id);
        item["branch"] = json!(pr.source_branch);
        match result {
            Ok(text) => {
                item["fixed"] = json!(true);
                item["result"] = json!(text);
            }
            Err(error) => {
                item["fixed"] = json!(false);
                item["error"] = json!(error);
            }
        }
        out.push(item);
    }
    if let Some(first) = out.first_mut() {
        first["switchedBranch"] = json!(switched);
    }
    tell(host, crate::remotectl::dispatch::Invalidate::Repo, &project_id);
    Ok(Value::Array(out))
}

async fn reply_draft(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    let project_id = arg(args, "projectId");
    let pr_id = arg_i64(args, "prId")?;
    let threads = threads_for(host, &project_id, pr_id, &ids_of(args.get("ids"))).await?;
    if threads.is_empty() {
        return Ok(json!([]));
    }
    let prompts = super::bridge::ask(&host.app, "pr.prompts", json!({"runId": null, "findingIds": [], "threads": threads}), Duration::from_secs(60), cancel.clone()).await?;
    let note = Some(arg(args, "note")).filter(|n| !n.trim().is_empty());
    let mut out = Vec::new();
    for thread in prompts["threads"].as_array().into_iter().flatten() {
        let job = uuid::Uuid::new_v4().to_string();
        let conversation = thread["conversation"].as_str().unwrap_or_default().to_string();
        let work = claude_cmd::draft_reply_on(host.app.clone(), host.app.state::<crate::db::Db>(), conversation, note.clone(), Some(job.clone()), Some(host.workspace_id.clone()), engine(args));
        let draft = tokio::select! {
            draft = work => draft?,
            _ = cancel.cancelled() => {
                crate::ai_runs::cancel(&job);
                return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
            }
        };
        out.push(json!({"threadId": thread["id"], "prId": pr_id, "location": thread["location"], "draft": draft.trim()}));
    }
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(id: &str, severity: &str, estado: &str) -> MemoryFinding {
        serde_json::from_value(json!({
            "id": id, "severity": severity, "tipo": "Bug", "categoria": "c", "subtitulo": "s",
            "archivo": null, "lineas": null, "confianza": null, "estado": estado
        }))
        .unwrap()
    }

    #[test]
    fn the_gate_is_the_panels_no_critical_still_standing() {
        assert!(gate_passes(&[finding("F-1", "warning", "abierto"), finding("F-2", "critical", "resuelto")]));
        assert!(gate_passes(&[finding("F-1", "critical", "falso_positivo")]));
        assert!(!gate_passes(&[finding("F-1", "critical", "posteado")]));
        assert!(gate_passes(&[]));
    }

    #[test]
    fn findings_are_kept_by_state() {
        let all = [finding("F-1", "warning", "abierto"), finding("F-2", "info", "posteado"), finding("F-3", "info", "resuelto"), finding("F-4", "critical", "ignorado")];
        let ids = |state: &str| all.iter().filter(|f| keeps(state, f)).map(|f| f.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids("activeFindings"), vec!["F-1", "F-2"]);
        assert_eq!(ids("resolvedFindings"), vec!["F-3"]);
        assert_eq!(ids("discardedFindings"), vec!["F-4"]);
        assert_eq!(ids("allFindings").len(), 4);
    }

    #[test]
    fn ids_and_checks_read_the_way_a_flow_writes_them() {
        assert_eq!(ids_of(Some(&json!("F-001, F-003"))), vec!["F-001", "F-003"]);
        assert_eq!(ids_of(Some(&json!([12, "#13"]))), vec!["12", "13"]);
        assert!(ids_of(None).is_empty());
        let checks = vec![json!({"state": "success"}), json!({"state": "running"})];
        assert_eq!(checks_summary(&checks), json!({"checksPassing": false, "checksFailed": 0, "checksPending": 1}));
        assert_eq!(checks_summary(&[json!({"state": "success"}), json!({"state": "skipped"})])["checksPassing"], true);
        assert_eq!(checks_summary(&[json!({"state": "failed"})])["checksFailed"], 1);
    }
}
