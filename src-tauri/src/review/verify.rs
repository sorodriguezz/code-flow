//! Checking what the reviewers wrote before anyone reads it.
//!
//! Two layers, cheapest first. **Grounding** is arithmetic and costs nothing: a finding has to point
//! at a file that exists in the pull request's commit, its quoted evidence has to be in that file,
//! and a minor finding has to be about code the PR actually touched. That alone removes the two
//! failure modes a reviewer working from memory produces — the bug described in code that is not
//! there, and the comment anchored ten lines away from the code it is about (the evidence says where
//! the code really is, so the location is corrected rather than the finding dropped).
//!
//! **Verification** is a model pass, and the level decides whether to spend it: each serious finding
//! is shown back with its code and the pass tries to *refute* it. It is small on purpose — a handful
//! of findings, a few dozen lines each — because it is the place where a false positive costs the
//! most (a Blocker blocks a merge) and is the cheapest to check.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use super::contract::{LevelContract, Severity};
use super::merge::{Discarded, Finding};
use super::outline::{same_path, ChangedFile};
use crate::review_memory::line_span;

/// Evidence shorter than this (whitespace removed) proves nothing — `}` or `return;` is everywhere.
const MIN_EVIDENCE_CHARS: usize = 8;

/// How much a finding's confidence drops when its evidence is nowhere in its file. Not straight to
/// zero: the model may have paraphrased a real line, and the contract's threshold decides the rest.
const UNFOUND_EVIDENCE_PENALTY: u8 = 25;

/// The confidence a finding that stated none is assumed to have, when it has to be penalised.
const ASSUMED_CONFIDENCE: u8 = 70;

/// How far beyond what the PR touched a `Mayor`/`Menor`/`Info` may sit and still be about the change.
const TOUCH_MARGIN: usize = 3;

/// The same margin for a file without recognised symbols, where the touched code has no range to
/// fall back on — the bundle shows twelve lines around each change there, so the reviewer saw them.
const NO_SYMBOL_MARGIN: usize = 12;

/// How many findings one verification pass reads. The most severe come first; past this the rest
/// pass unverified rather than turning the pass into a second review.
pub const MAX_VERIFIED: usize = 12;

/// What the checks can read.
pub struct Sources<'a> {
    /// The PR's readable files, as the reviewers saw them.
    pub files: &'a [ChangedFile],
    /// The files the PR deleted.
    pub deleted: &'a [ChangedFile],
    /// A file outside the PR, at the PR's head commit — `None` when it does not exist there.
    pub outside: &'a (dyn Fn(&str) -> Option<String> + Sync),
}

impl Sources<'_> {
    fn in_pr(&self, path: &str) -> Option<&ChangedFile> {
        self.files.iter().find(|f| same_path(&f.path, path))
    }

    fn deleted(&self, path: &str) -> Option<&ChangedFile> {
        self.deleted.iter().find(|f| same_path(&f.path, path))
    }
}

/// What grounding did.
#[derive(Debug, Default)]
pub struct Grounding {
    pub findings: Vec<Finding>,
    pub discarded: Vec<Discarded>,
    /// `(finding id or category, from, to)` for each location corrected from its evidence — logged,
    /// because a moved anchor is a decision somebody may want to check.
    pub relocated: Vec<(String, String, String)>,
}

fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Whether one line of code is the quoted evidence. Whitespace-blind, because a model re-indents
/// what it quotes; and in both directions, because it sometimes quotes a line plus the start of the
/// next one.
fn line_matches(line: &str, evidence: &str) -> bool {
    let line = compact(line);
    if line.is_empty() {
        return false;
    }
    line.contains(evidence) || (line.chars().count() >= MIN_EVIDENCE_CHARS && evidence.contains(&line))
}

/// 1-based lines of `content` that hold the evidence.
fn hits(content: &str, evidence: &str) -> Vec<u32> {
    content
        .lines()
        .enumerate()
        .filter(|(_, line)| line_matches(line, evidence))
        .map(|(i, _)| i as u32 + 1)
        .collect()
}

