use chrono::{SubsecRound, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    ActivityLogEntry, AgentChain, AgentChainStep, AgentTask, ChainClaim, ChainDetail, ChainTemplate,
    ChainTemplateStep, ChatConversationSummary, DocPage, JobHistoryEntry, NewChainStep, NewProject, Project,
    ReviewContext, ReviewRunDetail, ReviewRunSummary, StoryBatch, StoryBatchDetail, StoryDraft, Workspace,
    WorkspaceActivityEntry, WorkspaceAgent, WorkspaceMcp, WorkspaceSkill, WorkItemReviewRow,
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
    let ws = Workspace {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        icon: icon.to_string(),
        color: color.to_string(),
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ws.id, ws.name, ws.icon, ws.color, ws.sort_order, ws.created_at],
    )?;
    // Seed the workspace's editable prompt overrides (review standard + PR-description template)
    // with their built-in defaults so a new workspace works out of the box and the user can edit.
    for (kind, default) in [
        ("review_standard", crate::ai::DEFAULT_PR_REVIEW_STANDARD),
        ("pr_description", crate::ai::DEFAULT_PR_DESCRIPTION_TEMPLATE),
    ] {
        conn.execute(
            "INSERT INTO workspace_prompts (workspace_id, kind, content, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![ws.id, kind, default, ws.created_at],
        )?;
    }
    Ok(ws)
}

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

// ---------- workspace prompts (review standard, PR description) ----------

/// The built-in default text for a prompt `kind` — the fallback when a workspace has no override
/// (or blanked it), and the source for the editor's "restore default".
pub fn workspace_prompt_default(kind: &str) -> &'static str {
    match kind {
        "pr_description" => crate::ai::DEFAULT_PR_DESCRIPTION_TEMPLATE,
        "user_stories" => crate::ai::DEFAULT_USER_STORIES_TEMPLATE,
        "story_verify" => crate::ai::DEFAULT_STORY_VERIFY_TEMPLATE,
        "work_item_analyze" => crate::ai::DEFAULT_WORK_ITEM_ANALYZE_TEMPLATE,
        "work_item_bug_analyze" => crate::ai::DEFAULT_WORK_ITEM_BUG_ANALYZE_TEMPLATE,
        "work_item_criteria" => crate::ai::DEFAULT_WORK_ITEM_CRITERIA_TEMPLATE,
        "work_item_tasks" => crate::ai::DEFAULT_WORK_ITEM_TASKS_TEMPLATE,
        "repo_doc" => crate::ai::DEFAULT_REPO_DOC_TEMPLATE,
        "workspace_doc" => crate::ai::DEFAULT_WORKSPACE_DOC_TEMPLATE,
        // The SDD/Harness pipeline stages reuse this per-workspace text store; they start empty
        // (no preconfig — the user defines them). The guide is static frontend content, not stored.
        "sdd_stages" => "",
        // review_standard and anything unexpected fall back to the review methodology.
        _ => crate::ai::DEFAULT_PR_REVIEW_STANDARD,
    }
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

// ---------- agent tasks ----------

/// Marks an `activity_log.session_id` as belonging to an agent task rather than to an ordinary
/// chat. Turns are recorded by the same code path either way, so this prefix is what lets the two
/// features own their own conversations: the Agents view lists (and deletes) exactly these, and
/// `list_chat_conversations` skips exactly these.
pub const AGENT_CONVERSATION_PREFIX: &str = "agent-";

