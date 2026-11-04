//! The workspace-wide limit on agent turns running at once, overall and per model.
//!
//! A team's own `max_parallel` caps one run; nothing capped them together, so three runs of four
//! each could start twelve Opus turns at once and burn a plan's window in minutes. The runner asks
//! here before every headless turn. A claim takes no more items than there are free slots, so an
//! item is only marked running when it can actually start; per-model caps then make a turn wait its
//! turn here rather than being refused.
//!
//! Configuration is one settings row, `agents_governor`: `{"max_turns": 6, "per_model": {"<model>": n}}`.
//! Interactive turns the user types are not counted: a person waiting on an answer is never queued
//! behind a background run.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::db::{queries, Db};

pub const SETTING_KEY: &str = "agents_governor";
pub const DEFAULT_MAX_TURNS: i64 = 6;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Config {
    pub max_turns: i64,
    pub per_model: HashMap<String, i64>,
}

impl Default for Config {
    fn default() -> Self {
        Self { max_turns: DEFAULT_MAX_TURNS, per_model: HashMap::new() }
    }
}

impl Config {
    pub fn sane(mut self) -> Self {
        self.max_turns = self.max_turns.clamp(1, 32);
        self.per_model.retain(|model, cap| !model.trim().is_empty() && *cap > 0);
        for cap in self.per_model.values_mut() {
            *cap = (*cap).clamp(1, 32);
        }
        self
    }

    /// The cap for a model: an exact entry, else one whose key the model id starts with
    /// (`claude-opus` caps every Opus), else none beyond the total.
    pub fn cap_for(&self, model: &str) -> Option<i64> {
        if let Some(cap) = self.per_model.get(model) {
            return Some(*cap);
        }
        self.per_model.iter().filter(|(key, _)| model.starts_with(key.as_str())).map(|(_, cap)| *cap).min()
    }
}

pub fn read_config(conn: &rusqlite::Connection) -> Config {
    queries::get_setting(conn, SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Config>(&raw).ok())
        .unwrap_or_default()
        .sane()
}

#[derive(Default)]
struct Counts {
    total: i64,
    by_model: HashMap<String, i64>,
    waiting: i64,
}

static COUNTS: LazyLock<Mutex<Counts>> = LazyLock::new(Default::default);
static FREED: LazyLock<Notify> = LazyLock::new(Notify::new);

fn counts() -> std::sync::MutexGuard<'static, Counts> {
    COUNTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether a turn on `model` may start now under `config`, given what runs.
pub fn admits(config: &Config, total: i64, on_model: i64, model: &str) -> bool {
    total < config.max_turns && config.cap_for(model).map(|cap| on_model < cap).unwrap_or(true)
}

/// Slots free overall right now — how many items a claim may take.
pub fn free_slots(db: &Db) -> usize {
    let config = db.0.lock().map(|c| read_config(&c)).unwrap_or_default();
    let used = counts().total;
    (config.max_turns - used).max(0) as usize
}

/// A held slot; dropping it frees the slot and wakes whoever waits.
pub struct Permit {
    app: AppHandle,
    model: String,
}

impl Drop for Permit {
    fn drop(&mut self) {
        {
            let mut c = counts();
            c.total = (c.total - 1).max(0);
            if let Some(n) = c.by_model.get_mut(&self.model) {
                *n = (*n - 1).max(0);
            }
        }
        FREED.notify_waiters();
        let _ = self.app.emit("runner:slots", status_now(&self.app));
        // A freed slot may be what another run was waiting for: move every running run.
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let ids: Vec<String> = {
                let db = app.state::<Db>();
                let conn = db.0.lock();
                conn.ok()
                    .and_then(|c| {
                        let mut stmt = c.prepare("SELECT id FROM agent_team_runs WHERE status = 'running'").ok()?;
                        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).ok()?;
                        Some(rows.filter_map(Result::ok).collect())
                    })
                    .unwrap_or_default()
            };
            for id in ids {
                super::kick(&app, &id);
            }
        });
    }
}

/// Waits for a slot for a turn on `model`.
pub async fn acquire(app: &AppHandle, model: &str) -> Permit {
    let mut announced = false;
    loop {
        let notified = FREED.notified();
        let config = {
            let db = app.state::<Db>();
            let config = db.0.lock().map(|c| read_config(&c)).unwrap_or_default();
            config
        };
        {
            let mut c = counts();
            let on_model = c.by_model.get(model).copied().unwrap_or(0);
            if admits(&config, c.total, on_model, model) {
                c.total += 1;
                *c.by_model.entry(model.to_string()).or_default() += 1;
                if announced {
                    c.waiting = (c.waiting - 1).max(0);
                }
                drop(c);
                let _ = app.emit("runner:slots", status_now(app));
                return Permit { app: app.clone(), model: model.to_string() };
            }
            if !announced {
                c.waiting += 1;
                announced = true;
            }
        }
        let _ = app.emit("runner:slots", status_now(app));
        notified.await;
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub max_turns: i64,
    pub running: i64,
    pub waiting: i64,
    pub by_model: HashMap<String, i64>,
    pub per_model: HashMap<String, i64>,
}

fn status_now(app: &AppHandle) -> Status {
    let config = {
        let db = app.state::<Db>();
        let config = db.0.lock().map(|c| read_config(&c)).unwrap_or_default();
        config
    };
    let c = counts();
    Status { max_turns: config.max_turns, running: c.total, waiting: c.waiting, by_model: c.by_model.clone(), per_model: config.per_model }
}

#[tauri::command]
pub fn governor_status(app: AppHandle) -> Status {
    status_now(&app)
}

#[tauri::command]
pub fn governor_set(app: AppHandle, db: tauri::State<'_, Db>, config: Config) -> Result<Status, String> {
    let config = config.sane();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, SETTING_KEY, &serde_json::to_string(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    FREED.notify_waiters();
    let status = status_now(&app);
    let _ = app.emit("runner:slots", status.clone());
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_overall_and_per_model() {
        let config = Config { max_turns: 3, per_model: HashMap::from([("claude-opus".to_string(), 1)]) }.sane();
        assert!(admits(&config, 0, 0, "claude-opus-5-5"));
        assert!(!admits(&config, 1, 1, "claude-opus-5-5"));
        assert!(admits(&config, 1, 0, "claude-sonnet-5-5"));
        assert!(!admits(&config, 3, 0, "claude-sonnet-5-5"));
    }

    #[test]
    fn sane_clamps_and_drops_blank_models() {
        let config = Config { max_turns: 0, per_model: HashMap::from([(" ".to_string(), 2), ("m".to_string(), 99)]) }.sane();
        assert_eq!(config.max_turns, 1);
        assert_eq!(config.per_model.len(), 1);
        assert_eq!(config.per_model["m"], 32);
    }
}