fn format_span(start: u32, end: u32) -> String {
    if end > start { format!("{start}-{end}") } else { start.to_string() }
}

/// Lowers a finding's confidence for evidence that is nowhere to be found — or, when that takes it
/// under its threshold, leaves it alone and returns the reason to discard it.
fn penalise(finding: &mut Finding, contract: &LevelContract, why: String) -> Option<String> {
    let lowered = finding.confianza.unwrap_or(ASSUMED_CONFIDENCE).saturating_sub(UNFOUND_EVIDENCE_PENALTY);
    if lowered < contract.threshold_for(finding.severity) {
        return Some(why);
    }
    finding.confianza = Some(lowered);
    None
}

/// Moves a finding to the evidence line nearest to where it said it was, keeping its length — and
/// its replacement with it, when the replacement was written for the old span.
fn relocate(finding: &mut Finding, found: &[u32], total: u32) -> Option<(String, String)> {
    let span = line_span(finding.lineas.as_deref());
    if let Some((start, end)) = span {
        // Already there (a quoted line one off the stated range is the same place).
        if found.iter().any(|h| *h + 1 >= start && *h <= end + 1) {
            return None;
        }
    }
    let anchor = match span {
        Some((start, _)) => *found.iter().min_by_key(|h| h.abs_diff(start))?,
        None => *found.first()?,
    };
    let length = span.map(|(s, e)| e.saturating_sub(s)).unwrap_or(0).min(29);
    let (new_start, new_end) = (anchor, (anchor + length).min(total.max(anchor)));
    let before = finding.lineas.clone().unwrap_or_else(|| "?".into());
    let after = format_span(new_start, new_end);
    if let (Some((start, end)), Some(replacement)) = (span, finding.reemplazo.as_mut()) {
        if replacement.start == start && replacement.end == end {
            replacement.start = new_start;
            replacement.end = new_end;
        } else {
            // Written against lines that turned out to be somewhere else: no longer trustworthy.
            finding.reemplazo = None;
        }
    }
    finding.lineas = Some(after.clone());
    Some((before, after))
}

/// The stretches of a PR file a minor finding has to fall inside to be about the change.
fn touched_windows(file: &ChangedFile) -> Vec<(usize, usize)> {
    let margin = if file.symbols.is_empty() { NO_SYMBOL_MARGIN } else { TOUCH_MARGIN };
    let mut windows: Vec<(usize, usize)> = file.symbols.iter().map(|s| (s.start, s.end)).collect();
    windows.extend(file.touched().iter().map(|l| (l.saturating_sub(margin).max(1), l + margin)));
    windows
}

/// Whether the evidence is real code in some *other* file of the PR (new side or deleted lines).
fn quoted_elsewhere(sources: &Sources, path: &str, evidence: &str) -> bool {
    sources.files.iter().filter(|f| !same_path(&f.path, path)).any(|f| {
        !hits(&f.content, evidence).is_empty() || f.removed.iter().any(|b| b.lines.iter().any(|l| line_matches(l, evidence)))
    })
}

