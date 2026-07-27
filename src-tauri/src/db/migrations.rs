use rusqlite::{Connection, OptionalExtension};

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
            ado_org      TEXT,
            ado_project  TEXT,
            ado_repo_id  TEXT,
            github_owner TEXT,
            github_repo  TEXT,
            github_host  TEXT,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
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

        -- Per-workspace, provider-independent prompt overrides keyed by `kind`
        -- (`review_standard` = the PR review methodology, `pr_description` = the PR-description
        -- generator). One row per (workspace, kind), seeded with the built-in default on creation
        -- and backfilled for pre-existing workspaces (see backfill_workspace_prompts). Empty
        -- content means "use the built-in default", so resetting is just a blank save. These are
        -- deliberately NOT per-provider — the same text applies to whatever engine a task routes to.
        CREATE TABLE IF NOT EXISTS workspace_prompts (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL,
            content      TEXT NOT NULL DEFAULT '',
            updated_at   TEXT NOT NULL,
            PRIMARY KEY (workspace_id, kind)
        );

        -- Durable memory of every completed PR review — one row per run, kept in the DB (not on
        -- disk) so it moves/backs up with codeflow.db. Holds the rendered review, the exact diff
        -- reviewed, run metadata and the parsed findings (JSON), which is what a re-review reads
        -- back to reconcile new/still-present/resolved. Timestamped rows, never overwritten, so the
        -- code a finding referred to stays recoverable even after the branch is gone.
        CREATE TABLE IF NOT EXISTS review_runs (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            workspace_id TEXT NOT NULL,
            pr_id        INTEGER NOT NULL,
            iter         INTEGER NOT NULL,
            level        TEXT NOT NULL,
            meta         TEXT NOT NULL DEFAULT '{}',
            review_md    TEXT NOT NULL,
            diff         TEXT NOT NULL DEFAULT '',
            findings     TEXT NOT NULL DEFAULT '[]',
            created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_review_runs_pr ON review_runs (project_id, pr_id, created_at);

        -- Skills installed via `npx skills add`, scoped per workspace; synced into whichever
        -- project is actually being reviewed at review time (Claude Code only discovers
        -- skills from a project's own .claude/skills, there's no cross-directory flag for it).
        CREATE TABLE IF NOT EXISTS workspace_skills (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            skill_name   TEXT NOT NULL,
            source_repo  TEXT NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 1,
            installed_at TEXT NOT NULL
        );

        -- User-defined SDD/Harness agents (roles) per workspace — name + role + model + prompt.
        -- Deliberately empty by default (no preset roster); the user creates their own.
        CREATE TABLE IF NOT EXISTS workspace_agents (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            role         TEXT NOT NULL DEFAULT '',
            provider     TEXT NOT NULL DEFAULT '',
            model        TEXT NOT NULL DEFAULT '',
            prompt       TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
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

        -- Persisted record of every AI chat question/answer turn, scoped per project — the
        -- chat itself (chatStore) only lives in memory for the session, so without this a
        -- restart silently loses everything that was ever asked. `session_id` is the Claude
        -- Code session these turns can be `--resume`d under; rows sharing one `session_id`
        -- reconstruct a full conversation, letting the UI list/reopen/continue past chats
        -- instead of only ever having one ongoing conversation per project.
        CREATE TABLE IF NOT EXISTS activity_log (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            session_id  TEXT,
            question    TEXT NOT NULL,
            answer      TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        -- Persisted record of every finished PR review / pre-commit analysis run — like
        -- `activity_log` above, `jobsStore` on the frontend only lives in memory for the
        -- session, so without this a restart silently loses every past review/analysis
        -- result. Only successful/errored *completed* runs are recorded (there's nothing
        -- meaningful to reopen from a run that was still in flight when the app closed).
        CREATE TABLE IF NOT EXISTS job_history (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL,
            label        TEXT NOT NULL,
            custom_label TEXT,
            status       TEXT NOT NULL,
            result       TEXT,
            error        TEXT,
            meta         TEXT NOT NULL DEFAULT '{}',
            created_at   TEXT NOT NULL
        );

        -- A user-given rename for a chat conversation (`activity_log` rows grouped by
        -- `session_id`) — conversations don't otherwise have a row of their own to attach a
        -- title to, since they're just a GROUP BY over individual question/answer turns.
        CREATE TABLE IF NOT EXISTS conversation_titles (
            session_id  TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        "#,
    )?;

    migrate_review_contexts_to_workspace(conn)?;
    migrate_md_files_into_contexts(conn)?;
    migrate_review_standards_into_prompts(conn)?;
    backfill_workspace_prompts(conn)?;
    drop_legacy_installed_skills(conn)?;
    add_session_id_to_activity_log(conn)?;
    add_response_time_to_activity_log(conn)?;
    add_is_error_to_activity_log(conn)?;
    add_engine_session_id_to_activity_log(conn)?;
    add_trace_to_activity_log(conn)?;
    add_engine_meta_to_activity_log(conn)?;
    add_custom_label_to_job_history(conn)?;
    add_github_columns_to_projects(conn)?;
    add_github_host_to_projects(conn)?;
    add_enabled_to_workspace_skills(conn)?;
    add_provider_to_workspace_agents(conn)?;
    Ok(())
}

/// `workspace_agents` gained a `provider` column so an agent runs on its own provider + model
/// (not just a bare model id). Existing rows default to empty, falling back to the active provider.
fn add_provider_to_workspace_agents(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "workspace_agents", "provider")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE workspace_agents ADD COLUMN provider TEXT NOT NULL DEFAULT '';")
}

/// `workspace_skills` gained an `enabled` flag so skills can be toggled off (e.g. when not using
/// Claude Code) without deleting them. Existing rows default to enabled — the pre-toggle behavior.
fn add_enabled_to_workspace_skills(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "workspace_skills", "enabled")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE workspace_skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;")
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

/// The old `workspace_md_files` ("Instructions / .md") was functionally identical to
/// `review_contexts` — both were just named text blocks folded into the review prompt. They're now
/// one concept ("Contexto"), so move any md-file rows into `review_contexts` (name = filename) and
/// drop the old table. No-op on fresh installs where the table never existed.
fn migrate_md_files_into_contexts(conn: &Connection) -> rusqlite::Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_md_files'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        INSERT OR IGNORE INTO review_contexts (id, workspace_id, name, content, enabled, created_at)
            SELECT id, workspace_id, filename, content, enabled, created_at FROM workspace_md_files;
        DROP TABLE workspace_md_files;
        "#,
    )
}

