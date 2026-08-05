//! Everything decided *before* a line of code is read: what is in scope, whether this pull request
//! is worth reviewing at all, and how the work is split across workers.
//!
//! All three used to be the model's job, done implicitly and differently every run. Making them a
//! plan has a second payoff beyond determinism: the plan can be shown to the user *before* the
//! review spends anything, which is the difference between "reviewing…" for four minutes and
//! "3 grupos · 12 archivos · nivel completo · lentes 1-5".

use globset::{Glob, GlobSet, GlobSetBuilder};

use super::contract::{LevelContract, ScopeConfig};
use super::outline::ChangedFile;

/// Extensions that do not count as code when deciding whether a pull request is trivial.
const NON_CODE_EXT: [&str; 18] = [
    "md", "txt", "rst", "adoc", "json", "yml", "yaml", "toml", "ini", "cfg", "env", "properties",
    "gitignore", "gitattributes", "editorconfig", "lock", "svg", "png",
];

/// Below this many changed lines, a pull request that touches only documentation and configuration
/// is not worth a review.
const TRIVIAL_LINES: usize = 10;

/// Why a review would be skipped, and whether the human gets a say.
///
/// The distinction is the whole point of the type. A draft or an already-merged pull request is
/// still perfectly reviewable if that is what was asked for, so it *asks*; a two-line README change
/// is not, so it just reports. Nothing here ever blocks on its own — the caller decides, and a
/// `force` flag overrides either.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skip {
    pub reason: String,
    pub requires_confirmation: bool,
}

/// Whether this run reviews the whole pull request or only what moved since the last one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanMode {
    /// No previous run for this pull request: everything in scope gets reviewed.
    First,
    /// A re-review bounded to the files that changed since the previous run. The findings on
    /// untouched files are not re-derived — they persist by definition, and reconciliation carries
    /// them forward.
    Delta,
}

/// One worker's share of the files.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: usize,
    /// Lines this group's worker will actually read — the balancing metric, surfaced so a wildly
    /// lopsided split is visible rather than merely suspected.
    pub weight: usize,
    /// Indices into [`ReviewPlan::files`].
    pub files: Vec<usize>,
}

/// The resolved plan for one review.
#[derive(Debug, Clone)]
pub struct ReviewPlan {
    pub contract: LevelContract,
    pub mode: PlanMode,
    /// The files this review will actually read, after scope and delta filtering.
    pub files: Vec<ChangedFile>,
    /// Paths dropped by the scope globs, so the report can say what it never looked at.
    pub out_of_scope: Vec<String>,
    /// Paths dropped because a re-review is bounded to the delta.
    pub outside_delta: Vec<String>,
    pub groups: Vec<Group>,
    pub skip: Option<Skip>,
    pub additions: usize,
    pub deletions: usize,
}

impl ReviewPlan {
    /// Whether this plan may actually fan out. One group is never worth a second process, and a
    /// level that says `subagents: false` has already decided.
    pub fn parallel(&self) -> bool {
        self.contract.subagents && self.groups.len() > 1
    }

    pub fn files_of(&self, group: &Group) -> Vec<&ChangedFile> {
        group.files.iter().filter_map(|i| self.files.get(*i)).collect()
    }
}

