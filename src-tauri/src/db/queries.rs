use chrono::{SubsecRound, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    ActivityLogEntry, AgentChain, AgentChainStep, AgentProject, AgentTask, BenchTab, ChainClaim, ChainDetail,
    ChainRepo, ChainStepBrief, ChainTemplate, ChainTemplateStep, ChatConversationSummary, DocPage,
    JobHistoryEntry, NewChainStep, NewProject, NewStoryWorkItem, Project, ReviewContext, ReviewRunDetail,
    ReviewRunSummary, StoryBatch, StoryBatchDetail, StoryDraft, Workspace, WorkspaceActivityEntry,
    WorkspaceAgent, WorkspaceSkill, WorkspaceTerminal, WorkItemReviewRow,
};

/// The timestamp every record is stamped with, truncated to **microseconds**.
///
/// `Utc::now()` has nanosecond resolution and `to_rfc3339()` prints all nine digits. That extra
/// precision cannot survive a round trip through the shared Supabase project: `timestamptz` holds
/// microseconds, so Postgres *rounds* on the way in (`.496982900` comes back `.496983`) and strips
/// trailing zeros on the way out (`.582389800` comes back `.58239`).
///
/// The sync layer compares a record's timestamp against the one it last agreed with the server on.
/// A value the server cannot store verbatim makes every pulled record look permanently edited here:
/// every push re-sends the whole collection, and — much worse — every genuine incoming edit is read
/// as a simultaneous local one and frozen as a conflict. Truncating here is what makes the value
/// this machine holds and the value the server returns the same instant; `api_sync::same_instant`
/// handles the trailing zeros.
///
/// Microseconds are far finer than anything that distinguishes two edits by a person, and the
/// column is a string in SQLite either way, so nothing else notices.
pub(crate) fn now() -> String {
    Utc::now().trunc_subsecs(6).to_rfc3339()
}

// ---------- workspaces ----------

pub fn create_workspace(conn: &Connection, name: &str, icon: &str, color: &str) -> rusqlite::Result<Workspace> {
    // Appended, not prepended. `list_workspaces` sorts on `sort_order` and the user arranges that
    // order by hand (see `reorder_workspaces`), so a new row taking 0 would push itself in front of
    // an arrangement somebody made on purpose. `MAX + 1` puts it after everything; the `-1` default
    // means the first workspace on a fresh install still starts at 0.
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspaces",
        [],
        |row| row.get(0),
    )?;
    let ws = Workspace {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        icon: icon.to_string(),
        color: color.to_string(),
        sort_order,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ws.id, ws.name, ws.icon, ws.color, ws.sort_order, ws.created_at],
    )?;
    // Seed the workspace's editable prompt overrides with their built-in defaults so a new
    // workspace works out of the box and the user can edit real text rather than an empty box.
    for (kind, default) in WORKSPACE_PROMPT_KINDS {
        conn.execute(
            "INSERT INTO workspace_prompts (workspace_id, kind, content, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![ws.id, kind, default, ws.created_at],
        )?;
    }
    Ok(ws)
}

/// Every per-workspace prompt `kind`, with its built-in default.
///
/// One list, because it is read in four places that must agree — creating a workspace, backfilling
/// an existing one, importing one from a shared collection, and answering "restore default" — and
/// a kind that reaches three of them is a prompt that silently falls back to the wrong text in the
/// fourth.
pub const WORKSPACE_PROMPT_KINDS: &[(&str, &str)] = &[
    ("review_standard", crate::ai::DEFAULT_PR_REVIEW_STANDARD),
    ("pr_description", crate::ai::DEFAULT_PR_DESCRIPTION_TEMPLATE),
    // The PR review engine's own prompts: the depth directive of each level, the lens catalog, and
    // the two roles the pipeline fans out into.
    ("review_lenses", crate::ai::DEFAULT_REVIEW_LENSES),
    ("review_level_basico", crate::ai::DEFAULT_REVIEW_LEVEL_BASICO),
    ("review_level_completo", crate::ai::DEFAULT_REVIEW_LEVEL_COMPLETO),
    ("review_level_ultra", crate::ai::DEFAULT_REVIEW_LEVEL_ULTRA),
    ("review_worker", crate::ai::DEFAULT_REVIEW_WORKER),
    ("review_crossfile", crate::ai::DEFAULT_REVIEW_CROSSFILE),
    ("review_summary", crate::ai::DEFAULT_REVIEW_SUMMARY),
    ("user_stories", crate::ai::DEFAULT_USER_STORIES_TEMPLATE),
    ("story_verify", crate::ai::DEFAULT_STORY_VERIFY_TEMPLATE),
    ("work_item_analyze", crate::ai::DEFAULT_WORK_ITEM_ANALYZE_TEMPLATE),
    ("work_item_bug_analyze", crate::ai::DEFAULT_WORK_ITEM_BUG_ANALYZE_TEMPLATE),
    ("work_item_description", crate::ai::DEFAULT_WORK_ITEM_DESCRIPTION_TEMPLATE),
    ("work_item_criteria", crate::ai::DEFAULT_WORK_ITEM_CRITERIA_TEMPLATE),
    ("work_item_tasks", crate::ai::DEFAULT_WORK_ITEM_TASKS_TEMPLATE),
    ("work_item_tasks_qa", crate::ai::DEFAULT_WORK_ITEM_TASKS_QA_TEMPLATE),
    ("work_item_qa_estimation", crate::ai::DEFAULT_WORK_ITEM_QA_ESTIMATION),
    ("repo_doc", crate::ai::DEFAULT_REPO_DOC_TEMPLATE),
    ("workspace_doc", crate::ai::DEFAULT_WORKSPACE_DOC_TEMPLATE),
];

// ---------- review runs (durable review memory) ----------

/// The `WHERE` every memory read shares: this project, this pull request — **and this repository**.
///
/// The repository clause is the one that isn't obvious. A project row points at a clone and can be
/// re-linked to a different repository; without this, the new repository would inherit the old
/// one's findings for a PR that merely happens to share its number. Runs written before the key
/// existed carry an empty one and are still matched, since back then the project *was* the
/// repository — dropping them would silently erase memory that is still correct.
const MEMORY_SCOPE: &str = "project_id = ?1 AND pr_id = ?2 \
     AND COALESCE(json_extract(meta, '$.repo_key'), '') IN ('', ?3)";

/// How many runs this PR already has — used to number the next iteration.
pub fn count_review_runs(
    conn: &Connection,
    project_id: &str,
    pr_id: i64,
    repo_key: &str,
) -> rusqlite::Result<i64> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM review_runs WHERE {MEMORY_SCOPE}"),
        params![project_id, pr_id, repo_key],
        |row| row.get(0),
    )
}

/// The newest run's `findings` JSON for this PR, if any — read back on a re-review to reconcile
/// against the previous run.
pub fn latest_review_findings(
    conn: &Connection,
    project_id: &str,
    pr_id: i64,
    repo_key: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!("SELECT findings FROM review_runs WHERE {MEMORY_SCOPE} ORDER BY created_at DESC LIMIT 1"),
        params![project_id, pr_id, repo_key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

/// The head commit SHA of this PR's most recent run (from its `meta` JSON), if any — used to
/// detect "nothing changed since last review" and to diff which files changed since.
pub fn latest_review_head(
    conn: &Connection,
    project_id: &str,
    pr_id: i64,
    repo_key: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!(
            "SELECT json_extract(meta, '$.head_sha') FROM review_runs
             WHERE {MEMORY_SCOPE} ORDER BY created_at DESC LIMIT 1"
        ),
        params![project_id, pr_id, repo_key],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|opt| opt.flatten().filter(|s| !s.is_empty()))
}

/// When this PR was last reviewed (RFC 3339, UTC), if ever.
///
/// Used to tell a re-review what has happened *on the pull request* since — a comment written after
/// this instant is one the last run never saw, and so a reason to review again even when the code
/// hasn't moved.
pub fn latest_review_run_at(
    conn: &Connection,
    project_id: &str,
    pr_id: i64,
    repo_key: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!("SELECT created_at FROM review_runs WHERE {MEMORY_SCOPE} ORDER BY created_at DESC LIMIT 1"),
        params![project_id, pr_id, repo_key],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

/// Records one completed review run. `id` reuses the job id so the run and its `job_history` row
/// share identity. `meta`/`findings` are JSON blobs authored by the caller.
#[allow(clippy::too_many_arguments)]
pub fn add_review_run(
    conn: &Connection,
    id: &str,
    project_id: &str,
    workspace_id: &str,
    pr_id: i64,
    iter: i64,
    level: &str,
    meta: &str,
    review_md: &str,
    diff: &str,
    findings: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO review_runs
            (id, project_id, workspace_id, pr_id, iter, level, meta, review_md, diff, findings, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO NOTHING",
        params![id, project_id, workspace_id, pr_id, iter, level, meta, review_md, diff, findings, now()],
    )?;
    Ok(())
}

/// Every saved run in a workspace (across its projects), newest first — the memory manager's list.
/// `pr_title` comes from the run's own `meta` JSON (json_extract); `findings_count` from the
/// length of the `findings` JSON array.
pub fn list_review_runs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ReviewRunSummary>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.project_id, COALESCE(p.name, '—'), r.pr_id,
                COALESCE(json_extract(r.meta, '$.pr_title'), ''),
                r.iter, r.level,
                COALESCE(json_array_length(r.findings), 0),
                r.created_at
         FROM review_runs r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.workspace_id = ?1
         ORDER BY r.created_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(ReviewRunSummary {
            id: row.get(0)?,
            project_id: row.get(1)?,
            project_name: row.get(2)?,
            pr_id: row.get(3)?,
            pr_title: row.get(4)?,
            iter: row.get(5)?,
            level: row.get(6)?,
            findings_count: row.get(7)?,
            created_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

/// The full content of one run, for the viewer / export.
pub fn get_review_run(conn: &Connection, id: &str) -> rusqlite::Result<Option<ReviewRunDetail>> {
    conn.query_row(
        "SELECT id, project_id, pr_id, iter, level, meta, review_md, diff, findings, created_at
         FROM review_runs WHERE id = ?1",
        params![id],
        |row| {
            Ok(ReviewRunDetail {
                id: row.get(0)?,
                project_id: row.get(1)?,
                pr_id: row.get(2)?,
                iter: row.get(3)?,
                level: row.get(4)?,
                meta: row.get(5)?,
                review_md: row.get(6)?,
                diff: row.get(7)?,
                findings: row.get(8)?,
                created_at: row.get(9)?,
            })
        },
    )
    .optional()
}

/// Overwrites a run's `findings` JSON — used when a finding is marked (false-positive / ignored)
/// so the change persists and future re-reviews carry it forward.
pub fn set_review_run_findings(conn: &Connection, id: &str, findings: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE review_runs SET findings = ?2 WHERE id = ?1", params![id, findings])?;
    Ok(())
}

/// Whether a run with this id is already stored. Its own query rather than a `get_review_run` that
/// is thrown away: an import asks this once per folder, and the row it would otherwise load carries
/// the whole review and its diff.
pub fn review_run_exists(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM review_runs WHERE id = ?1", params![id], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
}

pub fn delete_review_run(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM review_runs WHERE id = ?1", params![id])?;
    Ok(())
}

/// Deletes every saved run of one PR (the "clear this PR's history" action).
pub fn delete_review_runs_for_pr(conn: &Connection, project_id: &str, pr_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM review_runs WHERE project_id = ?1 AND pr_id = ?2",
        params![project_id, pr_id],
    )?;
    Ok(())
}

/// Wipes all saved review memory for a workspace (the strong "purge" action).
pub fn purge_workspace_review_runs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM review_runs WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(())
}

// ---------- review engine configuration ----------

/// The workspace's review engine configuration, resolved.
///
/// A missing row, a blank one, or one no version of this build can parse all resolve to the
/// built-in defaults — never to an error. A configuration nobody can read is a reason to review
/// with the standard rules, not a reason to refuse to review.
pub fn get_review_engine_config(
    conn: &Connection,
    workspace_id: &str,
) -> crate::review::contract::ReviewEngineConfig {
    let stored: Option<String> = conn
        .query_row(
            "SELECT config FROM review_engine_config WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    crate::review::contract::ReviewEngineConfig::load(stored.as_deref())
}

/// Saves the workspace's review engine configuration. An empty string clears it back to the
/// built-in defaults, the same way a blank prompt does.
pub fn set_review_engine_config(
    conn: &Connection,
    workspace_id: &str,
    config: &str,
) -> rusqlite::Result<()> {
    if config.trim().is_empty() {
        conn.execute("DELETE FROM review_engine_config WHERE workspace_id = ?1", params![workspace_id])?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO review_engine_config (workspace_id, config, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
        params![workspace_id, config, now()],
    )?;
    Ok(())
}

/// The most recent run of every **other** pull request of one repository — the raw material for
/// [`crate::review::hints`].
///
/// Only the newest run per pull request: an older iteration's findings were superseded by the run
/// that came after it, and carrying all of them would make one long-lived pull request drown out
/// every other. Newest first, which is what makes the first hint seen the most recent one.
pub fn review_runs_for_repo(
    conn: &Connection,
    workspace_id: &str,
    repo_key: &str,
    exclude_pr: i64,
    limit: i64,
) -> rusqlite::Result<Vec<crate::review::hints::PastRun>> {
    let mut stmt = conn.prepare(
        "SELECT pr_id, created_at, findings FROM review_runs r
         WHERE workspace_id = ?1
           AND COALESCE(json_extract(meta, '$.repo_key'), '') = ?2
           AND pr_id != ?3
           AND created_at = (
               SELECT MAX(created_at) FROM review_runs x
               WHERE x.workspace_id = r.workspace_id AND x.pr_id = r.pr_id
                 AND COALESCE(json_extract(x.meta, '$.repo_key'), '') = ?2
           )
         ORDER BY created_at DESC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![workspace_id, repo_key, exclude_pr, limit], |row| {
        Ok(crate::review::hints::PastRun {
            pr_id: row.get(0)?,
            created_at: row.get(1)?,
            findings_json: row.get(2)?,
        })
    })?;
    rows.collect()
}

// ---------- workspace prompts (review standard, PR description) ----------

/// The built-in default text for a prompt `kind` — the fallback when a workspace has no override
/// (or blanked it), and the source for the editor's "restore default".
pub fn workspace_prompt_default(kind: &str) -> &'static str {
    // `work_item_qa_estimation` is in the list but is not a prompt of its own: it is the hours the
    // QA ladder is estimated with, spliced into that template at its slot. It is stored apart so
    // recalibrating the numbers is not an edit to prose.
    WORKSPACE_PROMPT_KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, default)| *default)
        // `review_standard` and anything unexpected fall back to the review methodology.
        .unwrap_or(crate::ai::DEFAULT_PR_REVIEW_STANDARD)
}

/// The workspace's saved override for `kind`, or the built-in default when the row is missing or
/// was blanked (a blank save is how the UI "resets to default"). Never returns an empty string,
/// so callers can use it directly as the prompt.
pub fn get_workspace_prompt(conn: &Connection, workspace_id: &str, kind: &str) -> rusqlite::Result<String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT content FROM workspace_prompts WHERE workspace_id = ?1 AND kind = ?2",
            params![workspace_id, kind],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(match stored {
        Some(c) if !c.trim().is_empty() => c,
        _ => workspace_prompt_default(kind).to_string(),
    })
}

/// Saves the workspace's override for `kind`. Passing the empty string clears the override so the
/// workspace falls back to the built-in default (that's what the "restore default" button does).
pub fn set_workspace_prompt(conn: &Connection, workspace_id: &str, kind: &str, content: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO workspace_prompts (workspace_id, kind, content, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(workspace_id, kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
        params![workspace_id, kind, content, now()],
    )?;
    Ok(())
}

pub fn list_workspaces(conn: &Connection) -> rusqlite::Result<Vec<Workspace>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, icon, color, sort_order, created_at FROM workspaces ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Workspace {
            id: row.get(0)?,
            name: row.get(1)?,
            icon: row.get(2)?,
            color: row.get(3)?,
            sort_order: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// Writes the order the user arranged the workspaces in.
///
/// The same positional contract as [`reorder_projects`]: the caller sends the whole list in its new
/// order and each row takes its index, so anything missing from the list keeps the `sort_order` it
/// had. Unscoped, because workspaces are the top of the tree — there is no parent whose siblings a
/// stale list could renumber by mistake.
pub fn reorder_workspaces(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE workspaces SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    tx.commit()
}

pub fn delete_workspace(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_workspace_color(conn: &Connection, id: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE workspaces SET color = ?1 WHERE id = ?2", params![color, id])?;
    Ok(())
}

pub fn rename_workspace(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE workspaces SET name = ?1 WHERE id = ?2", params![name, id])?;
    Ok(())
}

// ---------- projects ----------

pub fn create_project(conn: &Connection, input: NewProject) -> rusqlite::Result<Project> {
    let project = Project {
        id: Uuid::new_v4().to_string(),
        workspace_id: input.workspace_id,
        name: input.name,
        local_path: input.local_path,
        remote_url: input.remote_url,
        color: input.color,
        icon: input.icon,
        ado_org: input.ado_org,
        ado_project: input.ado_project,
        ado_repo_id: input.ado_repo_id,
        github_owner: input.github_owner,
        github_repo: input.github_repo,
        github_host: input.github_host,
        gitlab_project: input.gitlab_project,
        gitlab_host: input.gitlab_host,
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO projects (id, workspace_id, name, local_path, remote_url, color, icon, ado_org, ado_project, ado_repo_id, github_owner, github_repo, github_host, gitlab_project, gitlab_host, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            project.id,
            project.workspace_id,
            project.name,
            project.local_path,
            project.remote_url,
            project.color,
            project.icon,
            project.ado_org,
            project.ado_project,
            project.ado_repo_id,
            project.github_owner,
            project.github_repo,
            project.github_host,
            project.gitlab_project,
            project.gitlab_host,
            project.sort_order,
            project.created_at,
        ],
    )?;
    Ok(project)
}

fn map_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        local_path: row.get(3)?,
        remote_url: row.get(4)?,
        color: row.get(5)?,
        icon: row.get(6)?,
        ado_org: row.get(7)?,
        ado_project: row.get(8)?,
        ado_repo_id: row.get(9)?,
        github_owner: row.get(10)?,
        github_repo: row.get(11)?,
        github_host: row.get(12)?,
        gitlab_project: row.get(13)?,
        gitlab_host: row.get(14)?,
        sort_order: row.get(15)?,
        created_at: row.get(16)?,
    })
}

const PROJECT_COLUMNS: &str = "id, workspace_id, name, local_path, remote_url, color, icon, ado_org, ado_project, ado_repo_id, github_owner, github_repo, github_host, gitlab_project, gitlab_host, sort_order, created_at";

pub fn list_projects(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Project>> {
    let sql = format!(
        "SELECT {PROJECT_COLUMNS} FROM projects WHERE workspace_id = ?1 ORDER BY sort_order, created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![workspace_id], map_project)?;
    rows.collect()
}

/// Writes the order the user arranged the repositories in.
///
/// Scoped to the workspace, so a list from one cannot renumber another's — the ids come from a
/// screen that shows every workspace at once, and one stale list would otherwise shuffle rows the
/// user never touched. Ids that do not belong to `workspace_id` simply match nothing.
///
/// Positional, not relative: the caller sends the whole list in its new order and each row takes
/// its index. Anything not in the list keeps the `sort_order` it had, which is why the list is
/// expected to be the complete one.
pub fn reorder_projects(
    conn: &Connection,
    workspace_id: &str,
    ids: &[String],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE projects SET sort_order = ?3 WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id, index as i64],
        )?;
    }
    tx.commit()
}

/// Every project in the app, across all workspaces — used to answer "which repo does this
/// pull-request link belong to?", a question that isn't scoped to whatever workspace happens
/// to be open.
pub fn list_all_projects(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY sort_order, created_at");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_project)?;
    rows.collect()
}

pub fn get_project(conn: &Connection, id: &str) -> rusqlite::Result<Option<Project>> {
    let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1");
    conn.query_row(&sql, params![id], map_project).optional()
}

pub fn update_project_color(conn: &Connection, id: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE projects SET color = ?1 WHERE id = ?2", params![color, id])?;
    Ok(())
}

pub fn link_project_ado(
    conn: &Connection,
    id: &str,
    ado_org: &str,
    ado_project: &str,
    ado_repo_id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET ado_org = ?1, ado_project = ?2, ado_repo_id = ?3 WHERE id = ?4",
        params![ado_org, ado_project, ado_repo_id, id],
    )?;
    Ok(())
}

pub fn link_project_github(
    conn: &Connection,
    id: &str,
    github_owner: &str,
    github_repo: &str,
    github_host: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET github_owner = ?1, github_repo = ?2, github_host = ?3 WHERE id = ?4",
        params![github_owner, github_repo, github_host, id],
    )?;
    Ok(())
}

/// Links a project to a GitLab project by its **full path** — every group it is nested under,
/// then the project (`acme/backend/services/auth`). That is the identifier GitLab's own API takes,
/// and unlike GitHub there is no owner/repo pair to split it into.
///
/// Like its siblings this sets only its own provider's columns; clearing the others is
/// [`unlink_project`]'s job, and every caller that re-links calls that first.
pub fn link_project_gitlab(
    conn: &Connection,
    id: &str,
    gitlab_project: &str,
    gitlab_host: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET gitlab_project = ?1, gitlab_host = ?2 WHERE id = ?3",
        params![gitlab_project, gitlab_host, id],
    )?;
    Ok(())
}

/// Clears every VCS link — Azure DevOps, GitHub *and* GitLab — on a project. A project is linked
/// to at most one host at a time, so "disconnect" wipes whichever one is set without the caller
/// needing to know which provider it was.
///
/// Every column matters. This also runs immediately before a project is re-linked to a pasted
/// link's host, and a provider left behind here would still satisfy `linked_repo`'s precedence
/// order — sending the next review at the host the user just navigated away from, silently and
/// without an error.
pub fn unlink_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET ado_org = NULL, ado_project = NULL, ado_repo_id = NULL, \
         github_owner = NULL, github_repo = NULL, github_host = NULL, \
         gitlab_project = NULL, gitlab_host = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn move_project_to_workspace(conn: &Connection, id: &str, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET workspace_id = ?1 WHERE id = ?2",
        params![workspace_id, id],
    )?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- review contexts (per workspace) ----------