/// The deterministic checks. Findings that are not `abierto` (a previous run's, carried) pass
/// untouched; everything else is grounded against the code it names.
pub fn ground(findings: Vec<Finding>, sources: &Sources, contract: &LevelContract) -> Grounding {
    let mut out = Grounding::default();
    let mut outside_cache: HashMap<String, Option<String>> = HashMap::new();

    for mut finding in findings {
        if finding.estado != "abierto" {
            out.findings.push(finding);
            continue;
        }
        let Some(path) = finding.archivo.clone() else {
            out.findings.push(finding);
            continue;
        };
        let evidence = compact(&finding.evidencia);
        let has_evidence = evidence.chars().count() >= MIN_EVIDENCE_CHARS;
        let label = if finding.categoria.is_empty() { finding.subtitulo.clone() } else { finding.categoria.clone() };

        if let Some(file) = sources.in_pr(&path) {
            let total = file.lines as u32;
            let found = if has_evidence { hits(&file.content, &evidence) } else { Vec::new() };
            if !found.is_empty() {
                if let Some((from, to)) = relocate(&mut finding, &found, total) {
                    out.relocated.push((label.clone(), from, to));
                }
            } else if has_evidence {
                // Quoting a line the PR deleted is quoting real code: the finding is about the removal.
                let removed_at = file
                    .removed
                    .iter()
                    .find(|b| b.lines.iter().any(|l| line_matches(l, &evidence)))
                    .map(|b| (b.before as u32).min(total.max(1)));
                match removed_at {
                    Some(at) => {
                        let inside = line_span(finding.lineas.as_deref()).is_some_and(|(s, e)| at + 1 >= s && at <= e + 1);
                        if !inside {
                            let before = finding.lineas.clone().unwrap_or_else(|| "?".into());
                            finding.lineas = Some(at.to_string());
                            finding.reemplazo = None;
                            out.relocated.push((label.clone(), before, at.to_string()));
                        }
                    }
                    // Quoted from another file of the PR — the caller it reasons about, typically.
                    // Real code, just not this file's: nothing to correct and nothing to doubt.
                    None if quoted_elsewhere(sources, &file.path, &evidence) => {}
                    None => {
                        let why = format!("la evidencia citada no aparece en {}", file.path);
                        if let Some(reason) = penalise(&mut finding, contract, why) {
                            out.discarded.push(Discarded { finding, reason });
                            continue;
                        }
                    }
                }
            } else if line_span(finding.lineas.as_deref()).is_some_and(|(start, _)| start > total) {
                // No evidence to correct it from, and a location past the end of the file.
                let why = format!("las líneas {} están fuera de {} ({total} líneas)", finding.lineas.clone().unwrap_or_default(), file.path);
                if let Some(reason) = penalise(&mut finding, contract, why) {
                    out.discarded.push(Discarded { finding, reason });
                    continue;
                }
            }

            // A minor finding outside everything the PR touched is about code that was already there.
            if matches!(finding.severity, Severity::Mayor | Severity::Menor | Severity::Info) {
                if let Some((start, end)) = line_span(finding.lineas.as_deref()) {
                    let windows = touched_windows(file);
                    let (start, end) = (start as usize, end as usize);
                    if !windows.iter().any(|(a, b)| start <= *b && *a <= end) {
                        out.discarded.push(Discarded {
                            reason: format!("fuera de lo que cambió el PR en {} (código preexistente)", file.path),
                            finding,
                        });
                        continue;
                    }
                }
            }
            if let Some(replacement) = &finding.reemplazo {
                if replacement.start == 0 || replacement.end > total.max(1) || replacement.start > replacement.end {
                    finding.reemplazo = None;
                }
            }
            out.findings.push(finding);
            continue;
        }

        if sources.deleted(&path).is_some() {
            // About a file the PR removes: nothing on the new side to check against or anchor to.
            finding.reemplazo = None;
            out.findings.push(finding);
            continue;
        }

        // Outside the PR — a caller the change breaks, typically. It has to exist, at least.
        let content = outside_cache
            .entry(super::outline::normalize_path(&path).to_lowercase())
            .or_insert_with(|| (sources.outside)(&path))
            .clone();
        let Some(content) = content else {
            out.discarded.push(Discarded { reason: format!("{path} no existe en el commit del PR"), finding });
            continue;
        };
        // Never anchored inline on a host (it is not in the diff), so a suggestion could not apply.
        finding.reemplazo = None;
        if has_evidence {
            let found = hits(&content, &evidence);
            if found.is_empty() {
                let why = format!("la evidencia citada no aparece en {path}");
                if let Some(reason) = penalise(&mut finding, contract, why) {
                    out.discarded.push(Discarded { finding, reason });
                    continue;
                }
            } else if let Some((from, to)) = relocate(&mut finding, &found, content.lines().count() as u32) {
                out.relocated.push((label, from, to));
            }
        }
        out.findings.push(finding);
    }
    out
}

