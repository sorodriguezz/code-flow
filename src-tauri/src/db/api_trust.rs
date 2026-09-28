//! Which request scripts may run without asking first.
//!
//! A pre-request or post-response script runs in the webview with everything the app's JavaScript
//! can reach (see `src/lib/api/sandbox.ts`). That was fine while every script was one the user typed
//! into this app — but an import, and a collection shared through a Supabase project, bring
//! somebody else's code. So a script runs unasked only when its **exact text** is known to be the
//! user's: typed in this app's own script editor, approved in the trust gate, or already here when
//! the gate shipped. Anything else stops at a dialog that shows the code first.
//!
//! **Keyed by a SHA-256 of the text, not by the row holding it.** A collaborator who edits a script
//! produces a different text and therefore a different hash, which is exactly the "ask again" the
//! gate needs — no bookkeeping about who changed what. The same text in two places (a duplicated
//! request, your own export imported back) is the same code, and one approval covers both.
//!
//! **Local only.** The table is never part of a collaboration push or pull — trust is a decision
//! about code seen on this machine, and a peer must never be able to make that decision for it. It
//! does travel in the user's own encrypted backup, with the collections it vouches for.
//!
//! **Trust only goes up.** Recording a hash as untrusted (an import noting where a script came
//! from) never demotes one already trusted: identical text is identical code.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::queries::now;

/// Why a row exists — the two origins this side writes. The frontend writes `authored` (typed in
/// the script editor) and `approved` (accepted in the trust gate), and an import writes
/// `import:<format>`. Free text, so a later origin needs no migration.
pub const ORIGIN_MIGRATION: &str = "migration";
pub const ORIGIN_SHARED: &str = "shared";

/// Bound on the free-text origin, so a caller can't park a document in a label column.
const ORIGIN_MAX: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptTrust {
    /// Lowercase hex SHA-256 of the script's exact UTF-8 text.
    pub hash: String,
    /// `true` — may run without asking.
    pub trusted: bool,
    /// `authored` | `approved` | `migration` | `shared` | `import:<format>`.
    pub origin: String,
}

/// The hash the frontend computes too (`scriptHash` in `src/lib/api/scriptTrust.ts`): SHA-256 over
/// the UTF-8 bytes, no normalisation — trimming or line-ending folding would let two different
/// programs share one approval.
pub fn script_hash(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}

/// Blank scripts never run (`runScript` returns before evaluating), so they are never recorded or
/// asked about either.
pub fn is_runnable(code: &str) -> bool {
    !code.trim().is_empty()
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The rows that exist for `hashes`. A hash with no row is simply absent — untrusted, origin unknown.
pub fn lookup(conn: &Connection, hashes: &[String]) -> rusqlite::Result<Vec<ScriptTrust>> {
    let mut stmt = conn.prepare("SELECT hash, trusted, origin FROM api_script_trust WHERE hash = ?1")?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for hash in hashes {
        if !is_hash(hash) || !seen.insert(hash.as_str()) {
            continue;
        }
        let row = stmt
            .query_row(params![hash], |row| {
                Ok(ScriptTrust { hash: row.get(0)?, trusted: row.get(1)?, origin: row.get(2)? })
            })
            .optional()?;
        out.extend(row);
    }
    Ok(out)
}

/// Upserts `entries`. `trusted` is a ratchet: an existing trusted row stays trusted and keeps the
/// origin that made it so; an untrusted row keeps its first origin until something trusts it.
pub fn record(conn: &Connection, entries: &[ScriptTrust]) -> rusqlite::Result<()> {
    let stamp = now();
    let mut stmt = conn.prepare(
        "INSERT INTO api_script_trust (hash, trusted, origin, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(hash) DO UPDATE SET
             origin = CASE WHEN excluded.trusted > api_script_trust.trusted
                           THEN excluded.origin ELSE api_script_trust.origin END,
             updated_at = CASE WHEN excluded.trusted > api_script_trust.trusted
                               THEN excluded.updated_at ELSE api_script_trust.updated_at END,
             trusted = MAX(api_script_trust.trusted, excluded.trusted)",
    )?;
    for entry in entries {
        if !is_hash(&entry.hash) {
            continue;
        }
        let origin: String = entry.origin.chars().take(ORIGIN_MAX).collect();
        stmt.execute(params![entry.hash, entry.trusted, origin, stamp])?;
    }
    Ok(())
}

/// Records every runnable script in `codes` under one verdict — the shape an import needs.
pub fn record_scripts<'a>(
    conn: &Connection,
    codes: impl IntoIterator<Item = &'a str>,
    trusted: bool,
    origin: &str,
) -> rusqlite::Result<()> {
    let entries: Vec<ScriptTrust> = codes
        .into_iter()
        .filter(|code| is_runnable(code))
        .map(|code| ScriptTrust { hash: script_hash(code), trusted, origin: origin.to_string() })
        .collect();
    record(conn, &entries)
}

