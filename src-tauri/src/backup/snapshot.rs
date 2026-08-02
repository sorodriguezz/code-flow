//! What travels, and how it is copied out of and back into SQLite.
//!
//! **Configuration and credentials only — no history, no traces.** The distinction the user drew is
//! the one implemented here: a restored machine must be able to *do* everything the old one could,
//! without carrying a record of what was done on it. So collections, connections, workspaces,
//! prompts, agents, settings and every stored credential travel; request history, SQL history, AI
//! conversations, review runs, job history and the cookie jar do not. That is also why a backup of
//! a heavily used install stays small enough to encrypt and upload in well under a second.
//!
//! Rows are copied generically — `SELECT *`, columns read off the statement — rather than through
//! one struct per table. Fifteen hand-written mappings would be fifteen places for a column added
//! next month to be silently dropped on the round trip, and a backup that quietly loses a field is
//! the failure mode with no symptom until the restore.

use std::collections::BTreeMap;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};

/// The tables that make up "everything the user set up", in dependency order: a parent is always
/// written before the rows that point at it, and deleted after them.
///
/// Foreign keys are switched off for the duration of a restore (see [`apply`]), so this order is
/// not what keeps the writes legal — it is what keeps `PRAGMA foreign_key_check` clean at the end
/// and what makes a partial failure leave the least wreckage.
pub const TABLES: &[&str] = &[
    "workspaces",
    "projects",
    "review_contexts",
    "workspace_prompts",
    "workspace_skills",
    "workspace_agents",
    "workspace_chain_templates",
    "workspace_chain_template_steps",
    "workspace_mcps",
    "app_settings",
    "api_collections",
    "api_folders",
    "api_requests",
    "api_environments",
    "api_shared_collections",
    "db_connections",
    "db_consoles",
];

/// Deliberately absent from [`TABLES`], and each for a reason worth stating once:
///
/// - `api_history`, `db_query_history`, `activity_log`, `job_history`, `workspace_activity`,
///   `conversation_titles`, `review_runs`, `agent_tasks` — a log of what was done, not part of
///   being able to do it. Carrying them would move a trace of the other machine's work onto this
///   one. `agent_tasks` in particular names a project row and replays out of `activity_log`, so
///   restored elsewhere it would be a list of work pointing at repositories and transcripts that
///   were never there — and `agent_chains`/`agent_chain_steps` go with it for the same reason,
///   plus a worse one: a chain carries a live scheduler state, and restoring one mid-flight onto
///   another machine would hand it a plan that believes a step is running somewhere.
/// - `api_cookies` — live sessions. Restoring them would move a signed-in session between machines.
/// - `api_tombstones`, `api_sync_base`, `api_sync_conflicts` — the bookkeeping of one machine's
///   sync with a shared collection. It describes *this* install's relationship with the server; on
///   another machine it would be a false memory of agreements that never happened, and the first
///   pull would resolve against a base that was never true here.
#[cfg(test)]
const EXCLUDED: &[&str] = &[
    "api_history",
    "db_query_history",
    "activity_log",
    "job_history",
    "workspace_activity",
    "conversation_titles",
    "review_runs",
    "agent_tasks",
    "agent_chains",
    "agent_chain_steps",
    "api_cookies",
    "api_tombstones",
    "api_sync_base",
    "api_sync_conflicts",
];

/// `app_settings` keys that describe *this machine* rather than the user's setup, and so must not
/// ride along: the backup's own destination folder, its schedule and its last-run state.
///
/// A restored machine that inherited them would point its automatic backup at a path that exists on
/// the other computer — writing nowhere, and reporting a stale "last backup" that was never its own.
/// The portable half of the Drive connection lives under a separate key (`backup_drive`) precisely
/// so it *can* travel while this one doesn't.
const MACHINE_LOCAL_SETTINGS: &[&str] = &["backup_settings"];

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/// One table, as the column list plus a row of values per record. Column-major naming costs one
/// string per table instead of one per cell, which on `api_requests` is the difference between a
/// payload that compresses well and one that is mostly field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDump {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

/// One entry of the OS credential store. This is the half of the backup that makes it worth
/// encrypting whole.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub tables: Vec<TableDump>,
    pub secrets: Vec<SecretEntry>,
}

/// What a restore changed, per table, plus the two things worth warning about afterwards.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RestoreSummary {
    pub tables: BTreeMap<String, i64>,
    pub rows: i64,
    pub secrets: i64,
    /// Projects whose `local_path` doesn't exist here. Expected when moving between machines, and
    /// the one thing about a restored install that still needs a human.
    pub missing_project_paths: Vec<String>,
    /// Rows left pointing at a parent that isn't here. Zero for a backup restored whole; non-zero
    /// only for a merge into an install that had already deleted something.
    pub dangling_rows: i64,
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Value::from(f),
        ValueRef::Text(bytes) => serde_json::Value::from(String::from_utf8_lossy(bytes).into_owned()),
        // No column in the schema is a BLOB today, but a dump that silently dropped one if it ever
        // were is exactly the quiet data loss this module is written to avoid.
        ValueRef::Blob(bytes) => serde_json::json!({
            "$blob": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
        }),
    }
}

