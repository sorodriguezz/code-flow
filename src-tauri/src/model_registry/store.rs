//! The registry's rows (`ai_model_registry`) and the bench history (`ai_evaluations`).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::Declared;
use crate::evals::conformance::Conformance;
use crate::evals::report::Report;

/// One model as the registry knows it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ModelRecord {
    pub id: String,
    pub backend: String,
    pub model: String,
    pub digest: Option<String>,
    pub family: Option<String>,
    pub declared: Declared,
    /// `None` never tested; `Some(false)` tested and failed.
    pub tools_verified: Option<bool>,
    /// The digest the verification ran against.
    pub verified_digest: Option<String>,
    pub conformance: Option<Conformance>,
    pub updated_at: i64,
}

impl ModelRecord {
    /// The verdict, if it is about the bytes the model has now: a re-pull that changed the digest
    /// makes the old verdict a statement about a different model.
    pub fn current_verdict(&self) -> Option<bool> {
        match (&self.digest, &self.verified_digest) {
            (Some(now), Some(then)) if now != then => None,
            _ => self.tools_verified,
        }
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Records what a model declares, keeping any verification it already has.
pub fn upsert_declared(
    conn: &Connection,
    id: &str,
    backend: &str,
    model: &str,
    digest: Option<&str>,
    family: Option<&str>,
    declared: &Declared,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ai_model_registry (id, backend, model, digest, family, declared, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET digest = COALESCE(excluded.digest, digest), family = COALESCE(excluded.family, family),
             declared = excluded.declared, updated_at = excluded.updated_at",
        params![id, backend, model, digest, family, serde_json::to_string(declared).unwrap_or_default(), now()],
    )?;
    Ok(())
}

/// Stores a conformance verdict against `digest`.
pub fn record_conformance(conn: &Connection, id: &str, backend: &str, model: &str, digest: Option<&str>, conformance: &Conformance) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ai_model_registry (id, backend, model, digest, declared, tools_verified, verified_digest, conformance, updated_at)
         VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?4, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET digest = COALESCE(excluded.digest, digest), tools_verified = excluded.tools_verified,
             verified_digest = excluded.verified_digest, conformance = excluded.conformance, updated_at = excluded.updated_at",
        params![id, backend, model, digest, conformance.verified(), serde_json::to_string(conformance).unwrap_or_default(), now()],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<ModelRecord>> {
    conn.query_row(
        "SELECT id, backend, model, digest, family, declared, tools_verified, verified_digest, conformance, updated_at
         FROM ai_model_registry WHERE id = ?1",
        params![id],
        row_to_record,
    )
    .optional()
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<ModelRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, backend, model, digest, family, declared, tools_verified, verified_digest, conformance, updated_at
         FROM ai_model_registry ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_record)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelRecord> {
    let declared: String = row.get(5)?;
    let conformance: Option<String> = row.get(8)?;
    Ok(ModelRecord {
        id: row.get(0)?,
        backend: row.get(1)?,
        model: row.get(2)?,
        digest: row.get(3)?,
        family: row.get(4)?,
        declared: serde_json::from_str(&declared).unwrap_or_default(),
        tools_verified: row.get::<_, Option<i64>>(6)?.map(|v| v != 0),
        verified_digest: row.get(7)?,
        conformance: conformance.and_then(|c| serde_json::from_str(&c).ok()),
        updated_at: row.get(9)?,
    })
}

/// One stored bench run.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct EvaluationRow {
    pub id: String,
    pub backend: String,
    pub model: String,
    pub digest: Option<String>,
    pub adapter_id: Option<String>,
    pub score: f64,
    pub tools_passed: Option<i64>,
    pub tools_total: Option<i64>,
    pub created_at: i64,
    pub report: Report,
}

/// Files a finished report (and, when it ran the tools suite, its verdict on the registry row).
pub fn record_evaluation(conn: &Connection, report: &Report, adapter_id: Option<&str>) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO ai_evaluations (id, backend, model, digest, adapter_id, machine, score, tools_passed, tools_total, report, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            report.backend,
            report.model,
            report.model_digest,
            adapter_id,
            serde_json::to_string(&report.machine).unwrap_or_default(),
            report.score,
            report.conformance.as_ref().map(|c| c.passed as i64),
            report.conformance.as_ref().map(|c| c.total as i64),
            serde_json::to_string(report).unwrap_or_default(),
            now(),
        ],
    )?;
    if let (Some(conformance), None) = (&report.conformance, adapter_id) {
        let kind = crate::hybrid::local_llm::BackendKind::from_setting(&report.backend);
        if let Some(kind) = kind {
            let reg = super::registry_id(kind, &report.model);
            record_conformance(conn, &reg, &report.backend, &report.model, report.model_digest.as_deref(), conformance)?;
        }
    }
    Ok(id)
}

