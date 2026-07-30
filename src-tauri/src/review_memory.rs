//! Reconciliation logic for the durable PR-review memory. The runs themselves are stored in the
//! `review_runs` table (see `db::queries`) so everything lives inside `codeflow.db` and travels
//! with it — this module is the pure logic that turns a review's markdown into the slim,
//! comparable findings kept there, and diffs a re-review against the previous run.
//!
//! The finding parse is intentionally minimal: it extracts only what memory + reconciliation need
//! (id, severity, type, category, location, confidence). The canonical, user-facing render stays
//! in `src/lib/parseAnalysis.ts`; this must track that format's finding header, which is why both
//! are documented as a shared contract.

use regex::Regex;
use serde::{Deserialize, Serialize};

/// One finding as remembered for reconciliation — a slim projection of what the review markdown
/// contains, not the full rendered finding. Persisted as the `review_runs.findings` JSON, and
/// carried across a PR's runs so its state (posted? resolved? marked?) and thread survive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFinding {
    pub id: String,
    /// `critical` | `warning` | `info`, derived from the finding's emoji (same buckets the UI uses).
    pub severity: String,
    pub tipo: String,
    pub categoria: String,
    pub subtitulo: String,
    pub archivo: Option<String>,
    pub lineas: Option<String>,
    pub confianza: Option<i64>,
    /// Lifecycle state, carried across runs: `abierto` (new, not posted) · `posteado` (has a
    /// thread, still present) · `resuelto` (no longer in the code) · `falso_positivo` /
    /// `ignorado` (human-marked). Defaults to `abierto`.
    #[serde(default = "default_estado")]
    pub estado: String,
    /// The PR comment thread this finding was posted to, if any — kept even once resolved so a
    /// re-post replies to the same thread instead of opening a duplicate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<i64>,
    /// Iteration (run number) this finding was first seen in. Powers "introducido iter N".
    #[serde(default)]
    pub introducido_en_iter: usize,
    /// Iteration it was detected as resolved in (only when `estado = resuelto`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resuelto_en_iter: Option<usize>,
    /// Why it was marked `falso_positivo`/`ignorado` (human-supplied); absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motivo_descarte: Option<String>,
    /// Only set on a re-review: `nuevo` | `persiste` | `resuelto` relative to the previous run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

fn default_estado() -> String {
    "abierto".to_string()
}

impl MemoryFinding {
    /// Active = counts toward the Quality Gate / severity buckets. Resolved and human-discarded
    /// findings are carried for traceability but excluded from the active view.
    pub fn is_active(&self) -> bool {
        matches!(self.estado.as_str(), "abierto" | "posteado")
    }
}

/// The reconciliation result of a re-review against the immediately previous run.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewDelta {
    pub iter_previa: usize,
    pub iter_actual: usize,
    pub nuevos: usize,
    pub persisten: usize,
    pub resueltos: usize,
}

/// Run metadata written verbatim to `review_runs.meta` (JSON).
#[derive(Debug, Clone, Serialize)]
pub struct ReviewMeta {
    pub pr_id: i64,
    pub pr_title: String,
    pub pr_description: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub url: String,
    pub provider: String,
    pub level: String,
    pub engine: String,
    pub model: String,
    pub project_id: String,
    pub project_name: String,
    /// Which repository this run actually reviewed — `github:host/owner/repo` or
    /// `azure:org/project/repoId` (see `repo_key` in `ado_cmd`).
    ///
    /// The project id alone doesn't answer that question: a project is a row pointing at a clone,
    /// and re-pointing it at another repository would otherwise hand the new one the old one's
    /// memory — same project id, entirely different code. Empty on runs recorded before this was
    /// tracked, which are read as "belongs to whatever project stored them", the rule that was
    /// true when they were written.
    #[serde(default)]
    pub repo_key: String,
    pub workspace_id: String,
    pub timestamp: String,
    pub iter: usize,
    /// The head commit SHA this review ran against — lets a re-review detect "nothing changed" and
    /// which files changed since. Empty for runs recorded before this was tracked.
    #[serde(default)]
    pub head_sha: String,
    /// What this run actually looked at: files touched and lines added/removed in the reviewed
    /// diff. Zero on runs recorded before this was tracked, which is why the summary that prints
    /// it treats an all-zero scope as "unknown" rather than as an empty change.
    #[serde(default)]
    pub files: usize,
    #[serde(default)]
    pub additions: usize,
    #[serde(default)]
    pub deletions: usize,
}

