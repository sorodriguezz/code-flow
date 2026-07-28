use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    ActivityLogEntry, ChatConversationSummary, JobHistoryEntry, NewProject, Project, ReviewContext, ReviewRunDetail,
    ReviewRunSummary, Workspace, WorkspaceAgent, WorkspaceMcp, WorkspaceSkill,
};

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
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

/// How many runs this PR already has — used to number the next iteration.
pub fn count_review_runs(conn: &Connection, project_id: &str, pr_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM review_runs WHERE project_id = ?1 AND pr_id = ?2",
        params![project_id, pr_id],
        |row| row.get(0),
    )
}

/// The newest run's `findings` JSON for this PR, if any — read back on a re-review to reconcile
/// against the previous run.
pub fn latest_review_findings(conn: &Connection, project_id: &str, pr_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT findings FROM review_runs WHERE project_id = ?1 AND pr_id = ?2 ORDER BY created_at DESC LIMIT 1",
        params![project_id, pr_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

/// The head commit SHA of this PR's most recent run (from its `meta` JSON), if any — used to
/// detect "nothing changed since last review" and to diff which files changed since.
pub fn latest_review_head(conn: &Connection, project_id: &str, pr_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT json_extract(meta, '$.head_sha') FROM review_runs
         WHERE project_id = ?1 AND pr_id = ?2 ORDER BY created_at DESC LIMIT 1",
        params![project_id, pr_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|opt| opt.flatten().filter(|s| !s.is_empty()))
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
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO projects (id, workspace_id, name, local_path, remote_url, color, icon, ado_org, ado_project, ado_repo_id, github_owner, github_repo, github_host, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
        sort_order: row.get(13)?,
        created_at: row.get(14)?,
    })
}

const PROJECT_COLUMNS: &str = "id, workspace_id, name, local_path, remote_url, color, icon, ado_org, ado_project, ado_repo_id, github_owner, github_repo, github_host, sort_order, created_at";

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

/// Clears every VCS link (Azure DevOps *and* GitHub) on a project — a project is linked to at
/// most one host at a time, so "disconnect" wipes whichever one is set without the caller
/// needing to know which provider it was.
pub fn unlink_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET ado_org = NULL, ado_project = NULL, ado_repo_id = NULL, \
         github_owner = NULL, github_repo = NULL, github_host = NULL WHERE id = ?1",
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
}
