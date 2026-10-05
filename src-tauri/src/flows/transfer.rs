//! A flow as a file: export to JSON, import back — on this machine or another.
//!
//! **What travels is the document, never a secret.** A credential is referred to by id in a flow;
//! the export lists each one it uses by name and kind only, and the import matches them to the
//! credentials of the workspace it lands in by that name and kind. One with no match is left empty
//! for the user to pick — a node pointing at a credential id from another machine would fail in a
//! way that says nothing useful.
//!
//! **Pointers into this machine are checked.** A database connection, a Remote host, a note or a
//! repository is named by an id that only means something where it was made: kept when it exists
//! here (the user's own export imported back), cleared when it does not.
//!
//! **An import is not trusted.** It arrives with someone's commands; `flows_create_flow` with a
//! document stores it untrusted, and the review dialog is what runs first.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::params::{self, Kind};
use super::spec::{self, FlowSpec};
use crate::db::flow_run_queries;

/// The file's own marker, so an import can tell a CodeFlow flow from any JSON.
pub const MARKER: &str = "codeflow.flow";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedCredential {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub format: String,
    pub schema: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub credentials: Vec<ExportedCredential>,
    pub spec: FlowSpec,
}

/// What an import changed on the way in, for the window to say.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportNotes {
    /// Credentials the flow named that this workspace has no match for, by name.
    pub unmatched_credentials: Vec<String>,
    /// References to things that do not exist here, cleared: `node name · parameter`.
    pub cleared: Vec<String>,
    /// n8n nodes with no counterpart here, kept switched off: `Name (type)`.
    pub unmapped: Vec<String>,
}

/// The parameters of a node that point at something outside the document, with what they point at.
fn pointers(type_id: &str) -> Vec<(&'static str, &'static str)> {
    params::for_type(type_id)
        .iter()
        .filter_map(|spec| {
            let what = match spec.kind {
                Kind::Credential { .. } => "credential",
                Kind::DbConnection { .. } => "db",
                Kind::RemoteHost { .. } => "remote",
                Kind::Note => "note",
                Kind::Project => "project",
                _ => return None,
            };
            Some((spec.name, what))
        })
        .collect()
}

/// The export document of a flow.
pub fn export(conn: &Connection, name: &str, description: &str, spec: &FlowSpec) -> rusqlite::Result<ExportFile> {
    let mut credentials: Vec<ExportedCredential> = Vec::new();
    for node in &spec.nodes {
        for (param, what) in pointers(&node.type_id) {
            if what != "credential" {
                continue;
            }
            let Some(id) = node.params.get(param).and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
            if credentials.iter().any(|c| c.id == id) {
                continue;
            }
            if let Some(found) = flow_run_queries::get_credential(conn, id)? {
                credentials.push(ExportedCredential { id: found.id, name: found.name, kind: found.kind });
            }
        }
    }
    Ok(ExportFile {
        format: MARKER.into(),
        schema: 1,
        name: name.to_string(),
        description: description.to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        credentials,
        spec: spec.clone(),
    })
}

