//! The review's deterministic pass: the [`prescan`] and the [`rules`], run before any model reads a
//! line, and what they hand the reviewers.
//!
//! One place for both because they share everything around them — the workspace switches, the
//! files they read, where their blocks go in a prompt, and the line the report says about them —
//! and because the shared files of the pipeline should only have to call into here, not know how
//! either works. Two entry points, one per way a review gets its code: [`for_clone`] (the
//! project-backed review, reading git) and [`for_link`] (a review by link, reading the host's API).
//!
//! Neither can fail a review. Whatever the pass could not do is in [`Deterministic`] as a reason,
//! logged and said in the report.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::prescan::{self, Hit, ScanFile};
use super::rules::source::{Cached, FileSource, GitSource, HostSource, Net, RealNet};
use super::rules::{self, PrFile, RuleMeta, RuleRun, RunStatus};

/// The workspace's switches. Everything defaults to on: a pre-mark costs a few lines of prompt, and
/// a rule only runs when the PR touches its paths.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DeterministicConfig {
    /// The pre-scan of the added lines.
    pub prescan: bool,
    /// The deterministic rules as a whole.
    pub rules: bool,
    /// Per-rule switches, by id. A rule absent here keeps its own default.
    pub rule_overrides: BTreeMap<String, bool>,
}

impl Default for DeterministicConfig {
    fn default() -> Self {
        Self { prescan: true, rules: true, rule_overrides: BTreeMap::new() }
    }
}

impl DeterministicConfig {
    pub fn rule_enabled(&self, meta: &RuleMeta) -> bool {
        self.rules && self.rule_overrides.get(meta.id).copied().unwrap_or(meta.enabled)
    }
}

/// One rule as the settings screen lists it.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuleInfo {
    pub id: String,
    pub title: String,
    pub severity: String,
    pub categories: Vec<String>,
    pub paths: Vec<String>,
    pub levels: Vec<String>,
    pub enabled_by_default: bool,
}

/// Every rule CodeFlow knows, for the settings screen.
pub fn rule_catalog() -> Vec<RuleInfo> {
    rules::catalog()
        .into_iter()
        .map(|m| RuleInfo {
            id: m.id.into(),
            title: m.title.into(),
            severity: m.severity.into(),
            categories: m.categories.iter().map(|s| s.to_string()).collect(),
            paths: m.paths.iter().map(|s| s.to_string()).collect(),
            levels: m.levels.iter().map(|s| s.to_string()).collect(),
            enabled_by_default: m.enabled,
        })
        .collect()
}

/// What the pass found — carried to the reviewers' prompts and to the report.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Deterministic {
    pub prescan_on: bool,
    pub rules_on: bool,
    pub hits: Vec<Hit>,
    pub runs: Vec<RuleRun>,
}

fn pr_files(files: &[ScanFile]) -> Vec<PrFile> {
    files.iter().map(|f| PrFile { path: f.path.clone(), added: f.added_file, touched: f.added.iter().map(|(n, _)| *n).collect() }).collect()
}

/// The pass itself, over any source and network — what the tests drive with fakes.
pub async fn evaluate(cfg: &DeterministicConfig, level: &str, mut files: Vec<ScanFile>, source: &dyn FileSource, net: &dyn Net) -> Deterministic {
    let mut out = Deterministic { prescan_on: cfg.prescan, rules_on: cfg.rules, ..Default::default() };
    if cfg.prescan {
        // Only the manifests are read whole: what tells a line of `dependencies` from one of `scripts`.
        for file in files.iter_mut().filter(|f| prescan::wants_content(&f.path)) {
            file.content = source.read(&file.path).await.ok().flatten();
        }
        out.hits = prescan::scan(&files);
    }
    if cfg.rules {
        let changed = pr_files(&files);
        let now = chrono::Utc::now();
        let input = rules::RunInput {
            level,
            files: &changed,
            source,
            net,
            today: chrono::Local::now().date_naive(),
            now: now.timestamp(),
        };
        out.runs = rules::run(&rules::registry(), &input, &|meta| cfg.rule_enabled(meta)).await;
    }
    out
}