// ---------------------------------------------------------------------------
// The verification pass
// ---------------------------------------------------------------------------

/// What the verifier is told. Stated in code, like the bundle's evidence rules, so every workspace
/// gets it whatever its editable prompts say.
pub const VERIFY_ROLE: &str = r#"## TU ROL: VERIFICADOR
Recibes por stdin hallazgos que otros revisores reportaron sobre este pull request, cada uno con el código que lo rodea (misma notación del bundle: '>' agregado o modificado por el PR, '-' eliminado por el PR, sin número).

Tu trabajo es intentar REFUTAR cada hallazgo. Es REFUTADO solo si el código demuestra que es falso:
- el caso ya está manejado (ahí mismo o en código visible),
- la premisa no se cumple (el valor no puede ser nulo, el tipo no lo permite, la rama es inalcanzable),
- el código no hace lo que el hallazgo dice,
- o el problema es preexistente y el PR no lo toca.
Si no puedes refutarlo con certeza a partir del código, es CONFIRMADO. No cambies severidades ni agregues hallazgos nuevos. Abre otros archivos con tus herramientas solo si el fragmento no alcanza para decidir.

Responde con UNA línea por hallazgo, exactamente así (y nada más):
VERIFICACIÓN F-001: CONFIRMADO
VERIFICACIÓN F-002: REFUTADO — <motivo en una frase>"#;

/// The same job folded into the closing summary of a fanned-out review — one model call instead of
/// two, the verdicts first so the summary is written knowing which findings stand.
pub const CLOSING_VERIFY_NOTE: &str = r#"

## ANTES DEL RESUMEN: VERIFICA
Al final del stdin, bajo "HALLAZGOS A VERIFICAR", vienen los hallazgos más graves con su código ('>' agregado o modificado por el PR, '-' eliminado). Intenta REFUTAR cada uno: es REFUTADO solo si el código demuestra que es falso (ya está manejado, la premisa no se cumple, el código no hace eso, o es preexistente); si no puedes refutarlo con certeza, es CONFIRMADO.
Empieza tu respuesta con UNA línea por cada uno, exactamente así:
VERIFICACIÓN F-001: CONFIRMADO
VERIFICACIÓN F-002: REFUTADO — <motivo en una frase>
Después escribe el resumen como se te pidió, sin mencionar los hallazgos que refutaste."#;

/// The findings worth a second look under this contract: open, of a severity the level verifies,
/// most severe first, capped at [`MAX_VERIFIED`]. Indices into `findings`.
pub fn candidates(findings: &[Finding], contract: &LevelContract) -> Vec<usize> {
    let mut picks: Vec<usize> = findings
        .iter()
        .enumerate()
        .filter(|(_, f)| f.estado == "abierto" && contract.verify.contains(&f.severity))
        .map(|(i, _)| i)
        .collect();
    picks.sort_by_key(|i| (findings[*i].severity, std::cmp::Reverse(findings[*i].confianza.unwrap_or(0))));
    picks.truncate(MAX_VERIFIED);
    picks
}

/// Lines around a finding in a file outside the PR (or with no outline): numbered, no marks.
fn plain_snippet(content: &str, start: u32, end: u32, pad: u32) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let total = lines.len() as u32;
    let (a, b) = (start.saturating_sub(pad).max(1), (end + pad).min(total));
    let width = total.to_string().len();
    (a..=b.max(a)).filter_map(|n| lines.get(n as usize - 1).map(|l| format!(" {n:>width$} | {l}\n"))).collect()
}