/// Moves any rows from the original per-workspace `workspace_review_standards` table (added
/// earlier in this feature's life) into the generalized `workspace_prompts` table under
/// `kind = 'review_standard'`, then drops the old table. No-op on fresh installs where the old
/// table never existed.
fn migrate_review_standards_into_prompts(conn: &Connection) -> rusqlite::Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_review_standards'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        INSERT OR IGNORE INTO workspace_prompts (workspace_id, kind, content, updated_at)
            SELECT workspace_id, 'review_standard', content, updated_at FROM workspace_review_standards;
        DROP TABLE workspace_review_standards;
        "#,
    )
}

/// Seeds the built-in default of every prompt `kind` into every workspace that doesn't have that
/// row yet — both workspaces created before this feature existed and any created outside
/// `create_workspace` (e.g. an imported DB). Seeding the actual default text (not a blank) means
/// users see and can edit the real methodology/template rather than an empty box.
fn backfill_workspace_prompts(conn: &Connection) -> rusqlite::Result<()> {
    let now = crate::db::queries::now();
    for (kind, default) in [
        ("review_standard", crate::ai::DEFAULT_PR_REVIEW_STANDARD),
        ("pr_description", crate::ai::DEFAULT_PR_DESCRIPTION_TEMPLATE),
    ] {
        conn.execute(
            "INSERT INTO workspace_prompts (workspace_id, kind, content, updated_at)
             SELECT w.id, ?1, ?2, ?3 FROM workspaces w
             WHERE NOT EXISTS (
                 SELECT 1 FROM workspace_prompts p WHERE p.workspace_id = w.id AND p.kind = ?1
             )",
            rusqlite::params![kind, default, now],
        )?;
    }
    Ok(())
}