/// Files touched and lines added / removed across a reviewed diff — the "scope" line of a review
/// summary. Counted from the diff the review was actually given, so it describes the review rather
/// than the branch.
#[derive(Debug, Clone, Copy, Default)]
pub struct DiffScope {
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

/// Parses the slim finding projection from a review's markdown. Mirrors the finding header the
/// frontend parser (`parseAnalysis.ts`) emits: `### {emoji} [{Severidad} · {Tipo}] {Categoría} · F-NNN`.
pub fn parse_findings(review_md: &str) -> Vec<MemoryFinding> {
    // Same shape as parseAnalysis.ts HEADER_RE, adapted to Rust regex (unicode-aware by default).
    let header = Regex::new(
        r"(?m)^###\s*(🚨|⚠️|ℹ️)\s*\[([^·\]]+)·([^\]]+)\]\s*([^·]+)·\s*(F-\d+)\s*$",
    )
    .expect("valid header regex");
    let loc_re = Regex::new(r"📍\s*Ubicaci[oó]n:\s*([^\n]+)").expect("valid loc regex");
    let conf_re = Regex::new(r"🎯\s*Confianza:\s*(\d+)").expect("valid conf regex");

    let matches: Vec<_> = header.captures_iter(review_md).collect();
    let starts: Vec<usize> = header.find_iter(review_md).map(|m| m.start()).collect();

    let mut out = Vec::new();
    for (i, caps) in matches.iter().enumerate() {
        let block_start = starts[i];
        let block_end = starts.get(i + 1).copied().unwrap_or(review_md.len());
        let block = &review_md[block_start..block_end];

        let emoji = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let severity = match emoji {
            "🚨" => "critical",
            "⚠️" => "warning",
            _ => "info",
        };
        let tipo = caps.get(3).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let categoria = caps.get(4).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let id = caps.get(5).map(|m| m.as_str().trim().to_string()).unwrap_or_default();

        // Subtitle: first non-empty line after the header line, before the 📍/💭 fields.
        let subtitulo = block
            .lines()
            .skip(1)
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with('📍') && !l.starts_with('💭'))
            .unwrap_or("")
            .to_string();

        let (archivo, lineas) = loc_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| parse_location(m.as_str()))
            .unwrap_or((None, None));

        let confianza = conf_re
            .captures(block)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<i64>().ok());

        out.push(MemoryFinding {
            id,
            severity: severity.to_string(),
            tipo,
            categoria,
            subtitulo,
            archivo,
            lineas,
            confianza,
            estado: default_estado(),
            thread_id: None,
            introducido_en_iter: 0,
            resuelto_en_iter: None,
            motivo_descarte: None,
            delta: None,
        });
    }
    out
}

/// Splits a "📍 Ubicación" value into `(file, lines)`, stripping Markdown wrapping the model may
/// have added — same tolerance as the frontend's `parseLocation`.
fn parse_location(raw: &str) -> (Option<String>, Option<String>) {
    let cleaned = raw.trim().replace(['`', '*', '_'], "");
    let cleaned = cleaned.trim();
    match cleaned.rsplit_once(':') {
        Some((file, lines)) if !file.trim().is_empty() && lines.chars().any(|c| c.is_ascii_digit()) => {
            (Some(file.trim().to_string()), Some(lines.trim().to_string()))
        }
        _ => (Some(cleaned.to_string()).filter(|s| !s.is_empty()), None),
    }
}

/// Identity of a finding across runs — the same defect keeps this key even as line numbers drift,
/// so a persisted finding is recognized on re-review. File + category is stable enough in practice;
/// falls back to the subtitle when there's no location.
/// The identity key from a raw file + category — shared by reconciliation and by the posting flow
/// (to match a comment back to its stored finding and reuse its thread).
pub fn finding_identity(archivo: Option<&str>, categoria: &str) -> String {
    let file = archivo.unwrap_or_default().trim_start_matches('/').to_lowercase();
    let cat = categoria.to_lowercase();
    format!("{file}|{cat}")
}

