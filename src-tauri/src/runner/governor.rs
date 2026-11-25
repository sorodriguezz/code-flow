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
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::host::{AppHost, Host};
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

/// The slots themselves: who holds one, who waits, and the bell that rings when one frees. One for
/// the app ([`SLOTS`]); a test makes its own, so two tests never count each other's turns.
#[derive(Default)]
pub struct Slots {
    counts: Mutex<Counts>,
    freed: Notify,
}

impl Slots {
    fn counts(&self) -> std::sync::MutexGuard<'_, Counts> {
        self.counts.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn running(&self) -> i64 {
        self.counts().total
    }

    pub fn waiting(&self) -> i64 {
        self.counts().waiting
    }

    /// Waits for a slot for a turn on `model`, or for `cancel` — whichever comes first. `false` is
    /// a wait that was called off: nothing was taken and nothing is owed. `changed` is called every
    /// time the counts move, so whoever draws them can.
    pub async fn take(&self, config: impl Fn() -> Config, model: &str, cancel: &CancellationToken, changed: impl Fn()) -> bool {
        let mut announced = false;
        loop {
            // Armed before the look, so a slot freed between the look and the wait still rings.
            let notified = self.freed.notified();
            if cancel.is_cancelled() {
                if announced {
                    let mut c = self.counts();
                    c.waiting = (c.waiting - 1).max(0);
                }
                changed();
                return false;
            }
            {
                let config = config();
                let mut c = self.counts();
                let on_model = c.by_model.get(model).copied().unwrap_or(0);
                if admits(&config, c.total, on_model, model) {
                    c.total += 1;
                    *c.by_model.entry(model.to_string()).or_default() += 1;
                    if announced {
                        c.waiting = (c.waiting - 1).max(0);
                    }
                    drop(c);
                    changed();
                    return true;
                }
                if !announced {
                    c.waiting += 1;
                    announced = true;
                }
            }
            changed();
            tokio::select! {
                _ = notified => {}
                _ = cancel.cancelled() => {}
            }
        }
    }

    /// Gives a slot back and wakes whoever waits.
    pub fn release(&self, model: &str) {
        {
            let mut c = self.counts();
            c.total = (c.total - 1).max(0);
            if let Some(n) = c.by_model.get_mut(model) {
                *n = (*n - 1).max(0);
            }
        }
        self.freed.notify_waiters();
    }

    /// A change of configuration may have made room: everyone waiting looks again.
    pub fn wake(&self) {
        self.freed.notify_waiters();
    }
}

static SLOTS: LazyLock<Slots> = LazyLock::new(Slots::default);

/// The app's own slots.
pub fn app_slots() -> &'static Slots {
    &SLOTS
}

/// Whether a turn on `model` may start now under `config`, given what runs.
pub fn admits(config: &Config, total: i64, on_model: i64, model: &str) -> bool {
    total < config.max_turns && config.cap_for(model).map(|cap| on_model < cap).unwrap_or(true)
}

/// Slots free overall right now — how many items a claim may take.
pub fn free_slots(db: &Db, slots: &Slots) -> usize {
    let config = db.0.lock().map(|c| read_config(&c)).unwrap_or_default();
    // Turns already waiting for a slot are ahead of anything a new claim would add: counting them
    // keeps two runs that look at the same free slot from both marking an item as theirs.
    let used = slots.running() + slots.waiting();
    (config.max_turns - used).max(0) as usize
}

/// A held slot; dropping it frees the slot and wakes whoever waits.
pub struct Permit<H: Host> {
    host: H,
    model: String,
}

impl<H: Host> Drop for Permit<H> {
    fn drop(&mut self) {
        self.host.slots().release(&self.model);
        announce(&self.host);
        // A freed slot may be what another run was waiting for: move every running run.
        let host = self.host.clone();
        tauri::async_runtime::spawn(async move {
            let ids: Vec<String> = {
                let conn = host.db().0.lock();
                conn.ok()
                    .and_then(|c| {
                        let mut stmt = c.prepare("SELECT id FROM agent_team_runs WHERE status = 'running'").ok()?;
                        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).ok()?;
                        Some(rows.filter_map(Result::ok).collect())
                    })
                    .unwrap_or_default()
            };
            for id in ids {
                super::kick_on(&host, &id);
            }
        });
    }
}

