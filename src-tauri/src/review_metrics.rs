//! What the review memory says in aggregate — the numbers behind the review metrics view.
//!
//! Everything is computed from `review_runs` on demand rather than kept in counters: the runs are
//! the record, a human mark on a finding changes them after the fact (a false positive is decided
//! days later), and a counter written at review time would go on describing the review as it was
//! before anybody looked at it.
//!
//! Two different sets of findings are counted, on purpose:
//!
//! - **per run, what it introduced** — "new findings per month" counts a finding once, in the
//!   month of the run that first reported it. Counting every run's whole list would count a finding
//!   that survived five re-reviews five times.
//! - **per pull request, its latest run** — each run carries forward every finding the PR has ever
//!   had (resolved and human-discarded ones included, for traceability), with the state they are in
//!   *now*. So the latest run is the one place to ask "what is still open", "what did humans reject"
//!   and "what got fixed" without double counting.
//!
//! The rows are read defensively: `project_id` may be NULL (a review reached by link has no
//! project), the repository is whatever key the row carries, and findings are read through
//! [`MemoryFinding`] so a state this module has never heard of is counted under its own name rather
//! than breaking the view.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::review::contract::Severity;
use crate::review_memory::MemoryFinding;

/// The severities in the order every chart lists them.
pub const SEVERITIES: [&str; 5] = ["Blocker", "Crítico", "Mayor", "Menor", "Info"];

/// One stored run, with only what the metrics read — never the review text or the diff, which are
/// most of a row's weight and none of its numbers.
#[derive(Debug, Clone)]
pub struct MetricsRun {
    pub project_id: Option<String>,
    pub project_name: String,
    /// The repository the run reviewed (`github:host/owner/repo`, …), empty on runs that predate it.
    pub repo_key: String,
    pub pr_id: i64,
    pub iter: i64,
    pub level: String,
    pub created_at: String,
    pub meta: Value,
    pub findings: Vec<MemoryFinding>,
}

impl MetricsRun {
    /// Which repository this run counts under. The repo key when the run has one — a project can be
    /// re-pointed at another repository, and the key is what says which code was reviewed — and the
    /// project otherwise.
    fn repo(&self) -> String {
        if !self.repo_key.is_empty() {
            return self.repo_key.clone();
        }
        match &self.project_id {
            Some(id) if !id.is_empty() => format!("project:{id}"),
            _ => "unknown".to_string(),
        }
    }

    fn repo_label(&self) -> String {
        if !self.project_name.trim().is_empty() {
            return self.project_name.clone();
        }
        let name = self.meta.get("project_name").and_then(Value::as_str).unwrap_or_default();
        if !name.trim().is_empty() {
            return name.to_string();
        }
        repo_key_label(&self.repo_key)
    }

    fn month(&self) -> String {
        self.created_at.chars().take(7).collect()
    }

    fn day(&self) -> &str {
        self.created_at.get(..10).unwrap_or(&self.created_at)
    }

    /// The reviewer that produced this run, as "engine · model".
    fn engine(&self) -> String {
        let engine = self.meta.get("engine").and_then(Value::as_str).unwrap_or_default().trim();
        let model = self.meta.get("model").and_then(Value::as_str).unwrap_or_default().trim();
        match (engine.is_empty(), model.is_empty()) {
            (true, true) => "—".to_string(),
            (false, true) => engine.to_string(),
            (true, false) => model.to_string(),
            (false, false) => format!("{engine} · {model}"),
        }
    }

    fn gate_passed(&self) -> bool {
        self.meta.get("quality_gate").and_then(Value::as_bool).unwrap_or(false)
    }

    fn cost_usd(&self) -> Option<f64> {
        self.meta.get("cost")?.get("cost_usd")?.as_f64()
    }

    fn tokens(&self) -> i64 {
        let Some(cost) = self.meta.get("cost") else { return 0 };
        ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
            .iter()
            .map(|k| cost.get(*k).and_then(Value::as_i64).unwrap_or(0))
            .sum()
    }

