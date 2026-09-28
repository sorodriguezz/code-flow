//! Writes an imported collection tree in one transaction.
//!
//! The import used to be one IPC round trip per row — create the collection, update it, create each
//! folder, update it, create each request — so a failure half way through (a malformed spec, a
//! locked database, the window closing) left a collection with half its requests and no way to tell
//! which half. Here the whole tree and its environments go in inside one SQLite transaction: either
//! everything arrives or nothing does.
//!
//! The payload is already row-shaped. The frontend's importers map every source format onto
//! `ImportedCollection` and serialise auth, variables and specs to the same JSON blobs the tables
//! store, so this module stays what the rest of `db/` is — storage, with no opinion about what a
//! Postman auth block means.
//!
//! Every script the import brings is recorded in `api_script_trust` as untrusted, with the format it
//! came from as its origin (see `api_trust`). Same transaction, so a rolled-back import leaves no
//! stray trust rows behind it either.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::api_queries;
use super::api_trust;

/// Deeper than any real collection nests; what it stops is a payload built to exhaust the stack.
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Deserialize)]
pub struct ImportPayload {
    /// `postman`, `openapi`, `insomnia`, `bruno`… — recorded as `import:<format>` on each script.
    pub format: String,
    pub collections: Vec<ImportCollection>,
    pub environments: Vec<ImportEnvironment>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportCollection {
    pub name: String,
    pub description: String,
    /// The `auth` column's JSON, `""` for none.
    pub auth: String,
    pub pre_script: String,
    pub post_script: String,
    /// The `variables` column's JSON array.
    pub variables: String,
    pub items: Vec<ImportItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportItem {
    Folder {
        name: String,
        description: String,
        auth: String,
        pre_script: String,
        post_script: String,
        items: Vec<ImportItem>,
    },
    Request {
        name: String,
        protocol: String,
        /// The request's `spec` blob, stored verbatim.
        spec: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportEnvironment {
    pub name: String,
    pub variables: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ImportOutcome {
    pub collection_ids: Vec<String>,
    pub environment_ids: Vec<String>,
    pub folders: usize,
    pub requests: usize,
}

pub fn import_tree(
    conn: &Connection,
    workspace_id: &str,
    payload: &ImportPayload,
) -> Result<ImportOutcome, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let origin = format!("import:{}", payload.format.trim());
    let mut outcome = ImportOutcome::default();
    let mut scripts: Vec<String> = Vec::new();

    for source in &payload.collections {
        let mut collection =
            api_queries::create_collection(&tx, workspace_id, &source.name).map_err(|e| e.to_string())?;
        collection.description = source.description.clone();
        collection.auth = source.auth.clone();
        collection.pre_script = source.pre_script.clone();
        collection.post_script = source.post_script.clone();
        collection.variables = source.variables.clone();
        api_queries::update_collection(&tx, &collection).map_err(|e| e.to_string())?;
        scripts.push(source.pre_script.clone());
        scripts.push(source.post_script.clone());

        insert_items(&tx, &collection.id, None, &source.items, 0, &mut outcome, &mut scripts)?;
        outcome.collection_ids.push(collection.id);
    }

    for source in &payload.environments {
        let mut environment =
            api_queries::create_environment(&tx, workspace_id, &source.name).map_err(|e| e.to_string())?;
        environment.variables = source.variables.clone();
        api_queries::update_environment(&tx, &environment).map_err(|e| e.to_string())?;
        outcome.environment_ids.push(environment.id);
    }

    api_trust::record_scripts(&tx, scripts.iter().map(String::as_str), false, &origin)
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(outcome)
}

fn insert_items(
    tx: &Connection,
    collection_id: &str,
    folder_id: Option<&str>,
    items: &[ImportItem],
    depth: usize,
    outcome: &mut ImportOutcome,
    scripts: &mut Vec<String>,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("the import nests folders more than {MAX_DEPTH} levels deep"));
    }
    for item in items {
        match item {
            ImportItem::Request { name, protocol, spec } => {
                api_queries::create_request(tx, collection_id, folder_id, name, protocol, spec)
                    .map_err(|e| format!("could not import request \"{name}\": {e}"))?;
                scripts.extend(api_trust::request_scripts(spec));
                outcome.requests += 1;
            }
            ImportItem::Folder { name, description, auth, pre_script, post_script, items } => {
                let mut folder = api_queries::create_folder(tx, collection_id, folder_id, name)
                    .map_err(|e| format!("could not import folder \"{name}\": {e}"))?;
                folder.description = description.clone();
                folder.auth = auth.clone();
                folder.pre_script = pre_script.clone();
                folder.post_script = post_script.clone();
                api_queries::update_folder(tx, &folder).map_err(|e| e.to_string())?;
                scripts.push(pre_script.clone());
                scripts.push(post_script.clone());
                outcome.folders += 1;
                insert_items(tx, collection_id, Some(&folder.id), items, depth + 1, outcome, scripts)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'W', '', '', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    fn request(name: &str, spec: &str) -> ImportItem {
        ImportItem::Request { name: name.into(), protocol: "http".into(), spec: spec.into() }
    }

    fn payload(items: Vec<ImportItem>) -> ImportPayload {
        ImportPayload {
            format: "postman".into(),
            collections: vec![ImportCollection {
                name: "Orders API".into(),
                description: "d".into(),
                auth: "".into(),
                pre_script: "collection pre".into(),
                post_script: "".into(),
                variables: "[]".into(),
                items: vec![ImportItem::Folder {
                    name: "v1".into(),
                    description: "".into(),
                    auth: "".into(),
                    pre_script: "".into(),
                    post_script: "folder post".into(),
                    items,
                }],
            }],
            environments: vec![ImportEnvironment {
                name: "api.example.test".into(),
                variables: r#"[{"key":"baseUrl"}]"#.into(),
            }],
        }
    }

    #[test]
    fn the_whole_tree_lands_and_its_scripts_are_untrusted() {
        let conn = seeded();
        let outcome = import_tree(
            &conn,
            "w1",
            &payload(vec![
                request("List", r#"{"method":"GET","url":"{{baseUrl}}/v1/orders","postScript":"request post"}"#),
                request("Get", r#"{"method":"GET","url":"{{baseUrl}}/v1/orders/{orderId}"}"#),
            ]),
        )
        .unwrap();

        assert_eq!(outcome.collection_ids.len(), 1);
        assert_eq!(outcome.environment_ids.len(), 1);
        assert_eq!((outcome.folders, outcome.requests), (1, 2));
        assert_eq!(count(&conn, "api_collections"), 1);
        assert_eq!(count(&conn, "api_folders"), 1);
        assert_eq!(count(&conn, "api_requests"), 2);
        // The workspace's own Globals row is there too, so two environments.
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM api_environments WHERE is_global = 0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );

        // The denormalised columns are seeded from the spec, the same as a single create.
        let url: String = conn
            .query_row("SELECT url FROM api_requests WHERE name = 'List'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(url, "{{baseUrl}}/v1/orders");

        for code in ["collection pre", "folder post", "request post"] {
            let rows = api_trust::lookup(&conn, &[api_trust::script_hash(code)]).unwrap();
            assert_eq!(rows.len(), 1, "{code}");
            assert!(!rows[0].trusted, "{code} arrived from outside and must ask first");
            assert_eq!(rows[0].origin, "import:postman");
        }
    }

    /// A failure half way through leaves nothing behind — no collection, no folder, no request, no
    /// environment and no trust row.
    #[test]
    fn a_failure_rolls_everything_back() {
        let conn = seeded();
        // A trigger rejecting the second request stands in for any mid-import failure — a bad row, a
        // locked database — after the collection, the folder and the first request were written.
        conn.execute_batch(
            "CREATE TRIGGER reject_second BEFORE INSERT ON api_requests
                 WHEN NEW.name = 'Broken'
                 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
        )
        .unwrap();

        let error = import_tree(
            &conn,
            "w1",
            &payload(vec![
                request("Fine", r#"{"postScript":"request post"}"#),
                request("Broken", "{}"),
            ]),
        )
        .unwrap_err();
        assert!(error.contains("Broken"), "{error}");

        assert_eq!(count(&conn, "api_collections"), 0);
        assert_eq!(count(&conn, "api_folders"), 0);
        assert_eq!(count(&conn, "api_requests"), 0);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM api_environments WHERE is_global = 0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(count(&conn, "api_script_trust"), 0);
    }

    #[test]
    fn a_payload_nested_past_the_limit_is_refused_whole() {
        let conn = seeded();
        let mut items = vec![request("Leaf", "{}")];
        for depth in 0..=MAX_DEPTH + 1 {
            items = vec![ImportItem::Folder {
                name: format!("level {depth}"),
                description: "".into(),
                auth: "".into(),
                pre_script: "".into(),
                post_script: "".into(),
                items,
            }];
        }
        assert!(import_tree(&conn, "w1", &payload(items)).is_err());
        assert_eq!(count(&conn, "api_folders"), 0);
    }
}
