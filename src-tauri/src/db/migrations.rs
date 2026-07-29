use rusqlite::{Connection, OptionalExtension};

pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    // Must run *before* the schema batch: it moves the pre-workspace `api_*` tables aside so the
    // batch below recreates them in their current shape, and `migrate_api_tables_finish` then
    // copies the old rows across. See that pair's doc comments.
    migrate_api_tables_begin(conn)?;

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

        -- ===================== API client (per workspace) =====================
        -- Scoped to a WORKSPACE, not to a project: a collection describes a *service*, and the
        -- several repos of one workspace (frontend, backend, infra) normally talk to the same
        -- one — scoping per repo would mean re-creating the same collection in each. Scoping per
        -- workspace also keeps environments and the cookie jar from leaking a staging session
        -- from one client's workspace into another's.
        --
        -- Only the roots carry `workspace_id`: folders and requests reach it through their
        -- collection, so there is exactly one place a row's workspace can be wrong.
        --
        -- The editable content of a request lives in one `spec` JSON blob rather than in
        -- columns, so adding a protocol, an auth scheme or a body mode never needs a migration.

        CREATE TABLE IF NOT EXISTS api_collections (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            -- JSON AuthConfig; '' = nothing configured (children fall through to "none").
            auth        TEXT NOT NULL DEFAULT '',
            pre_script  TEXT NOT NULL DEFAULT '',
            post_script TEXT NOT NULL DEFAULT '',
            -- JSON ApiVariable[] — collection-scoped variables.
            variables   TEXT NOT NULL DEFAULT '[]',
            sort_order  INTEGER NOT NULL DEFAULT 0,
            -- Pinned collections sort above the rest, whatever their sort_order.
            pinned      INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        -- Folders nest arbitrarily (`parent_id` self-references); NULL means "directly under the
        -- collection". Kept as a separate table from requests so a folder can carry its own
        -- auth/scripts, which requests inherit.
        CREATE TABLE IF NOT EXISTS api_folders (
            id            TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
            parent_id     TEXT REFERENCES api_folders(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            auth          TEXT NOT NULL DEFAULT '',
            pre_script    TEXT NOT NULL DEFAULT '',
            post_script   TEXT NOT NULL DEFAULT '',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            -- Carried so a restore and a shared-workspace pull can both resolve last-write-wins on
            -- a folder the same way they do on a request.
            updated_at    TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_api_folders_parent
            ON api_folders (collection_id, parent_id, sort_order);

        CREATE TABLE IF NOT EXISTS api_requests (
            id            TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
            folder_id     TEXT REFERENCES api_folders(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            -- http | graphql | websocket | socketio | grpc | mqtt
            protocol      TEXT NOT NULL DEFAULT 'http',
            -- Denormalized out of `spec` purely so the tree can render method+URL without
            -- parsing every blob.
            method        TEXT NOT NULL DEFAULT 'GET',
            url           TEXT NOT NULL DEFAULT '',
            -- JSON ApiRequestSpec: params, headers, body, auth, scripts, protocol settings.
            spec          TEXT NOT NULL DEFAULT '{}',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_requests_parent
            ON api_requests (collection_id, folder_id, sort_order);

        -- Environments are global too. Exactly one row has `is_global = 1`: the "Globals"
        -- pseudo-environment, which is always in scope and can't be deleted or switched away
        -- from (see `ensure_globals_environment`).
        CREATE TABLE IF NOT EXISTS api_environments (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            -- JSON ApiVariable[] — initial vs current value, secret flag, enabled flag.
            variables   TEXT NOT NULL DEFAULT '[]',
            is_global   INTEGER NOT NULL DEFAULT 0,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL DEFAULT ''
        );

        -- Every send, whether or not it came from a saved request (`request_id` is NULL for
        -- ad-hoc sends). `snapshot` holds the full request spec + response so an old entry can
        -- be replayed or restored into the builder exactly as it was.
        CREATE TABLE IF NOT EXISTS api_history (
            id           TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            request_id  TEXT,
            name        TEXT NOT NULL DEFAULT '',
            protocol    TEXT NOT NULL DEFAULT 'http',
            method      TEXT NOT NULL DEFAULT '',
            url         TEXT NOT NULL DEFAULT '',
            status      INTEGER,
            duration_ms INTEGER,
            size_bytes  INTEGER,
            snapshot    TEXT NOT NULL DEFAULT '{}',
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_history_time ON api_history (workspace_id, created_at DESC);

        -- The cookie jar. Persisted rather than kept in the reqwest client because the client is
        -- rebuilt per request (per-request SSL/proxy/redirect overrides make a shared client
        -- impossible), so nothing in the transport layer can hold jar state across sends.
        CREATE TABLE IF NOT EXISTS api_cookies (
            id         TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,
            domain     TEXT NOT NULL,
            path       TEXT NOT NULL DEFAULT '/',
            name       TEXT NOT NULL,
            value      TEXT NOT NULL DEFAULT '',
            secure     INTEGER NOT NULL DEFAULT 0,
            http_only  INTEGER NOT NULL DEFAULT 0,
            expires    TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_api_cookies_key
            ON api_cookies (workspace_id, domain, path, name);

        -- What was deleted, and when. A deletion has to leave a trace: to anything reading changes
        -- since a point in time — a shared workspace, another machine — "absent" and "not created
        -- yet" are the same observation, so without this row a delete would be undone by the next
        -- pull instead of travelling.
        --
        -- Recorded for every workspace, not only shared ones: a workspace can be shared after the
        -- fact, and a deletion history that started when sharing did would resurrect everything
        -- removed before it.
        CREATE TABLE IF NOT EXISTS api_tombstones (
            id           TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            -- collection | folder | request | environment
            kind         TEXT NOT NULL,
            deleted_at   TEXT NOT NULL,
            PRIMARY KEY (workspace_id, kind, id)
        );
        "#,
    )?;

    migrate_api_tables_finish(conn)?;
    ensure_globals_environment(conn)?;

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
    add_pinned_to_api_collections(conn)?;
    add_updated_at_to_folders_and_environments(conn)?;
    Ok(())
}

/// Folders and environments had only a `created_at`, which made them the two records nothing could
/// order: a backup restore and a pull from a shared workspace both had to guess, and both guessed
/// "the incoming copy wins". That is a silent wrong answer — the local edit disappears — and it is
/// also what made a shared workspace never settle, because a record with no timestamp of its own
/// had to be re-stamped on every push and so looked changed forever.
///
/// Existing rows inherit their `created_at`: it is the only honest thing known about them, and it
/// sorts them below anything edited since.
fn add_updated_at_to_folders_and_environments(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["api_folders", "api_environments"] {
        if has_column(conn, table, "updated_at")? {
            continue;
        }
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
             UPDATE {table} SET updated_at = created_at WHERE updated_at = '';"
        ))?;
    }
    Ok(())
}

/// Every workspace resolves variables against its own "Globals" scope, so each one needs that row
/// before anything reads it. Idempotent and keyed on `is_global` rather than a fixed id, so a
/// user renaming it doesn't cause a duplicate to be seeded on the next launch.
fn ensure_globals_environment(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_environments (id, workspace_id, name, variables, is_global, sort_order, created_at)
         SELECT lower(hex(randomblob(16))), w.id, 'Globals', '[]', 1, -1, ?1
         FROM workspaces w
         WHERE NOT EXISTS (
             SELECT 1 FROM api_environments e WHERE e.workspace_id = w.id AND e.is_global = 1
         )",
        rusqlite::params![chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// The `api_*` tables shipped scoped to nothing — one global set of collections, environments,
/// history and cookies. They are now per-workspace, which means a new `workspace_id` column on
/// each of the four roots (folders and requests reach it through their collection).
///
/// SQLite can't add that column in place: `ALTER TABLE ... ADD COLUMN` rejects a `REFERENCES`
/// clause while foreign keys are on, so an in-place add would leave a migrated database without
/// the cascade a fresh one has — a workspace deletion would silently orphan its API rows. So the
/// old tables are moved aside here, the schema batch recreates them in their current shape, and
/// [`migrate_api_tables_finish`] copies the rows across. Splitting it in two is what lets the
/// batch stay the single definition of the schema instead of being duplicated inside a migration.
///
/// `legacy_alter_table` is essential: without it SQLite helpfully rewrites the foreign keys in
/// `api_folders`/`api_requests` to point at `api_collections_legacy`, and the rename silently
/// takes the children with it.
fn migrate_api_tables_begin(conn: &Connection) -> rusqlite::Result<()> {
    let needs_migration = table_exists(conn, "api_collections")?
        && !has_column(conn, "api_collections", "workspace_id")?;
    if !needs_migration {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        -- Dropped rather than carried along: a renamed table keeps its indexes under their old
        -- names, which would collide when the schema batch recreates them.
        DROP INDEX IF EXISTS idx_api_history_time;
        DROP INDEX IF EXISTS idx_api_cookies_key;
        ALTER TABLE api_collections  RENAME TO api_collections_legacy;
        ALTER TABLE api_environments RENAME TO api_environments_legacy;
        ALTER TABLE api_history      RENAME TO api_history_legacy;
        ALTER TABLE api_cookies      RENAME TO api_cookies_legacy;
        PRAGMA legacy_alter_table = OFF;
        "#,
    )
}

/// Second half of [`migrate_api_tables_begin`]: copies the pre-workspace rows into the recreated
/// tables, assigning them all to the oldest workspace — the one a single-workspace user has been
/// working in, which is where they will expect to find their collections.
///
/// If there is no workspace at all the legacy tables are left untouched rather than dropped:
/// there is nowhere to put the rows, and destroying a user's collections to tidy up a migration
/// is not a trade worth making. The next launch after a workspace exists finishes the job.
fn migrate_api_tables_finish(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "api_collections_legacy")? {
        return Ok(());
    }
    let target: Option<String> = conn
        .query_row(
            "SELECT id FROM workspaces ORDER BY sort_order, created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(workspace_id) = target else {
        return Ok(());
    };

    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let copied = conn.execute(
        "INSERT INTO api_collections
            (id, workspace_id, name, description, auth, pre_script, post_script, variables,
             sort_order, created_at, updated_at)
         SELECT id, ?1, name, description, auth, pre_script, post_script, variables,
                sort_order, created_at, updated_at
         FROM api_collections_legacy",
        rusqlite::params![workspace_id],
    )?;
    // The Globals row is per-workspace now, and `ensure_globals_environment` seeds one for every
    // workspace right after this — carrying the old one over as well would leave two in the
    // workspace that inherits it.
    conn.execute(
        "INSERT INTO api_environments
            (id, workspace_id, name, variables, is_global, sort_order, created_at)
         SELECT id, ?1, name, variables, is_global, sort_order, created_at
         FROM api_environments_legacy WHERE is_global = 0",
        rusqlite::params![workspace_id],
    )?;
    conn.execute(
        "INSERT INTO api_history
            (id, workspace_id, request_id, name, protocol, method, url, status, duration_ms,
             size_bytes, snapshot, created_at)
         SELECT id, ?1, request_id, name, protocol, method, url, status, duration_ms,
                size_bytes, snapshot, created_at
         FROM api_history_legacy",
        rusqlite::params![workspace_id],
    )?;
    conn.execute(
        "INSERT INTO api_cookies
            (id, workspace_id, domain, path, name, value, secure, http_only, expires, updated_at)
         SELECT id, ?1, domain, path, name, value, secure, http_only, expires, updated_at
         FROM api_cookies_legacy",
        rusqlite::params![workspace_id],
    )?;
    conn.execute_batch(
        r#"
        DROP TABLE api_collections_legacy;
        DROP TABLE api_environments_legacy;
        DROP TABLE api_history_legacy;
        DROP TABLE api_cookies_legacy;
        PRAGMA foreign_keys = ON;
        "#,
    )?;
    let _ = copied;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            rusqlite::params![name],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
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

/// `api_collections` gained a `pinned` flag so the ones a workspace lives in sort to the top of
/// the explorer. Existing rows default to unpinned — the pre-flag order, unchanged.
fn add_pinned_to_api_collections(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "api_collections", "pinned")? {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE api_collections ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The schema batch as it stood before the `api_*` tables were scoped to a workspace, derived
    /// from the current one so the two can't drift apart: strip the `workspace_id` columns and
    /// un-scope the two indexes that now lead with it.
    fn legacy_schema() -> String {
        let current = include_str!("migrations.rs");
        let start = current.find("PRAGMA foreign_keys = ON;").expect("schema batch");
        let end = current[start..].find("\"#,").expect("end of batch") + start;
        current[start..end]
            .replace(
                "            workspace_id TEXT NOT NULL DEFAULT '' REFERENCES workspaces(id) ON DELETE CASCADE,\n",
                "",
            )
            .replace(
                "ON api_cookies (workspace_id, domain, path, name)",
                "ON api_cookies (domain, path, name)",
            )
            .replace(
                "ON api_history (workspace_id, created_at DESC)",
                "ON api_history (created_at DESC)",
            )
    }

    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&legacy_schema()).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w-old', 'Flow', '2020-01-01', 0);
            INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w-new', 'Other', '2021-01-01', 1);
            INSERT INTO api_collections (id, name, created_at, updated_at) VALUES ('c1', 'My API', 't', 't');
            INSERT INTO api_folders (id, collection_id, name, created_at) VALUES ('f1', 'c1', 'Auth', 't');
            INSERT INTO api_requests (id, collection_id, folder_id, name, created_at, updated_at)
                VALUES ('r1', 'c1', 'f1', 'Login', 't', 't');
            INSERT INTO api_environments (id, name, is_global, created_at) VALUES ('e-glob', 'Globals', 1, 't');
            INSERT INTO api_environments (id, name, is_global, created_at) VALUES ('e1', 'Dev', 0, 't');
            INSERT INTO api_history (id, url, created_at) VALUES ('h1', 'https://x', 't');
            INSERT INTO api_cookies (id, domain, path, name, updated_at) VALUES ('k1', 'a.com', '/', 'sid', 't');
            "#,
        )
        .unwrap();
        conn
    }

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migrating_a_pre_workspace_database_keeps_every_row_and_reparents_it() {
        let conn = legacy_db();
        run(&conn).unwrap();

        // Content survives, assigned to the oldest workspace.
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_collections WHERE workspace_id = 'w-old'"),
            1
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_folders"), 1);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests"), 1);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_history WHERE workspace_id = 'w-old'"),
            1
        );
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_cookies WHERE workspace_id = 'w-old'"),
            1
        );
        assert_eq!(
            scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE id = 'e1' AND workspace_id = 'w-old'"),
            1
        );

        // Exactly one Globals per workspace: the legacy one is dropped, not carried over.
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE is_global = 1"), 2);
        assert_eq!(
            scalar(&conn, "SELECT COUNT(DISTINCT workspace_id) FROM api_environments WHERE is_global = 1"),
            2
        );

        // The children's foreign keys still point at `api_collections`, not at the renamed table —
        // this is what `legacy_alter_table` protects, and it fails loudly if that pragma is lost.
        let folders_sql: String = conn
            .query_row("SELECT sql FROM sqlite_master WHERE name = 'api_folders'", [], |r| r.get(0))
            .unwrap();
        assert!(folders_sql.contains("REFERENCES api_collections(id)"), "{folders_sql}");
        assert!(!folders_sql.contains("legacy"), "{folders_sql}");

        // No leftovers, and deleting the workspace now cascades the whole API tree away.
        assert!(!table_exists(&conn, "api_collections_legacy").unwrap());
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM workspaces WHERE id = 'w-old';")
            .unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_cookies"), 0);
    }

    #[test]
    fn migration_is_idempotent_and_a_fresh_database_needs_no_migration() {
        let conn = legacy_db();
        run(&conn).unwrap();
        run(&conn).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections"), 1);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE is_global = 1"), 2);

        let fresh = Connection::open_in_memory().unwrap();
        run(&fresh).unwrap();
        assert!(has_column(&fresh, "api_collections", "workspace_id").unwrap());
    }

    /// A database with API rows but no workspace has nowhere to put them; the rows must be kept
    /// for a later launch rather than dropped on the floor.
    #[test]
    fn a_database_with_no_workspace_keeps_the_legacy_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&legacy_schema()).unwrap();
        conn.execute_batch(
            "INSERT INTO api_collections (id, name, created_at, updated_at) VALUES ('c1', 'Kept', 't', 't');",
        )
        .unwrap();
        run(&conn).unwrap();
        assert!(table_exists(&conn, "api_collections_legacy").unwrap());
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections_legacy"), 1);

        // Once a workspace exists, the next launch finishes the job.
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w1', 'W', 't', 0);",
        )
        .unwrap();
        run(&conn).unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections WHERE workspace_id = 'w1'"), 1);
        assert!(!table_exists(&conn, "api_collections_legacy").unwrap());
    }
}
