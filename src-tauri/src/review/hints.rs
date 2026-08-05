//! What the saved review memory already settled about these same files — in **other** pull
//! requests of the same repository.
//!
//! This is the piece that turns a pile of stored reviews into memory that is actually consulted.
//! Everything else the pipeline reads back is scoped to one pull request: the previous run's
//! findings, the threads it opened, the marks a human made on it. A judgement made on PR #812 about
//! `Seguimiento.tsx` reached nothing, so the next branch that touched the same file re-derived the
//! same finding and the same argument got had again.
//!
//! Deliberately **hints, not filters** — and the distinction is not decoration. A finding closed
//! three months ago on the same file is evidence about *that* code at *that* time; the line may
//! have been rewritten since, and a rule that could never be contradicted would quietly hide a real
//! regression the day it was. So the reason travels with the hint, and the model is asked to weigh
//! it rather than obey it. The one thing that *is* a rule — a standing false positive for the whole
//! repository — already lives in `review_memory::FpSuppression`, which is a different mechanism on
//! purpose.

use serde::{Deserialize, Serialize};

use super::outline::same_path;
use crate::review_memory::MemoryFinding;

/// How many hints reach the prompt. Past this the block is longer than the code it is about.
const MAX_HINTS: usize = 25;

/// A closed finding on one of the files this pull request touches, from another pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub file: String,
    pub pr_id: i64,
    pub date: String,
    /// `resuelto` · `falso_positivo` · `ignorado`.
    pub estado: String,
    pub categoria: String,
    pub motivo: Option<String>,
}

/// One previous run, as the durable memory stores it.
pub struct PastRun {
    pub pr_id: i64,
    pub created_at: String,
    /// The run's `findings` column, still JSON — parsed here so the caller does not have to know
    /// the shape.
    pub findings_json: String,
}

fn is_closed(estado: &str) -> bool {
    matches!(estado, "resuelto" | "falso_positivo" | "ignorado")
}

