//! Reconciliation logic for the durable PR-review memory. The runs themselves are stored in the
//! `review_runs` table (see `db::queries`) so everything lives inside `codeflow.db` and travels
//! with it — this module is the pure logic that turns a review's markdown into the slim,
//! comparable findings kept there, and diffs a re-review against the previous run.
//!
//! Parsing the review markdown into findings used to live here too. It moved to
//! `review::merge`, which needs every field rather than the slim projection, and keeping a second
//! reader of the same format was how the two would eventually disagree about it: what this module
//! stores is now a projection of what that one parsed (`review::merge::Finding::to_memory`).

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// One finding as remembered for reconciliation — a slim projection of what the review markdown
/// contains, not the full rendered finding. Persisted as the `review_runs.findings` JSON, and
/// carried across a PR's runs so its state (posted? resolved? marked?) and thread survive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFinding {
    pub id: String,
    /// `critical` | `warning` | `info`, derived from the finding's emoji (same buckets the UI uses).
    pub severity: String,
    /// The severity itself — `Blocker` · `Crítico` · `Mayor` · `Menor` · `Info` — which the bucket
    /// above cannot give back: `critical` is both a Blocker and a Crítico, and a gate that blocks on
    /// Blocker alone must not mistake one for the other when a carried finding is rebuilt from here.
    /// Empty on runs recorded before this was kept.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub severidad: String,
    pub tipo: String,
    pub categoria: String,
    pub subtitulo: String,
    pub archivo: Option<String>,
    pub lineas: Option<String>,
    pub confianza: Option<i64>,
    /// Lifecycle state, carried across runs: `abierto` (new, not posted) · `posteado` (has a
    /// thread, still present) — the two *active* ones — · `deuda_tecnica` (real, accepted and
    /// still in the code: out of the gate but carried visibly and re-judged when its file changes,
    /// which is how it gets paid) · `resuelto` (a reviewer judged it fixed) · `falso_positivo` /
    /// `ignorado` (human-marked). Defaults to `abierto`. See [`set_finding_state`] for the one way
    /// code outside reconciliation should move it.
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
    /// Why it was marked `falso_positivo`/`ignorado`/`deuda_tecnica` (human-supplied); absent
    /// otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motivo_descarte: Option<String>,
    /// What fixed it, in the reviewer's words (1–2 sentences) — only on a `resuelto` the reviewer
    /// judged. Published on its thread and kept in the report's history, because "resuelto" alone
    /// asks the author to take the tool's word for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolucion: Option<String>,
    /// The file the fix landed in, when it is not the finding's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolucion_archivo: Option<String>,
    /// The lines of the fix — what the "📄 Código que lo resuelve" snippet is cut from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolucion_lineas: Option<String>,
    /// A re-review's new finding on code that did not change since the previously reviewed
    /// iteration: it should have been caught then. Said on the finding so the team can tell a
    /// regression from a miss, never used to drop it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tardio: bool,
    /// Only set on a re-review: `nuevo` | `persiste` | `resuelto` relative to the previous run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    /// This finding as the body of a pull-request comment — see [`crate::review::render::comment_markdown`].
    ///
    /// The one field here that is not a projection of something smaller. It exists because the rest
    /// of this struct deliberately drops `por_que`, `sugerencia` and `ejemplo_*`, and those are what
    /// a comment is made of: a client that holds only the stored findings (the mobile one) could
    /// otherwise publish nothing better than the subtitle — and because `record_published` records
    /// the thread id, that one-line comment would become the thread every later desktop publish
    /// replies to. Written once, at save time, from the same findings the report was rendered from.
    ///
    /// Empty on runs recorded before this was tracked, and on findings carried forward from one.
    /// That is read as "this run cannot be published from a client that only has the memory" — never
    /// filled in with a substitute, because a comment nobody wrote is not a comment.
    #[serde(default)]
    pub comentario_md: String,
    /// The iteration whose publish last wrote to this finding's thread — opened it, replied "sigue
    /// presente" on it, or closed it as fixed.
    ///
    /// What stops a second publish of the same review from talking twice. A publish that half-failed
    /// is retried by selecting again, and without this every finding that *did* land the first time
    /// would get a "sigue presente" reply on the thread it had opened seconds earlier — the reply
    /// meant for a later iteration, posted about the current one. Carried forward by reconciliation,
    /// so the next iteration (a different number) may publish again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publicado_en_iter: Option<usize>,
    /// True when the finding's thread is a plain pull-request comment rather than one anchored to a
    /// line — it had no location, or the host refused the line (GitHub answers 422 for a line outside
    /// the diff). GitHub cannot reply to or resolve such a comment, so a follow-up there is a new
    /// comment naming the finding instead of a reply that is certain to fail.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hilo_general: bool,
    /// What the pull request's own threads said about this finding — see [`crate::review::threads`].
    /// Flattened, so the stored JSON reads `sincronizado_desde_hilo`, `veredicto_pr`, … beside the
    /// rest, and a run written before this existed reads back as "the PR said nothing".
    #[serde(flatten, default)]
    pub hilo_pr: HiloPr,
}

/// The pull request's word on one finding, as the last re-review read it from the PR's threads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HiloPr {
    /// The current `estado` came from the PR — a thread the team closed, or a reply that opened with
    /// the verdict — rather than from a click in this app. A human verdict all the same: it feeds the
    /// "don't raise this again" block and the calibration exactly like one marked here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sincronizado_desde_hilo: bool,
    /// How: `status` (the thread's status on the host) · `texto` (a reply on the finding's own
    /// thread) · `resumen` (its block in a reply to this app's summary comment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sincronizado_via: Option<String>,
    /// The iteration whose re-review applied it — what the report of that run lists as synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sincronizado_en_iter: Option<usize>,
    /// A verdict the PR gave that did **not** apply on its own: the phrase sat past the comment's
    /// opening, or the finding's file changed since (the code moved, so it is re-judged instead).
    /// The finding card offers it as one click; it is recomputed on every re-review.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub veredicto_pr: Option<VeredictoPr>,
    /// When a human reopened it here (RFC 3339). A verdict on the PR older than this is the one they
    /// overrode — re-applying it would make reopening impossible while the thread stays closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reabierto_en: Option<String>,
}

/// A verdict read from the pull request, kept for a human to apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VeredictoPr {
    /// `falso_positivo` · `ignorado` · `deuda_tecnica`.
    pub estado: String,
    /// The human's words — what becomes `motivo_descarte` once applied.
    pub motivo: String,
    /// `status` · `texto` · `resumen`, as in [`HiloPr::sincronizado_via`].
    pub via: String,
    #[serde(default)]
    pub autor: String,
    #[serde(default)]
    pub fecha: String,
}

fn default_estado() -> String {
    "abierto".to_string()
}

impl MemoryFinding {
    /// Active = counts toward the Quality Gate / severity buckets. Resolved and human-discarded
    /// findings are carried for traceability but excluded from the active view — and so is
    /// accepted technical debt, which is real but was knowingly deferred.
    pub fn is_active(&self) -> bool {
        matches!(self.estado.as_str(), "abierto" | "posteado")
    }

    /// Accepted technical debt: out of the gate, but not closed — see [`MemoryFinding::needs_judgement`].
    pub fn is_debt(&self) -> bool {
        self.estado == ESTADO_DEUDA
    }

    /// What a re-review must hand back to a reviewer when its file is re-read: everything still in
    /// the code. Debt included — re-judging it is the only way it ever becomes `resuelto` (paid).
    pub fn needs_judgement(&self) -> bool {
        self.is_active() || self.is_debt()
    }

    /// The finding's "why", for re-judging it. The memory keeps no `por_que` of its own — it lives
    /// in the stored comment body — so it is read back out of that, cut short: the reviewer needs
    /// the mechanism, not the essay. `None` on runs saved before comment bodies were kept.
    pub fn por_que_breve(&self) -> Option<String> {
        const MAX: usize = 400;
        let (_, rest) = self.comentario_md.split_once("💭 **Por qué:**")?;
        let why = rest.split("\n\n").next().unwrap_or("").trim();
        if why.is_empty() {
            return None;
        }
        let mut out: String = why.chars().take(MAX).collect();
        if why.chars().count() > MAX {
            out.push('…');
        }
        Some(out.replace('\n', " "))
    }
}

/// The accepted-technical-debt state.
pub const ESTADO_DEUDA: &str = "deuda_tecnica";

/// Moves one finding to `estado`, with the reason it needs — the single way anything outside
/// reconciliation changes a finding's lifecycle (the human's mark, an import, a sync from the
/// pull request's own threads), so every caller agrees on what each state requires:
///
/// - `falso_positivo` · `ignorado` · `deuda_tecnica` take `motivo`; debt **requires** one, because
///   "accepted" with no reason is a decision nobody can revisit.
/// - `resuelto` takes `motivo` as its `resolucion` and stamps `iter` as the iteration it was fixed in.
/// - `abierto` (or `posteado`) reopens: back to active — `posteado` when it still owns a thread —
///   with the discard reason cleared.
///
/// Clears the fields the previous state carried and this one does not, so a reopened finding
/// doesn't keep announcing a fix, and a fix doesn't keep a discard reason.
pub fn set_finding_state(f: &mut MemoryFinding, estado: &str, motivo: Option<String>, iter: usize) -> Result<(), String> {
    let motivo = motivo.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let was_active = f.is_active();
    match estado {
        "falso_positivo" | "ignorado" | ESTADO_DEUDA => {
            if estado == ESTADO_DEUDA && motivo.is_none() {
                return Err("Marking a finding as technical debt needs a reason".to_string());
            }
            f.estado = estado.to_string();
            f.motivo_descarte = motivo;
        }
        "resuelto" => {
            f.estado = estado.to_string();
            f.resuelto_en_iter = Some(iter.max(1));
            f.resolucion = motivo;
        }
        "abierto" | "posteado" => {
            f.estado = if f.thread_id.is_some() { "posteado" } else { "abierto" }.to_string();
            f.motivo_descarte = None;
            f.resuelto_en_iter = None;
            f.resolucion = None;
            f.resolucion_archivo = None;
            f.resolucion_lineas = None;
            // Taking back a ruling (the team's, synced, or one made here): stamped, so the PR's
            // older word on it does not simply come back on the next re-review.
            if !was_active {
                f.hilo_pr.reabierto_en = Some(chrono::Utc::now().to_rfc3339());
            }
        }
        other => return Err(format!("Unknown finding state: {other}")),
    }
    // Whatever moved it now is the new word: a pending PR verdict is answered, and a sync is no
    // longer what the state says — the caller that syncs sets those back right after.
    let reabierto_en = f.hilo_pr.reabierto_en.take();
    f.hilo_pr = HiloPr { reabierto_en, ..HiloPr::default() };
    Ok(())
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
    /// Which repository this run actually reviewed — `github:host/owner/repo`, `gitlab:host/full/path` or
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
    /// The level's contract as it was resolved for this run — threshold, severities, lenses.
    ///
    /// Frozen rather than re-derived on read, because the workspace's policy is editable: a review
    /// from three months ago was produced under whatever the rules were then, and re-reading it
    /// under today's would describe a review that never happened. `Null` on runs recorded before
    /// the policy was tracked.
    #[serde(default)]
    pub level_contract: serde_json::Value,
    /// Which severities the Quality Gate blocked on for this run, for the same reason.
    #[serde(default)]
    pub quality_gate_policy: Vec<String>,
    /// Whether this run passed its gate. Stored so a memory browser can show the verdict without
    /// re-deriving it from findings whose state has since been edited by hand.
    #[serde(default)]
    pub quality_gate: bool,
    /// How many reviewers produced it — what the level actually bought.
    #[serde(default)]
    pub workers: usize,
    /// A reviewer or pass failed: part of the PR was not looked at. Lets the next review of the same
    /// commit run instead of answering "nothing changed".
    #[serde(default)]
    pub incomplete: bool,
    /// What the run spent, summed over its passes. Absent on runs recorded before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<RunCost>,
    /// The repository calibration this run was held to — the categories and the bar — frozen for the
    /// same reason as the contract: the history that raised it keeps moving. Absent when none applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration: Option<crate::review::calibration::Applied>,
    /// The deterministic rules that ran on this run, and the ones that could not be evaluated and
    /// why. Empty when none ran (or on runs recorded before they were kept).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<crate::review::deterministic::RuleRecord>,
}

