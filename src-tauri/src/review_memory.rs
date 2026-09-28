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
    /// This finding as the body of a pull-request comment — see [`crate::review::render::comment_markdown`].
    ///
    /// The one field here that is not a projection of something smaller. It exists because the rest
    /// of this struct deliberately drops `por_que`, `sugerencia` and `ejemplo_*`, and those are what
    /// a comment is made of: a client that holds only the stored findings (the mobile one) could
    /// otherwise publish nothing better than the subtitle — and because `apply_post_outcome` records
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
    of_current
}

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

/// Reconciles a fresh parse (`current`) against the previous run (`prev`) and returns the full,
/// merged finding set for this run plus the delta counts.
///
/// Rules (mirroring WF-PR-REVIEWER `re-review.md`): a current finding that continues an active prev
/// one (see [`pair_up`]) **persists** (keeps its stable id, `estado`, `thread_id`,
/// `introducido_en_iter`); one continuing a human-discarded prev keeps that mark; an unmatched
/// current one is **new**. A prev active finding nothing continues is **resolved** (carried forward,
/// thread kept). Findings already resolved/discarded are always carried forward untouched — they're
/// never deleted, which is what gives the PR its cumulative traceability.
///
/// `changed_files`, when provided (an efficient re-review), is the set of files that changed since
/// the last run: a previous active finding on a file that did NOT change auto-persists (its code
/// wasn't touched), rather than looking resolved just because this run didn't re-surface it. `None`
/// means a full review, where any unmatched active finding is treated as resolved.
///
/// **The result is positional**: `merged[i]` is `current[i]` for every `i < current.len()`, and
/// the carried-forward history follows. The caller carries ids back onto the full findings by that
/// position — by key it could not, since two findings may share one (see [`finding_identity`]).
///
/// Ids come out unique even from a memory that has duplicates in it — which runs saved before the
/// matching was one to one do. The first holder keeps the id; any later one is renumbered, thread
/// and all, rather than left sharing it.
pub fn reconcile(
    prev: &[MemoryFinding],
    current: &[MemoryFinding],
    prev_iter: usize,
    changed_files: Option<&[String]>,
) -> (Vec<MemoryFinding>, ReviewDelta) {
    let iter_actual = prev_iter + 1;
    let mut next_id = max_id_num(prev).max(max_id_num(current)) + 1;
    let mut fresh_id = || {
        let id = format!("F-{next_id:03}");
        next_id += 1;
        id
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
                nuevos += 1;
            }
            // Still present and previously seen (active or human-discarded) → persists.
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
        if !self.categoria.eq_ignore_ascii_case(categoria.trim()) {
            return false;
        }
        match (&self.archivo, archivo) {
            (None, _) => true,
            (Some(rule_file), Some(f)) => {
                let norm = |s: &str| s.trim().trim_start_matches('/').to_lowercase();
                let (a, b) = (norm(rule_file), norm(f));
                a == b || a.ends_with(&b) || b.ends_with(&a)
            }
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

    fn finding(id: &str, estado: &str, categoria: &str) -> MemoryFinding {
        MemoryFinding {
            id: id.into(),
            severity: "critical".into(),
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

    /// One of two same-category findings fixed: the other persists and the fixed one is resolved with
    /// its thread kept for the "resuelto" reply — it used to vanish from the memory instead.
    #[test]
    fn the_one_that_is_gone_is_resolved_not_lost() {
        let prev = vec![
            remembered("F-001", "posteado", "npe", "a.ts", "10", Some(1)),
            remembered("F-002", "posteado", "npe", "a.ts", "480", Some(2)),
        ];
        let current = vec![reported("npe", "a.ts", "478-481")];
        let (merged, delta) = reconcile(&prev, &current, 2, None);
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
        let (merged, delta) = reconcile(&prev, &[], 1, Some(&changed));
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
}
