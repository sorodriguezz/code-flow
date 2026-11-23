//! Approving a pull request on the strength of a review — the pure half.
//!
//! The approval itself is a host call (see `approve_pr_from_review` in `commands::ado_cmd`); what
//! lives here is the two judgements around it that must not depend on what happens to be on
//! screen:
//!
//! - **whether the run's gate actually passed**, re-derived from the run's stored findings and its
//!   frozen policy rather than taken from the stored `quality_gate` flag, because a human can mark a
//!   finding as a false positive after the run was saved — which is exactly what turns a FAILED into
//!   a PASSED worth approving — and the flag was written before that;
//! - **what the run's memory says about the approval**: who approved, when, and under which gate.
//!   The point of recording it is that the memory answers "who let this through" with a person, not
//!   with the AI that reviewed it.

use serde::Serialize;
use serde_json::Value;

use crate::review::contract::{gate_is_conclusive, Severity};
use crate::review_memory::MemoryFinding;

/// The gate a stored run stands at *now*, from its findings as they are after any human marks.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GateVerdict {
    /// No active finding carries a severity the run's policy blocks on.
    pub passed: bool,
    /// The level the run was reviewed at reports every severity the gate blocks on. A PASSED that
    /// is not conclusive is one nobody earned (see [`gate_is_conclusive`]) and is no basis for an
    /// approval.
    pub conclusive: bool,
    /// A reviewer or pass failed, so part of the pull request was never looked at.
    pub incomplete: bool,
    /// The blocking severities, as labels — what the approval record cites.
    pub blocking: Vec<String>,
}

impl GateVerdict {
    /// Whether this run is grounds for approving: passed, conclusive and complete.
    pub fn approvable(&self) -> bool {
        self.passed && self.conclusive && !self.incomplete
    }

    /// Why it is not, as one Spanish sentence for the error a refused approval returns — the same
    /// language the review report and its gate line are written in.
    pub fn refusal(&self) -> Option<String> {
        if !self.passed {
            Some("el Quality Gate de esta revisión no pasó".to_string())
        } else if !self.conclusive {
            Some("el Quality Gate de esta revisión no es concluyente para su nivel".to_string())
        } else if self.incomplete {
            Some("la revisión quedó incompleta: parte del PR no se revisó".to_string())
        } else {
            None
        }
    }
}

/// The policy a run was reviewed under, or the built-in default for a run saved before the policy
/// was frozen into its meta.
fn blocking_of(meta: &Value) -> Vec<Severity> {
    let parsed: Vec<Severity> = meta
        .get("quality_gate_policy")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).filter_map(Severity::parse).collect())
        .unwrap_or_default();
    if parsed.is_empty() {
        vec![Severity::Blocker, Severity::Critico]
    } else {
        parsed
    }
}

/// The severities the run's level reported, from its frozen contract. `None` for a run that
/// predates the contract — nothing to judge conclusiveness by, so it is not held against it.
fn reported_of(meta: &Value) -> Option<Vec<Severity>> {
    let items = meta.get("level_contract")?.get("severities")?.as_array()?;
    Some(items.iter().filter_map(Value::as_str).filter_map(Severity::parse).collect())
}

/// Whether one finding blocks under `blocking`. Its own severity when it was stored; otherwise the
/// emoji bucket, read conservatively — `critical` is both a Blocker and a Crítico, so it blocks when
/// either does.
fn blocks(finding: &MemoryFinding, blocking: &[Severity]) -> bool {
    if let Some(severity) = Severity::parse(&finding.severidad) {
        return blocking.contains(&severity);
    }
    match finding.severity.as_str() {
        "critical" => blocking.contains(&Severity::Blocker) || blocking.contains(&Severity::Critico),
        "warning" => blocking.contains(&Severity::Mayor),
        _ => blocking.contains(&Severity::Menor) || blocking.contains(&Severity::Info),
    }
}

/// The gate of a stored run, from its `meta` JSON and its findings as they stand now.
pub fn gate_verdict(meta: &Value, findings: &[MemoryFinding]) -> GateVerdict {
    let blocking = blocking_of(meta);
    let passed = !findings.iter().any(|f| f.is_active() && blocks(f, &blocking));
    let conclusive = reported_of(meta).map_or(true, |reported| gate_is_conclusive(&blocking, &reported));
    let incomplete = meta.get("incomplete").and_then(Value::as_bool).unwrap_or(false);
    GateVerdict { passed, conclusive, incomplete, blocking: blocking.iter().map(|s| s.label().to_string()).collect() }
}

