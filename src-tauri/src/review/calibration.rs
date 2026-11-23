//! What this repository keeps **dismissing**, turned into a higher bar for the categories involved.
//!
//! The standing false-positive rules (`review_memory::FpSuppression`) are a filter: a human said
//! "this category, here, is never a defect" and the merge enforces it. Calibration is the softer
//! sibling for everything below that certainty. When the team keeps marking one category as a false
//! positive or ignoring it — four times out of six, say — the next finding of that category is
//! *probably* noise too, but not certainly: the other two times it was real. So it is neither
//! dropped nor waved through. It is asked for more confidence (≥ 85 by default), in the prompt
//! before the reviewer writes it and again in the merge after.
//!
//! Only **human** verdicts count. A finding the verifier refuted never reaches the memory at all, so
//! it is neither a dismissal nor a sample — two models agreeing must never raise a bar no person set.
//! And the pull request under review is left out of its own history (the query excludes it): on a
//! re-review, iteration one's dismissals would otherwise raise iteration two's bar inside the very PR
//! they were made in.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::contract::CalibrationConfig;
use super::hints::PastRun;
use crate::review_memory::{category_slug, MemoryFinding};

/// How much of the most frequent dismissal reason travels into the prompt.
const REASON_CHARS: usize = 90;

/// One category this repository keeps dismissing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalibratedCategory {
    /// The category as the findings spelled it most recently — what the prompt shows.
    pub categoria: String,
    /// Its [`category_slug`], which is what a finding is matched by.
    pub slug: String,
    /// Findings of it a human discarded (`falso_positivo` / `ignorado`).
    pub dismissed: usize,
    /// Every finding of it in the history, whatever became of it.
    pub total: usize,
    /// The reason given most often, trimmed. `None` when nobody wrote one.
    pub motivo: Option<String>,
}

impl CalibratedCategory {
    pub fn rate(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.dismissed as f64 / self.total as f64
        }
    }
}

fn dismissed(estado: &str) -> bool {
    matches!(estado, "falso_positivo" | "ignorado")
}

fn trim_reason(reason: &str) -> String {
    let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    if reason.chars().count() <= REASON_CHARS {
        return reason;
    }
    let cut: String = reason.chars().take(REASON_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// The calibrated categories, worst first, from the repository's past runs.
///
/// `runs` is one row per **other** pull request — its latest run, which carries every finding that
/// PR ever had and the state it ended in (`queries::review_runs_for_repo`). Newest first, so the
/// first spelling and the first reason seen are the most recent ones.
pub fn from_runs(runs: &[PastRun], config: &CalibrationConfig) -> Vec<CalibratedCategory> {
    if !config.enabled {
        return Vec::new();
    }
    struct Tally {
        categoria: String,
        dismissed: usize,
        total: usize,
        /// reason → (count, first position seen), so a tie goes to the most recent.
        reasons: BTreeMap<String, (usize, usize)>,
    }
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    let mut seen = 0usize;
    for run in runs {
        let Ok(findings) = serde_json::from_str::<Vec<MemoryFinding>>(&run.findings_json) else { continue };
        for finding in findings {
            let slug = category_slug(&finding.categoria);
            if slug.is_empty() {
                continue;
            }
            let tally = tallies.entry(slug).or_insert_with(|| Tally {
                categoria: finding.categoria.trim().to_string(),
                dismissed: 0,
                total: 0,
                reasons: BTreeMap::new(),
            });
            tally.total += 1;
            if dismissed(&finding.estado) {
                tally.dismissed += 1;
                if let Some(reason) = finding.motivo_descarte.as_deref().map(trim_reason).filter(|r| !r.is_empty()) {
                    seen += 1;
                    let entry = tally.reasons.entry(reason).or_insert((0, seen));
                    entry.0 += 1;
                }
            }
        }
    }

    let mut out: Vec<CalibratedCategory> = tallies
        .into_iter()
        .filter(|(_, t)| t.total >= config.min_samples.max(1) && (t.dismissed as f64 / t.total as f64) >= config.min_rate)
        .map(|(slug, t)| CalibratedCategory {
            categoria: t.categoria,
            slug,
            dismissed: t.dismissed,
            total: t.total,
            motivo: t
                .reasons
                .into_iter()
                .max_by(|(_, (a, at)), (_, (b, bt))| a.cmp(b).then(bt.cmp(at)))
                .map(|(reason, _)| reason),
        })
        .collect();
    // Worst first: the highest rate, then the most evidence behind it.
    out.sort_by(|a, b| {
        b.rate()
            .partial_cmp(&a.rate())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.total.cmp(&a.total))
            .then_with(|| a.slug.cmp(&b.slug))
    });
    out.truncate(config.max_categories);
    out
}

/// The calibrated category a finding of `categoria` falls under, if any.
pub fn bar_for<'a>(categories: &'a [CalibratedCategory], categoria: &str) -> Option<&'a CalibratedCategory> {
    let slug = category_slug(categoria);
    if slug.is_empty() {
        return None;
    }
    categories.iter().find(|c| c.slug == slug)
}