/// What one review spent: every pass's tokens summed, and the price when the engines said one.
///
/// The global meter (`ai_usage`) already records each pass, but by engine and task — "review-pr" —
/// with nothing to say which review it was. This is that same usage, kept with the run it paid for.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct RunCost {
    pub passes: usize,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// The sum of the prices the engines reported; `None` when not one of the passes reported a
    /// price — an engine that never prints one is not free.
    pub cost_usd: Option<f64>,
    /// Passes that reported no usage at all (some CLIs do not): the totals above leave them out.
    pub unreported: usize,
    pub duration_ms: u64,
}

impl RunCost {
    /// One more pass, with whatever it reported.
    pub fn add(&mut self, usage: Option<&crate::ai::AiUsage>) {
        self.passes += 1;
        let Some(usage) = usage else {
            self.unreported += 1;
            return;
        };
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.cache_read_tokens += usage.cache_read_tokens;
        self.cache_write_tokens += usage.cache_write_tokens;
        if let Some(cost) = usage.cost_usd {
            self.cost_usd = Some(self.cost_usd.unwrap_or(0.0) + cost);
        }
    }

    /// The one line the run's log ends with.
    pub fn line(&self) -> String {
        let tokens = |n: i64| if n >= 10_000 { format!("{}k", n / 1_000) } else { n.to_string() };
        let mut out = format!(
            "{} pasada(s) · {} tokens de entrada · {} de salida",
            self.passes,
            tokens(self.input_tokens + self.cache_read_tokens + self.cache_write_tokens),
            tokens(self.output_tokens)
        );
        if let Some(cost) = self.cost_usd {
            out.push_str(&format!(" · ≈ US${cost:.2}"));
        }
        if self.unreported > 0 {
            out.push_str(&format!(" · {} sin informar", self.unreported));
        }
        out
    }
}

/// The *kind* of defect a finding is, across runs: file + category, falling back to the subtitle
/// when there is neither. Line numbers are deliberately not in it — they drift the moment anything
/// above the defect changes, and the same defect must still be recognised in the next iteration.
///
/// That also makes it **not an identity**: one file can hold two defects of one category (a null
/// dereference at line 12 and another at 480), and the dedupe rightly keeps both. The identity of a
/// finding is its stable `F-NNN` id; this key only narrows down which earlier finding a new one can
/// be (see [`pair_up`], which settles the rest by line) and is the fallback for a publish that names
/// no id (see [`match_publish_item`]).
pub fn finding_identity(archivo: Option<&str>, categoria: &str) -> String {
    let file = crate::review::outline::normalize_path(archivo.unwrap_or_default()).to_lowercase();
    format!("{file}|{}", category_slug(categoria))
}

/// A category as the model would have meant it, whatever it typed: lowercase, accents and
/// punctuation folded, words joined by `-`. `Null dereference`, `null-dereference` and
/// `NULL_DEREFERENCE` are one category.
///
/// The prompt asks for a kebab-case slug, and most of the time it gets one — but "most of the time"
/// was the weak point of reconciliation: the same defect re-reported as `Null Dereference` read as a
/// new finding *and* the old one as fixed, and its thread got a "resuelto" it had not earned.
pub fn category_slug(categoria: &str) -> String {
    let folded: String = categoria
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join("-")
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

/// A `lineas` value ("42", "42-50", "42-50, 80") as the first and last line it names. `None` when
/// nothing in it reads as a number — such a finding has no position to compare.
pub fn line_span(lineas: Option<&str>) -> Option<(u32, u32)> {
    let numbers: Vec<u32> = lineas?
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|n| n.parse::<u32>().ok())
        .collect();
    Some((*numbers.iter().min()?, *numbers.iter().max()?))
}

/// How far apart two spans are: `0` when they overlap, otherwise the gap between them. A side with no
/// position is as far as anything can be — still a candidate, only the least likely one.
fn span_distance(a: Option<(u32, u32)>, b: Option<(u32, u32)>) -> u32 {
    match (a, b) {
        (Some((a_lo, a_hi)), Some((b_lo, b_hi))) => {
            if a_lo <= b_hi && b_lo <= a_hi {
                0
            } else if a_hi < b_lo {
                b_lo - a_hi
            } else {
                a_lo - b_hi
            }
        }
        _ => u32::MAX,
    }
}

/// Which earlier finding each current one continues — `result[i]` is the index into `prev` that
/// `current[i]` takes over, if any. **One to one**: no two current findings ever continue the same
/// earlier one.
///
/// It used to be "the first earlier finding with the same file and category", which collapsed two
/// same-category findings in one file onto one id: both inherited it, the second earlier finding
/// matched nothing and silently vanished from the memory, and publishing then sent the second
/// defect's comment into the first one's thread as a "sigue presente" reply.
///
/// Candidates must share [`finding_identity`]; among them the nearest by line wins, taken globally
/// rather than in reading order — every candidate pair is ranked and the closest pairs are settled
/// first, so a finding that happens to be listed first cannot take the earlier finding that sits
/// right next to another one. Ties prefer an earlier finding that is still live over one already
/// `resuelto`, then the order the model reported them in.
fn pair_up(prev: &[MemoryFinding], current: &[MemoryFinding]) -> Vec<Option<usize>> {
    let mut pairs: Vec<(u32, bool, usize, usize)> = Vec::new();
    for (i, cur) in current.iter().enumerate() {
        let key = identity(cur);
        let here = line_span(cur.lineas.as_deref());
        for (j, p) in prev.iter().enumerate() {
            if identity(p) == key {
                let distance = span_distance(here, line_span(p.lineas.as_deref()));
                pairs.push((distance, p.estado == "resuelto", i, j));
            }
        }
    }
    pairs.sort_unstable();

    let mut of_current: Vec<Option<usize>> = vec![None; current.len()];
    let mut taken = vec![false; prev.len()];
    for (_, _, i, j) in pairs {
        if of_current[i].is_none() && !taken[j] {
            of_current[i] = Some(j);
            taken[j] = true;
        }
    }

    // Second chance for what the category could not settle: the same defect re-reported under
    // another name. Only on overwhelming evidence — same file, same type, within a few lines, and
    // saying the same thing — because pairing two *different* defects is worse than missing one:
    // the second one's text would be posted as a "sigue presente" reply in the first one's thread.
    let mut near: Vec<(u32, usize, usize)> = Vec::new();
    for (i, cur) in current.iter().enumerate() {
        if of_current[i].is_some() || cur.archivo.is_none() {
            continue;
        }
        let here = line_span(cur.lineas.as_deref());
        for (j, p) in prev.iter().enumerate() {
            if taken[j] || p.estado == "resuelto" || p.tipo != cur.tipo {
                continue;
            }
            let same_file = matches!((&cur.archivo, &p.archivo), (Some(a), Some(b)) if crate::review::outline::same_path(a, b));
            let distance = span_distance(here, line_span(p.lineas.as_deref()));
            if same_file && distance <= RENAMED_MAX_DISTANCE && says_the_same(cur, p) {
                near.push((distance, i, j));
            }
        }
    }
    near.sort_unstable();
    for (_, i, j) in near {
        if of_current[i].is_none() && !taken[j] {
            of_current[i] = Some(j);
            taken[j] = true;
        }
    }
    of_current
}

/// How far apart, in lines, a re-named finding may be from the one it continues.
const RENAMED_MAX_DISTANCE: u32 = 3;

/// Whether two findings describe the same thing in words: their categories share a word, or their
/// subtitles share enough of theirs. Deliberately crude — it only has to separate "the null check,
/// renamed" from "a different bug two lines down", and the line distance already did most of that.
fn says_the_same(a: &MemoryFinding, b: &MemoryFinding) -> bool {
    fn words(s: &str) -> std::collections::HashSet<String> {
        category_slug(s).split('-').filter(|w| w.chars().count() > 3).map(str::to_string).collect()
    }
    let (ca, cb) = (words(&a.categoria), words(&b.categoria));
    if ca.intersection(&cb).next().is_some() {
        return true;
    }
    let (sa, sb) = (words(&a.subtitulo), words(&b.subtitulo));
    let union = sa.union(&sb).count();
    union > 0 && sa.intersection(&sb).count() * 4 >= union
}

/// What a run did **not** re-read, so reconciliation never mistakes "not looked at" for "fixed".
///
/// A previous finding is declared `resuelto` because the run that should have re-found it did not.
/// That inference only holds for code the run actually read: a reviewer that failed, a file whose
/// content had to be dropped from its bundle, a cross-file pass that never ran — each leaves
/// findings nobody re-checked, and calling those fixed is how a Blocker used to be marked resolved
/// (and its thread closed on the pull request) by a review that crashed.
#[derive(Debug, Clone, Copy, Default)]
pub struct Unread<'a> {
    /// Files whose reviewer failed or whose content never reached one.
    pub files: &'a [String],
    /// Findings with no file were not re-checked either — a failed cross-file pass, or any failure
    /// at all when the run cannot say which reviewer would have owned them.
    pub unlocated: bool,
}

/// True when `finding_file` is (a suffix-tolerant match of) one of `changed`. File paths differ
/// between the review markdown (repo-relative) and git (also repo-relative, sometimes with a
/// leading slash), so compare normalized and allow either to be a suffix of the other.
fn file_in_changed(finding_file: &str, changed: &[String]) -> bool {
    changed.iter().any(|c| crate::review::outline::same_path(c, finding_file))
}

/// One reviewer's ruling on a previous finding it was handed back to re-judge (see
/// [`reevaluate_block`]): still there, or fixed — and where.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PriorVerdict {
    pub resolved: bool,
    /// Persists: where the finding now is. Resolved: the file of the fix, when the reviewer named one.
    pub archivo: Option<String>,
    /// Persists: its current lines. Resolved: the lines of the fix.
    pub lineas: Option<String>,
    /// Resolved: what fixes it, 1–2 sentences.
    pub resolucion: Option<String>,
}

/// Lines a re-review's delta touched, per file — the new-side line numbers added (or where
/// something was deleted) between the previously reviewed iteration and this one.
pub type DeltaLines = std::collections::HashMap<String, Vec<(u32, u32)>>;

/// What a re-review knows besides the findings it reported — every field optional, and absent
/// meaning "this run cannot say", which is always read in the direction that changes nothing on
/// the pull request.
#[derive(Debug, Clone, Copy, Default)]
pub struct Rereview<'a> {
    /// The files that changed since the previous run (an efficient re-review); `None` on a full one.
    pub changed_files: Option<&'a [String]>,
    /// What the run did not actually re-read.
    pub unread: Unread<'a>,
    /// The reviewers' rulings on the previous findings they were handed, by id.
    pub verdicts: Option<&'a std::collections::HashMap<String, PriorVerdict>>,
    /// The delta's lines, for telling a late finding from a new one. `None` when there is no delta
    /// (a first review, a full one, a review with no clone).
    pub delta_lines: Option<&'a DeltaLines>,
}

/// Whether a finding at `lineas` of `file` sits on anything the delta touched. A file the delta
/// never touched is untouched whatever the lines; a finding with no lines in a touched file can't
/// be placed, and is given the benefit of the doubt.
fn touches_delta(file: &str, lineas: Option<&str>, delta: &DeltaLines) -> bool {
    let Some((_, spans)) = delta.iter().find(|(path, _)| crate::review::outline::same_path(path, file)) else {
        return false;
    };
    match line_span(lineas) {
        Some(here) => spans.iter().any(|span| span_distance(Some(here), Some(*span)) == 0),
        None => true,
    }
}

