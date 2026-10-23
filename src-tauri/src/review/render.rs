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
//! The shape is not negotiable: `src/lib/parseAnalysis.ts` and `review::merge::parse` both
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
    /// Files whose reviewer failed: not reviewed this run, said so — and their earlier findings kept
    /// rather than resolved (see `review_memory::Unread`).
    pub unreviewed: &'a [String],
    /// Passes beyond the per-file reviewers that failed (the cross-file pass, the verification).
    pub failed_passes: &'a [String],
    /// How the findings were checked before landing here — see [`Checking`].
    pub checking: Checking,
    /// Active findings in the report that this run did not re-read: carried from an earlier one
    /// because their file did not change (or their reviewer failed). Said once, so a re-review that
    /// read three files does not look as if it found what it only kept.
    pub carried: usize,
}

/// What the checks between the reviewers and the report did, for the one line that says so.
#[derive(Debug, Clone, Copy, Default)]
pub struct Checking {
    /// Findings the verification pass was shown.
    pub verified: usize,
    /// …and how many of those it refuted.
    pub refuted: usize,
    /// Findings dropped for pointing at code that is not there (or not the PR's).
    pub ungrounded: usize,
    /// Locations corrected to where the quoted code really is.
    pub relocated: usize,
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
    if let Some(r) = &finding.reemplazo {
        out.push_str(&format!(
            "✏️ Reemplazo: {}\n```{}\n{}\n```\n\n",
            span_label(r.start, r.end),
            r.lang,
            r.code
        ));
    }
    if let Some(confidence) = finding.confianza {
        out.push_str(&format!("🎯 Confianza: {confidence}/100\n\n"));
    }
    out.push_str("---\n\n");
    out
}

fn span_label(start: u32, end: u32) -> String {
    if end > start { format!("{start}-{end}") } else { start.to_string() }
}

/// A replacement in the host's own suggestion syntax, when it has one and the comment will be
/// anchored on exactly the lines it replaces; otherwise a plain block naming its lines.
///
/// GitHub's ```` ```suggestion ```` replaces the commented range. GitLab anchors a note on the
/// range's **last** line, so its suggestion reaches `end - start` lines up from there. Azure DevOps
/// and Bitbucket have no API-level suggestion, and a block a person can copy is the honest
/// substitute.
pub fn replacement_markdown(finding: &Finding, provider: &str) -> Option<String> {
    let r = finding.reemplazo.as_ref()?;
    let anchored_exactly = crate::review_memory::line_span(finding.lineas.as_deref()) == Some((r.start, r.end));
    Some(match (provider, anchored_exactly) {
        ("github", true) => format!("✏️ **Sugerencia aplicable:**\n```suggestion\n{}\n```", r.code),
        ("gitlab", true) => format!("✏️ **Sugerencia aplicable:**\n```suggestion:-{}+0\n{}\n```", r.end - r.start, r.code),
        _ => format!("✏️ **Reemplazo sugerido (líneas {}):**\n```{}\n{}\n```", span_label(r.start, r.end), r.lang, r.code),
    })
}