pub fn upsert_review_context(
    conn: &Connection,
    id: Option<String>,
    workspace_id: &str,
    name: &str,
    content: &str,
    enabled: bool,
) -> rusqlite::Result<ReviewContext> {
    let ctx = ReviewContext {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        content: content.to_string(),
        enabled,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO review_contexts (id, workspace_id, name, content, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, enabled = excluded.enabled",
        params![ctx.id, ctx.workspace_id, ctx.name, ctx.content, ctx.enabled, ctx.created_at],
    )?;
    Ok(ctx)
}

pub fn list_review_contexts(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ReviewContext>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, name, content, enabled, created_at FROM review_contexts WHERE workspace_id = ?1 ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(ReviewContext {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            name: row.get(2)?,
            content: row.get(3)?,
            enabled: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn delete_review_context(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM review_contexts WHERE id = ?1", params![id])?;
    Ok(())
}


// ---------- workspace skills ----------

pub fn add_workspace_skill(
    conn: &Connection,
    workspace_id: &str,
    skill_name: &str,
    source_repo: &str,
) -> rusqlite::Result<WorkspaceSkill> {
    let skill = WorkspaceSkill {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        skill_name: skill_name.to_string(),
        source_repo: source_repo.to_string(),
        enabled: true,
        installed_at: now(),
    };
    conn.execute(
        "INSERT INTO workspace_skills (id, workspace_id, skill_name, source_repo, enabled, installed_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        params![skill.id, skill.workspace_id, skill.skill_name, skill.source_repo, skill.installed_at],
    )?;
    Ok(skill)
}

fn map_skill(row: &rusqlite::Row) -> rusqlite::Result<WorkspaceSkill> {
    Ok(WorkspaceSkill {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        skill_name: row.get(2)?,
        source_repo: row.get(3)?,
        enabled: row.get(4)?,
        installed_at: row.get(5)?,
    })
}

pub fn list_workspace_skills(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<WorkspaceSkill>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, skill_name, source_repo, enabled, installed_at
         FROM workspace_skills WHERE workspace_id = ?1 ORDER BY installed_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], map_skill)?;
    rows.collect()
}

pub fn get_workspace_skill(conn: &Connection, id: &str) -> rusqlite::Result<Option<WorkspaceSkill>> {
    conn.query_row(
        "SELECT id, workspace_id, skill_name, source_repo, enabled, installed_at FROM workspace_skills WHERE id = ?1",
        params![id],
        map_skill,
    )
    .optional()
}

pub fn set_workspace_skill_enabled(conn: &Connection, id: &str, enabled: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE workspace_skills SET enabled = ?2 WHERE id = ?1", params![id, enabled])?;
    Ok(())
}

pub fn delete_workspace_skill(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_skills WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- workspace SDD/Harness agents ----------

pub fn list_workspace_agents(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<WorkspaceAgent>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, name, role, provider, model, prompt, enabled, sort_order, created_at
         FROM workspace_agents WHERE workspace_id = ?1 ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(WorkspaceAgent {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            name: row.get(2)?,
            role: row.get(3)?,
            provider: row.get(4)?,
            model: row.get(5)?,
            prompt: row.get(6)?,
            enabled: row.get(7)?,
            sort_order: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_workspace_agent(
    conn: &Connection,
    id: Option<String>,
    workspace_id: &str,
    name: &str,
    role: &str,
    provider: &str,
    model: &str,
    prompt: &str,
    enabled: bool,
) -> rusqlite::Result<WorkspaceAgent> {
    let existing = id.as_ref().and_then(|existing_id| {
        conn.query_row(
            "SELECT sort_order, created_at FROM workspace_agents WHERE id = ?1",
            params![existing_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .ok()
    });
    let (sort_order, created_at) = existing.unwrap_or((0, now()));
    let agent = WorkspaceAgent {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        role: role.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        prompt: prompt.to_string(),
        enabled,
        sort_order,
        created_at,
    };
    conn.execute(
        "INSERT INTO workspace_agents (id, workspace_id, name, role, provider, model, prompt, enabled, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, provider = excluded.provider,
            model = excluded.model, prompt = excluded.prompt, enabled = excluded.enabled",
        params![
            agent.id, agent.workspace_id, agent.name, agent.role, agent.provider, agent.model, agent.prompt,
            agent.enabled, agent.sort_order, agent.created_at,
        ],
    )?;
    Ok(agent)
}

pub fn delete_workspace_agent(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_agents WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- agent projects ----------

fn map_agent_project(row: &rusqlite::Row) -> rusqlite::Result<AgentProject> {
    Ok(AgentProject {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        color: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const AGENT_PROJECT_COLUMNS: &str =
    "id, workspace_id, name, description, color, sort_order, created_at, updated_at";

/// The workspace's folders in the order the user arranged them, ties broken by name so a set
/// created in one go (all `sort_order = 0` until the first drag) still reads alphabetically.
pub fn list_agent_projects(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<AgentProject>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {AGENT_PROJECT_COLUMNS} FROM agent_projects WHERE workspace_id = ?1
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_agent_project)?;
    rows.collect()
}

/// Creates when `id` is `None`, otherwise edits in place. A new folder goes to the bottom of the
/// workspace's list, which is where the user just asked for it to appear.
pub fn upsert_agent_project(
    conn: &Connection,
    id: Option<&str>,
    workspace_id: &str,
    name: &str,
    description: &str,
    color: &str,
) -> rusqlite::Result<AgentProject> {
    let stamp = now();
    let Some(existing_id) = id else {
        let sort_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM agent_projects WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )?;
        let project = AgentProject {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            color: color.to_string(),
            sort_order,
            created_at: stamp.clone(),
            updated_at: stamp,
        };
        conn.execute(
            &format!(
                "INSERT INTO agent_projects ({AGENT_PROJECT_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
            ),
            params![
                project.id,
                project.workspace_id,
                project.name,
                project.description,
                project.color,
                project.sort_order,
                project.created_at,
                project.updated_at,
            ],
        )?;
        return Ok(project);
    };

    conn.execute(
        "UPDATE agent_projects SET name = ?2, description = ?3, color = ?4, updated_at = ?5 WHERE id = ?1",
        params![existing_id, name, description, color, stamp],
    )?;
    conn.query_row(
        &format!("SELECT {AGENT_PROJECT_COLUMNS} FROM agent_projects WHERE id = ?1"),
        params![existing_id],
        map_agent_project,
    )
}

/// Unfiles everything the folder held, then drops it. The work outlives the folder — that is the
/// whole point of the membership pointer carrying no foreign key.
pub fn delete_agent_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE agent_tasks SET agent_project_id = '' WHERE agent_project_id = ?1",
        params![id],
    )?;
    tx.execute(
        "UPDATE agent_chains SET agent_project_id = '' WHERE agent_project_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM agent_projects WHERE id = ?1", params![id])?;
    tx.commit()
}

/// `ids` is the section's full order, top to bottom.
pub fn reorder_agent_projects(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE agent_projects SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    tx.commit()
}

/// Files a task in a folder, or unfiles it with `""`.
///
/// None of the four filing/pinning writers touches `updated_at`, deliberately: the list is ordered
/// by it, and putting a task in a folder is not work done on the task — re-stamping would shuffle a
/// month-old task to the top of the tree for having been tidied away.
pub fn set_agent_task_group(conn: &Connection, id: &str, agent_project_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_tasks SET agent_project_id = ?2 WHERE id = ?1",
        params![id, agent_project_id],
    )?;
    Ok(())
}

pub fn set_agent_task_pinned(conn: &Connection, id: &str, pinned: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_tasks SET pinned = ?2 WHERE id = ?1", params![id, pinned])?;
    Ok(())
}

pub fn set_chain_group(conn: &Connection, chain_id: &str, agent_project_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_chains SET agent_project_id = ?2 WHERE id = ?1",
        params![chain_id, agent_project_id],
    )?;
    Ok(())
}

pub fn set_chain_pinned(conn: &Connection, chain_id: &str, pinned: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_chains SET pinned = ?2 WHERE id = ?1", params![chain_id, pinned])?;
    Ok(())
}

// ---------- agent tasks ----------

/// Marks an `activity_log.session_id` as belonging to an agent task rather than to an ordinary
/// chat. Turns are recorded by the same code path either way, so this prefix is what lets the two
/// features own their own conversations: the Agents view lists (and deletes) exactly these, and
/// `list_chat_conversations` skips exactly these.
pub const AGENT_CONVERSATION_PREFIX: &str = "agent-";

/// The grouping pair is **appended**, not slotted in next to `title` where the table carries it:
/// every mapper here reads by position, so inserting a column in the middle would silently shift
/// fifteen `row.get(..)` calls onto their neighbours.
const AGENT_TASK_COLUMNS: &str = "id, workspace_id, project_id, agent_id, agent_name, provider, model, prompt, \
     goal, title, conversation_id, status, turns, last_error, created_at, updated_at, \
     agent_project_id, pinned";

fn map_agent_task(row: &rusqlite::Row) -> rusqlite::Result<AgentTask> {
    Ok(AgentTask {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_id: row.get(2)?,
        agent_id: row.get(3)?,
        agent_name: row.get(4)?,
        provider: row.get(5)?,
        model: row.get(6)?,
        prompt: row.get(7)?,
        goal: row.get(8)?,
        title: row.get(9)?,
        conversation_id: row.get(10)?,
        status: row.get(11)?,
        turns: row.get(12)?,
        last_error: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        agent_project_id: row.get(16)?,
        pinned: row.get(17)?,
    })
}

/// Most recently touched first — a list of work in progress is read from the top, and the one you
/// just answered is the one you are most likely to come back to.
pub fn list_agent_tasks(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<AgentTask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks WHERE workspace_id = ?1
         ORDER BY updated_at DESC, created_at DESC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], |row| map_agent_task(row))?;
    rows.collect()
}

pub fn get_agent_task(conn: &Connection, id: &str) -> rusqlite::Result<Option<AgentTask>> {
    conn.query_row(
        &format!("SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks WHERE id = ?1"),
        params![id],
        |row| map_agent_task(row),
    )
    .optional()
}

/// The [`AGENT_CONVERSATION_PREFIX`] on the conversation id is what tells an `activity_log` row
/// that belongs to a task apart from one that belongs to an ordinary chat, without adding a column
/// to a table every chat turn in the app writes to.
#[allow(clippy::too_many_arguments)]
pub fn create_agent_task(
    conn: &Connection,
    workspace_id: &str,
    project_id: &str,
    agent_id: &str,
    agent_name: &str,
    provider: &str,
    model: &str,
    prompt: &str,
    goal: &str,
    title: &str,
    agent_project_id: &str,
) -> rusqlite::Result<AgentTask> {
    let stamp = now();
    let task = AgentTask {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        project_id: project_id.to_string(),
        agent_id: agent_id.to_string(),
        agent_name: agent_name.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        prompt: prompt.to_string(),
        goal: goal.to_string(),
        title: title.to_string(),
        agent_project_id: agent_project_id.to_string(),
        pinned: false,
        conversation_id: format!("{AGENT_CONVERSATION_PREFIX}{}", Uuid::new_v4()),
        status: "draft".to_string(),
        turns: 0,
        last_error: String::new(),
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    conn.execute(
        "INSERT INTO agent_tasks (id, workspace_id, project_id, agent_id, agent_name, provider, model, prompt,
            goal, title, conversation_id, status, turns, last_error, created_at, updated_at, agent_project_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            task.id,
            task.workspace_id,
            task.project_id,
            task.agent_id,
            task.agent_name,
            task.provider,
            task.model,
            task.prompt,
            task.goal,
            task.title,
            task.conversation_id,
            task.status,
            task.turns,
            task.last_error,
            task.created_at,
            task.updated_at,
            task.agent_project_id,
        ],
    )?;
    Ok(task)
}

/// Writes only what a turn changes. `updated_at` is re-stamped, which is also what re-sorts the
/// list — the task you just spoke to moves to the top.
pub fn update_agent_task_run(
    conn: &Connection,
    id: &str,
    status: &str,
    model: &str,
    turns: i64,
    last_error: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_tasks SET status = ?2, model = ?3, turns = ?4, last_error = ?5, updated_at = ?6
         WHERE id = ?1",
        params![id, status, model, turns, last_error, now()],
    )?;
    Ok(())
}

/// The repository a task runs in, changeable only while it has no turns yet — after that the
/// engine session and the working tree it has already touched both belong to the old one.
pub fn set_agent_task_project(conn: &Connection, id: &str, project_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_tasks SET project_id = ?2, updated_at = ?3 WHERE id = ?1 AND turns = 0",
        params![id, project_id, now()],
    )?;
    Ok(())
}

pub fn rename_agent_task(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_tasks SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now()],
    )?;
    Ok(())
}

pub fn delete_agent_task(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_tasks WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- agent chains ----------

/// A chain **is** a graph now — `on_pass`/`on_fail` can point backwards, which is the loop the
/// feature spent its whole life without. What used to make a runaway impossible was the shape of
/// the data; what makes it impossible now is [`MAX_CHAIN_DISPATCHES`], and these two are what keep
/// a plan nobody meant to author, and a step that keeps failing, from getting that far.
///
/// 16 rather than 8: with a reviewer able to send work back, a plan is no longer one pass down a
/// list, and eight was a number chosen when it was.
pub const MAX_CHAIN_STEPS: usize = 16;
const MAX_STEP_ATTEMPTS: i64 = 3;

/// The hard bound on a chain: how many step runs it may dispatch in its whole life, however many
/// times its steps send each other backwards.
///
/// This is the one number that has to exist. Every other cap here bounds the *plan* — how much can
/// be written down — and a plan with a back-edge is a program, so the plan's size stopped being
/// the bound the moment loops became expressible. A step run is a whole engine session against a
/// real working copy, so the ceiling is deliberately something a person would notice reaching
/// rather than something generous: 128 is a twelve-step plan going round ten times, which is well
/// past the point where the loop is the problem.
pub const MAX_CHAIN_DISPATCHES: i64 = 128;

/// How many repositories one chain may work across.
///
/// The ceiling is not the database's, it is the clock's: the steps of a chain run one after another
/// and each is a whole engine session against a real working copy, so a plan fanned out over
/// thirty repositories is one nobody watches to the end. Raised to 16 rather than to something
/// round, because this is the one cap that nothing in this change made cheaper — an engine still
/// sees one working directory, and steps still run in series. It moves when worktrees do.
pub const MAX_CHAIN_REPOS: usize = 16;

/// The cap on **rows**, after a `"*"` step has been expanded into one per repository.
///
/// [`MAX_CHAIN_STEPS`] limits what a user writes; this limits what that turns into. It is no longer
/// the runaway guard — [`MAX_CHAIN_DISPATCHES`] is, because rows stopped predicting runs the day a
/// step could be visited twice — so what it bounds now is how big a *plan* may be: how much there
/// is to read in the detail pane, and how long one lap takes. 64 is one lap the length of an
/// afternoon, and the dispatch budget is what stops the second lap being a week.
pub const MAX_CHAIN_ROWS: usize = 64;

/// How much of a step's answer is carried into the next step's opening message.
///
/// **This used to be 6k, and the reason was the command line, not the model.** The composed message
/// rode `-p` as one argv element, and on Windows an npm-installed provider resolves to a `.cmd`
/// shim that routes the command line through cmd.exe — ceiling 8191 characters. A whole design
/// existed around that number: "for anything bigger, have one step write `docs/plan.md` and the
/// next read it."
///
/// That ceiling is gone. `ai::chat_with_repo` now delivers any message past `INLINE_ASK_LIMIT` as
/// **data** rather than as an argument, which every engine already knows how to carry, so what is
/// left to ration here is the next agent's context window and nothing else. 60k characters is
/// roughly fifteen thousand tokens — a full plan, a full review, a stack trace with its code —
/// while still being a bound rather than a promise that a runaway answer will be pasted whole into
/// every step that follows it.
const HANDOFF_MAX: usize = 60_000;

/// Head **and** tail, because a plan's conclusion is at the bottom: keeping only the first N
/// characters would hand the next agent the throat-clearing and drop the decision. Two thirds from
/// the front, one third from the back. Cut on `chars()` so a fixed offset can never split a code
/// point.
fn clamp_to(text: &str, max: usize) -> (String, bool) {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return (text.to_string(), false);
    }
    let head_len = max * 2 / 3;
    let tail_len = max - head_len;
    let omitted = chars.len() - head_len - tail_len;
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    (format!("{head}\n\n…[{omitted} characters omitted]…\n\n{tail}"), true)
}

fn clamp_handoff(text: &str) -> (String, bool) {
    clamp_to(text, HANDOFF_MAX)
}

/// The message a step opens with.
///
/// The headings are English scaffolding around the user's own words, deliberately not translated:
/// they are read by an engine, not by a person, and threading the app's locale through the backend
/// so a prompt could say "Objetivo" would buy nothing an LLM notices.
///
/// The objective is repeated on every step because every step is a fresh engine session that has
/// no memory of the chain (see `claim_next_chain_step`).
/// The shared-memory block, and the standing instructions that make it worth having.
///
/// **These are the app's words, not the user's.** "Read what came before, and write down where you
/// left things" is true of every chain ever authored, and asking each user to remember to put it in
/// every agent's role was asking them to rediscover the feature. The role is for *who the agent is*;
/// this is for how a chain works.
///
/// The path is the same relative one in **every** repository of the plan, because the folder is
/// mirrored into each of them: a step running in the third repository opens `.codeflow/memory/<id>/`
/// exactly as the step in the first did, and finds the same notes there.
fn compose_memory_block(chain_id: &str, notes: &[(i64, String)], own_note: &str) -> String {
    let folder = crate::chain_memory::relative_dir(chain_id);
    let mut out = format!("## Shared memory — `{folder}/`\n");
    if notes.is_empty() {
        out.push_str("Nothing has been written here yet. You are the first step.\n");
    } else {
        out.push_str("Notes from the steps before you, in plan order. Open the ones you need — do not assume this message contains all of them:\n\n");
        for (index, name) in notes {
            out.push_str(&format!("- `{folder}/{name}` — step {}\n", index + 1));
        }
    }
    out.push_str(&format!(
        "\nWhen you finish, your answer is filed as `{folder}/{own_note}`. Write it for the agent \
that comes next, who has none of your context and cannot see your reasoning: name the files you \
touched and the symbols inside them, say what is done and what is left, and give paths precise \
enough to open without searching. If you needed something that was not in memory, say where you \
found it so nobody has to look twice.\n\n"
    ));
    out
}

fn compose_chain_input(
    goal: &str,
    instruction: &str,
    previous: Option<(&str, i64, &str)>,
    feedback: &str,
    memory: &str,
) -> String {
    let mut out = String::new();
    if !goal.trim().is_empty() {
        out.push_str("## Objective\n");
        out.push_str(goal.trim());
        out.push_str("\n\n");
    }
    if let Some((agent_name, index, output)) = previous {
        out.push_str(&format!("## Context — {agent_name} (step {})\n", index + 1));
        out.push_str(output.trim());
        out.push_str("\n\n");
    }
    // Last before the task and deliberately loud. This block only exists when the plan was sent
    // *back* here by a later step whose check failed, and the whole value of a loop is that the
    // second pass knows something the first did not — an agent that re-received its original
    // instruction verbatim would produce its original answer verbatim.
    if !feedback.trim().is_empty() {
        out.push_str("## This is a retry — the previous attempt was rejected\n");
        out.push_str(feedback.trim());
        out.push_str("\n\nFix what is described above. Do not start over from scratch.\n\n");
    }
    out.push_str(memory);
    out.push_str("## Your task\n");
    out.push_str(instruction.trim());
    out
}

/// The notes that exist for a chain, as the steps that wrote them — read from the plan rather than
/// from the folder.
///
/// The database is the honest index: it knows which steps answered and under which agent, so the
/// listing is right even if a note failed to be written, and composing a message never has to touch
/// a disk that might be slow or gone. A step is listed once it has produced output, which is
/// exactly when `chain_memory::write_note` filed it.
fn memory_notes(conn: &Connection, chain_id: &str, before: i64) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT step_index, agent_name FROM agent_chain_steps
          WHERE chain_id = ?1 AND step_index < ?2 AND status = 'done' AND output_text <> ''
          ORDER BY step_index",
    )?;
    let rows = stmt.query_map(params![chain_id, before], |row| {
        let index: i64 = row.get(0)?;
        let agent: String = row.get(1)?;
        Ok((index, crate::chain_memory::note_name(index, &agent)))
    })?;
    rows.collect()
}

/// Appended rather than placed after `goal` where the table carries them, for the reason spelled
/// out on [`AGENT_TASK_COLUMNS`].
/// Trailed by the repository count, which is a correlated subquery rather than a column: it is the
/// only thing about a chain's repository set that every list of chains needs, and a join would
/// multiply the chain row by its repositories.
const CHAIN_COLUMNS: &str = "id, project_id, title, goal, status, current_step, step_count, last_reason, \
     created_at, updated_at, agent_project_id, pinned, kind, work_item_provider, work_item_org, \
     work_item_id, work_item_key, work_item_url, work_item_title, dispatches, \
     (SELECT COUNT(*) FROM agent_chain_repos r WHERE r.chain_id = agent_chains.id)";

/// The same columns qualified for the join in [`list_agent_chains`]. Written out rather than
/// derived from [`CHAIN_COLUMNS`] by string substitution — a `replace("id,", "c.id,")` also
/// rewrites the `id` inside `project_id`, and the result compiles perfectly and fails at runtime.
const CHAIN_COLUMNS_QUALIFIED: &str = "c.id, c.project_id, c.title, c.goal, c.status, c.current_step, \
     c.step_count, c.last_reason, c.created_at, c.updated_at, c.agent_project_id, c.pinned, c.kind, \
     c.work_item_provider, c.work_item_org, c.work_item_id, c.work_item_key, c.work_item_url, \
     c.work_item_title, c.dispatches, (SELECT COUNT(*) FROM agent_chain_repos r WHERE r.chain_id = c.id)";

fn map_chain(row: &rusqlite::Row) -> rusqlite::Result<AgentChain> {
    Ok(AgentChain {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        goal: row.get(3)?,
        status: row.get(4)?,
        current_step: row.get(5)?,
        step_count: row.get(6)?,
        last_reason: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        agent_project_id: row.get(10)?,
        pinned: row.get(11)?,
        kind: row.get(12)?,
        work_item_provider: row.get(13)?,
        work_item_org: row.get(14)?,
        work_item_id: row.get(15)?,
        work_item_key: row.get(16)?,
        work_item_url: row.get(17)?,
        work_item_title: row.get(18)?,
        dispatches: row.get(19)?,
        repo_count: row.get(20)?,
    })
}

/// Aliased `s`, and paired with [`STEP_FROM`]: a step now reports the *name* of the repository it
/// runs in, which lives in another table. Every read of a step goes through the two together.
const STEP_COLUMNS: &str = "s.id, s.chain_id, s.step_index, s.project_id, COALESCE(p.name, ''), s.phase, \
     s.agent_id, s.agent_name, s.provider, s.model, s.prompt, s.instruction, s.gate, s.gate_cleared, \
     s.pending_input, s.task_id, s.run_id, s.log_count_at_dispatch, s.output_text, s.output_truncated, \
     s.status, s.attempts, s.last_error, s.check_command, s.on_pass, s.on_fail, s.feedback, \
     s.created_at, s.updated_at";

/// LEFT, not INNER: a repository removed from the workspace must not make the steps that ran in it
/// disappear out of a finished plan.
const STEP_FROM: &str = "FROM agent_chain_steps s LEFT JOIN projects p ON p.id = s.project_id";

fn map_step(row: &rusqlite::Row) -> rusqlite::Result<AgentChainStep> {
    Ok(AgentChainStep {
        id: row.get(0)?,
        chain_id: row.get(1)?,
        step_index: row.get(2)?,
        project_id: row.get(3)?,
        project_name: row.get(4)?,
        phase: row.get(5)?,
        agent_id: row.get(6)?,
        agent_name: row.get(7)?,
        provider: row.get(8)?,
        model: row.get(9)?,
        prompt: row.get(10)?,
        instruction: row.get(11)?,
        gate: row.get(12)?,
        gate_cleared: row.get(13)?,
        pending_input: row.get(14)?,
        task_id: row.get(15)?,
        run_id: row.get(16)?,
        log_count_at_dispatch: row.get(17)?,
        output_text: row.get(18)?,
        output_truncated: row.get(19)?,
        status: row.get(20)?,
        attempts: row.get(21)?,
        last_error: row.get(22)?,
        check_command: row.get(23)?,
        on_pass: row.get(24)?,
        on_fail: row.get(25)?,
        feedback: row.get(26)?,
        created_at: row.get(27)?,
        updated_at: row.get(28)?,
    })
}