    /// Whether this finding first appeared in this run.
    fn introduced_here(&self, finding: &MemoryFinding) -> bool {
        if finding.introducido_en_iter > 0 {
            return finding.introducido_en_iter as i64 == self.iter;
        }
        // Runs saved before the iteration was kept: the delta says it, and a first run has nothing
        // before it to have carried anything from.
        match finding.delta.as_deref() {
            Some(delta) => delta == "nuevo",
            None => self.iter <= 1 && finding.estado != "resuelto",
        }
    }
}

/// A repository key as a person reads it: the provider prefix dropped, the last two path segments
/// kept — the same reading the memory browser gives it.
fn repo_key_label(key: &str) -> String {
    let without = key.split_once(':').map_or(key, |(_, rest)| rest);
    let parts: Vec<&str> = without.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return if without.is_empty() { "—".to_string() } else { without.to_string() };
    }
    parts[parts.len().saturating_sub(2)..].join("/")
}

/// One finding's severity, as a label from [`SEVERITIES`]: its own when stored, its emoji bucket
/// otherwise (the bucket's most severe member, so nothing is understated).
fn severity_label(finding: &MemoryFinding) -> &'static str {
    if let Some(severity) = Severity::parse(&finding.severidad) {
        return severity.label();
    }
    match finding.severity.as_str() {
        "critical" => "Crítico",
        "warning" => "Mayor",
        _ => "Info",
    }
}

/// Counts per severity, always all five keys so a chart has a stable shape.
fn severity_counts() -> BTreeMap<String, usize> {
    SEVERITIES.iter().map(|s| (s.to_string(), 0)).collect()
}

/// What the view filters by. Dates are `YYYY-MM-DD`, inclusive, compared against the run's own
/// timestamp; an empty filter is everything.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsFilter {
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