/// Reconciles a fresh parse (`current`) against the previous run (`prev`) and returns the full,
/// merged finding set for this run plus the delta counts.
///
/// Rules (mirroring WF-PR-REVIEWER `re-review.md`): a current finding that continues a prev one
/// (see [`pair_up`]) **persists** — keeps its stable id, `estado` (a human's discard or accepted
/// debt included), `thread_id`, `introducido_en_iter`; an unmatched current one is **new** (and
/// `tardio` when none of its lines is one the delta touched). Findings already resolved/discarded
/// are always carried forward untouched — they're never deleted, which is what gives the PR its
/// cumulative traceability.
///
/// **A previous finding is only `resuelto` when a reviewer judged it so.** It used to be inferred:
/// its file was re-read and it simply didn't reappear. That inference closed threads on the pull
/// request — an outward-facing claim — every time a model merely forgot to repeat itself. Now every
/// previous finding still in the code (active, or accepted debt) whose file is re-read is handed to
/// the reviewer that reads it, which must return a verdict ([`PriorVerdict`]): persists, or resolved
/// with what fixed it. One with **no verdict and no current finding continuing it persists** — the
/// conservative direction, because a wrongly-open thread costs a click and a wrongly-closed one
/// hides a defect. A verdict is only honoured for a file this run actually re-read (in the delta,
/// and not among the [`Unread`]).
///
/// **The result is positional**: `merged[i]` is `current[i]` for every `i < current.len()`, and
/// the carried-forward history follows. The caller carries ids back onto the full findings by that
/// position — by key it could not, since two findings may share one (see [`finding_identity`]).
///
/// Ids come out unique even from a memory that has duplicates in it — which runs saved before the
/// matching was one to one do. The first holder keeps the id; any later one is renumbered, thread
/// and all, rather than left sharing it.
#[cfg(test)]
pub fn reconcile(
    prev: &[MemoryFinding],
    current: &[MemoryFinding],
    prev_iter: usize,
    changed_files: Option<&[String]>,
) -> (Vec<MemoryFinding>, ReviewDelta) {
    reconcile_with(prev, current, prev_iter, Rereview { changed_files, ..Default::default() })
}

/// [`reconcile`], with everything the re-review knows — see [`Rereview`].
pub fn reconcile_with(
    prev: &[MemoryFinding],
    current: &[MemoryFinding],
    prev_iter: usize,
    re: Rereview<'_>,
) -> (Vec<MemoryFinding>, ReviewDelta) {
    let iter_actual = prev_iter + 1;
    let mut next_id = max_id_num(prev).max(max_id_num(current)) + 1;
    let mut fresh_id = || {
        let id = format!("F-{next_id:03}");
        next_id += 1;
        id
    };
    let late = |f: &MemoryFinding| match (re.delta_lines, &f.archivo) {
        (Some(delta), Some(file)) => !touches_delta(file, f.lineas.as_deref(), delta),
        _ => false,
    };

    let pairs = pair_up(prev, current);
    // Earlier findings whose identity lives on in a current one — the ones not carried forward.
    let mut continued = vec![false; prev.len()];
    let mut used_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut merged: Vec<MemoryFinding> = Vec::with_capacity(current.len() + prev.len());
    let (mut nuevos, mut persisten, mut resueltos) = (0, 0, 0);

    for (i, cur) in current.iter().enumerate() {
        let mut f = cur.clone();
        match pairs[i] {
            // Reappeared after being resolved → a brand-new finding (new id/iter). The resolved one
            // stays in the history, carried forward below as it was.
            Some(j) if prev[j].estado == "resuelto" => {
                f.id = fresh_id();
                f.estado = "abierto".to_string();
                f.introducido_en_iter = iter_actual;
                f.delta = Some("nuevo".to_string());
                f.tardio = late(&f);
                nuevos += 1;
            }
            // Still present and previously seen (active, debt or human-discarded) → persists.
            Some(j) => {
                let p = &prev[j];
                continued[j] = true;
                f.id = if used_ids.contains(&p.id) { fresh_id() } else { p.id.clone() };
                f.estado = p.estado.clone();
                f.thread_id = p.thread_id;
                f.hilo_general = p.hilo_general;
                f.publicado_en_iter = p.publicado_en_iter;
                f.introducido_en_iter = if p.introducido_en_iter == 0 { prev_iter.max(1) } else { p.introducido_en_iter };
                f.motivo_descarte = p.motivo_descarte.clone();
                f.hilo_pr = p.hilo_pr.clone();
                f.tardio = p.tardio;
                f.delta = Some("persiste".to_string());
                if f.is_active() {
                    persisten += 1;
                }
            }
            // Never seen before → new.
            None => {
                f.id = fresh_id();
                f.estado = "abierto".to_string();
                f.introducido_en_iter = iter_actual;
                f.delta = Some("nuevo".to_string());
                f.tardio = late(&f);
                nuevos += 1;
            }
        }
        used_ids.insert(f.id.clone());
        merged.push(f);
    }

    // Carry forward every prev finding nothing above continued.
    for (j, p) in prev.iter().enumerate() {
        if continued[j] {
            continue;
        }
        let mut f = p.clone();
        if used_ids.contains(&f.id) {
            f.id = fresh_id();
        }
        used_ids.insert(f.id.clone());
        f.delta = Some("persiste".to_string());
        if p.needs_judgement() {
            // A verdict counts only for code this run read again: a file in the delta (or any file,
            // on a full review) whose reviewer did not fail and whose content reached it.
            let reread = match &p.archivo {
                Some(file) => {
                    re.changed_files.is_none_or(|changed| file_in_changed(file, changed))
                        && !file_in_changed(file, re.unread.files)
                }
                None => !re.unread.unlocated,
            };
            let verdict = re.verdicts.filter(|_| reread).and_then(|v| v.get(&p.id.to_uppercase()));
            match verdict {
                Some(v) if v.resolved => {
                    f.estado = "resuelto".to_string();
                    f.resuelto_en_iter = Some(iter_actual);
                    f.resolucion = v.resolucion.clone();
                    f.resolucion_archivo = v
                        .archivo
                        .clone()
                        .filter(|file| !p.archivo.as_deref().is_some_and(|own| crate::review::outline::same_path(own, file)));
                    f.resolucion_lineas = v.lineas.clone();
                    f.delta = Some("resuelto".to_string());
                    // Fixed: whatever the PR proposed calling it no longer needs an answer.
                    f.hilo_pr.veredicto_pr = None;
                    resueltos += 1;
                }
                Some(v) => {
                    // Still there: it may have moved.
                    let same_file = match (&v.archivo, &p.archivo) {
                        (Some(a), Some(b)) => crate::review::outline::same_path(a, b),
                        _ => true,
                    };
                    if same_file && v.lineas.is_some() {
                        f.lineas = v.lineas.clone();
                    }
                    if p.is_active() {
                        persisten += 1;
                    }
                }
                // No verdict: conservative — it persists, thread untouched.
                None => {
                    if p.is_active() {
                        persisten += 1;
                    }
                }
            }
        }
        merged.push(f);
    }

    (merged, ReviewDelta { iter_previa: prev_iter, iter_actual, nuevos, persisten, resueltos })
}

/// The previous findings a reviewer must re-judge, as one prompt block — and the exact verdict
/// lines it must answer with ([`crate::review::merge::parse_prior_verdicts`] reads them back).
///
/// Handed to whoever reads the finding's file (the group that owns it, or the single reviewer),
/// because only that reader can tell whether the code still has the defect. Without a verdict a
/// finding persists — so the block asks for one per finding, explicitly, rather than relying on the
/// model to *not* repeat what was fixed (which is what used to be read as "resolved").
///
/// Returns `None` when there is nothing to re-judge.
pub fn reevaluate_block(findings: &[MemoryFinding]) -> Option<String> {
    let due: Vec<&MemoryFinding> = findings.iter().filter(|f| f.needs_judgement()).collect();
    if due.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nEstos hallazgos de iteraciones anteriores de este PR siguen abiertos (o fueron aceptados como \
         deuda técnica) y su código está en lo que revisas ahora. Re-evalúa CADA UNO sobre el código \
         actual y NO los vuelvas a reportar como hallazgo nuevo. Responde con UNA línea por hallazgo, \
         exactamente así (al final de tu respuesta, fuera de cualquier hallazgo):\n\
         PREVIO F-003: PERSISTE @ ruta/archivo.ts:42-50\n\
         PREVIO F-004: RESUELTO @ ruta/archivo.ts:60-64 — <qué lo corrige, 1–2 frases en español>\n\n\
         En PERSISTE, `@` lleva su ubicación actual (las líneas pueden haberse movido). En RESUELTO, `@` \
         lleva las líneas del código que lo corrige (con su archivo si la corrección está en otro). \
         Marca RESUELTO solo si el código actual demuestra que ya no ocurre; si dudas, es PERSISTE.\n\n",
    );
    for f in due {
        let loc = match (&f.archivo, &f.lineas) {
            (Some(file), Some(lines)) => format!("`{file}:{lines}`"),
            (Some(file), None) => format!("`{file}`"),
            _ => "sin ubicación".to_string(),
        };
        let deuda = if f.is_debt() { " · deuda técnica aceptada" } else { "" };
        let severidad = if f.severidad.is_empty() { f.severity.as_str() } else { f.severidad.as_str() };
        out.push_str(&format!(
            "- **{}** · {} · categoría `{}` · {}{} — {}\n",
            f.id, severidad, f.categoria, loc, deuda, f.subtitulo
        ));
        if let Some(why) = f.por_que_breve() {
            out.push_str(&format!("  - Por qué: {why}\n"));
        }
    }
    Some(out)
}

/// One item of a publish, as much of it as matching it to its stored finding needs.
#[derive(Debug, Clone, Copy)]
pub struct PublishKey<'a> {
    /// The finding's `F-NNN`, when the client sent it. The desktop always does; the phone predates it.
    pub id: Option<&'a str>,
    pub file: Option<&'a str>,
    pub category: &'a str,
    /// The lines the item's location names, for telling apart two same-category findings in a file.
    pub lines: Option<(u32, u32)>,
}

/// Which stored finding a published item is about — the one whose thread it opens, replies on or
/// closes. `claimed` marks the findings earlier items of the same publish already took, so no two
/// items ever write to one finding.
///
/// **By id first**, because the id is the finding's identity: it is what the report shows, what the
/// memory stores and what the comment's own heading says. Matching on file + category instead is how
/// the second of two same-category findings in one file used to be posted as a "sigue presente"
/// reply in the first one's thread, its own text never reaching the pull request.
///
/// The fallback — same [`finding_identity`], nearest by line, first unclaimed — is for an item that
/// names no id (the phone sends none) and for one whose id is already claimed in this publish, which
/// is what a report saved before ids were unique looks like: two findings under one `F-001`, the
/// second of which is really the memory's `F-002`.
pub fn match_publish_item(findings: &[MemoryFinding], item: &PublishKey, claimed: &[bool]) -> Option<usize> {
    let free = |k: usize| !claimed.get(k).copied().unwrap_or(false);
    if let Some(id) = item.id.map(str::trim).filter(|id| !id.is_empty()) {
        if let Some(k) = findings.iter().enumerate().position(|(k, f)| free(k) && f.id == id) {
            return Some(k);
        }
    }
    let key = finding_identity(item.file, item.category);
    findings
        .iter()
        .enumerate()
        .filter(|(k, f)| free(*k) && finding_identity(f.archivo.as_deref(), &f.categoria) == key)
        .min_by_key(|(k, f)| (span_distance(item.lines, line_span(f.lineas.as_deref())), *k))
        .map(|(k, _)| k)
}

