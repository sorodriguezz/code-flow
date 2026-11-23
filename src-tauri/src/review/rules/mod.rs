//! Deterministic rules: checks a tool can settle before the model reads a line, handed to the
//! reviewer as **facts** to judge.
//!
//! Ported from the reference reviewer's custom rules (`rules/R-NNNN.py`, run by
//! `tools/lib/rules.py`). The division of labour is the same as the rest of [`crate::review`]: a
//! rule gathers what a reviewer cannot fetch itself — a file outside the bundle at the PR's commit,
//! a vault's secrets, a registry's versions, Node's release index — and the reviewer judges it,
//! reporting **at most one finding per subject** of the rule (per schema, per environment, per
//! `package.json`, per declaration).
//!
//! A rule runs only when the pull request touches one of its `paths`, only at the levels it lists,
//! and only when the workspace has it on. Whatever goes wrong — no network, no `az`, a 401, a panic,
//! its timeout — it is `not_evaluated` with a short reason, said in the report, and **never** stops
//! the review.
//!
//! Adding a rule is one file implementing [`Rule`] plus one line in [`registry`].

use std::collections::BTreeSet;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod source;

mod r0001_env;
mod r0002_prisma;
mod r0003_node;
mod r0004_deps;

use source::{FileSource, Net};

/// Ceiling on any list a rule's facts carry; past it, the rest is a count.
pub const MAX_NAMES: usize = 40;

/// What a rule is, as code declares it. The workspace only switches it on or off.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMeta {
    pub id: &'static str,
    pub title: &'static str,
    /// The severity its findings usually deserve — the instruction says when to go up or down.
    pub severity: &'static str,
    /// The categories its findings are reported under.
    pub categories: &'static [&'static str],
    /// Globs over repository paths; the rule runs only when the PR touches one.
    pub paths: &'static [&'static str],
    /// The depth levels it runs at.
    pub levels: &'static [&'static str],
    /// Whether it is on when the workspace has said nothing.
    pub enabled: bool,
    pub timeout_secs: u64,
    /// What the reviewer is told to do with the facts.
    pub instruction: &'static str,
}

/// One changed file of the pull request, as a rule sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrFile {
    pub path: String,
    /// The PR adds it (rather than modifying it).
    pub added: bool,
    /// New-side lines the PR added or changed — what a fact says "changed in this PR" about.
    pub touched: BTreeSet<usize>,
}

/// What a rule reads from.
pub struct RuleCx<'a> {
    /// The PR's files that match this rule's paths.
    pub matched: &'a [String],
    /// Every changed file of the PR (deleted ones excluded).
    pub files: &'a [PrFile],
    /// Files at the PR's source commit.
    pub source: &'a dyn FileSource,
    pub net: &'a dyn Net,
    pub today: chrono::NaiveDate,
    /// Unix seconds, for expiry checks.
    pub now: i64,
}

impl RuleCx<'_> {
    pub fn file(&self, path: &str) -> Option<&PrFile> {
        self.files.iter().find(|f| f.path == path)
    }
}

/// What a rule came back with.
pub enum Facts {
    /// Something for the reviewer to judge.
    Found(Value),
    /// Nothing it applies to (with why) — dropped from the prompt, said in the log.
    NotApplicable(String),
}

pub trait Rule: Send + Sync {
    fn meta(&self) -> &'static RuleMeta;
    /// `Err` is a reason the rule could not be evaluated at all.
    fn evaluate<'a>(&'a self, cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>>;
}

/// Every rule CodeFlow knows. The order is the report's.
pub fn registry() -> Vec<Box<dyn Rule>> {
    vec![Box::new(r0001_env::Env), Box::new(r0002_prisma::Prisma), Box::new(r0003_node::Node), Box::new(r0004_deps::Deps)]
}

/// Every rule's declaration — what the settings screen lists.
pub fn catalog() -> Vec<&'static RuleMeta> {
    registry().iter().map(|r| r.meta()).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Facts for the reviewer.
    Facts,
    NotApplicable,
    NotEvaluated,
}

/// One rule's run, as the prompt, the log and the report read it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleRun {
    pub id: String,
    pub title: String,
    pub severity: String,
    pub categories: Vec<String>,
    pub status: RunStatus,
    /// Why it does not apply, or why it could not be evaluated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facts: Option<Value>,
    /// The PR's files that triggered it.
    pub matched: Vec<String>,
    pub instruction: String,
    pub millis: u64,
}

