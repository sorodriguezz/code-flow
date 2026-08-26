//! What travels, and how it is copied out of and back into SQLite.
//!
//! **Everything in the database.** The user's line is that a restored machine should be the old one
//! — not merely able to do what it could, but holding what it held: the same request history, the
//! same AI conversations, the same past reviews and the same agent work. So [`TABLES`] is the whole
//! schema, and [`covers_every_table`] is the test that keeps it that way. The only things left
//! behind are the handful of *fields* that name this particular computer, listed in
//! [`MACHINE_LOCAL_BACKUP_FIELDS`] — a destination folder on a disk the other machine doesn't have
//! is not configuration, it is a broken path waiting to be discovered.
//!
//! Two consequences worth stating, because they are the price of "everything":
//!
//! - **The cookie jar travels.** `api_cookies` holds live sessions, so restoring moves a signed-in
//!   session onto the other computer. Between two machines belonging to the same person that is the
//!   point; it is also why the file is encrypted whole rather than field by field.
//! - **Live state arrives mid-flight.** A chain that was running when the backup was written
//!   restores saying so. [`super::restore`] runs `recover_after_restart` afterwards for exactly
//!   this: the same reconciliation the app does after a crash, which is what a restored session
//!   effectively is.
//!
//! Rows are copied generically — `SELECT *`, columns read off the statement — rather than through
//! one struct per table. Thirty-six hand-written mappings would be thirty-six places for a column
//! added next month to be silently dropped on the round trip, and a backup that quietly loses a
//! field is the failure mode with no symptom until the restore.

use std::collections::BTreeMap;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, ToSql};
use serde::{Deserialize, Serialize};

/// Every table in the schema, in dependency order: a parent is always written before the rows that
/// point at it, and deleted after them.
///
/// Foreign keys are switched off for the duration of a restore (see [`apply`]), so this order is
/// not what keeps the writes legal — it is what keeps `PRAGMA foreign_key_check` clean at the end
/// and what makes a partial failure leave the least wreckage.
///
/// A table missing from this list is a table that vanishes on a restore, silently, and is not
/// noticed until someone needs it. That is not a hypothetical: `workspace_mcps`, `doc_pages` and
/// `work_item_reviews` were each absent here for several releases while the settings panel promised
/// MCP servers travelled. [`covers_every_table`] is the test that now makes that state unreachable
/// — a migration adding a table fails it until the table is named here.
pub const TABLES: &[&str] = &[
    // Roots. Everything below points at one of these, directly or through another.
    "workspaces",
    "app_settings",
    "projects",
    // Workspace-scoped configuration.
    "review_contexts",
    "workspace_prompts",
    "workspace_git_identity",
    "review_engine_config",
    "workspace_skills",
    "workspace_agents",
    "workspace_mcps",
    "workspace_chain_templates",
    "workspace_chain_template_steps",
    "agent_projects",
    // Authored content: things the user wrote and edited, as opposed to things the app recorded.
    "story_batches",
    "story_drafts",
    "doc_pages",
    "work_item_reviews",
    // The Notes workspace, which is authored content too but gets a switch of its own — see the
    // `notes` group below. Folders before notes: a note points at the folder it is filed in.
    "note_books",
    "notes",
    "note_templates",
    // The Diagrams workspace, with its own switch for the same reasons the Notes one has. Folders
    // before diagrams: a diagram points at the folder it is filed in. Templates last — they point
    // only at the workspace.
    "diagram_folders",
    "diagrams",
    "diagram_templates",
    // The keyring. Meta first — the wrapped key, without which every row below it is unreadable —
    // then folders before items (an item points at a folder), then blobs, which point at an item.
    //
    // Safe to carry because every payload in here is sealed and the password that opens it is
    // deliberately *not* in the backup (see `keyvault::master_password_key`). A restored machine
    // gets the vault back and asks for the master password, which is the correct exchange.
    "vault_meta",
    "vault_folders",
    "vault_items",
    "vault_blobs",
    "vault_audit",
    // The API client, its sync bookkeeping and its jar. The three sync tables travel so the
    // restored machine resumes the shared collection exactly where this one left it, rather than
    // re-deriving a base by pulling — see the note in [`apply`] about merging.
    "api_collections",
    "api_folders",
    "api_requests",
    "api_environments",
    "api_shared_collections",
    "api_sync_base",
    "api_sync_conflicts",
    "api_tombstones",
    "api_cookies",
    "api_history",
    // The database workspace.
    "db_groups",
    "db_connections",
    "db_consoles",
    "db_query_history",
    // The Remote workspace. The host rows hold no credential — passwords and passphrases are in
    // the OS store, and travel or not with the `credentials` switch like every other secret.
    "remote_groups",
    "remote_hosts",
    "remote_snippets",
    "remote_log",
    // History, activity and agent work. Last because every one of them hangs off a project or a
    // workspace, and `agent_chain_steps` and `agent_chain_repos` hang off `agent_chains` in turn.
    "activity_log",
    "job_history",
    // What the engines spent. No foreign key of its own, so its position here is only about
    // reading order: it belongs with the history of the work that spent it.
    "ai_usage",
    "workspace_activity",
    "conversation_titles",
    "review_runs",
    "agent_tasks",
    "agent_chains",
    "agent_chain_repos",
    "agent_chain_steps",
];

