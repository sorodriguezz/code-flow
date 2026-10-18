//! What the report lets someone do with a finding after a review: read the rule behind it, mark it
//! a false positive or accepted, review a security hotspot — and see only the findings on code they
//! changed.
//!
//! Triage is written to the local SonarQube, which remembers it across analyses the way it would on
//! a company server (an issue marked a false positive does not come back on the next run), and to
//! the last report kept on disk, so the list on screen agrees without a new review.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::api::SonarClient;

/// A security hotspot: code SonarQube wants a person to look at, not necessarily a vulnerability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    pub key: String,
    pub rule: String,
    pub message: String,
    pub path: String,
    pub line: Option<u32>,
    /// `HIGH`, `MEDIUM` or `LOW` — how likely it is to be a real vulnerability.
    pub probability: String,
    /// SonarQube's security category: `sql-injection`, `weak-cryptography`, `others`…
    pub category: String,
    /// `TO_REVIEW` or `REVIEWED`.
    pub status: String,
    /// `SAFE`, `FIXED` or `ACKNOWLEDGED` once reviewed.
    pub resolution: Option<String>,
}

/// How many hotspots a report keeps.
const HOTSPOT_LIMIT: usize = 1_000;

pub fn hotspot_from(value: &Value, project_key: &str) -> Option<Hotspot> {
    let component = value.get("component")?.as_str()?;
    let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_string);
    Some(Hotspot {
        key: text("key")?,
        rule: value.get("ruleKey").or_else(|| value.get("rule")).and_then(Value::as_str).unwrap_or_default().to_string(),
        message: text("message").unwrap_or_default(),
        path: component.strip_prefix(&format!("{project_key}:")).unwrap_or(component).to_string(),
        line: value.get("line").and_then(Value::as_u64).map(|l| l as u32),
        probability: text("vulnerabilityProbability").unwrap_or_else(|| "LOW".into()),
        category: text("securityCategory").unwrap_or_else(|| "others".into()),
        status: text("status").unwrap_or_else(|| "TO_REVIEW".into()),
        resolution: text("resolution"),
    })
}

fn probability_rank(probability: &str) -> u8 {
    match probability {
        "HIGH" => 0,
        "MEDIUM" => 1,
        _ => 2,
    }
}

/// Every hotspot of the project, still to review first, the likeliest first.
pub async fn hotspots(client: &SonarClient, project_key: &str) -> Result<Vec<Hotspot>, String> {
    let raw = client
        .get_all("api/hotspots/search", &[("project", project_key.to_string())], "hotspots", HOTSPOT_LIMIT)
        .await
        .map_err(String::from)?;
    let mut found: Vec<Hotspot> = raw.iter().filter_map(|h| hotspot_from(h, project_key)).collect();
    found.sort_by(|a, b| {
        (a.status != "TO_REVIEW")
            .cmp(&(b.status != "TO_REVIEW"))
            .then(probability_rank(&a.probability).cmp(&probability_rank(&b.probability)))
            .then(a.path.cmp(&b.path))
            .then(a.line.cmp(&b.line))
    });
    Ok(found)
}

// ------------------------------------------------------------------------------------------- rules

/// A rule as its page in SonarQube explains it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleInfo {
    pub key: String,
    pub name: String,
    /// The language's name (`Java`, `TypeScript`).
    pub language: String,
    /// The explanation, as SonarQube's own HTML: why it matters, how to fix it, references.
    pub sections: Vec<RuleSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleSection {
    /// `introduction`, `root_cause`, `how_to_fix`, `resources` — or `description` for a rule that
    /// has one block only.
    pub key: String,
    pub html: String,
}

/// Rules read this session. A rule's text is the plugin's and does not change while it runs.
static RULES: LazyLock<Mutex<HashMap<String, RuleInfo>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn rule_from(value: &Value) -> Option<RuleInfo> {
    let rule = value.get("rule")?;
    let text = |name: &str| rule.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    let mut sections: Vec<RuleSection> = rule
        .get("descriptionSections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(RuleSection { key: s.get("key")?.as_str()?.to_string(), html: s.get("content")?.as_str()?.to_string() })
        })
        .collect();
    // Older plugins: one HTML block.
    if sections.is_empty() {
        let html = text("htmlDesc");
        if !html.is_empty() {
            sections.push(RuleSection { key: "description".into(), html });
        }
    }
    let order = |key: &str| match key {
        "introduction" | "description" => 0,
        "root_cause" => 1,
        "assess_the_problem" => 2,
        "how_to_fix" => 3,
        _ => 4,
    };
    sections.sort_by_key(|s| order(&s.key));
    Some(RuleInfo { key: text("key"), name: text("name"), language: text("langName"), sections })
}