fn json_to_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .or_else(|| n.as_f64().map(Value::Real))
            .unwrap_or(Value::Null),
        serde_json::Value::String(s) => Value::Text(s.clone()),
        serde_json::Value::Object(map) => match map.get("$blob").and_then(|b| b.as_str()) {
            Some(encoded) => base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
                .map(Value::Blob)
                .unwrap_or(Value::Null),
            None => Value::Text(value.to_string()),
        },
        other => Value::Text(other.to_string()),
    }
}

/// Reads one table whole. `SELECT *` rather than a column list so a column added by a future
/// migration travels without this file having to hear about it.
fn dump_table(conn: &Connection, table: &str) -> rusqlite::Result<TableDump> {
    let mut statement = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let columns: Vec<String> = statement.column_names().iter().map(|c| (*c).to_string()).collect();
    let width = columns.len();
    let skip_key = table == "app_settings";

    let mut rows = Vec::new();
    let mut cursor = statement.query([])?;
    while let Some(row) = cursor.next()? {
        // `app_settings` is one table holding many unrelated things, so the exclusion has to happen
        // per row rather than per table.
        if skip_key {
            let key: String = row.get(0)?;
            if MACHINE_LOCAL_SETTINGS.contains(&key.as_str()) {
                continue;
            }
        }
        let mut values = Vec::with_capacity(width);
        for index in 0..width {
            values.push(value_to_json(row.get_ref(index)?));
        }
        rows.push(values);
    }
    Ok(TableDump { name: table.to_string(), columns, rows })
}

/// Every configuration table, in one consistent read.
///
/// The transaction matters: without it the read spans fifteen statements, and a sync applying a
/// pull between two of them would seal a backup holding a collection but not the requests that
/// arrived with it — a state that never existed on either machine.
pub fn export(conn: &Connection) -> rusqlite::Result<Vec<TableDump>> {
    let tx = conn.unchecked_transaction()?;
    let mut tables = Vec::with_capacity(TABLES.len());
    for table in TABLES {
        tables.push(dump_table(&tx, table)?);
    }
    Ok(tables)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// How a restore treats what is already here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreMode {
    /// The clean restore: the configuration tables are emptied, then written from the file. What
    /// the user means by "leave this machine exactly like the other one".
    Replace,
    /// Add and overwrite, delete nothing. For folding a second machine's setup into this one; a row
    /// that exists only here survives.
    Merge,
}

/// A column list this build doesn't have — the backup was written by a version with a column since
/// removed. Dropping it is right: the alternative is refusing the whole restore over a field
/// nothing reads any more.
fn known_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(names)
}

fn write_table(conn: &Connection, dump: &TableDump, summary: &mut RestoreSummary) -> rusqlite::Result<()> {
    if dump.rows.is_empty() {
        return Ok(());
    }
    let existing = known_columns(conn, &dump.name)?;
    // Positions in the dump's row that this schema still has a column for.
    let kept: Vec<usize> = dump
        .columns
        .iter()
        .enumerate()
        .filter(|(_, name)| existing.iter().any(|c| c == *name))
        .map(|(index, _)| index)
        .collect();
    if kept.is_empty() {
        return Ok(());
    }

    let names: Vec<&str> = kept.iter().map(|i| dump.columns[*i].as_str()).collect();
    let placeholders = (1..=kept.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    // `INSERT OR REPLACE` rather than a hand-written upsert per table: the primary key differs from
    // table to table (`app_settings` is keyed by `key`, `workspace_prompts` by a pair), and REPLACE
    // is the one form that needs to know none of it. Its usual danger — REPLACE deletes the
    // conflicting row first, firing every ON DELETE CASCADE hanging off it — is why the caller runs
    // this with `PRAGMA foreign_keys = OFF`.
    let sql = format!(
        "INSERT OR REPLACE INTO {} ({}) VALUES ({placeholders})",
        dump.name,
        names.join(", ")
    );
    let mut statement = conn.prepare(&sql)?;

    let mut written = 0i64;
    for row in &dump.rows {
        let values: Vec<Value> = kept
            .iter()
            .map(|index| row.get(*index).map(json_to_value).unwrap_or(Value::Null))
            .collect();
        let params: Vec<&dyn ToSql> = values.iter().map(|v| v as &dyn ToSql).collect();
        written += statement.execute(params.as_slice())? as i64;
    }

    summary.rows += written;
    *summary.tables.entry(dump.name.clone()).or_insert(0) += written;
    Ok(())
}

/// Empties the configuration tables, children first, leaving history and traces untouched.
///
/// `app_settings` is emptied too: a setting the backup doesn't carry is one the user turned off on
/// the other machine, and a "clean restore" that left it on here would be neither clean nor a
/// restore. The machine-local keys are the exception, and [`apply`] puts them back.
fn wipe(conn: &Connection) -> rusqlite::Result<()> {
    for table in TABLES.iter().rev() {
        conn.execute(&format!("DELETE FROM {table}"), [])?;
    }
    Ok(())
}

/// The machine-local settings, read before a wipe so they can be put back after it.
///
/// Without this a clean restore points this computer's backup at the *other* computer's folder —
/// which is both the wrong place and, on a different platform, not a place at all. The backup
/// deliberately doesn't carry these keys, so nothing in the file would rewrite them.
fn keep_local(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut kept = Vec::new();
    for key in MACHINE_LOCAL_SETTINGS {
        let value: Option<String> = conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |row| row.get(0))
            .ok();
        if let Some(value) = value {
            kept.push(((*key).to_string(), value));
        }
    }
    Ok(kept)
}