fn identity(f: &MemoryFinding) -> String {
    let base = finding_identity(f.archivo.as_deref(), &f.categoria);
    if base == "|" {
        f.subtitulo.to_lowercase()
    } else {
        base
    }
}

/// Highest `F-NNN` number across a set of findings, so new ones get the next correlative and
/// persisting ones can keep their stable id.
fn max_id_num(findings: &[MemoryFinding]) -> usize {
    findings
        .iter()
        .filter_map(|f| f.id.strip_prefix("F-").and_then(|n| n.trim().parse::<usize>().ok()))
        .max()
        .unwrap_or(0)
}

/// Reconciles a fresh parse (`current`) against the previous run (`prev`) and returns the full,
/// merged finding set for this run plus the delta counts.
///
/// Rules (mirroring WF-PR-REVIEWER `re-review.md`): a current finding matching an active prev one
/// **persists** (keeps its stable id, `estado`, `thread_id`, `introducido_en_iter`); one matching
/// a human-discarded prev keeps that mark; an unmatched current one is **new**. A prev active
/// finding with no match this run is **resolved** (carried forward, thread kept). Findings already
/// resolved/discarded are always carried forward untouched — they're never deleted, which is what
/// gives the PR its cumulative traceability.
/// True when `finding_file` is (a suffix-tolerant match of) one of `changed`. File paths differ
/// between the review markdown (repo-relative) and git (also repo-relative, sometimes with a
/// leading slash), so compare normalized and allow either to be a suffix of the other.
fn file_in_changed(finding_file: &str, changed: &[String]) -> bool {
    let norm = |s: &str| s.trim_start_matches('/').to_lowercase();
    let a = norm(finding_file);
    changed.iter().any(|c| {
        let c = norm(c);
        c == a || c.ends_with(&a) || a.ends_with(&c)
    })
}

/// Reconciles a fresh parse against the previous run. `changed_files`, when provided (an efficient
/// re-review), is the set of files that changed since the last run: a previous active finding on a
/// file that did NOT change auto-persists (its code wasn't touched), rather than looking resolved
/// just because this run didn't re-surface it. `None` means a full review, where any unmatched
/// active finding is treated as resolved.
pub fn reconcile(
    prev: &[MemoryFinding],
    current: &[MemoryFinding],
    prev_iter: usize,
    changed_files: Option<&[String]>,
) -> (Vec<MemoryFinding>, ReviewDelta) {
    let iter_actual = prev_iter + 1;
    let mut next_id = max_id_num(prev).max(max_id_num(current)) + 1;

    let mut merged: Vec<MemoryFinding> = Vec::new();
    let mut matched_prev: Vec<String> = Vec::new();
    let (mut nuevos, mut persisten, mut resueltos) = (0, 0, 0);

    for cur in current {
        let key = identity(cur);
        let prev_match = prev.iter().find(|p| identity(p) == key);
        match prev_match {
            // Reappeared after being resolved → treat as a brand-new finding (new id/iter).
            Some(p) if p.estado == "resuelto" => {
                let mut f = cur.clone();
                f.id = format!("F-{next_id:03}");
                next_id += 1;
                f.estado = "abierto".to_string();
                f.introducido_en_iter = iter_actual;
                f.delta = Some("nuevo".to_string());
                nuevos += 1;
                merged.push(f);
            }
            // Still present and previously seen (active or human-discarded) → persists.
            Some(p) => {
                let mut f = cur.clone();
                f.id = p.id.clone();
                f.estado = p.estado.clone();
                f.thread_id = p.thread_id;
                f.introducido_en_iter = if p.introducido_en_iter == 0 { prev_iter.max(1) } else { p.introducido_en_iter };
                f.motivo_descarte = p.motivo_descarte.clone();
                f.delta = Some("persiste".to_string());
                if f.is_active() {
                    persisten += 1;
                }
                matched_prev.push(key);
                merged.push(f);
            }
            // Never seen before → new.
            None => {
                let mut f = cur.clone();
                f.id = format!("F-{next_id:03}");
                next_id += 1;
                f.estado = "abierto".to_string();
                f.introducido_en_iter = iter_actual;
                f.delta = Some("nuevo".to_string());
                nuevos += 1;
                merged.push(f);
            }
        }
    }

    // Carry forward every prev finding not matched above.
    for p in prev {
        let key = identity(p);
        if matched_prev.contains(&key) || merged.iter().any(|m| m.id == p.id) {
            continue;
        }
        let mut f = p.clone();
        if p.is_active() {
            // On an efficient re-review, a finding whose file wasn't touched can't have been fixed —
            // its code wasn't re-analyzed, so auto-persist instead of declaring it resolved.
            let file_touched = match (changed_files, &p.archivo) {
                (Some(changed), Some(file)) => file_in_changed(file, changed),
                // No changed-file info (full review) or no location → treat as re-analyzed.
                _ => true,
            };
            if file_touched {
                // Its file was re-reviewed and it's gone → resolved (thread kept for the reply).
                f.estado = "resuelto".to_string();
                f.resuelto_en_iter = Some(iter_actual);
                f.delta = Some("resuelto".to_string());
                resueltos += 1;
            } else {
                f.delta = Some("persiste".to_string());
                persisten += 1;
            }
        } else {
            // Already resolved/discarded → carried untouched (traceability).
            f.delta = Some("persiste".to_string());
        }
        merged.push(f);
    }

    (merged, ReviewDelta { iter_previa: prev_iter, iter_actual, nuevos, persisten, resueltos })
}