/// One finding as the body of a pull-request comment.
///
/// # Why this is not [`render_finding`]
///
/// The report block and the comment block are deliberately different documents. The report is read
/// inside CodeFlow next to every other finding, so it carries the severity label and the location
/// line that anchors it. A comment is read on GitHub/Azure/GitLab *already attached to the line it
/// is about*, so repeating the location under it is noise, and the severity is carried by the
/// emoji. This mirrors `formatFindingAsComment` in `src/lib/parseAnalysis.ts` field for field —
/// they must stay in step, because a finding posted from the desktop and the same finding posted
/// from a phone have to read as the same comment, not as two tools disagreeing.
///
/// # Why it is rendered here and stored
///
/// The durable memory keeps [`crate::review_memory::MemoryFinding`], a slim projection that drops
/// `por_que`, `sugerencia` and `ejemplo_*` — everything a comment is actually made of. A client
/// holding only that projection (the mobile one does; it never sees a `Finding`) can therefore not
/// build this body, and the one that tried posted `subtitulo` alone. That is worse than it sounds:
/// `record_published` writes the resulting thread id back onto the finding, so a one-line comment
/// posted once becomes the thread every *future* desktop publish replies to — the full finding
/// never gets written anywhere. Rendering it at save time is what lets any client publish the same
/// comment the desktop would have.
pub fn comment_markdown(finding: &Finding, provider: &str) -> String {
    let mut out = format!(
        "### {} [{}] {} · {}",
        finding.severity.emoji(),
        finding.tipo.label(),
        if finding.categoria.is_empty() { "hallazgo" } else { &finding.categoria },
        finding.id,
    );
    if !finding.subtitulo.is_empty() {
        out.push_str(&format!("\n\n{}", finding.subtitulo));
    }
    if !finding.por_que.is_empty() {
        out.push_str(&format!("\n\n💭 **Por qué:** {}", finding.por_que));
    }
    if !finding.sugerencia.is_empty() {
        out.push_str(&format!("\n\n💡 **Sugerencia:** {}", finding.sugerencia));
    }
    if !finding.ejemplo_code.is_empty() {
        out.push_str(&format!(
            "\n\n🛠️ Ejemplo de solución:\n```{}\n{}\n```",
            finding.ejemplo_lang, finding.ejemplo_code
        ));
    }
    if let Some(block) = replacement_markdown(finding, provider) {
        out.push_str(&format!("\n\n{block}"));
    }
    if let Some(confidence) = finding.confianza {
        out.push_str(&format!("\n\n🎯 Confianza: {confidence}/100"));
    }
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

    if !ctx.unreviewed.is_empty() || !ctx.failed_passes.is_empty() {
        // Said before anything else is read, because it qualifies everything else: a clean report
        // from a run that lost a reviewer is not a clean report.
        let mut parts: Vec<String> = Vec::new();
        if !ctx.unreviewed.is_empty() {
            parts.push(format!("no se revisaron {}", ctx.unreviewed.join(", ")));
        }
        if !ctx.failed_passes.is_empty() {
            parts.push(format!("falló: {}", ctx.failed_passes.join(", ")));
        }
        out.push_str(&format!(
            "⚠️ Revisión incompleta — {}. Sus hallazgos anteriores se mantienen; vuelve a revisar para completarla.\n",
            parts.join(" · ")
        ));
    }
    let c = ctx.checking;
    if c.verified > 0 || c.ungrounded > 0 || c.relocated > 0 {
        let mut parts: Vec<String> = Vec::new();
        if c.verified > 0 {
            parts.push(format!("{} verificado(s), {} refutado(s)", c.verified, c.refuted));
        }
        if c.ungrounded > 0 {
            parts.push(format!("{} descartado(s) al cotejarlos con el código del PR", c.ungrounded));
        }
        if c.relocated > 0 {
            parts.push(format!("{} ubicación(es) corregida(s)", c.relocated));
        }
        out.push_str(&format!("🔎 Verificación: {}\n", parts.join(" · ")));
    }

    if ctx.carried > 0 {
        out.push_str(&format!(
            "↪️ {} hallazgo(s) se mantienen de la revisión anterior: su archivo no se volvió a revisar en esta.\n",
            ctx.carried
        ));
    }
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

    if active.is_empty() && ctx.unreviewed.is_empty() {
        out.push_str("✅ Sin hallazgos que reportar en el alcance analizado.\n\n");
    } else if active.is_empty() {
        out.push_str("Sin hallazgos en lo que sí se revisó.\n\n");
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
            unreviewed: &[],
            failed_passes: &[],
            checking: Checking::default(),
            carried: 0,
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

    /// The whole reason `comentario_md` is stored: the slim memory a phone reads drops `por_que`,
    /// `sugerencia` and `ejemplo_*`, so a comment built from the memory alone would be the subtitle
    /// and nothing else — and the thread id that comes back would pin every later publish to it.
    #[test]
    fn a_comment_carries_the_fields_the_stored_memory_drops() {
        let body = comment_markdown(&finding(Severity::Mayor, FindingType::Bug, "F-007"), "github");
        assert!(body.contains("F-007"), "the reconciled id, not the pre-reconciliation one");
        assert!(body.contains("**Por qué:** p"));
        assert!(body.contains("**Sugerencia:** s"));
        assert!(body.contains("🎯 Confianza: 80/100"));
    }

    /// A comment is posted *attached to* the line it is about, so repeating the location inside it
    /// is noise — and the desktop's own `formatFindingAsComment` leaves it out for that reason.
    /// The two have to agree, or the same finding reads as two different comments depending on
    /// which device published it.
    #[test]
    fn a_comment_leaves_out_the_location_the_report_block_carries() {
        let f = finding(Severity::Mayor, FindingType::Bug, "F-001");
        assert!(!comment_markdown(&f, "github").contains("📍 Ubicación"));
        assert!(render_finding(&f).contains("📍 Ubicación: a.ts:1-2"));
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

    /// A run that lost a reviewer never reads as a clean bill of health.
    #[test]
    fn an_incomplete_review_says_so_and_does_not_claim_clean() {
        let c = contract("completo");
        let unreviewed = vec!["src/pago.ts".to_string()];
        let context = ReportContext { unreviewed: &unreviewed, ..ctx(&c, &[Severity::Blocker], "") };
        let md = review_markdown(&[], &context);
        assert!(md.contains("Revisión incompleta"));
        assert!(md.contains("src/pago.ts"));
        assert!(!md.contains("✅ Sin hallazgos"));
    }

    #[test]
    fn the_checking_line_counts_what_the_checks_did() {
        let c = contract("ultra");
        let context = ReportContext {
            checking: Checking { verified: 3, refuted: 1, ungrounded: 2, relocated: 1 },
            ..ctx(&c, &[Severity::Blocker], "")
        };
        let md = review_markdown(&[], &context);
        assert!(md.contains("🔎 Verificación: 3 verificado(s), 1 refutado(s) · 2 descartado(s)"));
    }

    /// The re-review bug: a Blocker on a file the re-review did not touch was kept in the memory but
    /// left out of the report and of the gate, which then read PASSED. Rebuilt from the report that
    /// rendered it, it is back in both — with its prose, and with the memory's lifecycle.
    #[test]
    fn a_carried_blocker_is_in_the_report_and_fails_the_gate() {
        let earlier_md = "### 🚨 [Blocker · Vulnerabilidad] sql-injection · F-002\n\nSQL armado con concatenación\n\n📍 Ubicación: src/repo.ts:40-44\n\n💭 Por qué: el id llega del request.\n\n💡 Sugerencia: parametriza la consulta.\n\n🎯 Confianza: 90\n\n---\n\n";
        let earlier = vec![parse(earlier_md)];
        let memory: crate::review_memory::MemoryFinding = serde_json::from_value(serde_json::json!({
            "id": "F-002", "severity": "critical", "severidad": "Blocker", "tipo": "Vulnerabilidad",
            "categoria": "sql-injection", "subtitulo": "SQL armado con concatenación", "archivo": "src/repo.ts",
            "lineas": "41-45", "confianza": 90, "estado": "posteado", "thread_id": 77,
            "introducido_en_iter": 1, "delta": "persiste"
        }))
        .unwrap();
        let carried = Finding::recovered(&memory, &earlier);
        assert_eq!(carried.severity, Severity::Blocker);
        assert_eq!(carried.por_que, "el id llega del request.", "the prose comes back from the report that had it");
        assert_eq!(carried.lineas.as_deref(), Some("41-45"), "the memory's place wins");
        assert_eq!((carried.estado.as_str(), carried.thread_id), ("posteado", Some(77)));

        let c = contract("completo");
        let blocking = [Severity::Blocker];
        let context = ReportContext { carried: 1, ..ctx(&c, &blocking, "") };
        let md = review_markdown(std::slice::from_ref(&carried), &context);
        assert!(md.contains("❌ FAILED"), "{md}");
        assert!(md.contains("sql-injection · F-002"));
        assert!(md.contains("↪️ 1 hallazgo(s) se mantienen de la revisión anterior"));
        assert!(!passes_gate(&[carried], &blocking));
    }

    /// One no earlier report holds is still rebuilt from the memory, and its severity is never
    /// downgraded past what the gate blocks on.
    #[test]
    fn a_carried_finding_no_report_holds_keeps_its_severity_and_place() {
        let memory = |severidad: &str| -> crate::review_memory::MemoryFinding {
            serde_json::from_value(serde_json::json!({
                "id": "F-004", "severity": "critical", "severidad": severidad, "tipo": "Bug",
                "categoria": "null-dereference", "subtitulo": "saldo sin validar", "archivo": "src/pago.ts",
                "lineas": "12", "estado": "abierto", "introducido_en_iter": 2
            }))
            .unwrap()
        };
        let rebuilt = Finding::recovered(&memory("Blocker"), &[]);
        assert_eq!((rebuilt.severity, rebuilt.subtitulo.as_str()), (Severity::Blocker, "saldo sin validar"));
        assert_eq!((rebuilt.archivo.as_deref(), rebuilt.lineas.as_deref()), (Some("src/pago.ts"), Some("12")));
        // A run from before the fine severity was kept: `critical` reads as Crítico, still blocking.
        assert_eq!(Finding::recovered(&memory(""), &[]).severity, Severity::Critico);
        // Another finding that happens to hold the same id in an older report is not borrowed.
        let other = vec![parse("### ⚠️ [Mayor · Code Smell] dead-code · F-004\n\notra cosa\n\n📍 Ubicación: src/otro.ts:3\n\n---\n\n")];
        assert_eq!(Finding::recovered(&memory("Blocker"), &other).categoria, "null-dereference");
    }

    /// A replacement becomes a one-click suggestion only where the host has one and the comment
    /// lands on exactly the lines it replaces.
    #[test]
    fn a_replacement_is_a_suggestion_only_where_it_can_apply() {
        let mut f = parse(
            "### 🚨 [Crítico · Bug] npe · F-001\n\nsub\n\n📍 Ubicación: a.ts:4-5\n\n💭 Por qué: p\n\n✏️ Reemplazo: 4-5\n```ts\nif (!c) return;\nreturn c.saldo;\n```\n\n🎯 Confianza: 80",
        )
        .remove(0);
        let r = f.reemplazo.clone().expect("parsed");
        assert_eq!((r.start, r.end, r.lang.as_str()), (4, 5, "ts"));
        assert!(comment_markdown(&f, "github").contains("```suggestion\nif (!c) return;"));
        assert!(comment_markdown(&f, "gitlab").contains("```suggestion:-1+0"));
        assert!(comment_markdown(&f, "azure").contains("Reemplazo sugerido (líneas 4-5)"));
        assert!(review_markdown(&[f.clone()], &ctx(&contract("completo"), &[Severity::Blocker], "")).contains("✏️ Reemplazo: 4-5"));
        f.lineas = Some("9".into());
        assert!(!comment_markdown(&f, "github").contains("```suggestion"), "anchored elsewhere: a plain block");
    }
}
