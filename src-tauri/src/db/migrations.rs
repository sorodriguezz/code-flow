use rusqlite::Connection;

pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS workspaces (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            icon        TEXT NOT NULL DEFAULT 'folder',
            color       TEXT NOT NULL DEFAULT '#6366f1',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id          TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            local_path  TEXT NOT NULL,
            remote_url  TEXT,
            color       TEXT NOT NULL DEFAULT '#6366f1',
            icon        TEXT NOT NULL DEFAULT 'git-branch',
            ado_org     TEXT,
            ado_project TEXT,
            ado_repo_id TEXT,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        );

        -- Review context is scoped per WORKSPACE (see migrate_review_contexts_to_workspace
        -- below for the project_id -> workspace_id column migration for pre-existing rows).
        CREATE TABLE IF NOT EXISTS review_contexts (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            content      TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT NOT NULL
        );

        -- Free-form markdown instruction files per workspace (a CLAUDE.md-style doc, plus
        -- room for more later) — folded into the review prompt alongside review_contexts,
        -- never written into a project's own working tree.
        CREATE TABLE IF NOT EXISTS workspace_md_files (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            filename     TEXT NOT NULL,
            content      TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );

        -- Skills installed via `npx skills add`, scoped per workspace; synced into whichever
        -- project is actually being reviewed at review time (Claude Code only discovers
        -- skills from a project's own .claude/skills, there's no cross-directory flag for it).
        CREATE TABLE IF NOT EXISTS workspace_skills (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            skill_name   TEXT NOT NULL,
            source_repo  TEXT NOT NULL,
            installed_at TEXT NOT NULL
        );

        -- MCP servers configured per workspace; written out as a --mcp-config JSON file for
        -- headless `claude -p` invocations against any project in the workspace.
        CREATE TABLE IF NOT EXISTS workspace_mcps (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            command      TEXT NOT NULL,
            args         TEXT NOT NULL DEFAULT '',
            env          TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;

    migrate_review_contexts_to_workspace(conn)?;
    drop_legacy_installed_skills(conn)?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `review_contexts` used to be scoped per-project (`project_id`); it's now per-workspace.
/// For any database created before this change, re-point each existing row at its project's
/// workspace (rather than just dropping the column, which would silently discard content the
/// user already wrote) and drop the old column.
fn migrate_review_contexts_to_workspace(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "review_contexts", "project_id")? {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        ALTER TABLE review_contexts ADD COLUMN workspace_id TEXT;
        UPDATE review_contexts
            SET workspace_id = (SELECT workspace_id FROM projects WHERE projects.id = review_contexts.project_id);
        DELETE FROM review_contexts WHERE workspace_id IS NULL;
        ALTER TABLE review_contexts DROP COLUMN project_id;
        "#,
    )
}

/// Superseded by `workspace_skills` — the old table was never actually used for anything
/// (skills management wasn't implemented yet), so there's no data worth preserving.
fn drop_legacy_installed_skills(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("DROP TABLE IF EXISTS installed_skills;")
}
