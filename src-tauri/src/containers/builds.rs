//! «Builds» — BuildKit's own build history, read through `docker buildx history`.
//!
//! BuildKit keeps a record of every build it ran — the ones started from here and the ones typed in a
//! terminal alike — with its state, its steps (cached or run, and how long each took) and its log.
//! The manager shows that record rather than one of its own: nothing to keep in step, and a build
//! run elsewhere is there too. Docker only (buildx); the other engines keep no such history, and
//! the page falls back to the builds it started itself.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::cli;
use super::engine::{check_ref, EngineKind, Target};

const HISTORY_TIMEOUT: Duration = Duration::from_secs(20);
/// A log beyond this is cut from the front: the end — where a build fails — is what is read.
const LOG_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildRecord {
    /// The record's own id — the last part of `ls`'s `builder/node/id`, which `inspect` takes.
    pub id: String,
    pub name: String,
    /// `completed`, `failed`, `running`, `canceled`.
    pub status: String,
    pub created_at: String,
    pub completed_at: String,
    pub total_steps: u64,
    pub completed_steps: u64,
    pub cached_steps: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDetail {
    #[serde(flatten)]
    pub record: BuildRecord,
    pub context: String,
    pub dockerfile: String,
    pub platforms: Vec<String>,
    /// Milliseconds, as BuildKit measured it.
    pub duration_ms: Option<u64>,
    pub error: String,
    /// The plain progress log (`#5 [2/6] RUN …`, `#5 DONE 1.2s`), parsed by the page.
    pub logs: String,
}

fn text(value: &Value, names: &[&str]) -> String {
    names.iter().find_map(|n| value.get(*n)).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn number(value: &Value, names: &[&str]) -> u64 {
    names.iter().find_map(|n| value.get(*n)).and_then(Value::as_u64).unwrap_or(0)
}

/// `Completed`, `completed`, `Error`… in the four words the page knows.
fn status_of(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "completed" | "complete" | "done" => "completed",
        "error" | "failed" | "failure" => "failed",
        "canceled" | "cancelled" => "canceled",
        "running" | "building" | "" => "running",
        other => return other.to_string(),
    }
    .to_string()
}

fn record_of(value: &Value) -> BuildRecord {
    let full = text(value, &["ref", "Ref"]);
    BuildRecord {
        id: full.rsplit('/').next().unwrap_or_default().to_string(),
        name: text(value, &["name", "Name"]),
        status: status_of(&text(value, &["status", "Status"])),
        created_at: text(value, &["created_at", "StartedAt", "CreatedAt"]),
        completed_at: text(value, &["completed_at", "CompletedAt"]),
        total_steps: number(value, &["total_steps", "NumTotalSteps"]),
        completed_steps: number(value, &["completed_steps", "NumCompletedSteps"]),
        cached_steps: number(value, &["cached_steps", "NumCachedSteps"]),
    }
}

/// `history ls --format json`: one record per line, newest first.
pub fn parse_list(text_out: &str) -> Vec<BuildRecord> {
    cli::json_values(text_out).iter().map(record_of).filter(|r| !r.id.is_empty()).collect()
}

/// `history inspect --format json`, without its log.
pub fn parse_inspect(text_out: &str) -> Result<BuildDetail, String> {
    let doc: Value = serde_json::from_str(text_out.trim()).map_err(|e| format!("could not read the build record: {e}"))?;
    let platforms = match doc.get("Platform") {
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::String(one)) => vec![one.clone()],
        _ => vec![],
    };
    let error = match doc.get("Error") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("Message").and_then(Value::as_str).unwrap_or_default().to_string(),
        _ => String::new(),
    };
    Ok(BuildDetail {
        record: record_of(&doc),
        context: text(&doc, &["Context"]),
        dockerfile: text(&doc, &["Dockerfile"]),
        platforms,
        duration_ms: doc.get("Duration").and_then(Value::as_u64).map(|ns| ns / 1_000_000),
        error,
        logs: String::new(),
    })
}

fn docker_only(target: &Target) -> Result<(), String> {
    match target.engine()? {
        EngineKind::Docker => Ok(()),
        _ => Err("unsupported".into()),
    }
}