/// The calibration as one line per category, for the reviewer's context — the same words the
/// report and the log use, so what the model was told and what the merge enforced read alike.
pub fn block(categories: &[CalibratedCategory], min_confidence: u8) -> Option<String> {
    if categories.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nEs una VARA, no un filtro: si encuentras algo de estas categorías y estás seguro, repórtalo. \
         Por debajo de esa confianza se descarta al consolidar.\n",
    );
    for c in categories {
        let motivo = c.motivo.as_deref().map(|m| format!(", motivo frecuente: «{m}»")).unwrap_or_default();
        out.push_str(&format!(
            "- Calibración: este repo descarta a menudo: `{}` ({} de {}{}) — repórtalos solo con confianza ≥ {}\n",
            c.categoria, c.dismissed, c.total, motivo, min_confidence
        ));
    }
    Some(out)
}

/// The report's one line about it: which categories carried a raised bar, and what it cost.
pub fn report_line(categories: &[CalibratedCategory], min_confidence: u8, held_back: usize) -> Option<String> {
    if categories.is_empty() {
        return None;
    }
    let names: Vec<String> = categories.iter().map(|c| format!("`{}` ({}/{})", c.categoria, c.dismissed, c.total)).collect();
    let tail = if held_back > 0 { format!(" · {held_back} hallazgo(s) no llegaron a esa vara") } else { String::new() };
    Some(format!("🎯 Calibración (confianza ≥ {min_confidence}): {}{tail}\n", names.join(", ")))
}

/// The calibration a run was held to, frozen into its meta (`ReviewMeta::calibration`): a memory read
/// months later has to say which bar applied, and by then the history that raised it has moved on.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Applied {
    /// The confidence a finding of one of the categories needed.
    pub min_confidence: u8,
    pub categories: Vec<CalibratedCategory>,
    /// Findings this run held back under that bar.
    pub held_back: usize,
}

