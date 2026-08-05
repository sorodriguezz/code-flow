//! Findings back to the review Markdown the whole app already reads.
//!
//! Rendering here rather than taking the model's own text verbatim buys three things that were not
//! previously true. The **format is guaranteed**: a worker that misspells a field or forgets the
//! location no longer produces a finding the frontend cannot anchor to a line. The **ratings and
//! the Quality Gate are derived** from the findings that actually survived the contract, instead of
//! being a self-assessment the model wrote before its own findings were filtered — which is how a
//! review used to come out `Fiabilidad=D` with every `Crítico` dropped by the threshold. And the
//! **ids are the reconciled ones**, so the report, the durable memory and the comment threads on
//! the pull request finally agree on what `F-003` is.
//!
//! The shape is not negotiable: `src/lib/parseAnalysis.ts` and `review_memory::parse_findings` both
//! read it, and posting anchors comments from it.

use super::contract::{Dimension, LevelContract, Ratings, Severity};
use super::merge::Finding;

/// The A–E ratings of a review, from the worst **active** finding in each dimension.
///
/// Closed findings are excluded on purpose: a defect the team fixed, or a human ruled a false
/// positive, must not keep dragging the rating down for the life of the pull request.
pub fn ratings(findings: &[Finding]) -> Ratings {
    let mut out = Ratings::default();
    for finding in findings.iter().filter(|f| f.is_active()) {
        let slot = match finding.tipo.dimension() {
            Dimension::Fiabilidad => &mut out.fiabilidad,
            Dimension::Seguridad => &mut out.seguridad,
            Dimension::Mantenibilidad => &mut out.mantenibilidad,
        };
        let candidate = finding.severity.rating();
        if candidate > *slot {
            *slot = candidate;
        }
    }
    out
}

/// Whether the review passes the repository's Quality Gate: `false` as soon as one active finding
/// carries a severity the policy blocks on. Strictly binary — there is no "passed with warnings",
/// however many non-blocking findings stay open. That nuance belongs in the prose.
pub fn passes_gate(findings: &[Finding], blocking: &[Severity]) -> bool {
    !findings.iter().any(|f| f.is_active() && blocking.contains(&f.severity))
}

/// Everything the report needs that isn't a finding.
pub struct ReportContext<'a> {
    pub contract: &'a LevelContract,
    pub blocking: &'a [Severity],
    /// The model's own prose (summary, strengths, notes), with its self-assessed rating line
    /// already stripped by [`strip_grades`].
    pub narrative: &'a str,
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
    /// Files the scope configuration kept out, so "nothing found" is a verifiable claim about a
    /// stated scope rather than an unqualified one.
    pub out_of_scope: usize,
    /// On a re-review, how many files were actually re-read.
    pub delta_files: Option<usize>,
    /// Files whose content had to be dropped from a bundle to fit its budget.
    pub degraded: &'a [String],
    /// How many workers produced this review — worth stating, because it is what the level bought.
    pub workers: usize,
}