/// Tables that are deliberately *not* in a backup, and the only sanctioned way to be absent from
/// [`TABLES`].
///
/// [`covers_every_table`] exists precisely to make silent omission impossible, so opting out has to
/// be something a person wrote down. A table named here is claiming its rows are worthless on
/// another machine — not merely large, not merely regenerable, but wrong to carry.
///
/// The bench's two tables are that: they hold the scrollback of shells opened on *this* computer, in
/// directories that exist on *this* computer, under a shell profile detected on *this* computer.
/// Restored onto another machine it is a wall of output from somewhere else, pinned to paths that
/// are not there. It is also the one table whose contents nobody curated — a `cargo build` scrolls
/// a hundred kilobytes through it — and putting that inside an encrypted file the user keeps
/// forever is a cost with no matching benefit.
///
/// It stays in the local database, which is the whole of what was asked for: survive a restart,
/// travel nowhere.
///
/// `remote_devices` is the second, and its reason is about authority rather than usefulness. Each
/// row is a credential that lets a phone drive **this** installation's server. Carrying it into a
/// restore would mean the new machine silently accepting a device somebody paired with the old
/// one — access quietly widening to a second computer through an operation the user thinks of as
/// "get my settings back". Re-pairing is a six-digit code and thirty seconds; a restored token is
/// a door nobody remembers opening.
///
/// Read only by [`covers_every_table`], and that is the point rather than an oversight: nothing at
/// runtime consults this, because excluding a table is *not* an action the exporter takes — it is
/// [`TABLES`] not naming it. This list is the written-down reason, and the test is what makes
/// writing it down compulsory.
#[allow(dead_code)]
pub const NEVER_BACKED_UP: &[&str] =
    &["workspace_terminals", "workspace_bench_tabs", "remote_devices"];

// ---------------------------------------------------------------------------
// What the user chose to include
// ---------------------------------------------------------------------------

/// One switch in the settings panel: a name the user picks by, and the tables behind it.
///
/// Grouped by what the rows *are* to the person reading the panel, not by which subsystem wrote
/// them — "conversations" is one choice even though it spans four tables, because nobody wants
/// `workspace_activity` without `activity_log`.
pub struct Group {
    /// Matches the field on [`Selection`] and the `backup.include.*` translation keys.
    pub key: &'static str,
    pub tables: &'static [&'static str],
}