pub fn evaluations(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<EvaluationRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, backend, model, digest, adapter_id, score, tools_passed, tools_total, created_at, report
         FROM ai_evaluations ORDER BY created_at DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            let report: String = row.get(9)?;
            Ok((
                EvaluationRow {
                    id: row.get(0)?,
                    backend: row.get(1)?,
                    model: row.get(2)?,
                    digest: row.get(3)?,
                    adapter_id: row.get(4)?,
                    score: row.get(5)?,
                    tools_passed: row.get(6)?,
                    tools_total: row.get(7)?,
                    created_at: row.get(8)?,
                    report: placeholder_report(),
                },
                report,
            ))
        })?
        .filter_map(|row| row.ok())
        .filter_map(|(mut row, report)| {
            row.report = serde_json::from_str(&report).ok()?;
            Some(row)
        })
        .collect();
    Ok(rows)
}

pub fn evaluation(conn: &Connection, id: &str) -> rusqlite::Result<Option<Report>> {
    let raw: Option<String> = conn.query_row("SELECT report FROM ai_evaluations WHERE id = ?1", params![id], |row| row.get(0)).optional()?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
}

pub fn delete_evaluation(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ai_evaluations WHERE id = ?1", params![id])?;
    Ok(())
}

fn placeholder_report() -> Report {
    Report {
        format: 0,
        app_version: None,
        started_at: String::new(),
        finished_at: String::new(),
        backend: String::new(),
        model: String::new(),
        model_digest: None,
        adapter: None,
        ctx: 0,
        machine: crate::evals::report::MachineSummary { os: String::new(), arch: String::new(), ram_gb: 0.0, gpu: String::new(), gpu_name: None, gpu_gb: None },
        speed: None,
        conformance: None,
        tasks: Vec::new(),
        peak_rss_bytes: None,
        score: 0.0,
        aborted: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evals::conformance::{summarize, CaseResult};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        conn
    }

    fn conformance(pass: bool) -> Conformance {
        summarize(
            ["single-call", "pick-right-tool", "nested-args", "no-tool-needed", "use-result", "error-recovery"]
                .iter()
                .enumerate()
                .map(|(i, id)| CaseResult { id: id.to_string(), passed: pass || i == 0, native: true, detail: String::new() })
                .collect(),
        )
    }

    #[test]
    fn declared_then_verified_then_stale() {
        let conn = db();
        upsert_declared(&conn, "ollama|m", "ollama", "m", Some("d1"), Some("qwen"), &Declared { tools: true, ..Default::default() }).unwrap();
        assert_eq!(get(&conn, "ollama|m").unwrap().unwrap().current_verdict(), None);
        record_conformance(&conn, "ollama|m", "ollama", "m", Some("d1"), &conformance(false)).unwrap();
        let rec = get(&conn, "ollama|m").unwrap().unwrap();
        assert_eq!(rec.current_verdict(), Some(false));
        assert!(rec.declared.tools, "the verification kept what was declared");
        // A re-pull changed the bytes: the old verdict no longer applies.
        upsert_declared(&conn, "ollama|m", "ollama", "m", Some("d2"), None, &rec.declared).unwrap();
        assert_eq!(get(&conn, "ollama|m").unwrap().unwrap().current_verdict(), None);
        record_conformance(&conn, "ollama|m", "ollama", "m", Some("d2"), &conformance(true)).unwrap();
        assert_eq!(get(&conn, "ollama|m").unwrap().unwrap().current_verdict(), Some(true));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