/// A false positive the human has already ruled on, kept at the **repository** level instead of
/// inside one pull request's memory.
///
/// That scope is the whole point. A PR's memory only reaches its own pull request: mark a finding
/// `falso_positivo` there and the next PR touching the same code re-derives it from scratch, so the
/// same argument gets had again on every branch. These rules are read into *every* review of the
/// repository, which is what turns one judgement into a standing one.
///
/// Matching is deliberately coarse — a category, optionally narrowed to one file — because a rule
/// describes a *class* of finding rather than a line: the defect it denies drifts across lines and
/// re-appears in files the rule was never written against. It shares [`finding_identity`] with
/// reconciliation so a rule and a finding agree on what "the same thing" means.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FpSuppression {
    pub id: String,
    /// Which repository this rule belongs to (the `repo_key` — `github:host/owner/repo`, `gitlab:host/full/path` or
    /// `azure:org/project/repoId`). Every rule in a workspace lives in one list and is filtered by
    /// this, so two repositories in the same workspace never silence each other's findings.
    pub repo_key: String,
    pub categoria: String,
    /// The file the rule is scoped to, or `None` for "this category, anywhere in the repository".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archivo: Option<String>,
    /// Why it isn't a real defect here. Carried into the prompt rather than kept as a private note:
    /// a bare "don't report this" teaches the model nothing, while the reason lets it tell a
    /// genuinely different finding from the one that was already dismissed.
    pub motivo: String,
    /// The pull request the rule came from, so a rule that turns out to be wrong can be traced back
    /// to the review that produced it.
    #[serde(default)]
    pub pr_id: i64,
    pub created_at: String,
}

impl FpSuppression {
    /// True when `f` is what this rule denies: same category, and — for a file-scoped rule — the
    /// same file. Suffix-tolerant on the path for the same reason [`file_in_changed`] is.
    pub fn matches(&self, categoria: &str, archivo: Option<&str>) -> bool {
        if category_slug(&self.categoria) != category_slug(categoria) {
            return false;
        }
        match (&self.archivo, archivo) {
            (None, _) => true,
            (Some(rule_file), Some(f)) => crate::review::outline::same_path(rule_file.trim(), f.trim()),
            (Some(_), None) => false,
        }
    }
}

/// The repository's standing false positives, rendered as one review-prompt context.
///
/// Stated as rules with reasons rather than a blocklist: the model is asked to weigh whether what
/// it found is the same thing, and to say so when it believes a rule no longer holds. A rule that
/// can never be contradicted would quietly hide a real regression the day the code around it
/// changes — the reason is what lets the model tell those two cases apart.
///
/// Returns `None` when the repository has no rules, so a first review's prompt stays clean.
pub fn suppressions_block(rules: &[FpSuppression]) -> Option<String> {
    if rules.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nEn revisiones anteriores de ESTE repositorio, una persona revisora ya descartó los \
         siguientes patrones como falsos positivos. NO los vuelvas a reportar como hallazgo.\n\n\
         Si crees que en este diff el caso es REALMENTE distinto (el motivo del descarte ya no \
         aplica), puedes reportarlo, pero explica en 💭 Por qué en qué se diferencia del descarte \
         previo.\n\n",
    );
    for r in rules {
        let scope = match &r.archivo {
            Some(file) => format!("`{file}`"),
            None => "todo el repositorio".to_string(),
        };
        out.push_str(&format!("- Categoría `{}` en {} — {}\n", r.categoria, scope, r.motivo));
    }
    Some(out)
}

/// What this pull request already settled: the findings a human marked `falso_positivo` or
/// `ignorado` in an earlier iteration of the same PR.
///
/// Without this the model never learns of the ruling. Reconciliation re-applies the mark after the
/// fact, so a dismissed finding stays out of the active set — but it is re-derived, re-written and
/// re-paid for on every single run, and the reviewer looks like it isn't listening. Handing it back
/// with the reason closes that loop at the source.
///
/// Kept separate from the PR's open conversation ([`pending_comments_block`]'s job) because the two
/// ask opposite things of the model: one is "answer these", this one is "don't raise these".
///
/// Returns `None` when nothing has been discarded.
pub fn discarded_block(findings: &[MemoryFinding]) -> Option<String> {
    let discarded: Vec<&MemoryFinding> = findings
        .iter()
        .filter(|f| matches!(f.estado.as_str(), "falso_positivo" | "ignorado"))
        .collect();
    if discarded.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nEn iteraciones anteriores de este PR, una persona revisora descartó los siguientes \
         hallazgos. NO los vuelvas a reportar.\n\n",
    );
    for f in discarded {
        let etiqueta = if f.estado == "falso_positivo" { "falso positivo" } else { "ignorado" };
        let loc = match &f.archivo {
            Some(file) => format!(" · `{file}`"),
            None => String::new(),
        };
        let motivo = match &f.motivo_descarte {
            Some(m) if !m.trim().is_empty() => format!(" — {m}"),
            _ => String::new(),
        };
        out.push_str(&format!(
            "- **{}** · categoría `{}`{} · {}{}\n",
            f.id, f.categoria, loc, etiqueta, motivo
        ));
    }
    Some(out)
}

/// The cumulative "resolved / debt / discarded findings" traceability appended to a review's body —
/// every finding resolved, accepted as technical debt or human-discarded over the PR's life, with
/// the iteration it entered and (for resolved) left, and what fixed it. Returns `None` when there's
/// nothing to show, so first reviews stay clean.
///
/// Debt is its own section, between the two, because it is neither history nor a rejection: it is
/// still in the code, and the report keeps saying so until somebody pays it.
pub fn resolved_history_section(findings: &[MemoryFinding]) -> Option<String> {
    let resolved: Vec<&MemoryFinding> = findings.iter().filter(|f| f.estado == "resuelto").collect();
    let debt: Vec<&MemoryFinding> = findings.iter().filter(|f| f.is_debt()).collect();
    let discarded: Vec<&MemoryFinding> = findings
        .iter()
        .filter(|f| matches!(f.estado.as_str(), "falso_positivo" | "ignorado"))
        .collect();
    if resolved.is_empty() && debt.is_empty() && discarded.is_empty() {
        return None;
    }

    let mut s = String::from("\n\n---\n");
    if !debt.is_empty() {
        s.push_str("\n### 🧾 Deuda técnica\n\n");
        for f in debt {
            let loc = location_label(f);
            let severidad = if f.severidad.is_empty() { f.severity.as_str() } else { f.severidad.as_str() };
            s.push_str(&format!(
                "- **{}** · {} · `{}` · {} — {} _(introducido iter {})_\n",
                f.id, severidad, f.categoria, loc, f.subtitulo, f.introducido_en_iter
            ));
            if let Some(m) = f.motivo_descarte.as_deref().filter(|m| !m.trim().is_empty()) {
                s.push_str(&format!("  - Aceptada: {}\n", m.trim()));
            }
        }
    }
    if !resolved.is_empty() {
        s.push_str("\n### 🕘 Historial de hallazgos resueltos (trazabilidad)\n\n");
        for f in resolved {
            let file = f.archivo.clone().unwrap_or_else(|| "—".to_string());
            s.push_str(&format!(
                "- **{}** · `{}` · {} — introducido iter {} · resuelto iter {}\n",
                f.id,
                f.categoria,
                file,
                f.introducido_en_iter,
                f.resuelto_en_iter.unwrap_or(0),
            ));
            if let Some(r) = f.resolucion.as_deref().filter(|r| !r.trim().is_empty()) {
                s.push_str(&format!("  - 🛠️ {}\n", r.trim()));
            }
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

/// `file:lines`, `file`, or `—`.
fn location_label(f: &MemoryFinding) -> String {
    match (&f.archivo, &f.lineas) {
        (Some(file), Some(lines)) => format!("`{file}:{lines}`"),
        (Some(file), None) => format!("`{file}`"),
        _ => "—".to_string(),
    }
}

// ---------------------------------------------------------------------------
// The debt scan: accepted debt from other pull requests of the same repository
// ---------------------------------------------------------------------------

/// Debt accepted in **another** pull request of this repository, on a file this one touches —
/// carried into this review so it is seen, re-judged on the code this PR is changing anyway, and
/// settled in the run it came from when the reviewer finds it paid. Only files the PR already
/// touches: re-judging debt elsewhere would cost a download per file, and the scan is meant to be
/// free.
#[derive(Debug, Clone)]
pub struct ForeignDebt {
    /// What this review calls it (`D-001`…): its own id belongs to the other PR's numbering and
    /// would collide with this one's.
    pub alias: String,
    /// The run it lives in — the other PR's newest — and that PR.
    pub run_id: String,
    pub pr_id: i64,
    pub iter: usize,
    pub finding: MemoryFinding,
}

/// The accepted debt in `runs` (`(run id, pr, iter, findings JSON)`, newest run of each other PR)
/// whose file is one of `touched`.
pub fn foreign_debt(runs: &[(String, i64, i64, String)], touched: &[String]) -> Vec<ForeignDebt> {
    let mut out: Vec<ForeignDebt> = Vec::new();
    for (run_id, pr_id, iter, json) in runs {
        let findings: Vec<MemoryFinding> = serde_json::from_str(json).unwrap_or_default();
        for f in findings.into_iter().filter(|f| f.is_debt()) {
            let Some(file) = f.archivo.as_deref() else { continue };
            if !file_in_changed(file, touched) {
                continue;
            }
            out.push(ForeignDebt {
                alias: format!("D-{:03}", out.len() + 1),
                run_id: run_id.clone(),
                pr_id: *pr_id,
                iter: (*iter).max(1) as usize,
                finding: f,
            });
        }
    }
    out
}

impl ForeignDebt {
    /// The debt as this review's reviewer is handed it: under its alias, saying where it came from.
    pub fn for_review(&self) -> MemoryFinding {
        MemoryFinding {
            id: self.alias.clone(),
            subtitulo: format!("{} (deuda aceptada en el PR #{}, {})", self.finding.subtitulo, self.pr_id, self.finding.id),
            ..self.finding.clone()
        }
    }
}

/// Settles a debt the reviewer judged paid, in its own run's findings: `resuelto`, with what fixed
/// it and which pull request did. Returns whether anything changed.
pub fn settle_foreign_debt(findings: &mut [MemoryFinding], debt: &ForeignDebt, verdict: &PriorVerdict, by_pr: i64) -> bool {
    let Some(f) = findings.iter_mut().find(|f| f.id == debt.finding.id && f.is_debt()) else {
        return false;
    };
    let how = verdict.resolucion.clone().unwrap_or_else(|| "Corregido".to_string());
    if set_finding_state(f, "resuelto", Some(format!("Saldada en el PR #{by_pr}: {how}")), debt.iter).is_err() {
        return false;
    }
    f.resolucion_archivo = verdict.archivo.clone();
    f.resolucion_lineas = verdict.lineas.clone();
    true
}

/// "Deuda técnica de otros PRs" — what this review carried in and what became of it.
pub fn foreign_debt_section(debts: &[ForeignDebt], verdicts: &std::collections::HashMap<String, PriorVerdict>) -> Option<String> {
    if debts.is_empty() {
        return None;
    }
    let mut s = String::from("\n\n---\n\n### 🧾 Deuda técnica de otros PRs\n\n");
    for d in debts {
        let f = &d.finding;
        let severidad = if f.severidad.is_empty() { f.severity.as_str() } else { f.severidad.as_str() };
        s.push_str(&format!(
            "- **{}** (PR #{} · {}) · {} · `{}` · {} — {}\n",
            d.alias, d.pr_id, f.id, severidad, f.categoria, location_label(f), f.subtitulo
        ));
        match verdicts.get(&d.alias) {
            Some(v) if v.resolved => {
                s.push_str(&format!("  - ✔️ Saldada en este PR{}\n", v.resolucion.as_deref().map(|r| format!(": {r}")).unwrap_or_default()));
            }
            _ => {
                if let Some(m) = f.motivo_descarte.as_deref().filter(|m| !m.trim().is_empty()) {
                    s.push_str(&format!("  - Sigue presente · aceptada: {}\n", m.trim()));
                } else {
                    s.push_str("  - Sigue presente\n");
                }
            }
        }
    }
    Some(s)
}

// ---------------------------------------------------------------------------
// What a resolved thread is told
// ---------------------------------------------------------------------------

/// Lines `span` of `file` out of a diff — the unified diff a host's API returns
/// (`+++ b/<path>`) or the one a project run stores (`--- <path> (<status>)`) — from the new side:
/// added and context lines, never removed ones. `None` when the diff does not hold any of them.
///
/// What lets a review with no clone show the code that fixed a finding: the fix is, by definition,
/// something this pull request wrote, and so it is usually in the diff.
pub fn snippet_from_diff(diff: &str, file: &str, span: (u32, u32)) -> Option<String> {
    let mut in_file = false;
    let mut line_no: u32 = 0;
    let mut picked: Vec<(u32, &str)> = Vec::new();
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            let path = path.trim().trim_start_matches("b/");
            in_file = crate::review::outline::same_path(path, file);
            continue;
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            // A stored project diff names the file here (`--- src/a.ts (modified)`); a unified
            // diff's `--- a/…` is followed by its `+++` line, which decides.
            let path = rest.rsplit_once(" (").map(|(p, _)| p).unwrap_or(rest).trim().trim_start_matches("a/");
            in_file = crate::review::outline::same_path(path, file);
            continue;
        }
        if line.starts_with("diff --git ") {
            in_file = false;
            continue;
        }
        if let Some(header) = line.strip_prefix("@@") {
            // `@@ -12,7 +14,9 @@` → the new side starts at 14.
            line_no = header
                .split_whitespace()
                .find_map(|part| part.strip_prefix('+'))
                .and_then(|range| range.split(',').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            continue;
        }
        if !in_file || line_no == 0 {
            continue;
        }
        match line.chars().next() {
            Some('-') => {}
            Some('+') | Some(' ') => {
                if line_no >= span.0 && line_no <= span.1 {
                    picked.push((line_no, &line[1..]));
                }
                line_no += 1;
            }
            // `\ No newline at end of file`, or a blank context line some renderers strip the space of.
            None => line_no += 1,
            _ => {}
        }
    }
    (!picked.is_empty()).then(|| picked.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n"))
}

/// Lines `span` (1-based, inclusive) of a file's whole content.
pub fn snippet_from_content(content: &str, span: (u32, u32)) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let (start, end) = (span.0.max(1) as usize, (span.1 as usize).min(lines.len()));
    (start <= end).then(|| lines[start - 1..end].join("\n"))
}

/// The repository a saved run reviewed, from its `meta` — empty when the run predates the key.
pub fn run_repo_key(meta: &str) -> String {
    serde_json::from_str::<serde_json::Value>(meta)
        .ok()
        .and_then(|m| m.get("repo_key").and_then(serde_json::Value::as_str).map(str::to_lowercase))
        .unwrap_or_default()
}

/// The longest snippet a resolved thread is shown — enough for a guard or a call, not a file.
const MAX_SNIPPET_LINES: u32 = 15;

/// The span of a finding's fix, capped to what a comment can show.
pub fn resolution_span(f: &MemoryFinding) -> Option<(u32, u32)> {
    let (start, end) = line_span(f.resolucion_lineas.as_deref())?;
    Some((start, end.min(start + MAX_SNIPPET_LINES - 1)))
}

/// The file a finding's fix lives in: its own unless the verdict named another.
pub fn resolution_file(f: &MemoryFinding) -> Option<&str> {
    f.resolucion_archivo.as_deref().or(f.archivo.as_deref())
}

/// What a resolved finding's thread gets under the "resuelto en la iteración N" line: what fixed it,
/// and — when the lines are known and the code could be read — the code itself. Empty for a finding
/// nobody explained, which then reads exactly as it did before verdicts existed.
pub fn resolution_note(f: &MemoryFinding, code: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(r) = f.resolucion.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        out.push_str(&format!("\n\n🛠️ **Resolución:** {r}"));
    }
    if let (Some(code), Some(file), Some((start, end))) = (code.filter(|c| !c.trim().is_empty()), resolution_file(f), resolution_span(f)) {
        let lines = if end > start { format!("{start}-{end}") } else { start.to_string() };
        let lang = file.rsplit_once('.').map(|(_, ext)| ext).filter(|ext| ext.len() <= 6).unwrap_or("");
        out.push_str(&format!("\n\n📄 **Código que lo resuelve** (`{file}:{lines}`):\n```{lang}\n{code}\n```"));
    }
    out
}

// ---------------------------------------------------------------------------
// Moving memory between installs
// ---------------------------------------------------------------------------
//
// Export writes one folder per run — `review.md`, `meta.json`, `diff.patch`, `findings.json` — and
// import reads the same shape back. The parts below are the decisions that shape has to encode:
// what identifies a run once it is outside the database, and which local project a run coming from
// somewhere else belongs to.

/// The `review_runs` columns that aren't inside `meta`, written beside a run on export as
/// `run.json`.
///
/// Without it a folder is content with no identity: the row's id lives only in the database, and
/// an import would have to invent one — which is how re-importing the same folder ends up creating
/// a second copy of a review that was already there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunIdentity {
    pub id: String,
    pub project_id: String,
    pub workspace_id: String,
    pub pr_id: i64,
    pub iter: i64,
    pub level: String,
    pub created_at: String,
    /// Repeated from `meta.repo_key` so routing an import needs only this file, and so a folder
    /// assembled by hand has one obvious place to say which repository it belongs to.
    #[serde(default)]
    pub repo_key: String,
}