pub async fn rule(client: &SonarClient, key: &str) -> Result<RuleInfo, String> {
    if let Some(found) = RULES.lock().ok().and_then(|cache| cache.get(key).cloned()) {
        return Ok(found);
    }
    let value = client.get("api/rules/show", &[("key", key.to_string())]).await.map_err(String::from)?;
    let info = rule_from(&value).ok_or_else(|| format!("SonarQube has no rule {key}"))?;
    if let Ok(mut cache) = RULES.lock() {
        cache.insert(key.to_string(), info.clone());
    }
    Ok(info)
}

// ------------------------------------------------------------------------------------------ triage

/// What a person decided about an issue.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IssueVerdict {
    /// Not a problem: the rule is wrong here.
    FalsePositive,
    /// A real problem the team chose to live with ("won't fix").
    Accepted,
}

/// Marks an issue on the server, with the reason as a comment when there is one.
pub async fn decide_issue(client: &SonarClient, issue: &str, verdict: IssueVerdict, comment: &str) -> Result<(), String> {
    if !comment.trim().is_empty() {
        client
            .post("api/issues/add_comment", &[("issue", issue.to_string()), ("text", comment.trim().to_string())])
            .await
            .map_err(String::from)?;
    }
    match verdict {
        IssueVerdict::FalsePositive => transition(client, issue, "falsepositive").await,
        // `accept` since SonarQube 10.4; `wontfix` before it.
        IssueVerdict::Accepted => match transition(client, issue, "accept").await {
            Ok(()) => Ok(()),
            Err(_) => transition(client, issue, "wontfix").await,
        },
    }
}

async fn transition(client: &SonarClient, issue: &str, name: &str) -> Result<(), String> {
    client
        .post("api/issues/do_transition", &[("issue", issue.to_string()), ("transition", name.to_string())])
        .await
        .map(|_| ())
        .map_err(String::from)
}

/// A hotspot reviewed (`SAFE`, `FIXED`, `ACKNOWLEDGED`) or sent back to review (`None`).
pub async fn review_hotspot(client: &SonarClient, hotspot: &str, resolution: Option<&str>, comment: &str) -> Result<(), String> {
    let mut form = vec![("hotspot", hotspot.to_string())];
    match resolution {
        Some(resolution) => {
            if !matches!(resolution, "SAFE" | "FIXED" | "ACKNOWLEDGED") {
                return Err(format!("not a hotspot resolution: {resolution}"));
            }
            form.push(("status", "REVIEWED".into()));
            form.push(("resolution", resolution.to_string()));
        }
        None => form.push(("status", "TO_REVIEW".into())),
    }
    if !comment.trim().is_empty() {
        form.push(("comment", comment.trim().to_string()));
    }
    client.post("api/hotspots/change_status", &form).await.map(|_| ()).map_err(String::from)
}

// ---------------------------------------------------------------------------------------- new code

/// The lines a branch added or changed against its base — "new code" the way a pull request sees
/// it, from git rather than from SonarQube (whose Community Build analyses one branch only).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedLines {
    /// The base it was measured against: the ref asked for, or the one picked.
    pub base: String,
    /// Changed lines per file, as inclusive `[first, last]` runs.
    pub files: HashMap<String, Vec<(u32, u32)>>,
    /// Files that did not exist at the base: every line is new.
    pub added: Vec<String>,
}

/// The base a branch is compared with when none is named: what the remote's HEAD points at, else
/// `main` or `master`.
fn default_base(repo: &git2::Repository) -> Option<String> {
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            return Some(target.trim_start_matches("refs/remotes/").to_string());
        }
    }
    ["origin/main", "origin/master", "main", "master"]
        .iter()
        .find(|name| repo.revparse_single(name).is_ok())
        .map(|name| name.to_string())
}