/// Removes the model's own `📈 CALIDAD` line from its prose.
///
/// It is re-derived from the filtered findings, and leaving both in would put two contradictory
/// rating lines in one report — with `parseAnalysis.ts` reading whichever it matched first.
pub fn strip_grades(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim_start().starts_with("📈"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// One finding, in the exact block the standard specifies.
fn render_finding(finding: &Finding) -> String {
    let mut out = format!(
        "### {} [{} · {}] {} · {}\n\n",
        finding.severity.emoji(),
        finding.severity.label(),
        finding.tipo.label(),
        if finding.categoria.is_empty() { "hallazgo" } else { &finding.categoria },
        finding.id,
    );
    if !finding.subtitulo.is_empty() {
        out.push_str(&format!("{}\n\n", finding.subtitulo));
    }
    if let Some(file) = &finding.archivo {
        // Plain text, no backticks: this exact line is parsed to anchor the comment to a line of
        // the pull request, and Markdown around it is what makes that fail.
        match &finding.lineas {
            Some(lines) => out.push_str(&format!("📍 Ubicación: {file}:{lines}\n\n")),
            None => out.push_str(&format!("📍 Ubicación: {file}\n\n")),
        }
    }
    if !finding.por_que.is_empty() {
        out.push_str(&format!("💭 Por qué: {}\n\n", finding.por_que));
    }
    if !finding.sugerencia.is_empty() {
        out.push_str(&format!("💡 Sugerencia: {}\n\n", finding.sugerencia));
    }
    if !finding.ejemplo_code.is_empty() {
        out.push_str(&format!(
            "🛠️ Ejemplo de solución:\n```{}\n{}\n```\n\n",
            finding.ejemplo_lang, finding.ejemplo_code
        ));
    }
    if let Some(confidence) = finding.confianza {
        out.push_str(&format!("🎯 Confianza: {confidence}/100\n\n"));
    }
    out.push_str("---\n\n");
    out
}

/// The scope line: what this review actually looked at.
///
/// It exists so that "found nothing" is checkable. Without it, an empty review and a review whose
/// scope globs excluded the only changed file read identically.
fn scope_line(ctx: &ReportContext) -> String {
    let mut out = format!(
        "🔍 Alcance: {} archivo(s) · +{} −{} · nivel {} · lentes {}",
        ctx.files,
        ctx.additions,
        ctx.deletions,
        ctx.contract.level,
        ctx.contract.lenses.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","),
    );
    if let Some(delta) = ctx.delta_files {
        out.push_str(&format!(" · re-revisión acotada a {delta} archivo(s) modificados"));
    }
    if ctx.workers > 1 {
        out.push_str(&format!(" · {} revisores en paralelo", ctx.workers));
    }
    if ctx.out_of_scope > 0 {
        out.push_str(&format!(" · {} fuera de alcance", ctx.out_of_scope));
    }
    out.push('\n');
    out
}

/// The whole review body.
pub fn review_markdown(findings: &[Finding], ctx: &ReportContext) -> String {
    let ratings = ratings(findings);
    let active: Vec<&Finding> = findings.iter().filter(|f| f.is_active()).collect();
    let gate = passes_gate(findings, ctx.blocking);
    let conclusive = super::contract::gate_is_conclusive(ctx.blocking, &ctx.contract.severities);

    // First line, byte-for-byte what `parseAnalysis.ts`'s `GRADES_RE` expects.
    let mut out = format!(
        "📈 CALIDAD: Fiabilidad={} Seguridad={} Mantenibilidad={}\n\n",
        ratings.fiabilidad, ratings.seguridad, ratings.mantenibilidad
    );

    out.push_str(&format!(
        "🚦 Quality Gate: {}\n",
        if gate { "✅ PASSED" } else { "❌ FAILED" }
    ));
    if gate && !conclusive {
        // A gate that blocks on a severity this level never looked for is a `PASSED` nobody earned,
        // and saying so is the only honest thing the report can do with it.
        let missing: Vec<&str> = ctx
            .blocking
            .iter()
            .filter(|s| !ctx.contract.severities.contains(s))
            .map(|s| s.label())
            .collect();
        out.push_str(&format!(
            "⚠️ Gate no concluyente: la política bloquea en {} y el nivel {} no reporta esa(s) severidad(es).\n",
            missing.join("/"),
            ctx.contract.level
        ));
    }
    out.push_str(&scope_line(ctx));

    if !ctx.degraded.is_empty() {
        out.push_str(&format!(
            "ℹ️ Contexto recortado por presupuesto en: {}. Si algo de ahí importa, vuelve a revisarlo con más nivel.\n",
            ctx.degraded.join(", ")
        ));
    }
    out.push('\n');

    let narrative = ctx.narrative.trim();
    if !narrative.is_empty() {
        out.push_str(narrative);
        out.push_str("\n\n");
    }

    if active.is_empty() {
        out.push_str("✅ Sin hallazgos que reportar en el alcance analizado.\n\n");
    }

    for finding in findings.iter().filter(|f| f.is_active()) {
        out.push_str(&render_finding(finding));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::contract::{resolve_level_contract, FindingType, ReviewEngineConfig};
    use crate::review::merge::parse;

    fn contract(level: &str) -> LevelContract {
        resolve_level_contract(level, &ReviewEngineConfig::default())
    }

    fn ctx<'a>(c: &'a LevelContract, blocking: &'a [Severity], narrative: &'a str) -> ReportContext<'a> {
        ReportContext {
            contract: c,
            blocking,
            narrative,
            files: 3,
            additions: 40,
            deletions: 5,
            out_of_scope: 0,
            delta_files: None,
            degraded: &[],
            workers: 1,
        }
    }

    fn finding(severity: Severity, tipo: FindingType, id: &str) -> Finding {
        let mut f = parse("### 🚨 [Crítico · Bug] x · F-001\n\nsub\n\n📍 Ubicación: a.ts:1-2\n\n💭 Por qué: p\n\n💡 Sugerencia: s\n\n🎯 Confianza: 80")
            .remove(0);
        f.severity = severity;
        f.tipo = tipo;
        f.id = id.into();
        f
    }

    #[test]
    fn ratings_come_from_the_worst_finding_of_each_dimension() {
        let findings = vec![
            finding(Severity::Menor, FindingType::Bug, "F-001"),
            finding(Severity::Blocker, FindingType::Vulnerabilidad, "F-002"),
        ];
        let r = ratings(&findings);
        assert_eq!(r.fiabilidad, 'B');
        assert_eq!(r.seguridad, 'E');
        assert_eq!(r.mantenibilidad, 'A', "a dimension with no findings is A");
    }

    /// The reason the ratings are derived and not taken from the model: a finding the human ruled
    /// out must stop counting.
    #[test]
    fn a_closed_finding_stops_dragging_its_rating_down() {
        let mut f = finding(Severity::Blocker, FindingType::Bug, "F-001");
        f.estado = "falso_positivo".into();
        assert_eq!(ratings(&[f]).fiabilidad, 'A');
    }

    #[test]
    fn the_gate_fails_on_a_blocking_severity_and_ignores_the_rest() {
        let blocking = vec![Severity::Blocker, Severity::Critico];
        assert!(passes_gate(&[finding(Severity::Mayor, FindingType::Bug, "F-001")], &blocking));
        assert!(!passes_gate(&[finding(Severity::Critico, FindingType::Bug, "F-001")], &blocking));
        // Binary: any number of non-blocking findings still passes.
        let many: Vec<Finding> = (0..8).map(|i| finding(Severity::Menor, FindingType::CodeSmell, &format!("F-{i}"))).collect();
        assert!(passes_gate(&many, &blocking));
    }

    #[test]
    fn a_closed_finding_never_fails_the_gate() {
        let mut f = finding(Severity::Blocker, FindingType::Bug, "F-001");
        f.estado = "resuelto".into();
        assert!(passes_gate(&[f], &[Severity::Blocker]));
    }

    #[test]
    fn the_report_opens_with_the_line_the_frontend_parses() {
        let c = contract("completo");
        let blocking = vec![Severity::Blocker, Severity::Critico];
        let md = review_markdown(&[finding(Severity::Mayor, FindingType::Bug, "F-001")], &ctx(&c, &blocking, ""));
        let first = md.lines().next().unwrap();
        assert_eq!(first, "📈 CALIDAD: Fiabilidad=C Seguridad=A Mantenibilidad=A");
    }

    /// The round trip that matters: what this renders, the parser has to read back identically.
    #[test]
    fn a_rendered_finding_parses_back_into_itself() {
        let c = contract("completo");
        let blocking = vec![Severity::Blocker];
        let mut original = finding(Severity::Critico, FindingType::Bug, "F-007");
        original.ejemplo_lang = "ts".into();
        original.ejemplo_code = "if (!x) return;".into();

        let md = review_markdown(std::slice::from_ref(&original), &ctx(&c, &blocking, "resumen"));
        let back = parse(&md);
        assert_eq!(back.len(), 1);
        let back = &back[0];
        assert_eq!(back.id, "F-007");
        assert_eq!(back.severity, Severity::Critico);
        assert_eq!(back.tipo, FindingType::Bug);
        assert_eq!(back.categoria, original.categoria);
        assert_eq!(back.archivo, original.archivo);
        assert_eq!(back.lineas, original.lineas);
        assert_eq!(back.confianza, original.confianza);
        assert_eq!(back.por_que, original.por_que);
        assert_eq!(back.sugerencia, original.sugerencia);
        assert_eq!(back.ejemplo_code, "if (!x) return;");
    }

    #[test]
    fn the_location_line_stays_plain_so_a_comment_can_be_anchored() {
        let c = contract("completo");
        let md = review_markdown(&[finding(Severity::Mayor, FindingType::Bug, "F-001")], &ctx(&c, &[], ""));
        assert!(md.contains("📍 Ubicación: a.ts:1-2"));
        assert!(!md.contains("📍 Ubicación: `"), "no backticks: the value is parsed literally");
    }

    #[test]
    fn the_models_own_rating_line_is_dropped_rather_than_duplicated() {
        let prose = "📈 CALIDAD: Fiabilidad=E Seguridad=E Mantenibilidad=E\n\nEl PR está bien estructurado.";
        let c = contract("completo");
        let md = review_markdown(&[], &ctx(&c, &[], &strip_grades(prose)));
        assert_eq!(md.matches("📈 CALIDAD").count(), 1);
        assert!(md.contains("Fiabilidad=A"), "the derived rating wins");
        assert!(md.contains("bien estructurado"), "the rest of the prose survives");
    }

    #[test]
    fn a_review_with_nothing_to_report_says_so_and_states_its_scope() {
        let c = contract("completo");
        let md = review_markdown(&[], &ctx(&c, &[Severity::Blocker], ""));
        assert!(md.contains("✅ Sin hallazgos"));
        assert!(md.contains("🔍 Alcance: 3 archivo(s) · +40 −5"));
        assert!(md.contains("nivel completo"));
        assert!(md.contains("🚦 Quality Gate: ✅ PASSED"));
    }

    /// The case the conclusiveness check exists for: a policy that blocks on something the level
    /// never looks for.
    #[test]
    fn a_passed_nobody_earned_is_flagged_as_inconclusive() {
        let c = contract("basico");
        let blocking = vec![Severity::Blocker, Severity::Mayor];
        let md = review_markdown(&[], &ctx(&c, &blocking, ""));
        assert!(md.contains("PASSED"));
        assert!(md.contains("Gate no concluyente"));
        assert!(md.contains("Mayor"));
    }

    #[test]
    fn a_conclusive_gate_says_nothing_extra() {
        let c = contract("completo");
        let md = review_markdown(&[], &ctx(&c, &[Severity::Blocker, Severity::Critico], ""));
        assert!(!md.contains("no concluyente"));
    }

    #[test]
    fn trimmed_context_and_a_bounded_re_review_are_both_stated() {
        let c = contract("completo");
        let degraded = vec!["src/big.ts".to_string()];
        let context = ReportContext {
            delta_files: Some(2),
            degraded: &degraded,
            workers: 3,
            ..ctx(&c, &[Severity::Blocker], "")
        };
        let md = review_markdown(&[], &context);
        assert!(md.contains("re-revisión acotada a 2 archivo(s)"));
        assert!(md.contains("3 revisores en paralelo"));
        assert!(md.contains("src/big.ts"));
    }
}