impl MetricsFilter {
    fn keeps(&self, run: &MetricsRun) -> bool {
        let day = run.day();
        self.repo.as_deref().filter(|r| !r.is_empty()).map_or(true, |repo| run.repo() == repo)
            && self.from.as_deref().filter(|d| !d.is_empty()).map_or(true, |from| day >= from)
            && self.to.as_deref().filter(|d| !d.is_empty()).map_or(true, |to| day <= to)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RepoOption {
    pub key: String,
    pub label: String,
    pub runs: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MonthStat {
    /// `YYYY-MM`.
    pub month: String,
    pub runs: usize,
    pub gate_passed: usize,
    pub gate_failed: usize,
    /// Findings first reported in this month, per severity.
    pub new_findings: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RepoStat {
    pub key: String,
    pub label: String,
    pub runs: usize,
    pub prs: usize,
    /// Active findings of each PR's latest run, per severity.
    pub open: BTreeMap<String, usize>,
    pub runs_with_cost: usize,
    pub total_cost_usd: f64,
    pub avg_cost_usd: Option<f64>,
}

/// A ratio of human-rejected findings within one group (an engine, a category).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RateStat {
    pub key: String,
    pub findings: usize,
    pub false_positives: usize,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CountStat {
    pub key: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct CostStat {
    pub runs_with_cost: usize,
    pub total_cost_usd: f64,
    pub avg_cost_usd: Option<f64>,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReviewMetrics {
    /// Every repository with saved runs in the workspace — the filter's options, read before the
    /// filter is applied so choosing one never makes the others disappear.
    pub repos: Vec<RepoOption>,
    pub total_runs: usize,
    pub total_prs: usize,
    pub gate_passed: usize,
    pub gate_failed: usize,
    /// Runs a person approved from CodeFlow after reading them (see `review_approval`).
    pub approved: usize,
    /// Oldest first, only months with runs.
    pub months: Vec<MonthStat>,
    pub by_repo: Vec<RepoStat>,
    /// Findings by category, most frequent first, at most [`TOP_CATEGORIES`].
    pub top_categories: Vec<CountStat>,
    /// All findings, falso_positivo / total, overall.
    pub false_positive: RateStat,
    pub false_positive_by_engine: Vec<RateStat>,
    pub false_positive_by_category: Vec<RateStat>,
    /// Every finding by its lifecycle state — resolved, open, posted, rejected, and whatever states
    /// the memory grows later.
    pub by_state: Vec<CountStat>,
    pub resolved: usize,
    pub cost: CostStat,
    pub runs_by_level: Vec<CountStat>,
}

/// How many categories the "top" list keeps.
pub const TOP_CATEGORIES: usize = 10;

fn rate(key: String, findings: usize, false_positives: usize) -> RateStat {
    let rate = if findings == 0 { 0.0 } else { false_positives as f64 / findings as f64 };
    RateStat { key, findings, false_positives, rate }
}

fn sorted_counts(map: HashMap<String, usize>) -> Vec<CountStat> {
    let mut out: Vec<CountStat> = map.into_iter().map(|(key, count)| CountStat { key, count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    out
}

fn sorted_rates(map: HashMap<String, (usize, usize)>) -> Vec<RateStat> {
    let mut out: Vec<RateStat> = map.into_iter().map(|(key, (n, fp))| rate(key, n, fp)).collect();
    out.sort_by(|a, b| b.findings.cmp(&a.findings).then_with(|| a.key.cmp(&b.key)));
    out
}

/// The metrics of the runs `filter` keeps. Pure: everything it needs is in `runs`.
pub fn compute(runs: &[MetricsRun], filter: &MetricsFilter) -> ReviewMetrics {
    // The filter's options, from every run.
    let mut repo_options: BTreeMap<String, RepoOption> = BTreeMap::new();
    for run in runs {
        let entry = repo_options
            .entry(run.repo())
            .or_insert_with(|| RepoOption { key: run.repo(), label: run.repo_label(), runs: 0 });
        entry.runs += 1;
    }
    let mut repos: Vec<RepoOption> = repo_options.into_values().collect();
    repos.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

    let kept: Vec<&MetricsRun> = runs.iter().filter(|r| filter.keeps(r)).collect();

    // The latest run of every pull request — newest by timestamp, the iteration breaking a tie.
    let mut latest: HashMap<(String, i64), &MetricsRun> = HashMap::new();
    for run in &kept {
        let key = (run.repo(), run.pr_id);
        let newer = latest.get(&key).map_or(true, |cur| (run.created_at.as_str(), run.iter) > (cur.created_at.as_str(), cur.iter));
        if newer {
            latest.insert(key, run);
        }
    }
    // Which reviewer produced each iteration, so a finding is held against the engine that reported
    // it rather than the one that happened to re-review the PR last.
    let engine_at: HashMap<(String, i64, i64), String> =
        kept.iter().map(|r| ((r.repo(), r.pr_id, r.iter), r.engine())).collect();

    let mut months: BTreeMap<String, MonthStat> = BTreeMap::new();
    let mut levels: HashMap<String, usize> = HashMap::new();
    let mut cost = CostStat::default();
    let mut repo_stats: BTreeMap<String, RepoStat> = BTreeMap::new();
    let mut repo_prs: HashMap<String, HashSet<i64>> = HashMap::new();
    let (mut gate_passed, mut gate_failed, mut approved) = (0, 0, 0);

    for run in &kept {
        let month = months.entry(run.month()).or_insert_with(|| MonthStat {
            month: run.month(),
            runs: 0,
            gate_passed: 0,
            gate_failed: 0,
            new_findings: severity_counts(),
        });
        month.runs += 1;
        if run.gate_passed() {
            month.gate_passed += 1;
            gate_passed += 1;
        } else {
            month.gate_failed += 1;
            gate_failed += 1;
        }
        for finding in run.findings.iter().filter(|f| run.introduced_here(f)) {
            *month.new_findings.entry(severity_label(finding).to_string()).or_default() += 1;
        }
        if run.meta.get("approval").is_some_and(Value::is_object) {
            approved += 1;
        }
        let level = if run.level.is_empty() { "—".to_string() } else { run.level.clone() };
        *levels.entry(level).or_default() += 1;

        let repo = repo_stats.entry(run.repo()).or_insert_with(|| RepoStat {
            key: run.repo(),
            label: run.repo_label(),
            runs: 0,
            prs: 0,
            open: severity_counts(),
            runs_with_cost: 0,
            total_cost_usd: 0.0,
            avg_cost_usd: None,
        });
        repo.runs += 1;
        repo_prs.entry(run.repo()).or_default().insert(run.pr_id);
        // A run whose engines never named a price is not free: it counts towards tokens, never
        // towards the average price.
        if let Some(usd) = run.cost_usd() {
            repo.runs_with_cost += 1;
            repo.total_cost_usd += usd;
            cost.runs_with_cost += 1;
            cost.total_cost_usd += usd;
        }
        cost.total_tokens += run.tokens();
    }
    cost.avg_cost_usd = (cost.runs_with_cost > 0).then(|| cost.total_cost_usd / cost.runs_with_cost as f64);

    let mut categories: HashMap<String, usize> = HashMap::new();
    let mut states: HashMap<String, usize> = HashMap::new();
    let mut by_engine: HashMap<String, (usize, usize)> = HashMap::new();
    let mut by_category: HashMap<String, (usize, usize)> = HashMap::new();
    let (mut total, mut false_positives) = (0, 0);

    for ((repo_key, pr_id), run) in &latest {
        for finding in &run.findings {
            total += 1;
            let fp = finding.estado == "falso_positivo";
            if fp {
                false_positives += 1;
            }
            let category = if finding.categoria.trim().is_empty() { "—".to_string() } else { finding.categoria.trim().to_string() };
            *categories.entry(category.clone()).or_default() += 1;
            *states.entry(finding.estado.clone()).or_default() += 1;
            let engine = engine_at
                .get(&(repo_key.clone(), *pr_id, finding.introducido_en_iter as i64))
                .cloned()
                .unwrap_or_else(|| run.engine());
            let slot = by_engine.entry(engine).or_default();
            slot.0 += 1;
            slot.1 += fp as usize;
            let slot = by_category.entry(category).or_default();
            slot.0 += 1;
            slot.1 += fp as usize;
            if finding.is_active() {
                if let Some(repo) = repo_stats.get_mut(repo_key) {
                    *repo.open.entry(severity_label(finding).to_string()).or_default() += 1;
                }
            }
        }
    }

    let mut by_repo: Vec<RepoStat> = repo_stats
        .into_values()
        .map(|mut repo| {
            repo.prs = repo_prs.get(&repo.key).map_or(0, HashSet::len);
            repo.avg_cost_usd = (repo.runs_with_cost > 0).then(|| repo.total_cost_usd / repo.runs_with_cost as f64);
            repo
        })
        .collect();
    by_repo.sort_by(|a, b| b.runs.cmp(&a.runs).then_with(|| a.label.cmp(&b.label)));

    let mut top_categories = sorted_counts(categories);
    top_categories.truncate(TOP_CATEGORIES);
    let resolved = states.get("resuelto").copied().unwrap_or(0);

    ReviewMetrics {
        repos,
        total_runs: kept.len(),
        total_prs: latest.len(),
        gate_passed,
        gate_failed,
        approved,
        months: months.into_values().collect(),
        by_repo,
        top_categories,
        false_positive: rate("all".to_string(), total, false_positives),
        false_positive_by_engine: sorted_rates(by_engine),
        false_positive_by_category: sorted_rates(by_category),
        by_state: sorted_counts(states),
        resolved,
        cost,
        runs_by_level: sorted_counts(levels),
    }
}

/// Every run of a workspace, slimmed to what [`compute`] reads.
///
/// Reads a `repo_key` column when the table has one and the meta's key otherwise, and takes
/// `project_id` as nullable — both so this keeps working across the schema's evolution (runs
/// reviewed by link have no project). A row whose findings no longer parse counts as a run with
/// none rather than failing the whole view.
pub fn load_runs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<MetricsRun>> {
    let has_repo_column = conn
        .prepare("SELECT 1 FROM pragma_table_info('review_runs') WHERE name = 'repo_key'")?
        .exists([])?;
    let repo_expr = if has_repo_column {
        "COALESCE(NULLIF(r.repo_key, ''), json_extract(r.meta, '$.repo_key'), '')"
    } else {
        "COALESCE(json_extract(r.meta, '$.repo_key'), '')"
    };
    let sql = format!(
        "SELECT r.project_id, COALESCE(p.name, ''), {repo_expr}, r.pr_id, r.iter, r.level, r.created_at,
                r.meta, r.findings
         FROM review_runs r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.workspace_id = ?1
         ORDER BY r.created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        let meta: String = row.get::<_, Option<String>>(7)?.unwrap_or_default();
        let findings: String = row.get::<_, Option<String>>(8)?.unwrap_or_default();
        Ok(MetricsRun {
            project_id: row.get(0)?,
            project_name: row.get(1)?,
            repo_key: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            pr_id: row.get(3)?,
            iter: row.get(4)?,
            level: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            created_at: row.get(6)?,
            meta: serde_json::from_str(&meta).unwrap_or(Value::Null),
            findings: serde_json::from_str(&findings).unwrap_or_default(),
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(id: &str, severidad: &str, categoria: &str, estado: &str, iter: usize) -> MemoryFinding {
        serde_json::from_value(serde_json::json!({
            "id": id, "severity": "warning", "severidad": severidad, "tipo": "Bug", "categoria": categoria,
            "subtitulo": "x", "archivo": null, "lineas": null, "confianza": 80, "estado": estado,
            "introducido_en_iter": iter,
        }))
        .unwrap()
    }

    fn run(_id: &str, repo: &str, pr: i64, iter: i64, at: &str, meta: Value, findings: Vec<MemoryFinding>) -> MetricsRun {
        MetricsRun {
            project_id: None,
            project_name: String::new(),
            repo_key: repo.into(),
            pr_id: pr,
            iter,
            level: "completo".into(),
            created_at: at.into(),
            meta,
            findings,
        }
    }

    #[test]
    fn no_runs_is_a_well_formed_empty_answer() {
        let m = compute(&[], &MetricsFilter::default());
        assert_eq!(m.total_runs, 0);
        assert!(m.months.is_empty() && m.by_repo.is_empty() && m.repos.is_empty());
        assert_eq!(m.false_positive.rate, 0.0);
        assert_eq!(m.cost.avg_cost_usd, None);
    }

    fn sample() -> Vec<MetricsRun> {
        let claude = serde_json::json!({ "engine": "claude", "model": "opus", "quality_gate": false,
            "cost": { "passes": 2, "input_tokens": 100, "output_tokens": 50, "cost_usd": 0.5 } });
        let codex = serde_json::json!({ "engine": "codex", "model": "", "quality_gate": true,
            "approval": { "account": "@ana" } });
        vec![
            // PR 1, first iteration by claude: two findings.
            run("a", "github:h/o/app", 1, 1, "2026-10-03T10:00:00Z", claude.clone(), vec![
                finding("F-001", "Crítico", "npe", "abierto", 1),
                finding("F-002", "Mayor", "naming", "abierto", 1),
            ]),
            // PR 1, second iteration by codex: F-001 fixed, F-002 rejected by a human, one new one.
            run("b", "github:h/o/app", 1, 2, "2026-11-04T10:00:00Z", codex, vec![
                finding("F-001", "Crítico", "npe", "resuelto", 1),
                finding("F-002", "Mayor", "naming", "falso_positivo", 1),
                finding("F-003", "Menor", "npe", "posteado", 2),
            ]),
            // Another repository, reviewed by link (no project).
            run("c", "gitlab:h/g/api", 7, 1, "2026-11-20T10:00:00Z", claude, vec![finding("F-001", "Blocker", "sql", "abierto", 1)]),
        ]
    }

    #[test]
    fn findings_are_counted_once_in_the_month_they_appeared() {
        let m = compute(&sample(), &MetricsFilter::default());
        assert_eq!(m.total_runs, 3);
        assert_eq!(m.total_prs, 2);
        let oct = &m.months[0];
        assert_eq!((oct.month.as_str(), oct.gate_failed), ("2026-10", 1));
        assert_eq!(oct.new_findings["Crítico"], 1);
        assert_eq!(oct.new_findings["Mayor"], 1);
        let nov = &m.months[1];
        assert_eq!((nov.runs, nov.gate_passed, nov.gate_failed), (2, 1, 1));
        // F-001/F-002 carried into run b are not new again.
        assert_eq!(nov.new_findings["Crítico"], 0);
        assert_eq!(nov.new_findings["Menor"], 1);
        assert_eq!(nov.new_findings["Blocker"], 1);
        assert_eq!(m.approved, 1);
    }

    #[test]
    fn open_resolved_and_rejected_come_from_each_prs_latest_run() {
        let m = compute(&sample(), &MetricsFilter::default());
        let app = m.by_repo.iter().find(|r| r.key == "github:h/o/app").unwrap();
        assert_eq!(app.label, "o/app");
        assert_eq!(app.open["Menor"], 1);
        assert_eq!(app.open["Crítico"], 0, "a resolved finding is not open");
        assert_eq!(m.resolved, 1);
        // 4 findings across the latest runs, one human-rejected.
        assert_eq!((m.false_positive.findings, m.false_positive.false_positives), (4, 1));
        // F-002 was reported by claude in iteration 1, so the rejection is claude's, not codex's.
        let claude = m.false_positive_by_engine.iter().find(|r| r.key == "claude · opus").unwrap();
        assert_eq!((claude.findings, claude.false_positives), (3, 1));
        let codex = m.false_positive_by_engine.iter().find(|r| r.key == "codex").unwrap();
        assert_eq!((codex.findings, codex.false_positives), (1, 0));
        assert_eq!(m.top_categories[0], CountStat { key: "npe".into(), count: 2 });
    }

    #[test]
    fn cost_averages_only_runs_that_named_a_price() {
        let m = compute(&sample(), &MetricsFilter::default());
        assert_eq!(m.cost.runs_with_cost, 2);
        assert!((m.cost.total_cost_usd - 1.0).abs() < 1e-9);
        assert_eq!(m.cost.avg_cost_usd, Some(0.5));
        assert_eq!(m.cost.total_tokens, 300);
        let app = m.by_repo.iter().find(|r| r.key == "github:h/o/app").unwrap();
        assert_eq!((app.runs, app.runs_with_cost, app.prs), (2, 1, 1));
        assert_eq!(m.runs_by_level, vec![CountStat { key: "completo".into(), count: 3 }]);
    }

    #[test]
    fn filters_narrow_the_numbers_but_not_the_repo_options() {
        let only_api = MetricsFilter { repo: Some("gitlab:h/g/api".into()), ..Default::default() };
        let m = compute(&sample(), &only_api);
        assert_eq!(m.total_runs, 1);
        assert_eq!(m.repos.len(), 2);

        let november = MetricsFilter { from: Some("2026-11-01".into()), to: Some("2026-11-05".into()), ..Default::default() };
        let m = compute(&sample(), &november);
        assert_eq!(m.total_runs, 1);
        assert_eq!(m.months.len(), 1);
    }

    #[test]
    fn a_run_without_a_repo_key_counts_under_its_project() {
        let mut legacy = run("x", "", 3, 1, "2026-09-01T00:00:00Z", Value::Null, vec![]);
        legacy.project_id = Some("p1".into());
        legacy.project_name = "Mi repo".into();
        let m = compute(&[legacy], &MetricsFilter::default());
        assert_eq!(m.repos[0], RepoOption { key: "project:p1".into(), label: "Mi repo".into(), runs: 1 });
        assert_eq!(m.gate_failed, 1, "a run that recorded no verdict did not pass");
    }

    #[test]
    fn runs_load_from_the_table_with_a_null_project() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE review_runs (id TEXT, project_id TEXT, workspace_id TEXT, pr_id INTEGER, iter INTEGER,
                level TEXT, meta TEXT, review_md TEXT, diff TEXT, findings TEXT, created_at TEXT);
             INSERT INTO projects VALUES ('p1', 'App');
             INSERT INTO review_runs VALUES ('a', 'p1', 'w', 1, 1, 'basico', '{\"repo_key\":\"github:h/o/app\"}', '', '', '[]', '2026-11-01T00:00:00Z');
             INSERT INTO review_runs VALUES ('b', NULL, 'w', 2, 1, 'ultra', '{}', '', '', 'not json', '2026-11-02T00:00:00Z');
             INSERT INTO review_runs VALUES ('c', 'p1', 'other', 3, 1, 'basico', '{}', '', '', '[]', '2026-11-03T00:00:00Z');",
        )
        .unwrap();
        let runs = load_runs(&conn, "w").unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].repo_key, "github:h/o/app");
        assert_eq!(runs[0].project_name, "App");
        assert_eq!(runs[1].project_id, None);
        assert!(runs[1].findings.is_empty());
    }
}