/// The setup itself: workspaces, the repositories' entries, and everything the user configured
/// against them. Not a group — it has no switch, because every other group's rows hang off it and a
/// backup without it restores into nothing.
pub const CORE_TABLES: &[&str] = &[
    "workspaces",
    "app_settings",
    "projects",
    "review_contexts",
    "workspace_prompts",
    "workspace_git_identity",
    "review_engine_config",
    "workspace_skills",
    "workspace_agents",
    "workspace_mcps",
    "workspace_chain_templates",
    "workspace_chain_template_steps",
    "agent_projects",
];

/// The optional groups, in the order the panel lists them.
pub const GROUPS: &[Group] = &[
    Group {
        key: "apiClient",
        // The three sync tables ride with the collections rather than getting a switch of their
        // own: they are meaningless without `api_shared_collections`, and a collection restored
        // without its sync base would re-derive one on the next pull — which is the slow, lossy
        // version of what carrying them does exactly.
        tables: &[
            "api_collections",
            "api_folders",
            "api_requests",
            "api_environments",
            "api_shared_collections",
            "api_sync_base",
            "api_sync_conflicts",
            "api_tombstones",
        ],
    },
    Group { key: "databases", tables: &["db_groups", "db_connections", "db_consoles"] },
    Group {
        key: "remote",
        tables: &["remote_groups", "remote_hosts", "remote_snippets", "remote_log"],
    },
    Group {
        key: "authored",
        tables: &["story_batches", "story_drafts", "doc_pages", "work_item_reviews"],
    },
    Group {
        // Its own switch rather than riding with `authored`, though notes are authored content by
        // any reading. Two reasons, and both are about what the switch is *for*: a notes corpus is
        // the most personal thing in the database — a journal, a one-to-one, a half-written
        // resignation — and someone who keeps backups on a shared drive may reasonably carry their
        // specs and not their notebook. It is also the group most likely to be the large one, and
        // a user trimming a backup wants that choice to be available separately from "everything I
        // ever wrote".
        key: "notes",
        tables: &["note_books", "notes", "note_templates"],
    },
    Group {
        // Its own switch beside `notes` rather than inside it. The argument is the size one: a
        // diagram carries a rendered PNG thumbnail per row on top of its document, so this is the
        // group most able to dominate a backup — and somebody trimming a file to fit a shared
        // drive should be able to drop the drawings without dropping the writing.
        key: "diagrams",
        tables: &["diagram_folders", "diagrams", "diagram_templates"],
    },
    Group {
        // Its own switch, and the one whose *absence* is as much the point as its presence: the
        // vault is unreadable without the master password, so it is safe to carry — but somebody
        // keeping backups on a shared drive may still want everything except this.
        key: "vault",
        tables: &["vault_meta", "vault_folders", "vault_items", "vault_blobs", "vault_audit"],
    },
    Group { key: "requestHistory", tables: &["api_history", "db_query_history"] },
    Group {
        // `ai_usage` rides here rather than in a switch of its own: it is the token account of
        // exactly these turns, and somebody who does not keep the conversations has no use for a
        // meter of what they cost.
        key: "conversations",
        tables: &[
            "activity_log",
            "conversation_titles",
            "workspace_activity",
            "job_history",
            "ai_usage",
        ],
    },
    Group { key: "reviews", tables: &["review_runs"] },
    Group {
        key: "agentWork",
        tables: &["agent_tasks", "agent_chains", "agent_chain_repos", "agent_chain_steps"],
    },
    Group { key: "cookies", tables: &["api_cookies"] },
];

/// Which groups go into the file. Every field defaults to `true`, which is what makes an install
/// upgrading from a build without this setting keep backing up everything rather than quietly
/// starting to leave things out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Selection {
    /// Not a table group: every token, key and password in the OS credential store. Its own switch
    /// because it is the one part of the file whose loss is a lockout and whose leak is a breach —
    /// a user keeping backups on a shared drive may reasonably want the setup without the keys.
    pub credentials: bool,
    pub api_client: bool,
    pub databases: bool,
    pub remote: bool,
    pub authored: bool,
    pub notes: bool,
    pub diagrams: bool,
    pub vault: bool,
    pub request_history: bool,
    pub conversations: bool,
    pub reviews: bool,
    pub agent_work: bool,
    pub cookies: bool,
}

