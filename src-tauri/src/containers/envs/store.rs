//! The environments this machine has, one row each in `container_envs`.
//!
//! Machine-local, and kept out of backups (`backup::snapshot::NEVER_BACKED_UP`): every row names a
//! worktree on this disk and containers of this machine's engine. Restored elsewhere it would be a
//! list of folders and projects that are not there.
//!
//! The row holds what was decided — branch, checkout, project name, offset, configuration — and
//! the port map last planned. Whether anything runs is never stored: it is read from the engine
//! each time the list is shown.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::plan::{EnvWarning, PortBinding};

/// How an environment is brought up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EnvConfig {
    /// A Compose stack: its folder and files, relative to the repository root.
    #[serde(rename_all = "camelCase")]
    Compose { dir: String, files: Vec<String> },
    /// A `devcontainer.json`, relative to the repository root, run by the Dev Containers CLI
    /// (`cli`) or directly with the engine (`direct`).
    #[serde(rename_all = "camelCase")]
    Devcontainer {
        config: String,
        mode: String,
        /// Run directly although the file asks for `features` — ticked by the user in the create
        /// dialog; without it a direct run of such a file is refused.
        #[serde(default)]
        without_features: bool,
        /// The `initializeCommand` the user saw and agreed to run on this computer, word for word.
        /// The branch's file is compared with it before each start: a different command is not run
        /// until it is approved again.
        #[serde(default)]
        approved_init: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvRecord {
    pub id: String,
    pub project_id: String,
    pub repo_name: String,
    pub repo_path: String,
    pub branch: String,
    /// The branch it was started from, when this environment made the branch.
    pub base: String,
    pub worktree_path: String,
    /// The checkout was made for this environment — only then may removing it delete it.
    pub worktree_created: bool,
    pub compose_project: String,
    pub port_offset: u16,
    pub runtime: String,
    pub context: Option<String>,
    pub config: EnvConfig,
    pub ports: Vec<PortBinding>,
    pub warnings: Vec<EnvWarning>,
    pub copied_files: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS container_envs (
            id               TEXT PRIMARY KEY,
            project_id       TEXT NOT NULL,
            repo_name        TEXT NOT NULL,
            repo_path        TEXT NOT NULL,
            branch           TEXT NOT NULL,
            base             TEXT NOT NULL DEFAULT '',
            worktree_path    TEXT NOT NULL,
            worktree_created INTEGER NOT NULL DEFAULT 0,
            compose_project  TEXT NOT NULL UNIQUE,
            port_offset      INTEGER NOT NULL DEFAULT 0,
            runtime          TEXT NOT NULL,
            context          TEXT,
            config           TEXT NOT NULL,
            ports            TEXT NOT NULL DEFAULT '[]',
            warnings         TEXT NOT NULL DEFAULT '[]',
            copied_files     TEXT NOT NULL DEFAULT '[]',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_container_envs_project ON container_envs(project_id);",
    )
}

const COLUMNS: &str = "id, project_id, repo_name, repo_path, branch, base, worktree_path, worktree_created, compose_project, port_offset, runtime, context, config, ports, warnings, copied_files, created_at, updated_at";

fn json<T: serde::de::DeserializeOwned + Default>(text: String) -> T {
    serde_json::from_str(&text).unwrap_or_default()
}

fn from_row(row: &Row) -> rusqlite::Result<EnvRecord> {
    let config_text: String = row.get(12)?;
    let config = serde_json::from_str(&config_text).map_err(|e| rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, Box::new(e)))?;
    Ok(EnvRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        repo_name: row.get(2)?,
        repo_path: row.get(3)?,
        branch: row.get(4)?,
        base: row.get(5)?,
        worktree_path: row.get(6)?,
        worktree_created: row.get::<_, i64>(7)? != 0,
        compose_project: row.get(8)?,
        port_offset: row.get::<_, i64>(9)?.clamp(0, u16::MAX as i64) as u16,
        runtime: row.get(10)?,
        context: row.get(11)?,
        config,
        ports: json(row.get(13)?),
        warnings: json(row.get(14)?),
        copied_files: json(row.get(15)?),
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn text<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".into())
}

pub fn insert(conn: &Connection, env: &EnvRecord) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO container_envs ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"),
        params![
            env.id,
            env.project_id,
            env.repo_name,
            env.repo_path,
            env.branch,
            env.base,
            env.worktree_path,
            env.worktree_created as i64,
            env.compose_project,
            env.port_offset as i64,
            env.runtime,
            env.context,
            text(&env.config),
            text(&env.ports),
            text(&env.warnings),
            text(&env.copied_files),
            env.created_at,
            env.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<EnvRecord>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM container_envs WHERE id = ?1"), params![id], from_row).optional()
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<EnvRecord>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM container_envs ORDER BY repo_name, created_at"))?;
    let rows = stmt.query_map([], from_row)?;
    rows.collect()
}

/// The port map and the warnings of the last plan.
pub fn set_plan(conn: &Connection, id: &str, ports: &[PortBinding], warnings: &[EnvWarning], now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE container_envs SET ports = ?2, warnings = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, text(&ports), text(&warnings), now],
    )?;
    Ok(())
}