/// The pass for a project-backed review, started beside the blast radius: owned inputs so it runs
/// as its own task and costs the review no wall time it was not already spending.
pub fn spawn_for_clone(
    cfg: &DeterministicConfig,
    level: &str,
    repo_path: &str,
    head_ref: &str,
    diff_files: &[crate::git::diff::FileDiffInfo],
) -> tokio::task::JoinHandle<Deterministic> {
    let (cfg, level) = (cfg.clone(), level.to_string());
    let files = if cfg.prescan || cfg.rules { prescan::from_git(diff_files) } else { Vec::new() };
    let source = Cached::new(GitSource { repo: repo_path.to_string(), rev: head_ref.to_string() });
    tokio::spawn(async move {
        if !cfg.prescan && !cfg.rules {
            return Deterministic::default();
        }
        evaluate(&cfg, &level, files, &source, &RealNet).await
    })
}

/// The pass for a review by link: the diff as the host returned it, files read through its API.
pub async fn for_link(
    cfg: &DeterministicConfig,
    level: &str,
    target: &crate::pr_link::PrLinkTarget,
    credential: &str,
    source_branch: &str,
    diff_text: &str,
) -> Deterministic {
    if !cfg.prescan && !cfg.rules {
        return Deterministic::default();
    }
    let source = Cached::new(HostSource::for_link(target, credential, source_branch));
    evaluate(cfg, level, prescan::from_unified(diff_text), &source, &RealNet).await
}

/// One rule's run as a saved review's meta keeps it (`ReviewMeta::rules`): which rules this run
/// actually ran, and the ones that could not be evaluated and why — without the facts, which carry
/// file names and versions the memory has no use for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleRecord {
    pub id: String,
    pub severity: String,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Deterministic {
    /// What a saved run records about the rules: one row per rule that ran (a rule whose paths the
    /// PR never touched did not run, and is not listed).
    pub fn records(&self) -> Vec<RuleRecord> {
        self.runs
            .iter()
            .map(|r| RuleRecord {
                id: r.id.clone(),
                severity: r.severity.clone(),
                status: r.status,
                reason: (r.status != RunStatus::Facts).then(|| r.reason.clone()).flatten(),
            })
            .collect()
    }

    fn with_facts(&self) -> impl Iterator<Item = (usize, &RuleRun)> {
        self.runs.iter().enumerate().filter(|(_, r)| r.status == RunStatus::Facts)
    }

    /// The block each group's bundle header carries, in group order: the pre-marks on that group's
    /// files, and the rules whose first matched file it reads (a rule no group reads rides in the
    /// first). One home per rule, so two reviewers never report the same rule twice.
    pub fn group_blocks(&self, groups: &[Vec<String>]) -> Vec<String> {
        let home = |run: &RuleRun| -> usize {
            groups
                .iter()
                .position(|files| run.matched.iter().any(|m| files.iter().any(|f| super::outline::same_path(f, m))))
                .unwrap_or(0)
        };
        let mut rides: Vec<Vec<&RuleRun>> = vec![Vec::new(); groups.len()];
        for (_, run) in self.with_facts() {
            if let Some(slot) = rides.get_mut(home(run)) {
                slot.push(run);
            }
        }
        groups
            .iter()
            .zip(rides)
            .map(|(files, runs)| {
                let mut out = prescan::block(&self.hits, Some(files)).unwrap_or_default();
                out.push_str(&rules::block(&runs).unwrap_or_default());
                out
            })
            .collect()
    }

    /// The single block of a review that reads every group at once, limited to the files it reviews.
    pub fn whole_block(&self, reviewed: &[String]) -> String {
        let runs: Vec<&RuleRun> = self.with_facts().map(|(_, r)| r).collect();
        let mut out = prescan::block(&self.hits, Some(reviewed)).unwrap_or_default();
        out.push_str(&rules::block(&runs).unwrap_or_default());
        out
    }

    /// The same, as named context entries for the single-pass prompt of a review by link.
    pub fn contexts(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        if let Some(text) = prescan::context_text(&self.hits) {
            out.push(("Pre-scan determinista".to_string(), text));
        }
        let runs: Vec<&RuleRun> = self.with_facts().map(|(_, r)| r).collect();
        if let Some(block) = rules::block(&runs) {
            let text = block.lines().map(|l| l.trim_start_matches('#').trim_start()).collect::<Vec<_>>().join("\n");
            out.push(("Reglas deterministas".to_string(), text.trim().to_string()));
        }
        out
    }

    /// What the run log says about the pass.
    pub fn log_lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.prescan_on {
            out.push(format!("  pre-scan: {}", prescan::summary(&self.hits)));
        }
        for run in &self.runs {
            let status = match run.status {
                RunStatus::Facts => "con hechos para los revisores".to_string(),
                RunStatus::NotApplicable => format!("sin nada que reportar ({})", run.reason.as_deref().unwrap_or("")),
                RunStatus::NotEvaluated => format!("no evaluada: {}", run.reason.as_deref().unwrap_or("")),
            };
            out.push(format!("  regla {}: {status} ({:.1} s)", run.id, run.millis as f64 / 1000.0));
        }
        out
    }

    /// The report's line: which rules ran, which could not and why. `None` when nothing ran — a
    /// PR that touches no rule's paths says nothing about rules.
    pub fn report_line(&self) -> Option<String> {
        let mut parts = Vec::new();
        if self.prescan_on && !self.hits.is_empty() {
            parts.push(format!("pre-scan {}", prescan::summary(&self.hits)));
        }
        if !self.runs.is_empty() {
            parts.push(format!("reglas: {}", rules::summary(&self.runs)));
        }
        (!parts.is_empty()).then(|| format!("🧪 Determinista: {}\n", parts.join(" · ")))
    }
}