impl Default for Selection {
    fn default() -> Self {
        Self {
            credentials: true,
            api_client: true,
            databases: true,
            remote: true,
            authored: true,
            notes: true,
            diagrams: true,
            vault: true,
            request_history: true,
            conversations: true,
            reviews: true,
            agent_work: true,
            cookies: true,
        }
    }
}

impl Selection {
    fn group_enabled(&self, key: &str) -> bool {
        match key {
            "apiClient" => self.api_client,
            "databases" => self.databases,
            "remote" => self.remote,
            "authored" => self.authored,
            "notes" => self.notes,
            "diagrams" => self.diagrams,
            "vault" => self.vault,
            "requestHistory" => self.request_history,
            "conversations" => self.conversations,
            "reviews" => self.reviews,
            "agentWork" => self.agent_work,
            "cookies" => self.cookies,
            // A group added to `GROUPS` without a field here would silently never be written.
            // Defaulting to "included" makes that failure a too-large backup rather than a
            // too-small one, which is the direction with a symptom.
            _ => true,
        }
    }

    /// The tables this selection writes, in [`TABLES`] order.
    pub fn tables(&self) -> Vec<&'static str> {
        let chosen: Vec<&'static str> = CORE_TABLES
            .iter()
            .copied()
            .chain(
                GROUPS
                    .iter()
                    .filter(|group| self.group_enabled(group.key))
                    .flat_map(|group| group.tables.iter().copied()),
            )
            .collect();
        TABLES.iter().copied().filter(|table| chosen.contains(table)).collect()
    }
}

/// The one `app_settings` key that cannot be copied across verbatim, and the fields of it that are
/// the reason why.
///
/// `backup_settings` is a single JSON blob mixing two unrelated things: what the user chose (run it,
/// how often, keep how many, also on exit) and where *this computer* puts the file. The first half
/// is a preference and travels. The second half names a directory on the other machine's disk, a
/// Drive file this install alone has permission to write, and a last-run outcome that was never
/// this machine's — inherited, they point the automatic backup at nowhere and report a success that
/// never happened here.
///
/// So the key travels with these fields blanked, and [`merge_backup_settings`] puts this machine's
/// own values back on restore. The Drive and OneDrive client registrations live under separate keys
/// (`backup_drive`, `backup_onedrive`) and travel whole, because an app registration is a one-time
/// setup in a portal rather than a fact about a computer.
const BACKUP_SETTINGS_KEY: &str = "backup_settings";
const MACHINE_LOCAL_BACKUP_FIELDS: &[&str] = &[
    "folder",
    "driveFileId",
    "lastBackupAt",
    "lastBackupPath",
    "lastError",
    "lastHash",
];

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

/// Blanks the fields of a `backup_settings` blob that describe the machine it was written on,
/// leaving the user's schedule preferences intact.
///
/// Blanked rather than removed so the shape stays the one `BackupSettings` deserialises; an absent
/// field and an empty one land the same way through `#[serde(default)]`, and an empty string is
/// what the rest of the module already treats as "not chosen yet".
fn strip_machine_fields(raw: &str) -> String {
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(raw)
    else {
        // Unparseable settings are not worth failing a backup over, and carrying them forward
        // verbatim would carry the folder too — so the safe answer is to carry nothing.
        return String::new();
    };
    for field in MACHINE_LOCAL_BACKUP_FIELDS {
        if map.contains_key(*field) {
            map.insert((*field).to_string(), serde_json::Value::from(""));
        }
    }
    serde_json::Value::Object(map).to_string()
}

