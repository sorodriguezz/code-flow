//! What the workers returned, turned into the review's findings: parsed, deduped, filtered by the
//! level's contract, ordered and numbered.
//!
//! Five steps, all of them verifiable arithmetic, and none of them verified before: two runs of the
//! same pull request at the same level could filter differently and nothing noticed. **The judgment
//! stays with the model** — how confident it is, what type the defect is, how to fix it. This module
//! never invents or rewrites a finding's content; it only decides which ones get in, and under which
//! id.
//!
//! The parser is the other half of the format contract with `src/lib/parseAnalysis.ts`. It is
//! deliberately more lenient than that one: a worker that omits the trailing `· F-001` still has its
//! finding read, because the id is assigned here anyway, and a worker that drops the confidence line
//! keeps its finding rather than having it silently deleted by a threshold it never opted into.

use std::sync::OnceLock;

use regex::Regex;

use super::calibration::CalibratedCategory;
use super::contract::{FindingType, LevelContract, Severity};
use super::outline::normalize_path;
use crate::review_memory::MemoryFinding;

/// One finding, with everything the report renders — the full record, unlike
/// [`MemoryFinding`], which is the slim projection the durable memory keeps for reconciliation.
#[derive(Debug, Clone)]
pub struct Finding {
    /// Assigned by [`number`], or carried over from a previous run for a finding that persists.
    /// Empty until then.
    pub id: String,
    pub severity: Severity,
    pub tipo: FindingType,
    pub categoria: String,
    pub subtitulo: String,
    pub archivo: Option<String>,
    pub lineas: Option<String>,
    pub por_que: String,
    pub sugerencia: String,
    pub ejemplo_lang: String,
    pub ejemplo_code: String,
    /// The one line of code the finding is about, copied verbatim by the reviewer (`🔎 Evidencia`).
    ///
    /// Never rendered: it exists to be *checked*. A finding whose evidence is nowhere in the file it
    /// names is one the model described from memory rather than from the code — and when the line
    /// is there but not where the finding says, the location is corrected to where it actually is,
    /// which is what anchors the comment to the right line on the pull request.
    pub evidencia: String,
    /// The exact replacement for a span of lines, when the fix is that local (`✏️ Reemplazo`) —
    /// what becomes a one-click suggestion on hosts that have them.
    pub reemplazo: Option<Replacement>,
    /// `None` when the worker didn't state one. Treated as "not flagged as uncertain" rather than
    /// as zero — see [`passes`].
    pub confianza: Option<u8>,
    /// Lifecycle state, once reconciliation has run. `abierto` until then.
    pub estado: String,
    pub thread_id: Option<i64>,
    pub introducido_en_iter: usize,
    pub resuelto_en_iter: Option<usize>,
    pub motivo_descarte: Option<String>,
    pub delta: Option<String>,
    /// A re-review's new finding on code that did not change since the iteration before — see
    /// `MemoryFinding::tardio`. Decided by reconciliation, never by the reviewer.
    pub tardio: bool,
}

/// The exact new text for lines `start..=end` of the finding's file.
#[derive(Debug, Clone, PartialEq)]
pub struct Replacement {
    pub start: u32,
    pub end: u32,
    pub lang: String,
    pub code: String,
}

impl Finding {
    /// The slim projection stored in the durable review memory.
    pub fn to_memory(&self) -> MemoryFinding {
        MemoryFinding {
            id: self.id.clone(),
            severity: match self.severity {
                Severity::Blocker | Severity::Critico => "critical".into(),
                Severity::Mayor => "warning".into(),
                Severity::Menor | Severity::Info => "info".into(),
            },
            severidad: self.severity.label().to_string(),
            tipo: self.tipo.label().to_string(),
            categoria: self.categoria.clone(),
            subtitulo: self.subtitulo.clone(),
            archivo: self.archivo.clone(),
            lineas: self.lineas.clone(),
            confianza: self.confianza.map(|c| c as i64),
            estado: self.estado.clone(),
            thread_id: self.thread_id,
            introducido_en_iter: self.introducido_en_iter,
            resuelto_en_iter: self.resuelto_en_iter,
            motivo_descarte: self.motivo_descarte.clone(),
            delta: self.delta.clone(),
            // Left empty here and filled after reconciliation, because the comment's heading carries
            // the finding's id and the id is not final yet: `reconcile` hands a persisting finding
            // its previous run's id and mints a fresh one for anything new. Rendering it now would
            // stamp the pre-reconciliation number into a comment that gets posted under another.
            comentario_md: String::new(),
            // Publishing state belongs to the memory, never to a review: reconciliation carries it
            // over from the earlier finding this one continues.
            publicado_en_iter: None,
            hilo_general: false,
            // Lifecycle fields reconciliation fills in.
            resolucion: None,
            resolucion_archivo: None,
            resolucion_lineas: None,
            tardio: self.tardio,
            // The PR's word on it is the memory's, carried by reconciliation like its thread.
            hilo_pr: Default::default(),
        }
    }

    /// Whether this finding counts toward the buckets, the ratings and the Quality Gate.
    pub fn is_active(&self) -> bool {
        matches!(self.estado.as_str(), "abierto" | "posteado")
    }