/// Superseded by `workspace_skills` — the old table was never actually used for anything
/// (skills management wasn't implemented yet), so there's no data worth preserving.
fn drop_legacy_installed_skills(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("DROP TABLE IF EXISTS installed_skills;")
}

/// `activity_log` originally had no `session_id` column — for a database created before
/// conversations were grouped by session, add it (existing rows just become un-groupable
/// single turns, which is fine, there's no old session id to backfill them with).
fn add_session_id_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "session_id")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN session_id TEXT;")
}

/// Splits the two meanings `session_id` used to carry.
///
/// `session_id` is now the **conversation** id — minted by the app when a chat starts, stable for
/// its whole life, and the key everything groups by. The engine's own resume token moves here,
/// because it is not a conversation identity: Gemini/agy reports one fixed sentinel for every run
/// (so every chat ever collapsed into a single activity), while the Claude CLI can mint a *new*
/// id on each resumed turn (so one conversation could scatter across several activities). Old
/// rows keep grouping by whatever they stored, which is the best that data supports.
fn add_engine_session_id_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "engine_session_id")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN engine_session_id TEXT;")
}

/// What the engine printed while producing this turn (tool calls, progress), as JSON. Lets a
/// finished answer still show *how* it was reached, days later — rows written before this simply
/// have no trace to show.
fn add_trace_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "trace")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN trace TEXT;")
}

/// `activity_log` originally didn't record how long a reply took — for a database created before
/// that, add the column (existing rows stay NULL and simply show no timing, which is exactly the
/// pre-change behavior).
fn add_response_time_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "response_time_ms")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN response_time_ms INTEGER;")
}

/// Failed turns used not to be recorded at all — for a database created before that, add the flag
/// (every existing row is a successful turn, which is what the `0` default says).
fn add_is_error_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "activity_log", "is_error")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE activity_log ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0;")
}

/// Which engine answered a turn — provider, model and CLI version. Recorded per turn because the
/// alternative (reading today's settings when a conversation is reopened) would credit an old
/// answer to whatever engine happens to be configured now. Rows written before this stay NULL and
/// simply show no engine stamp. Added together since they're always written as a set.
fn add_engine_meta_to_activity_log(conn: &Connection) -> rusqlite::Result<()> {
    for column in ["provider", "model", "engine_version"] {
        if !has_column(conn, "activity_log", column)? {
            conn.execute_batch(&format!("ALTER TABLE activity_log ADD COLUMN {column} TEXT;"))?;
        }
    }
    Ok(())
}

/// `job_history` originally had no `custom_label` column — for a database created before
/// renaming was supported, add it (existing rows just have no override, falling back to
/// their auto-derived label, which is exactly the pre-rename behavior).
fn add_custom_label_to_job_history(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "job_history", "custom_label")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE job_history ADD COLUMN custom_label TEXT;")
}

/// `projects` gained `github_owner`/`github_repo` when GitHub was added alongside Azure DevOps
/// as a PR host — for a database created before that, add the columns (existing rows simply
/// have no GitHub link, exactly the pre-GitHub behavior). Added together since they're always
/// set/cleared as a pair.
fn add_github_columns_to_projects(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "projects", "github_owner")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN github_owner TEXT;")?;
    }
    if !has_column(conn, "projects", "github_repo")? {
        conn.execute_batch("ALTER TABLE projects ADD COLUMN github_repo TEXT;")?;
    }
    Ok(())
}

/// `github_host` records which GitHub server a linked project lives on (github.com or an
/// Enterprise host), so the API base URL and per-host token can be resolved. Added after
/// `github_owner`/`github_repo` — a row with those set but a NULL host defaults to github.com.
fn add_github_host_to_projects(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "projects", "github_host")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE projects ADD COLUMN github_host TEXT;")
}