/// The code one finding is about, as the verifier gets it.
fn code_for(finding: &Finding, sources: &Sources) -> String {
    let Some(path) = finding.archivo.as_deref() else { return String::new() };
    let span = line_span(finding.lineas.as_deref());
    if let Some(file) = sources.in_pr(path) {
        let (start, end) = span.map(|(s, e)| (s as usize, e as usize)).unwrap_or((1, 1));
        // The touched symbol around it, when it is short enough to read whole; otherwise a window.
        let symbol = file.symbols.iter().find(|s| s.start <= start && end <= s.end && s.end - s.start <= 80);
        let (a, b) = match symbol {
            Some(s) => (s.start, s.end),
            None => (start.saturating_sub(12).max(1), end + 12),
        };
        return super::bundle::snippet(file, a, b);
    }
    if let Some(file) = sources.deleted(path) {
        let lines: Vec<String> = file.removed.iter().flat_map(|b| b.lines.iter()).take(40).map(|l| format!("- | {l}\n")).collect();
        return lines.concat();
    }
    match ((sources.outside)(path), span) {
        (Some(content), Some((s, e))) => plain_snippet(&content, s, e, 12),
        _ => String::new(),
    }
}

/// The verifier's stdin: each picked finding with its claim and its code.
pub fn payload(findings: &[Finding], picks: &[usize], sources: &Sources) -> String {
    let mut out = String::from("HALLAZGOS A VERIFICAR\n\n");
    for i in picks {
        let f = &findings[*i];
        let location = match (&f.archivo, &f.lineas) {
            (Some(file), Some(lines)) => format!("{file}:{lines}"),
            (Some(file), None) => file.clone(),
            _ => "sin ubicación".into(),
        };
        out.push_str(&format!(
            "### {} · [{} · {}] {} · {}\n{}\n",
            f.id,
            f.severity.label(),
            f.tipo.label(),
            if f.categoria.is_empty() { "hallazgo" } else { &f.categoria },
            location,
            f.subtitulo
        ));
        if !f.por_que.is_empty() {
            out.push_str(&format!("Por qué: {}\n", f.por_que));
        }
        let code = code_for(f, sources);
        if !code.is_empty() {
            out.push_str("```\n");
            out.push_str(&code);
            out.push_str("```\n");
        }
        out.push('\n');
    }
    out
}