    /// A finding the memory carried forward without this run re-reading it — its file did not
    /// change, or its reviewer failed — rebuilt in full so the report shows it and the gate counts it.
    ///
    /// The whole block comes from the newest earlier report that rendered it (`earlier`, newest
    /// first): same id **and** same kind, since an id alone could have been renumbered onto another
    /// finding. One no report holds any more is rebuilt from what the memory kept — no prose, but the
    /// severity, the place and the subtitle, which is what the gate and the card need. Either way the
    /// memory has the last word on the lifecycle: state, thread and the iterations it lived through.
    pub fn recovered(memory: &MemoryFinding, earlier: &[Vec<Finding>]) -> Finding {
        let kind = crate::review_memory::finding_identity(memory.archivo.as_deref(), &memory.categoria);
        let rendered = earlier.iter().flatten().find(|f| {
            f.id == memory.id && crate::review_memory::finding_identity(f.archivo.as_deref(), &f.categoria) == kind
        });
        let mut finding = match rendered {
            Some(f) => f.clone(),
            None => Finding {
                id: String::new(),
                severity: Severity::parse(&memory.severidad).unwrap_or(match memory.severity.as_str() {
                    // Runs before the fine severity was kept: the bucket's least severe member, so a
                    // gate that blocks on Crítico still fails on a carried `critical`.
                    "critical" => Severity::Critico,
                    "warning" => Severity::Mayor,
                    _ => Severity::Menor,
                }),
                tipo: FindingType::parse(&memory.tipo).unwrap_or(FindingType::Bug),
                categoria: memory.categoria.clone(),
                subtitulo: memory.subtitulo.clone(),
                archivo: None,
                lineas: None,
                por_que: String::new(),
                sugerencia: String::new(),
                ejemplo_lang: String::new(),
                ejemplo_code: String::new(),
                evidencia: String::new(),
                reemplazo: None,
                confianza: memory.confianza.map(|c| c.clamp(0, 100) as u8),
                estado: String::new(),
                thread_id: None,
                introducido_en_iter: 0,
                resuelto_en_iter: None,
                motivo_descarte: None,
                delta: None,
                tardio: false,
            },
        };
        finding.id = memory.id.clone();
        finding.archivo = memory.archivo.clone();
        finding.lineas = memory.lineas.clone().or(finding.lineas);
        finding.estado = memory.estado.clone();
        finding.thread_id = memory.thread_id;
        finding.introducido_en_iter = memory.introducido_en_iter;
        finding.resuelto_en_iter = memory.resuelto_en_iter;
        finding.motivo_descarte = memory.motivo_descarte.clone();
        finding.delta = memory.delta.clone();
        finding.tardio = memory.tardio;
        finding
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// The finding heading. Mirrors `parseAnalysis.ts`'s `HEADER_RE` with two deliberate relaxations:
/// the variation selector after `⚠`/`ℹ` is optional (engines emit both forms), and the trailing
/// `· F-NNN` is optional because [`number`] assigns the id regardless.
fn header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^###\s*(🚨|⚠\x{FE0F}?|ℹ\x{FE0F}?)\s*\[([^·\]]+)·([^\]]+)\]\s*(.+?)\s*$")
            .expect("valid finding header regex")
    })
}

fn id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"·\s*(F-\d+)\s*$").expect("valid id regex"))
}

fn code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)```(\w*)\n(.*?)```").expect("valid code fence regex"))
}

/// The field markers, by their base codepoint — the variation selector that may follow is left to
/// the value and trimmed with the label.
const MARKERS: [(char, &str); 8] = [
    ('📍', "location"),
    ('⏳', "late"),
    ('💭', "why"),
    ('💡', "suggestion"),
    ('🛠', "example"),
    ('✏', "replacement"),
    ('🔎', "evidence"),
    ('🎯', "confidence"),
];

/// Splits a finding's body into its labelled fields.
///
/// Scanning for the markers rather than matching one regex per field is what makes this survive a
/// worker that reorders them, omits one, or writes a multi-paragraph "why": each value simply runs
/// to the next marker.
fn fields(block: &str) -> Vec<(&'static str, String)> {
    let mut hits: Vec<(usize, char, &'static str)> = Vec::new();
    for (marker, name) in MARKERS {
        for (idx, _) in block.match_indices(marker) {
            hits.push((idx, marker, name));
        }
    }
    hits.sort_by_key(|(idx, _, _)| *idx);

    let mut out = Vec::new();
    for (i, (idx, marker, name)) in hits.iter().enumerate() {
        let start = idx + marker.len_utf8();
        let end = hits.get(i + 1).map(|(next, _, _)| *next).unwrap_or(block.len());
        if start > end {
            continue;
        }
        let raw = &block[start..end];
        // Drop the variation selector, the human label ("Ubicación:", "Por qué:") and the
        // separators around it — everything up to and including the first colon on the first line.
        let raw = raw.trim_start_matches('\u{FE0F}').trim_start();
        let value = match raw.split_once(':') {
            // Only when the colon is on the marker's own line, so a "why" whose prose contains a
            // colon is not decapitated.
            Some((label, rest)) if !label.contains('\n') && label.chars().count() <= 30 => rest,
            _ => raw,
        };
        out.push((*name, value.trim().to_string()));
    }
    out
}

fn field_of<'a>(fields: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
    fields.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str())
}

/// Splits a `📍 Ubicación` value into `(file, lines)`, stripping any Markdown the model wrapped it
/// in. Same tolerance as the frontend's `parseLocation`, which exists because the prompt asks for
/// plain text here and the model formats paths everywhere else.
fn parse_location(raw: &str) -> (Option<String>, Option<String>) {
    let cleaned: String = raw.trim().chars().filter(|c| !matches!(c, '`' | '*' | '_')).collect();
    let cleaned = cleaned.trim();
    // Take the first line only: a worker occasionally adds prose under the location.
    let cleaned = cleaned.lines().next().unwrap_or("").trim();
    if cleaned.is_empty() {
        return (None, None);
    }
    match cleaned.rsplit_once(':') {
        Some((file, lines)) if !file.trim().is_empty() && lines.chars().any(|c| c.is_ascii_digit()) => {
            (Some(normalize_path(file.trim())), Some(lines.trim().to_string()))
        }
        _ => (Some(normalize_path(cleaned)), None),
    }
}

/// The quoted line out of a `🔎 Evidencia` value: the first non-empty line, with the backticks or
/// fence the model wrapped it in taken off. Kept verbatim otherwise — it is compared against the code.
fn evidence_of(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("```"))
        .map(|l| l.trim_matches('`').trim().to_string())
        .find(|l| !l.is_empty())
        .unwrap_or_default()
}

