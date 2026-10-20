//! Datasets: approved experiences turned into chat examples a trainer reads.
//!
//! An example is `{ "messages": [system, user, assistant] }` — the shape both `mlx-lm` and TRL's SFT
//! trainer take, rendered with each base model's own chat template at training time, so one dataset
//! serves any family. Only **positive** evidence becomes an example (a kept turn, an applied answer);
//! reverted and rejected ones are counted in the manifest, kept for preference training later.

use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Fewer examples than this train nothing worth publishing; the dataset is still built, and says so.
pub const MEANINGFUL: usize = 50;
/// The least a trainer accepts: one to train on, one to validate, one to test.
pub const MINIMUM: usize = 3;

const SYSTEM: &str = "You are CodeFlow's coding assistant. Answer the way this user has accepted before.";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub source: String,
    pub prompt: String,
    pub response: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRow {
    pub id: String,
    pub name: String,
    pub family: String,
    pub path: String,
    pub train_count: i64,
    pub valid_count: i64,
    pub test_count: i64,
    pub manifest: serde_json::Value,
    pub created_at: i64,
}

/// The positive examples approved experiences yield, with the ids they came from, and how many
/// negative ones were seen. `workspace_id`: only that workspace's.
pub fn collect(conn: &Connection, workspace_id: Option<&str>) -> rusqlite::Result<(Vec<(String, Example)>, usize)> {
    let mut stmt = conn.prepare(
        "SELECT id, source, signal, run_ref, prompt, response FROM ai_experiences
         WHERE training_allowed = 1 AND quality = 'approved' AND (?1 IS NULL OR workspace_id = ?1)
         ORDER BY created_at",
    )?;
    let rows: Vec<(String, String, String, Option<String>, Option<String>, Option<String>)> = stmt
        .query_map(params![workspace_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut examples = Vec::new();
    let mut negatives = 0;
    let mut seen = std::collections::HashSet::new();
    for (id, source, signal, run_ref, prompt, response) in rows {
        if matches!(signal.as_str(), "reverted" | "rejected" | "failed" | "error" | "cancelled") {
            negatives += 1;
            continue;
        }
        let pair = match (prompt.filter(|p| !p.trim().is_empty()), response.filter(|r| !r.trim().is_empty())) {
            (Some(p), Some(r)) => Some((p, r)),
            _ => run_ref.as_deref().and_then(|r| r.strip_prefix("checkpoint:")).and_then(|checkpoint| turn_of_checkpoint(conn, checkpoint)),
        };
        let Some((prompt, response)) = pair else { continue };
        let prompt = crate::secret_scan::redact(prompt.trim()).0;
        let response = crate::secret_scan::redact(response.trim()).0;
        let key = format!("{:x}", Sha256::digest(format!("{}\u{0}{}", normalized(&prompt), normalized(&response)).as_bytes()));
        if !seen.insert(key) {
            continue;
        }
        examples.push((id, Example { source, prompt, response }));
    }
    Ok((examples, negatives))
}

/// The question and answer of the chat turn whose checkpoint is `checkpoint`.
fn turn_of_checkpoint(conn: &Connection, checkpoint: &str) -> Option<(String, String)> {
    let pattern = format!("%\"id\":\"{}\"%", checkpoint.replace('%', "").replace('_', "\\_"));
    conn.query_row(
        "SELECT question, answer FROM activity_log WHERE checkpoint LIKE ?1 ESCAPE '\\' AND is_error = 0 LIMIT 1",
        params![pattern],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .ok()
}

fn normalized(text: &str) -> String {
    text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Which split an example's group goes to: one in ten to test, one in ten to validation. By the
/// prompt's opening, so two near-identical requests always land on the same side.
fn split_of(prompt: &str) -> u8 {
    let opening: String = normalized(prompt).chars().take(200).collect();
    Sha256::digest(opening.as_bytes())[0] % 10
}

/// The three splits, never empty when there are at least [`MINIMUM`] examples.
pub fn split(examples: Vec<Example>) -> (Vec<Example>, Vec<Example>, Vec<Example>) {
    let (mut train, mut valid, mut test) = (Vec::new(), Vec::new(), Vec::new());
    for example in examples {
        match split_of(&example.prompt) {
            0 => test.push(example),
            1 => valid.push(example),
            _ => train.push(example),
        }
    }
    for target in [&mut valid, &mut test] {
        if target.is_empty() && train.len() > 1 {
            target.push(train.pop().expect("checked"));
        }
    }
    if train.is_empty() {
        if let Some(moved) = valid.pop().or_else(|| test.pop()) {
            train.push(moved);
        }
    }
    (train, valid, test)
}

fn jsonl(examples: &[Example]) -> String {
    examples
        .iter()
        .map(|e| {
            serde_json::json!({ "messages": [
                { "role": "system", "content": SYSTEM },
                { "role": "user", "content": e.prompt },
                { "role": "assistant", "content": e.response },
            ]})
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Builds and files a dataset for `family` from the approved experiences (of `workspace_id`, when
/// given), under `root`.
pub fn build(conn: &Connection, root: &std::path::Path, name: &str, family: &str, workspace_id: Option<&str>) -> Result<DatasetRow, String> {
    let (collected, negatives) = collect(conn, workspace_id).map_err(|e| e.to_string())?;
    if collected.len() < MINIMUM {
        return Err(format!(
            "only {} approved examples — approve at least {MINIMUM} kept answers in a workspace that allows training",
            collected.len()
        ));
    }
    let sources: Vec<String> = collected.iter().map(|(id, _)| id.clone()).collect();
    let (train, valid, test) = split(collected.into_iter().map(|(_, e)| e).collect());
    let id = uuid::Uuid::new_v4().to_string();
    let dir: PathBuf = root.join("datasets").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (file, part) in [("train.jsonl", &train), ("valid.jsonl", &valid), ("test.jsonl", &test)] {
        std::fs::write(dir.join(file), jsonl(part)).map_err(|e| e.to_string())?;
    }
    let total = train.len() + valid.len() + test.len();
    let manifest = serde_json::json!({
        "format": 1,
        "name": name,
        "family": family,
        "workspace": workspace_id,
        "examples": total,
        "train": train.len(),
        "valid": valid.len(),
        "test": test.len(),
        "negativesSeen": negatives,
        "meaningful": total >= MEANINGFUL,
        "sources": sources,
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
    let created_at = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO ai_datasets (id, name, family, path, train_count, valid_count, test_count, manifest, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, name, family, dir.to_string_lossy(), train.len() as i64, valid.len() as i64, test.len() as i64, manifest.to_string(), created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(DatasetRow {
        id,
        name: name.to_string(),
        family: family.to_string(),
        path: dir.to_string_lossy().to_string(),
        train_count: train.len() as i64,
        valid_count: valid.len() as i64,
        test_count: test.len() as i64,
        manifest,
        created_at,
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<DatasetRow>> {
    let mut stmt = conn.prepare("SELECT id, name, family, path, train_count, valid_count, test_count, manifest, created_at FROM ai_datasets ORDER BY created_at DESC")?;
    let rows = stmt
        .query_map([], |r| {
            let manifest: String = r.get(7)?;
            Ok(DatasetRow {
                id: r.get(0)?,
                name: r.get(1)?,
                family: r.get(2)?,
                path: r.get(3)?,
                train_count: r.get(4)?,
                valid_count: r.get(5)?,
                test_count: r.get(6)?,
                manifest: serde_json::from_str(&manifest).unwrap_or(serde_json::Value::Null),
                created_at: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<DatasetRow>> {
    Ok(list(conn)?.into_iter().find(|d| d.id == id))
}

/// Deletes a dataset's row and its files.
pub fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    if let Some(row) = get(conn, id).map_err(|e| e.to_string())? {
        let _ = std::fs::remove_dir_all(&row.path);
    }
    conn.execute("DELETE FROM ai_datasets WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);
             CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE activity_log (id TEXT PRIMARY KEY, question TEXT, answer TEXT, checkpoint TEXT, is_error INTEGER DEFAULT 0);
             INSERT INTO workspaces VALUES ('w1');",
        )
        .unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        crate::experiences::set_training_allowed(&conn, "w1", true).unwrap();
        conn
    }

    fn approve(conn: &Connection, id: &str) {
        crate::experiences::set_quality(conn, id, "approved").unwrap();
    }

    #[test]
    fn kept_turns_become_examples_and_reverted_ones_do_not() {
        let conn = db();
        for i in 0..6 {
            conn.execute(
                "INSERT INTO activity_log (id, question, answer, checkpoint) VALUES (?1, ?2, ?3, ?4)",
                params![format!("a{i}"), format!("pregunta número {i} sobre el carrito"), format!("respuesta {i}"), format!("{{\"id\":\"cp{i}\",\"paths\":[\"x\"]}}")],
            )
            .unwrap();
            let id = crate::experiences::record(
                &conn,
                crate::experiences::NewExperience {
                    workspace_id: Some("w1".into()),
                    source: Some(crate::experiences::Source::TurnReview),
                    signal: Some(if i == 5 { crate::experiences::Signal::Reverted } else { crate::experiences::Signal::Accepted }),
                    run_ref: Some(format!("checkpoint:cp{i}")),
                    detail: serde_json::json!({ "hunk": i }),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
            approve(&conn, &id);
        }
        // Not approved: never used.
        crate::experiences::record(
            &conn,
            crate::experiences::NewExperience {
                workspace_id: Some("w1".into()),
                source: Some(crate::experiences::Source::ApplyCode),
                prompt: Some("p".into()),
                response: Some("r".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let (examples, negatives) = collect(&conn, Some("w1")).unwrap();
        assert_eq!(examples.len(), 5);
        assert_eq!(negatives, 1);
        assert!(examples[0].1.prompt.contains("pregunta"));

        let root = std::env::temp_dir().join(format!("codeflow-ds-{}", uuid::Uuid::new_v4()));
        let row = build(&conn, &root, "test", "qwen", Some("w1")).unwrap();
        assert_eq!(row.train_count + row.valid_count + row.test_count, 5);
        assert!(row.valid_count >= 1 && row.test_count >= 1 && row.train_count >= 1);
        let train = std::fs::read_to_string(PathBuf::from(&row.path).join("train.jsonl")).unwrap();
        let first: serde_json::Value = serde_json::from_str(train.lines().next().unwrap()).unwrap();
        assert_eq!(first["messages"][2]["role"], "assistant");
        assert_eq!(row.manifest["meaningful"], false);
        assert_eq!(list(&conn).unwrap().len(), 1);
        delete(&conn, &row.id).unwrap();
        assert!(!PathBuf::from(&row.path).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn too_few_examples_is_said_not_trained() {
        let conn = db();
        let err = build(&conn, &std::env::temp_dir(), "x", "qwen", None).unwrap_err();
        assert!(err.contains("only 0"));
    }

    #[test]
    fn near_duplicates_land_on_the_same_side() {
        assert_eq!(split_of("Fix the cart total"), split_of("fix   the CART total"));
    }
}