fn verdict_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?mi)^[\s>*_`-]*VERIFICACI[ÓO]N\s+(F-\d+)\s*[:：]\s*\**\s*(CONFIRMADO|REFUTADO)\**\s*(?:[—–:\-]+\s*(.*))?$")
            .expect("valid verdict regex")
    })
}

/// One verdict: refuted or not, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub refuted: bool,
    pub reason: String,
}

/// Every verdict line in a reply, by finding id. A finding with no line is not refuted — the pass
/// is lenient the same way the threshold is: losing a real defect to a missing line is the one
/// failure it must not add.
pub fn parse_verdicts(text: &str) -> HashMap<String, Verdict> {
    verdict_re()
        .captures_iter(text)
        .filter_map(|c| {
            let id = c.get(1)?.as_str().to_uppercase();
            let refuted = c.get(2)?.as_str().eq_ignore_ascii_case("refutado");
            let reason = c.get(3).map(|m| m.as_str().trim().trim_matches('*').trim().to_string()).unwrap_or_default();
            Some((id, Verdict { refuted, reason }))
        })
        .collect()
}

/// The reply without its verdict lines — what is left is the closing pass's summary.
pub fn strip_verdicts(text: &str) -> String {
    verdict_re().replace_all(text, "").lines().skip_while(|l| l.trim().is_empty()).collect::<Vec<_>>().join("\n").trim().to_string()
}

/// Drops what the verifier refuted, among the findings it was actually shown.
pub fn apply(findings: Vec<Finding>, picks: &[String], verdicts: &HashMap<String, Verdict>) -> (Vec<Finding>, Vec<Discarded>) {
    let mut kept = Vec::with_capacity(findings.len());
    let mut dropped = Vec::new();
    for finding in findings {
        let verdict = picks.contains(&finding.id).then(|| verdicts.get(&finding.id.to_uppercase())).flatten();
        match verdict {
            Some(v) if v.refuted => dropped.push(Discarded {
                reason: if v.reason.is_empty() { "refutado en la verificación".into() } else { format!("refutado en la verificación: {}", v.reason) },
                finding,
            }),
            _ => kept.push(finding),
        }
    }
    (kept, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::contract::{resolve_level_contract, ReviewEngineConfig};
    use crate::review::merge::parse;
    use crate::review::outline::{RemovedBlock, Symbol};

    fn contract(level: &str) -> LevelContract {
        resolve_level_contract(level, &ReviewEngineConfig::default())
    }

    const CODE: &str = "\
export function pagar(dto) {
  const cuenta = buscar(dto.id);
  return cuenta.saldo;
}

export function otra() {
  return 1;
}
";

    fn pr_file() -> ChangedFile {
        ChangedFile {
            path: "src/pago.ts".into(),
            status: "modified".into(),
            content: CODE.into(),
            lines: CODE.lines().count(),
            changed: [3].into_iter().collect(),
            symbols: vec![Symbol { start: 1, end: 4, label: "export function pagar(dto)".into() }],
            ..Default::default()
        }
    }

    fn finding(sev: &str, lines: &str, evidence: &str) -> Finding {
        parse(&format!(
            "### 🚨 [{sev} · Bug] null-dereference · F-001\n\nSe lee saldo sin validar.\n\n📍 Ubicación: src/pago.ts:{lines}\n\n💭 Por qué: buscar puede devolver null.\n\n🔎 Evidencia: `{evidence}`\n\n🎯 Confianza: 80/100\n"
        ))
        .remove(0)
    }

    fn no_outside(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn evidence_is_parsed_and_a_right_location_is_left_alone() {
        let files = [pr_file()];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        let f = finding("Crítico", "3", "return cuenta.saldo;");
        assert_eq!(f.evidencia, "return cuenta.saldo;");
        let g = ground(vec![f], &sources, &contract("completo"));
        assert_eq!(g.findings.len(), 1);
        assert_eq!(g.findings[0].lineas.as_deref(), Some("3"));
        assert!(g.relocated.is_empty());
    }

    /// The evidence says where the code really is — the anchor follows it.
    #[test]
    fn a_misplaced_location_is_corrected_from_its_evidence() {
        let files = [pr_file()];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        let g = ground(vec![finding("Crítico", "7-8", "return   cuenta.saldo;")], &sources, &contract("completo"));
        assert_eq!(g.findings[0].lineas.as_deref(), Some("3-4"));
        assert_eq!(g.relocated.len(), 1);
    }

    #[test]
    fn evidence_that_is_nowhere_in_the_file_costs_the_finding_its_place() {
        let files = [pr_file()];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        // 80 - 25 = 55 < 60 (completo's threshold for Crítico): out.
        let g = ground(vec![finding("Crítico", "3", "await repositorio.borrarTodo();")], &sources, &contract("completo"));
        assert!(g.findings.is_empty());
        assert!(g.discarded[0].reason.contains("no aparece"));
        // A Blocker's lower bar keeps it, with the doubt written into its confidence.
        let g = ground(vec![finding("Blocker", "3", "await repositorio.borrarTodo();")], &sources, &contract("completo"));
        assert_eq!(g.findings[0].confianza, Some(55));
    }

    #[test]
    fn evidence_quoted_from_another_pr_file_is_not_held_against_the_finding() {
        let caller = ChangedFile {
            path: "src/carrito.ts".into(),
            content: "const total = pagar(dto) + envio;\n".into(),
            lines: 1,
            ..Default::default()
        };
        let files = [pr_file(), caller];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        let g = ground(vec![finding("Crítico", "3", "const total = pagar(dto) + envio;")], &sources, &contract("completo"));
        assert_eq!(g.findings.len(), 1);
        assert_eq!(g.findings[0].confianza, Some(80), "no penalty");
    }

    #[test]
    fn a_quoted_deleted_line_is_real_code() {
        let mut file = pr_file();
        file.removed = vec![RemovedBlock { before: 3, lines: vec!["  if (!cuenta) throw new NotFound();".into()] }];
        let files = [file];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        let g = ground(vec![finding("Crítico", "3", "if (!cuenta) throw new NotFound();")], &sources, &contract("completo"));
        assert_eq!(g.findings.len(), 1, "about the removal, so it stays");
    }

    #[test]
    fn a_minor_finding_on_untouched_code_is_preexisting() {
        let files = [pr_file()];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        let mut f = finding("Mayor", "7", "return 1;");
        f.evidencia.clear();
        let g = ground(vec![f], &sources, &contract("completo"));
        assert!(g.findings.is_empty());
        assert!(g.discarded[0].reason.contains("preexistente"));
        // A Crítico in the same place is not dropped by this rule — it is the verifier's to judge.
        let mut f = finding("Crítico", "7", "return 1;");
        f.evidencia.clear();
        assert_eq!(ground(vec![f], &sources, &contract("completo")).findings.len(), 1);
    }

    #[test]
    fn a_file_outside_the_pr_has_to_exist() {
        let files = [pr_file()];
        let caller = |path: &str| (path == "src/carrito.ts").then(|| "import { pagar } from './pago';\npagar(dto);\n".to_string());
        let sources = Sources { files: &files, deleted: &[], outside: &caller };
        let mut gone = finding("Crítico", "2", "pagar(dto);");
        gone.archivo = Some("src/inventado.ts".into());
        let mut real = finding("Crítico", "9", "pagar(dto);");
        real.archivo = Some("src/carrito.ts".into());
        let g = ground(vec![gone, real], &sources, &contract("completo"));
        assert_eq!(g.findings.len(), 1);
        assert_eq!(g.findings[0].archivo.as_deref(), Some("src/carrito.ts"));
        assert_eq!(g.findings[0].lineas.as_deref(), Some("2"), "relocated to where the call really is");
        assert!(g.discarded[0].reason.contains("no existe"));
    }

    #[test]
    fn verdicts_parse_in_the_shapes_models_write_them() {
        let text = "VERIFICACIÓN F-001: CONFIRMADO\n**VERIFICACION F-002: REFUTADO** — el null se valida en la línea 2\n- VERIFICACIÓN F-003 : refutado: ya lo cubre el guard\n\nEl PR agrega pagos.";
        let v = parse_verdicts(text);
        assert_eq!(v.len(), 3);
        assert!(!v["F-001"].refuted);
        assert!(v["F-002"].refuted);
        assert!(v["F-002"].reason.contains("línea 2"));
        assert!(v["F-003"].refuted);
        assert_eq!(strip_verdicts(text), "El PR agrega pagos.");
    }

    #[test]
    fn only_what_was_shown_can_be_refuted() {
        let mut a = finding("Blocker", "3", "return cuenta.saldo;");
        a.id = "F-001".into();
        let mut b = finding("Blocker", "3", "return cuenta.saldo;");
        b.id = "F-002".into();
        let verdicts = parse_verdicts("VERIFICACIÓN F-001: REFUTADO — manejado\nVERIFICACIÓN F-002: REFUTADO — x");
        let (kept, dropped) = apply(vec![a, b], &["F-001".to_string()], &verdicts);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "F-002", "never shown to the verifier, so its verdict is noise");
        assert!(dropped[0].reason.contains("manejado"));
    }

    #[test]
    fn candidates_follow_the_level_and_lead_with_the_worst() {
        let files = [pr_file()];
        let sources = Sources { files: &files, deleted: &[], outside: &no_outside };
        let mut major = finding("Mayor", "3", "return cuenta.saldo;");
        major.id = "F-002".into();
        let mut blocker = finding("Blocker", "3", "return cuenta.saldo;");
        blocker.id = "F-001".into();
        let findings = vec![major, blocker];
        assert!(candidates(&findings, &contract("basico")).is_empty());
        assert_eq!(candidates(&findings, &contract("completo")), vec![1]);
        assert_eq!(candidates(&findings, &contract("ultra")), vec![1, 0]);
        let text = payload(&findings, &[1], &sources);
        assert!(text.contains("F-001"));
        assert!(text.contains(">3 | ") || text.contains("> 3 | ") || text.contains(">3 |"), "{text}");
    }
}