/// The two scripts inside a request's `spec` blob. A blob that doesn't parse holds no script the
/// sandbox could run either, so it contributes nothing.
pub fn request_scripts(spec: &str) -> [String; 2] {
    let parsed: serde_json::Value = serde_json::from_str(spec).unwrap_or(serde_json::Value::Null);
    let field = |key: &str| parsed.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    [field("preScript"), field("postScript")]
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/// Creates the table, and — only on the run that creates it — trusts what is already here.
///
/// The upgrade has to be quiet for the scripts people wrote themselves: a gate that greeted every
/// existing request with a dialog would be clicked through by reflex, which is the habit it exists
/// to break. So everything present at this moment is trusted **except** scripts in collections
/// linked to collaboration: those may already hold a teammate's code that never passed any gate,
/// so they are recorded as `shared` and ask once.
///
/// "Only on the run that creates it" is what makes this an upgrade rather than a standing rule: on
/// every later launch the table exists and nothing here runs, so a script that arrives afterwards
/// is judged by the gate, never waved through by a migration.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let existed = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_script_trust'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS api_script_trust (
            hash       TEXT PRIMARY KEY,
            trusted    INTEGER NOT NULL DEFAULT 0,
            origin     TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );",
    )?;

    if existed {
        return Ok(());
    }
    seed_existing(conn)
}