/// Compiles a scope config into `(include, exclude)` matchers.
///
/// A pattern with no separator is also matched anywhere in the tree (`package-lock.json` means "any
/// `package-lock.json`", which is how everyone writes it and never how a bare glob reads it).
/// A pattern that does not compile is dropped rather than fatal: a typo in one exclude must not
/// take the review down with it.
fn build_globs(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        if let Ok(glob) = Glob::new(pattern) {
            builder.add(glob);
        }
        if !pattern.contains('/') {
            if let Ok(glob) = Glob::new(&format!("**/{pattern}")) {
                builder.add(glob);
            }
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}

/// Whether a path survives the scope configuration.
pub fn in_scope(path: &str, scope: &ScopeConfig) -> bool {
    let include = build_globs(&scope.include);
    let exclude = build_globs(&scope.exclude);
    matches_scope(path, &include, &exclude)
}

fn matches_scope(path: &str, include: &GlobSet, exclude: &GlobSet) -> bool {
    // An empty include list means "everything": the absence of a restriction is not a restriction.
    let included = include.is_empty() || include.is_match(path);
    included && !exclude.is_match(path)
}

/// Greedy longest-processing-time distribution: heaviest file first, into whichever group is
/// lightest so far.
///
/// Balances far better than splitting alphabetically when one file weighs ten times the rest —
/// which is the normal shape of a pull request, not the exception.
fn partition(files: &[ChangedFile], max_groups: usize, per_group: usize) -> Vec<Group> {
    if files.is_empty() {
        return Vec::new();
    }
    let per_group = per_group.max(1);
    let wanted = files.len().div_ceil(per_group).max(1);
    let count = wanted.min(max_groups.max(1));

    let mut groups: Vec<Group> =
        (0..count).map(|i| Group { id: i + 1, weight: 0, files: Vec::new() }).collect();

    let mut order: Vec<usize> = (0..files.len()).collect();
    order.sort_by(|a, b| files[*b].weight().cmp(&files[*a].weight()));

    for index in order {
        let lightest = groups
            .iter_mut()
            .min_by_key(|g| g.weight)
            .expect("at least one group");
        lightest.weight += files[index].weight();
        lightest.files.push(index);
    }
    // Stable, readable order inside each group.
    for group in groups.iter_mut() {
        group.files.sort_by(|a, b| files[*a].path.cmp(&files[*b].path));
    }
    groups.retain(|g| !g.files.is_empty());
    // Renumber so the ids are contiguous even if a group came out empty.
    for (i, group) in groups.iter_mut().enumerate() {
        group.id = i + 1;
    }
    groups
}

/// Decides whether this pull request is worth reviewing.
///
/// `pr_status` is the bucketed status the VCS layer already produces (`open` · `draft` · `merged` ·
/// `closed`), so this never has to know one host's raw status from another's.
fn triage(pr_status: &str, files: &[ChangedFile], additions: usize, deletions: usize) -> Option<Skip> {
    match pr_status.to_lowercase().as_str() {
        "draft" => {
            return Some(Skip {
                reason: "El PR está en draft.".to_string(),
                requires_confirmation: true,
            })
        }
        "merged" | "closed" | "completed" | "abandoned" => {
            return Some(Skip {
                reason: format!("El PR está '{pr_status}'."),
                requires_confirmation: true,
            })
        }
        _ => {}
    }

    if files.is_empty() {
        return Some(Skip {
            reason: "No queda ningún archivo dentro del alcance configurado.".to_string(),
            requires_confirmation: false,
        });
    }

    let only_non_code = files.iter().all(|f| {
        f.path
            .rsplit_once('.')
            .map(|(_, ext)| NON_CODE_EXT.contains(&ext.to_lowercase().as_str()))
            .unwrap_or(false)
    });
    if additions + deletions < TRIVIAL_LINES && only_non_code {
        return Some(Skip {
            reason: format!(
                "PR trivial: {} línea(s) cambiadas y solo archivos de doc/config.",
                additions + deletions
            ),
            requires_confirmation: false,
        });
    }
    None
}

/// Builds the plan for one review.
///
/// `changed_since` bounds a re-review to the files that moved since the previous run. `None` means
/// a first review (or one whose previous head could not be resolved — a rebase, a force-push),
/// where the conservative answer is to review everything.
pub fn build(
    files: Vec<ChangedFile>,
    contract: LevelContract,
    scope: &ScopeConfig,
    pr_status: &str,
    changed_since: Option<&[String]>,
) -> ReviewPlan {
    let include = build_globs(&scope.include);
    let exclude = build_globs(&scope.exclude);

    let mut in_scope_files: Vec<ChangedFile> = Vec::new();
    let mut out_of_scope: Vec<String> = Vec::new();
    for file in files {
        if matches_scope(&file.path, &include, &exclude) {
            in_scope_files.push(file);
        } else {
            out_of_scope.push(file.path);
        }
    }

    // The scope line describes what was reviewed, so it is counted after scope filtering and before
    // the delta bound — the delta narrows what is *re-read*, not what the pull request changed.
    let additions: usize = in_scope_files.iter().map(|f| f.changed.len()).sum();
    let deletions: usize = in_scope_files.iter().map(|f| f.deletions).sum();

    let mut mode = PlanMode::First;
    let mut outside_delta: Vec<String> = Vec::new();
    if let Some(changed) = changed_since.filter(|c| !c.is_empty()) {
        mode = PlanMode::Delta;
        let (inside, outside): (Vec<ChangedFile>, Vec<ChangedFile>) = in_scope_files
            .into_iter()
            .partition(|f| changed.iter().any(|c| super::outline::same_path(c, &f.path)));
        // A delta that matched nothing is a delta that could not be trusted (a rename the diff and
        // the ref list spell differently, a force-push): reviewing everything is the conservative
        // answer, and it is what a first review would have done anyway.
        if inside.is_empty() {
            mode = PlanMode::First;
            in_scope_files = outside;
        } else {
            outside_delta = outside.into_iter().map(|f| f.path).collect();
            in_scope_files = inside;
        }
    }

    let skip = triage(pr_status, &in_scope_files, additions, deletions);

    // Only files with content to show can be handed to a worker; a deletion is reported in the
    // scope and reasoned about from the diff, not opened.
    let readable: Vec<ChangedFile> = in_scope_files.into_iter().filter(|f| f.is_readable()).collect();
    let groups = partition(&readable, contract.max_groups, contract.files_per_group);

    ReviewPlan {
        contract,
        mode,
        files: readable,
        out_of_scope,
        outside_delta,
        groups,
        skip,
        additions,
        deletions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::contract::{resolve_level_contract, ReviewEngineConfig};
    use crate::review::outline::Symbol;
    use std::collections::BTreeSet;

    fn file(path: &str, lines: usize, changed: usize) -> ChangedFile {
        let content: String = (1..=lines).map(|i| format!("l{i}\n")).collect();
        ChangedFile {
            path: path.into(),
            status: "modified".into(),
            lines: content.lines().count(),
            content,
            changed: (1..=changed.min(lines)).collect::<BTreeSet<usize>>(),
            deletions: 0,
            symbols: vec![Symbol { start: 1, end: lines.max(1), label: "s".into() }],
        }
    }

    fn contract(level: &str) -> LevelContract {
        resolve_level_contract(level, &ReviewEngineConfig::default())
    }

    #[test]
    fn the_default_scope_drops_what_nobody_reviews() {
        let scope = ScopeConfig::default();
        assert!(in_scope("src/app/foo.ts", &scope));
        assert!(!in_scope("node_modules/pkg/index.js", &scope));
        assert!(!in_scope("src/node_modules/pkg/index.js", &scope));
        assert!(!in_scope("dist/bundle.js", &scope));
        assert!(!in_scope("src/__snapshots__/a.snap", &scope));
    }

    /// A bare filename means "anywhere", which is how every config in the wild writes it.
    #[test]
    fn a_bare_filename_pattern_matches_at_any_depth() {
        let scope = ScopeConfig::default();
        assert!(!in_scope("pnpm-lock.yaml", &scope));
        assert!(!in_scope("apps/web/pnpm-lock.yaml", &scope));
    }

    #[test]
    fn an_include_list_narrows_the_review() {
        let scope = ScopeConfig { include: vec!["src/**".into()], exclude: vec![] };
        assert!(in_scope("src/a.ts", &scope));
        assert!(!in_scope("docs/a.md", &scope));
    }

    /// A typo in one pattern must not take the review down with it.
    #[test]
    fn an_unparseable_pattern_is_dropped_not_fatal() {
        let scope = ScopeConfig { include: vec!["**".into()], exclude: vec!["[".into()] };
        assert!(in_scope("src/a.ts", &scope));
    }

    #[test]
    fn files_are_split_into_balanced_groups() {
        let files = vec![
            file("a.ts", 1000, 10),
            file("b.ts", 100, 5),
            file("c.ts", 100, 5),
            file("d.ts", 100, 5),
        ];
        let groups = partition(&files, 4, 2);
        assert_eq!(groups.len(), 2, "four files at two per group");
        // The heaviest file goes alone; the three light ones balance against it.
        let heavy = groups.iter().find(|g| g.files.len() == 1).expect("one group holds only a.ts");
        assert_eq!(files[heavy.files[0]].path, "a.ts");
    }

    #[test]
    fn the_group_ceiling_holds_even_with_many_files() {
        let files: Vec<ChangedFile> = (0..40).map(|i| file(&format!("f{i}.ts"), 50, 5)).collect();
        let groups = partition(&files, 4, 3);
        assert_eq!(groups.len(), 4, "capped by max_groups, not by files/per_group");
        assert_eq!(groups.iter().map(|g| g.files.len()).sum::<usize>(), 40, "nothing is lost");
    }

    #[test]
    fn ultra_spreads_the_same_work_across_more_workers() {
        let files: Vec<ChangedFile> = (0..12).map(|i| file(&format!("f{i}.ts"), 50, 5)).collect();
        let full = partition(&files, contract("completo").max_groups, contract("completo").files_per_group);
        let ultra = partition(&files, contract("ultra").max_groups, contract("ultra").files_per_group);
        assert!(ultra.len() > full.len(), "fewer files each, read more deeply");
    }

    #[test]
    fn a_draft_asks_before_it_skips() {
        let plan = build(vec![file("a.ts", 50, 5)], contract("completo"), &ScopeConfig::default(), "draft", None);
        let skip = plan.skip.expect("a draft is flagged");
        assert!(skip.requires_confirmation, "it asks rather than refusing");
    }

    #[test]
    fn a_documentation_only_change_is_skipped_without_asking() {
        let mut readme = file("README.md", 20, 3);
        readme.changed = (1..=3).collect();
        let plan = build(vec![readme], contract("completo"), &ScopeConfig::default(), "open", None);
        let skip = plan.skip.expect("a trivial PR is flagged");
        assert!(!skip.requires_confirmation);
        assert!(skip.reason.contains("trivial"));
    }

    #[test]
    fn a_real_change_is_never_skipped() {
        let plan = build(vec![file("src/a.ts", 200, 40)], contract("completo"), &ScopeConfig::default(), "open", None);
        assert!(plan.skip.is_none());
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.groups.len(), 1);
    }

    #[test]
    fn out_of_scope_files_are_reported_rather_than_silently_dropped() {
        let plan = build(
            vec![file("src/a.ts", 50, 5), file("dist/b.js", 50, 5)],
            contract("completo"),
            &ScopeConfig::default(),
            "open",
            None,
        );
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.out_of_scope, vec!["dist/b.js".to_string()]);
    }

    #[test]
    fn a_re_review_is_bounded_to_the_files_that_moved() {
        let plan = build(
            vec![file("src/a.ts", 50, 5), file("src/b.ts", 50, 5)],
            contract("completo"),
            &ScopeConfig::default(),
            "open",
            Some(&["src/b.ts".to_string()]),
        );
        assert_eq!(plan.mode, PlanMode::Delta);
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].path, "src/b.ts");
        assert_eq!(plan.outside_delta, vec!["src/a.ts".to_string()]);
        // The scope still describes the whole pull request, not just what was re-read.
        assert_eq!(plan.additions, 10);
    }

    /// A delta nothing matches is a delta that cannot be trusted — reviewing everything is the
    /// conservative answer, not reviewing nothing.
    #[test]
    fn a_delta_that_matches_nothing_falls_back_to_a_full_review() {
        let plan = build(
            vec![file("src/a.ts", 50, 5)],
            contract("completo"),
            &ScopeConfig::default(),
            "open",
            Some(&["src/gone.ts".to_string()]),
        );
        assert_eq!(plan.mode, PlanMode::First);
        assert_eq!(plan.files.len(), 1);
    }

    #[test]
    fn basico_never_fans_out_however_many_groups_there_are() {
        let files: Vec<ChangedFile> = (0..20).map(|i| file(&format!("f{i}.ts"), 50, 5)).collect();
        let plan = build(files, contract("basico"), &ScopeConfig::default(), "open", None);
        assert!(plan.groups.len() > 1, "the split still happens");
        assert!(!plan.parallel(), "but the level says one pass");
    }
}