const AGENT_TASK_COLUMNS: &str = "id, workspace_id, project_id, agent_id, agent_name, provider, model, prompt, \
     goal, title, conversation_id, status, turns, last_error, created_at, updated_at";

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
        conversation_id: format!("{AGENT_CONVERSATION_PREFIX}{}", Uuid::new_v4()),
        status: "draft".to_string(),
        turns: 0,
        last_error: String::new(),
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    conn.execute(
        "INSERT INTO agent_tasks (id, workspace_id, project_id, agent_id, agent_name, provider, model, prompt,
            goal, title, conversation_id, status, turns, last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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

/// A chain is a list, never a graph — there is no back-edge column anywhere, so it cannot loop by
/// construction. These two are the belt to that pair of braces: a plan nobody meant to author, and
/// a step that keeps failing, both stop on their own.
pub const MAX_CHAIN_STEPS: usize = 8;
const MAX_STEP_ATTEMPTS: i64 = 3;

/// How much of a step's answer is carried into the next step's opening message.
///
/// 6k and not 60k, and this is the least obvious constraint in the codebase: `claude.rs` passes the
/// composed message as **one argv element** (`cmd.arg("-p").arg(inv.prompt)`), and on Windows a
/// provider installed through npm resolves to a `.cmd` shim, which routes the whole command line
/// through cmd.exe — whose ceiling is 8191 characters, not 32767. Nothing else in the app
/// systematically builds prompts this large, so the limit belongs to this feature.
///
/// For anything bigger the channel is the working copy itself: have one step write `docs/plan.md`
/// and the next read it. That is a convention, and the authoring dialog says so.
const HANDOFF_MAX: usize = 6_000;
const HANDOFF_HEAD: usize = 4_000;
const HANDOFF_TAIL: usize = 2_000;

/// Head **and** tail, because a plan's conclusion is at the bottom: keeping only the first N
/// characters would hand the next agent the throat-clearing and drop the decision. Cut on
/// `chars()` so a fixed offset can never split a code point.
fn clamp_handoff(text: &str) -> (String, bool) {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= HANDOFF_MAX {
        return (text.to_string(), false);
    }
    let omitted = chars.len() - HANDOFF_HEAD - HANDOFF_TAIL;
    let head: String = chars[..HANDOFF_HEAD].iter().collect();
    let tail: String = chars[chars.len() - HANDOFF_TAIL..].iter().collect();
    (format!("{head}\n\n…[{omitted} characters omitted]…\n\n{tail}"), true)
}

/// The message a step opens with.
///
/// The headings are English scaffolding around the user's own words, deliberately not translated:
/// they are read by an engine, not by a person, and threading the app's locale through the backend
/// so a prompt could say "Objetivo" would buy nothing an LLM notices.
///
/// The objective is repeated on every step because every step is a fresh engine session that has
/// no memory of the chain (see `claim_next_chain_step`).
fn compose_chain_input(goal: &str, instruction: &str, previous: Option<(&str, i64, &str)>) -> String {
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
    out.push_str("## Your task\n");
    out.push_str(instruction.trim());
    out
}

const CHAIN_COLUMNS: &str =
    "id, project_id, title, goal, status, current_step, step_count, last_reason, created_at, updated_at";

/// The same columns qualified for the join in [`list_agent_chains`]. Written out rather than
/// derived from [`CHAIN_COLUMNS`] by string substitution — a `replace("id,", "c.id,")` also
/// rewrites the `id` inside `project_id`, and the result compiles perfectly and fails at runtime.
const CHAIN_COLUMNS_QUALIFIED: &str = "c.id, c.project_id, c.title, c.goal, c.status, c.current_step, \
     c.step_count, c.last_reason, c.created_at, c.updated_at";

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
    })
}

const STEP_COLUMNS: &str = "id, chain_id, step_index, agent_id, agent_name, provider, model, prompt, \
     instruction, gate, gate_cleared, pending_input, task_id, run_id, log_count_at_dispatch, \
     output_text, output_truncated, status, attempts, last_error, created_at, updated_at";