/// A `✏️ Reemplazo: 42-44` value and the fence under it. The span falls back to the finding's own
/// lines; without a fence there is nothing to replace with, so no replacement.
fn replacement_of(raw: &str, lineas: Option<&str>) -> Option<Replacement> {
    let caps = code_re().captures(raw)?;
    let code = caps.get(2)?.as_str().trim_end_matches('\n').to_string();
    let head = raw.split("```").next().unwrap_or("");
    let (start, end) = crate::review_memory::line_span(Some(head))
        .or_else(|| crate::review_memory::line_span(lineas))?;
    Some(Replacement { start, end, lang: caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(), code })
}

/// Everything before the first finding heading — the model's own prose, kept so a review that found
/// nothing still says something.
pub fn preamble(markdown: &str) -> String {
    match header_re().find(markdown) {
        Some(m) => markdown[..m.start()].trim().to_string(),
        None => markdown.trim().to_string(),
    }
}

/// Parses every finding out of one worker's Markdown reply.
pub fn parse(markdown: &str) -> Vec<Finding> {
    let starts: Vec<usize> = header_re().find_iter(markdown).map(|m| m.start()).collect();
    let mut out = Vec::new();

    for (i, caps) in header_re().captures_iter(markdown).enumerate() {
        let block_start = starts[i];
        let block_end = starts.get(i + 1).copied().unwrap_or(markdown.len());
        let block = &markdown[block_start..block_end];

        let severity = Severity::parse(caps.get(2).map(|m| m.as_str()).unwrap_or(""))
            // A heading whose severity word is unreadable still carries the emoji, which the
            // standard maps one-to-one — and an unparseable finding must never simply vanish.
            .or_else(|| match caps.get(1).map(|m| m.as_str()).unwrap_or("") {
                "🚨" => Some(Severity::Critico),
                "⚠️" | "⚠" => Some(Severity::Mayor),
                _ => Some(Severity::Menor),
            })
            .unwrap_or(Severity::Menor);
        let tipo = FindingType::parse(caps.get(3).map(|m| m.as_str()).unwrap_or(""))
            .unwrap_or(FindingType::CodeSmell);

        let tail = caps.get(4).map(|m| m.as_str().trim()).unwrap_or("");
        let id = id_re().captures(tail).and_then(|c| c.get(1)).map(|m| m.as_str().to_string());
        let categoria = match id_re().find(tail) {
            Some(m) => tail[..m.start()].trim().trim_end_matches('·').trim(),
            None => tail,
        }
        .to_string();

        // The subtitle is the first real line of the body, before any marker.
        let body = block.lines().skip(1).collect::<Vec<_>>().join("\n");
        let subtitulo = body
            .lines()
            .map(str::trim)
            .find(|l| {
                !l.is_empty()
                    && !l.starts_with("---")
                    && !MARKERS.iter().any(|(m, _)| l.starts_with(*m))
            })
            .unwrap_or("")
            .to_string();

        let parsed = fields(&body);
        let (archivo, lineas) =
            field_of(&parsed, "location").map(parse_location).unwrap_or((None, None));
        let confianza = field_of(&parsed, "confidence")
            .and_then(|v| {
                v.chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u16>()
                    .ok()
            })
            .map(|n| n.min(100) as u8);

        let example = field_of(&parsed, "example").unwrap_or("");
        let (ejemplo_lang, ejemplo_code) = code_re()
            .captures(example)
            .map(|c| {
                (
                    c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
                    c.get(2).map(|m| m.as_str().trim_end().to_string()).unwrap_or_default(),
                )
            })
            .unwrap_or_default();

        // A "why" or "suggestion" runs to the next marker, so it can still trail the `---` that
        // separates findings.
        let clean = |s: &str| s.trim().trim_end_matches('-').trim().to_string();
        let evidencia = field_of(&parsed, "evidence").map(evidence_of).unwrap_or_default();
        let reemplazo = field_of(&parsed, "replacement").and_then(|raw| replacement_of(raw, lineas.as_deref()));

        out.push(Finding {
            id: id.unwrap_or_default(),
            severity,
            tipo,
            categoria,
            subtitulo,
            archivo,
            lineas,
            por_que: field_of(&parsed, "why").map(clean).unwrap_or_default(),
            sugerencia: field_of(&parsed, "suggestion").map(clean).unwrap_or_default(),
            ejemplo_lang,
            ejemplo_code,
            evidencia,
            reemplazo,
            confianza,
            estado: "abierto".to_string(),
            thread_id: None,
            introducido_en_iter: 0,
            resuelto_en_iter: None,
            motivo_descarte: None,
            delta: None,
            // Read back from a rendered report (see `render::late_note`); a worker never writes it.
            tardio: field_of(&parsed, "late").is_some(),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Verdicts on previous findings
// ---------------------------------------------------------------------------

/// `PREVIO F-003: PERSISTE @ src/a.ts:42-50` · `PREVIO F-004: RESUELTO @ 60-64 — <resolución>` —
/// the line format `review_memory::reevaluate_block` asks for (`D-NNN` for debt carried in from
/// another pull request by the debt scan). Tolerant of what models do to a line
/// they were told to write verbatim: a bullet or bold around it, either dash, a missing `@`.
fn prior_verdict_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?mi)^[ \t>*_-]*PREVIO\s+\**([FD]-\d+)\**\s*:\s*\**(PERSISTE|RESUELTO)\**[ \t]*(?:@[ \t]*([^—–\n]*?))?[ \t]*(?:(?:—|–|[ \t]-[ \t])[ \t]*(.*?))?[ \t*_]*$",
        )
        .expect("valid prior verdict regex")
    })
}