/// A bundle with `block` inside its header, right before the code — so the pre-marks read as part
/// of the header the reviewer already treats as instructions. `text` is header + `body`.
pub fn into_header(text: &str, body: &str, block: &str) -> String {
    if block.is_empty() {
        return text.to_string();
    }
    let split = text.len().saturating_sub(body.len());
    let (head, code) = if text.is_char_boundary(split) && text[split..] == *body { text.split_at(split) } else { (text, "") };
    format!("{head}{block}#\n{code}")
}

#[cfg(test)]
mod tests {
    use super::super::rules::source::fake::{FakeNet, Files};
    use super::*;

    fn files() -> Vec<ScanFile> {
        vec![
            ScanFile { path: "src/a.ts".into(), added: vec![(3, "console.log(x)".into())], ..Default::default() },
            ScanFile { path: "prisma/schema.prisma".into(), added: vec![(10, "  email String @unique".into())], ..Default::default() },
        ]
    }

    #[tokio::test]
    async fn the_pass_honours_the_switches_and_places_its_blocks() {
        let source = Files::with(&[("prisma/migrations/migration_lock.toml", "x")]);
        let net = FakeNet::default();
        let on = evaluate(&DeterministicConfig::default(), "completo", files(), &source, &net).await;
        assert_eq!(on.hits.len(), 1);
        let ids: Vec<&str> = on.runs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["R-0002"]);

        let groups = vec![vec!["src/a.ts".to_string()], vec!["prisma/schema.prisma".to_string()]];
        let blocks = on.group_blocks(&groups);
        assert!(blocks[0].contains("PRE-SCAN") && !blocks[0].contains("R-0002"));
        assert!(blocks[1].contains("[R-0002]") && !blocks[1].contains("PRE-SCAN"));
        let line = on.report_line().unwrap();
        assert_eq!(line, "🧪 Determinista: pre-scan 1 marca(s): 1 resto(s) de debug · reglas: R-0002 con hechos\n");

        let off = DeterministicConfig { prescan: false, rule_overrides: [("R-0002".to_string(), false)].into(), ..Default::default() };
        let quiet = evaluate(&off, "completo", files(), &source, &net).await;
        assert!(quiet.hits.is_empty() && quiet.runs.is_empty() && quiet.report_line().is_none());
        // Rules are a completo/ultra affair by default.
        let basico = evaluate(&DeterministicConfig::default(), "basico", files(), &source, &net).await;
        assert!(basico.runs.is_empty());
    }

    #[test]
    fn a_rule_run_gives_its_report_line_and_record() {
        let det = Deterministic {
            rules_on: true,
            runs: vec![RuleRun {
                id: "R-0004".into(),
                title: "t".into(),
                severity: "Menor".into(),
                categories: vec![],
                status: RunStatus::NotEvaluated,
                reason: Some("superó su límite de 120 s".into()),
                facts: None,
                matched: vec!["package.json".into()],
                instruction: String::new(),
                millis: 0,
            }],
            ..Default::default()
        };
        assert_eq!(det.report_line().as_deref(), Some("🧪 Determinista: reglas: R-0004 no evaluada (superó su límite de 120 s)\n"));
        let records = det.records();
        assert_eq!(records.len(), 1);
        assert_eq!((records[0].id.as_str(), records[0].status), ("R-0004", RunStatus::NotEvaluated));
        assert_eq!(records[0].reason.as_deref(), Some("superó su límite de 120 s"));
        let json = serde_json::to_value(&records).unwrap();
        assert_eq!(json[0]["status"], "not_evaluated");
        assert_eq!(into_header("# head\ncode", "code", "# block\n"), "# head\n# block\n#\ncode");
    }
}