fn map_step(row: &rusqlite::Row) -> rusqlite::Result<AgentChainStep> {
    Ok(AgentChainStep {
        id: row.get(0)?,
        chain_id: row.get(1)?,
        step_index: row.get(2)?,
        agent_id: row.get(3)?,
        agent_name: row.get(4)?,
        provider: row.get(5)?,
        model: row.get(6)?,
        prompt: row.get(7)?,
        instruction: row.get(8)?,
        gate: row.get(9)?,
        gate_cleared: row.get(10)?,
        pending_input: row.get(11)?,
        task_id: row.get(12)?,
        run_id: row.get(13)?,
        log_count_at_dispatch: row.get(14)?,
        output_text: row.get(15)?,
        output_truncated: row.get(16)?,
        status: row.get(17)?,
        attempts: row.get(18)?,
        last_error: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
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

fn steps_of(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<AgentChainStep>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {STEP_COLUMNS} FROM agent_chain_steps WHERE chain_id = ?1 ORDER BY step_index"
    ))?;
    let rows = stmt.query_map(params![chain_id], map_step)?;
    rows.collect()
}

/// The next step waiting to run, or `None` when the plan is spent.
fn next_pending_step(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<AgentChainStep>> {
    conn.query_row(
        &format!(
            "SELECT {STEP_COLUMNS} FROM agent_chain_steps
             WHERE chain_id = ?1 AND status = 'pending' ORDER BY step_index LIMIT 1"
        ),
        params![chain_id],
        map_step,
    )
    .optional()
}

/// The nearest earlier step that actually produced something, walking backwards — so a skipped or
/// output-less step degrades into "no context" instead of handing the next agent an empty block.
fn previous_output(
    conn: &Connection,
    chain_id: &str,
    step_index: i64,
) -> rusqlite::Result<Option<(String, i64, String)>> {
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

pub fn get_chain_detail(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<ChainDetail>> {
    let Some(chain) = chain_row(conn, chain_id)? else { return Ok(None) };
    let steps = steps_of(conn, chain_id)?;
    Ok(Some(ChainDetail { chain, steps }))
}

/// Writes the plan. Every step's agent is snapshotted here, at authoring time — not at dispatch —
/// so a chain that waits a week at a gate still runs as the roster read when it was written.
///
/// Created `paused`: nothing in this app starts an engine the user did not just ask it to. The
/// frontend queues it in a second call, which is also what makes "create then decide" possible.
pub fn create_agent_chain(
    conn: &Connection,
    project_id: &str,
    title: &str,
    goal: &str,
    steps: &[NewChainStep],
) -> rusqlite::Result<ChainDetail> {
    let workspace_id: String =
        conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project_id], |r| r.get(0))?;
    let roster = list_workspace_agents(conn, &workspace_id)?;

    let tx = conn.unchecked_transaction()?;
    let stamp = now();
    let chain = AgentChain {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        title: title.to_string(),
        goal: goal.to_string(),
        status: "paused".to_string(),
        current_step: 0,
        step_count: steps.len() as i64,
        last_reason: String::new(),
        created_at: stamp.clone(),
        updated_at: stamp.clone(),
    };
    tx.execute(
        "INSERT INTO agent_chains (id, project_id, title, goal, status, current_step, step_count,
            last_reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
        ],
    )?;

    for (index, step) in steps.iter().enumerate() {
        let agent = roster.iter().find(|a| a.id == step.agent_id);
        tx.execute(
            "INSERT INTO agent_chain_steps (id, chain_id, step_index, agent_id, agent_name, provider,
                model, prompt, instruction, gate, gate_cleared, pending_input, task_id, run_id,
                log_count_at_dispatch, output_text, output_truncated, status, attempts, last_error,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, '', '', '', -1, '', 0, 'pending', 0, '', ?11, ?11)",
            params![
                Uuid::new_v4().to_string(),
                chain.id,
                index as i64,
                step.agent_id,
                agent.map(|a| a.name.clone()).unwrap_or_default(),
                agent.map(|a| a.provider.clone()).unwrap_or_default(),
                agent.map(|a| a.model.clone()).unwrap_or_default(),
                agent.map(|a| a.prompt.clone()).unwrap_or_default(),
                step.instruction,
                step.gate,
                stamp,
            ],
        )?;
    }
    tx.commit()?;
    let steps = steps_of(conn, &chain.id)?;
    Ok(ChainDetail { chain, steps })
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
    };
    let mut plan = vec![seed];
    plan.extend(steps.iter().cloned());
    let detail = create_agent_chain(conn, &task.project_id, title, goal, &plan)?;

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

    // The repository can be gone even though the chain is not: `projects` cascades to
    // `agent_chains`, but a claim racing the delete would otherwise create a task in a vacuum.
    let project: Option<(String, String)> = conn
        .query_row(
            "SELECT workspace_id, local_path FROM projects WHERE id = ?1",
            params![chain.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((workspace_id, _local_path)) = project else {
        set_chain_state(conn, chain_id, "failed", "chain.projectGone")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    };

    let Some(step) = next_pending_step(conn, chain_id)? else {
        set_chain_state(conn, chain_id, "done", "")?;
        return Ok(idle_claim(chain_row(conn, chain_id)?.unwrap_or(chain)));
    };

    // A gate parks the chain *before* the step, and freezes the message while it waits — so what
    // the user approves is byte-for-byte what runs, however long they take to look at it.
    if step.gate && !step.gate_cleared {
        if step.pending_input.is_empty() {
            let previous = previous_output(conn, chain_id, step.step_index)?;
            let message = compose_chain_input(
                &chain.goal,
                &step.instruction,
                previous.as_ref().map(|(name, index, text)| (name.as_str(), *index, text.as_str())),
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
            create_agent_task(
                &tx,
                &workspace_id,
                &chain.project_id,
                &step.agent_id,
                &step.agent_name,
                &step.provider,
                &step.model,
                &step.prompt,
                &step.instruction,
                &title,
            )?
        }
    };

    let message = if step.pending_input.is_empty() {
        let previous = previous_output(&tx, chain_id, step.step_index)?;
        compose_chain_input(
            &chain.goal,
            &step.instruction,
            previous.as_ref().map(|(name, index, text)| (name.as_str(), *index, text.as_str())),
        )
    } else {
        step.pending_input.clone()
    };

    // How many turns this conversation already holds. Recovery reads the row at exactly this
    // offset, so a retry after an error can never harvest the previous attempt's error text and
    // hand it forward as though it were the plan.
    let log_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM activity_log WHERE project_id = ?1 AND session_id = ?2",
        params![chain.project_id, task.conversation_id],
        |row| row.get(0),
    )?;

    tx.execute(
        "UPDATE agent_chain_steps SET status = 'running', task_id = ?2, run_id = ?3, pending_input = ?4,
            log_count_at_dispatch = ?5, attempts = attempts + 1, updated_at = ?6
         WHERE id = ?1",
        params![step.id, task.id, run_id, message, log_count, now()],
    )?;
    tx.execute(
        "UPDATE agent_chains SET status = 'running', current_step = ?2, last_reason = '', updated_at = ?3
         WHERE id = ?1",
        params![chain_id, step.step_index, now()],
    )?;
    tx.commit()?;

    let chain = chain_row(conn, chain_id)?.unwrap_or(chain);
    let step = conn.query_row(
        &format!("SELECT {STEP_COLUMNS} FROM agent_chain_steps WHERE id = ?1"),
        params![step.id],
        map_step,
    )?;
    Ok(ChainClaim { chain, kind: "run".to_string(), task: Some(task), step: Some(step), message })
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
    let step: Option<AgentChainStep> = conn
        .query_row(
            &format!("SELECT {STEP_COLUMNS} FROM agent_chain_steps WHERE id = ?1"),
            params![step_id],
            map_step,
        )
        .optional()?;
    let Some(step) = step else { return Ok(None) };
    let chain_id = step.chain_id.clone();

    match outcome {
        "done" => {
            let (clamped, truncated) = clamp_handoff(output_text.trim());
            conn.execute(
                "UPDATE agent_chain_steps SET status = 'done', output_text = ?2, output_truncated = ?3,
                    run_id = '', last_error = '', updated_at = ?4
                 WHERE id = ?1",
                params![step.id, clamped, truncated, now()],
            )?;
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
        "error" => {
            conn.execute(
                "UPDATE agent_chain_steps SET status = 'error', run_id = '', last_error = ?2, updated_at = ?3
                 WHERE id = ?1",
                params![step.id, reason, now()],
            )?;
            set_chain_state(conn, &chain_id, "failed", reason)?;
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
                "SELECT {STEP_COLUMNS} FROM agent_chain_steps
                 WHERE chain_id = ?1 AND status IN ('pending', 'error', 'interrupted')
                 ORDER BY step_index LIMIT 1"
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
                "SELECT {STEP_COLUMNS} FROM agent_chain_steps
                 WHERE chain_id = ?1 AND status IN ('error', 'interrupted') ORDER BY step_index LIMIT 1"
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

pub fn delete_chain(conn: &Connection, chain_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_chains WHERE id = ?1", params![chain_id])?;
    Ok(())
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
    let step: Option<AgentChainStep> = conn
        .query_row(
            &format!("SELECT {STEP_COLUMNS} FROM agent_chain_steps WHERE id = ?1"),
            params![step_id],
            map_step,
        )
        .optional()?;
    let Some(step) = step else { return Ok(None) };
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
            "SELECT {STEP_COLUMNS} FROM agent_chain_steps WHERE status = 'running'"
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
        "SELECT id, template_id, step_index, agent_id, instruction, gate
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
            "INSERT INTO workspace_chain_template_steps (id, template_id, step_index, agent_id, instruction, gate)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                Uuid::new_v4().to_string(),
                template_id,
                index as i64,
                step.agent_id,
                step.instruction,
                step.gate
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

pub fn upsert_workspace_mcp(
    conn: &Connection,
    id: Option<String>,
    workspace_id: &str,
    name: &str,
    command: &str,
    args: &str,
    env: &str,
    enabled: bool,
) -> rusqlite::Result<WorkspaceMcp> {
    let mcp = WorkspaceMcp {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        command: command.to_string(),
        args: args.to_string(),
        env: env.to_string(),
        enabled,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO workspace_mcps (id, workspace_id, name, command, args, env, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, command = excluded.command,
            args = excluded.args, env = excluded.env, enabled = excluded.enabled",
        params![mcp.id, mcp.workspace_id, mcp.name, mcp.command, mcp.args, mcp.env, mcp.enabled, mcp.created_at],
    )?;
    Ok(mcp)
}

pub fn list_workspace_mcps(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<WorkspaceMcp>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, name, command, args, env, enabled, created_at
         FROM workspace_mcps WHERE workspace_id = ?1 ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(WorkspaceMcp {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            name: row.get(2)?,
            command: row.get(3)?,
            args: row.get(4)?,
            env: row.get(5)?,
            enabled: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn delete_workspace_mcp(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_mcps WHERE id = ?1", params![id])?;
    Ok(())
}

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

/// The column list every `activity_log` read shares, so the row indices below can't drift apart.
const ACTIVITY_COLUMNS: &str =
    "id, project_id, session_id, engine_session_id, question, answer, trace, created_at, response_time_ms, is_error, provider, model, engine_version";

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

fn all_activity_log_entries(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<ActivityLogEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTIVITY_COLUMNS}
         FROM activity_log WHERE project_id = ?1 AND session_id IS NOT NULL ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![project_id], read_activity_row)?;
    rows.collect()
}

/// Groups every turn into one summary per `session_id` (title = first question asked,
/// `updated_at` = latest turn) — the conversation-level list the history sidebar/modal show.
/// `search`, when given, keeps only conversations where *any* turn's question or answer
/// contains it, so search covers full past exchanges, not just the title.
pub fn list_chat_conversations(
    conn: &Connection,
    project_id: &str,
    search: Option<&str>,
) -> rusqlite::Result<Vec<ChatConversationSummary>> {
    let entries = all_activity_log_entries(conn, project_id)?;
    let needle = search.map(|s| s.to_lowercase());

    let mut order: Vec<String> = Vec::new();
    let mut by_session: std::collections::HashMap<String, ChatConversationSummary> = std::collections::HashMap::new();
    let mut matched: std::collections::HashSet<String> = std::collections::HashSet::new();

    for e in &entries {
        let Some(sid) = e.session_id.clone() else { continue };
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

pub fn list_job_history(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<JobHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, kind, label, custom_label, status, result, error, meta, created_at
         FROM job_history WHERE project_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
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

pub fn list_workspace_activity(
    conn: &Connection,
    workspace_id: &str,
) -> rusqlite::Result<Vec<WorkspaceActivityEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, kind, label, custom_label, status, result, error, meta, created_at
         FROM workspace_activity WHERE workspace_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
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
    tags, open_questions, status, last_error, created_at, updated_at, verify_project_id, \
    verify_provider, verify_model, verified_at";

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
        verify_project_id: row.get(21)?,
        verify_provider: row.get(22)?,
        verify_model: row.get(23)?,
        verified_at: row.get(24)?,
    })
}

const DRAFT_COLUMNS: &str = "id, batch_id, seq, title, narrative, description, acceptance_criteria, \
    priority, story_points, tags, notes, work_item_id, work_item_url, status, last_error, created_at, \
    updated_at, verify_status, verify_summary, verify_criteria, verified_at";

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
        ado_org: String::new(),
        ado_project: String::new(),
        work_item_type: String::new(),
        area_path: String::new(),
        iteration_path: String::new(),
        tags: String::new(),
        open_questions: "[]".to_string(),
        verify_project_id: None,
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
    ado_org: &str,
    ado_project: &str,
    work_item_type: &str,
    area_path: &str,
    iteration_path: &str,
    tags: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET ado_org = ?2, ado_project = ?3, work_item_type = ?4, area_path = ?5,
            iteration_path = ?6, tags = ?7, updated_at = ?8
         WHERE id = ?1",
        params![id, ado_org, ado_project, work_item_type, area_path, iteration_path, tags, now()],
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

/// Records what a finished generation ran on, and what it couldn't answer.
pub fn set_story_batch_run(
    conn: &Connection,
    id: &str,
    provider: &str,
    model: &str,
    open_questions: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET provider = ?2, model = ?3, open_questions = ?4, updated_at = ?5
         WHERE id = ?1",
        params![id, provider, model, open_questions, now()],
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
        tags: story.tags.clone(),
        notes: story.notes.clone(),
        work_item_id: 0,
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
            priority, story_points, tags, notes, work_item_id, work_item_url, status, last_error,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            draft.id, draft.batch_id, draft.seq, draft.title, draft.narrative, draft.description,
            draft.acceptance_criteria, draft.priority, draft.story_points, draft.tags, draft.notes,
            draft.work_item_id, draft.work_item_url, draft.status, draft.last_error, draft.created_at,
            draft.updated_at,
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
            priority = ?6, story_points = ?7, tags = ?8, notes = ?9, updated_at = ?10
         WHERE id = ?1",
        params![id, title, narrative, description, acceptance_criteria, priority, story_points, tags, notes, now()],
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

/// The repository a batch's criteria are checked against. `None` clears it — a batch with no
/// repository simply can't run the check, and the button says so rather than guessing a repo.
pub fn set_story_batch_verify_project(
    conn: &Connection,
    id: &str,
    project_id: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_batches SET verify_project_id = ?2, updated_at = ?3 WHERE id = ?1",
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
    work_item_url: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE story_drafts SET work_item_id = ?2, work_item_url = ?3, status = 'published',
            last_error = '', updated_at = ?4
         WHERE id = ?1",
        params![id, work_item_id, work_item_url, now()],
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

        let rows = list_workspace_activity(&conn, &mine.id).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "#42 acme/widgets · Fix login");
        assert!(list_workspace_activity(&conn, &other.id).unwrap().is_empty());
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
            list_workspace_activity(&conn, &ws.id).unwrap()[0].custom_label.as_deref(),
            Some("Revisión del viernes")
        );

        delete_workspace_activity(&conn, "job-1").unwrap();
        assert!(list_workspace_activity(&conn, &ws.id).unwrap().is_empty());
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

        mark_story_published(&conn, &first[0].id, 4321, "https://dev.azure.com/x/_workitems/edit/4321").unwrap();

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
        mark_story_published(&conn, &stories[0].id, 99, "https://x/99").unwrap();

        let saved = save_story_draft(
            &conn, &stories[0].id, "Pagar con tarjeta", "Como usuario…", "otro contexto", "[]", 1, 5.0, "pagos", "",
        )
        .unwrap()
        .expect("the story still exists");
        assert_eq!(saved.title, "Pagar con tarjeta");
        assert_eq!(saved.story_points, 5.0);
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
            r#"["Dado …\nCuando …\nEntonces …"]"#, 2, 3.0, "checkout", "",
        )
        .unwrap()
        .expect("the story still exists");
        assert_eq!(renamed.verify_status, "pass");
        assert_eq!(renamed.verify_criteria, verdicts);

        // A criterion rewritten: every verdict on the row is now about text that no longer exists.
        let edited = save_story_draft(
            &conn, id, "Pagar con tarjeta", "Como usuario…", "contexto",
            r#"["Escenario: otro\nDado …"]"#, 2, 3.0, "checkout", "",
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
}