/// Reads one table whole. `SELECT *` rather than a column list so a column added by a future
/// migration travels without this file having to hear about it.
fn dump_table(conn: &Connection, table: &str) -> rusqlite::Result<TableDump> {
    let mut statement = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let columns: Vec<String> = statement.column_names().iter().map(|c| (*c).to_string()).collect();
    let width = columns.len();
    // `app_settings` is one table holding many unrelated things, so the one key needing special
    // treatment has to be found per row rather than per table. Both columns are looked up by name
    // rather than by position: `SELECT *` returns declaration order, and a migration that ever
    // rebuilt this table would silently move them.
    let settings = (table == "app_settings")
        .then(|| {
            Some((
                columns.iter().position(|c| c == "key")?,
                columns.iter().position(|c| c == "value")?,
            ))
        })
        .flatten();

    let mut rows = Vec::new();
    let mut cursor = statement.query([])?;
    while let Some(row) = cursor.next()? {
        let mut values = Vec::with_capacity(width);
        for index in 0..width {
            values.push(value_to_json(row.get_ref(index)?));
        }
        if let Some((key_column, value_column)) = settings {
            if values[key_column].as_str() == Some(BACKUP_SETTINGS_KEY) {
                let stripped = values[value_column].as_str().map(strip_machine_fields).unwrap_or_default();
                values[value_column] = serde_json::Value::from(stripped);
            }
        }
        rows.push(values);
    }
    Ok(TableDump { name: table.to_string(), columns, rows })
}