fn chain_row(conn: &Connection, id: &str) -> rusqlite::Result<Option<AgentChain>> {
    conn.query_row(
        &format!("SELECT {CHAIN_COLUMNS} FROM agent_chains WHERE id = ?1"),
        params![id],
        map_chain,
    )
    .optional()
}

fn step_row(conn: &Connection, step_id: &str) -> rusqlite::Result<Option<AgentChainStep>> {
    conn.query_row(
        &format!("SELECT {STEP_COLUMNS} {STEP_FROM} WHERE s.id = ?1"),
        params![step_id],
        map_step,
    )
    .optional()
}

/// Every repository the chain works across, in the order they were picked.
pub fn chain_repos(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<ChainRepo>> {
    let mut stmt = conn.prepare(
        "SELECT r.project_id, COALESCE(p.name, ''), r.position
         FROM agent_chain_repos r LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.chain_id = ?1 ORDER BY r.position",
    )?;
    let rows = stmt.query_map(params![chain_id], |row| {
        Ok(ChainRepo { project_id: row.get(0)?, name: row.get(1)?, position: row.get(2)? })
    })?;
    rows.collect()
}

fn steps_of(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<AgentChainStep>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {STEP_COLUMNS} {STEP_FROM} WHERE s.chain_id = ?1 ORDER BY s.step_index"
    ))?;
    let rows = stmt.query_map(params![chain_id], map_step)?;
    rows.collect()
}

/// The next step waiting to run, or `None` when the plan is spent.
fn next_pending_step(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<AgentChainStep>> {
    conn.query_row(
        &format!(
            "SELECT {STEP_COLUMNS} {STEP_FROM}
             WHERE s.chain_id = ?1 AND s.status = 'pending' ORDER BY s.step_index LIMIT 1"
        ),
        params![chain_id],
        map_step,
    )
    .optional()
}

/// The nearest earlier step that actually produced something, walking backwards — so a skipped or
/// output-less step degrades into "no context" instead of handing the next agent an empty block.
///
/// **The same repository first.** A chain fanned out over three repositories interleaves three
/// independent lines of work, and the answer step 4 needs is the one step 1 gave about *its* tree,
/// not whatever step 3 happened to say about somebody else's. Only when this repository has no
/// earlier answer at all does it fall back to the plan-wide one, which is what carries a shared
/// analysis into the repository that is about to act on it.
///
/// For a chain with one repository the two queries pick the same row, so this is exactly the
/// behaviour every chain written before multi-repo had.
fn previous_output(
    conn: &Connection,
    chain_id: &str,
    step_index: i64,
    project_id: &str,
) -> rusqlite::Result<Option<(String, i64, String)>> {
    let same_repo = conn
        .query_row(
            "SELECT agent_name, step_index, output_text FROM agent_chain_steps
             WHERE chain_id = ?1 AND step_index < ?2 AND output_text <> '' AND project_id = ?3
             ORDER BY step_index DESC LIMIT 1",
            params![chain_id, step_index, project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if same_repo.is_some() {
        return Ok(same_repo);
    }
    conn.query_row(
        "SELECT agent_name, step_index, output_text FROM agent_chain_steps
         WHERE chain_id = ?1 AND step_index < ?2 AND output_text <> ''
         ORDER BY step_index DESC LIMIT 1",
        params![chain_id, step_index],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
}

fn set_chain_state(conn: &Connection, id: &str, status: &str, reason: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_chains SET status = ?2, last_reason = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status, reason, now()],
    )?;
    Ok(())
}

/// Chains of the workspace, newest activity first. Joined against `projects` rather than storing a
/// `workspace_id`: a repository moved to another workspace has to take its chains with it.
pub fn list_agent_chains(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<AgentChain>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHAIN_COLUMNS_QUALIFIED} FROM agent_chains c JOIN projects p ON p.id = c.project_id
         WHERE p.workspace_id = ?1 ORDER BY c.updated_at DESC, c.created_at DESC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_chain)?;
    rows.collect()
}

/// Every step of every chain of the workspace, slim enough to load them all at once — the task list
/// draws a chain as a group of its steps, so it needs all of them and none of their text.
///
/// Scoped through `projects` for the same reason [`list_agent_chains`] is: `agent_chains` carries no
/// `workspace_id` of its own.
pub fn list_workspace_chain_steps(
    conn: &Connection,
    workspace_id: &str,
) -> rusqlite::Result<Vec<ChainStepBrief>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.chain_id, s.step_index, s.agent_name, s.instruction, s.gate, s.task_id,
                s.status, s.project_id, COALESCE(sp.name, ''), s.phase
         FROM agent_chain_steps s
         JOIN agent_chains c ON c.id = s.chain_id
         JOIN projects p ON p.id = c.project_id
         LEFT JOIN projects sp ON sp.id = s.project_id
         WHERE p.workspace_id = ?1
         ORDER BY s.chain_id, s.step_index",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(ChainStepBrief {
            id: row.get(0)?,
            chain_id: row.get(1)?,
            step_index: row.get(2)?,
            agent_name: row.get(3)?,
            instruction: row.get(4)?,
            gate: row.get(5)?,
            task_id: row.get(6)?,
            status: row.get(7)?,
            project_id: row.get(8)?,
            project_name: row.get(9)?,
            phase: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn get_chain_detail(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<ChainDetail>> {
    let Some(chain) = chain_row(conn, chain_id)? else { return Ok(None) };
    let steps = steps_of(conn, chain_id)?;
    let repos = chain_repos(conn, chain_id)?;
    Ok(Some(ChainDetail { chain, steps, repos }))
}

/// Turns the plan a user authored into the flat list of rows the scheduler walks.
///
/// The only thing that happens here is the `"*"` expansion: a step that says "every repository"
/// becomes one row per repository, consecutively, sharing everything but the tree they run in. The
/// gate rides the **first** row of an expansion and not all of them — "review before this step"
/// is one decision about one phase of the plan, and parking three times to approve the same thing
/// three times is not what the checkbox says.
///
/// A step naming a repository the chain was not given falls back to the first one rather than
/// failing: the dialog can only offer what the chain has, so this is a stale window, and a chain
/// that runs somewhere defensible beats a create that vanishes.
fn expand_steps(steps: &[NewChainStep], project_ids: &[String]) -> Vec<(NewChainStep, String)> {
    let primary = project_ids.first().cloned().unwrap_or_default();
    let mut rows = Vec::with_capacity(steps.len());
    // Where each authored step lands once expanded. `on_pass`/`on_fail` are written against the
    // plan as *typed* — "if this fails, go back to step 2" means the second row of the dialog — and
    // one authored step can become N rows, so the targets have to be translated or a jump would
    // land on whatever happens to sit at that index afterwards.
    let mut starts: Vec<i64> = Vec::with_capacity(steps.len());
    for step in steps {
        let targets: Vec<String> = match step.project_id.as_str() {
            "*" => project_ids.to_vec(),
            "" => vec![primary.clone()],
            named if project_ids.iter().any(|id| id == named) => vec![named.to_string()],
            _ => vec![primary.clone()],
        };
        starts.push(rows.len() as i64);
        for (at, target) in targets.into_iter().enumerate() {
            let mut row = step.clone();
            row.gate = step.gate && at == 0;
            rows.push((row, target));
        }
    }

    // The *first* row of the authored step, which for a fanned-out one means a backward jump
    // re-runs the whole fan rather than its tail. That is what "go back to the analysis" means when
    // the analysis was one instruction across five repositories.
    //
    // Out-of-range targets degrade to the default rather than failing the chain: a saved template
    // authored against a longer plan is a plan somebody shortened, not a plan to refuse.
    let translate = |target: i64| -> i64 {
        if target < 0 { -1 } else { starts.get(target as usize).copied().unwrap_or(-1) }
    };
    for (row, _) in rows.iter_mut() {
        row.on_pass = translate(row.on_pass);
        row.on_fail = translate(row.on_fail);
    }
    rows
}

/// How many rows [`create_agent_chain`] would write for this plan. The command layer checks it
/// against [`MAX_CHAIN_ROWS`] before anything is inserted.
pub fn expanded_step_count(steps: &[NewChainStep], project_ids: &[String]) -> usize {
    expand_steps(steps, project_ids).len()
}

/// Writes the plan. Every step's agent is snapshotted here, at authoring time — not at dispatch —
/// so a chain that waits a week at a gate still runs as the roster read when it was written.
///
/// Created `paused`: nothing in this app starts an engine the user did not just ask it to. The
/// frontend queues it in a second call, which is also what makes "create then decide" possible.
///
/// `project_ids` is the whole repository set, first one first. That first repository is also
/// written to `agent_chains.project_id`, which is what every workspace-scoped query joins through
/// and what a step that names no repository of its own falls back to.
pub fn create_agent_chain(
    conn: &Connection,
    project_ids: &[String],
    title: &str,
    goal: &str,
    steps: &[NewChainStep],
    agent_project_id: &str,
) -> rusqlite::Result<ChainDetail> {
    create_chain_inner(conn, project_ids, title, goal, steps, agent_project_id, "chain", None)
}

#[allow(clippy::too_many_arguments)]
fn create_chain_inner(
    conn: &Connection,
    project_ids: &[String],
    title: &str,
    goal: &str,
    steps: &[NewChainStep],
    agent_project_id: &str,
    kind: &str,
    work_item: Option<&NewStoryWorkItem>,
) -> rusqlite::Result<ChainDetail> {
    let Some(project_id) = project_ids.first() else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    let workspace_id: String =
        conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project_id], |r| r.get(0))?;
    let roster = list_workspace_agents(conn, &workspace_id)?;
    let rows = expand_steps(steps, project_ids);
    let item = work_item.cloned().unwrap_or_default();

    let tx = conn.unchecked_transaction()?;
    let stamp = now();
    let chain = AgentChain {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        title: title.to_string(),
        goal: goal.to_string(),
        agent_project_id: agent_project_id.to_string(),
        pinned: false,
        status: "paused".to_string(),
        current_step: 0,
        step_count: rows.len() as i64,
        last_reason: String::new(),
        dispatches: 0,
        created_at: stamp.clone(),
        updated_at: stamp.clone(),
        kind: kind.to_string(),
        work_item_provider: item.provider.clone(),
        work_item_org: item.org.clone(),
        work_item_id: item.id,
        work_item_key: item.key.clone(),
        work_item_url: item.url.clone(),
        work_item_title: item.title.clone(),
        repo_count: project_ids.len() as i64,
    };
    tx.execute(
        "INSERT INTO agent_chains (id, project_id, title, goal, status, current_step, step_count,
            last_reason, created_at, updated_at, agent_project_id, kind, work_item_provider,
            work_item_org, work_item_id, work_item_key, work_item_url, work_item_title)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            chain.id,
            chain.project_id,
            chain.title,
            chain.goal,
            chain.status,
            chain.current_step,
            chain.step_count,
            chain.last_reason,
            chain.created_at,
            chain.updated_at,
            chain.agent_project_id,
            chain.kind,
            chain.work_item_provider,
            chain.work_item_org,
            chain.work_item_id,
            chain.work_item_key,
            chain.work_item_url,
            chain.work_item_title,
        ],
    )?;

    // `INSERT OR IGNORE`, so the same repository picked twice is one repository rather than a
    // primary-key failure that loses the whole chain.
    for (position, id) in project_ids.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO agent_chain_repos (chain_id, project_id, position)
             VALUES (?1, ?2, ?3)",
            params![chain.id, id, position as i64],
        )?;
    }

    for (index, (step, target)) in rows.iter().enumerate() {
        let agent = roster.iter().find(|a| a.id == step.agent_id);
        tx.execute(
            "INSERT INTO agent_chain_steps (id, chain_id, step_index, project_id, phase, agent_id,
                agent_name, provider, model, prompt, instruction, gate, gate_cleared, pending_input,
                task_id, run_id, log_count_at_dispatch, output_text, output_truncated, status,
                attempts, last_error, check_command, on_pass, on_fail, feedback, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, '', '', '', -1, '', 0,
                'pending', 0, '', ?14, ?15, ?16, '', ?13, ?13)",
            params![
                Uuid::new_v4().to_string(),
                chain.id,
                index as i64,
                target,
                step.phase,
                step.agent_id,
                agent.map(|a| a.name.clone()).unwrap_or_default(),
                agent.map(|a| a.provider.clone()).unwrap_or_default(),
                agent.map(|a| a.model.clone()).unwrap_or_default(),
                agent.map(|a| a.prompt.clone()).unwrap_or_default(),
                step.instruction,
                step.gate,
                stamp,
                step.check_command.trim(),
                step.on_pass,
                step.on_fail,
            ],
        )?;
    }
    tx.commit()?;
    let steps = steps_of(conn, &chain.id)?;
    let repos = chain_repos(conn, &chain.id)?;
    Ok(ChainDetail { chain, steps, repos })
}