/// The cumulative "resolved / discarded findings" traceability appended to a re-review's body —
/// every finding resolved or human-discarded over the PR's life, with the iteration it entered and
/// (for resolved) left. Returns `None` when there's nothing to show, so first reviews stay clean.
pub fn resolved_history_section(findings: &[MemoryFinding]) -> Option<String> {
    let resolved: Vec<&MemoryFinding> = findings.iter().filter(|f| f.estado == "resuelto").collect();
    let discarded: Vec<&MemoryFinding> = findings
        .iter()
        .filter(|f| matches!(f.estado.as_str(), "falso_positivo" | "ignorado"))
        .collect();
    if resolved.is_empty() && discarded.is_empty() {
        return None;
    }

    let mut s = String::new();
    if !resolved.is_empty() {
        s.push_str("\n\n---\n\n### 🕘 Historial de hallazgos resueltos (trazabilidad)\n\n");
        for f in resolved {
            let file = f.archivo.clone().unwrap_or_else(|| "—".to_string());
            s.push_str(&format!(
                "- `{}` · {} — introducido iter {} · resuelto iter {}\n",
                f.categoria,
                file,
                f.introducido_en_iter,
                f.resuelto_en_iter.unwrap_or(0),
            ));
        }
    }
    if !discarded.is_empty() {
        s.push_str("\n### 🗂️ Hallazgos descartados\n\n");
        for f in discarded {
            let file = f.archivo.clone().unwrap_or_else(|| "—".to_string());
            let motivo = f.motivo_descarte.clone().unwrap_or_default();
            let estado = if f.estado == "falso_positivo" { "falso positivo" } else { "ignorado" };
            s.push_str(&format!("- `{}` · {} — {}{}\n", f.categoria, file, estado, if motivo.is_empty() { String::new() } else { format!(": {motivo}") }));
        }
    }
    Some(s)
}

/// A one-line, human-facing summary of a re-review delta, prepended to the returned review so the
/// user immediately sees what changed since the last run. Renders as plain summary prose in the
/// review panel (it sits before the findings, so the frontend parser keeps it out of the findings
/// list).
pub fn delta_banner(delta: &ReviewDelta) -> String {
    format!(
        "🔁 Re-revisión (iter {} → {}): {} nuevos · {} persisten · {} resueltos\n\n",
        delta.iter_previa, delta.iter_actual, delta.nuevos, delta.persisten, delta.resueltos,
    )
}