/// A run id for a folder that has no `run.json` — one exported before identities were written
/// beside them, or hand-assembled.
///
/// Derived from what makes the run unique rather than generated fresh, because the insert is
/// `ON CONFLICT DO NOTHING`: a uuid would defeat that and make every re-import of the same folder
/// look like a run the database had never seen.
pub fn derived_run_id(repo_key: &str, pr_id: i64, iter: i64, created_at: &str) -> String {
    let digest = Sha256::digest(format!("{repo_key}|{pr_id}|{iter}|{created_at}").as_bytes());
    format!("imported-{:x}", digest).chars().take(33).collect()
}

/// A project on *this* machine, as much of it as routing an import needs.
#[derive(Debug, Clone)]
pub struct LocalProject {
    pub id: String,
    /// `None` when the project isn't linked to a pull-request host, and so cannot be the
    /// destination for any repository's memory.
    pub repo_key: Option<String>,
}

/// Which local project an imported run belongs to, or `None` when nothing here is that repository.
///
/// **By repository, never by the id the export carries.** That id names a row in another install's
/// database; the row it happens to name here may point at entirely different code, and handing it
/// the findings would be the exact confusion `MEMORY_SCOPE` in `db::queries` exists to prevent.
///
/// The id fallback applies only to runs recorded before repository keys were tracked, where the
/// project genuinely *was* the repository — and only when that id exists here. A run that names a
/// repository this workspace doesn't have is reported back rather than placed somewhere plausible:
/// the fix is to link the repository and import again, which the user can only do if they are told.
pub fn resolve_project<'a>(run: &RunIdentity, local: &'a [LocalProject]) -> Option<&'a LocalProject> {
    let wanted = run.repo_key.trim().to_lowercase();
    if !wanted.is_empty() {
        return local.iter().find(|p| {
            p.repo_key.as_deref().is_some_and(|k| k.trim().to_lowercase() == wanted)
        });
    }
    local.iter().find(|p| p.id == run.project_id)
}