fn announce<H: Host>(host: &H) {
    host.emit("runner:slots", serde_json::to_value(status_of(host)).unwrap_or_default());
}

/// Waits for a slot for a turn on `model`. `None` when `cancel` fired first: the turn was called
/// off while it queued — an abort, a deleted run — and must not start.
pub async fn acquire_on<H: Host>(host: &H, model: &str, cancel: &CancellationToken) -> Option<Permit<H>> {
    let config = || host.db().0.lock().map(|c| read_config(&c)).unwrap_or_default();
    let changed = || announce(host);
    host.slots().take(config, model, cancel, changed).await.then(|| Permit { host: host.clone(), model: model.to_string() })
}

/// [`acquire_on`] for the app.
pub async fn acquire(app: &AppHandle, model: &str, cancel: &CancellationToken) -> Option<Permit<AppHost>> {
    acquire_on(&AppHost(app.clone()), model, cancel).await
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub max_turns: i64,
    pub running: i64,
    pub waiting: i64,
    pub by_model: HashMap<String, i64>,
    pub per_model: HashMap<String, i64>,
}

fn status_of<H: Host>(host: &H) -> Status {
    let config = host.db().0.lock().map(|c| read_config(&c)).unwrap_or_default();
    let c = host.slots().counts();
    Status { max_turns: config.max_turns, running: c.total, waiting: c.waiting, by_model: c.by_model.clone(), per_model: config.per_model }
}

#[tauri::command]
pub fn governor_status(app: AppHandle) -> Status {
    status_of(&AppHost(app))
}

#[tauri::command]
pub fn governor_set(app: AppHandle, db: tauri::State<'_, Db>, config: Config) -> Result<Status, String> {
    let config = config.sane();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, SETTING_KEY, &serde_json::to_string(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    SLOTS.wake();
    let host = AppHost(app);
    announce(&host);
    Ok(status_of(&host))
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

    #[tokio::test]
    async fn a_turn_called_off_while_it_queues_takes_no_slot() {
        let slots = std::sync::Arc::new(Slots::default());
        let config = || Config { max_turns: 1, per_model: HashMap::new() };
        let never = CancellationToken::new();
        assert!(slots.take(config, "m", &never, || {}).await, "the first turn gets the only slot");

        // The second one queues behind it…
        let cancel = CancellationToken::new();
        let waiter = {
            let (slots, cancel) = (slots.clone(), cancel.clone());
            tokio::spawn(async move { slots.take(config, "m", &cancel, || {}).await })
        };
        while slots.waiting() == 0 {
            tokio::task::yield_now().await;
        }
        // …and is called off there: it never starts, and leaves nothing behind.
        cancel.cancel();
        assert!(!waiter.await.unwrap());
        assert_eq!((slots.running(), slots.waiting()), (1, 0));

        // A freed slot goes to whoever still waits.
        let next = {
            let slots = slots.clone();
            tokio::spawn(async move { slots.take(config, "m", &CancellationToken::new(), || {}).await })
        };
        while slots.waiting() == 0 {
            tokio::task::yield_now().await;
        }
        slots.release("m");
        assert!(next.await.unwrap());
        assert_eq!((slots.running(), slots.waiting()), (1, 0));
    }

    #[test]
    fn sane_clamps_and_drops_blank_models() {
        let config = Config { max_turns: 0, per_model: HashMap::from([(" ".to_string(), 2), ("m".to_string(), 99)]) }.sane();
        assert_eq!(config.max_turns, 1);
        assert_eq!(config.per_model.len(), 1);
        assert_eq!(config.per_model["m"], 32);
    }
}
