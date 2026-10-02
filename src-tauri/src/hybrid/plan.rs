//! The plan: what the subscription CLI is asked to produce, how its answer is read, and what is
//! checked before anything in it reaches the local model. The review's answer in the local fix loop
//! is the same thing in smaller form — a verdict and a list of tasks — and goes through the same
//! checks.
//!
//! The schemas are written in the strict dialect (every property required, nullable where optional,
//! no additional properties) because that is what Codex's `--output-schema` enforces, and Claude's
//! `--json-schema` accepts it as well — one schema for both CLIs that can hold a model to one.
//! Every other engine gets the same shape described in words, and its answer goes through the same
//! lenient reader.
//!
//! A run may span several repositories (one plan across a front end and its API). Every task, every
//! reference and every check names its repository; with a single repository that name is a
//! formality the reader does not hold the planner to.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};

/// The most tasks a plan may hold. Each is one local request, and a plan this long is already an
/// afternoon on a laptop.
pub const MAX_TASKS: usize = 40;
/// The most fixes one review round may hand back. A review that finds more than this is not a list
/// of corrections, it is a second plan.
pub const MAX_FIXES: usize = 12;
pub const MAX_INSTRUCTION_CHARS: usize = 6_000;
pub const MAX_CONTEXT_REFS: usize = 12;
pub const MAX_ACCEPTANCE: usize = 10;
pub const MAX_CHECKS: usize = 5;

/// One task, as both the plan and the review's fixes write it.
macro_rules! task_schema {
    () => {
        r#"{"type":"object","additionalProperties":false,"required":["id","title","repo","file","action","regions","instruction","context","acceptance","depends_on","difficulty"],"properties":{"id":{"type":"string"},"title":{"type":"string"},"repo":{"type":"string"},"file":{"type":"string"},"action":{"type":"string","enum":["create","modify","delete"]},"regions":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["start_line","end_line","first_line"],"properties":{"start_line":{"type":"integer"},"end_line":{"type":"integer"},"first_line":{"type":"string"}}}},"instruction":{"type":"string"},"context":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["repo","file","start_line","end_line","first_line","why"],"properties":{"repo":{"type":["string","null"]},"file":{"type":"string"},"start_line":{"type":["integer","null"]},"end_line":{"type":["integer","null"]},"first_line":{"type":["string","null"]},"why":{"type":"string"}}}},"acceptance":{"type":"array","items":{"type":"string"}},"depends_on":{"type":"array","items":{"type":"string"}},"difficulty":{"type":"string","enum":["easy","medium","hard"]}}}"#
    };
}

/// What the planner's answer must match.
pub const PLAN_SCHEMA: &str = concat!(
    r#"{"type":"object","additionalProperties":false,"required":["summary","tasks","checks","risks"],"properties":{"summary":{"type":"string"},"tasks":{"type":"array","items":"#,
    task_schema!(),
    r#"},"checks":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["repo","command"],"properties":{"repo":{"type":"string"},"command":{"type":"string"}}}},"risks":{"type":"array","items":{"type":"string"}}}}"#
);

/// What a review in the local fix loop must answer with: whether the work is right, and if not,
/// the corrections — as tasks for the local model, in the plan's own shape.
pub const REVIEW_SCHEMA: &str = concat!(
    r#"{"type":"object","additionalProperties":false,"required":["verdict","summary","fixes"],"properties":{"verdict":{"type":"string","enum":["ok","fix","pending"]},"summary":{"type":"string"},"fixes":{"type":"array","items":"#,
    task_schema!(),
    r#"}}}"#
);

/// One of the run's repositories, as the plan refers to it: by `name`, which is what the planner
/// is told; the rest is what the reader resolves the name to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoRef {
    pub project_id: String,
    pub name: String,
    pub path: String,
}