fn globs(patterns: &[&str]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let mut add = |p: &str| {
            if let Ok(glob) = GlobBuilder::new(p).literal_separator(true).build() {
                builder.add(glob);
            }
        };
        add(pattern);
        // `package.json` means any package.json, the way everybody writes it.
        if !pattern.contains('/') {
            add(&format!("**/{pattern}"));
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}

/// The PR's files a rule's paths match.
pub fn matched(meta: &RuleMeta, files: &[PrFile]) -> Vec<String> {
    let set = globs(meta.paths);
    files.iter().filter(|f| set.is_match(&f.path)).map(|f| f.path.clone()).collect()
}

/// Whether a rule runs at this level. The reference tool's `standard` is CodeFlow's `completo`.
pub fn runs_at(meta: &RuleMeta, level: &str) -> bool {
    let level = crate::review::contract::normalize_level(level);
    meta.levels.iter().any(|l| crate::review::contract::normalize_level(l) == level)
}

/// Sorted, unique, at most [`MAX_NAMES`] — the rest as a count.
pub fn capped<I: IntoIterator<Item = String>>(items: I) -> Vec<String> {
    let set: BTreeSet<String> = items.into_iter().collect();
    let total = set.len();
    let mut out: Vec<String> = set.into_iter().take(MAX_NAMES).collect();
    if total > MAX_NAMES {
        out.push(format!("+{} más", total - MAX_NAMES));
    }
    out
}

/// A file's text parsed as JSON, BOM and all; `Ok(None)` when it is missing or not JSON.
pub async fn read_json(source: &dyn FileSource, path: &str) -> Result<Option<Value>, String> {
    Ok(source.read(path).await?.and_then(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()))
}

/// 1-based line of the first line containing `needle`.
pub fn line_of(text: &str, needle: &str) -> Option<usize> {
    text.lines().position(|l| l.contains(needle)).map(|i| i + 1)
}

/// Joins a root folder (`""` = the repository's) and a relative path.
pub fn join(root: &str, rel: &str) -> String {
    if root.is_empty() {
        rel.to_string()
    } else {
        format!("{root}/{rel}")
    }
}

/// Runs one rule, holding it to its timeout and catching a panic: a rule never sinks a review.
async fn run_one(rule: &dyn Rule, cx: &RuleCx<'_>) -> RuleRun {
    let meta = rule.meta();
    let started = Instant::now();
    let guarded = AssertUnwindSafe(rule.evaluate(cx)).catch_unwind();
    let outcome = tokio::time::timeout(Duration::from_secs(meta.timeout_secs.max(1)), guarded).await;
    let (status, reason, facts) = match outcome {
        Err(_) => (RunStatus::NotEvaluated, Some(format!("superó su límite de {} s", meta.timeout_secs)), None),
        Ok(Err(_)) => (RunStatus::NotEvaluated, Some("error inesperado de la regla".to_string()), None),
        Ok(Ok(Err(reason))) => (RunStatus::NotEvaluated, Some(reason), None),
        Ok(Ok(Ok(Facts::NotApplicable(reason)))) => (RunStatus::NotApplicable, Some(reason), None),
        Ok(Ok(Ok(Facts::Found(value)))) => (RunStatus::Facts, None, Some(value)),
    };
    RuleRun {
        id: meta.id.to_string(),
        title: meta.title.to_string(),
        severity: meta.severity.to_string(),
        categories: meta.categories.iter().map(|c| c.to_string()).collect(),
        status,
        reason,
        facts,
        matched: cx.matched.to_vec(),
        instruction: meta.instruction.to_string(),
        millis: started.elapsed().as_millis() as u64,
    }
}

/// Everything a set of rules runs against.
pub struct RunInput<'a> {
    pub level: &'a str,
    pub files: &'a [PrFile],
    pub source: &'a dyn FileSource,
    pub net: &'a dyn Net,
    pub today: chrono::NaiveDate,
    pub now: i64,
}