/// "Carry on from here": a chain whose first step is an existing task, already finished.
///
/// Step 0 is created `done` with that task's last successful answer copied into `output_text` and
/// its `task_id` pointing back at it, so the transcript is one click away and the handoff composes
/// exactly as it would have if the task had been step 0 all along. It never runs, which is why a
/// source agent that has since been deleted is harmless here.
#[allow(clippy::too_many_arguments)]
pub fn create_continuation_chain(
    conn: &Connection,
    source_task_id: &str,
    title: &str,
    goal: &str,
    steps: &[NewChainStep],
    agent_project_id: &str,
) -> rusqlite::Result<ChainDetail> {
    let task = get_agent_task(conn, source_task_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    // The last turn that actually produced something. A failed or stopped turn has nothing to hand
    // on, and reaching further back would quietly carry forward an answer the user already moved
    // past.
    let answer: Option<String> = conn
        .query_row(
            "SELECT answer FROM activity_log
             WHERE project_id = ?1 AND session_id = ?2 AND is_error = 0
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![task.project_id, task.conversation_id],
            |row| row.get(0),
        )
        .optional()?;

    let seed = NewChainStep {
        agent_id: task.agent_id.clone(),
        instruction: task.goal.clone(),
        gate: false,
        project_id: String::new(),
        phase: String::new(),
        ..Default::default()
    };
    let mut plan = vec![seed];
    plan.extend(steps.iter().cloned());
    // One repository: the task's own. Continuing from a task is continuing in the tree that task
    // already edited, and a second repository here would have nothing to do with what came before.
    let repos = [task.project_id.clone()];
    let detail = create_agent_chain(conn, &repos, title, goal, &plan, agent_project_id)?;

    let (output, truncated) = clamp_handoff(answer.unwrap_or_default().trim());
    if let Some(first) = detail.steps.first() {
        conn.execute(
            "UPDATE agent_chain_steps SET status = 'done', output_text = ?2, output_truncated = ?3,
                task_id = ?4, agent_name = ?5, updated_at = ?6
             WHERE id = ?1",
            params![first.id, output, truncated, task.id, task.agent_name, now()],
        )?;
    }
    get_chain_detail(conn, &detail.chain.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

// ---------- the story realizer ----------
//
// Two phases over N repositories, and no third concept: a story run *is* a chain, so it recovers
// after a kill, parks at its gate and reports its steps through exactly the code every other chain
// already goes through. What is special about it lives in three places and nowhere else — the
// objective is a work item rather than a sentence somebody typed, the plan is generated instead of
// authored, and the review in the middle is the point of the whole thing.

/// How much of the work item's own text travels in **every** step's opening message.
///
/// Still smaller than [`HANDOFF_MAX`], and still for the same shape of reason — the objective is
/// repeated on every step *in addition to* the previous step's answer — but no longer for the argv
/// one, which is why this could rise with it. A work item with more than 12k characters of
/// description is one whose detail belongs in the repository rather than in every prompt.
const STORY_BRIEF_MAX: usize = 12_000;

/// How much of a failed check's own output travels back to the agent being asked to fix it.
///
/// Smaller than a handoff and on purpose: a failing suite prints hundreds of passing lines around
/// the handful that matter, and [`clamp_to`] keeps both ends, which for test output is the summary
/// and the first failure.
const CHECK_OUTPUT_MAX: usize = 8_000;

/// Phase one, run once per candidate repository.
///
/// Deliberately read-only and deliberately shaped. The verdict line is what the review screen reads
/// to pre-tick the repositories the story actually touches, so it has to be a fixed token on a line
/// of its own rather than a sentence the model phrases its own way; everything under it is for the
/// human.
const STORY_ANALYZE_INSTRUCTION: &str = "\
Read the user story in the objective above and inspect THIS repository — only this one.

Decide whether this repository has to change for the story to be delivered, and if it does, plan \
exactly what changes. Ground every claim in something you actually opened: name the files, the \
symbols, the endpoints.

**Do not edit, create or delete any file. This is a read-only pass.**

Answer in Markdown, in this shape and starting with these three lines:

VERDICT: TOUCHES | DOES NOT TOUCH
CONFIDENCE: high | medium | low
WHY: one or two sentences, naming the evidence you found.

## Plan
One bullet per change, each naming the file it lands in and what happens there. Leave this section \
empty when the verdict is DOES NOT TOUCH.

## Risks
Anything that could break, anything you could not verify, and anything the story does not say.";

/// Phase two, run once per repository the user kept.
///
/// The plan it carries out is whatever survived the review, which may be nothing like what phase one
/// proposed — so this says the plan is the specification and refuses to improvise past it.
const STORY_IMPLEMENT_INSTRUCTION: &str = "\
Carry out the plan above in THIS repository. The plan is the specification, including any edit the \
user made to it — where it is silent, follow this repository's own conventions rather than \
inventing a new one.

Change nothing the plan does not call for. If a step of it turns out to be wrong or impossible, \
stop and say so instead of substituting a different change.

Finish with a short summary: the files you changed, and why each one.";

/// The objective every step of a story run opens with: the work item, then whatever the user added.
fn compose_story_goal(item: &NewStoryWorkItem, notes: &str) -> String {
    let mut out = String::new();
    out.push_str("## User story\n");
    let name = match item.key.trim().is_empty() {
        true => format!("#{}", item.id),
        false => item.key.trim().to_string(),
    };
    out.push_str(&format!("{name} — {}\n", item.title.trim()));
    if !item.url.trim().is_empty() {
        out.push_str(&format!("{}\n", item.url.trim()));
    }
    let (body, _) = clamp_to(item.body.trim(), STORY_BRIEF_MAX);
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    if !notes.trim().is_empty() {
        out.push_str("\n## Extra instructions from the user\n");
        out.push_str(notes.trim());
        out.push('\n');
    }
    out
}

/// A story run: analyse every candidate repository, stop for the user, then implement.
///
/// The plan is 2N rows — N analyses and N implementations — and the gate rides the **first**
/// implementation. That is the whole two-phase shape the feature promises: nothing is written to any
/// working copy until somebody has read what every repository proposed and said which of them go
/// ahead.
#[allow(clippy::too_many_arguments)]
pub fn create_story_chain(
    conn: &Connection,
    project_ids: &[String],
    title: &str,
    notes: &str,
    analyst_agent_id: &str,
    implementer_agent_id: &str,
    agent_project_id: &str,
    work_item: &NewStoryWorkItem,
) -> rusqlite::Result<ChainDetail> {
    let goal = compose_story_goal(work_item, notes);
    let mut steps: Vec<NewChainStep> = Vec::with_capacity(project_ids.len() * 2);
    for id in project_ids {
        steps.push(NewChainStep {
            agent_id: analyst_agent_id.to_string(),
            instruction: STORY_ANALYZE_INSTRUCTION.to_string(),
            gate: false,
            project_id: id.clone(),
            phase: "analyze".to_string(),
            ..Default::default()
        });
    }
    for (at, id) in project_ids.iter().enumerate() {
        steps.push(NewChainStep {
            agent_id: implementer_agent_id.to_string(),
            instruction: STORY_IMPLEMENT_INSTRUCTION.to_string(),
            gate: at == 0,
            project_id: id.clone(),
            phase: "implement".to_string(),
            ..Default::default()
        });
    }
    create_chain_inner(
        conn,
        project_ids,
        title,
        &goal,
        &steps,
        agent_project_id,
        "story",
        Some(work_item),
    )
}

/// Freezes the message one particular step will be sent.
///
/// [`approve_chain_gate`] does this for the step the chain is parked at; this does it for the ones
/// behind it, which is what lets the review screen approve a plan for six repositories in one press
/// instead of stopping at each. Refused once the step has left `pending` — rewriting the input of a
/// step that has already run would be a lie about what produced its answer.
pub fn set_chain_step_input(conn: &Connection, step_id: &str, input: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_chain_steps SET pending_input = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'pending'",
        params![step_id, input, now()],
    )?;
    Ok(())
}

/// Takes one step out of the plan, or puts it back.
///
/// The chain-wide [`skip_chain_step`] only reaches the step the plan is currently waiting on, which
/// is the right shape for "I don't want this one to run now". This is the other shape: the review
/// screen deciding, before any of them runs, that four of the six repositories are not part of this
/// story after all. Only ever moves between `pending` and `skipped`, so it can never rewrite the
/// history of a step that already ran.
pub fn set_chain_step_skipped(conn: &Connection, step_id: &str, skipped: bool) -> rusqlite::Result<()> {
    let (from, to) = match skipped {
        true => ("pending", "skipped"),
        false => ("skipped", "pending"),
    };
    conn.execute(
        "UPDATE agent_chain_steps SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = ?4",
        params![step_id, to, now(), from],
    )?;
    Ok(())
}

fn idle_claim(chain: AgentChain) -> ChainClaim {
    ChainClaim { chain, kind: "idle".to_string(), task: None, step: None, message: String::new() }
}

/// Decides — and records — what happens next. **Everything that could refuse has refused before
/// the caller is told to run anything**, and every fact the run will need (its task, its run id,
/// the exact message, the ordinal that recovery reads) is committed here, before dispatch.
///
/// That ordering is the whole robustness story: the driver is frontend code that can be killed
/// between any two lines, so nothing may exist in the engine that does not already exist on disk.
pub fn claim_next_chain_step(conn: &Connection, chain_id: &str, run_id: &str) -> rusqlite::Result<ChainClaim> {
    let Some(chain) = chain_row(conn, chain_id)? else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    if chain.status != "queued" {
        return Ok(idle_claim(chain));
    }

    let Some(step) = next_pending_step(conn, chain_id)? else {
        set_chain_state(conn, chain_id, "done", "")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    };

    // The repository can be gone even though the chain is not: `projects` cascades to
    // `agent_chains` through the chain's *primary* repository only, so any other one in the set can
    // be removed from the workspace while a plan is parked at a gate. Read off the step rather than
    // off the chain — a claim racing that delete would otherwise create a task in a vacuum.
    let project: Option<(String, String)> = conn
        .query_row(
            "SELECT workspace_id, local_path FROM projects WHERE id = ?1",
            params![step.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((workspace_id, _local_path)) = project else {
        set_chain_state(conn, chain_id, "failed", "chain.projectGone")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    };

    // A gate parks the chain *before* the step, and freezes the message while it waits — so what
    // the user approves is byte-for-byte what runs, however long they take to look at it.
    if step.gate && !step.gate_cleared {
        if step.pending_input.is_empty() {
            let previous = previous_output(conn, chain_id, step.step_index, &step.project_id)?;
            let memory = compose_memory_block(
                chain_id,
                &memory_notes(conn, chain_id, step.step_index)?,
                &crate::chain_memory::note_name(step.step_index, &step.agent_name),
            );
            let message = compose_chain_input(
                &chain.goal,
                &step.instruction,
                previous.as_ref().map(|(name, index, text)| (name.as_str(), *index, text.as_str())),
                &step.feedback,
                &memory,
            );
            conn.execute(
                "UPDATE agent_chain_steps SET pending_input = ?2, updated_at = ?3 WHERE id = ?1",
                params![step.id, message, now()],
            )?;
        }
        conn.execute(
            "UPDATE agent_chains SET status = 'gated', current_step = ?2, last_reason = '', updated_at = ?3
             WHERE id = ?1",
            params![chain_id, step.step_index, now()],
        )?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    }

    // Mirrors `isRunnableAgent` on the frontend, and it has to be a hard stop rather than a
    // fallback: `send_chat_message` only honours an agent's routing when provider *and* model are
    // both set, and otherwise quietly runs on the normal chat routing. A step that "works" on the
    // wrong engine is far worse than a chain that stops and says why.
    if step.provider.trim().is_empty() || step.model.trim().is_empty() {
        conn.execute(
            "UPDATE agent_chain_steps SET status = 'error', last_error = 'chain.agentNotRoutable', updated_at = ?2
             WHERE id = ?1",
            params![step.id, now()],
        )?;
        set_chain_state(conn, chain_id, "failed", "chain.agentNotRoutable")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    }

    if step.attempts >= MAX_STEP_ATTEMPTS {
        set_chain_state(conn, chain_id, "failed", "chain.attemptsExhausted")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    }

    // The loop's stop. Checked here rather than where the jump is decided because this is the only
    // place work is actually handed out — a budget enforced at the branch would be a budget that a
    // recovered step, a manual retry or a resumed chain each walk around by a different door.
    if chain.dispatches >= MAX_CHAIN_DISPATCHES {
        set_chain_state(conn, chain_id, "failed", "chain.dispatchesExhausted")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    }

    let tx = conn.unchecked_transaction()?;

    // The workspace is read live off `projects`, so a repository moved between workspaces files
    // this step's task under the one it is in now rather than the one it was created in.
    let task = match get_agent_task(&tx, &step.task_id)? {
        Some(existing) => existing,
        None => {
            let title = if step.instruction.trim().is_empty() {
                chain.title.clone()
            } else {
                step.instruction.trim().chars().take(64).collect()
            };
            // Filed in the chain's own folder: a step's task is the chain's work, and a tree that
            // showed the chain in one folder and the tasks it produced in another would be lying
            // about where the work lives.
            create_agent_task(
                &tx,
                &workspace_id,
                &step.project_id,
                &step.agent_id,
                &step.agent_name,
                &step.provider,
                &step.model,
                &step.prompt,
                &step.instruction,
                &title,
                &chain.agent_project_id,
            )?
        }
    };

    let message = if step.pending_input.is_empty() {
        let previous = previous_output(&tx, chain_id, step.step_index, &step.project_id)?;
        let memory = compose_memory_block(
            chain_id,
            &memory_notes(&tx, chain_id, step.step_index)?,
            &crate::chain_memory::note_name(step.step_index, &step.agent_name),
        );
        compose_chain_input(
            &chain.goal,
            &step.instruction,
            previous.as_ref().map(|(name, index, text)| (name.as_str(), *index, text.as_str())),
            &step.feedback,
            &memory,
        )
    } else {
        step.pending_input.clone()
    };

    // How many turns this conversation already holds. Recovery reads the row at exactly this
    // offset, so a retry after an error can never harvest the previous attempt's error text and
    // hand it forward as though it were the plan.
    let log_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM activity_log WHERE project_id = ?1 AND session_id = ?2",
        params![task.project_id, task.conversation_id],
        |row| row.get(0),
    )?;

    tx.execute(
        "UPDATE agent_chain_steps SET status = 'running', task_id = ?2, run_id = ?3, pending_input = ?4,
            log_count_at_dispatch = ?5, attempts = attempts + 1, updated_at = ?6
         WHERE id = ?1",
        params![step.id, task.id, run_id, message, log_count, now()],
    )?;
    tx.execute(
        "UPDATE agent_chains SET status = 'running', current_step = ?2, last_reason = '',
            dispatches = dispatches + 1, updated_at = ?3
         WHERE id = ?1",
        params![chain_id, step.step_index, now()],
    )?;
    tx.commit()?;

    let chain = chain_row(conn, chain_id)?.unwrap_or(chain);
    let step = step_row(conn, &step.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok(ChainClaim { chain, kind: "run".to_string(), task: Some(task), step: Some(step), message })
}

/// What the step that sent the plan backwards has to say for itself, as the next attempt will read
/// it: its own answer, and the output of the command that rejected it.
///
/// Both halves, because they answer different questions. The check's output is *what* is wrong — a
/// failing test name, a compiler error — and is the part a machine produced, so it is quoted as
/// found. The step's answer is *what was attempted*, which is what stops the next pass from
/// redoing the same thing a slightly different way.
fn rejection_note(step: &AgentChainStep, answer: &str, check_output: &str) -> String {
    let mut note = format!("Step {} ({}) rejected this work.\n", step.step_index + 1, step.agent_name);
    if !step.check_command.trim().is_empty() {
        note.push_str(&format!("\nThe check that failed was: `{}`\n", step.check_command.trim()));
    }
    if !check_output.trim().is_empty() {
        // Its own budget rather than the handoff's: a failing test suite prints far more than
        // anyone needs, and the useful part is at both ends.
        let (clamped, _) = clamp_to(check_output.trim(), CHECK_OUTPUT_MAX);
        note.push_str(&format!("\n```\n{clamped}\n```\n"));
    }
    if !answer.trim().is_empty() {
        note.push_str(&format!("\nWhat that step reported:\n\n{}\n", answer.trim()));
    }
    note
}

/// Moves the plan to `target`, in whichever direction that turns out to be.
///
/// **This is the whole of the graph, and it is why there is no edge table.** Forward is marking
/// what was jumped over as `skipped`; backward is putting everything from the target onwards back
/// to `pending`. Either way exactly one row is left for [`next_pending_step`] to find, so the
/// selector that used to walk a list walks a graph without a line changing: the rows around the
/// cursor are told the truth, and the cursor falls out of them.
///
/// What a backward jump clears is chosen by what would otherwise be a lie on the second lap:
/// `pending_input` because a frozen message is last lap's message, `gate_cleared` because an
/// approval was given for work that has since been rejected, `last_error` because it belongs to a
/// run that is being redone. What it deliberately does **not** clear is `attempts` — a step that
/// has run three times has run three times, whether that was three crashes or three rejections,
/// and each one cost an engine session against a real working copy.
fn jump_to(
    conn: &Connection,
    chain_id: &str,
    from_index: i64,
    target: i64,
    feedback: &str,
) -> rusqlite::Result<()> {
    if target > from_index {
        // Forward: everything stepped over is `skipped` rather than left `pending`, or the
        // selector would simply hand back the first of them and the branch would do nothing.
        conn.execute(
            "UPDATE agent_chain_steps SET status = 'skipped', updated_at = ?4
             WHERE chain_id = ?1 AND step_index > ?2 AND step_index < ?3 AND status = 'pending'",
            params![chain_id, from_index, target, now()],
        )?;
    } else {
        conn.execute(
            "UPDATE agent_chain_steps SET status = 'pending', pending_input = '', gate_cleared = 0,
                run_id = '', last_error = '', updated_at = ?3
             WHERE chain_id = ?1 AND step_index >= ?2",
            params![chain_id, target, now()],
        )?;
    }
    if !feedback.trim().is_empty() {
        conn.execute(
            "UPDATE agent_chain_steps SET feedback = ?3, updated_at = ?4
             WHERE chain_id = ?1 AND step_index = ?2",
            params![chain_id, target, feedback, now()],
        )?;
    }
    Ok(())
}

/// The three facts a note is named and filed by, read before the outcome is applied.
pub fn chain_step_note(conn: &Connection, step_id: &str) -> rusqlite::Result<Option<(String, i64, String)>> {
    conn.query_row(
        "SELECT chain_id, step_index, agent_name FROM agent_chain_steps WHERE id = ?1",
        params![step_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
}

/// Every working copy a chain's memory is mirrored into: **all** of its repositories, not just the
/// first, so a step running in the third can read what the step in the first wrote.
///
/// Repositories that have left the workspace drop out rather than appearing as empty paths — there
/// is nowhere to mirror to, which is not an error, just one fewer copy.
pub fn chain_repo_paths(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT p.local_path FROM agent_chain_repos r JOIN projects p ON p.id = r.project_id
          WHERE r.chain_id = ?1 AND p.local_path <> '' ORDER BY r.position",
    )?;
    let rows = stmt.query_map(params![chain_id], |row| row.get(0))?;
    rows.collect()
}

/// The repository a given step ran in, by name — the one fact a note's header carries that the step
/// row alone does not spell out.
pub fn step_repo_name(conn: &Connection, step_id: &str) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT COALESCE(p.name, '') FROM agent_chain_steps s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.id = ?1",
        params![step_id],
        |row| row.get(0),
    )
    .optional()
    .map(|name| name.unwrap_or_default())
}

/// Every step of a plan as the summary writes it: position, agent, how it ended, what it said.
pub fn chain_summary_sections(
    conn: &Connection,
    chain_id: &str,
) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT step_index, agent_name, status, output_text FROM agent_chain_steps
          WHERE chain_id = ?1 ORDER BY step_index",
    )?;
    let rows = stmt.query_map(params![chain_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    rows.collect()
}

/// What a step's check needs in order to run: the command, and the working copy to run it in.
///
/// Both come off the *step* rather than off the chain — a multi-repo plan runs each step somewhere
/// else, and a check that ran in the chain's primary repository while its step edited another would
/// pass or fail on the wrong tree. `None` when there is no check, or when the repository it named
/// has left the workspace.
pub fn chain_step_check(conn: &Connection, step_id: &str) -> rusqlite::Result<Option<(String, String)>> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT s.check_command, p.local_path
               FROM agent_chain_steps s LEFT JOIN projects p ON p.id = s.project_id
              WHERE s.id = ?1",
            params![step_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        Some((command, Some(path))) if !command.trim().is_empty() && !path.trim().is_empty() => {
            Some((command.trim().to_string(), path))
        }
        _ => None,
    })
}

/// Records how a dispatched step ended, and decides where the chain goes next.
///
/// `outcome` is one of `done` | `error` | `cancelled` | `requeue`. The last two both return the
/// step to `pending`, and both are safe to re-send: a stopped turn is never written to
/// `activity_log`, and a requeued one never reached an engine at all.
pub fn complete_chain_step(
    conn: &Connection,
    step_id: &str,
    outcome: &str,
    output_text: &str,
    reason: &str,
) -> rusqlite::Result<Option<AgentChain>> {
    let Some(step) = step_row(conn, step_id)? else { return Ok(None) };
    let chain_id = step.chain_id.clone();

    match outcome {
        "done" => {
            let (clamped, truncated) = clamp_handoff(output_text.trim());
            // `feedback` is cleared here and only here: it described the rejection that sent the
            // plan back to this step, and this step has now passed. Leaving it would make the next
            // lap of an unrelated loop open with a complaint about work that was already fixed.
            conn.execute(
                "UPDATE agent_chain_steps SET status = 'done', output_text = ?2, output_truncated = ?3,
                    run_id = '', last_error = '', feedback = '', updated_at = ?4
                 WHERE id = ?1",
                params![step.id, clamped, truncated, now()],
            )?;
            // A pass may still be a jump: `on_pass` is how a plan branches forward past steps that
            // this one made unnecessary. `-1` and "the next one" are the same thing and neither
            // needs the rows around it touched.
            if step.on_pass >= 0 && step.on_pass != step.step_index + 1 {
                jump_to(conn, &chain_id, step.step_index, step.on_pass, "")?;
            }
            match next_pending_step(conn, &chain_id)? {
                None => set_chain_state(conn, &chain_id, "done", "")?,
                Some(next) => {
                    // An answer with nothing in it must never cascade: three agents working from
                    // an empty context block is the worst outcome this feature can produce, so the
                    // next step is force-gated and the user is told why.
                    if clamped.is_empty() {
                        conn.execute(
                            "UPDATE agent_chain_steps SET gate = 1, gate_cleared = 0, updated_at = ?2 WHERE id = ?1",
                            params![next.id, now()],
                        )?;
                        set_chain_state(conn, &chain_id, "queued", "chain.emptyOutput")?;
                    } else {
                        set_chain_state(conn, &chain_id, "queued", "")?;
                    }
                }
            }
        }
        // A failed turn goes back in the queue while there are attempts left, instead of stopping
        // the plan and waiting for somebody to press Retry.
        //
        // The old behaviour made a chain only as autonomous as the person watching it: one flaky
        // turn — a rate limit, a dropped connection, an engine that came back empty on a bad
        // minute — parked eight steps of work until a human noticed. Nothing about that first
        // failure needed a decision, and the decision it asked for was always "try again".
        //
        // This cannot spin. `claim_next_chain_step` increments `attempts` before it dispatches and
        // refuses outright at [`MAX_STEP_ATTEMPTS`], so the retries are counted by the same code
        // that hands the work out; the step is `pending` rather than `error` because that is what
        // makes it eligible, and `queued` is the one chain state the frontend driver continues on.
        // The reason travels either way, so a chain retrying says *why* while it does it rather
        // than looking idle.
        // The step answered and then its own declared check came back non-zero. **This is the one
        // outcome the feature never had**: every other branch here is about whether a turn
        // happened, and this is the first that is about whether what it produced is any good.
        //
        // Deliberately not a failure of the turn. The answer is recorded — it is what the next
        // attempt has to work from — and where the plan goes is `on_fail`'s to say: back to an
        // earlier step (the loop), or, with no target, this step again with the check's own output
        // told to it. Nothing decides here whether that is allowed; `claim_next_chain_step` refuses
        // an exhausted step and an exhausted budget, and it is the only place that hands work out.
        "check_failed" => {
            let (clamped, truncated) = clamp_handoff(output_text.trim());
            conn.execute(
                "UPDATE agent_chain_steps SET output_text = ?2, output_truncated = ?3, run_id = '',
                    last_error = 'chain.checkFailed', updated_at = ?4
                 WHERE id = ?1",
                params![step.id, clamped, truncated, now()],
            )?;
            let target = if step.on_fail >= 0 { step.on_fail } else { step.step_index };
            let note = rejection_note(&step, &clamped, reason);
            jump_to(conn, &chain_id, step.step_index, target, &note)?;
            set_chain_state(conn, &chain_id, "queued", "chain.checkFailed")?;
        }
        "error" => {
            let retryable = step.attempts < MAX_STEP_ATTEMPTS;
            conn.execute(
                "UPDATE agent_chain_steps SET status = ?2, run_id = '', last_error = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![step.id, if retryable { "pending" } else { "error" }, reason, now()],
            )?;
            set_chain_state(conn, &chain_id, if retryable { "queued" } else { "failed" }, reason)?;
        }
        // Back to `pending`, never to `error`: the turn was either stopped (never persisted) or
        // refused before it ran (the repository was busy), so re-sending the identical message
        // cannot duplicate anything.
        "cancelled" | "requeue" => {
            conn.execute(
                "UPDATE agent_chain_steps SET status = 'pending', run_id = '', updated_at = ?2 WHERE id = ?1",
                params![step.id, now()],
            )?;
            let next = if outcome == "requeue" { "queued" } else { "paused" };
            set_chain_state(conn, &chain_id, next, reason)?;
        }
        _ => return Ok(chain_row(conn, &chain_id)?),
    }
    chain_row(conn, &chain_id)
}

/// Approves the gate the chain is parked at and lets it go. `input` overrides the frozen message
/// when the user edited it, and is written before the state changes so the preview can never
/// disagree with what runs.
pub fn approve_chain_gate(conn: &Connection, chain_id: &str, input: &str) -> rusqlite::Result<Option<AgentChain>> {
    let Some(step) = next_pending_step(conn, chain_id)? else {
        set_chain_state(conn, chain_id, "done", "")?;
        return chain_row(conn, chain_id);
    };
    let message = if input.trim().is_empty() { step.pending_input.clone() } else { input.to_string() };
    conn.execute(
        "UPDATE agent_chain_steps SET gate_cleared = 1, pending_input = ?2, updated_at = ?3 WHERE id = ?1",
        params![step.id, message, now()],
    )?;
    set_chain_state(conn, chain_id, "queued", "")?;
    chain_row(conn, chain_id)
}

/// Marks the step the chain is waiting on as deliberately not run. Composition then walks back
/// past it to the nearest earlier answer.
pub fn skip_chain_step(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<AgentChain>> {
    let target: Option<AgentChainStep> = conn
        .query_row(
            &format!(
                "SELECT {STEP_COLUMNS} {STEP_FROM}
                 WHERE s.chain_id = ?1 AND s.status IN ('pending', 'error', 'interrupted')
                 ORDER BY s.step_index LIMIT 1"
            ),
            params![chain_id],
            map_step,
        )
        .optional()?;
    if let Some(step) = target {
        conn.execute(
            "UPDATE agent_chain_steps SET status = 'skipped', run_id = '', updated_at = ?2 WHERE id = ?1",
            params![step.id, now()],
        )?;
    }
    match next_pending_step(conn, chain_id)? {
        Some(_) => set_chain_state(conn, chain_id, "queued", "")?,
        None => set_chain_state(conn, chain_id, "done", "")?,
    }
    chain_row(conn, chain_id)
}

/// Puts a failed or interrupted step back in the queue. `attempts` is deliberately not reset —
/// three tries is three tries, however they were spent.
pub fn retry_chain_step(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<AgentChain>> {
    let target: Option<AgentChainStep> = conn
        .query_row(
            &format!(
                "SELECT {STEP_COLUMNS} {STEP_FROM}
                 WHERE s.chain_id = ?1 AND s.status IN ('error', 'interrupted')
                 ORDER BY s.step_index LIMIT 1"
            ),
            params![chain_id],
            map_step,
        )
        .optional()?;
    let Some(step) = target else { return chain_row(conn, chain_id) };
    if step.attempts >= MAX_STEP_ATTEMPTS {
        set_chain_state(conn, chain_id, "failed", "chain.attemptsExhausted")?;
        return chain_row(conn, chain_id);
    }
    conn.execute(
        "UPDATE agent_chain_steps SET status = 'pending', run_id = '', last_error = '', updated_at = ?2
         WHERE id = ?1",
        params![step.id, now()],
    )?;
    set_chain_state(conn, chain_id, "queued", "")?;
    chain_row(conn, chain_id)
}

/// Hands a parked chain back to the scheduler. Only from a state the user parked it in — a failed
/// chain goes through `retry_chain_step`, which is where the attempt cap lives.
/// Runs the plan again from one step, with something the user wants said to it.
///
/// The mechanism is the loop from `on_fail`, pointed by hand instead of by a failed check — which
/// is the whole reason it costs almost nothing to have: [`jump_to`] already knows how to put a plan
/// back to an earlier step and hand that step a note, so "re-run the implementer, but this time
/// use the existing helper" is that same move with the note coming from a person.
///
/// It works on a **finished** chain as much as on a stopped one, which is the point: the memory
/// folder is still there, the steps still hold their answers, and the second pass opens knowing
/// everything the first one learned rather than starting from an empty repository again.
///
/// The dispatch budget is deliberately *not* reset. A plan you have re-run four times has cost four
/// plans' worth of engine sessions, and the counter is what keeps that visible.
pub fn rerun_chain_from(
    conn: &Connection,
    chain_id: &str,
    step_index: i64,
    note: &str,
) -> rusqlite::Result<Option<AgentChain>> {
    let Some(chain) = chain_row(conn, chain_id)? else { return Ok(None) };
    if chain.status == "running" {
        return Ok(Some(chain));
    }
    // Attempts start over, and only here. Every other reset in this file is the plan recovering
    // from its own trouble, where the count is the bound; this one is a person deciding to spend
    // more, which is a decision the app has no business overriding.
    conn.execute(
        "UPDATE agent_chain_steps SET attempts = 0 WHERE chain_id = ?1 AND step_index >= ?2",
        params![chain_id, step_index],
    )?;
    let note = if note.trim().is_empty() {
        String::new()
    } else {
        format!("The user has asked for this step to be done again, with this change:\n\n{}", note.trim())
    };
    jump_to(conn, chain_id, i64::MAX, step_index, &note)?;
    set_chain_state(conn, chain_id, "queued", "")?;
    chain_row(conn, chain_id)
}

pub fn resume_chain(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<AgentChain>> {
    let Some(chain) = chain_row(conn, chain_id)? else { return Ok(None) };
    if chain.status == "paused" {
        set_chain_state(conn, chain_id, "queued", "")?;
    }
    chain_row(conn, chain_id)
}

pub fn abort_chain(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<AgentChain>> {
    set_chain_state(conn, chain_id, "aborted", "")?;
    chain_row(conn, chain_id)
}

/// Deletes the plan **and the tasks its steps produced**.
///
/// The tasks are the bug this fixes. `agent_chain_steps.task_id` deliberately carries no foreign
/// key — a step has to outlive its task in order to be able to report that the task is gone — and
/// the consequence was that the cascade which takes the steps could not take these. Deleting a
/// chain left its turns behind as free-standing tasks in the tree, filed under a folder, belonging
/// to a plan that no longer existed and with no way left to tell where they came from.
///
/// One transaction, tasks first: a half-applied delete that removed the chain and left the tasks
/// would be the exact state this exists to make impossible.
pub fn delete_chain(conn: &Connection, chain_id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM agent_tasks WHERE id IN
            (SELECT task_id FROM agent_chain_steps WHERE chain_id = ?1 AND task_id <> '')",
        params![chain_id],
    )?;
    tx.execute("DELETE FROM agent_chains WHERE id = ?1", params![chain_id])?;
    tx.commit()
}

/// The ids of the tasks a chain owns, for a caller that has to forget them before they are gone.
pub fn chain_task_ids(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT task_id FROM agent_chain_steps WHERE chain_id = ?1 AND task_id <> ''",
    )?;
    let rows = stmt.query_map(params![chain_id], |row| row.get(0))?;
    rows.collect()
}

/// The turn a dispatched step wrote, found by **ordinal** rather than by recency.
///
/// `log_count_at_dispatch` was recorded before the run started, so this reads the row that run
/// produced and no other. `None` means the turn never landed — the step was interrupted, and the
/// working copy may hold half of its edits, which is a question only a human can answer.
fn harvest_row(conn: &Connection, step: &AgentChainStep) -> rusqlite::Result<Option<(String, bool)>> {
    if step.task_id.is_empty() || step.log_count_at_dispatch < 0 {
        return Ok(None);
    }
    let conversation: Option<(String, String)> = conn
        .query_row(
            "SELECT project_id, conversation_id FROM agent_tasks WHERE id = ?1",
            params![step.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((project_id, conversation_id)) = conversation else { return Ok(None) };
    conn.query_row(
        "SELECT answer, is_error FROM activity_log
         WHERE project_id = ?1 AND session_id = ?2
         ORDER BY created_at ASC, id ASC LIMIT 1 OFFSET ?3",
        params![project_id, conversation_id, step.log_count_at_dispatch],
        |row| Ok((row.get(0)?, row.get::<_, bool>(1)?)),
    )
    .optional()
}

/// Polled by the frontend for a step whose run outlived the webview. Completes it the moment its
/// turn lands, so a reload costs the log but never the work.
pub fn harvest_chain_step(conn: &Connection, step_id: &str) -> rusqlite::Result<Option<AgentChain>> {
    let Some(step) = step_row(conn, step_id)? else { return Ok(None) };
    if step.status != "running" {
        return chain_row(conn, &step.chain_id);
    }
    match harvest_row(conn, &step)? {
        Some((answer, false)) => complete_chain_step(conn, &step.id, "done", &answer, ""),
        Some((answer, true)) => complete_chain_step(conn, &step.id, "error", "", &answer),
        None => Ok(None),
    }
}

/// Run once per launch, from `db::init`, before any UI exists.
///
/// This is where "the app was killed mid-step" is answered, and it deliberately lives here rather
/// than in a store: the frontend's own demotion only runs if the user opens the Agents view, so a
/// task left `running` by a killed session would keep a spinner and a repository slot until
/// someone happened to look.
///
/// **Nothing is ever resumed here.** An agent turn edits a real working copy with edits
/// auto-approved; dispatching one the instant the app opens, into a tree the user has not looked at
/// since, is the single thing that must not happen. Chains park and ask.
pub fn recover_after_restart(conn: &Connection) -> rusqlite::Result<()> {
    let running: Vec<AgentChainStep> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {STEP_COLUMNS} {STEP_FROM} WHERE s.status = 'running'"
        ))?;
        let rows = stmt.query_map([], map_step)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for step in &running {
        match harvest_row(conn, step)? {
            // The turn landed before the process died: keep the work rather than throwing it away.
            Some((answer, false)) => {
                let (clamped, truncated) = clamp_handoff(answer.trim());
                conn.execute(
                    "UPDATE agent_chain_steps SET status = 'done', output_text = ?2, output_truncated = ?3,
                        run_id = '', updated_at = ?4
                     WHERE id = ?1",
                    params![step.id, clamped, truncated, now()],
                )?;
            }
            Some((answer, true)) => {
                conn.execute(
                    "UPDATE agent_chain_steps SET status = 'error', run_id = '', last_error = ?2, updated_at = ?3
                     WHERE id = ?1",
                    params![step.id, answer, now()],
                )?;
            }
            // No row means the turn never completed. The tree may hold half its edits, and the
            // run's `checkpoint_before` is still in `refs/codeflow/checkpoints/`.
            None => {
                conn.execute(
                    "UPDATE agent_chain_steps SET status = 'interrupted', run_id = '', updated_at = ?2
                     WHERE id = ?1",
                    params![step.id, now()],
                )?;
            }
        }
    }

    conn.execute("UPDATE agent_tasks SET status = 'idle' WHERE status = 'running'", [])?;
    // `queued` is demoted along with `running`: a queued chain with nobody pumping it is a chain
    // that looks like it is about to start and never will.
    conn.execute(
        "UPDATE agent_chains SET status = 'paused', last_reason = 'chain.interrupted', updated_at = ?1
         WHERE status IN ('running', 'queued')",
        params![now()],
    )?;
    // A batch still claiming to be generating is one whose app was killed mid-run: there is no
    // process left to finish it, and leaving it would show a spinner that never resolves. Its
    // stories, if the previous run had already written any, are untouched.
    conn.execute(
        "UPDATE story_batches SET status = 'draft', updated_at = ?1 WHERE status = 'generating'",
        params![now()],
    )?;
    // Same reasoning for a document caught mid-generation. Its body is left alone: a run that had
    // already written one is a run whose work is worth keeping.
    conn.execute(
        "UPDATE doc_pages SET status = 'draft', updated_at = ?1 WHERE status = 'generating'",
        params![now()],
    )?;
    Ok(())
}

// ---------- chain templates ----------

fn template_steps(conn: &Connection, template_id: &str) -> rusqlite::Result<Vec<ChainTemplateStep>> {
    let mut stmt = conn.prepare(
        "SELECT id, template_id, step_index, agent_id, instruction, gate, check_command, on_pass, on_fail
         FROM workspace_chain_template_steps WHERE template_id = ?1 ORDER BY step_index",
    )?;
    let rows = stmt.query_map(params![template_id], |row| {
        Ok(ChainTemplateStep {
            id: row.get(0)?,
            template_id: row.get(1)?,
            step_index: row.get(2)?,
            agent_id: row.get(3)?,
            instruction: row.get(4)?,
            gate: row.get(5)?,
            check_command: row.get(6)?,
            on_pass: row.get(7)?,
            on_fail: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn list_chain_templates(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ChainTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, name, description, sort_order, created_at, updated_at
         FROM workspace_chain_templates WHERE workspace_id = ?1 ORDER BY sort_order, created_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(ChainTemplate {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            sort_order: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            steps: Vec::new(),
        })
    })?;
    let mut templates = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for template in &mut templates {
        template.steps = template_steps(conn, &template.id)?;
    }
    Ok(templates)
}

/// Replaces the template wholesale: the steps are the template, and a partial update would need a
/// diff whose only purpose would be to preserve ids nothing else refers to.
pub fn upsert_chain_template(
    conn: &Connection,
    id: Option<String>,
    workspace_id: &str,
    name: &str,
    description: &str,
    steps: &[NewChainStep],
) -> rusqlite::Result<ChainTemplate> {
    let tx = conn.unchecked_transaction()?;
    let stamp = now();
    let existing = id.as_ref().and_then(|existing_id| {
        tx.query_row(
            "SELECT sort_order, created_at FROM workspace_chain_templates WHERE id = ?1",
            params![existing_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .ok()
    });
    let (sort_order, created_at) = existing.unwrap_or((0, stamp.clone()));
    let template_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());

    tx.execute(
        "INSERT INTO workspace_chain_templates (id, workspace_id, name, description, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
            updated_at = excluded.updated_at",
        params![template_id, workspace_id, name, description, sort_order, created_at, stamp],
    )?;
    tx.execute("DELETE FROM workspace_chain_template_steps WHERE template_id = ?1", params![template_id])?;
    for (index, step) in steps.iter().enumerate() {
        tx.execute(
            "INSERT INTO workspace_chain_template_steps (id, template_id, step_index, agent_id,
                instruction, gate, check_command, on_pass, on_fail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                Uuid::new_v4().to_string(),
                template_id,
                index as i64,
                step.agent_id,
                step.instruction,
                step.gate,
                step.check_command.trim(),
                step.on_pass,
                step.on_fail,
            ],
        )?;
    }
    tx.commit()?;

    Ok(ChainTemplate {
        id: template_id.clone(),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        sort_order,
        created_at,
        updated_at: stamp,
        steps: template_steps(conn, &template_id)?,
    })
}

pub fn delete_chain_template(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_chain_templates WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- workspace MCP servers ----------




// ---------- activity log (AI chat history / conversations) ----------

/// Who answered a chat turn, on what, and how long it took — the facts stamped under the reply.
/// Grouped into one argument so [`add_activity_log`] keeps a readable signature as this grows.
#[derive(Default)]
pub struct TurnMeta<'a> {
    /// Provider id the turn actually ran through (`claude`, `codex`, …).
    pub provider: Option<&'a str>,
    /// Model the CLI reported for the turn. `None` when it didn't report exactly one.
    pub model: Option<&'a str>,
    /// Version of the engine CLI. `None` for HTTP engines, or when the probe failed.
    pub engine_version: Option<&'a str>,
    pub response_time_ms: Option<i64>,
}

pub fn add_activity_log(
    conn: &Connection,
    project_id: &str,
    conversation_id: &str,
    engine_session_id: Option<&str>,
    question: &str,
    answer: &str,
    trace: Option<&str>,
    meta: TurnMeta<'_>,
    is_error: bool,
) -> rusqlite::Result<ActivityLogEntry> {
    let entry = ActivityLogEntry {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        session_id: Some(conversation_id.to_string()),
        engine_session_id: engine_session_id.map(str::to_string),
        question: question.to_string(),
        answer: answer.to_string(),
        trace: trace.map(str::to_string),
        created_at: now(),
        response_time_ms: meta.response_time_ms,
        is_error,
        provider: meta.provider.map(str::to_string),
        model: meta.model.map(str::to_string),
        engine_version: meta.engine_version.map(str::to_string),
    };
    conn.execute(
        "INSERT INTO activity_log (id, project_id, session_id, engine_session_id, question, answer, trace, created_at, response_time_ms, is_error, provider, model, engine_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            entry.id,
            entry.project_id,
            entry.session_id,
            entry.engine_session_id,
            entry.question,
            entry.answer,
            entry.trace,
            entry.created_at,
            entry.response_time_ms,
            entry.is_error,
            entry.provider,
            entry.model,
            entry.engine_version
        ],
    )?;
    Ok(entry)
}

/// The column list every read that returns a whole [`ActivityLogEntry`] shares, so the row indices
/// in [`read_activity_row`] can't drift apart from it.
///
/// Not every `activity_log` read wants the whole row: the ones that only need to *describe* turns
/// go through [`conversation_turns`] instead, because `trace` is the heaviest column in the
/// database and reading it to build a list of titles is pure waste.
const ACTIVITY_COLUMNS: &str =
    "id, project_id, session_id, engine_session_id, question, answer, trace, created_at, response_time_ms, is_error, provider, model, engine_version";

/// [`ACTIVITY_COLUMNS`] with `trace` replaced by a literal `NULL`, so [`read_activity_row`] can
/// read it unchanged and the turn comes back with `trace: None`.
///
/// This exists because reopening a conversation returned every turn *with* its trace: 30 turns at
/// the 600 KB ceiling is ~18 MB in a single IPC response, which is a visible freeze on the click
/// that opens it. A trace read this way is fetched per turn, on demand, by [`get_turn_trace`].
const ACTIVITY_COLUMNS_NO_TRACE: &str =
    "id, project_id, session_id, engine_session_id, question, answer, NULL, created_at, response_time_ms, is_error, provider, model, engine_version";

fn read_activity_row(row: &rusqlite::Row) -> rusqlite::Result<ActivityLogEntry> {
    Ok(ActivityLogEntry {
        id: row.get(0)?,
        project_id: row.get(1)?,
        session_id: row.get(2)?,
        engine_session_id: row.get(3)?,
        question: row.get(4)?,
        answer: row.get(5)?,
        trace: row.get(6)?,
        created_at: row.get(7)?,
        response_time_ms: row.get(8)?,
        is_error: row.get(9)?,
        provider: row.get(10)?,
        model: row.get(11)?,
        engine_version: row.get(12)?,
    })
}

/// The slice of an `activity_log` row a conversation *summary* actually needs.
///
/// Deliberately not [`ActivityLogEntry`]. That struct carries `trace`, whose ceiling is
/// `ai_runs::MAX_TRACE_LINES` (300) x `MAX_LINE_CHARS` (2000) — roughly 600 KB per turn — and
/// building the history sidebar used to read *every* turn of the project through it just to reach
/// `session_id`, `question` and `created_at`. On a project with a few hundred turns that is
/// hundreds of megabytes read, allocated and thrown away to produce a list of titles.
struct ConversationTurn {
    session_id: String,
    question: String,
    /// Empty string unless the caller is searching — see [`conversation_turns`]. The only reader
    /// is the search filter, and answers are the second-largest column in the table.
    answer: String,
    created_at: String,
}

/// Every turn of a project that belongs to a conversation, oldest first, projected down to
/// [`ConversationTurn`]. `with_answer` is what decides whether the `answer` column is read at all:
/// the summary itself never needs it, only the search filter does.
fn conversation_turns(
    conn: &Connection,
    project_id: &str,
    with_answer: bool,
) -> rusqlite::Result<Vec<ConversationTurn>> {
    // A literal `''` rather than a second query string, so the row indices below stay the same in
    // both modes and cannot drift apart.
    let answer_column = if with_answer { "answer" } else { "''" };
    let mut stmt = conn.prepare(&format!(
        "SELECT session_id, question, {answer_column}, created_at
         FROM activity_log WHERE project_id = ?1 AND session_id IS NOT NULL ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(ConversationTurn {
            session_id: row.get(0)?,
            question: row.get(1)?,
            answer: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// Groups every turn into one summary per `session_id` (title = first question asked,
/// `updated_at` = latest turn) — the conversation-level list the history sidebar/modal show.
/// `search`, when given, keeps only conversations where *any* turn's question or answer
/// contains it, so search covers full past exchanges, not just the title.
///
/// The grouping is still done here rather than in SQL, because the two things that make it correct
/// — the Unicode-aware `to_lowercase()` the search uses (SQLite's `LIKE`/`LOWER` are ASCII-only, so
/// searching "análisis" would stop matching "Análisis") and the exact `starts_with` on the agent
/// prefix — have no faithful SQL equivalent here. What changed is *what is read*: turns now come
/// back as [`ConversationTurn`], without `trace` and without `answer` unless something is being
/// searched for. That is the whole cost of this call; the loop below was never the problem.
pub fn list_chat_conversations(
    conn: &Connection,
    project_id: &str,
    search: Option<&str>,
) -> rusqlite::Result<Vec<ChatConversationSummary>> {
    let needle = search.map(|s| s.to_lowercase());
    let entries = conversation_turns(conn, project_id, needle.is_some())?;

    let mut order: Vec<String> = Vec::new();
    let mut by_session: std::collections::HashMap<String, ChatConversationSummary> = std::collections::HashMap::new();
    let mut matched: std::collections::HashSet<String> = std::collections::HashSet::new();

    for e in &entries {
        let sid = e.session_id.clone();
        // An agent task's turns live in this table too, but the Agents view owns their lifecycle.
        // Listed here they would show up as ordinary chats, where deleting one would wipe the
        // transcript of a task that still exists — and rename it under a title the task never sees.
        if sid.starts_with(AGENT_CONVERSATION_PREFIX) {
            continue;
        }
        if let Some(q) = &needle {
            if e.question.to_lowercase().contains(q.as_str()) || e.answer.to_lowercase().contains(q.as_str()) {
                matched.insert(sid.clone());
            }
        }
        match by_session.get_mut(&sid) {
            Some(summary) => {
                summary.updated_at = e.created_at.clone();
                summary.turn_count += 1;
            }
            None => {
                order.push(sid.clone());
                by_session.insert(
                    sid.clone(),
                    ChatConversationSummary {
                        session_id: sid,
                        project_id: project_id.to_string(),
                        title: e.question.clone(),
                        created_at: e.created_at.clone(),
                        updated_at: e.created_at.clone(),
                        turn_count: 1,
                    },
                );
            }
        }
    }

    let mut result: Vec<ChatConversationSummary> = order
        .into_iter()
        .filter(|sid| needle.is_none() || matched.contains(sid))
        .filter_map(|sid| by_session.remove(&sid))
        .collect();

    let custom_titles = conversation_titles(conn, project_id)?;
    for summary in &mut result {
        if let Some(title) = custom_titles.get(&summary.session_id) {
            summary.title = title.clone();
        }
    }

    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(result)
}

fn conversation_titles(conn: &Connection, project_id: &str) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT session_id, title FROM conversation_titles WHERE project_id = ?1")?;
    let rows = stmt.query_map(params![project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    rows.collect()
}

pub fn rename_chat_conversation(conn: &Connection, project_id: &str, session_id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO conversation_titles (session_id, project_id, title, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
        params![session_id, project_id, title, now()],
    )?;
    Ok(())
}

/// Every turn of one conversation, oldest first — flattened into `[user, assistant, user,
/// assistant, ...]` by the frontend to redisplay exactly like a live chat.
pub fn get_conversation_messages(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
) -> rusqlite::Result<Vec<ActivityLogEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTIVITY_COLUMNS}
         FROM activity_log WHERE project_id = ?1 AND session_id = ?2 ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![project_id, session_id], read_activity_row)?;
    rows.collect()
}

/// [`get_conversation_messages`] without the traces — every turn comes back with `trace: None`.
///
/// Same rows, same order, same everything else; the difference is that the click that reopens a
/// long conversation no longer moves ~18 MB through IPC in one response (see
/// [`ACTIVITY_COLUMNS_NO_TRACE`]). The trace of any single turn is still reachable, one at a time,
/// through [`get_turn_trace`] — which is what the "how it got there" disclosure in the chat log
/// must call when the user expands it. **A caller that uses this without wiring that disclosure
/// silently loses the trace**, so the eager reader above is kept rather than removed, and the
/// command picks between the two on an explicit flag that defaults to the eager one.
pub fn get_conversation_messages_lite(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
) -> rusqlite::Result<Vec<ActivityLogEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTIVITY_COLUMNS_NO_TRACE}
         FROM activity_log WHERE project_id = ?1 AND session_id = ?2 ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![project_id, session_id], read_activity_row)?;
    rows.collect()
}

/// One turn's stored trace, by row id.
///
/// `None` covers both "this turn never had one" (it predates traces, or the engine printed
/// nothing) and "no such row" — the caller draws no disclosure either way, which is exactly what
/// the eager path does today with a `null` trace.
pub fn get_turn_trace(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT trace FROM activity_log WHERE id = ?1",
        params![id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

/// Provider id that answered the most recent turn of a conversation, when one was recorded.
/// `None` for a conversation with no turns yet, or whose turns predate provider tracking.
///
/// This is how the chat command tells whether a stored resume token still belongs to the engine
/// about to run — see `claude_cmd::session_for_provider`.
pub fn last_turn_provider(
    conn: &Connection,
    project_id: &str,
    conversation_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT provider FROM activity_log
         WHERE project_id = ?1 AND session_id = ?2 AND provider IS NOT NULL
         ORDER BY created_at DESC LIMIT 1",
        params![project_id, conversation_id],
        |row| row.get(0),
    )
    .optional()
}

pub fn delete_chat_conversation(conn: &Connection, project_id: &str, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM activity_log WHERE project_id = ?1 AND session_id = ?2",
        params![project_id, session_id],
    )?;
    conn.execute(
        "DELETE FROM conversation_titles WHERE project_id = ?1 AND session_id = ?2",
        params![project_id, session_id],
    )?;
    Ok(())
}

// ---------- job history (PR reviews / pre-commit analyses) ----------

/// `id` is supplied by the caller (the same id the frontend's in-memory job already has)
/// rather than generated here — that's what lets a job just run this session and the same
/// job reloaded from history after a restart share one identity, so renaming/deleting either
/// one always hits the right row.
#[allow(clippy::too_many_arguments)]
pub fn add_job_history(
    conn: &Connection,
    id: &str,
    project_id: &str,
    kind: &str,
    label: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
    meta: &str,
) -> rusqlite::Result<JobHistoryEntry> {
    let entry = JobHistoryEntry {
        id: id.to_string(),
        project_id: project_id.to_string(),
        kind: kind.to_string(),
        label: label.to_string(),
        custom_label: None,
        status: status.to_string(),
        result: result.map(str::to_string),
        error: error.map(str::to_string),
        meta: meta.to_string(),
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO job_history (id, project_id, kind, label, status, result, error, meta, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            entry.id,
            entry.project_id,
            entry.kind,
            entry.label,
            entry.status,
            entry.result,
            entry.error,
            entry.meta,
            entry.created_at
        ],
    )?;
    Ok(entry)
}

/// One page of a project's finished runs, newest first.
///
/// This used to select the whole table unconditionally, and that is a freeze rather than merely a
/// memory cost: `result` holds the *entire text* of every PR review and every pre-commit analysis,
/// nothing ever prunes `job_history`, so on a long-lived install the first open of the AI panel
/// dragged megabytes across IPC and deserialised them on the UI thread. `jobsStore` now asks for a
/// page at a time and **appends**, so no run becomes unreachable — see `PAGE_SIZE` there.
///
/// `limit = None` keeps the old "everything" behaviour byte for byte, which is what the command
/// still does when the caller sends no limit; SQLite reads a negative `LIMIT` as "no limit", so
/// that arm needs no second SQL string.
///
/// `result` is deliberately **still** in the projection. Dropping it is the bigger win, but the
/// Activity list feeds `AiPanel` and `AnalyzeSection` straight from these rows — both read
/// `job.result` synchronously off the selected row — so a list without it would show an empty
/// review until a second fetch landed. Bounding the page is the half that can be done without
/// touching those readers.
///
/// The `id` tiebreak matters only because of `OFFSET`: two runs that finished in the same
/// millisecond have equal `created_at`, and without a total order a page boundary could land
/// between them and skip one. The frontend re-sorts by timestamp anyway, so this changes nothing
/// visible.
pub fn list_job_history(
    conn: &Connection,
    project_id: &str,
    limit: Option<i64>,
    offset: i64,
) -> rusqlite::Result<Vec<JobHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, kind, label, custom_label, status, result, error, meta, created_at
         FROM job_history WHERE project_id = ?1 ORDER BY created_at DESC, id DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![project_id, limit.unwrap_or(-1), offset], |row| {
        Ok(JobHistoryEntry {
            id: row.get(0)?,
            project_id: row.get(1)?,
            kind: row.get(2)?,
            label: row.get(3)?,
            custom_label: row.get(4)?,
            status: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
            meta: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn rename_job_history(conn: &Connection, id: &str, label: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE job_history SET custom_label = ?1 WHERE id = ?2", params![label, id])?;
    Ok(())
}

/// Best-effort by design — deleting a job that's still running (no `job_history` row exists
/// for it yet) simply affects 0 rows, which is fine; the frontend removes it from memory
/// regardless.
pub fn delete_job_history(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM job_history WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- workspace activity (reviews of PRs with no repository here) ----------

/// The `job_history` writer's twin for work that belongs to no project. Same contract: `id` comes
/// from the caller (the frontend's in-memory job id), so the running job and the row it leaves
/// behind are one identity and renaming/deleting either always hits the right row.
#[allow(clippy::too_many_arguments)]
pub fn add_workspace_activity(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    kind: &str,
    label: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
    meta: &str,
) -> rusqlite::Result<WorkspaceActivityEntry> {
    let entry = WorkspaceActivityEntry {
        id: id.to_string(),
        workspace_id: workspace_id.to_string(),
        kind: kind.to_string(),
        label: label.to_string(),
        custom_label: None,
        status: status.to_string(),
        result: result.map(str::to_string),
        error: error.map(str::to_string),
        meta: meta.to_string(),
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO workspace_activity (id, workspace_id, kind, label, status, result, error, meta, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            entry.id,
            entry.workspace_id,
            entry.kind,
            entry.label,
            entry.status,
            entry.result,
            entry.error,
            entry.meta,
            entry.created_at
        ],
    )?;
    Ok(entry)
}

/// [`list_job_history`]'s twin, and paged for the same reason and on the same terms — read that
/// doc comment. One Activity list mixes rows from both tables, so if only one of them were bounded
/// the panel would still stall on whichever bucket was not.
pub fn list_workspace_activity(
    conn: &Connection,
    workspace_id: &str,
    limit: Option<i64>,
    offset: i64,
) -> rusqlite::Result<Vec<WorkspaceActivityEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, kind, label, custom_label, status, result, error, meta, created_at
         FROM workspace_activity WHERE workspace_id = ?1 ORDER BY created_at DESC, id DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![workspace_id, limit.unwrap_or(-1), offset], |row| {
        Ok(WorkspaceActivityEntry {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            kind: row.get(2)?,
            label: row.get(3)?,
            custom_label: row.get(4)?,
            status: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
            meta: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn rename_workspace_activity(conn: &Connection, id: &str, label: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE workspace_activity SET custom_label = ?1 WHERE id = ?2", params![label, id])?;
    Ok(())
}

/// Best-effort, exactly like [`delete_job_history`] — a run still in flight has no row yet.
pub fn delete_workspace_activity(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_activity WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- app settings (key/value) ----------

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

/// Many settings in one pass over one prepared statement.
///
/// Exists because the app asks for roughly ninety of these during boot — every AI task's three
/// keys, every persisted layout slot — and one command per key means one acquisition of the global
/// connection mutex per key, all of them serialised behind whatever else wants the database.
///
/// Only keys that exist come back, which is what lets a caller tell "unset" from "set to empty"
/// exactly as [`get_setting`]'s `None` does: an absent entry is an absent row, not `""`.
///
/// A prepared statement reused per key rather than one `IN (…)`: binding a variable-length list
/// means building SQL at runtime and staying under SQLite's parameter ceiling, and the cost this
/// is here to remove is the mutex and the IPC round trip, not the lookups — `key` is the primary
/// key, so each one is a single index probe.
pub fn get_settings(
    conn: &Connection,
    keys: &[String],
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1")?;
    let mut out = std::collections::HashMap::with_capacity(keys.len());
    for key in keys {
        let value: Option<String> = stmt.query_row(params![key], |row| row.get(0)).optional()?;
        if let Some(value) = value {
            out.insert(key.clone(), value);
        }
    }
    Ok(out)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------- user stories (story_batches / story_drafts) ----------

const BATCH_COLUMNS: &str = "id, workspace_id, project_id, title, source_kind, source_ref, source_text, \
    instructions, provider, model, ado_org, ado_project, work_item_type, area_path, iteration_path, \
    tags, open_questions, status, last_error, created_at, updated_at, \
    verify_provider, verify_model, verified_at, prompt_template, prompt_instructions, generated_at, \
    verify_project_ids, feature_project_id, question_answers, board_provider";

fn map_batch(row: &rusqlite::Row) -> rusqlite::Result<StoryBatch> {
    Ok(StoryBatch {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_id: row.get(2)?,
        title: row.get(3)?,
        source_kind: row.get(4)?,
        source_ref: row.get(5)?,
        source_text: row.get(6)?,
        instructions: row.get(7)?,
        provider: row.get(8)?,
        model: row.get(9)?,
        ado_org: row.get(10)?,
        ado_project: row.get(11)?,
        work_item_type: row.get(12)?,
        area_path: row.get(13)?,
        iteration_path: row.get(14)?,
        tags: row.get(15)?,
        open_questions: row.get(16)?,
        status: row.get(17)?,
        last_error: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        verify_provider: row.get(21)?,
        verify_model: row.get(22)?,
        verified_at: row.get(23)?,
        prompt_template: row.get(24)?,
        prompt_instructions: row.get(25)?,
        generated_at: row.get(26)?,
        verify_project_ids: row.get(27)?,
        feature_project_id: row.get(28)?,
        question_answers: row.get(29)?,
        board_provider: row.get(30)?,
    })
}

const DRAFT_COLUMNS: &str = "id, batch_id, seq, title, narrative, description, acceptance_criteria, \
    priority, story_points, tags, notes, work_item_id, work_item_url, status, last_error, created_at, \
    updated_at, verify_status, verify_summary, verify_criteria, verified_at, work_item_key, \
    original_estimate";

fn map_draft(row: &rusqlite::Row) -> rusqlite::Result<StoryDraft> {
    Ok(StoryDraft {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        seq: row.get(2)?,
        title: row.get(3)?,
        narrative: row.get(4)?,
        description: row.get(5)?,
        acceptance_criteria: row.get(6)?,
        priority: row.get(7)?,
        story_points: row.get(8)?,
        tags: row.get(9)?,
        notes: row.get(10)?,
        work_item_id: row.get(11)?,
        work_item_url: row.get(12)?,
        status: row.get(13)?,
        last_error: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        verify_status: row.get(17)?,
        verify_summary: row.get(18)?,
        verify_criteria: row.get(19)?,
        verified_at: row.get(20)?,
        work_item_key: row.get(21)?,
        original_estimate: row.get(22)?,
    })
}

/// The workspace's batches, newest activity first — the same ordering the agent console's task
/// list uses, so the two read the same way.
// ---------- documentation pages ----------

const DOC_PAGE_COLUMNS: &str = "id, workspace_id, project_id, scope, title, content, ado_org, \
    ado_project, wiki_id, wiki_name, page_path, published_at, published_url, engine, model, \
    version, status, last_error, created_at, updated_at";

fn map_doc_page(row: &rusqlite::Row) -> rusqlite::Result<DocPage> {
    Ok(DocPage {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_id: row.get(2)?,
        scope: row.get(3)?,
        title: row.get(4)?,
        content: row.get(5)?,
        ado_org: row.get(6)?,
        ado_project: row.get(7)?,
        wiki_id: row.get(8)?,
        wiki_name: row.get(9)?,
        page_path: row.get(10)?,
        published_at: row.get(11)?,
        published_url: row.get(12)?,
        engine: row.get(13)?,
        model: row.get(14)?,
        version: row.get(15)?,
        status: row.get(16)?,
        last_error: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

/// The workspace's documents, newest first.
///
/// A stale `generating` is corrected on disk by `recover_after_restart`, not papered over here.
/// Demoting it in memory as well was the first shape of this and it was worse than either option
/// alone: the list said `draft` while `get_doc_page` — which the publish and generate commands both
/// read — still said `generating`, so the row the user was looking at and the row being acted on
/// disagreed about whether a run was in flight.
pub fn list_doc_pages(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<DocPage>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DOC_PAGE_COLUMNS} FROM doc_pages WHERE workspace_id = ?1 ORDER BY updated_at DESC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_doc_page)?;
    rows.collect()
}

/// Moves a document's status without touching its body.
///
/// Separate from [`set_doc_page_content`] because marking a row `generating` used to go through it
/// with an empty string, which meant stopping a regeneration — or having it fail — replaced the
/// document the user had written and possibly already published with nothing. A status is not a
/// content edit, and the two must not share a write.
pub fn set_doc_page_status(
    conn: &Connection,
    id: &str,
    status: &str,
    last_error: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE doc_pages SET status = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status, last_error, now()],
    )?;
    Ok(())
}

pub fn get_doc_page(conn: &Connection, id: &str) -> rusqlite::Result<Option<DocPage>> {
    conn.query_row(
        &format!("SELECT {DOC_PAGE_COLUMNS} FROM doc_pages WHERE id = ?1"),
        params![id],
        map_doc_page,
    )
    .optional()
}

/// Creates an empty document. Its content arrives when the generation runs, or when the user types.
///
/// Separate from the generation for the same reason `create_story_batch` is: the row is what the
/// user *chose to document*, and it has to survive a generation that failed — otherwise the only
/// way to retry is to make the choice again.
pub fn create_doc_page(
    conn: &Connection,
    workspace_id: &str,
    project_id: Option<&str>,
    scope: &str,
    title: &str,
) -> rusqlite::Result<DocPage> {
    let id = Uuid::new_v4().to_string();
    let stamp = now();
    conn.execute(
        "INSERT INTO doc_pages (id, workspace_id, project_id, scope, title, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, workspace_id, project_id, scope, title, stamp],
    )?;
    Ok(get_doc_page(conn, &id)?.expect("the row was just inserted"))
}

/// Replaces a document's body. Used by both the generation and the editor.
pub fn set_doc_page_content(
    conn: &Connection,
    id: &str,
    content: &str,
    status: &str,
    last_error: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE doc_pages SET content = ?2, status = ?3, last_error = ?4, updated_at = ?5 \
         WHERE id = ?1",
        params![id, content, status, last_error, now()],
    )?;
    Ok(())
}

/// Stamps what generated a document. Split from the content write because a run that produced
/// nothing still ran, and knowing which engine failed is worth as much as knowing which succeeded.
pub fn set_doc_page_provenance(
    conn: &Connection,
    id: &str,
    engine: &str,
    model: &str,
    version: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE doc_pages SET engine = ?2, model = ?3, version = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, engine, model, version, now()],
    )?;
    Ok(())
}

pub fn set_doc_page_title(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE doc_pages SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now()],
    )?;
    Ok(())
}

/// Where this document publishes. Remembered per document — a team routinely puts its architecture
/// page in one wiki and a service runbook in another.
pub fn set_doc_page_target(
    conn: &Connection,
    id: &str,
    org: &str,
    project: &str,
    wiki_id: &str,
    wiki_name: &str,
    page_path: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE doc_pages SET ado_org = ?2, ado_project = ?3, wiki_id = ?4, wiki_name = ?5, \
         page_path = ?6, updated_at = ?7 WHERE id = ?1",
        params![id, org, project, wiki_id, wiki_name, page_path, now()],
    )?;
    Ok(())
}

/// Records that the page reached the wiki. Kept apart from the target so "where it would go" and
/// "where it actually went" can differ — which is exactly the state after the target is retargeted.
///
/// Clears `last_error` on the way: a document that failed to generate, was then fixed by hand and
/// published is not a document with an error, and leaving the string would keep a red banner over
/// a page that is live.
pub fn mark_doc_page_published(conn: &Connection, id: &str, url: &str) -> rusqlite::Result<()> {
    let stamp = now();
    conn.execute(
        "UPDATE doc_pages SET published_at = ?2, published_url = ?3, last_error = '', \
         status = 'ready', updated_at = ?2 WHERE id = ?1",
        params![id, stamp, url],
    )?;
    Ok(())
}

pub fn delete_doc_page(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM doc_pages WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- work item reviews ----------

const WORK_ITEM_REVIEW_COLUMNS: &str = "id, workspace_id, ado_org, work_item_id, work_item_type, \
    work_item_url, title, payload, engine, model, version, created_at, updated_at";

fn map_work_item_review(row: &rusqlite::Row) -> rusqlite::Result<WorkItemReviewRow> {
    Ok(WorkItemReviewRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        ado_org: row.get(2)?,
        work_item_id: row.get(3)?,
        work_item_type: row.get(4)?,
        work_item_url: row.get(5)?,
        title: row.get(6)?,
        payload: row.get(7)?,
        engine: row.get(8)?,
        model: row.get(9)?,
        version: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

/// The workspace's saved reviews, newest first.
///
/// Carries the payload of every row: a session's JSON is a few kilobytes and the list is human
/// sized (one per review anyone has run), so the split projection `story_batches` needs to avoid
/// dragging whole diffs around would be complexity bought for nothing here.
pub fn list_work_item_reviews(
    conn: &Connection,
    workspace_id: &str,
) -> rusqlite::Result<Vec<WorkItemReviewRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {WORK_ITEM_REVIEW_COLUMNS} FROM work_item_reviews \
         WHERE workspace_id = ?1 ORDER BY updated_at DESC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_work_item_review)?;
    rows.collect()
}

/// Writes a review session, creating it or overwriting the one with the same id.
///
/// An upsert rather than an insert because a session answers in three stages and the user keeps
/// editing between them: every one of those is the *same* review being saved again, and a row per
/// save would turn one sitting into a dozen indistinguishable history entries. `created_at`
/// deliberately survives the update — it is when the review was started, and that is what makes
/// the list read as a history.
#[allow(clippy::too_many_arguments)]
pub fn save_work_item_review(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    org: &str,
    work_item_id: i64,
    work_item_type: &str,
    work_item_url: &str,
    title: &str,
    payload: &str,
    engine: &str,
    model: &str,
    version: &str,
) -> rusqlite::Result<()> {
    let stamp = now();
    conn.execute(
        "INSERT INTO work_item_reviews \
            (id, workspace_id, ado_org, work_item_id, work_item_type, work_item_url, title, \
             payload, engine, model, version, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12) \
         ON CONFLICT(id) DO UPDATE SET \
            title = excluded.title, payload = excluded.payload, \
            work_item_type = excluded.work_item_type, work_item_url = excluded.work_item_url, \
            engine = excluded.engine, model = excluded.model, version = excluded.version, \
            updated_at = excluded.updated_at",
        params![
            id,
            workspace_id,
            org,
            work_item_id,
            work_item_type,
            work_item_url,
            title,
            payload,
            engine,
            model,
            version,
            stamp
        ],
    )?;
    Ok(())
}

pub fn delete_work_item_review(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM work_item_reviews WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list_story_batches(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<StoryBatch>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BATCH_COLUMNS} FROM story_batches WHERE workspace_id = ?1 ORDER BY updated_at DESC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_batch)?;
    rows.collect()
}

pub fn get_story_batch(conn: &Connection, id: &str) -> rusqlite::Result<Option<StoryBatchDetail>> {
    let batch = conn
        .query_row(
            &format!("SELECT {BATCH_COLUMNS} FROM story_batches WHERE id = ?1"),
            params![id],
            map_batch,
        )
        .optional()?;
    let Some(batch) = batch else { return Ok(None) };
    Ok(Some(StoryBatchDetail { stories: list_story_drafts(conn, id)?, batch }))
}

pub fn list_story_drafts(conn: &Connection, batch_id: &str) -> rusqlite::Result<Vec<StoryDraft>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DRAFT_COLUMNS} FROM story_drafts WHERE batch_id = ?1 ORDER BY seq, created_at"
    ))?;
    let rows = stmt.query_map(params![batch_id], map_draft)?;
    rows.collect()
}

/// Creates an empty batch: its source is captured now, its stories arrive when the generation runs.
///
/// The two are separate steps because the source is what the user *chose* and the stories are what
/// a model *proposed* — a generation that fails, or one the user re-runs with different
/// instructions, must not take the selected wiki pages down with it.
#[allow(clippy::too_many_arguments)]
pub fn create_story_batch(
    conn: &Connection,
    workspace_id: &str,
    project_id: Option<&str>,
    title: &str,
    source_kind: &str,
    source_ref: &str,
    source_text: &str,
    instructions: &str,
) -> rusqlite::Result<StoryBatch> {
    let batch = StoryBatch {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        project_id: project_id.map(str::to_string),
        title: title.to_string(),
        source_kind: source_kind.to_string(),
        source_ref: source_ref.to_string(),
        source_text: source_text.to_string(),
        instructions: instructions.to_string(),
        provider: String::new(),
        model: String::new(),
        prompt_template: String::new(),
        prompt_instructions: String::new(),
        generated_at: String::new(),
        board_provider: String::new(),
        ado_org: String::new(),
        ado_project: String::new(),
        work_item_type: String::new(),
        area_path: String::new(),
        iteration_path: String::new(),
        tags: String::new(),
        open_questions: "[]".to_string(),
        question_answers: "[]".to_string(),
        verify_project_ids: "[]".to_string(),
        feature_project_id: None,
        verify_provider: String::new(),
        verify_model: String::new(),
        verified_at: String::new(),
        status: "draft".to_string(),
        last_error: String::new(),
        created_at: now(),
        updated_at: now(),
    };
    conn.execute(
        "INSERT INTO story_batches (id, workspace_id, project_id, title, source_kind, source_ref,
            source_text, instructions, provider, model, ado_org, ado_project, work_item_type, area_path,
            iteration_path, tags, open_questions, status, last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            batch.id, batch.workspace_id, batch.project_id, batch.title, batch.source_kind, batch.source_ref,
            batch.source_text, batch.instructions, batch.provider, batch.model, batch.ado_org,
            batch.ado_project, batch.work_item_type, batch.area_path, batch.iteration_path, batch.tags,
            batch.open_questions, batch.status, batch.last_error, batch.created_at, batch.updated_at,
        ],
    )?;
    Ok(batch)
}

pub fn rename_story_batch(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now()],
    )?;
    Ok(())
}