/// A span of an existing file the local model rewrites, instead of the whole file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Region {
    /// 1-based, inclusive, as numbered in the file when the plan was written.
    pub start_line: u32,
    pub end_line: u32,
    /// The text of `start_line`, trimmed — what finds the region again when the line numbers have
    /// moved (another task, the user, a formatter).
    pub first_line: String,
}

/// A piece of the repository the local model is shown for reference and never rewrites.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextRef {
    /// The repository it is in: a name as the planner wrote it, the project id once validated.
    /// `None` is the task's own.
    #[serde(default)]
    pub repo: Option<String>,
    pub file: String,
    /// `None` with `end_line` for the whole file — meant for short files only.
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    #[serde(default)]
    pub first_line: Option<String>,
    #[serde(default)]
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanTask {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// A repository name as the planner wrote it; the project id once validated.
    #[serde(default)]
    pub repo: String,
    pub file: String,
    pub action: String,
    #[serde(default)]
    pub regions: Vec<Region>,
    pub instruction: String,
    #[serde(default)]
    pub context: Vec<ContextRef>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "medium")]
    pub difficulty: String,
}

fn medium() -> String {
    "medium".to_string()
}

/// A command that validates the change, and the repository it runs in — a name as the planner
/// wrote it, the project id once validated (empty: the run's first repository).
///
/// Read from either shape: the object the schema asks for, or the bare command string an engine
/// that cannot be held to a schema tends to write (and that runs written before checks had a
/// repository stored).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanCheck {
    #[serde(default)]
    pub repo: String,
    pub command: String,
}

impl<'de> Deserialize<'de> for PlanCheck {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Shape {
            Bare(String),
            Full {
                #[serde(default)]
                repo: Option<String>,
                command: String,
            },
        }
        Ok(match Shape::deserialize(deserializer)? {
            Shape::Bare(command) => PlanCheck { repo: String::new(), command },
            Shape::Full { repo, command } => PlanCheck { repo: repo.unwrap_or_default(), command },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub summary: String,
    pub tasks: Vec<PlanTask>,
    #[serde(default)]
    pub checks: Vec<PlanCheck>,
    #[serde(default)]
    pub risks: Vec<String>,
}

/// A review's answer in the local fix loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Review {
    /// `ok` | `fix` | `pending`.
    pub verdict: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub fixes: Vec<PlanTask>,
}

/// Reads a plan out of an answer: the bare object a schema-constrained CLI returns, or an object
/// somewhere in prose and fences from one that is not.
pub fn parse(answer: &str) -> Result<Plan, String> {
    let json = crate::ai::json_answer(answer).ok_or_else(|| "The answer contains no JSON object.".to_string())?;
    serde_json::from_str::<Plan>(&json).map_err(|e| format!("The plan is not in the expected shape: {e}"))
}

/// Reads a review out of an answer, as [`parse`] reads a plan. The verdict is normalised to lower
/// case; anything but the three words is refused.
pub fn parse_review(answer: &str) -> Result<Review, String> {
    let json = crate::ai::json_answer(answer).ok_or_else(|| "The answer contains no JSON object.".to_string())?;
    let mut review = serde_json::from_str::<Review>(&json).map_err(|e| format!("The review is not in the expected shape: {e}"))?;
    review.verdict = review.verdict.trim().to_ascii_lowercase();
    if !matches!(review.verdict.as_str(), "ok" | "fix" | "pending") {
        return Err(format!("\"{}\" is not a verdict; use ok, fix or pending.", review.verdict));
    }
    review.summary = review.summary.trim().chars().take(4_000).collect();
    Ok(review)
}

/// A repository-relative path as the plan should have written it, or `None` when it cannot be one:
/// absolute, climbing out with `..`, or inside `.git`.
pub fn clean_path(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace('\\', "/");
    let normalized = normalized.trim_start_matches("./");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            other => parts.push(other),
        }
    }
    if parts.first() == Some(&".git") || parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn line_count(path: &Path) -> Option<usize> {
    std::fs::read_to_string(path).ok().map(|text| text.lines().count())
}