/// Runs, side by side, every rule that is on, belongs to this level and matches a changed path.
/// A rule that matches nothing does not appear at all — it did not run.
pub async fn run(rules: &[Box<dyn Rule>], input: &RunInput<'_>, enabled: &(dyn Fn(&RuleMeta) -> bool + Sync)) -> Vec<RuleRun> {
    let selected: Vec<(&dyn Rule, Vec<String>)> = rules
        .iter()
        .map(|r| r.as_ref())
        .filter(|r| enabled(r.meta()) && runs_at(r.meta(), input.level))
        .filter_map(|r| {
            let m = matched(r.meta(), input.files);
            (!m.is_empty()).then_some((r, m))
        })
        .collect();
    let futures = selected.iter().map(|(rule, matched)| async move {
        let cx = RuleCx { matched, files: input.files, source: input.source, net: input.net, today: input.today, now: input.now };
        run_one(*rule, &cx).await
    });
    futures_util::future::join_all(futures).await
}

/// The `#`-commented block for the reviewer. Only runs with facts reach it: "does not apply" is
/// nothing to judge, and a rule that could not run at all is said in the report instead of asking
/// the model to write a finding about the network.
pub fn block(runs: &[&RuleRun]) -> Option<String> {
    let rows: Vec<&&RuleRun> = runs.iter().filter(|r| r.status == RunStatus::Facts).collect();
    if rows.is_empty() {
        return None;
    }
    let mut out = String::from(
        "#\n# --- REGLAS DETERMINISTAS (hechos que una herramienta juntó en el commit del PR; júzgalos tú) ---\n",
    );
    for run in rows {
        out.push_str(&format!(
            "# [{}] {} · severidad sugerida {} · categoría {}\n",
            run.id,
            run.title,
            run.severity,
            run.categories.join(" / ")
        ));
        out.push_str(&format!("#   Archivos que la activaron: {}\n", run.matched.join(", ")));
        out.push_str(&format!("#   Instrucción: {}\n", run.instruction));
        let facts = run.facts.as_ref().map(|f| serde_json::to_string(f).unwrap_or_default()).unwrap_or_default();
        out.push_str(&format!("#   Hechos: {facts}\n"));
    }
    out.push_str(
        "#   A lo sumo UN hallazgo por sujeto de cada regla (el que dice su instrucción), con la categoría de la regla\n\
         #   y su id entre corchetes al inicio del porqué (p. ej. \"[R-0002] …\"). Los hechos ya están verificados: no los\n\
         #   re-derives; decide si son un problema real en este PR. Nunca escribas el valor de un secreto.\n\
         #   Usa la severidad sugerida de la regla aunque este nivel no la liste: los hallazgos de regla se reportan igual.\n",
    );
    Some(out)
}