/// Saves where this batch publishes to. One target per batch, deliberately: "publish the selected
/// stories" has to be a single decision, not one dropdown per card.
#[allow(clippy::too_many_arguments)]
pub fn set_story_batch_target(
    conn: &Connection,
    id: &str,
    board_provider: &str,
    ado_org: &str,
    ado_project: &str,
    work_item_type: &str,
    area_path: &str,
    iteration_path: &str,
    tags: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET board_provider = ?2, ado_org = ?3, ado_project = ?4,
            work_item_type = ?5, area_path = ?6, iteration_path = ?7, tags = ?8, updated_at = ?9
         WHERE id = ?1",
        params![
            id,
            board_provider,
            ado_org,
            ado_project,
            work_item_type,
            area_path,
            iteration_path,
            tags,
            now()
        ],
    )?;
    Ok(())
}

/// The extra instructions the next generation runs with. Separate from the source: the whole point
/// of keeping the source text is that "generate again, but split the payment story in two" re-reads
/// exactly the documentation the first run saw.
pub fn set_story_batch_instructions(conn: &Connection, id: &str, instructions: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET instructions = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, instructions, now()],
    )?;
    Ok(())
}

pub fn set_story_batch_status(
    conn: &Connection,
    id: &str,
    status: &str,
    last_error: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET status = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status, last_error, now()],
    )?;
    Ok(())
}