/// The chosen tables, in one consistent read.
///
/// The transaction matters: without it the read spans dozens of statements, and a sync applying a
/// pull between two of them would seal a backup holding a collection but not the requests that
/// arrived with it — a state that never existed on either machine.
pub fn export(conn: &Connection, selection: &Selection) -> rusqlite::Result<Vec<TableDump>> {
    let tx = conn.unchecked_transaction()?;
    let chosen = selection.tables();
    let mut tables = Vec::with_capacity(chosen.len());
    for table in chosen {
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

/// Empties the tables the backup actually carries, children first.
///
/// **Only those.** `Replace` means "leave this machine like the backup", and for a table the backup
/// has an opinion about that means emptying it first. For a table the user chose not to include it
/// means nothing at all — clearing it would delete data on the strength of a file that never
/// claimed to replace it, which is destruction with no possible restore behind it. A partial
/// backup must never be able to erase more than it can put back.
///
/// `app_settings` is emptied when carried: a setting the backup doesn't have is one the user turned
/// off on the other machine, and a "clean restore" that left it on here would be neither clean nor
/// a restore. `backup_settings` is the exception, and [`apply`] merges this machine's half back.
fn wipe(conn: &Connection, carried: &[TableDump]) -> rusqlite::Result<()> {
    for table in TABLES.iter().rev() {
        if carried.iter().any(|dump| dump.name == *table) {
            conn.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    Ok(())
}

/// This machine's `backup_settings`, read before anything is written.
fn local_backup_settings(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [BACKUP_SETTINGS_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Puts this computer's destination back on top of the schedule that came from the backup.
///
/// Runs in both modes and after the writes, so the result is the same either way: the incoming blob
/// supplies the preferences, `local` supplies every field in [`MACHINE_LOCAL_BACKUP_FIELDS`] that
/// this machine already had an answer for. Without it a clean restore points this computer's backup
/// at the *other* computer's folder — the wrong place, and on a different platform not a place at
/// all — and hands it a `driveFileId` it has no permission to write.
fn merge_backup_settings(conn: &Connection, local: Option<&str>) -> rusqlite::Result<()> {
    let restored = local_backup_settings(conn);
    let field_of = |raw: Option<&str>, field: &str| -> Option<serde_json::Value> {
        serde_json::from_str::<serde_json::Value>(raw?)
            .ok()?
            .get(field)
            .cloned()
            .filter(|value| !matches!(value.as_str(), Some("")))
    };

    // The backup's blob when there is one, this machine's when there isn't. Neither side having
    // anything to say leaves the key absent rather than writing an empty object — that is what a
    // fresh install looks like, and what `load_settings` already defaults from.
    let Some(base) = restored.as_deref().or(local) else {
        return Ok(());
    };
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(base)
    else {
        return Ok(());
    };
    for field in MACHINE_LOCAL_BACKUP_FIELDS {
        match field_of(local, field) {
            Some(value) => {
                map.insert((*field).to_string(), value);
            }
            // Nothing local to keep — make sure the other machine's value can't survive either.
            None => {
                map.insert((*field).to_string(), serde_json::Value::from(""));
            }
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![BACKUP_SETTINGS_KEY, serde_json::Value::Object(map).to_string()],
    )?;
    Ok(())
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
        // Read in both modes: `Merge` doesn't wipe, but the incoming row would still overwrite this
        // machine's destination on its way past.
        let local = local_backup_settings(&tx);
        if mode == RestoreMode::Replace {
            wipe(&tx, tables)?;
        }
        // In `TABLES` order, not the file's: a backup written by another build may list them
        // differently, and parents still want to land first.
        for table in TABLES {
            if let Some(dump) = tables.iter().find(|d| d.name == *table) {
                write_table(&tx, dump, &mut summary)?;
            }
        }
        // After the writes, so this machine's own destination wins even against a file that somehow
        // carries one.
        merge_backup_settings(&tx, local.as_deref())?;
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
            INSERT INTO app_settings (key, value)
                VALUES ('backup_settings', '{"keepCopies":9,"folder":"C:/only/here","driveFileId":"file-on-the-other-mac"}');
            -- History and traces: present here, and expected to travel with everything else.
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
        let tables = export(&source, &Selection::default()).unwrap();

        let mut target = empty();
        let summary = apply(&mut target, &tables, RestoreMode::Replace).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM workspaces WHERE id = 'w1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM projects WHERE id = 'p1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM db_connections WHERE id = 'd1'"), 1);
        assert!(summary.rows >= 5);
        assert_eq!(summary.dangling_rows, 0, "a whole restore must leave no orphans");
    }

    /// The user's line: the other machine picks up where this one left off, history included.
    #[test]
    fn history_and_live_sessions_travel() {
        let source = seeded();
        let tables = export(&source, &Selection::default()).unwrap();

        let mut target = empty();
        apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_history WHERE id = 'h1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_cookies WHERE id = 'k1'"), 1);
    }

    /// The rule a partial backup lives or dies by: `Replace` may empty a table the file can refill,
    /// and must not touch one it cannot. Otherwise turning a switch off would turn the restore into
    /// a delete — destruction with nothing behind it to put back.
    #[test]
    fn a_partial_replace_does_not_erase_what_it_cannot_restore() {
        let source = seeded();
        let selection = Selection { conversations: false, ..Default::default() };
        let tables = export(&source, &selection).unwrap();

        let mut target = seeded();
        target
            .execute(
                "INSERT INTO activity_log (id, project_id, session_id, question, answer, created_at)
                 VALUES ('mine', 'p1', 's1', 'q', 'a', '2026-06-01T00:00:00+00:00')",
                [],
            )
            .unwrap();
        apply(&mut target, &tables, RestoreMode::Replace).unwrap();

        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM activity_log WHERE id = 'mine'"),
            1,
            "a group left out of the backup must survive a Replace untouched"
        );
        // And a group that *was* included still replaces cleanly.
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_history WHERE id = 'h1'"), 1);
    }

    #[test]
    fn a_switch_turned_off_keeps_its_tables_out_of_the_file() {
        let source = seeded();
        let tables = export(&source, &Selection { cookies: false, ..Default::default() }).unwrap();
        assert!(
            !tables.iter().any(|t| t.name == "api_cookies"),
            "the jar must not be in a file the user excluded it from"
        );
        assert!(tables.iter().any(|t| t.name == "workspaces"), "the setup is never optional");
    }

    /// Every table belongs to exactly one switch, or to the core. A table in neither is one no
    /// setting can control and — worse — one `Selection::tables` never returns.
    #[test]
    fn every_table_belongs_to_exactly_one_group() {
        for table in TABLES {
            let in_core = CORE_TABLES.contains(table);
            let groups: Vec<&str> = GROUPS
                .iter()
                .filter(|g| g.tables.contains(table))
                .map(|g| g.key)
                .collect();
            assert_eq!(
                usize::from(in_core) + groups.len(),
                1,
                "{table} is in core={in_core} and groups {groups:?}"
            );
        }
        assert_eq!(Selection::default().tables().len(), TABLES.len(), "all on means everything");
    }

    /// The upgrade path: a `backup_settings` blob written before this setting existed has no
    /// `include` field, and must keep backing up everything rather than quietly narrowing.
    #[test]
    fn settings_without_a_selection_still_include_everything() {
        let restored: Selection = serde_json::from_str("{}").unwrap();
        assert_eq!(restored, Selection::default());
        assert!(restored.credentials);
    }

    /// The guard that makes "everything" checkable rather than asserted: a migration adding a table
    /// fails here until [`TABLES`] names it. `workspace_mcps`, `doc_pages` and `work_item_reviews`
    /// were each silently unbacked for releases for want of this test.
    #[test]
    fn covers_every_table() {
        let conn = empty();
        let mut statement = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap();
        let present: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();

        let missing: Vec<&String> = present
            .iter()
            .filter(|name| !TABLES.contains(&name.as_str()) && !NEVER_BACKED_UP.contains(&name.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "these tables would vanish on a restore: {missing:?} — add them to TABLES, or to \
             NEVER_BACKED_UP with a reason",
        );

        // The exemption is not a loophole to leave lying around: a table named there and *also*
        // named in `TABLES` would read as excluded while travelling anyway, and one named there
        // after being dropped from the schema is a note about nothing.
        for name in NEVER_BACKED_UP {
            assert!(!TABLES.contains(name), "{name} is both excluded and included");
            assert!(present.iter().any(|p| p == name), "{name} is excluded but not in the schema");
        }

        let stale: Vec<&&str> = TABLES.iter().filter(|name| !present.iter().any(|p| p == *name)).collect();
        assert!(stale.is_empty(), "these are named but no longer in the schema: {stale:?}");
    }

    /// The schedule is a preference and travels; the folder it writes to is a fact about a computer
    /// and does not.
    #[test]
    fn the_schedule_travels_but_the_destination_does_not() {
        let source = seeded();
        let tables = export(&source, &Selection::default()).unwrap();
        let settings = tables.iter().find(|t| t.name == "app_settings").unwrap();
        let keys: Vec<&str> = settings.rows.iter().filter_map(|r| r[0].as_str()).collect();
        assert!(keys.contains(&"ai_provider"));
        assert!(keys.contains(&"backup_settings"), "the schedule is part of the setup");

        let row = settings
            .rows
            .iter()
            .find(|r| r[0].as_str() == Some("backup_settings"))
            .unwrap();
        let blob: serde_json::Value = serde_json::from_str(row[1].as_str().unwrap()).unwrap();
        assert_eq!(blob["keepCopies"], 9, "a preference travels");
        assert_eq!(blob["folder"], "", "a path on the other machine's disk does not");
    }

    /// The failure `PRAGMA foreign_keys = OFF` exists to prevent: rewriting a workspace row must
    /// not take everything hanging off it down first.
    #[test]
    fn replacing_a_parent_row_does_not_cascade_its_children_away() {
        let source = seeded();
        let tables = export(&source, &Selection::default()).unwrap();

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
        let tables = export(&source, &Selection::default()).unwrap();

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
        let tables = export(&source, &Selection::default()).unwrap();

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
        let tables = export(&source, &Selection::default()).unwrap();
        let mut target = empty();
        let summary = apply(&mut target, &tables, RestoreMode::Replace).unwrap();
        assert_eq!(summary.missing_project_paths.len(), 1);
    }

    /// A backup written by a build with a column this one has dropped restores anyway.
    #[test]
    fn an_unknown_column_is_dropped_rather_than_refused() {
        let source = seeded();
        let mut tables = export(&source, &Selection::default()).unwrap();
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