/// Every verdict a reviewer returned on the previous findings it was handed, by id (upper-cased).
/// A later line for the same id wins — a model that corrects itself says so last.
pub fn parse_prior_verdicts(text: &str) -> std::collections::HashMap<String, crate::review_memory::PriorVerdict> {
    let mut out = std::collections::HashMap::new();
    for caps in prior_verdict_re().captures_iter(text) {
        let Some(id) = caps.get(1).map(|m| m.as_str().to_uppercase()) else { continue };
        let resolved = caps.get(2).is_some_and(|m| m.as_str().eq_ignore_ascii_case("resuelto"));
        let (archivo, lineas) = match caps.get(3).map(|m| m.as_str().trim()).filter(|l| !l.is_empty()) {
            // A bare range keeps the finding's own file; `file:range` names another.
            Some(loc) if loc.trim_matches('`').chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ',' | ' ')) => {
                (None, Some(loc.trim_matches('`').trim().to_string()))
            }
            Some(loc) => parse_location(loc),
            None => (None, None),
        };
        let resolucion = caps
            .get(4)
            .map(|m| m.as_str().trim().trim_matches('*').trim().to_string())
            .filter(|r| !r.is_empty());
        out.insert(id, crate::review_memory::PriorVerdict { resolved, archivo, lineas, resolucion });
    }
    out
}

/// The reply without its verdict lines, so neither the findings parser (which would read them as
/// part of the finding above) nor the narrative ever sees them.
pub fn strip_prior_verdicts(text: &str) -> String {
    prior_verdict_re().replace_all(text, "").to_string()
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/// Parses a `lines` value into spans. `"42-50, 80"` → `[(42,50),(80,80)]`. Anything unparseable is
/// ignored for dedupe purposes rather than making the whole finding un-mergeable.
fn spans(value: Option<&str>) -> Vec<(u32, u32)> {
    let Some(value) = value else { return Vec::new() };
    let mut out = Vec::new();
    for chunk in value.split(',') {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        match chunk.split_once('-') {
            Some((a, b)) => {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
                    out.push((a.min(b), a.max(b)));
                }
            }
            None => {
                if let Ok(n) = chunk.parse::<u32>() {
                    out.push((n, n));
                }
            }
        }
    }
    out
}

fn overlaps(a: &[(u32, u32)], b: &[(u32, u32)]) -> bool {
    a.iter().any(|x| b.iter().any(|y| x.0 <= y.1 && y.0 <= x.1))
}

/// Merges findings pointing at the same defect: same file, and overlapping line ranges.
///
/// With no parseable range on either side there is no basis for claiming they are the same defect,
/// so those only merge when the category matches too. The survivor is the more confident one (on a
/// tie, the more severe), and it inherits any field the other one filled and it left empty — two
/// workers looking at the same code from adjacent groups routinely write complementary halves.
pub fn dedupe(findings: Vec<Finding>) -> (Vec<Finding>, usize) {
    let mut kept: Vec<(Finding, Vec<(u32, u32)>)> = Vec::new();
    let mut merged = 0usize;

    for finding in findings {
        let mine = spans(finding.lineas.as_deref());
        let key = finding.archivo.as_deref().map(normalize_path).unwrap_or_default().to_lowercase();

        let hit = kept.iter_mut().find(|(existing, existing_spans)| {
            let their_key =
                existing.archivo.as_deref().map(normalize_path).unwrap_or_default().to_lowercase();
            if their_key != key {
                return false;
            }
            if !mine.is_empty() && !existing_spans.is_empty() {
                overlaps(&mine, existing_spans)
            } else {
                !finding.categoria.is_empty()
                    && finding.categoria.eq_ignore_ascii_case(&existing.categoria)
            }
        });

        let Some((existing, existing_spans)) = hit else {
            kept.push((finding, mine));
            continue;
        };

        merged += 1;
        let new_wins = (finding.confianza.unwrap_or(0), std::cmp::Reverse(finding.severity))
            > (existing.confianza.unwrap_or(0), std::cmp::Reverse(existing.severity));
        let (mut winner, loser) = if new_wins {
            (finding, existing.clone())
        } else {
            (existing.clone(), finding)
        };

        // Whatever the winner left empty and the loser filled.
        if winner.subtitulo.is_empty() {
            winner.subtitulo = loser.subtitulo;
        }
        if winner.por_que.is_empty() {
            winner.por_que = loser.por_que;
        }
        if winner.sugerencia.is_empty() {
            winner.sugerencia = loser.sugerencia;
        }
        if winner.ejemplo_code.is_empty() {
            winner.ejemplo_lang = loser.ejemplo_lang;
            winner.ejemplo_code = loser.ejemplo_code;
        }
        if winner.lineas.is_none() {
            winner.lineas = loser.lineas;
        }
        if winner.archivo.is_none() {
            winner.archivo = loser.archivo;
        }
        if winner.confianza.is_none() {
            winner.confianza = loser.confianza;
        }
        if winner.evidencia.is_empty() {
            winner.evidencia = loser.evidencia;
        }
        if winner.reemplazo.is_none() {
            winner.reemplazo = loser.reemplazo;
        }

        existing_spans.extend(mine);
        existing_spans.sort_unstable();
        existing_spans.dedup();
        *existing = winner;
    }

    (kept.into_iter().map(|(f, _)| f).collect(), merged)
}

// ---------------------------------------------------------------------------
// Contract filtering
// ---------------------------------------------------------------------------

/// Why a finding was dropped — printed to the run log, because nothing is ever discarded silently.
#[derive(Debug, Clone)]
pub struct Discarded {
    pub finding: Finding,
    pub reason: String,
}