fn seed_existing(conn: &Connection) -> rusqlite::Result<()> {
    let shared: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT collection_id FROM api_shared_collections")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    // (collection_id, script) for every script in the tree, whichever table it lives in.
    let mut scripts: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, pre_script, post_script FROM api_collections")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (id, pre, post) = row?;
            scripts.push((id.clone(), pre));
            scripts.push((id, post));
        }
    }
    {
        let mut stmt = conn.prepare("SELECT collection_id, pre_script, post_script FROM api_folders")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (collection_id, pre, post) = row?;
            scripts.push((collection_id.clone(), pre));
            scripts.push((collection_id, post));
        }
    }
    {
        let mut stmt = conn.prepare("SELECT collection_id, spec FROM api_requests")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for row in rows {
            let (collection_id, spec) = row?;
            let [pre, post] = request_scripts(&spec);
            scripts.push((collection_id.clone(), pre));
            scripts.push((collection_id, post));
        }
    }

    let seed = |conn: &Connection| -> rusqlite::Result<()> {
        for (collection_id, code) in &scripts {
            let (trusted, origin) = if shared.contains(collection_id) {
                (false, ORIGIN_SHARED)
            } else {
                (true, ORIGIN_MIGRATION)
            };
            // The ratchet in `record` is what settles one text living in both a shared and a local
            // collection: the local copy vouches for it, whichever of the two is met first.
            record_scripts(conn, [code.as_str()], trusted, origin)?;
        }
        Ok(())
    };
    // Batched in a transaction of its own only when nobody opened one already. `db::open` runs the
    // whole migration list inside a single `BEGIN IMMEDIATE`, and SQLite has no nested BEGIN: a
    // second one here fails, which used to send every fresh install and first upgrade down the
    // migration's non-transactional fallback. Inside that outer transaction the writes are already
    // batched, and they commit or roll back with the rest of the migration.
    if !conn.is_autocommit() {
        return seed(conn);
    }
    let tx = conn.unchecked_transaction()?;
    seed(&tx)?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn
    }

    /// `db::open` runs the migration list inside one `BEGIN IMMEDIATE`. Seeding used to open a
    /// transaction of its own, which SQLite refuses inside another — so every fresh install and
    /// first upgrade fell back to migrating without a transaction. It must seed inside the outer
    /// one, and roll back with it.
    #[test]
    fn seeding_runs_inside_an_outer_migration_transaction() {
        let conn = fresh();
        conn.execute_batch(
            "DROP TABLE api_script_trust;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'W', '', '', 0, '2026-01-01T00:00:00+00:00');
             INSERT INTO api_collections (id, workspace_id, name, pre_script, post_script, created_at, updated_at)
                 VALUES ('c1', 'w1', 'Mine', 'seeded inside', '', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();

        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        migrate(&conn).unwrap();
        assert!(!conn.is_autocommit(), "seeding must not have committed or ended the outer transaction");
        conn.execute_batch("ROLLBACK").unwrap();
        // DDL is transactional in SQLite: rolling back takes the freshly created table with it,
        // seeded rows and all — which is exactly the all-or-nothing the outer transaction is for.
        let table_left = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_script_trust'",
                [],
                |_| Ok(true),
            )
            .optional()
            .unwrap()
            .unwrap_or(false);
        assert!(!table_left, "a rolled-back migration leaves nothing behind, not even the table");

        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        assert!(row(&conn, "seeded inside").unwrap().trusted);
    }

    fn row(conn: &Connection, code: &str) -> Option<ScriptTrust> {
        lookup(conn, &[script_hash(code)]).unwrap().into_iter().next()
    }

    /// Pinned against `shasum -a 256` so the Rust and TypeScript hashes are provably the same
    /// function — the same vector is asserted in `scriptTrust.test.ts`.
    #[test]
    fn the_hash_is_plain_sha256_of_the_utf8_text() {
        assert_eq!(
            script_hash("pm.test(\"ok\", () => {});\n"),
            "f289d1ab16f967646ba0624bd086604655b6f271938f9287383df05cb2e6e56b"
        );
        // Non-ASCII is hashed as UTF-8, not as UTF-16 code units.
        assert_eq!(
            script_hash("console.log(\"ñandú\")"),
            "d28ea6a847ceee6f67b3f947729152308fb58fbcf1c73aacab80f98379f4b983"
        );
    }

    #[test]
    fn recording_is_a_ratchet_that_never_demotes() {
        let conn = fresh();
        let code = "pm.environment.set('a', 1)";
        record_scripts(&conn, [code], true, "approved").unwrap();
        // An import of the same text must not take the approval away.
        record_scripts(&conn, [code], false, "import:postman").unwrap();
        let found = row(&conn, code).unwrap();
        assert!(found.trusted);
        assert_eq!(found.origin, "approved");

        // And an untrusted row is promoted — taking the origin that trusted it.
        let other = "pm.globals.set('b', 2)";
        record_scripts(&conn, [other], false, "import:insomnia").unwrap();
        assert_eq!(row(&conn, other).unwrap().origin, "import:insomnia");
        record_scripts(&conn, [other], true, "approved").unwrap();
        let promoted = row(&conn, other).unwrap();
        assert!(promoted.trusted);
        assert_eq!(promoted.origin, "approved");
    }

    #[test]
    fn blank_scripts_and_malformed_hashes_are_never_recorded() {
        let conn = fresh();
        record_scripts(&conn, ["", "   \n\t"], true, "authored").unwrap();
        record(
            &conn,
            &[ScriptTrust { hash: "not-a-hash".into(), trusted: true, origin: "authored".into() }],
        )
        .unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM api_script_trust", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        // A lookup ignores junk rather than failing the whole batch.
        assert!(lookup(&conn, &["zz".into(), script_hash("x")]).unwrap().is_empty());
    }

    /// The upgrade path: what exists when the table is created is trusted, except in collections
    /// linked to collaboration — and a later launch seeds nothing.
    #[test]
    fn the_first_run_trusts_existing_scripts_outside_shared_collections() {
        let conn = fresh();
        conn.execute_batch(
            r#"
            DROP TABLE api_script_trust;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'W', '', '', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_collections (id, workspace_id, name, pre_script, post_script, created_at, updated_at)
                VALUES ('local', 'w1', 'Mine', 'local collection pre', '', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                       ('team', 'w1', 'Team', 'team collection pre', 'both places', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_folders (id, collection_id, parent_id, name, pre_script, post_script, created_at, updated_at)
                VALUES ('f1', 'local', NULL, 'F', '', 'local folder post', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                       ('f2', 'team', NULL, 'G', 'team folder pre', '', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                VALUES ('r1', 'local', 'f1', 'A', '', '{"preScript":"local request pre","postScript":"both places"}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                       ('r2', 'team', NULL, 'B', '', '{"preScript":"","postScript":"team request post"}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
                       ('r3', 'team', NULL, 'C', '', 'not json', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_shared_collections (collection_id, workspace_id, remote_name, role, created_at)
                VALUES ('team', 'w1', 'Team', 'member', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();

        migrate(&conn).unwrap();

        for code in ["local collection pre", "local folder post", "local request pre"] {
            let found = row(&conn, code).unwrap_or_else(|| panic!("{code} was not seeded"));
            assert!(found.trusted, "{code}");
            assert_eq!(found.origin, ORIGIN_MIGRATION);
        }
        for code in ["team collection pre", "team folder pre", "team request post"] {
            let found = row(&conn, code).unwrap_or_else(|| panic!("{code} was not recorded"));
            assert!(!found.trusted, "{code} must ask once");
            assert_eq!(found.origin, ORIGIN_SHARED);
        }
        // In both a shared and a local collection: the local copy vouches for it.
        assert!(row(&conn, "both places").unwrap().trusted);

        // A script added after the upgrade is never waved through by a later launch.
        conn.execute(
            "UPDATE api_collections SET pre_script = 'arrived later' WHERE id = 'local'",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert!(row(&conn, "arrived later").is_none());
    }
}