pub async fn list(target: &Target) -> Result<Vec<BuildRecord>, String> {
    docker_only(target)?;
    let out = target.run_owned(vec!["buildx".into(), "history".into(), "ls".into(), "--format".into(), "json".into()], HISTORY_TIMEOUT).await?;
    if !out.ok() {
        // An older buildx has no `history`: the page says so rather than showing an error.
        let complaint = out.complaint();
        return Err(if complaint.contains("unknown command") || complaint.contains("unknown flag") { "unsupported".into() } else { complaint });
    }
    Ok(parse_list(&out.stdout))
}

pub async fn detail(target: &Target, id: &str) -> Result<BuildDetail, String> {
    docker_only(target)?;
    check_ref(id)?;
    let inspect = target.run_owned(vec!["buildx".into(), "history".into(), "inspect".into(), id.into(), "--format".into(), "json".into()], HISTORY_TIMEOUT);
    let logs = target.run_owned(vec!["buildx".into(), "history".into(), "logs".into(), id.into()], HISTORY_TIMEOUT);
    let (inspect, logs) = tokio::join!(inspect, logs);
    let inspect = inspect?;
    if !inspect.ok() {
        return Err(inspect.complaint());
    }
    let mut detail = parse_inspect(&inspect.stdout)?;
    if detail.record.id.is_empty() {
        detail.record.id = id.to_string();
    }
    if let Ok(out) = logs {
        // BuildKit writes its progress to stderr.
        let mut text = if out.stdout.trim().is_empty() { out.stderr } else { out.stdout };
        if text.len() > LOG_LIMIT {
            let mut cut = text.len() - LOG_LIMIT;
            while !text.is_char_boundary(cut) {
                cut += 1;
            }
            text = text[cut..].to_string();
        }
        detail.logs = text;
    }
    Ok(detail)
}

pub async fn remove(target: &Target, ids: &[String]) -> Result<(), String> {
    docker_only(target)?;
    if ids.is_empty() {
        return Ok(());
    }
    for id in ids {
        check_ref(id)?;
    }
    let mut args: Vec<String> = vec!["buildx".into(), "history".into(), "rm".into()];
    args.extend(ids.iter().cloned());
    let out = target.run_owned(args, HISTORY_TIMEOUT).await?;
    if out.ok() { Ok(()) } else { Err(out.complaint()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_from_ls() {
        let rows = parse_list(
            r#"{"cached_steps":3,"completed_at":"2026-11-17T14:11:30Z","completed_steps":16,"created_at":"2026-11-17T14:11:24Z","name":"iris","ref":"orbstack/orbstack/gpj3","status":"Completed","total_steps":16}
{"cached_steps":0,"completed_steps":4,"created_at":"2026-11-17T14:00:00Z","name":"api","ref":"default/default/m4zy","status":"Error","total_steps":9}"#,
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "gpj3");
        assert_eq!(rows[0].status, "completed");
        assert_eq!(rows[0].cached_steps, 3);
        assert_eq!(rows[1].status, "failed");
        assert_eq!(rows[1].completed_at, "");
    }

    #[test]
    fn detail_from_inspect() {
        let detail = parse_inspect(
            r#"{"Name":"iris","Ref":"gpj3","Context":"/tmp/iris","Dockerfile":"Dockerfile","Platform":["linux/amd64"],"StartedAt":"2026-11-17T11:11:24-03:00","CompletedAt":"2026-11-17T11:11:30-03:00","Duration":5502154159,"Status":"completed","NumCompletedSteps":16,"NumTotalSteps":16,"NumCachedSteps":3}"#,
        )
        .unwrap();
        assert_eq!(detail.record.id, "gpj3");
        assert_eq!(detail.duration_ms, Some(5502));
        assert_eq!(detail.platforms, vec!["linux/amd64"]);
        assert_eq!(detail.record.created_at, "2026-11-17T11:11:24-03:00");
        let failed = parse_inspect(r#"{"Ref":"x","Status":"failed","Error":{"Message":"process \"/bin/sh -c exit 1\" did not complete"}}"#).unwrap();
        assert_eq!(failed.record.status, "failed");
        assert!(failed.error.contains("did not complete"));
    }
}