/// Whether a finding survives the level's contract.
///
/// A finding with **no** stated confidence survives. The threshold exists to cut what the model
/// itself flagged as uncertain, and a worker that never wrote the line has flagged nothing — losing
/// a real defect to a missing field would be the one failure mode this pipeline must not add.
fn passes(finding: &Finding, contract: &LevelContract) -> Result<(), String> {
    // A deterministic rule's finding carries the severity its rule declares (often `Info`) and is
    // reported at every level the rule runs at: the rule already decided it is worth saying, and the
    // gate only blocks on what the workspace policy names.
    if !contract.reports(finding.severity) && rule_id(finding).is_none() {
        return Err(format!(
            "severidad {} no se reporta en nivel {} (permitidas: {})",
            finding.severity.label(),
            contract.level,
            contract.severity_labels().join("/")
        ));
    }
    let Some(confidence) = finding.confianza else { return Ok(()) };
    let minimum = contract.threshold_for(finding.severity);
    if confidence < minimum {
        return Err(format!(
            "confianza {confidence} < {minimum} (umbral de {} en nivel {})",
            finding.severity.label(),
            contract.level
        ));
    }
    Ok(())
}

/// The deterministic rule a finding comes from — the `[R-NNNN]` its why starts with, as the rules
/// block asks the reviewer to write it (see `rules::block`). Tolerant of the subtitle carrying it
/// instead, and of markdown emphasis around it.
pub fn rule_id(finding: &Finding) -> Option<String> {
    fn re() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new(r"^[\s*_`]*\[(R-\d{4})\]").expect("static regex"))
    }
    [&finding.por_que, &finding.subtitulo]
        .iter()
        .find_map(|text| re().captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()))
}

/// The repository's calibration (see [`super::calibration`]) as the merge applies it: the
/// categories the team keeps dismissing, and the confidence a finding of one of them needs.
#[derive(Debug, Clone, Copy)]
pub struct Calibration<'a> {
    pub categories: &'a [CalibratedCategory],
    pub min_confidence: u8,
}

impl Calibration<'_> {
    // Every caller in the app now passes the repository's calibration; [`filter`] is the tests' shape.
    #[cfg_attr(not(test), allow(dead_code))]
    pub const NONE: Calibration<'static> = Calibration { categories: &[], min_confidence: 0 };
}

/// The raised bar, checked after the level's own — never instead of it, and never lower than it.
///
/// A bar, not a filter: a finding of a calibrated category that is *sure* still gets through. And,
/// like the level threshold, one with no stated confidence is not held back — it never said it was
/// unsure, and a missing field must not be what loses a real defect.
fn clears_calibration(finding: &Finding, contract: &LevelContract, calibration: &Calibration) -> Result<(), String> {
    let Some(category) = super::calibration::bar_for(calibration.categories, &finding.categoria) else { return Ok(()) };
    let Some(confidence) = finding.confianza else { return Ok(()) };
    let minimum = calibration.min_confidence.max(contract.threshold_for(finding.severity));
    if confidence < minimum {
        return Err(format!(
            "{CALIBRATION_PREFIX} este repo descarta a menudo `{}` ({} de {}) — confianza {confidence} < {minimum}",
            category.categoria, category.dismissed, category.total
        ));
    }
    Ok(())
}

/// How a discard by calibration starts, so the pipeline can count them without a second channel.
pub const CALIBRATION_PREFIX: &str = "calibración:";

/// Applies the contract, returning `(survivors, discards)`.
///
/// A finding that is already closed (`resuelto` / `falso_positivo` / `ignorado`) is **not**
/// re-filtered: it comes from a previous run, possibly at another level, and traceability requires
/// keeping it in this review and every later one.
#[cfg_attr(not(test), allow(dead_code))]
pub fn filter(findings: Vec<Finding>, contract: &LevelContract) -> (Vec<Finding>, Vec<Discarded>) {
    filter_calibrated(findings, contract, &Calibration::NONE)
}

/// [`filter`], with the repository's calibration applied on top of the level's thresholds.
pub fn filter_calibrated(
    findings: Vec<Finding>,
    contract: &LevelContract,
    calibration: &Calibration,
) -> (Vec<Finding>, Vec<Discarded>) {
    let mut survivors = Vec::new();
    let mut discarded = Vec::new();
    for finding in findings {
        if finding.estado != "abierto" && finding.estado != "posteado" {
            survivors.push(finding);
            continue;
        }
        match passes(&finding, contract).and_then(|()| clears_calibration(&finding, contract, calibration)) {
            Ok(()) => survivors.push(finding),
            Err(reason) => discarded.push(Discarded { finding, reason }),
        }
    }
    (survivors, discarded)
}

/// The report's order: severity, then confidence descending, then file — so `F-001` is always the
/// most severe finding, at every level.
pub fn sort(findings: &mut [Finding]) {
    findings.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then(b.confianza.unwrap_or(0).cmp(&a.confianza.unwrap_or(0)))
            .then_with(|| a.archivo.cmp(&b.archivo))
    });
}

/// Numbers the findings that don't have an id yet, starting at `start` and skipping anything
/// already taken.
///
/// The skip matters: a re-review carries stable ids forward, and assigning `start + position` would
/// collide the moment a carried id fell inside the range — two findings with one id, which breaks
/// posting and reconciliation at once.
pub fn number(findings: &mut [Finding], start: usize) {
    let mut used: Vec<String> = findings.iter().filter(|f| !f.id.is_empty()).map(|f| f.id.clone()).collect();
    let mut free = start.max(1);
    for finding in findings.iter_mut() {
        if !finding.id.is_empty() {
            continue;
        }
        while used.contains(&format!("F-{free:03}")) {
            free += 1;
        }
        finding.id = format!("F-{free:03}");
        used.push(finding.id.clone());
        free += 1;
    }
}

