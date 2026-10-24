//! Which advisories the user has already been told about, so the daily check only speaks up for a
//! new one (user, 2026-10-23: «Aviso cuando sale una vulnerabilidad nueva en algo que usas»).
//!
//! A repository's first look — by an analysis or by the daily check — is absorbed silently: every
//! advisory it already had is old news to someone who has not been warned about anything yet, and a
//! first check that rang forty times would teach the user to mute the source.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Seen {
    /// Repositories looked at at least once.
    pub projects: HashSet<String>,
    /// `project|ecosystem|package|advisory`.
    pub keys: HashSet<String>,
    /// When the daily check last ran (Unix ms).
    pub last_check: i64,
}

pub fn key(project_id: &str, ecosystem: &str, package: &str, advisory: &str) -> String {
    format!("{project_id}|{ecosystem}|{package}|{advisory}")
}

impl Seen {
    /// Records `keys` for `project_id` and returns the ones that are news. Pure.
    pub fn absorb(&mut self, project_id: &str, keys: impl IntoIterator<Item = String>) -> Vec<String> {
        let first = self.projects.insert(project_id.to_string());
        let mut fresh = Vec::new();
        for k in keys {
            if self.keys.insert(k.clone()) && !first {
                fresh.push(k);
            }
        }
        fresh
    }
}

fn path() -> PathBuf {
    crate::paths::state_dir().join("deps").join("seen-advisories.json")
}

pub fn load() -> Seen {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(seen: &Seen) {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(seen) {
        let _ = std::fs::write(p, bytes);
    }
}

/// Once a day.
pub const INTERVAL_MS: i64 = 24 * 3_600_000;

pub fn due(seen: &Seen, now: i64) -> bool {
    now - seen.last_check >= INTERVAL_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_look_is_silent_and_later_ones_report_only_news() {
        let mut seen = Seen::default();
        assert!(seen.absorb("p1", [key("p1", "npm", "a", "GHSA-1")]).is_empty());
        assert!(seen.absorb("p1", [key("p1", "npm", "a", "GHSA-1")]).is_empty());
        assert_eq!(seen.absorb("p1", [key("p1", "npm", "a", "GHSA-1"), key("p1", "npm", "a", "GHSA-2")]), vec![key("p1", "npm", "a", "GHSA-2")]);
        // Another repository's first look is its own.
        assert!(seen.absorb("p2", [key("p2", "npm", "a", "GHSA-2")]).is_empty());
    }

    #[test]
    fn runs_once_a_day() {
        let seen = Seen { last_check: 1_000, ..Default::default() };
        assert!(!due(&seen, 1_000 + INTERVAL_MS - 1));
        assert!(due(&seen, 1_000 + INTERVAL_MS));
    }
}