/// The repository a task, reference or check names. With one repository every name means it — the
/// planner was told so, and holding it to the spelling would refuse plans for nothing. With several,
/// a name or a project id; failing that, the one repository where `file` already exists.
fn resolve_repo<'a>(raw: &str, file: Option<&str>, repos: &'a [RepoRef]) -> Option<&'a RepoRef> {
    if repos.len() == 1 {
        return repos.first();
    }
    let wanted = raw.trim().trim_end_matches('/');
    if !wanted.is_empty() {
        let found = repos.iter().find(|repo| {
            repo.project_id == wanted
                || repo.name.eq_ignore_ascii_case(wanted)
                || Path::new(&repo.path) == Path::new(wanted)
        });
        if found.is_some() {
            return found;
        }
    }
    let file = file?;
    let mut holding = repos.iter().filter(|repo| Path::new(&repo.path).join(file).is_file());
    match (holding.next(), holding.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

fn repo_names(repos: &[RepoRef]) -> String {
    repos.iter().map(|repo| repo.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// Checks a plan against the repositories it is about, repairing what can be repaired without
/// guessing and refusing what cannot. `Err` holds every problem, worded for the planner, which is
/// who reads them on the retry.
///
/// Repaired quietly, because each has exactly one sensible reading: a `create` for a file that
/// exists (it is a whole-file rewrite), a `modify` for one that does not (it is a create), a region
/// with no `first_line` (read from the file), an unknown difficulty (medium), references to files
/// that do not exist and dependencies on tasks that do not exist (dropped), a check naming no known
/// repository (dropped — checks are optional).
///
/// On the way out every `repo` holds a project id.
pub fn validate(mut plan: Plan, repos: &[RepoRef]) -> Result<Plan, Vec<String>> {
    let mut problems = Vec::new();
    if plan.tasks.is_empty() {
        problems.push("The plan has no tasks.".to_string());
    }
    if plan.tasks.len() > MAX_TASKS {
        problems.push(format!(
            "The plan has {} tasks; merge them into at most {MAX_TASKS} (one per file).",
            plan.tasks.len()
        ));
    }
    validate_tasks(&mut plan.tasks, repos, &mut problems);
    plan.checks = plan
        .checks
        .iter()
        .filter_map(|check| {
            let command = check.command.trim().to_string();
            if command.is_empty() || command.chars().count() > 300 || command.contains('\n') {
                return None;
            }
            let repo = resolve_repo(&check.repo, None, repos).or_else(|| check.repo.trim().is_empty().then(|| repos.first()).flatten())?;
            Some(PlanCheck { repo: repo.project_id.clone(), command })
        })
        .take(MAX_CHECKS)
        .collect();
    plan.summary = plan.summary.trim().chars().take(1_000).collect();
    plan.risks = plan.risks.iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).take(10).collect();

    if problems.is_empty() {
        Ok(plan)
    } else {
        Err(problems)
    }
}

/// Checks a review round's fixes the way [`validate`] checks a plan's tasks. An empty list is not
/// a problem here — the caller decides what a `fix` verdict with nothing to fix means.
pub fn validate_fixes(mut fixes: Vec<PlanTask>, repos: &[RepoRef]) -> Result<Vec<PlanTask>, Vec<String>> {
    let mut problems = Vec::new();
    if fixes.len() > MAX_FIXES {
        problems.push(format!(
            "You returned {} fixes; merge them into at most {MAX_FIXES} (one per file), or implement the rest yourself.",
            fixes.len()
        ));
    }
    validate_tasks(&mut fixes, repos, &mut problems);
    if problems.is_empty() {
        Ok(fixes)
    } else {
        Err(problems)
    }
}

fn validate_tasks(tasks: &mut [PlanTask], repos: &[RepoRef], problems: &mut Vec<String>) {
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_files: std::collections::HashMap<(String, String), String> = std::collections::HashMap::new();
    for task in tasks.iter_mut() {
        task.id = task.id.trim().to_string();
        if task.id.is_empty() || !seen_ids.insert(task.id.clone()) {
            problems.push(format!("Task ids must be unique and non-empty (\"{}\").", task.id));
        }
        let Some(file) = clean_path(&task.file) else {
            problems.push(format!("Task {}: \"{}\" is not a path inside the repository.", task.id, task.file));
            continue;
        };
        task.file = file.clone();
        let Some(repo) = resolve_repo(&task.repo, Some(&file), repos) else {
            problems.push(format!(
                "Task {}: \"{}\" is not one of this run's repositories ({}).",
                task.id,
                task.repo,
                repo_names(repos)
            ));
            continue;
        };
        task.repo = repo.project_id.clone();
        let root = PathBuf::from(&repo.path);
        if let Some(other) = seen_files.insert((repo.project_id.clone(), file.clone()), task.id.clone()) {
            problems.push(format!(
                "Tasks {other} and {} both change {file}. Put every change to a file in one task.",
                task.id
            ));
        }
        if task.title.trim().is_empty() {
            task.title = file.clone();
        }
        task.title = task.title.trim().chars().take(120).collect();
        if task.instruction.trim().is_empty() {
            problems.push(format!("Task {} has no instruction.", task.id));
        }
        if task.instruction.chars().count() > MAX_INSTRUCTION_CHARS {
            problems.push(format!(
                "Task {}'s instruction is longer than {MAX_INSTRUCTION_CHARS} characters; split the file's work into regions or tighten it.",
                task.id
            ));
        }
        if !matches!(task.difficulty.as_str(), "easy" | "medium" | "hard") {
            task.difficulty = medium();
        }

        let full = root.join(&file);
        let exists = full.is_file();
        task.action = match (task.action.as_str(), exists) {
            ("delete", false) => {
                problems.push(format!("Task {} deletes {file}, which does not exist.", task.id));
                "delete".to_string()
            }
            ("delete", true) => "delete".to_string(),
            ("create", true) | ("modify", true) => "modify".to_string(),
            ("create", false) | ("modify", false) => "create".to_string(),
            (other, _) => {
                problems.push(format!("Task {}: unknown action \"{other}\".", task.id));
                other.to_string()
            }
        };

        if task.action != "modify" {
            task.regions.clear();
        } else if !task.regions.is_empty() {
            let lines: Vec<String> = std::fs::read_to_string(&full)
                .map(|text| text.lines().map(str::to_string).collect())
                .unwrap_or_default();
            task.regions.sort_by_key(|region| region.start_line);
            let mut previous_end = 0u32;
            for region in task.regions.iter_mut() {
                if region.start_line == 0 || region.end_line < region.start_line || region.end_line as usize > lines.len() {
                    problems.push(format!(
                        "Task {}: region {}-{} is outside {file}, which has {} lines.",
                        task.id,
                        region.start_line,
                        region.end_line,
                        lines.len()
                    ));
                    continue;
                }
                if region.start_line <= previous_end {
                    problems.push(format!("Task {}: regions in {file} overlap; merge them.", task.id));
                }
                previous_end = region.end_line;
                if region.first_line.trim().is_empty() {
                    region.first_line = lines[region.start_line as usize - 1].trim().to_string();
                } else {
                    region.first_line = region.first_line.trim().to_string();
                }
            }
        }

        let own = repo.project_id.clone();
        task.context.retain_mut(|reference| {
            let Some(path) = clean_path(&reference.file) else { return false };
            let named = reference.repo.as_deref().unwrap_or("").trim();
            let target = if named.is_empty() { repos.iter().find(|r| r.project_id == own) } else { resolve_repo(named, Some(&path), repos) };
            match target {
                Some(target) if Path::new(&target.path).join(&path).is_file() => {
                    reference.file = path;
                    reference.repo = Some(target.project_id.clone());
                    true
                }
                _ => false,
            }
        });
        task.context.truncate(MAX_CONTEXT_REFS);
        for reference in task.context.iter_mut() {
            let base = reference
                .repo
                .as_deref()
                .and_then(|id| repos.iter().find(|r| r.project_id == id))
                .map(|r| PathBuf::from(&r.path))
                .unwrap_or_else(|| root.clone());
            if let (Some(start), Some(end)) = (reference.start_line, reference.end_line) {
                let total = line_count(&base.join(&reference.file)).unwrap_or(0) as u32;
                if start == 0 || end < start || start > total {
                    reference.start_line = None;
                    reference.end_line = None;
                } else if end > total {
                    reference.end_line = Some(total);
                }
            } else {
                reference.start_line = None;
                reference.end_line = None;
            }
        }
        task.acceptance.retain(|line| !line.trim().is_empty());
        task.acceptance.truncate(MAX_ACCEPTANCE);
    }

    let ids: std::collections::HashSet<String> = tasks.iter().map(|t| t.id.clone()).collect();
    for task in tasks.iter_mut() {
        let own = task.id.clone();
        task.depends_on.retain(|id| ids.contains(id) && id != &own);
    }
}

/// The note an unusable plan goes back to the planner with.
pub fn rejection_note(problems: &[String]) -> String {
    let mut note = String::from(
        "The plan you returned could not be used. Return the whole plan again as JSON in the same \
         shape, fixing these problems:\n",
    );
    for problem in problems {
        note.push_str(&format!("- {problem}\n"));
    }
    note
}

/// The note an unusable review goes back to the reviewer with.
pub fn review_rejection_note(problems: &[String]) -> String {
    let mut note = String::from(
        "Your review could not be used. Answer again with the review as JSON in the same shape \
         (verdict, summary, fixes), fixing these problems:\n",
    );
    for problem in problems {
        note.push_str(&format!("- {problem}\n"));
    }
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-hybrid-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src/lib")).unwrap();
        std::fs::write(dir.join("src/api.ts"), (1..=60).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
        std::fs::write(dir.join("src/types.ts"), "export interface Invoice { id: string }\n").unwrap();
        dir
    }

    fn one(root: &Path) -> Vec<RepoRef> {
        vec![RepoRef { project_id: "p1".into(), name: "shop".into(), path: root.to_string_lossy().into_owned() }]
    }

    fn task(id: &str, file: &str, action: &str) -> PlanTask {
        PlanTask {
            id: id.into(),
            title: String::new(),
            repo: String::new(),
            file: file.into(),
            action: action.into(),
            regions: vec![],
            instruction: "Do the thing.".into(),
            context: vec![],
            acceptance: vec![],
            depends_on: vec![],
            difficulty: "easy".into(),
        }
    }

    fn check(command: &str) -> PlanCheck {
        PlanCheck { repo: String::new(), command: command.into() }
    }

    #[test]
    fn the_schemas_are_valid_json_in_the_strict_dialect() {
        for schema in [PLAN_SCHEMA, REVIEW_SCHEMA] {
            let schema: serde_json::Value = serde_json::from_str(schema).expect("valid JSON");
            assert_eq!(schema["additionalProperties"], false);
            let required = schema["required"].as_array().unwrap().len();
            assert_eq!(required, schema["properties"].as_object().unwrap().len(), "strict mode wants every property required");
        }
        let plan: serde_json::Value = serde_json::from_str(PLAN_SCHEMA).unwrap();
        let review: serde_json::Value = serde_json::from_str(REVIEW_SCHEMA).unwrap();
        assert_eq!(plan["properties"]["tasks"]["items"], review["properties"]["fixes"]["items"], "one task shape for both");
        let task = &plan["properties"]["tasks"]["items"];
        let required: Vec<&str> = task["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let properties: Vec<&String> = task["properties"].as_object().unwrap().keys().collect();
        assert_eq!(required.len(), properties.len(), "strict mode wants every property required");
        assert!(required.contains(&"repo"));
    }

    #[test]
    fn a_plan_is_read_from_a_bare_object_or_from_prose() {
        let bare = r#"{"summary":"s","tasks":[{"id":"t1","title":"a","repo":"shop","file":"x.ts","action":"create","regions":[],"instruction":"i","context":[],"acceptance":[],"depends_on":[],"difficulty":"easy"}],"checks":[{"repo":"shop","command":"npm test"}],"risks":[]}"#;
        let plan = parse(bare).unwrap();
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(plan.checks[0], PlanCheck { repo: "shop".into(), command: "npm test".into() });
        let wrapped = format!("Here is the plan:\n```json\n{bare}\n```\nGood luck.");
        assert_eq!(parse(&wrapped).unwrap().tasks[0].id, "t1");
        assert!(parse("no json here").is_err());
    }

    #[test]
    fn a_check_written_as_a_bare_string_still_reads() {
        let plan = parse(r#"{"tasks":[],"checks":["pnpm tsc --noEmit"]}"#).unwrap();
        assert_eq!(plan.checks, vec![check("pnpm tsc --noEmit")]);
    }

    #[test]
    fn paths_are_kept_inside_the_repository() {
        assert_eq!(clean_path("./src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(clean_path("src\\b.ts").as_deref(), Some("src/b.ts"));
        assert_eq!(clean_path("../outside.ts"), None);
        assert_eq!(clean_path("/etc/passwd"), None);
        assert_eq!(clean_path("C:/Windows/x"), None);
        assert_eq!(clean_path(".git/config"), None);
    }

    #[test]
    fn actions_are_repaired_to_match_the_disk() {
        let root = repo();
        let plan = Plan {
            summary: String::new(),
            tasks: vec![task("t1", "src/api.ts", "create"), task("t2", "src/new.ts", "modify")],
            checks: vec![],
            risks: vec![],
        };
        let plan = validate(plan, &one(&root)).expect("valid");
        assert_eq!(plan.tasks[0].action, "modify");
        assert_eq!(plan.tasks[1].action, "create");
        assert_eq!(plan.tasks[0].repo, "p1", "a single repository is every task's, whatever it was called");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn two_tasks_on_one_file_and_bad_regions_are_refused() {
        let root = repo();
        let mut second = task("t2", "./src/api.ts", "modify");
        second.regions = vec![Region { start_line: 50, end_line: 90, first_line: String::new() }];
        let plan = Plan {
            summary: String::new(),
            tasks: vec![task("t1", "src/api.ts", "modify"), second],
            checks: vec![],
            risks: vec![],
        };
        let problems = validate(plan, &one(&root)).expect_err("refused");
        assert!(problems.iter().any(|p| p.contains("both change src/api.ts")), "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("outside src/api.ts")), "{problems:?}");
        assert!(rejection_note(&problems).contains("Return the whole plan again"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn regions_get_their_anchor_and_references_are_pruned() {
        let root = repo();
        let mut t = task("t1", "src/api.ts", "modify");
        t.regions = vec![Region { start_line: 10, end_line: 12, first_line: String::new() }];
        t.context = vec![
            ContextRef { repo: None, file: "src/types.ts".into(), start_line: None, end_line: None, first_line: None, why: "type".into() },
            ContextRef { repo: None, file: "src/missing.ts".into(), start_line: Some(1), end_line: Some(3), first_line: None, why: String::new() },
        ];
        t.depends_on = vec!["t9".into(), "t1".into()];
        t.difficulty = "trivial".into();
        let plan = validate(
            Plan { summary: String::new(), tasks: vec![t], checks: vec![check("pnpm tsc --noEmit"), check("a\nb")], risks: vec![] },
            &one(&root),
        )
        .expect("valid");
        let t = &plan.tasks[0];
        assert_eq!(t.regions[0].first_line, "line 10");
        assert_eq!(t.context.len(), 1, "a reference to a missing file is dropped");
        assert_eq!(t.context[0].repo.as_deref(), Some("p1"));
        assert!(t.depends_on.is_empty(), "unknown and self dependencies are dropped");
        assert_eq!(t.difficulty, "medium");
        assert_eq!(plan.checks, vec![PlanCheck { repo: "p1".into(), command: "pnpm tsc --noEmit".into() }], "a multi-line check is not a check");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_plan_across_repositories_names_one_for_every_task() {
        let api = repo();
        let web = repo();
        std::fs::write(web.join("src/page.tsx"), "export const Page = () => null;\n").unwrap();
        let repos = vec![
            RepoRef { project_id: "p-api".into(), name: "api".into(), path: api.to_string_lossy().into_owned() },
            RepoRef { project_id: "p-web".into(), name: "web".into(), path: web.to_string_lossy().into_owned() },
        ];
        let mut front = task("t1", "src/page.tsx", "modify");
        front.repo = "WEB".into();
        front.context = vec![ContextRef {
            repo: Some("api".into()),
            file: "src/types.ts".into(),
            start_line: None,
            end_line: None,
            first_line: None,
            why: "the type it renders".into(),
        }];
        // No name, but the file exists in exactly one of them.
        let back = task("t2", "src/page.tsx", "modify");
        let unknown = PlanTask { repo: "mobile".into(), ..task("t3", "src/app.ts", "create") };
        let plan = Plan {
            summary: String::new(),
            tasks: vec![front.clone(), PlanTask { id: "t2".into(), ..back }],
            checks: vec![PlanCheck { repo: "api".into(), command: "npm test".into() }, PlanCheck { repo: "ios".into(), command: "xcodebuild".into() }],
            risks: vec![],
        };
        let problems = validate(plan, &repos).expect_err("t1 and t2 are the same file in the same repository");
        assert!(problems.iter().any(|p| p.contains("both change src/page.tsx")), "{problems:?}");

        let plan = Plan {
            summary: String::new(),
            tasks: vec![front, unknown],
            checks: vec![PlanCheck { repo: "api".into(), command: "npm test".into() }, PlanCheck { repo: "ios".into(), command: "xcodebuild".into() }],
            risks: vec![],
        };
        let problems = validate(plan.clone(), &repos).expect_err("an unknown repository is refused");
        assert!(problems.iter().any(|p| p.contains("\"mobile\" is not one of this run's repositories (api, web)")), "{problems:?}");

        let plan = Plan { tasks: vec![plan.tasks[0].clone()], ..plan };
        let plan = validate(plan, &repos).expect("valid");
        assert_eq!(plan.tasks[0].repo, "p-web");
        assert_eq!(plan.tasks[0].context[0].repo.as_deref(), Some("p-api"));
        assert_eq!(plan.checks, vec![PlanCheck { repo: "p-api".into(), command: "npm test".into() }], "a check for no known repository is dropped");
        std::fs::remove_dir_all(api).ok();
        std::fs::remove_dir_all(web).ok();
    }

    #[test]
    fn a_review_is_read_and_its_fixes_are_checked_like_a_plan() {
        let root = repo();
        let answer = r#"{"verdict":"FIX","summary":"The guard is inverted.","fixes":[{"id":"f1","title":"Invert the guard","repo":"shop","file":"src/api.ts","action":"modify","regions":[{"start_line":3,"end_line":5,"first_line":""}],"instruction":"Return early when the id is empty.","context":[],"acceptance":[],"depends_on":["f9"],"difficulty":"easy"}]}"#;
        let review = parse_review(answer).unwrap();
        assert_eq!(review.verdict, "fix");
        let fixes = validate_fixes(review.fixes, &one(&root)).expect("valid");
        assert_eq!(fixes[0].regions[0].first_line, "line 3");
        assert!(fixes[0].depends_on.is_empty());
        assert!(parse_review(r#"{"verdict":"maybe","summary":"","fixes":[]}"#).is_err());
        assert!(review_rejection_note(&["x".into()]).contains("verdict, summary, fixes"));
        std::fs::remove_dir_all(root).ok();
    }
}