/// Records what a finished generation ran on, what it couldn't answer, and the prompt it used.
///
/// The prompt is snapshotted here rather than read back later because both of its halves are
/// mutable elsewhere: the template is one shared row per workspace with no history, and the batch's
/// `instructions` field is overwritten by the rail as soon as the user edits it for the next run.
/// `generated_at` shares the timestamp with `updated_at` so the two can never disagree about when
/// this run landed.
pub fn set_story_batch_run(
    conn: &Connection,
    id: &str,
    provider: &str,
    model: &str,
    open_questions: &str,
    prompt_template: &str,
    prompt_instructions: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET provider = ?2, model = ?3, open_questions = ?4,
            prompt_template = ?5, prompt_instructions = ?6, generated_at = ?7, updated_at = ?7
         WHERE id = ?1",
        params![id, provider, model, open_questions, prompt_template, prompt_instructions, now()],
    )?;
    Ok(())
}

pub fn delete_story_batch(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM story_batches WHERE id = ?1", params![id])?;
    Ok(())
}

/// What one generated story carries into the database. A plain struct rather than eleven
/// positional arguments, because the command layer builds a whole list of these at once.
pub struct NewStoryDraft {
    pub title: String,
    pub narrative: String,
    pub description: String,
    /// Already JSON-encoded by the caller — the parsed shape lives in the command layer.
    pub acceptance_criteria: String,
    pub priority: i64,
    pub story_points: f64,
    /// Hours, alongside the points rather than instead of them. `0.0` is "not estimated".
    pub original_estimate: f64,
    pub tags: String,
    pub notes: String,
}

/// Writes a generation's stories into a batch.
///
/// **Published stories are kept.** A re-run is "propose these again from the same documentation",
/// and a work item that already exists on Azure Boards is not a proposal any more — deleting its
/// row would strip the only record that it was published and let the next publish create a
/// duplicate. Fresh stories are appended after them.
pub fn replace_story_drafts(
    conn: &Connection,
    batch_id: &str,
    stories: &[NewStoryDraft],
) -> rusqlite::Result<Vec<StoryDraft>> {
    conn.execute(
        "DELETE FROM story_drafts WHERE batch_id = ?1 AND work_item_id = 0",
        params![batch_id],
    )?;
    let kept: i64 = conn.query_row(
        "SELECT COUNT(*) FROM story_drafts WHERE batch_id = ?1",
        params![batch_id],
        |row| row.get(0),
    )?;
    for (i, story) in stories.iter().enumerate() {
        insert_story_draft(conn, batch_id, kept + i as i64, story)?;
    }
    list_story_drafts(conn, batch_id)
}

fn insert_story_draft(
    conn: &Connection,
    batch_id: &str,
    seq: i64,
    story: &NewStoryDraft,
) -> rusqlite::Result<StoryDraft> {
    let draft = StoryDraft {
        id: Uuid::new_v4().to_string(),
        batch_id: batch_id.to_string(),
        seq,
        title: story.title.clone(),
        narrative: story.narrative.clone(),
        description: story.description.clone(),
        acceptance_criteria: story.acceptance_criteria.clone(),
        priority: story.priority,
        story_points: story.story_points,
        original_estimate: story.original_estimate,
        tags: story.tags.clone(),
        notes: story.notes.clone(),
        work_item_id: 0,
        work_item_key: String::new(),
        work_item_url: String::new(),
        verify_status: String::new(),
        verify_summary: String::new(),
        verify_criteria: "[]".to_string(),
        verified_at: String::new(),
        status: "draft".to_string(),
        last_error: String::new(),
        created_at: now(),
        updated_at: now(),
    };
    conn.execute(
        "INSERT INTO story_drafts (id, batch_id, seq, title, narrative, description, acceptance_criteria,
            priority, story_points, original_estimate, tags, notes, work_item_id, work_item_url, status,
            last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            draft.id, draft.batch_id, draft.seq, draft.title, draft.narrative, draft.description,
            draft.acceptance_criteria, draft.priority, draft.story_points, draft.original_estimate,
            draft.tags, draft.notes, draft.work_item_id, draft.work_item_url, draft.status,
            draft.last_error, draft.created_at, draft.updated_at,
        ],
    )?;
    Ok(draft)
}

/// Adds one empty story to the end of a batch — the "write one myself" path, which is the same
/// path a generated story ends up on once it has been edited.
pub fn add_story_draft(conn: &Connection, batch_id: &str) -> rusqlite::Result<StoryDraft> {
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), -1) + 1 FROM story_drafts WHERE batch_id = ?1",
        params![batch_id],
        |row| row.get(0),
    )?;
    insert_story_draft(
        conn,
        batch_id,
        next,
        &NewStoryDraft {
            title: String::new(),
            narrative: String::new(),
            description: String::new(),
            acceptance_criteria: "[]".to_string(),
            priority: 0,
            story_points: 0.0,
            original_estimate: 0.0,
            tags: String::new(),
            notes: String::new(),
        },
    )
}

/// Saves the user's edits to one story. Never touches `work_item_id`/`status`: editing a published
/// story changes the draft here, not the work item on Azure — the card says as much.
///
/// **Editing the criteria drops the verification.** A verdict is an answer about one exact wording;
/// once that wording changes, keeping the verdict would show a green "cumple" against a criterion
/// nothing has ever checked — and QA stops looking precisely where the gap now is. Everything else
/// (title, points, tags) leaves the verdicts alone, because none of it changes what was verified.
#[allow(clippy::too_many_arguments)]
pub fn save_story_draft(
    conn: &Connection,
    id: &str,
    title: &str,
    narrative: &str,
    description: &str,
    acceptance_criteria: &str,
    priority: i64,
    story_points: f64,
    original_estimate: f64,
    tags: &str,
    notes: &str,
) -> rusqlite::Result<Option<StoryDraft>> {
    let previous_criteria: Option<String> = conn
        .query_row(
            "SELECT acceptance_criteria FROM story_drafts WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    conn.execute(
        "UPDATE story_drafts SET title = ?2, narrative = ?3, description = ?4, acceptance_criteria = ?5,
            priority = ?6, story_points = ?7, original_estimate = ?8, tags = ?9, notes = ?10, updated_at = ?11
         WHERE id = ?1",
        params![
            id, title, narrative, description, acceptance_criteria, priority, story_points,
            original_estimate, tags, notes, now()
        ],
    )?;
    if previous_criteria.as_deref().is_some_and(|before| before != acceptance_criteria) {
        clear_story_verification(conn, id)?;
    }
    conn.query_row(
        &format!("SELECT {DRAFT_COLUMNS} FROM story_drafts WHERE id = ?1"),
        params![id],
        map_draft,
    )
    .optional()
}