/// The run's `meta` with the approval written into it, under `approval`.
///
/// Written into the JSON rather than a column: the meta is already where a run's provenance lives
/// (engine, model, policy, cost), and every reader of it — the memory browser, the export, the
/// backup — carries an unknown key along untouched. An earlier approval of the same run (approved,
/// dismissed on the host, approved again) is replaced: the record answers who approved *last*.
pub fn with_approval(meta_json: &str, account: Option<&str>, provider: &str, at: &str, verdict: &GateVerdict) -> String {
    let mut meta: Value = serde_json::from_str(meta_json).unwrap_or_else(|_| Value::Object(Default::default()));
    if !meta.is_object() {
        meta = Value::Object(Default::default());
    }
    let record = serde_json::json!({
        // `None` when the host would not say who the credential is (a Bitbucket access token is not
        // a person) — recorded as unknown rather than guessed.
        "account": account.map(str::trim).filter(|a| !a.is_empty()),
        "approved_at": at,
        "provider": provider,
        "gate": if verdict.passed { "PASSED" } else { "FAILED" },
        "gate_policy": verdict.blocking,
        // Who decided: always a person in this app. The review informed it; it did not take it.
        "by": "human",
    });
    meta.as_object_mut().expect("meta is an object").insert("approval".to_string(), record);
    serde_json::to_string(&meta).unwrap_or_else(|_| meta_json.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(severity: &str, severidad: &str, estado: &str) -> MemoryFinding {
        serde_json::from_value(serde_json::json!({
            "id": "F-001",
            "severity": severity,
            "severidad": severidad,
            "tipo": "Bug",
            "categoria": "npe",
            "subtitulo": "x",
            "archivo": null,
            "lineas": null,
            "confianza": 90,
            "estado": estado,
        }))
        .unwrap()
    }

    fn meta(policy: &[&str], reported: Option<&[&str]>, incomplete: bool) -> Value {
        let mut meta = serde_json::json!({ "quality_gate_policy": policy, "incomplete": incomplete });
        if let Some(reported) = reported {
            meta["level_contract"] = serde_json::json!({ "severities": reported });
        }
        meta
    }

    #[test]
    fn a_blocking_finding_fails_the_gate_until_a_human_rejects_it() {
        let m = meta(&["Blocker", "Crítico"], Some(&["Blocker", "Critico", "Mayor"]), false);
        assert!(!gate_verdict(&m, &[finding("critical", "Crítico", "abierto")]).passed);
        let verdict = gate_verdict(&m, &[finding("critical", "Crítico", "falso_positivo")]);
        assert!(verdict.passed && verdict.approvable());
        // A non-blocking severity never fails it.
        assert!(gate_verdict(&m, &[finding("warning", "Mayor", "posteado")]).passed);
    }

    #[test]
    fn a_finding_without_its_own_severity_is_read_conservatively() {
        let only_blocker = meta(&["Blocker"], None, false);
        assert!(!gate_verdict(&only_blocker, &[finding("critical", "", "abierto")]).passed);
    }

    #[test]
    fn an_unearned_or_partial_pass_is_not_grounds_for_approving() {
        let unearned = meta(&["Blocker", "Mayor"], Some(&["Blocker", "Critico"]), false);
        let verdict = gate_verdict(&unearned, &[]);
        assert!(verdict.passed && !verdict.conclusive && !verdict.approvable());
        assert!(verdict.refusal().unwrap().contains("concluyente"));

        let partial = gate_verdict(&meta(&["Blocker"], None, true), &[]);
        assert!(partial.passed && !partial.approvable());
    }

    #[test]
    fn a_run_with_no_policy_uses_the_default_one() {
        let verdict = gate_verdict(&serde_json::json!({}), &[finding("critical", "Blocker", "abierto")]);
        assert!(!verdict.passed);
        assert_eq!(verdict.blocking, vec!["Blocker", "Crítico"]);
    }

    #[test]
    fn the_approval_lands_in_the_meta_and_keeps_everything_else() {
        let verdict = gate_verdict(&serde_json::json!({}), &[]);
        let out = with_approval(r#"{"engine":"claude","cost":{"passes":2}}"#, Some(" @ana "), "github", "2026-11-23T10:00:00Z", &verdict);
        let meta: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(meta["engine"], "claude");
        assert_eq!(meta["cost"]["passes"], 2);
        assert_eq!(meta["approval"]["account"], "@ana");
        assert_eq!(meta["approval"]["gate"], "PASSED");
        assert_eq!(meta["approval"]["by"], "human");

        let unknown = with_approval("not json", None, "bitbucket", "t", &verdict);
        assert!(serde_json::from_str::<Value>(&unknown).unwrap()["approval"]["account"].is_null());
    }
}