/// Reads an export (or a bare flow document) and fits it to `workspace_id`: credentials matched by
/// name and kind, pointers that mean nothing here cleared. Returns the document to store, its name,
/// its description and what was changed.
pub fn import(conn: &Connection, workspace_id: &str, text: &str) -> Result<(FlowSpec, String, String, ImportNotes), String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("The file is not JSON: {e}"))?;
    let mut unmapped = Vec::new();
    let (mut document, name, description, credentials) = if value.get("format").and_then(Value::as_str) == Some(MARKER) {
        let file: ExportFile = serde_json::from_value(value).map_err(|e| format!("The file is not a CodeFlow flow: {e}"))?;
        (file.spec, file.name, file.description, file.credentials)
    } else if super::n8n::is_n8n(&value) {
        // An n8n workflow: its core nodes mapped, the rest kept switched off and listed.
        let converted = super::n8n::convert(&value)?;
        unmapped = converted.unmapped;
        (converted.spec, converted.name, String::new(), Vec::new())
    } else if value.get("nodes").is_some() {
        let spec: FlowSpec = serde_json::from_value(value).map_err(|e| format!("The file is not a CodeFlow flow: {e}"))?;
        (spec, String::new(), String::new(), Vec::new())
    } else {
        return Err("The file is not a CodeFlow flow".into());
    };
    // What the editor would refuse to save is refused here too.
    spec::validate(&document)?;

    let local = flow_run_queries::list_credentials(conn, workspace_id).map_err(|e| e.to_string())?;
    let by_id: HashMap<&str, &ExportedCredential> = credentials.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut notes = ImportNotes { unmapped, ..ImportNotes::default() };
    for node in document.nodes.iter_mut() {
        for (param, what) in pointers(&node.type_id) {
            let Some(id) = node.params.get(param).and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string) else { continue };
            let replacement: Option<String> = match what {
                "credential" => match by_id.get(id.as_str()) {
                    Some(wanted) => {
                        let found = local.iter().find(|c| c.name == wanted.name && c.kind == wanted.kind).map(|c| c.id.clone());
                        if found.is_none() && !notes.unmatched_credentials.contains(&wanted.name) {
                            notes.unmatched_credentials.push(wanted.name.clone());
                        }
                        found
                    }
                    // Not listed in the file: kept only if it is one of this workspace's own.
                    None => local.iter().any(|c| c.id == id).then(|| id.clone()),
                },
                "db" => crate::db::datasource_queries::get_connection(conn, &id).ok().flatten().map(|_| id.clone()),
                "remote" => crate::db::remote_queries::get_host(conn, &id).ok().flatten().map(|_| id.clone()),
                "note" => crate::db::note_queries::get_note(conn, &id).ok().flatten().map(|_| id.clone()),
                "project" => crate::db::queries::get_project(conn, &id).ok().flatten().map(|_| id.clone()),
                _ => Some(id.clone()),
            };
            match replacement {
                Some(new_id) if new_id == id => {}
                Some(new_id) => {
                    node.params[param] = json!(new_id);
                }
                None => {
                    node.params[param] = json!("");
                    if what != "credential" {
                        notes.cleared.push(format!("{} · {param}", node.name));
                    }
                }
            }
        }
    }
    // Nothing imported starts switched on: it is a document, not a running thing.
    Ok((document, name, description, notes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES ('w1', 'Uno', 'x', '#111', 0, '2026-01-01');
             INSERT INTO flow_credentials (id, workspace_id, scope, name, kind, meta, created_at, updated_at)
                 VALUES ('local-api', 'w1', 'workspace', 'API pedidos', 'bearer', '{}', '2026-01-01', '2026-01-01');",
        )
        .unwrap();
        conn
    }

    fn document() -> FlowSpec {
        spec::parse(
            &json!({
                "schema": 1,
                "nodes": [
                    {"id": "t", "type": "trigger.manual", "name": "Manual", "pos": [0, 0]},
                    {"id": "h", "type": "net.http", "name": "Pedidos", "pos": [200, 0], "params": {"url": "https://example.com", "credential": "their-api"}},
                    {"id": "g", "type": "net.graphql", "name": "Catálogo", "pos": [200, 100], "params": {"url": "https://example.com/gql", "credential": "their-other"}},
                    {"id": "q", "type": "data.sql", "name": "Consulta", "pos": [400, 0], "params": {"connection": "their-db", "queryText": "SELECT 1"}},
                ],
                "connections": [{"from": "t", "out": 0, "to": "h", "input": 0}],
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn credentials_travel_by_name_and_foreign_pointers_are_cleared() {
        let conn = db();
        let file = ExportFile {
            format: MARKER.into(),
            schema: 1,
            name: "Pedidos".into(),
            description: "d".into(),
            exported_at: String::new(),
            credentials: vec![
                ExportedCredential { id: "their-api".into(), name: "API pedidos".into(), kind: "bearer".into() },
                ExportedCredential { id: "their-other".into(), name: "Catálogo".into(), kind: "header".into() },
            ],
            spec: document(),
        };
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains("secret"), "an export carries no secret field at all");
        let (spec, name, _, notes) = import(&conn, "w1", &text).unwrap();
        assert_eq!(name, "Pedidos");
        let param = |id: &str, name: &str| spec.nodes.iter().find(|n| n.id == id).unwrap().params[name].clone();
        assert_eq!(param("h", "credential"), json!("local-api"), "matched by name and kind");
        assert_eq!(param("g", "credential"), json!(""));
        assert_eq!(notes.unmatched_credentials, vec!["Catálogo"]);
        assert_eq!(param("q", "connection"), json!(""));
        assert_eq!(notes.cleared, vec!["Consulta · connection"]);
    }

    #[test]
    fn a_bare_document_imports_and_anything_else_is_refused() {
        let conn = db();
        let bare = serde_json::to_string(&document()).unwrap();
        assert!(import(&conn, "w1", &bare).is_ok());
        assert!(import(&conn, "w1", r#"{"hello": 1}"#).unwrap_err().contains("not a CodeFlow flow"));
        assert!(import(&conn, "w1", "not json").unwrap_err().contains("not JSON"));
    }
}