/// The repositories a batch's criteria are checked against, as a JSON array of project ids. An empty
/// array clears them — a batch with no repository simply can't run the check, and the button says so
/// rather than guessing one.
pub fn set_story_batch_verify_projects(
    conn: &Connection,
    id: &str,
    project_ids_json: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET verify_project_ids = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, project_ids_json, now()],
    )?;
    Ok(())
}

/// The answers the team has given to the batch's open questions.
///
/// Deliberately not merged into `instructions`: that field is the user's preferences about *how* to
/// write the backlog and is rewritten wholesale from a textarea, while these are requirements the
/// documentation was missing and have to survive being edited one at a time.
pub fn set_story_batch_answers(conn: &Connection, id: &str, answers_json: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET question_answers = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, answers_json, now()],
    )?;
    Ok(())
}

/// Where the batch's `.feature` file is written. `None` clears it, which leaves the export falling
/// back to the first repository of the verification set.
pub fn set_story_batch_feature_project(
    conn: &Connection,
    id: &str,
    project_id: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET feature_project_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, project_id, now()],
    )?;
    Ok(())
}

/// Records what the last verification ran on. Written once per run, after the verdicts land, so a
/// run that failed to parse leaves the previous (honest) stamp in place.
pub fn set_story_batch_verification_run(
    conn: &Connection,
    id: &str,
    provider: &str,
    model: &str,
) -> rusqlite::Result<()> {
    let stamp = now();
    conn.execute(
        "UPDATE story_batches SET verify_provider = ?2, verify_model = ?3, verified_at = ?4,
            updated_at = ?4
         WHERE id = ?1",
        params![id, provider, model, stamp],
    )?;
    Ok(())
}

/// Files one story's verdicts. `criteria` is the JSON array the command layer built, positionally
/// aligned with the story's own `acceptance_criteria`.
pub fn save_story_verification(
    conn: &Connection,
    id: &str,
    status: &str,
    summary: &str,
    criteria: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_drafts SET verify_status = ?2, verify_summary = ?3, verify_criteria = ?4,
            verified_at = ?5
         WHERE id = ?1",
        params![id, status, summary, criteria, now()],
    )?;
    Ok(())
}

/// Forgets a story's verdicts — back to never-checked. Note this deliberately does *not* touch
/// `updated_at`: dropping a stale verdict is bookkeeping, not an edit, and letting it reorder the
/// batch list would make a story look freshly worked on because someone fixed a typo in it.
pub fn clear_story_verification(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_drafts SET verify_status = '', verify_summary = '', verify_criteria = '[]',
            verified_at = ''
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Files the work item a story became. This is the row that makes publishing idempotent.
pub fn mark_story_published(
    conn: &Connection,
    id: &str,
    work_item_id: i64,
    work_item_key: &str,
    work_item_url: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_drafts SET work_item_id = ?2, work_item_key = ?3, work_item_url = ?4,
            status = 'published', last_error = '', updated_at = ?5
         WHERE id = ?1",
        params![id, work_item_id, work_item_key, work_item_url, now()],
    )?;
    Ok(())
}

pub fn mark_story_error(conn: &Connection, id: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_drafts SET status = 'error', last_error = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, error, now()],
    )?;
    Ok(())
}

/// Deleting a story that was already published only forgets it here; the work item stays on Azure
/// Boards, which is the only honest thing this app can do about something a whole team can see.
pub fn delete_story_draft(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM story_drafts WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    /// A migrated, empty database with one project to hang activity on.
    fn fixture() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        let ws = create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let project = create_project(
            &conn,
            crate::db::models::NewProject {
                workspace_id: ws.id,
                name: "proj".into(),
                local_path: "/tmp/proj".into(),
                remote_url: None,
                color: "#fff".into(),
                icon: "folder".into(),
                ado_org: None,
                ado_project: None,
                ado_repo_id: None,
                github_owner: None,
                github_repo: None,
                github_host: None,
                gitlab_project: None,
                gitlab_host: None,
            },
        )
        .unwrap();
        (conn, project.id)
    }

    fn log(conn: &Connection, project: &str, conversation: &str, engine_session: &str, question: &str) {
        add_activity_log(
            conn,
            project,
            conversation,
            Some(engine_session),
            question,
            "answer",
            None,
            TurnMeta::default(),
            false,
        )
        .unwrap();
    }

    /// The bug this split fixes: Gemini/agy reports one fixed session sentinel for every run, so
    /// when the engine's id was the grouping key, three separate chats collapsed into one activity.
    #[test]
    fn separate_conversations_stay_separate_even_when_the_engine_reuses_one_session_id() {
        let (conn, project) = fixture();
        log(&conn, &project, "conv-1", "agy-last", "primera pregunta");
        log(&conn, &project, "conv-2", "agy-last", "segunda pregunta");
        log(&conn, &project, "conv-3", "agy-last", "tercera pregunta");

        let conversations = list_chat_conversations(&conn, &project, None).unwrap();
        assert_eq!(conversations.len(), 3);
        assert_eq!(conversations.iter().map(|c| c.turn_count).collect::<Vec<_>>(), vec![1, 1, 1]);
    }

    /// The mirror case: the Claude CLI can mint a *new* session id on each resumed turn, which
    /// used to scatter one conversation across several activities.
    #[test]
    fn one_conversation_stays_one_activity_even_when_the_engine_changes_session_id() {
        let (conn, project) = fixture();
        log(&conn, &project, "conv-1", "session-a", "pregunta");
        log(&conn, &project, "conv-1", "session-b", "seguimiento");

        let conversations = list_chat_conversations(&conn, &project, None).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].turn_count, 2);
        assert_eq!(conversations[0].title, "pregunta");
    }

    fn log_provider(conn: &Connection, project: &str, conversation: &str, provider: &str) {
        add_activity_log(
            conn,
            project,
            conversation,
            Some("engine-session"),
            "pregunta",
            "answer",
            None,
            TurnMeta { provider: Some(provider), ..TurnMeta::default() },
            false,
        )
        .unwrap();
    }

    /// A conversation reports the engine of its *latest* turn: that's what reveals a resume token
    /// left behind by a different CLI after the chat's routing changed.
    #[test]
    fn a_conversation_reports_the_provider_of_its_latest_turn() {
        let (conn, project) = fixture();
        log_provider(&conn, &project, "conv-1", "opencode");
        log_provider(&conn, &project, "conv-1", "claude");

        assert_eq!(last_turn_provider(&conn, &project, "conv-1").unwrap().as_deref(), Some("claude"));
    }

    /// Turns recorded before provider tracking existed have nothing to compare against — the
    /// caller must read that as "can't tell" and keep the session rather than discard a working one.
    #[test]
    fn a_conversation_without_recorded_providers_reports_none() {
        let (conn, project) = fixture();
        log(&conn, &project, "conv-1", "session-a", "pregunta");

        assert_eq!(last_turn_provider(&conn, &project, "conv-1").unwrap(), None);
        assert_eq!(last_turn_provider(&conn, &project, "conv-inexistente").unwrap(), None);
    }

    /// Reopening a conversation has to resume the engine session its *latest* turn ran under.
    #[test]
    fn a_conversation_keeps_the_engine_session_of_each_turn() {
        let (conn, project) = fixture();
        log(&conn, &project, "conv-1", "session-a", "pregunta");
        log(&conn, &project, "conv-1", "session-b", "seguimiento");

        let turns = get_conversation_messages(&conn, &project, "conv-1").unwrap();
        let latest = turns.iter().filter_map(|t| t.engine_session_id.clone()).next_back();
        assert_eq!(latest.as_deref(), Some("session-b"));
    }

    /// The whole point of `workspace_activity`: a PR reviewed from a link has no project, so it
    /// follows the workspace — visible whichever repository of it is open, invisible from another.
    #[test]
    fn workspace_activity_is_scoped_to_its_workspace_and_not_to_any_project() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        let mine = create_workspace(&conn, "mine", "folder", "#fff").unwrap();
        let other = create_workspace(&conn, "other", "folder", "#fff").unwrap();

        add_workspace_activity(
            &conn, "job-1", &mine.id, "pr-review", "#42 acme/widgets · Fix login", "done", Some("ok"), None,
            r#"{"prId":42,"repoLabel":"acme/widgets"}"#,
        )
        .unwrap();

        let rows = list_workspace_activity(&conn, &mine.id, None, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "#42 acme/widgets · Fix login");
        assert!(list_workspace_activity(&conn, &other.id, None, 0).unwrap().is_empty());
    }

    /// Renaming and deleting have to reach these rows too — they show in the same list, with the
    /// same pencil and the same trash, as the rows that live in `job_history`.
    #[test]
    fn workspace_activity_can_be_renamed_and_deleted() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        let ws = create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        add_workspace_activity(&conn, "job-1", &ws.id, "pr-review", "#42 acme/widgets", "done", None, None, "{}")
            .unwrap();

        rename_workspace_activity(&conn, "job-1", "Revisión del viernes").unwrap();
        assert_eq!(
            list_workspace_activity(&conn, &ws.id, None, 0).unwrap()[0].custom_label.as_deref(),
            Some("Revisión del viernes")
        );

        delete_workspace_activity(&conn, "job-1").unwrap();
        assert!(list_workspace_activity(&conn, &ws.id, None, 0).unwrap().is_empty());
    }

    fn story_fixture() -> (Connection, StoryBatch) {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        let ws = create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let batch =
            create_story_batch(&conn, &ws.id, None, "Checkout", "wiki", "/Producto", "documentación", "")
                .unwrap();
        (conn, batch)
    }

    fn proposal(title: &str) -> NewStoryDraft {
        NewStoryDraft {
            title: title.to_string(),
            narrative: "Como usuario, quiero pagar, para completar mi compra".to_string(),
            description: "contexto".to_string(),
            acceptance_criteria: r#"["Dado …\nCuando …\nEntonces …"]"#.to_string(),
            priority: 2,
            story_points: 3.0,
            original_estimate: 4.0,
            tags: "checkout".to_string(),
            notes: String::new(),
        }
    }

    /// The contract that makes re-generating safe: a story that already exists on Azure Boards
    /// survives the re-run (its work item id is the only thing stopping a duplicate), and the new
    /// proposals are appended after it rather than renumbered on top of it.
    #[test]
    fn regenerating_keeps_published_stories_and_appends_the_rest() {
        let (conn, batch) = story_fixture();
        let first = replace_story_drafts(&conn, &batch.id, &[proposal("Pagar"), proposal("Cancelar")]).unwrap();
        assert_eq!(first.len(), 2);

        mark_story_published(&conn, &first[0].id, 4321, "", "https://dev.azure.com/x/_workitems/edit/4321")
            .unwrap();

        let second = replace_story_drafts(&conn, &batch.id, &[proposal("Reembolsar")]).unwrap();
        assert_eq!(second.len(), 2, "the published story is kept, the unpublished one replaced");
        assert_eq!(second[0].title, "Pagar");
        assert_eq!(second[0].work_item_id, 4321);
        assert_eq!(second[0].status, "published");
        assert_eq!(second[1].title, "Reembolsar");
        // Appended *after* what was kept, so the sequence never collides.
        assert_eq!(second[1].seq, 1);
    }

    /// Editing a published story changes the draft here and nothing on the host — the work item id
    /// has to survive the save, or the next publish would create a duplicate.
    #[test]
    fn editing_a_published_story_keeps_its_work_item() {
        let (conn, batch) = story_fixture();
        let stories = replace_story_drafts(&conn, &batch.id, &[proposal("Pagar")]).unwrap();
        mark_story_published(&conn, &stories[0].id, 99, "", "https://x/99").unwrap();

        let saved = save_story_draft(
            &conn, &stories[0].id, "Pagar con tarjeta", "Como usuario…", "otro contexto", "[]", 1, 5.0, 6.0, "pagos", "",
        )
        .unwrap()
        .expect("the story still exists");
        assert_eq!(saved.title, "Pagar con tarjeta");
        assert_eq!(saved.story_points, 5.0);
        assert_eq!(saved.original_estimate, 6.0);
        assert_eq!(saved.work_item_id, 99);
        assert_eq!(saved.status, "published");
    }

    /// A verdict is an answer about one exact wording. Editing that wording has to drop it, or the
    /// card would show a green "cumple" against a criterion nothing has ever checked — and QA would
    /// stop looking exactly where the gap now is. Everything else is left alone: renaming a story
    /// or re-estimating it changes nothing about what was verified.
    #[test]
    fn editing_the_criteria_drops_the_verdicts_but_renaming_does_not() {
        let (conn, batch) = story_fixture();
        let stories = replace_story_drafts(&conn, &batch.id, &[proposal("Pagar")]).unwrap();
        let id = &stories[0].id;
        let verdicts = r#"[{"verdict":"pass","evidence":["src/pago.ts:12"],"note":"","covered_by_test":true}]"#;
        save_story_verification(&conn, id, "pass", "Implementada", verdicts).unwrap();

        // Same criteria, different title: the verification still describes what was checked.
        let renamed = save_story_draft(
            &conn, id, "Pagar con tarjeta", "Como usuario…", "contexto",
            r#"["Dado …\nCuando …\nEntonces …"]"#, 2, 3.0, 4.0, "checkout", "",
        )
        .unwrap()
        .expect("the story still exists");
        assert_eq!(renamed.verify_status, "pass");
        assert_eq!(renamed.verify_criteria, verdicts);

        // A criterion rewritten: every verdict on the row is now about text that no longer exists.
        let edited = save_story_draft(
            &conn, id, "Pagar con tarjeta", "Como usuario…", "contexto",
            r#"["Escenario: otro\nDado …"]"#, 2, 3.0, 4.0, "checkout", "",
        )
        .unwrap()
        .expect("the story still exists");
        assert_eq!(edited.verify_status, "");
        assert_eq!(edited.verify_summary, "");
        assert_eq!(edited.verify_criteria, "[]");
        assert_eq!(edited.verified_at, "");
    }

    /// A batch is workspace-scoped and its stories hang off it: deleting the workspace has to take
    /// both away, and deleting the batch has to take its stories.
    #[test]
    fn a_batch_and_its_stories_cascade() {
        let (conn, batch) = story_fixture();
        replace_story_drafts(&conn, &batch.id, &[proposal("Pagar")]).unwrap();
        assert_eq!(get_story_batch(&conn, &batch.id).unwrap().unwrap().stories.len(), 1);

        delete_story_batch(&conn, &batch.id).unwrap();
        assert!(get_story_batch(&conn, &batch.id).unwrap().is_none());
        assert!(list_story_drafts(&conn, &batch.id).unwrap().is_empty());
    }

    /// A batch left mid-generation by a killed session must not come back showing a spinner for a
    /// process that died yesterday.
    #[test]
    fn a_generating_batch_is_demoted_on_restart() {
        let (conn, batch) = story_fixture();
        set_story_batch_status(&conn, &batch.id, "generating", "").unwrap();
        recover_after_restart(&conn).unwrap();
        assert_eq!(get_story_batch(&conn, &batch.id).unwrap().unwrap().batch.status, "draft");
    }

    /// The two scopes share a table, and `project_id` is what tells them apart: a repository
    /// document names the repo it describes, a workspace one names none because its subject is
    /// what happens *between* them. Both have to round-trip.
    #[test]
    fn a_document_remembers_its_scope_its_target_and_where_it_was_published() {
        let (conn, project) = fixture();
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();

        let repo_doc = create_doc_page(&conn, &workspace, Some(&project), "repo", "checkout-api").unwrap();
        let system_doc = create_doc_page(&conn, &workspace, None, "workspace", "Arquitectura").unwrap();
        assert_eq!(repo_doc.project_id.as_deref(), Some(project.as_str()));
        assert_eq!(system_doc.project_id, None, "a workspace document documents no single repo");

        set_doc_page_content(&conn, &repo_doc.id, "# checkout-api\n\nVariables…", "ready", "").unwrap();
        set_doc_page_target(&conn, &repo_doc.id, "acme", "Plataforma", "wiki-1", "Plataforma.wiki", "/Servicios/Checkout")
            .unwrap();
        mark_doc_page_published(&conn, &repo_doc.id, "https://dev.azure.com/acme/_wiki").unwrap();

        let stored = get_doc_page(&conn, &repo_doc.id).unwrap().unwrap();
        assert!(stored.content.starts_with("# checkout-api"));
        assert_eq!(stored.page_path, "/Servicios/Checkout");
        assert_eq!(stored.wiki_name, "Plataforma.wiki");
        assert!(!stored.published_at.is_empty());

        // Newest first, and both scopes in one list.
        let listed = list_doc_pages(&conn, &workspace).unwrap();
        assert_eq!(listed.len(), 2);

        delete_doc_page(&conn, &system_doc.id).unwrap();
        assert_eq!(list_doc_pages(&conn, &workspace).unwrap().len(), 1);
    }

    /// A row still claiming to be mid-generation after a restart would show a spinner nothing is
    /// going to stop, so the recovery pass demotes it **on disk** — and the document it had already
    /// written survives that, because a killed run's work is still work.
    #[test]
    fn a_generating_document_is_demoted_on_restart_without_losing_its_body() {
        let (conn, project) = fixture();
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        let page = create_doc_page(&conn, &workspace, Some(&project), "repo", "api").unwrap();
        set_doc_page_content(&conn, &page.id, "# api\n\nLo que alcanzó a escribir", "ready", "").unwrap();
        set_doc_page_status(&conn, &page.id, "generating", "").unwrap();

        // Before recovery the row tells the truth rather than a convenient lie: the list and
        // `get_doc_page` have to agree about whether a run is in flight.
        assert_eq!(list_doc_pages(&conn, &workspace).unwrap()[0].status, "generating");

        recover_after_restart(&conn).unwrap();
        let recovered = get_doc_page(&conn, &page.id).unwrap().unwrap();
        assert_eq!(recovered.status, "draft");
        assert!(recovered.content.contains("Lo que alcanzó a escribir"));
    }

    /// The bug this guards: marking a row `generating` used to go through the content write with an
    /// empty string, so stopping a regeneration replaced a document the user had written — and
    /// possibly already published — with nothing.
    #[test]
    fn starting_and_failing_a_generation_never_touches_the_document() {
        let (conn, project) = fixture();
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        let page = create_doc_page(&conn, &workspace, Some(&project), "repo", "api").unwrap();
        set_doc_page_content(&conn, &page.id, "# api\n\nDocumento publicado", "ready", "").unwrap();

        set_doc_page_status(&conn, &page.id, "generating", "").unwrap();
        set_doc_page_status(&conn, &page.id, "error", "el motor falló").unwrap();

        let after = get_doc_page(&conn, &page.id).unwrap().unwrap();
        assert!(after.content.contains("Documento publicado"), "a failed run must not erase the page");
        assert_eq!(after.last_error, "el motor falló");
    }

    /// Documents belong to the repository they describe: dropping the repo from the workspace has
    /// to take its document with it rather than leave one pointing at nothing.
    #[test]
    fn deleting_a_repository_takes_its_document_with_it() {
        let (conn, project) = fixture();
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        create_doc_page(&conn, &workspace, Some(&project), "repo", "api").unwrap();
        create_doc_page(&conn, &workspace, None, "workspace", "Arquitectura").unwrap();

        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute("DELETE FROM projects WHERE id = ?1", params![project]).unwrap();

        let left = list_doc_pages(&conn, &workspace).unwrap();
        assert_eq!(left.len(), 1, "the workspace document survives; the repository one does not");
        assert_eq!(left[0].scope, "workspace");
    }

    /// A chain of `steps` instructions, queued and ready to be claimed, plus the routable agent
    /// every step is snapshotted from — without provider *and* model the scheduler refuses to
    /// dispatch at all, which would make any test below pass for the wrong reason.
    /// A plan whose steps carry a check and a failure target, queued and ready to claim.
    fn queued_plan(conn: &Connection, project: &str, plan: &[(&str, i64)]) -> ChainDetail {
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        let agent =
            upsert_workspace_agent(conn, None, &workspace, "Bot", "role", "claude", "sonnet", "", true).unwrap();
        let steps: Vec<NewChainStep> = plan
            .iter()
            .enumerate()
            .map(|(at, (check, on_fail))| NewChainStep {
                agent_id: agent.id.clone(),
                instruction: format!("step {at}"),
                check_command: check.to_string(),
                on_fail: *on_fail,
                ..Default::default()
            })
            .collect();
        let detail = create_agent_chain(conn, &[project.to_string()], "plan", "objetivo", &steps, "").unwrap();
        resume_chain(conn, &detail.chain.id).unwrap();
        detail
    }

    fn queued_chain(conn: &Connection, project: &str, steps: usize) -> ChainDetail {
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        let agent =
            upsert_workspace_agent(conn, None, &workspace, "Bot", "role", "claude", "sonnet", "", true).unwrap();
        let plan: Vec<NewChainStep> = (0..steps)
            .map(|at| NewChainStep {
                agent_id: agent.id.clone(),
                instruction: format!("step {at}"),
                ..Default::default()
            })
            .collect();
        let detail =
            create_agent_chain(conn, &[project.to_string()], "plan", "objetivo", &plan, "").unwrap();
        resume_chain(conn, &detail.chain.id).unwrap();
        detail
    }


    /// Deleting a chain takes its steps' tasks with it.
    ///
    /// The bug: `agent_chain_steps.task_id` carries no foreign key on purpose, so the cascade that
    /// removed the steps could not touch the tasks. A deleted plan left its turns behind as
    /// free-standing rows in the tree, belonging to nothing.
    #[test]
    fn deleting_a_chain_deletes_the_tasks_its_steps_produced() {
        let (conn, project) = fixture();
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        let chain_id = queued_chain(&conn, &project, 2).chain.id;

        let first = claim_next_chain_step(&conn, &chain_id, "run-1").unwrap().step.unwrap();
        complete_chain_step(&conn, &first.id, "done", "hecho", "").unwrap();
        claim_next_chain_step(&conn, &chain_id, "run-2").unwrap();
        assert_eq!(list_agent_tasks(&conn, &workspace).unwrap().len(), 2, "two steps, two tasks");

        delete_chain(&conn, &chain_id).unwrap();
        assert!(list_agent_tasks(&conn, &workspace).unwrap().is_empty(), "and none of them outlive the plan");
    }

    /// A task the user made by hand is not the chain's to delete, however the two are filed.
    #[test]
    fn deleting_a_chain_leaves_tasks_that_were_never_its_own() {
        let (conn, project) = fixture();
        let workspace: String =
            conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project], |r| r.get(0))
                .unwrap();
        let chain_id = queued_chain(&conn, &project, 1).chain.id;
        claim_next_chain_step(&conn, &chain_id, "run-1").unwrap();
        let mine =
            create_agent_task(&conn, &workspace, &project, "a", "Bot", "claude", "sonnet", "", "mi tarea", "mi tarea", "")
                .unwrap();

        delete_chain(&conn, &chain_id).unwrap();
        let left = list_agent_tasks(&conn, &workspace).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, mine.id);
    }

    /// Re-running from a step is the loop pointed by hand: the plan goes back, that step is told
    /// what the user wants different, and the message it opens with actually carries it.
    #[test]
    fn rerunning_from_a_step_carries_the_users_words_into_it() {
        let (conn, project) = fixture();
        let chain_id = queued_chain(&conn, &project, 2).chain.id;
        for at in 1..=2 {
            let step = claim_next_chain_step(&conn, &chain_id, &format!("run-{at}")).unwrap().step.unwrap();
            complete_chain_step(&conn, &step.id, "done", "primera pasada", "").unwrap();
        }
        assert_eq!(chain_row(&conn, &chain_id).unwrap().unwrap().status, "done");

        let chain = rerun_chain_from(&conn, &chain_id, 1, "usa el helper que ya existe").unwrap().unwrap();
        assert_eq!(chain.status, "queued", "a finished plan can be sent back");

        let claim = claim_next_chain_step(&conn, &chain_id, "run-3").unwrap();
        let step = claim.step.unwrap();
        assert_eq!(step.step_index, 1, "from where it was asked, not from the top");
        assert_eq!(step.attempts, 1, "attempts start over — this is a person spending, not a retry");
        assert!(claim.message.contains("usa el helper que ya existe"));

        let steps = get_chain_detail(&conn, &chain_id).unwrap().unwrap().steps;
        assert_eq!(steps[0].status, "done", "the step before it was left alone");
    }

    /// The loop. A later step rejects the work and the plan goes **back**, which is the thing a
    /// chain could not express at all before `on_fail` existed.
    ///
    /// What it checks beyond "it went back" is the part that makes the loop worth having: the step
    /// it lands on is `pending` again with its frozen message cleared, and it is carrying the
    /// rejection. A second lap that re-received its original instruction verbatim would produce its
    /// original answer verbatim, and the plan would go round forever getting nowhere.
    #[test]
    fn a_failed_check_sends_the_plan_back_and_tells_it_why() {
        let (conn, project) = fixture();
        // Step 0 implements, step 1 reviews and sends it back to 0 when its check fails.
        let chain_id = queued_plan(&conn, &project, &[("", -1), ("exit 1", 0)]).chain.id;

        let first = claim_next_chain_step(&conn, &chain_id, "run-1").unwrap().step.unwrap();
        complete_chain_step(&conn, &first.id, "done", "primer intento", "").unwrap();
        let reviewer = claim_next_chain_step(&conn, &chain_id, "run-2").unwrap().step.unwrap();
        assert_eq!(reviewer.step_index, 1);

        let chain = complete_chain_step(&conn, &reviewer.id, "check_failed", "no me gusta", "FAIL: 2 tests")
            .unwrap()
            .unwrap();
        assert_eq!(chain.status, "queued", "a rejection keeps the plan moving, it does not park it");
        assert_eq!(chain.last_reason, "chain.checkFailed");

        let steps = get_chain_detail(&conn, &chain_id).unwrap().unwrap().steps;
        assert_eq!(steps[0].status, "pending", "step 0 runs again");
        assert_eq!(steps[1].status, "pending", "and so does everything after it");
        assert_eq!(steps[0].pending_input, "", "last lap's frozen message is gone");
        assert!(steps[0].feedback.contains("FAIL: 2 tests"), "the check's own output travels back");
        assert!(steps[0].feedback.contains("no me gusta"), "and so does what the reviewer said");

        // And the second lap actually opens with it, rather than merely storing it.
        let again = claim_next_chain_step(&conn, &chain_id, "run-3").unwrap();
        assert_eq!(again.step.unwrap().step_index, 0);
        assert!(again.message.contains("FAIL: 2 tests"), "the message the agent gets carries the rejection");
    }

    /// The same rejection with nowhere to send it: the step retries **itself**, which is what makes
    /// a check useful on a plan with only one step in it.
    #[test]
    fn a_failed_check_with_no_target_retries_the_step_that_failed_it() {
        let (conn, project) = fixture();
        let chain_id = queued_plan(&conn, &project, &[("exit 1", -1), ("", -1)]).chain.id;

        let step = claim_next_chain_step(&conn, &chain_id, "run-1").unwrap().step.unwrap();
        complete_chain_step(&conn, &step.id, "check_failed", "hecho", "boom").unwrap();

        let steps = get_chain_detail(&conn, &chain_id).unwrap().unwrap().steps;
        assert_eq!(steps[0].status, "pending");
        assert!(steps[0].feedback.contains("boom"));
        assert_eq!(steps[1].status, "pending", "the plan never got past the step that failed");

        let again = claim_next_chain_step(&conn, &chain_id, "run-2").unwrap().step.unwrap();
        assert_eq!(again.step_index, 0, "the same step, not the one behind it");
        assert_eq!(again.attempts, 2, "and it costs an attempt, which is what bounds this");
    }

    /// Forward is the other direction the same mechanism gives: a step that passes can declare the
    /// work behind it unnecessary. What is jumped over must end up `skipped` rather than left
    /// `pending`, or the selector would simply hand back the first of them and the branch would
    /// quietly do nothing at all.
    #[test]
    fn a_step_can_branch_forward_past_work_it_made_unnecessary() {
        let (conn, project) = fixture();
        let chain_id = queued_plan(&conn, &project, &[("", -1), ("", -1), ("", -1)]).chain.id;
        conn.execute(
            "UPDATE agent_chain_steps SET on_pass = 2 WHERE chain_id = ?1 AND step_index = 0",
            params![chain_id],
        )
        .unwrap();

        let first = claim_next_chain_step(&conn, &chain_id, "run-1").unwrap().step.unwrap();
        complete_chain_step(&conn, &first.id, "done", "ya está", "").unwrap();

        let landed = claim_next_chain_step(&conn, &chain_id, "run-2").unwrap().step.unwrap();
        assert_eq!(landed.step_index, 2, "it went where it was told");
        let steps = get_chain_detail(&conn, &chain_id).unwrap().unwrap().steps;
        assert_eq!(steps[1].status, "skipped", "and what it stepped over says so");
    }

    /// The stop on the loop, walked all the way to the end.
    ///
    /// A plan that can send itself backwards is a program, and a program with no bound is one that
    /// runs an engine against a real working copy until somebody notices. This drives an
    /// unconditional loop as far as it will go and asserts it lands on a **failed** chain rather
    /// than on a chain that is still, quietly, `queued`.
    #[test]
    fn an_unconditional_loop_runs_out_of_budget_instead_of_running_forever() {
        let (conn, project) = fixture();
        let chain_id = queued_plan(&conn, &project, &[("", -1), ("exit 1", 0)]).chain.id;

        // Far more laps than either bound allows; the assertion is that it stops on its own.
        let mut dispatched = 0;
        for at in 0..64 {
            let claim = claim_next_chain_step(&conn, &chain_id, &format!("run-{at}")).unwrap();
            let Some(step) = claim.step else { break };
            dispatched += 1;
            let outcome = if step.check_command.is_empty() { "done" } else { "check_failed" };
            complete_chain_step(&conn, &step.id, outcome, "algo", "rechazado").unwrap();
        }

        let chain = chain_row(&conn, &chain_id).unwrap().unwrap();
        assert_eq!(chain.status, "failed", "the loop stopped itself");
        assert!(dispatched < 64, "and it stopped before the test ran out of patience");
        assert!(
            chain.dispatches <= MAX_CHAIN_DISPATCHES,
            "never over budget: {} dispatches",
            chain.dispatches
        );
    }

    /// The auto-retry, and the half of it that matters: that it **stops**.
    ///
    /// A retry loop whose bound lives anywhere other than the code handing the work out is a retry
    /// loop that can spin, and a spinning chain here does not merely burn tokens — every attempt is
    /// an engine session against a real working copy. So this walks the whole thing: three failures
    /// are three dispatches, the fourth claim is refused, and the plan is left `failed` rather than
    /// quietly `queued` forever.
    #[test]
    fn a_failed_step_is_retried_by_itself_and_then_gives_up() {
        let (conn, project) = fixture();
        let chain_id = queued_chain(&conn, &project, 2).chain.id;

        for attempt in 1..=MAX_STEP_ATTEMPTS {
            let claim = claim_next_chain_step(&conn, &chain_id, &format!("run-{attempt}")).unwrap();
            assert_eq!(claim.kind, "run", "attempt {attempt} should have been dispatched");
            let step = claim.step.unwrap();
            assert_eq!(step.attempts, attempt, "the claim is what counts the attempts");

            let chain = complete_chain_step(&conn, &step.id, "error", "", "boom").unwrap().unwrap();
            if attempt < MAX_STEP_ATTEMPTS {
                assert_eq!(chain.status, "queued", "with attempts left the plan keeps itself moving");
                assert_eq!(chain.last_reason, "boom", "and says why while it does");
            } else {
                assert_eq!(chain.status, "failed", "the last attempt stops the plan");
            }
        }

        // The one that would have been the fourth. `claim_next_chain_step` refuses a chain that is
        // not `queued`, so this is idle either way — what it proves is that nothing put it back.
        let after = claim_next_chain_step(&conn, &chain_id, "run-4").unwrap();
        assert_eq!(after.kind, "idle");
        assert_eq!(after.chain.status, "failed");

        let steps = get_chain_detail(&conn, &chain_id).unwrap().unwrap().steps;
        assert_eq!(steps[0].status, "error", "the exhausted step is finally an error, not pending");
        assert_eq!(steps[1].status, "pending", "and the plan never reached the step behind it");
    }

    /// The other half: a retried step that *works* carries on into the rest of the plan, rather
    /// than the retry being a dead end that only ever ends in `failed`.
    #[test]
    fn a_step_that_fails_once_and_then_answers_carries_the_plan_on() {
        let (conn, project) = fixture();
        let chain_id = queued_chain(&conn, &project, 2).chain.id;

        let first = claim_next_chain_step(&conn, &chain_id, "run-1").unwrap().step.unwrap();
        complete_chain_step(&conn, &first.id, "error", "", "flaky").unwrap();

        let retried = claim_next_chain_step(&conn, &chain_id, "run-2").unwrap().step.unwrap();
        assert_eq!(retried.id, first.id, "the same step, not the one behind it");
        let chain = complete_chain_step(&conn, &retried.id, "done", "el plan", "").unwrap().unwrap();
        assert_eq!(chain.status, "queued");

        let second = claim_next_chain_step(&conn, &chain_id, "run-3").unwrap().step.unwrap();
        assert_eq!(second.step_index, 1, "the plan moved on");

        let steps = get_chain_detail(&conn, &chain_id).unwrap().unwrap().steps;
        assert_eq!(steps[0].status, "done");
        assert_eq!(steps[0].output_text, "el plan", "the failed attempt left no residue on it");
    }
}