/// The whole mechanical step, in the order the runbook specifies: merge every worker's reply,
/// dedupe, apply the contract, order, and number from `start`.
///
/// The pipeline runs these same steps itself, because it grounds each finding in its code
/// (`review::verify`) between the dedupe and the contract — this composition is the reference the
/// tests hold the steps to.
///
/// **Whatever id a worker wrote is discarded.** With one reviewer that number was merely redundant;
/// with several it is actively wrong, because each worker numbers its own findings from `F-001` and
/// three of them return three different defects all claiming that id. Numbering is this module's
/// job, and the ids that ultimately reach the report are the *reconciled* ones — assigned by
/// identity against the previous run so a finding keeps one id, and one comment thread, for the life
/// of the pull request.
#[cfg(test)]
pub fn consolidate(
    replies: &[String],
    contract: &LevelContract,
    start: usize,
) -> (Vec<Finding>, Vec<Discarded>, usize) {
    let mut all: Vec<Finding> = replies.iter().flat_map(|r| parse(r)).collect();
    for finding in all.iter_mut() {
        finding.id.clear();
    }
    let (deduped, merged) = dedupe(all);
    let (mut survivors, discarded) = filter(deduped, contract);
    sort(&mut survivors);
    number(&mut survivors, start);
    (survivors, discarded, merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::contract::{resolve_level_contract, ReviewEngineConfig};

    fn contract(level: &str) -> LevelContract {
        resolve_level_contract(level, &ReviewEngineConfig::default())
    }

    const ONE: &str = "\
📈 CALIDAD: Fiabilidad=C Seguridad=A Mantenibilidad=B

### 🚨 [Crítico · Bug] null-dereference · F-001

Se accede a `cuenta.saldo` sin verificar que la cuenta exista.

📍 Ubicación: src/services/pago.ts:42-50

💭 Por qué: `buscarCuenta` retorna null cuando el id no existe; el path no lo maneja.

💡 Sugerencia: Guarda temprano: si `!cuenta`, retorna 404 antes de leer `saldo`.

🛠️ Ejemplo de solución:
```ts
if (!cuenta) return res.status(404).end();
```

🎯 Confianza: 85/100

---
";

    #[test]
    fn a_finding_parses_every_field() {
        let f = parse(ONE);
        assert_eq!(f.len(), 1);
        let f = &f[0];
        assert_eq!(f.severity, Severity::Critico);
        assert_eq!(f.tipo, FindingType::Bug);
        assert_eq!(f.categoria, "null-dereference");
        assert_eq!(f.id, "F-001");
        assert_eq!(f.archivo.as_deref(), Some("src/services/pago.ts"));
        assert_eq!(f.lineas.as_deref(), Some("42-50"));
        assert_eq!(f.confianza, Some(85));
        assert!(f.subtitulo.starts_with("Se accede"));
        assert!(f.por_que.contains("buscarCuenta"));
        assert!(f.sugerencia.contains("404"));
        assert_eq!(f.ejemplo_lang, "ts");
        assert!(f.ejemplo_code.contains("status(404)"));
        // The `---` separator must not bleed into the last field.
        assert!(!f.sugerencia.contains("---"));
    }

    #[test]
    fn the_prose_before_the_first_finding_is_kept() {
        assert!(preamble(ONE).contains("📈 CALIDAD"));
        assert!(!preamble(ONE).contains("null-dereference"));
        assert_eq!(preamble("Todo bien ✅").trim(), "Todo bien ✅");
    }

    /// The id is assigned here, so a worker that forgets it must not lose its finding.
    #[test]
    fn a_heading_without_an_id_still_parses() {
        let md = "### ⚠️ [Mayor · Code Smell] dead-code\n\nSobra.\n\n🎯 Confianza: 60";
        let f = parse(md);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].categoria, "dead-code");
        assert!(f[0].id.is_empty());
    }

    /// Engines emit the emoji with and without its variation selector.
    #[test]
    fn both_spellings_of_the_emoji_parse() {
        assert_eq!(parse("### ⚠️ [Mayor · Bug] a · F-001\n\nx").len(), 1);
        assert_eq!(parse("### ⚠ [Mayor · Bug] a · F-002\n\nx").len(), 1);
        assert_eq!(parse("### ℹ [Menor · Code Smell] b · F-003\n\nx").len(), 1);
    }

    #[test]
    fn a_location_wrapped_in_markdown_still_resolves() {
        assert_eq!(
            parse_location("`src/a.ts:12-14`"),
            (Some("src/a.ts".into()), Some("12-14".into()))
        );
        assert_eq!(parse_location("/src/a.ts:9"), (Some("src/a.ts".into()), Some("9".into())));
        assert_eq!(parse_location("src/a.ts"), (Some("src/a.ts".into()), None));
    }

    #[test]
    fn a_why_containing_a_colon_is_not_decapitated() {
        let md = "### 🚨 [Crítico · Bug] x · F-001\n\nsub\n\n💭 Por qué: el mapa es: clave -> valor\n\n💡 Sugerencia: arregla";
        let f = parse(md);
        assert_eq!(f[0].por_que, "el mapa es: clave -> valor");
    }

    #[test]
    fn the_same_defect_reported_by_two_workers_becomes_one() {
        let a = "### 🚨 [Crítico · Bug] npe · F-001\n\nsub a\n\n📍 Ubicación: src/a.ts:40-50\n\n🎯 Confianza: 60";
        let b = "### 🚨 [Crítico · Bug] npe · F-001\n\nsub b\n\n📍 Ubicación: src/a.ts:45-55\n\n💡 Sugerencia: la buena\n\n🎯 Confianza: 90";
        let (merged, count) = dedupe([parse(a), parse(b)].concat());
        assert_eq!(count, 1);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].confianza, Some(90), "the more confident report wins");
        assert_eq!(merged[0].sugerencia, "la buena", "and inherits what the other one filled");
    }

    #[test]
    fn different_files_or_disjoint_ranges_are_different_findings() {
        let a = "### 🚨 [Crítico · Bug] npe · F-001\n\ns\n\n📍 Ubicación: src/a.ts:10-12";
        let b = "### 🚨 [Crítico · Bug] npe · F-001\n\ns\n\n📍 Ubicación: src/b.ts:10-12";
        let c = "### 🚨 [Crítico · Bug] npe · F-001\n\ns\n\n📍 Ubicación: src/a.ts:900-905";
        let (merged, _) = dedupe([parse(a), parse(b), parse(c)].concat());
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn the_contract_filters_by_severity_and_by_confidence() {
        let basico = contract("basico");
        let low = "### 🚨 [Crítico · Bug] x · F-001\n\ns\n\n📍 Ubicación: a.ts:1\n\n🎯 Confianza: 60";
        let minor = "### ℹ️ [Menor · Code Smell] y · F-002\n\ns\n\n📍 Ubicación: b.ts:1\n\n🎯 Confianza: 100";
        let (kept, dropped) = filter([parse(low), parse(minor)].concat(), &basico);
        assert!(kept.is_empty());
        assert_eq!(dropped.len(), 2);
        assert!(dropped[0].reason.contains("confianza 60 < 75"));
        assert!(dropped[1].reason.contains("no se reporta en nivel basico"));
    }

    /// A deterministic rule's `Info` finding is reported at completo (which reports no `Info`) and at
    /// ultra; the confidence threshold still applies to it, and a plain `Info` is still dropped.
    #[test]
    fn a_rule_finding_is_exempt_from_the_reported_severities() {
        let rule = "### ℹ️ [Info · Code Smell] outdated-dependency · F-001\n\ns\n\n📍 Ubicación: package.json:3\n\n💭 Por qué: [R-0004] axios puede subir a 1.7.9.\n\n🎯 Confianza: 80";
        let unsure = "### ℹ️ [Info · Code Smell] outdated-dependency · F-002\n\ns\n\n📍 Ubicación: package.json:4\n\n💭 Por qué: [R-0004] no se pudo leer el registry.\n\n🎯 Confianza: 40";
        let plain = "### ℹ️ [Info · Code Smell] naming · F-003\n\ns\n\n📍 Ubicación: a.ts:1\n\n💭 Por qué: el nombre confunde.\n\n🎯 Confianza: 90";
        assert_eq!(rule_id(&parse(rule)[0]).as_deref(), Some("R-0004"));
        assert_eq!(rule_id(&parse(plain)[0]), None);
        for level in ["completo", "ultra"] {
            let (kept, dropped) = filter([parse(rule), parse(unsure), parse(plain)].concat(), &contract(level));
            let kept: Vec<&str> = kept.iter().map(|f| f.lineas.as_deref().unwrap()).collect();
            if level == "completo" {
                assert_eq!(kept, vec!["3"], "{level}");
                assert_eq!(dropped.len(), 2);
                assert!(dropped[1].reason.contains("no se reporta en nivel completo"));
            } else {
                assert_eq!(kept, vec!["3", "1"], "{level}");
            }
            assert!(dropped[0].reason.contains("confianza 40"), "{level}: the threshold still applies");
        }
        // An Info finding does not fail a gate that blocks on Menor and up.
        let found = filter(parse(rule), &contract("completo")).0;
        assert!(crate::review::render::passes_gate(&found, &[Severity::Blocker, Severity::Critico, Severity::Mayor, Severity::Menor]));
    }

    /// Severity and threshold are independent gates — a perfect-confidence Minor still does not
    /// survive `basico`.
    #[test]
    fn blocker_gets_its_own_lower_threshold() {
        let full = contract("completo");
        let blocker = "### 🚨 [Blocker · Vulnerabilidad] rce · F-001\n\ns\n\n📍 Ubicación: a.ts:1\n\n🎯 Confianza: 55";
        let critico = "### 🚨 [Crítico · Bug] npe · F-002\n\ns\n\n📍 Ubicación: b.ts:1\n\n🎯 Confianza: 55";
        let (kept, dropped) = filter([parse(blocker), parse(critico)].concat(), &full);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].severity, Severity::Blocker);
        assert_eq!(dropped.len(), 1);
    }

    /// Calibration raises the bar for its category only, and a sure finding still clears it — a bar,
    /// never a filter.
    #[test]
    fn calibration_raises_the_bar_without_suppressing_the_category() {
        let cats = vec![CalibratedCategory {
            categoria: "missing-validation".into(),
            slug: "missing-validation".into(),
            dismissed: 3,
            total: 4,
            motivo: None,
        }];
        let cal = Calibration { categories: &cats, min_confidence: 85 };
        let unsure = "### ⚠️ [Mayor · Bug] Missing Validation · F-001\n\ns\n\n📍 Ubicación: a.ts:1\n\n🎯 Confianza: 70";
        let sure = "### ⚠️ [Mayor · Bug] missing-validation · F-002\n\ns\n\n📍 Ubicación: b.ts:1\n\n🎯 Confianza: 90";
        let other = "### ⚠️ [Mayor · Bug] npe · F-003\n\ns\n\n📍 Ubicación: c.ts:1\n\n🎯 Confianza: 70";
        let silent = "### ⚠️ [Mayor · Bug] missing-validation · F-004\n\ns\n\n📍 Ubicación: d.ts:1";
        let (kept, dropped) =
            filter_calibrated([parse(unsure), parse(sure), parse(other), parse(silent)].concat(), &contract("completo"), &cal);
        assert_eq!(kept.iter().map(|f| f.archivo.as_deref().unwrap()).collect::<Vec<_>>(), vec!["b.ts", "c.ts", "d.ts"]);
        assert_eq!(dropped.len(), 1);
        assert!(dropped[0].reason.starts_with(CALIBRATION_PREFIX));
        assert!(dropped[0].reason.contains("3 de 4") && dropped[0].reason.contains("70 < 85"));
        // Without calibration the same finding passes the level's own 60.
        assert_eq!(filter(parse(unsure), &contract("completo")).0.len(), 1);
    }

    /// A worker that omitted the confidence line has not flagged anything as uncertain.
    #[test]
    fn a_finding_with_no_confidence_survives() {
        let md = "### 🚨 [Crítico · Bug] x · F-001\n\ns\n\n📍 Ubicación: a.ts:1";
        let (kept, _) = filter(parse(md), &contract("completo"));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].confianza, None);
    }

    /// A closed finding is carried through whatever the level is — that is what makes the PR's
    /// history cumulative.
    #[test]
    fn a_closed_finding_is_never_re_filtered() {
        let mut f = parse("### ℹ️ [Menor · Code Smell] y · F-002\n\ns\n\n📍 Ubicación: b.ts:1\n\n🎯 Confianza: 10");
        f[0].estado = "falso_positivo".into();
        let (kept, dropped) = filter(f, &contract("basico"));
        assert_eq!(kept.len(), 1);
        assert!(dropped.is_empty());
    }

    #[test]
    fn findings_are_ordered_most_severe_first_then_most_confident() {
        let md = concat!(
            "### ℹ️ [Menor · Code Smell] c · F-001\n\ns\n\n📍 Ubicación: c.ts:1\n\n🎯 Confianza: 90\n\n",
            "### 🚨 [Crítico · Bug] a · F-002\n\ns\n\n📍 Ubicación: a.ts:1\n\n🎯 Confianza: 70\n\n",
            "### 🚨 [Crítico · Bug] b · F-003\n\ns\n\n📍 Ubicación: b.ts:1\n\n🎯 Confianza: 95\n\n",
        );
        let (findings, _, _) = consolidate(&[md.to_string()], &contract("ultra"), 1);
        let order: Vec<&str> = findings.iter().map(|f| f.categoria.as_str()).collect();
        assert_eq!(order, vec!["b", "a", "c"]);
        assert_eq!(findings[0].id, "F-001", "F-001 is always the most severe");
    }

    /// Three workers each numbering from `F-001` is the reason worker ids are thrown away.
    #[test]
    fn ids_written_by_the_workers_are_discarded_and_reassigned() {
        let one = "### 🚨 [Crítico · Bug] a · F-001\n\ns\n\n📍 Ubicación: a.ts:1\n\n🎯 Confianza: 90";
        let two = "### 🚨 [Crítico · Bug] b · F-001\n\ns\n\n📍 Ubicación: b.ts:1\n\n🎯 Confianza: 80";
        let three = "### 🚨 [Crítico · Bug] c · F-001\n\ns\n\n📍 Ubicación: c.ts:1\n\n🎯 Confianza: 70";
        let (findings, _, _) = consolidate(
            &[one.to_string(), two.to_string(), three.to_string()],
            &contract("completo"),
            1,
        );
        let ids: Vec<&str> = findings.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["F-001", "F-002", "F-003"], "no two findings share an id");
    }

    /// A re-review continues the numbering instead of restarting it.
    #[test]
    fn consolidation_starts_from_the_id_the_previous_run_stopped_at() {
        let md = "### 🚨 [Crítico · Bug] a · F-001\n\ns\n\n📍 Ubicación: a.ts:1\n\n🎯 Confianza: 90";
        let (findings, _, _) = consolidate(&[md.to_string()], &contract("completo"), 5);
        assert_eq!(findings[0].id, "F-005");
    }

    /// The collision the skip in `number` exists for: a carried id landing inside the new range.
    #[test]
    fn numbering_never_collides_with_a_carried_id() {
        let mut findings = parse(concat!(
            "### 🚨 [Crítico · Bug] a · F-004\n\ns\n\n📍 Ubicación: a.ts:1\n\n",
            "### 🚨 [Crítico · Bug] b\n\ns\n\n📍 Ubicación: b.ts:1\n\n",
            "### 🚨 [Crítico · Bug] c\n\ns\n\n📍 Ubicación: c.ts:1\n\n",
        ));
        number(&mut findings, 3);
        let ids: Vec<&str> = findings.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["F-004", "F-003", "F-005"]);
    }

    #[test]
    fn a_reply_with_no_findings_yields_none_rather_than_failing() {
        let (findings, discarded, merged) =
            consolidate(&["Todo se ve bien ✅".to_string()], &contract("completo"), 1);
        assert!(findings.is_empty());
        assert!(discarded.is_empty());
        assert_eq!(merged, 0);
    }

    /// The verdict lines, in the shapes models actually write them.
    #[test]
    fn prior_verdicts_are_read_in_every_shape_and_stripped_from_the_findings() {
        let reply = concat!(
            "### 🚨 [Crítico · Bug] npe · F-001\n\nsub\n\n📍 Ubicación: a.ts:1\n\n💭 Por qué: p\n\n",
            "PREVIO F-003: PERSISTE @ src/a.ts:42-50\n",
            "- **PREVIO F-004: RESUELTO** @ 60-64 — Se agregó la guarda que retorna 404.\n",
            "PREVIO f-007: resuelto @ `src/otro.ts:5-9` – Se movió la validación al servicio.\n",
            "PREVIO F-008: RESUELTO — Se eliminó la llamada.\n",
        );
        let v = parse_prior_verdicts(reply);
        assert_eq!(v.len(), 4);
        let p3 = &v["F-003"];
        assert!(!p3.resolved);
        assert_eq!((p3.archivo.as_deref(), p3.lineas.as_deref()), (Some("src/a.ts"), Some("42-50")));
        let p4 = &v["F-004"];
        assert!(p4.resolved);
        assert_eq!((p4.archivo.as_deref(), p4.lineas.as_deref()), (None, Some("60-64")));
        assert_eq!(p4.resolucion.as_deref(), Some("Se agregó la guarda que retorna 404."));
        let p7 = &v["F-007"];
        assert_eq!((p7.archivo.as_deref(), p7.lineas.as_deref()), (Some("src/otro.ts"), Some("5-9")));
        assert_eq!(p7.resolucion.as_deref(), Some("Se movió la validación al servicio."));
        assert_eq!((v["F-008"].lineas.as_deref(), v["F-008"].resolucion.as_deref()), (None, Some("Se eliminó la llamada.")));

        let cleaned = strip_prior_verdicts(reply);
        assert!(!cleaned.contains("PREVIO"));
        let findings = parse(&cleaned);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].por_que, "p", "the verdicts no longer trail the last field");
    }
}