/// Applies a snapshot's tables.
///
/// Runs with foreign keys **off**, which is not a shortcut: `INSERT OR REPLACE` on a parent row
/// deletes the old one before writing the new, and every `ON DELETE CASCADE` in the schema would
/// fire on the way past — restoring a workspace would take its projects, collections and
/// environments with it, mid-restore, and then write them back only if they happened to come later
/// in the file. With them off the whole set lands as written, and `PRAGMA foreign_key_check`
/// afterwards is what proves the result is consistent rather than assumed to be.
pub fn apply(
    conn: &mut Connection,
    tables: &[TableDump],
    mode: RestoreMode,
) -> rusqlite::Result<RestoreSummary> {
    let mut summary = RestoreSummary::default();

    // Has to be outside the transaction — SQLite ignores `PRAGMA foreign_keys` inside one.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let result = (|| -> rusqlite::Result<()> {
        let tx = conn.transaction()?;
        let local = if mode == RestoreMode::Replace {
            let local = keep_local(&tx)?;
            wipe(&tx)?;
            local
        } else {
            Vec::new()
        };
        // In `TABLES` order, not the file's: a backup written by another build may list them
        // differently, and parents still want to land first.
        for table in TABLES {
            if let Some(dump) = tables.iter().find(|d| d.name == *table) {
                write_table(&tx, dump, &mut summary)?;
            }
        }
        // After the writes, so this machine's own settings win even against a file that somehow
        // carries them.
        for (key, value) in &local {
            tx.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )?;
        }
        tx.commit()
    })();
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    result?;

    summary.dangling_rows = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut s| s.query_map([], |_| Ok(())).map(|rows| rows.count() as i64))
        .unwrap_or(0);

    summary.missing_project_paths = conn
        .prepare("SELECT local_path FROM projects")
        .and_then(|mut s| {
            s.query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|path| !path.trim().is_empty() && !std::path::Path::new(path).exists())
        .collect();

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM workspaces;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', 'folder', '#111111', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO projects (id, workspace_id, name, local_path, sort_order, created_at)
                VALUES ('p1', 'w1', 'api', 'Z:\\definitely\\not\\here', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                VALUES ('c1', 'w1', 'My API', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_requests (id, collection_id, name, url, spec, created_at, updated_at)
                VALUES ('r1', 'c1', 'Login', 'https://a', '{"auth":{"bearer":{"token":"t"}}}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO db_connections (id, workspace_id, name, kind, spec, created_at, updated_at)
                VALUES ('d1', 'w1', 'prod', 'postgres', '{}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO app_settings (key, value) VALUES ('ai_provider', 'claude');
            INSERT INTO app_settings (key, value) VALUES ('backup_settings', '{"folder":"C:/only/here"}');
            -- History and traces: present here, and expected to stay behind.
            INSERT INTO api_history (id, workspace_id, url, created_at)
                VALUES ('h1', 'w1', 'https://a', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_cookies (id, workspace_id, domain, name, value, updated_at)
                VALUES ('k1', 'w1', 'example.com', 'session', 'live', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        conn
    }

    fn empty() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch("DELETE FROM workspaces; DELETE FROM app_settings;").unwrap();
        conn
    }

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn a_restore_reproduces_the_configuration() {
        let source = seeded();
        let tables = export(&source).unwrap();

        let mut target = empty();
        let summary = apply(&mut target, &tables, RestoreMode::Replace).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM workspaces WHERE id = 'w1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM projects WHERE id = 'p1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM db_connections WHERE id = 'd1'"), 1);
        assert!(summary.rows >= 5);
        assert_eq!(summary.dangling_rows, 0, "a whole restore must leave no orphans");
    }

    /// The user's own line: able to do everything, carrying no record of what was done.
    #[test]
    fn history_and_live_sessions_stay_behind() {
        let source = seeded();
        let tables = export(&source).unwrap();
        assert!(
            tables.iter().all(|t| !EXCLUDED.contains(&t.name.as_str())),
            "no history table may appear in a backup"
        );

        let mut target = empty();
        apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_history"), 0);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_cookies"), 0);
    }

    /// The destination folder of the machine the backup came from must not become this machine's.
    #[test]
    fn the_backups_own_settings_do_not_travel() {
        let source = seeded();
        let tables = export(&source).unwrap();
        let settings = tables.iter().find(|t| t.name == "app_settings").unwrap();
        let keys: Vec<&str> = settings.rows.iter().filter_map(|r| r[0].as_str()).collect();
        assert!(keys.contains(&"ai_provider"));
        assert!(!keys.contains(&"backup_settings"));
    }

    /// The failure `PRAGMA foreign_keys = OFF` exists to prevent: rewriting a workspace row must
    /// not take everything hanging off it down first.
    #[test]
    fn replacing_a_parent_row_does_not_cascade_its_children_away() {
        let source = seeded();
        let tables = export(&source).unwrap();

        // Same ids already present, so every write is a REPLACE rather than an INSERT.
        let mut target = seeded();
        apply(&mut target, &tables, RestoreMode::Merge).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM projects WHERE id = 'p1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_collections WHERE id = 'c1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM db_connections WHERE id = 'd1'"), 1);
    }

    #[test]
    fn replace_drops_what_the_backup_does_not_carry_and_merge_keeps_it() {
        let source = seeded();
        let tables = export(&source).unwrap();

        let mut replaced = seeded();
        replaced
            .execute(
                "INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                 VALUES ('local-only', 'w1', 'Mine', '2026-06-01T00:00:00+00:00', '2026-06-01T00:00:00+00:00')",
                [],
            )
            .unwrap();
        apply(&mut replaced, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(scalar(&replaced, "SELECT COUNT(*) FROM api_collections WHERE id = 'local-only'"), 0);

        let mut merged = seeded();
        merged
            .execute(
                "INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                 VALUES ('local-only', 'w1', 'Mine', '2026-06-01T00:00:00+00:00', '2026-06-01T00:00:00+00:00')",
                [],
            )
            .unwrap();
        apply(&mut merged, &tables, RestoreMode::Merge).unwrap();
        assert_eq!(scalar(&merged, "SELECT COUNT(*) FROM api_collections WHERE id = 'local-only'"), 1);
    }

    /// Restoring twice must land on the same place as restoring once.
    #[test]
    fn restoring_twice_changes_nothing_the_second_time() {
        let source = seeded();
        let tables = export(&source).unwrap();

        let mut target = empty();
        apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        let after_first = scalar(&target, "SELECT COUNT(*) FROM api_requests");
        apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests"), after_first);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM workspaces"), 1);
    }

    /// The one thing a restored install still needs a human for.
    #[test]
    fn project_paths_that_do_not_exist_here_are_reported() {
        let source = seeded();
        let tables = export(&source).unwrap();
        let mut target = empty();
        let summary = apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(summary.missing_project_paths.len(), 1);
    }

    /// A backup written by a build with a column this one has dropped restores anyway.
    #[test]
    fn an_unknown_column_is_dropped_rather_than_refused() {
        let source = seeded();
        let mut tables = export(&source).unwrap();
        let workspaces = tables.iter_mut().find(|t| t.name == "workspaces").unwrap();
        workspaces.columns.push("since_removed".into());
        for row in &mut workspaces.rows {
            row.push(serde_json::Value::from("x"));
        }

        let mut target = empty();
        apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM workspaces WHERE id = 'w1'"), 1);
    }

    /// Every value type SQLite can hold survives the JSON round trip unchanged.
    #[test]
    fn nulls_numbers_and_text_all_come_back_as_themselves() {
        assert_eq!(json_to_value(&serde_json::Value::Null), Value::Null);
        assert_eq!(json_to_value(&serde_json::json!(7)), Value::Integer(7));
        assert_eq!(json_to_value(&serde_json::json!(1.5)), Value::Real(1.5));
        assert_eq!(json_to_value(&serde_json::json!("hi")), Value::Text("hi".into()));
        let blob = value_to_json(ValueRef::Blob(&[1, 2, 3]));
        assert_eq!(json_to_value(&blob), Value::Blob(vec![1, 2, 3]));
    }
}