/// `R-0002 con hechos · R-0004 no evaluada (registry.npmjs.org: sin autorización)` — short, for the
/// log and the report.
pub fn summary(runs: &[RuleRun]) -> String {
    let short = |reason: &Option<String>| -> String {
        let text = reason.as_deref().unwrap_or("");
        if text.chars().count() > 90 {
            format!("{}…", text.chars().take(89).collect::<String>())
        } else {
            text.to_string()
        }
    };
    runs.iter()
        .map(|r| match r.status {
            RunStatus::Facts => format!("{} con hechos", r.id),
            RunStatus::NotApplicable => format!("{} sin nada que reportar", r.id),
            RunStatus::NotEvaluated => format!("{} no evaluada ({})", r.id, short(&r.reason)),
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::source::fake::{FakeNet, Files};
    use super::*;

    static SLOW: RuleMeta = RuleMeta {
        id: "R-T1",
        title: "lenta",
        severity: "Menor",
        categories: &["x"],
        paths: &["**/*.ts"],
        levels: &["completo"],
        enabled: true,
        timeout_secs: 1,
        instruction: "i",
    };
    static PANICS: RuleMeta = RuleMeta { id: "R-T2", title: "rompe", paths: &["src/**"], ..SLOW_BASE };
    static FAILS: RuleMeta = RuleMeta { id: "R-T3", title: "falla", paths: &["package.json"], ..SLOW_BASE };
    static ULTRA: RuleMeta = RuleMeta { id: "R-T4", title: "ultra", levels: &["ultra"], ..SLOW_BASE };
    const SLOW_BASE: RuleMeta = RuleMeta {
        id: "",
        title: "",
        severity: "Menor",
        categories: &[],
        paths: &["**"],
        levels: &["completo"],
        enabled: true,
        timeout_secs: 5,
        instruction: "i",
    };

    struct Slow;
    impl Rule for Slow {
        fn meta(&self) -> &'static RuleMeta {
            &SLOW
        }
        fn evaluate<'a>(&'a self, _cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(Facts::Found(Value::Null))
            })
        }
    }
    struct Panics;
    impl Rule for Panics {
        fn meta(&self) -> &'static RuleMeta {
            &PANICS
        }
        fn evaluate<'a>(&'a self, _cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
            Box::pin(async { panic!("boom") })
        }
    }
    struct Fails;
    impl Rule for Fails {
        fn meta(&self) -> &'static RuleMeta {
            &FAILS
        }
        fn evaluate<'a>(&'a self, _cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
            Box::pin(async { Err("sin red".to_string()) })
        }
    }
    struct Ultra;
    impl Rule for Ultra {
        fn meta(&self) -> &'static RuleMeta {
            &ULTRA
        }
        fn evaluate<'a>(&'a self, cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
            let n = cx.matched.len();
            Box::pin(async move { Ok(Facts::Found(serde_json::json!({ "n": n }))) })
        }
    }

    fn pr(paths: &[&str]) -> Vec<PrFile> {
        paths.iter().map(|p| PrFile { path: p.to_string(), ..Default::default() }).collect()
    }

    #[tokio::test]
    async fn a_failing_rule_never_stops_the_others() {
        let rules: Vec<Box<dyn Rule>> = vec![Box::new(Slow), Box::new(Panics), Box::new(Fails), Box::new(Ultra)];
        let files = pr(&["src/a.ts", "package.json"]);
        let (source, net) = (Files::default(), FakeNet::default());
        let input = RunInput { level: "completo", files: &files, source: &source, net: &net, today: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), now: 0 };
        let runs = run(&rules, &input, &|_| true).await;
        let got: Vec<(&str, RunStatus, Option<&str>)> = runs.iter().map(|r| (r.id.as_str(), r.status, r.reason.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                ("R-T1", RunStatus::NotEvaluated, Some("superó su límite de 1 s")),
                ("R-T2", RunStatus::NotEvaluated, Some("error inesperado de la regla")),
                ("R-T3", RunStatus::NotEvaluated, Some("sin red")),
            ]
        );
        // Ultra-only: not at completo. Disabled: not at all.
        let ultra = RunInput { level: "ultra", ..input };
        let runs = run(&rules, &ultra, &|m| m.id == "R-T4").await;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].facts, Some(serde_json::json!({ "n": 2 })));
        assert_eq!(summary(&runs), "R-T4 con hechos");
        assert!(block(&runs.iter().collect::<Vec<_>>()).unwrap().contains("Hechos: {\"n\":2}"));
    }

    #[test]
    fn paths_match_like_people_write_them() {
        let meta = RuleMeta { paths: &["**/env/**", "package.json", "**/Dockerfile*"], ..SLOW_BASE };
        let files = pr(&["env/settings/settings.json", "apps/api/env/x.json", "apps/api/package.json", "Dockerfile.prod", "src/environment.ts"]);
        assert_eq!(matched(&meta, &files), ["env/settings/settings.json", "apps/api/env/x.json", "apps/api/package.json", "Dockerfile.prod"]);
        assert_eq!(capped((0..45).map(|n| format!("k{n:02}"))).last().unwrap(), "+5 más");
    }

    #[test]
    fn every_registered_rule_is_well_formed() {
        let ids: Vec<&str> = catalog().iter().map(|m| m.id).collect();
        assert_eq!(ids, ["R-0001", "R-0002", "R-0003", "R-0004"]);
        // The reference tool's severities: a "can be bumped" note must never fail a gate on Menor.
        let severities: Vec<&str> = catalog().iter().map(|m| m.severity).collect();
        assert_eq!(severities, ["Info", "Mayor", "Info", "Info"]);
        for meta in catalog() {
            assert!(!meta.levels.iter().any(|l| crate::review::contract::normalize_level(l) == "basico"), "{}", meta.id);
        }
        for meta in catalog() {
            assert!(!meta.paths.is_empty() && !meta.levels.is_empty() && !meta.categories.is_empty() && meta.timeout_secs > 0);
            assert!(crate::review::contract::Severity::parse(meta.severity).is_some(), "{}", meta.id);
        }
    }
}