/// The hints for `paths`, newest first.
///
/// Deduplicated by (file, category, state): the same defect closed across four iterations of one
/// pull request is one thing worth saying, not four. `runs` is expected newest-first, which is what
/// makes the first hint seen the most recent one.
pub fn for_paths(runs: &[PastRun], paths: &[String]) -> Vec<Hint> {
    if paths.is_empty() {
        return Vec::new();
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Hint> = Vec::new();

    for run in runs {
        let Ok(findings) = serde_json::from_str::<Vec<MemoryFinding>>(&run.findings_json) else {
            continue;
        };
        for finding in findings {
            if !is_closed(&finding.estado) {
                continue;
            }
            let Some(file) = finding.archivo.as_deref() else { continue };
            if !paths.iter().any(|p| same_path(p, file)) {
                continue;
            }
            let key = format!(
                "{}|{}|{}",
                file.to_lowercase(),
                finding.categoria.to_lowercase(),
                finding.estado
            );
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            out.push(Hint {
                file: file.to_string(),
                pr_id: run.pr_id,
                date: run.created_at.chars().take(10).collect(),
                estado: finding.estado.clone(),
                categoria: finding.categoria.clone(),
                motivo: finding.motivo_descarte.clone(),
            });
            if out.len() >= MAX_HINTS {
                return out;
            }
        }
    }
    out
}

/// The hints rendered as one review-prompt context block.
pub fn block(hints: &[Hint]) -> Option<String> {
    if hints.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nEn revisiones anteriores de OTROS PRs de este repositorio ya se evaluaron estos \
         hallazgos sobre los mismos archivos. Es CONTEXTO, no una prohibición: si vuelves a \
         encontrar algo equivalente, menciona en 💭 Por qué qué pasó la vez anterior (\"ya evaluado \
         en PR #X, marcado <estado>: <motivo>\"). Si crees que ahora el caso es distinto, repórtalo \
         igual y explica en qué se diferencia.\n\n",
    );
    for hint in hints {
        let estado = match hint.estado.as_str() {
            "falso_positivo" => "falso positivo",
            "ignorado" => "ignorado",
            _ => "resuelto",
        };
        out.push_str(&format!(
            "- `{}` · categoría `{}` — {} en PR #{} ({})",
            hint.file, hint.categoria, estado, hint.pr_id, hint.date
        ));
        match hint.motivo.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(motivo) => out.push_str(&format!(": {motivo}\n")),
            None => out.push('\n'),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(id: &str, estado: &str, categoria: &str, archivo: &str, motivo: Option<&str>) -> MemoryFinding {
        MemoryFinding {
            id: id.into(),
            severity: "warning".into(),
            tipo: "Bug".into(),
            categoria: categoria.into(),
            subtitulo: "algo".into(),
            archivo: Some(archivo.into()),
            lineas: Some("10".into()),
            confianza: Some(70),
            estado: estado.into(),
            thread_id: None,
            introducido_en_iter: 1,
            resuelto_en_iter: None,
            motivo_descarte: motivo.map(str::to_string),
            delta: None,
        }
    }

    fn run(pr_id: i64, created_at: &str, findings: Vec<MemoryFinding>) -> PastRun {
        PastRun {
            pr_id,
            created_at: created_at.into(),
            findings_json: serde_json::to_string(&findings).unwrap(),
        }
    }

    #[test]
    fn a_closed_finding_on_a_touched_file_becomes_a_hint() {
        let runs = vec![run(
            812,
            "2026-05-01T10:00:00Z",
            vec![finding("F-001", "falso_positivo", "stale-ref", "src/app/Seguimiento.tsx", Some("el padre remonta por key"))],
        )];
        let hints = for_paths(&runs, &["src/app/Seguimiento.tsx".into()]);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].pr_id, 812);
        assert_eq!(hints[0].date, "2026-05-01");
        assert_eq!(hints[0].motivo.as_deref(), Some("el padre remonta por key"));
    }

    /// An open finding belongs to whatever pull request is still arguing about it — it is not
    /// something this one has to be told.
    #[test]
    fn only_closed_findings_are_hints() {
        let runs = vec![run(
            812,
            "2026-05-01T10:00:00Z",
            vec![
                finding("F-001", "abierto", "a", "src/a.ts", None),
                finding("F-002", "posteado", "b", "src/a.ts", None),
                finding("F-003", "resuelto", "c", "src/a.ts", None),
            ],
        )];
        let hints = for_paths(&runs, &["src/a.ts".into()]);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].categoria, "c");
    }

    #[test]
    fn a_file_this_pr_does_not_touch_produces_nothing() {
        let runs = vec![run(812, "2026-05-01T10:00:00Z", vec![finding("F-001", "resuelto", "a", "src/other.ts", None)])];
        assert!(for_paths(&runs, &["src/a.ts".into()]).is_empty());
        assert!(for_paths(&runs, &[]).is_empty());
    }

    /// Paths arrive spelled differently from the hosts, the model and git.
    #[test]
    fn paths_match_across_their_spellings() {
        let runs = vec![run(812, "2026-05-01T10:00:00Z", vec![finding("F-001", "resuelto", "a", "src/a.ts", None)])];
        assert_eq!(for_paths(&runs, &["/src/a.ts".into()]).len(), 1);
    }

    /// The same defect closed across four iterations of one pull request is one thing worth saying.
    #[test]
    fn the_same_finding_across_runs_is_reported_once_and_newest_first() {
        let runs = vec![
            run(900, "2026-06-01T10:00:00Z", vec![finding("F-001", "falso_positivo", "stale-ref", "src/a.ts", Some("nuevo motivo"))]),
            run(812, "2026-05-01T10:00:00Z", vec![finding("F-001", "falso_positivo", "stale-ref", "src/a.ts", Some("viejo motivo"))]),
        ];
        let hints = for_paths(&runs, &["src/a.ts".into()]);
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].pr_id, 900, "the newest run wins");
        assert_eq!(hints[0].motivo.as_deref(), Some("nuevo motivo"));
    }

    /// The same category closed *differently* is two different pieces of evidence.
    #[test]
    fn the_same_category_in_two_states_is_two_hints() {
        let runs = vec![run(
            812,
            "2026-05-01T10:00:00Z",
            vec![
                finding("F-001", "resuelto", "npe", "src/a.ts", None),
                finding("F-002", "falso_positivo", "npe", "src/a.ts", Some("no aplica")),
            ],
        )];
        assert_eq!(for_paths(&runs, &["src/a.ts".into()]).len(), 2);
    }

    #[test]
    fn the_hint_list_is_bounded() {
        let findings: Vec<MemoryFinding> = (0..80)
            .map(|i| finding(&format!("F-{i:03}"), "resuelto", &format!("cat-{i}"), "src/a.ts", None))
            .collect();
        let runs = vec![run(812, "2026-05-01T10:00:00Z", findings)];
        assert_eq!(for_paths(&runs, &["src/a.ts".into()]).len(), MAX_HINTS);
    }

    #[test]
    fn a_corrupt_run_is_skipped_rather_than_fatal() {
        let runs = vec![
            PastRun { pr_id: 1, created_at: "2026-05-01".into(), findings_json: "not json".into() },
            run(812, "2026-05-01T10:00:00Z", vec![finding("F-001", "resuelto", "a", "src/a.ts", None)]),
        ];
        assert_eq!(for_paths(&runs, &["src/a.ts".into()]).len(), 1);
    }

    #[test]
    fn the_block_frames_the_hint_as_context_rather_than_as_a_rule() {
        let hints = vec![Hint {
            file: "src/a.ts".into(),
            pr_id: 812,
            date: "2026-05-01".into(),
            estado: "falso_positivo".into(),
            categoria: "stale-ref".into(),
            motivo: Some("el padre remonta por key".into()),
        }];
        let block = block(&hints).expect("hints produce a block");
        assert!(block.contains("PR #812"));
        assert!(block.contains("falso positivo"));
        assert!(block.contains("el padre remonta por key"));
        assert!(block.contains("no una prohibición"));
        assert!(block.contains("repórtalo"), "it must stay contradictable");
        assert!(block.is_empty() == false);
        assert!(super::block(&[]).is_none());
    }
}
