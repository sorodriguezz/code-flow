use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{NewProject, Project, ReviewContext, Workspace, WorkspaceMcp, WorkspaceMdFile, WorkspaceSkill};

fn now() -> String {
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
    Ok(ws)
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
        sort_order: 0,
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO projects (id, workspace_id, name, local_path, remote_url, color, icon, ado_org, ado_project, ado_repo_id, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
        sort_order: row.get(10)?,
        created_at: row.get(11)?,
    })
}

const PROJECT_COLUMNS: &str = "id, workspace_id, name, local_path, remote_url, color, icon, ado_org, ado_project, ado_repo_id, sort_order, created_at";

pub fn list_projects(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Project>> {
    let sql = format!(
        "SELECT {PROJECT_COLUMNS} FROM projects WHERE workspace_id = ?1 ORDER BY sort_order, created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![workspace_id], map_project)?;
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

pub fn unlink_project_ado(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET ado_org = NULL, ado_project = NULL, ado_repo_id = NULL WHERE id = ?1",
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

// ---------- workspace MD files ----------

pub fn upsert_workspace_md_file(
    conn: &Connection,
    id: Option<String>,
    workspace_id: &str,
    filename: &str,
    content: &str,
    enabled: bool,
) -> rusqlite::Result<WorkspaceMdFile> {
    let existing_created_at = id.as_ref().and_then(|existing_id| {
        conn.query_row(
            "SELECT created_at FROM workspace_md_files WHERE id = ?1",
            params![existing_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    });
    let now_str = now();
    let file = WorkspaceMdFile {
        id: id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        workspace_id: workspace_id.to_string(),
        filename: filename.to_string(),
        content: content.to_string(),
        enabled,
        created_at: existing_created_at.unwrap_or_else(|| now_str.clone()),
        updated_at: now_str,
    };
    conn.execute(
        "INSERT INTO workspace_md_files (id, workspace_id, filename, content, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, content = excluded.content,
            enabled = excluded.enabled, updated_at = excluded.updated_at",
        params![
            file.id,
            file.workspace_id,
            file.filename,
            file.content,
            file.enabled,
            file.created_at,
            file.updated_at,
        ],
    )?;
    Ok(file)
}

pub fn list_workspace_md_files(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<WorkspaceMdFile>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, filename, content, enabled, created_at, updated_at
         FROM workspace_md_files WHERE workspace_id = ?1 ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(WorkspaceMdFile {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            filename: row.get(2)?,
            content: row.get(3)?,
            enabled: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn delete_workspace_md_file(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_md_files WHERE id = ?1", params![id])?;
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
        installed_at: now(),
    };
    conn.execute(
        "INSERT INTO workspace_skills (id, workspace_id, skill_name, source_repo, installed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![skill.id, skill.workspace_id, skill.skill_name, skill.source_repo, skill.installed_at],
    )?;
    Ok(skill)
}

pub fn list_workspace_skills(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<WorkspaceSkill>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, skill_name, source_repo, installed_at
         FROM workspace_skills WHERE workspace_id = ?1 ORDER BY installed_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(WorkspaceSkill {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            skill_name: row.get(2)?,
            source_repo: row.get(3)?,
            installed_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn get_workspace_skill(conn: &Connection, id: &str) -> rusqlite::Result<Option<WorkspaceSkill>> {
    conn.query_row(
        "SELECT id, workspace_id, skill_name, source_repo, installed_at FROM workspace_skills WHERE id = ?1",
        params![id],
        |row| {
            Ok(WorkspaceSkill {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                skill_name: row.get(2)?,
                source_repo: row.get(3)?,
                installed_at: row.get(4)?,
            })
        },
    )
    .optional()
}

pub fn delete_workspace_skill(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM workspace_skills WHERE id = ?1", params![id])?;
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