/// Adds the rules an import brought in to the ones already here, returning the merged list and how
/// many were actually new.
///
/// Deduplicated by what a rule *means* — repository, category, scope — rather than by its id: ids
/// are minted per install, so two machines that independently dismissed the same finding hold the
/// same rule under different ids, and id-matching would file it twice. The existing reason is kept
/// on a collision, because it is the one the person using this machine wrote.
pub fn merge_suppressions(
    existing: &[FpSuppression],
    incoming: &[FpSuppression],
) -> (Vec<FpSuppression>, usize) {
    let key = |r: &FpSuppression| {
        let file = r.archivo.as_deref().unwrap_or_default().trim_start_matches('/').to_lowercase();
        format!("{}|{}|{}", r.repo_key.to_lowercase(), r.categoria.to_lowercase(), file)
    };
    let mut merged = existing.to_vec();
    let mut seen: Vec<String> = merged.iter().map(key).collect();
    let mut added = 0;
    for rule in incoming {
        let k = key(rule);
        if seen.contains(&k) {
            continue;
        }
        seen.push(k);
        merged.push(rule.clone());
        added += 1;
    }
    (merged, added)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(categoria: &str, archivo: Option<&str>) -> FpSuppression {
        FpSuppression {
            id: "r1".into(),
            repo_key: "github:github.com/acme/app".into(),
            categoria: categoria.into(),
            archivo: archivo.map(str::to_string),
            motivo: "el padre remonta por key={id}".into(),
            pr_id: 42,
            created_at: "2026-07-31T00:00:00Z".into(),
        }
    }

    /// A review's cost is every pass summed; a price only when an engine gave one, and the passes
    /// that said nothing counted apart rather than as free.
    #[test]
    fn a_review_cost_sums_its_passes_and_never_invents_a_price() {
        let usage = |input: i64, output: i64, cost: Option<f64>| crate::ai::AiUsage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: cost,
        };
        let mut cost = RunCost::default();
        cost.add(Some(&usage(40_000, 1_500, None)));
        assert_eq!(cost.cost_usd, None, "no engine said a price yet");
        cost.add(Some(&usage(12_000, 800, Some(0.05))));
        cost.add(Some(&usage(3_000, 200, Some(0.01))));
        cost.add(None);
        assert_eq!((cost.passes, cost.input_tokens, cost.output_tokens, cost.unreported), (4, 55_000, 2_500, 1));
        assert!((cost.cost_usd.unwrap() - 0.06).abs() < 1e-9);
        assert_eq!(cost.line(), "4 pasada(s) · 55k tokens de entrada · 2500 de salida · ≈ US$0.06 · 1 sin informar");
    }

    fn finding(id: &str, estado: &str, categoria: &str) -> MemoryFinding {
        MemoryFinding {
            id: id.into(),
            severity: "critical".into(),
            severidad: String::new(),
            tipo: "BUG".into(),
            categoria: categoria.into(),
            subtitulo: "algo".into(),
            archivo: Some("src/app/Seguimiento.tsx".into()),
            lineas: Some("50".into()),
            confianza: Some(60),
            estado: estado.into(),
            thread_id: None,
            introducido_en_iter: 1,
            resuelto_en_iter: None,
            motivo_descarte: Some("no aplica aquí".into()),
            delta: None,
            comentario_md: String::new(),
            publicado_en_iter: None,
            hilo_general: false,
            resolucion: None,
            resolucion_archivo: None,
            resolucion_lineas: None,
            tardio: false,
            hilo_pr: HiloPr::default(),
        }
    }

    /// A finding as a fresh review reports it: no memory of its own yet.
    fn reported(categoria: &str, archivo: &str, lineas: &str) -> MemoryFinding {
        MemoryFinding {
            estado: "abierto".into(),
            archivo: Some(archivo.into()),
            lineas: Some(lineas.into()),
            motivo_descarte: None,
            introducido_en_iter: 0,
            ..finding("", "abierto", categoria)
        }
    }

    /// A finding as a previous run left it in the memory.
    fn remembered(id: &str, estado: &str, categoria: &str, archivo: &str, lineas: &str, thread: Option<i64>) -> MemoryFinding {
        MemoryFinding {
            thread_id: thread,
            archivo: Some(archivo.into()),
            lineas: Some(lineas.into()),
            motivo_descarte: None,
            ..finding(id, estado, categoria)
        }
    }

    fn ids(findings: &[MemoryFinding]) -> Vec<&str> {
        findings.iter().map(|f| f.id.as_str()).collect()
    }

    #[test]
    fn a_first_reappearance_keeps_its_id_thread_and_iteration() {
        let prev = vec![remembered("F-001", "posteado", "npe", "src/a.ts", "40-45", Some(77))];
        let current = vec![reported("npe", "src/a.ts", "42-47")];
        let (merged, delta) = reconcile(&prev, &current, 1, None);
        assert_eq!(ids(&merged), vec!["F-001"]);
        assert_eq!(merged[0].thread_id, Some(77));
        assert_eq!(merged[0].estado, "posteado");
        assert_eq!(merged[0].introducido_en_iter, 1);
        assert_eq!(merged[0].delta.as_deref(), Some("persiste"));
        assert_eq!((delta.nuevos, delta.persisten, delta.resueltos), (0, 1, 0));
    }

    /// The collision this matching exists for: two defects of one category in one file. Each keeps
    /// its own id and its own thread, and neither swallows the other.
    #[test]
    fn two_same_category_findings_in_one_file_keep_their_own_ids() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "src/a.ts", "10", Some(1)),
            remembered("F-002", "posteado", "npe", "src/a.ts", "480-482", Some(2)),
        ];
        // Reported in the other order, and both shifted by an insertion above them.
        let current = vec![reported("npe", "src/a.ts", "495-497"), reported("npe", "src/a.ts", "25")];
        let (merged, delta) = reconcile(&prev, &current, 1, None);
        assert_eq!(merged.len(), 2, "nothing carried forward: both continued");
        assert_eq!((merged[0].id.as_str(), merged[0].thread_id), ("F-002", Some(2)));
        assert_eq!((merged[1].id.as_str(), merged[1].thread_id), ("F-001", Some(1)));
        assert_eq!((delta.nuevos, delta.persisten, delta.resueltos), (0, 2, 0));
    }

    /// Settled by nearness across all pairs, not in reading order: the first current finding must not
    /// take the earlier finding that sits right beside the second.
    #[test]
    fn pairs_are_settled_closest_first() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "a.ts", "50", Some(1)),
            remembered("F-002", "posteado", "npe", "a.ts", "500", Some(2)),
        ];
        let current = vec![reported("npe", "a.ts", "300"), reported("npe", "a.ts", "495")];
        let (merged, _) = reconcile(&prev, &current, 1, None);
        assert_eq!(ids(&merged), vec!["F-001", "F-002"]);
    }

    fn resolved_verdict(resolucion: &str) -> PriorVerdict {
        PriorVerdict { resolved: true, archivo: None, lineas: Some("12-14".into()), resolucion: Some(resolucion.into()) }
    }

    fn verdicts(pairs: &[(&str, PriorVerdict)]) -> std::collections::HashMap<String, PriorVerdict> {
        pairs.iter().map(|(id, v)| (id.to_string(), v.clone())).collect()
    }

    /// One of two same-category findings judged fixed: the other persists and the fixed one is
    /// resolved with its thread kept for the "resuelto" reply — it used to vanish from the memory.
    #[test]
    fn the_one_that_is_gone_is_resolved_not_lost() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1)),
            remembered("F-002", "posteado", "npe", "a.ts", "480", Some(2)),
        ];
        let current = vec![reported("npe", "a.ts", "478-481")];
        let v = verdicts(&[("F-001", resolved_verdict("Se agregó la guarda."))]);
        let (merged, delta) = reconcile_with(&prev, &current, 2, Rereview { verdicts: Some(&v), ..Default::default() });
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "F-002");
        let gone = &merged[1];
        assert_eq!((gone.id.as_str(), gone.estado.as_str(), gone.thread_id), ("F-001", "resuelto", Some(1)));
        assert_eq!(gone.resuelto_en_iter, Some(3));
        assert_eq!((delta.nuevos, delta.persisten, delta.resueltos), (0, 1, 1));
    }

    #[test]
    fn a_new_finding_gets_the_next_free_id() {
        let prev = vec![remembered("F-004", "posteado", "npe", "a.ts", "10", Some(1))];
        let current = vec![reported("npe", "a.ts", "10"), reported("sql-injection", "db.ts", "3")];
        let (merged, delta) = reconcile(&prev, &current, 1, None);
        assert_eq!(ids(&merged), vec!["F-004", "F-005"]);
        assert_eq!(merged[1].introducido_en_iter, 2);
        assert_eq!(merged[1].delta.as_deref(), Some("nuevo"));
        assert_eq!(delta.nuevos, 1);
    }

    /// Reappearing after being fixed is a new finding; the fixed one stays in the history as it was.
    #[test]
    fn a_resolved_finding_that_comes_back_is_new_and_the_history_stays() {
        let prev = vec![MemoryFinding {
            resuelto_en_iter: Some(2),
            ..remembered("F-001", "resuelto", "npe", "a.ts", "10", Some(9))
        }];
        let current = vec![reported("npe", "a.ts", "10")];
        let (merged, delta) = reconcile(&prev, &current, 2, None);
        assert_eq!(ids(&merged), vec!["F-002", "F-001"]);
        assert_eq!(merged[0].thread_id, None, "a new finding opens its own thread");
        assert_eq!(merged[1].estado, "resuelto");
        assert_eq!(delta.nuevos, 1);
    }

    /// A human ruling survives the next run: a discarded finding the model reports again keeps its
    /// mark and its reason, and does not count as open.
    #[test]
    fn a_discarded_finding_keeps_its_ruling() {
        let prev = vec![MemoryFinding {
            motivo_descarte: Some("es intencional".into()),
            ..remembered("F-003", "falso_positivo", "npe", "a.ts", "10", None)
        }];
        let (merged, delta) = reconcile(&prev, &[reported("npe", "a.ts", "11")], 1, None);
        assert_eq!(merged[0].id, "F-003");
        assert_eq!(merged[0].estado, "falso_positivo");
        assert_eq!(merged[0].motivo_descarte.as_deref(), Some("es intencional"));
        assert_eq!(delta.persisten, 0);
    }

    /// An efficient re-review only re-reads changed files: a finding on a file nobody touched cannot
    /// have been fixed, whatever this run said about it.
    #[test]
    fn a_finding_on_an_untouched_file_persists_on_a_delta_review() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "src/untouched.ts", "10", Some(1)),
            remembered("F-002", "posteado", "npe", "src/changed.ts", "10", Some(2)),
        ];
        let changed = vec!["src/changed.ts".to_string()];
        // Both judged fixed — but only the one whose file was re-read can be.
        let v = verdicts(&[("F-001", resolved_verdict("x")), ("F-002", resolved_verdict("y"))]);
        let (merged, delta) =
            reconcile_with(&prev, &[], 1, Rereview { changed_files: Some(&changed), verdicts: Some(&v), ..Default::default() });
        assert_eq!(merged[0].estado, "posteado");
        assert_eq!(merged[1].estado, "resuelto");
        assert_eq!((delta.persisten, delta.resueltos), (1, 1));
    }

    /// The result is positional — `merged[i]` is `current[i]` — which is what lets the caller carry
    /// ids back onto the full findings when two of them share a file and a category.
    #[test]
    fn the_merged_set_starts_with_the_current_findings_in_order() {
        let prev = vec![remembered("F-001", "posteado", "b", "b.ts", "1", Some(1))];
        let current = vec![reported("a", "a.ts", "1"), reported("b", "b.ts", "1"), reported("a", "a.ts", "90")];
        let (merged, _) = reconcile(&prev, &current, 1, None);
        for (i, cur) in current.iter().enumerate() {
            assert_eq!(merged[i].categoria, cur.categoria);
            assert_eq!(merged[i].lineas, cur.lineas);
        }
        let unique: std::collections::HashSet<&str> = merged.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(unique.len(), merged.len(), "no two findings share an id");
    }

    /// Runs saved before the matching was one to one can hold one id twice. The first holder keeps it;
    /// the other is renumbered rather than left sharing it forever.
    #[test]
    fn duplicate_ids_left_by_older_runs_are_repaired() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1)),
            remembered("F-001", "posteado", "npe", "a.ts", "480", Some(2)),
        ];
        let current = vec![reported("npe", "a.ts", "10"), reported("npe", "a.ts", "480")];
        let (merged, _) = reconcile(&prev, &current, 1, None);
        assert_eq!(ids(&merged), vec!["F-001", "F-002"]);
        assert_eq!(merged[1].thread_id, Some(2), "renumbered, thread and all");
    }

    /// What was published in an earlier iteration may be published again in this one.
    #[test]
    fn publish_marks_travel_with_the_finding() {
        let prev = vec![MemoryFinding {
            publicado_en_iter: Some(1),
            hilo_general: true,
            ..remembered("F-001", "posteado", "npe", "a.ts", "10", Some(5))
        }];
        let (merged, _) = reconcile(&prev, &[reported("npe", "a.ts", "10")], 1, None);
        assert_eq!(merged[0].publicado_en_iter, Some(1));
        assert!(merged[0].hilo_general);
    }

    #[test]
    fn line_spans_read_every_shape_the_model_writes() {
        assert_eq!(line_span(Some("42")), Some((42, 42)));
        assert_eq!(line_span(Some("42-50")), Some((42, 50)));
        assert_eq!(line_span(Some("L42–L50, 80")), Some((42, 80)));
        assert_eq!(line_span(Some("—")), None);
        assert_eq!(line_span(None), None);
    }

    fn key<'a>(id: Option<&'a str>, file: Option<&'a str>, category: &'a str, lines: Option<(u32, u32)>) -> PublishKey<'a> {
        PublishKey { id, file, category, lines }
    }

    /// The publish bug: both items used to land on the first finding of the pair.
    #[test]
    fn a_publish_item_is_matched_by_its_id() {
        let findings = vec![
            remembered("F-001", "abierto", "npe", "a.ts", "10", None),
            remembered("F-002", "abierto", "npe", "a.ts", "480", None),
        ];
        let none = vec![false; 2];
        assert_eq!(match_publish_item(&findings, &key(Some("F-002"), Some("a.ts"), "npe", Some((480, 480))), &none), Some(1));
        // The id wins even when the location didn't parse into a file — which used to match nothing
        // and open a fresh thread on every publish.
        assert_eq!(match_publish_item(&findings, &key(Some("F-001"), None, "npe", None), &none), Some(0));
    }

    /// No id on the wire (the phone): file + category, nearest by line, and never twice.
    #[test]
    fn an_item_without_an_id_falls_back_to_file_category_and_line() {
        let findings = vec![
            remembered("F-001", "abierto", "npe", "a.ts", "10", None),
            remembered("F-002", "abierto", "npe", "a.ts", "480", None),
        ];
        let mut claimed = vec![false; 2];
        let far = key(None, Some("a.ts"), "npe", Some((480, 481)));
        assert_eq!(match_publish_item(&findings, &far, &claimed), Some(1));
        claimed[1] = true;
        assert_eq!(match_publish_item(&findings, &far, &claimed), Some(0), "the claimed one is skipped");
        claimed[0] = true;
        assert_eq!(match_publish_item(&findings, &far, &claimed), None);
        assert_eq!(match_publish_item(&findings, &key(None, Some("b.ts"), "npe", None), &[false, false]), None);
    }

    /// A report saved before ids were unique shows one id twice. The second item, finding that id
    /// taken, lands on the other finding of its kind instead of on the first one's thread.
    #[test]
    fn a_duplicate_id_in_an_old_report_falls_through_to_the_other_finding() {
        let findings = vec![
            remembered("F-001", "abierto", "npe", "a.ts", "10", None),
            remembered("F-002", "abierto", "npe", "a.ts", "480", None),
        ];
        let claimed = vec![true, false];
        let second = key(Some("F-001"), Some("a.ts"), "npe", Some((480, 480)));
        assert_eq!(match_publish_item(&findings, &second, &claimed), Some(1));
    }

    #[test]
    fn matches_is_case_insensitive_on_category() {
        assert!(rule("Stale-Ref", None).matches("stale-ref", Some("a.ts")));
    }

    #[test]
    fn a_different_category_never_matches() {
        assert!(!rule("stale-ref", None).matches("n-plus-one", Some("a.ts")));
    }

    /// The dangerous direction: a rule written for one file must not silence the same category
    /// somewhere else in the repository.
    #[test]
    fn file_scoped_rule_does_not_match_another_file() {
        let r = rule("stale-ref", Some("src/app/Seguimiento.tsx"));
        assert!(!r.matches("stale-ref", Some("src/app/Otro.tsx")));
    }

    #[test]
    fn file_scoped_rule_tolerates_path_prefix_differences() {
        let r = rule("stale-ref", Some("src/app/Seguimiento.tsx"));
        assert!(r.matches("stale-ref", Some("/src/app/Seguimiento.tsx")));
        assert!(r.matches("stale-ref", Some("app/Seguimiento.tsx")));
    }

    #[test]
    fn repo_wide_rule_matches_any_file_including_none() {
        let r = rule("stale-ref", None);
        assert!(r.matches("stale-ref", Some("anything.ts")));
        assert!(r.matches("stale-ref", None));
    }

    /// A rule about a specific file can't be applied to a finding that reported no location —
    /// there is nothing to compare, and guessing would silence the wrong thing.
    #[test]
    fn file_scoped_rule_does_not_match_a_locationless_finding() {
        assert!(!rule("stale-ref", Some("a.ts")).matches("stale-ref", None));
    }

    #[test]
    fn blocks_are_absent_when_there_is_nothing_to_say() {
        assert!(suppressions_block(&[]).is_none());
        assert!(discarded_block(&[]).is_none());
        // Open and resolved findings are not rejections — they belong to other sections.
        let live = vec![finding("F-001", "abierto", "stale-ref"), finding("F-002", "resuelto", "n-plus-one")];
        assert!(discarded_block(&live).is_none());
    }

    #[test]
    fn discarded_block_lists_rejections_with_their_reason() {
        let findings = vec![
            finding("F-001", "falso_positivo", "stale-ref"),
            finding("F-002", "abierto", "n-plus-one"),
            finding("F-003", "ignorado", "naming"),
        ];
        let block = discarded_block(&findings).expect("rejections produce a block");
        assert!(block.contains("F-001"));
        assert!(block.contains("falso positivo"));
        assert!(block.contains("no aplica aquí"));
        assert!(block.contains("F-003"));
        assert!(block.contains("ignorado"));
        // The one still open must not be told to the model as already settled.
        assert!(!block.contains("F-002"));
    }

    // ---------------------------------------------------------------------
    // Moving memory between installs
    // ---------------------------------------------------------------------

    fn identity(repo_key: &str, project_id: &str) -> RunIdentity {
        RunIdentity {
            id: "job-1".into(),
            project_id: project_id.into(),
            workspace_id: "ws-source".into(),
            pr_id: 42,
            iter: 3,
            level: "deep".into(),
            created_at: "2026-08-01T10:00:00Z".into(),
            repo_key: repo_key.into(),
        }
    }

    fn local(id: &str, repo_key: Option<&str>) -> LocalProject {
        LocalProject { id: id.into(), repo_key: repo_key.map(str::to_string) }
    }

    #[test]
    fn a_run_is_routed_to_the_project_that_is_its_repository() {
        let here = vec![
            local("p-other", Some("github:github.com/acme/other")),
            local("p-app", Some("github:github.com/acme/app")),
        ];
        let run = identity("github:github.com/acme/app", "p-from-the-other-machine");
        assert_eq!(resolve_project(&run, &here).map(|p| p.id.as_str()), Some("p-app"));
    }

    /// The dangerous case, and the reason routing ignores the exported project id: two installs
    /// mint their own ids, so the id a run carries can name a *different* repository here. Placing
    /// the run there would hand one repository another's findings.
    #[test]
    fn a_matching_project_id_never_overrides_the_repository() {
        let here = vec![local("p-shared-id", Some("github:github.com/acme/completely-different"))];
        let run = identity("github:github.com/acme/app", "p-shared-id");
        assert!(resolve_project(&run, &here).is_none());
    }

    /// A repository this workspace doesn't have must come back as unresolved rather than land
    /// somewhere plausible — that is what lets the UI name it and say "link it and import again".
    #[test]
    fn an_unknown_repository_resolves_to_nothing() {
        let here = vec![local("p-app", Some("github:github.com/acme/app"))];
        assert!(resolve_project(&identity("gitlab:gitlab.com/acme/app", "p-app"), &here).is_none());
        // An unlinked project is not a candidate for anyone's memory.
        assert!(resolve_project(&identity("github:github.com/acme/app", "x"), &[local("p", None)]).is_none());
    }

    /// Runs recorded before repository keys existed carry an empty one, and back then the project
    /// *was* the repository — the same reading `MEMORY_SCOPE` gives them.
    #[test]
    fn a_legacy_run_without_a_repository_falls_back_to_its_project_id() {
        let here = vec![local("p-app", Some("github:github.com/acme/app")), local("p-legacy", None)];
        assert_eq!(
            resolve_project(&identity("", "p-legacy"), &here).map(|p| p.id.as_str()),
            Some("p-legacy")
        );
        assert!(resolve_project(&identity("", "p-gone"), &here).is_none());
    }

    #[test]
    fn repository_keys_are_matched_regardless_of_case() {
        let here = vec![local("p-app", Some("github:github.com/acme/app"))];
        let run = identity("GitHub:GitHub.com/Acme/App", "x");
        assert_eq!(resolve_project(&run, &here).map(|p| p.id.as_str()), Some("p-app"));
    }

    /// Re-importing the same folder must be a no-op, which only works if the id it is given is a
    /// function of the run rather than freshly generated.
    #[test]
    fn a_derived_id_is_stable_for_the_same_run_and_different_for_another() {
        let a = derived_run_id("github:github.com/acme/app", 42, 3, "2026-08-01T10:00:00Z");
        assert_eq!(a, derived_run_id("github:github.com/acme/app", 42, 3, "2026-08-01T10:00:00Z"));
        assert_ne!(a, derived_run_id("github:github.com/acme/app", 42, 4, "2026-08-01T10:00:00Z"));
        assert_ne!(a, derived_run_id("github:github.com/acme/other", 42, 3, "2026-08-01T10:00:00Z"));
        assert!(a.starts_with("imported-"));
    }

    /// Two installs that each dismissed the same finding hold the same rule under different ids.
    /// Merging by id would file it twice; merging by meaning keeps one, and keeps the reason the
    /// person on this machine wrote.
    #[test]
    fn merging_rules_dedupes_by_meaning_not_by_id() {
        let mine = FpSuppression { id: "mine".into(), motivo: "el mío".into(), ..rule("stale-ref", Some("a.ts")) };
        let theirs = FpSuppression { id: "theirs".into(), motivo: "el suyo".into(), ..rule("stale-ref", Some("/a.ts")) };
        let fresh = rule("n-plus-one", None);

        let (merged, added) = merge_suppressions(&[mine], &[theirs, fresh]);
        assert_eq!(added, 1, "only the genuinely new rule counts");
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].motivo, "el mío", "the local reason survives the collision");
        assert!(merged.iter().any(|r| r.categoria == "n-plus-one"));
    }

    /// Same category, same file, *different repository* — two rules, not one.
    #[test]
    fn merging_rules_keeps_repositories_apart() {
        let here = rule("stale-ref", Some("a.ts"));
        let elsewhere = FpSuppression { repo_key: "github:github.com/acme/other".into(), ..rule("stale-ref", Some("a.ts")) };
        let (merged, added) = merge_suppressions(&[here], &[elsewhere]);
        assert_eq!(added, 1);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn suppressions_block_carries_scope_and_reason() {
        let rules = vec![rule("stale-ref", Some("src/app/Seguimiento.tsx")), rule("n-plus-one", None)];
        let block = suppressions_block(&rules).expect("rules produce a block");
        assert!(block.contains("src/app/Seguimiento.tsx"));
        assert!(block.contains("todo el repositorio"));
        assert!(block.contains("el padre remonta por key={id}"));
    }

    #[test]
    fn categories_compare_by_their_slug() {
        assert_eq!(category_slug("Null Dereference"), "null-dereference");
        assert_eq!(category_slug("NULL_DEREFERENCE"), "null-dereference");
        assert_eq!(category_slug(" validación-faltante "), "validacion-faltante");
        assert_eq!(finding_identity(Some("/src/a.ts"), "Null dereference"), finding_identity(Some("src/a.ts"), "null-dereference"));
    }

    /// The same defect, re-reported with its category spelled differently, keeps its id and thread
    /// instead of reading as one new finding plus one fixed.
    #[test]
    fn a_reworded_category_still_continues_its_finding() {
        let prev = vec![MemoryFinding {
            subtitulo: "Se lee cuenta.saldo sin verificar que la cuenta exista".into(),
            ..remembered("F-004", "posteado", "null-dereference", "src/a.ts", "40-45", Some(77))
        }];
        let current = vec![MemoryFinding {
            subtitulo: "Acceso a cuenta.saldo sin comprobar si la cuenta existe".into(),
            ..reported("acceso-nulo-a-cuenta", "src/a.ts", "41-45")
        }];
        let (merged, delta) = reconcile(&prev, &current, 1, None);
        assert_eq!(merged[0].id, "F-004");
        assert_eq!(merged[0].thread_id, Some(77));
        assert_eq!((delta.nuevos, delta.resueltos), (0, 0));
    }

    /// …but a different defect a few lines away is not taken for it.
    #[test]
    fn a_different_defect_nearby_is_not_paired_by_proximity() {
        let prev = vec![MemoryFinding {
            subtitulo: "Se lee cuenta.saldo sin verificar que la cuenta exista".into(),
            ..remembered("F-004", "posteado", "null-dereference", "src/a.ts", "40-45", Some(77))
        }];
        let current = vec![MemoryFinding {
            subtitulo: "El bucle recorre una posición de más al final del arreglo".into(),
            ..reported("off-by-one", "src/a.ts", "44")
        }];
        let (merged, delta) = reconcile(&prev, &current, 1, None);
        assert_ne!(merged[0].id, "F-004");
        // The earlier one is not continued, and nobody judged it fixed: it persists.
        assert_eq!((delta.nuevos, delta.resueltos), (1, 0));
        assert_eq!(merged[1].estado, "posteado");
    }

    /// A reviewer that failed is not evidence of a fix: its files' findings persist.
    #[test]
    fn findings_on_files_nobody_reread_persist_instead_of_resolving() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "src/a.ts", "40", Some(7)),
            remembered("F-002", "posteado", "sqli", "src/b.ts", "10", Some(8)),
            MemoryFinding { archivo: None, lineas: None, ..remembered("F-003", "abierto", "breaking-change", "x", "1", None) },
        ];
        let unread_files = vec!["src/a.ts".to_string()];
        let v = verdicts(&[("F-001", resolved_verdict("x")), ("F-002", resolved_verdict("y")), ("F-003", resolved_verdict("z"))]);
        let (merged, delta) = reconcile_with(
            &prev,
            &[],
            1,
            Rereview { unread: Unread { files: &unread_files, unlocated: true }, verdicts: Some(&v), ..Default::default() },
        );
        let state = |id: &str| merged.iter().find(|f| f.id == id).map(|f| f.estado.clone()).unwrap();
        assert_eq!(state("F-001"), "posteado", "its reviewer failed");
        assert_eq!(state("F-002"), "resuelto", "its file was re-read and it is gone");
        assert_eq!(state("F-003"), "abierto", "no file, and the run cannot vouch for it");
        assert_eq!(delta.resueltos, 1);
    }

    #[test]
    fn a_rule_matches_its_category_however_it_is_spelled_and_only_its_own_file() {
        let r = rule("Null dereference", Some("app/Seguimiento.tsx"));
        assert!(r.matches("null-dereference", Some("src/app/Seguimiento.tsx")));
        assert!(!r.matches("null-dereference", Some("src/myapp/Seguimiento.tsx")), "a path boundary, not a raw suffix");
    }

    // ---------------------------------------------------------------------
    // Judged resolution, debt and late findings
    // ---------------------------------------------------------------------

    /// The conservative default: re-read, not re-reported, but nobody said it was fixed — it
    /// persists, and its thread is not closed as fixed.
    #[test]
    fn a_finding_nobody_judged_persists_even_when_its_file_was_reread() {
        let prev = vec![remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1))];
        let changed = vec!["a.ts".to_string()];
        let (merged, delta) = reconcile(&prev, &[], 1, Some(&changed));
        assert_eq!(merged[0].estado, "posteado");
        assert_eq!(merged[0].resuelto_en_iter, None);
        assert_eq!((delta.persisten, delta.resueltos), (1, 0));
    }

    /// A judged fix carries what fixed it and where; the fix's file is kept only when it is not the
    /// finding's own.
    #[test]
    fn a_resolved_verdict_records_the_resolution_and_where_the_fix_is() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "src/a.ts", "10", Some(1)),
            remembered("F-002", "abierto", "sqli", "src/b.ts", "5", None),
        ];
        let v = verdicts(&[
            ("F-001", PriorVerdict { archivo: Some("src/a.ts".into()), ..resolved_verdict("Guarda temprana.") }),
            ("F-002", PriorVerdict { archivo: Some("src/db.ts".into()), ..resolved_verdict("Consulta parametrizada.") }),
        ]);
        let (merged, delta) = reconcile_with(&prev, &[], 3, Rereview { verdicts: Some(&v), ..Default::default() });
        assert_eq!(delta.resueltos, 2);
        assert_eq!(merged[0].estado, "resuelto");
        assert_eq!(merged[0].resuelto_en_iter, Some(4));
        assert_eq!(merged[0].resolucion.as_deref(), Some("Guarda temprana."));
        assert_eq!(merged[0].resolucion_archivo, None, "same file: nothing to add");
        assert_eq!(merged[0].resolucion_lineas.as_deref(), Some("12-14"));
        assert_eq!(merged[1].resolucion_archivo.as_deref(), Some("src/db.ts"));
    }

    /// "Persists" may come with the lines it moved to.
    #[test]
    fn a_persists_verdict_moves_the_lines() {
        let prev = vec![remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1))];
        let v = verdicts(&[("F-001", PriorVerdict { resolved: false, archivo: None, lineas: Some("30-32".into()), resolucion: None })]);
        let (merged, delta) = reconcile_with(&prev, &[], 1, Rereview { verdicts: Some(&v), ..Default::default() });
        assert_eq!((merged[0].estado.as_str(), merged[0].lineas.as_deref()), ("posteado", Some("30-32")));
        assert_eq!(delta.persisten, 1);
    }

    /// A finding the model re-reported and also called fixed is still there: the report wins over
    /// the verdict, because closing the thread is the outward-facing mistake.
    #[test]
    fn a_reported_finding_is_not_closed_by_a_contradicting_verdict() {
        let prev = vec![remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1))];
        let v = verdicts(&[("F-001", resolved_verdict("x"))]);
        let (merged, delta) =
            reconcile_with(&prev, &[reported("npe", "a.ts", "11")], 1, Rereview { verdicts: Some(&v), ..Default::default() });
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].estado, "posteado");
        assert_eq!(delta.resueltos, 0);
    }

    /// Accepted debt is out of the active counts, stays debt while it is there, and is paid when a
    /// reviewer judges it fixed.
    #[test]
    fn debt_stays_out_of_the_counts_until_it_is_paid() {
        let debt = MemoryFinding { motivo_descarte: Some("se migra en Q3".into()), ..remembered("F-001", ESTADO_DEUDA, "npe", "a.ts", "10", Some(4)) };
        let (merged, delta) = reconcile(&[debt.clone()], &[], 1, None);
        assert_eq!(merged[0].estado, ESTADO_DEUDA);
        assert_eq!(delta.persisten, 0, "debt is not active");

        // Re-reported: still debt, reason kept.
        let (merged, _) = reconcile(&[debt.clone()], &[reported("npe", "a.ts", "10")], 1, None);
        assert_eq!((merged[0].estado.as_str(), merged[0].motivo_descarte.as_deref()), (ESTADO_DEUDA, Some("se migra en Q3")));

        let v = verdicts(&[("F-001", resolved_verdict("Se migró al cliente nuevo."))]);
        let (merged, delta) = reconcile_with(&[debt], &[], 1, Rereview { verdicts: Some(&v), ..Default::default() });
        assert_eq!(merged[0].estado, "resuelto");
        assert_eq!(delta.resueltos, 1);
    }

    /// Terminal states never come back for judgement, whatever a verdict says.
    #[test]
    fn a_verdict_never_touches_a_terminal_finding() {
        let prev = vec![remembered("F-001", "falso_positivo", "npe", "a.ts", "10", None)];
        let v = verdicts(&[("F-001", resolved_verdict("x"))]);
        let (merged, _) = reconcile_with(&prev, &[], 1, Rereview { verdicts: Some(&v), ..Default::default() });
        assert_eq!(merged[0].estado, "falso_positivo");
    }

    /// A new finding on lines the delta never touched should have been found the iteration before.
    #[test]
    fn a_new_finding_outside_the_delta_is_late() {
        let mut delta_lines = DeltaLines::new();
        delta_lines.insert("src/a.ts".into(), vec![(40, 45)]);
        let current = vec![
            reported("npe", "src/a.ts", "42"),
            reported("sqli", "src/a.ts", "100-102"),
            reported("leak", "src/untouched.ts", "3"),
        ];
        let (merged, _) = reconcile_with(&[], &current, 1, Rereview { delta_lines: Some(&delta_lines), ..Default::default() });
        assert_eq!(merged.iter().map(|f| f.tardio).collect::<Vec<_>>(), vec![false, true, true]);
        // No delta, no claim.
        let (merged, _) = reconcile(&[], &current, 1, None);
        assert!(merged.iter().all(|f| !f.tardio));
    }

    #[test]
    fn set_finding_state_requires_a_reason_for_debt_and_reopen_clears_the_rest() {
        let mut f = remembered("F-001", "posteado", "npe", "a.ts", "10", Some(9));
        assert!(set_finding_state(&mut f, ESTADO_DEUDA, Some("  ".into()), 2).is_err());
        set_finding_state(&mut f, ESTADO_DEUDA, Some("Aceptado por el equipo".into()), 2).unwrap();
        assert_eq!((f.estado.as_str(), f.motivo_descarte.as_deref()), (ESTADO_DEUDA, Some("Aceptado por el equipo")));
        assert!(!f.is_active() && f.needs_judgement());

        set_finding_state(&mut f, "resuelto", Some("Pagada".into()), 3).unwrap();
        assert_eq!((f.resuelto_en_iter, f.resolucion.as_deref()), (Some(3), Some("Pagada")));

        set_finding_state(&mut f, "abierto", None, 4).unwrap();
        assert_eq!(f.estado, "posteado", "it still owns a thread");
        assert!(f.motivo_descarte.is_none() && f.resolucion.is_none() && f.resuelto_en_iter.is_none());
        assert!(set_finding_state(&mut f, "whatever", None, 1).is_err());
    }

    #[test]
    fn the_reevaluate_block_lists_what_is_still_in_the_code_with_its_why() {
        let open = MemoryFinding {
            comentario_md: "### 🚨 [Bug] npe · F-001\n\nsub\n\n💭 **Por qué:** `x` puede ser null.\n\n💡 **Sugerencia:** s".into(),
            ..remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1))
        };
        let debt = remembered("F-002", ESTADO_DEUDA, "n-plus-one", "b.ts", "5", None);
        let gone = remembered("F-003", "resuelto", "naming", "c.ts", "1", None);
        let block = reevaluate_block(&[open, debt, gone]).expect("two to judge");
        assert!(block.contains("F-001") && block.contains("`a.ts:10`") && block.contains("`x` puede ser null."));
        assert!(block.contains("F-002") && block.contains("deuda técnica aceptada"));
        assert!(!block.contains("**F-003**"), "a resolved finding is not re-judged");
        assert!(block.contains("PREVIO F-003: PERSISTE @"), "the format is spelled out");
        assert!(reevaluate_block(&[remembered("F-009", "ignorado", "x", "a.ts", "1", None)]).is_none());
    }

    /// The scan carries only debt, only on files this PR touches, under aliases of its own — and a
    /// judged fix settles it in the run it came from.
    #[test]
    fn the_debt_scan_carries_debt_on_touched_files_and_settles_it_where_it_lives() {
        let other = vec![
            MemoryFinding { motivo_descarte: Some("en Q3".into()), ..remembered("F-002", ESTADO_DEUDA, "dup", "src/a.ts", "4", None) },
            remembered("F-003", ESTADO_DEUDA, "dup", "src/elsewhere.ts", "4", None),
            remembered("F-004", "posteado", "npe", "src/a.ts", "9", Some(1)),
        ];
        let runs = vec![("run-42".to_string(), 42, 3, serde_json::to_string(&other).unwrap())];
        let debts = foreign_debt(&runs, &["src/a.ts".to_string()]);
        assert_eq!(debts.len(), 1);
        assert_eq!((debts[0].alias.as_str(), debts[0].finding.id.as_str(), debts[0].pr_id), ("D-001", "F-002", 42));
        assert!(debts[0].for_review().subtitulo.contains("PR #42"));

        let verdict = resolved_verdict("Se extrajo el helper.");
        let mut stored = other.clone();
        assert!(settle_foreign_debt(&mut stored, &debts[0], &verdict, 77));
        assert_eq!(stored[0].estado, "resuelto");
        assert_eq!(stored[0].resuelto_en_iter, Some(3));
        assert!(stored[0].resolucion.as_deref().unwrap().starts_with("Saldada en el PR #77"));

        let v: std::collections::HashMap<String, PriorVerdict> = [("D-001".to_string(), verdict)].into_iter().collect();
        let section = foreign_debt_section(&debts, &v).unwrap();
        assert!(section.contains("Deuda técnica de otros PRs") && section.contains("Saldada en este PR"));
        let section = foreign_debt_section(&debts, &Default::default()).unwrap();
        assert!(section.contains("Sigue presente · aceptada: en Q3"));
    }

    #[test]
    fn a_fix_is_cut_from_either_diff_shape() {
        let unified = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,5 @@ fn\n ctx10\n-old11\n+if (!cuenta) return 404;\n+const s = cuenta.saldo;\n ctx13\n";
        assert_eq!(snippet_from_diff(unified, "src/a.ts", (11, 12)).as_deref(), Some("if (!cuenta) return 404;\nconst s = cuenta.saldo;"));
        assert_eq!(snippet_from_diff(unified, "src/other.ts", (11, 12)), None);
        let stored = "--- src/a.ts (modified)\n@@ -1,2 +1,3 @@\n uno\n+dos\n tres\n\n--- src/b.ts (added)\n@@ -0,0 +1 @@\n+b\n";
        assert_eq!(snippet_from_diff(stored, "src/a.ts", (2, 3)).as_deref(), Some("dos\ntres"));
        assert_eq!(snippet_from_content("a\nb\nc\nd", (2, 3)).as_deref(), Some("b\nc"));
        assert_eq!(snippet_from_content("a", (5, 9)), None);
    }

    #[test]
    fn a_resolution_note_carries_the_reason_and_the_code() {
        let f = MemoryFinding {
            resolucion: Some("Se agregó la guarda temprana.".into()),
            resolucion_lineas: Some("11-12".into()),
            ..remembered("F-001", "resuelto", "npe", "src/a.ts", "10", Some(1))
        };
        let note = resolution_note(&f, Some("if (!x) return;"));
        assert!(note.contains("🛠️ **Resolución:** Se agregó la guarda temprana."));
        assert!(note.contains("📄 **Código que lo resuelve** (`src/a.ts:11-12`):\n```ts\nif (!x) return;\n```"));
        assert_eq!(resolution_note(&remembered("F-002", "resuelto", "npe", "a.ts", "1", None), None), "");
    }

    #[test]
    fn the_history_shows_the_resolution_and_the_debt() {
        let fixed = MemoryFinding {
            resuelto_en_iter: Some(3),
            resolucion: Some("Se validó la entrada.".into()),
            ..remembered("F-001", "resuelto", "npe", "a.ts", "10", Some(1))
        };
        let debt = MemoryFinding { motivo_descarte: Some("Se paga en el sprint 12".into()), ..remembered("F-002", ESTADO_DEUDA, "dup", "b.ts", "4", None) };
        let section = resolved_history_section(&[fixed, debt]).unwrap();
        assert!(section.contains("introducido iter 1 · resuelto iter 3"));
        assert!(section.contains("🛠️ Se validó la entrada."));
        assert!(section.contains("### 🧾 Deuda técnica"));
        assert!(section.contains("Aceptada: Se paga en el sprint 12"));
    }
}