/// The configuration, changed after creation (an `initializeCommand` approved again).
pub fn set_config(conn: &Connection, id: &str, config: &EnvConfig, now: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE container_envs SET config = ?2, updated_at = ?3 WHERE id = ?1", params![id, text(config), now])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM container_envs WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn project_name_taken(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT COUNT(*) FROM container_envs WHERE compose_project = ?1", params![name], |r| r.get::<_, i64>(0)).map(|n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_round_trips() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let env = EnvRecord {
            id: "e1".into(),
            project_id: "p1".into(),
            repo_name: "shop".into(),
            repo_path: "/r/shop".into(),
            branch: "feature/pay".into(),
            base: "main".into(),
            worktree_path: "/w/shop/env-feature-pay".into(),
            worktree_created: true,
            compose_project: "shop-feature-pay".into(),
            port_offset: 100,
            runtime: "docker".into(),
            context: Some("orbstack".into()),
            config: EnvConfig::Compose { dir: String::new(), files: vec!["compose.yaml".into()] },
            ports: vec![],
            warnings: vec![],
            copied_files: vec![".env".into()],
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        insert(&conn, &env).unwrap();
        assert_eq!(get(&conn, "e1").unwrap().as_ref(), Some(&env));
        assert!(project_name_taken(&conn, "shop-feature-pay").unwrap());
        assert!(insert(&conn, &EnvRecord { id: "e2".into(), ..env.clone() }).is_err(), "one project name, one environment");
        let port = PortBinding { service: "web".into(), target: 80, protocol: "tcp".into(), host_ip: String::new(), base: Some(8080), host: Some(8180), host_end: None };
        set_plan(&conn, "e1", &[port.clone()], &[EnvWarning::new("sharedVolume", "x")], "t2").unwrap();
        let read = get(&conn, "e1").unwrap().unwrap();
        assert_eq!(read.ports, vec![port]);
        assert_eq!(read.updated_at, "t2");
        assert_eq!(list(&conn).unwrap().len(), 1);
        let dev = EnvConfig::Devcontainer { config: ".devcontainer/devcontainer.json".into(), mode: "direct".into(), without_features: true, approved_init: vec!["make prep".into()] };
        set_config(&conn, "e1", &dev, "t3").unwrap();
        assert_eq!(get(&conn, "e1").unwrap().unwrap().config, dev);
        // A row written before the two choices existed still reads.
        let old: EnvConfig = serde_json::from_str(r#"{"kind":"devcontainer","config":"x.json","mode":"cli"}"#).unwrap();
        assert_eq!(old, EnvConfig::Devcontainer { config: "x.json".into(), mode: "cli".into(), without_features: false, approved_init: vec![] });
        delete(&conn, "e1").unwrap();
        assert!(get(&conn, "e1").unwrap().is_none());
    }
}