// ---------- what the engines have spent ----------
//
// One row per finished run that reported anything. Global rather than per workspace: an engine's
// consumption is an account's, and splitting it by which folder happened to be open would answer a
// question nobody is asking of a status bar.

/// Files one run's report. Silently a no-op for a run that reported nothing worth keeping — the
/// caller checks too, and a meter is never worth failing a turn over.
pub fn record_ai_usage(
    conn: &Connection,
    provider: &str,
    model: &str,
    task: &str,
    usage: &crate::ai::AiUsage,
) -> rusqlite::Result<()> {
    if usage.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO ai_usage (id, provider, model, task, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, cost_usd, has_cost, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            Uuid::new_v4().to_string(),
            provider,
            model,
            task,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_write_tokens,
            usage.cost_usd.unwrap_or(0.0),
            usage.cost_usd.is_some(),
            now(),
        ],
    )?;
    Ok(())
}

/// Everything the statistics screen draws, for one window — and a sweep of anything older than the
/// retention window.
///
/// The sweep rides on the read rather than on a timer, because a `DELETE` bounded by an index is
/// cheaper than the machinery a scheduled job would need. It used to ride on the status bar's
/// summary read, which ran every few seconds; that read is gone with the spend meter, so this — the
/// only remaining reader of the table — inherited it. The table is therefore now pruned when
/// someone opens Settings → AI rather than continuously, which is later but still bounded: nothing
/// else reads these rows, so the only cost of a late sweep is disk.
///

/// Bucketing is done in SQL, on the timestamp string. That works because `now()` writes RFC 3339 in
/// UTC with a fixed shape, so `strftime` reads it and the buckets are real instants rather than
/// row-order approximations — and because a month of turns is thousands of rows the frontend has no
/// business folding itself.
///
/// The series is **gap-filled** afterwards: SQL only returns the buckets that have a row in them,
/// and a chart drawn from those alone would silently close up the quiet hours and show a week of
/// steady work where there was a burst and four idle days.
pub fn ai_usage_stats(conn: &Connection, window_hours: i64) -> rusqlite::Result<crate::ai_usage::UsageStats> {
    let hours = window_hours.clamp(1, 24 * 90);
    // Before anything is read, so `since` below reports the oldest row that actually survived.
    conn.execute(
        "DELETE FROM ai_usage WHERE created_at < ?1",
        params![(Utc::now() - chrono::Duration::days(crate::ai_usage::KEEP_DAYS))
            .trunc_subsecs(6)
            .to_rfc3339()],
    )?;
    let bucket_minutes = crate::ai_usage::bucket_minutes_for(hours);
    let bucket_seconds = bucket_minutes * 60;
    let now = Utc::now().trunc_subsecs(6);
    let from = now - chrono::Duration::hours(hours);
    let cutoff = from.to_rfc3339();

    // Aligned to the epoch rather than to "now minus N": a bucket boundary that moves every time
    // the screen is opened makes two readings of the same window disagree about which column a
    // turn belongs in.
    let mut stmt = conn.prepare(
        "SELECT CAST(strftime('%s', created_at) AS INTEGER) / ?2 AS bucket,
                COUNT(*),
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0),
                COALESCE(SUM(CASE WHEN has_cost THEN cost_usd ELSE 0 END), 0)
         FROM ai_usage WHERE created_at >= ?1
         GROUP BY bucket ORDER BY bucket",
    )?;
    let rows = stmt.query_map(params![cutoff, bucket_seconds], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, f64>(3)?))
    })?;
    let filled: std::collections::HashMap<i64, (i64, i64, f64)> =
        rows.map(|r| r.map(|(bucket, runs, tokens, cost)| (bucket, (runs, tokens, cost)))).collect::<rusqlite::Result<_>>()?;

    let first = from.timestamp() / bucket_seconds;
    let last = now.timestamp() / bucket_seconds;
    let mut series = Vec::with_capacity((last - first + 1).max(0) as usize);
    let mut peak_tokens = 0;
    for bucket in first..=last {
        let (runs, tokens, cost) = filled.get(&bucket).copied().unwrap_or((0, 0, 0.0));
        peak_tokens = peak_tokens.max(tokens);
        series.push(crate::ai_usage::UsageBucket {
            start: chrono::DateTime::from_timestamp(bucket * bucket_seconds, 0)
                .map(|stamp| stamp.to_rfc3339())
                .unwrap_or_default(),
            runs,
            tokens,
            cost_usd: cost,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT provider, COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(CASE WHEN has_cost THEN cost_usd ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN has_cost THEN 1 ELSE 0 END), 0)
         FROM ai_usage WHERE created_at >= ?1
         GROUP BY provider
         ORDER BY SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) DESC",
    )?;
    let providers = stmt
        .query_map(params![cutoff], |row| {
            Ok(crate::ai_usage::ProviderStat {
                provider: row.get(0)?,
                runs: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                cache_read_tokens: row.get(4)?,
                cache_write_tokens: row.get(5)?,
                cost_usd: row.get(6)?,
                costed_runs: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Capped: a workspace that routes per task across many models would otherwise turn the table
    // into the whole screen, and the tail of it is never the answer to anything.
    let mut stmt = conn.prepare(
        "SELECT provider, model, COUNT(*),
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                COALESCE(SUM(CASE WHEN has_cost THEN cost_usd ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN has_cost THEN 1 ELSE 0 END), 0)
         FROM ai_usage WHERE created_at >= ?1
         GROUP BY provider, model ORDER BY tokens DESC LIMIT 24",
    )?;
    let models = stmt
        .query_map(params![cutoff], |row| {
            Ok(crate::ai_usage::ModelStat {
                provider: row.get(0)?,
                model: row.get(1)?,
                runs: row.get(2)?,
                tokens: row.get(3)?,
                cost_usd: row.get(4)?,
                costed_runs: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Uncapped, unlike the model table: the vocabulary is closed (`ai::task`) and short, and the
    // whole point of this breakdown is that a feature missing from it means something.
    let mut stmt = conn.prepare(
        "SELECT task, COUNT(*),
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
                COALESCE(SUM(CASE WHEN has_cost THEN cost_usd ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN has_cost THEN 1 ELSE 0 END), 0)
         FROM ai_usage WHERE created_at >= ?1
         GROUP BY task ORDER BY tokens DESC",
    )?;
    let tasks = stmt
        .query_map(params![cutoff], |row| {
            Ok(crate::ai_usage::TaskStat {
                task: row.get(0)?,
                runs: row.get(1)?,
                tokens: row.get(2)?,
                cost_usd: row.get(3)?,
                costed_runs: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let since: Option<String> = conn
        .query_row("SELECT MIN(created_at) FROM ai_usage", [], |row| row.get(0))
        .optional()?
        .flatten();

    Ok(crate::ai_usage::UsageStats {
        window_hours: hours,
        bucket_minutes,
        series,
        providers,
        models,
        tasks,
        peak_tokens,
        since: since.unwrap_or_default(),
    })
}

// ---------- the agent console's terminal bench ----------

const WORKSPACE_TERMINAL_COLUMNS: &str =
    "id, workspace_id, tab_id, title, cwd, profile_id, transcript, sort_order, created_at";

fn map_workspace_terminal(row: &rusqlite::Row) -> rusqlite::Result<WorkspaceTerminal> {
    Ok(WorkspaceTerminal {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        tab_id: row.get(2)?,
        title: row.get(3)?,
        cwd: row.get(4)?,
        profile_id: row.get(5)?,
        transcript: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: row.get(8)?,
    })
}

/// Every terminal of a workspace, in the order they sit on the bench.
///
/// Transcripts and all — this is what the bench replays into xterm on the way in, and a terminal
/// without its output is the thing the table exists to prevent. They are capped at a quarter of a
/// megabyte each (see `terminal::TRANSCRIPT_LIMIT`), so a bench of a dozen is still a small read.
pub fn list_workspace_terminals(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<WorkspaceTerminal>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {WORKSPACE_TERMINAL_COLUMNS} FROM workspace_terminals WHERE workspace_id = ?1
         ORDER BY sort_order ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_workspace_terminal)?;
    rows.collect()
}

/// Adds one to the end of the bench. The row exists before its shell does, deliberately: the id it
/// gets here is what the pty records against, so a terminal that fails to open is still a row the
/// user can see failed rather than a click that did nothing.
pub fn add_workspace_terminal(
    conn: &Connection,
    workspace_id: &str,
    tab_id: &str,
    title: &str,
    cwd: &str,
    profile_id: &str,
) -> rusqlite::Result<WorkspaceTerminal> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspace_terminals WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    let terminal = WorkspaceTerminal {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        tab_id: tab_id.to_string(),
        title: title.to_string(),
        cwd: cwd.to_string(),
        profile_id: profile_id.to_string(),
        transcript: String::new(),
        sort_order,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO workspace_terminals (id, workspace_id, tab_id, title, cwd, profile_id, transcript, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8)",
        params![
            terminal.id,
            terminal.workspace_id,
            terminal.tab_id,
            terminal.title,
            terminal.cwd,
            terminal.profile_id,
            terminal.sort_order,
            terminal.created_at,
        ],
    )?;
    Ok(terminal)
}

/// A blank title is ignored rather than stored, so cancelling out of the inline editor with an
/// empty field leaves the tab named — the same rule the repository dock's rename follows.
pub fn rename_workspace_terminal(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    conn.execute("UPDATE workspace_terminals SET title = ?2 WHERE id = ?1", params![id, trimmed])?;
    Ok(())
}

/// Writes one session's recorded output. Called on a timer and on the way out — see
/// `terminal::drain_transcripts` for why the whole buffer is written rather than an append.
pub fn save_workspace_terminal_transcript(conn: &Connection, id: &str, transcript: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE workspace_terminals SET transcript = ?2 WHERE id = ?1",
        params![id, transcript],
    )?;
    Ok(())
}

/// Forgets one terminal, output and all. Killing its shell is the caller's job — this row is the
/// record, not the process.
pub fn delete_workspace_terminal(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_terminals WHERE id = ?1", params![id])?;
    Ok(())
}

/// Empties the whole bench for a workspace, and reports the ids it removed so the caller can kill
/// their shells. Returned rather than looked up separately because the two have to agree: a row
/// deleted whose shell was missed is a process nobody can reach again.
pub fn clear_workspace_terminals(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<String>> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM workspace_terminals WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    conn.execute("DELETE FROM workspace_terminals WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(ids)
}

// ---------- the bench's tabs ----------

const BENCH_TAB_COLUMNS: &str = "id, workspace_id, title, layout, sort_order, created_at";

fn map_bench_tab(row: &rusqlite::Row) -> rusqlite::Result<BenchTab> {
    Ok(BenchTab {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        layout: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
    })
}

pub fn list_bench_tabs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<BenchTab>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BENCH_TAB_COLUMNS} FROM workspace_bench_tabs WHERE workspace_id = ?1
         ORDER BY sort_order ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_bench_tab)?;
    rows.collect()
}

/// A new, empty tab at the end of the strip. Its layout is written later, once it has a pane in it
/// — an empty string means "arrange these however you like", which is the state a tab with no
/// terminals is genuinely in.
pub fn add_bench_tab(conn: &Connection, workspace_id: &str) -> rusqlite::Result<BenchTab> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspace_bench_tabs WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    let tab = BenchTab {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        title: String::new(),
        layout: String::new(),
        sort_order,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO workspace_bench_tabs (id, workspace_id, title, layout, sort_order, created_at)
         VALUES (?1, ?2, '', '', ?3, ?4)",
        params![tab.id, tab.workspace_id, tab.sort_order, tab.created_at],
    )?;
    Ok(tab)
}

/// Records the arrangement of a tab's panes.
///
/// Written on every split, close and finished drag, which is why it takes the tree whole rather
/// than a diff: the frontend owns the shape, and a backend that tried to apply changes to it would
/// need to understand it — which is exactly what keeping this opaque avoids.
pub fn set_bench_layout(conn: &Connection, tab_id: &str, layout: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE workspace_bench_tabs SET layout = ?2 WHERE id = ?1",
        params![tab_id, layout],
    )?;
    Ok(())
}

/// A blank title is ignored rather than stored — the bench falls back to naming a tab after its
/// shells, and an empty name would leave it nameless instead of returning it to that default.
pub fn rename_bench_tab(conn: &Connection, tab_id: &str, title: &str) -> rusqlite::Result<()> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    conn.execute("UPDATE workspace_bench_tabs SET title = ?2 WHERE id = ?1", params![tab_id, trimmed])?;
    Ok(())
}

/// Forgets a tab and every terminal filed under it, and reports those ids so the caller can kill
/// their shells. Returned rather than looked up separately because the two have to agree: a row
/// deleted whose shell was missed is a process nobody can reach again.
pub fn delete_bench_tab(conn: &Connection, tab_id: &str) -> rusqlite::Result<Vec<String>> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM workspace_terminals WHERE tab_id = ?1")?;
        let rows = stmt.query_map(params![tab_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    conn.execute("DELETE FROM workspace_terminals WHERE tab_id = ?1", params![tab_id])?;
    conn.execute("DELETE FROM workspace_bench_tabs WHERE id = ?1", params![tab_id])?;
    Ok(ids)
}

/// Empties the whole bench: every tab, every terminal, every transcript.
pub fn clear_bench_tabs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_bench_tabs WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(())
}
