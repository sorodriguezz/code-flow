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
        }
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