/// What [`Applied`] a run records — `None` when no category was calibrated.
pub fn applied(categories: &[CalibratedCategory], min_confidence: u8, held_back: usize) -> Option<Applied> {
    (!categories.is_empty()).then(|| Applied { min_confidence, categories: categories.to_vec(), held_back })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_records_the_bar_only_when_one_applied() {
        assert!(applied(&[], 85, 0).is_none());
        let cats = vec![CalibratedCategory { categoria: "x".into(), slug: "x".into(), dismissed: 4, total: 5, motivo: None }];
        let frozen = applied(&cats, 85, 1).unwrap();
        let json = serde_json::to_value(&frozen).unwrap();
        assert_eq!(json["minConfidence"], 85);
        assert_eq!(json["heldBack"], 1);
        assert_eq!(json["categories"][0]["slug"], "x");
    }

    fn run(pr: i64, findings: &[(&str, &str, Option<&str>)]) -> PastRun {
        let list: Vec<serde_json::Value> = findings
            .iter()
            .enumerate()
            .map(|(i, (categoria, estado, motivo))| {
                serde_json::json!({
                    "id": format!("F-{:03}", i + 1), "severity": "warning", "tipo": "Bug",
                    "categoria": categoria, "subtitulo": "x", "archivo": "a.ts", "lineas": "1",
                    "confianza": 70, "estado": estado, "motivo_descarte": motivo,
                })
            })
            .collect();
        PastRun { pr_id: pr, created_at: "2026-10-01".into(), findings_json: serde_json::to_string(&list).unwrap() }
    }

    /// Four samples, three dismissed: the bar rises, with the reason given most often.
    #[test]
    fn a_category_the_team_keeps_dismissing_is_calibrated() {
        let runs = vec![
            run(10, &[("missing-validation", "falso_positivo", Some("el gateway valida")), ("npe", "resuelto", None)]),
            run(9, &[("Missing Validation", "ignorado", Some("el gateway valida"))]),
            run(8, &[("missing-validation", "falso_positivo", Some("otro motivo")), ("missing-validation", "posteado", None)]),
        ];
        let cats = from_runs(&runs, &CalibrationConfig::default());
        assert_eq!(cats.len(), 1, "npe has one sample, below min_samples");
        assert_eq!((cats[0].dismissed, cats[0].total), (3, 4));
        assert_eq!(cats[0].slug, "missing-validation");
        assert_eq!(cats[0].motivo.as_deref(), Some("el gateway valida"));
        assert!(bar_for(&cats, "MISSING_VALIDATION").is_some(), "matched by slug, however it is spelled");
        assert!(bar_for(&cats, "sql-injection").is_none());
    }

    /// Below the rate, or below the samples, nothing moves — an anecdote is not a bar.
    #[test]
    fn too_little_evidence_or_too_low_a_rate_calibrates_nothing() {
        let few = vec![run(1, &[("x", "falso_positivo", None), ("x", "falso_positivo", None), ("x", "falso_positivo", None)])];
        assert!(from_runs(&few, &CalibrationConfig::default()).is_empty());
        let mostly_real = vec![run(1, &[("x", "falso_positivo", None), ("x", "resuelto", None), ("x", "resuelto", None), ("x", "posteado", None)])];
        assert!(from_runs(&mostly_real, &CalibrationConfig::default()).is_empty(), "1 of 4 is 25%");
        let off = CalibrationConfig { enabled: false, ..Default::default() };
        let many = vec![run(1, &[("x", "falso_positivo", None); 6])];
        assert!(from_runs(&many, &off).is_empty());
    }

    #[test]
    fn only_the_worst_categories_are_kept() {
        let mut findings: Vec<(&str, &str, Option<&str>)> = Vec::new();
        findings.extend([("a", "falso_positivo", None); 4]);
        findings.extend([("b", "falso_positivo", None); 3]);
        findings.push(("b", "resuelto", None));
        let cfg = CalibrationConfig { max_categories: 1, ..Default::default() };
        let cats = from_runs(&[run(1, &findings)], &cfg);
        assert_eq!(cats.iter().map(|c| c.slug.as_str()).collect::<Vec<_>>(), vec!["a"], "100% beats 75%");
    }

    #[test]
    fn the_block_states_the_bar_in_the_teams_words() {
        let cats = vec![CalibratedCategory {
            categoria: "missing-validation".into(),
            slug: "missing-validation".into(),
            dismissed: 5,
            total: 7,
            motivo: Some("el gateway valida".into()),
        }];
        let text = block(&cats, 85).unwrap();
        assert!(text.contains("Calibración: este repo descarta a menudo: `missing-validation` (5 de 7, motivo frecuente: «el gateway valida») — repórtalos solo con confianza ≥ 85"));
        assert!(block(&[], 85).is_none());
        assert!(report_line(&cats, 85, 2).unwrap().contains("2 hallazgo(s)"));
    }
}