/// What changed from the merge base of `base` and HEAD to the working tree (commits, staged and
/// unstaged edits, new files git does not ignore).
pub fn changed_lines(repo_path: &str, base: &str) -> Result<ChangedLines, String> {
    let repo = git2::Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let base = if base.trim().is_empty() { default_base(&repo).ok_or("no base branch to compare with (main or master)")? } else { base.trim().to_string() };
    let base_commit = repo
        .revparse_single(&base)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| format!("{base}: {}", e.message()))?;
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(|e| e.message().to_string())?;
    let fork = repo.merge_base(base_commit.id(), head.id()).map_err(|e| e.message().to_string())?;
    let tree = repo.find_commit(fork).and_then(|c| c.tree()).map_err(|e| e.message().to_string())?;
    let mut options = git2::DiffOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true).context_lines(0);
    let diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut options)).map_err(|e| e.message().to_string())?;

    let mut out = ChangedLines { base, ..Default::default() };
    diff.foreach(
        &mut |delta, _| {
            if matches!(delta.status(), git2::Delta::Added | git2::Delta::Untracked) {
                if let Some(path) = delta.new_file().path() {
                    out.added.push(path.to_string_lossy().replace('\\', "/"));
                }
            }
            true
        },
        None,
        Some(&mut |delta, hunk| {
            if hunk.new_lines() == 0 {
                return true;
            }
            if let Some(path) = delta.new_file().path() {
                let first = hunk.new_start();
                out.files.entry(path.to_string_lossy().replace('\\', "/")).or_default().push((first, first + hunk.new_lines() - 1));
            }
            true
        }),
        None,
    )
    .map_err(|e| e.message().to_string())?;
    out.added.sort();
    Ok(out)
}

/// Rewrites the last report kept for `project_key` — what the list shows after a triage.
pub fn update_last(project_key: &str, change: impl FnOnce(&mut super::analysis::RunSummary)) -> Result<(), String> {
    let Some(mut summary) = super::analysis::last(project_key) else { return Ok(()) };
    change(&mut summary);
    super::analysis::save_last(&summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hotspot_and_a_rule_are_read_from_the_api() {
        let hotspot = serde_json::json!({
            "key": "AY1", "component": "demo:src/db.ts", "line": 12, "message": "Make sure this query is safe",
            "ruleKey": "typescript:S2077", "securityCategory": "sql-injection", "vulnerabilityProbability": "HIGH", "status": "TO_REVIEW"
        });
        let found = hotspot_from(&hotspot, "demo").unwrap();
        assert_eq!((found.path.as_str(), found.line, found.probability.as_str()), ("src/db.ts", Some(12), "HIGH"));

        let rule = serde_json::json!({ "rule": {
            "key": "java:S2095", "name": "Resources should be closed", "langName": "Java",
            "descriptionSections": [
                { "key": "how_to_fix", "content": "<p>Use try-with-resources</p>" },
                { "key": "root_cause", "content": "<p>Leaks</p>" }
            ]
        }});
        let info = rule_from(&rule).unwrap();
        assert_eq!(info.sections.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), vec!["root_cause", "how_to_fix"]);
        let old = serde_json::json!({ "rule": { "key": "x:1", "name": "Old", "htmlDesc": "<p>One block</p>" } });
        assert_eq!(rule_from(&old).unwrap().sections[0].key, "description");
    }

    #[test]
    fn changed_lines_are_measured_from_the_merge_base() {
        let dir = std::env::temp_dir().join(format!("codeflow-newcode-{}", uuid::Uuid::new_v4()));
        let repo = git2::Repository::init(&dir).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let commit = |message: &str, parents: &[&git2::Commit]| {
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, parents).unwrap()
        };
        std::fs::write(dir.join("a.ts"), "one\ntwo\nthree\n").unwrap();
        let first = commit("base", &[]);
        let base = repo.find_commit(first).unwrap();
        repo.branch("main-base", &base, true).unwrap();
        std::fs::write(dir.join("a.ts"), "one\nTWO\nthree\nfour\n").unwrap();
        commit("work", &[&base]);
        std::fs::write(dir.join("b.ts"), "new file\n").unwrap();

        let changed = changed_lines(&dir.to_string_lossy(), "main-base").unwrap();
        assert_eq!(changed.files.get("a.ts"), Some(&vec![(2, 2), (4, 4)]));
        assert_eq!(changed.added, vec!["b.ts".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
