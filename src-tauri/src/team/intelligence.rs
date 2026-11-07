use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{Item, MemberSnap, Run};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ItemIntelligence {
    pub paths: Vec<String>,
    pub criteria: Vec<String>,
    pub evidence: Vec<Evidence>,
    pub base_sha: String,
    pub recovery: Option<Recovery>,
    pub substitute: Option<String>,
    pub amendment: Option<super::coordination::Amendment>,
    pub contract_specs: Vec<super::coordination::ContractSpec>,
    pub requires_contracts: Vec<String>,
    pub published_contracts: Vec<super::coordination::Contract>,
    pub used_contracts: BTreeMap<String, String>,
    pub failure_fingerprint: String,
    pub impact: Option<super::coordination::Impact>,
    pub approved_impact: String,
    pub execution: Option<super::coordination::Execution>,
    pub quota_events: Vec<super::coordination::Execution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub label: String,
    pub result: String,
    pub detail: String,
}

pub fn reported_evidence(criteria: &[String], reply: &str) -> Vec<Evidence> {
    if criteria.is_empty() {
        return Vec::new();
    }
    let (blocks, _) = super::protocol::blocks(reply);
    let reports: Vec<_> = blocks.iter().filter_map(|b| b.get("verificacion").and_then(|v| v.as_array()))
        .flatten().collect();
    criteria.iter().enumerate().map(|(index, label)| {
        let detail = reports.iter().find(|r| r.get("criterio").and_then(|n| n.as_u64()) == Some((index + 1) as u64))
            .and_then(|r| r.get("evidencia").and_then(|v| v.as_str())).unwrap_or("").trim().chars().take(1200).collect::<String>();
        Evidence { label: label.clone(), result: if detail.is_empty() { "unverified" } else { "reported" }.into(), detail }
    }).collect()
}

pub fn repository_check(root: &std::path::Path) -> Option<&'static str> {
    let manifest = |name| std::fs::read_to_string(root.join(name)).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    if let Some(package) = manifest("package.json") {
        let test = package["scripts"]["test"].as_str().unwrap_or_default();
        if !test.trim().is_empty() && !test.contains("no test specified") {
            let manager = package["packageManager"].as_str().and_then(|value| value.split('@').next());
            return Some(match manager {
                Some("pnpm") => "pnpm test",
                Some("yarn") => "yarn test",
                Some("bun") => "bun run test",
                Some("npm") => "npm test",
                _ if root.join("pnpm-lock.yaml").is_file() => "pnpm test",
                _ if root.join("yarn.lock").is_file() => "yarn test",
                _ if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() => "bun run test",
                _ => "npm test",
            });
        }
    }
    if root.join("Cargo.toml").is_file() {
        return Some(if root.join("Cargo.lock").is_file() { "cargo test --locked" } else { "cargo test" });
    }
    if root.join("pom.xml").is_file() {
        return Some(if cfg!(windows) && root.join("mvnw.cmd").is_file() {
            "mvnw.cmd test"
        } else if !cfg!(windows) && root.join("mvnw").is_file() {
            "./mvnw test"
        } else {
            "mvn test"
        });
    }
    if root.join("pytest.ini").is_file()
        || std::fs::read_to_string(root.join("pyproject.toml")).is_ok_and(|text| text.contains("[tool.pytest"))
    {
        return Some(if cfg!(windows) { "python -m pytest" } else { "python3 -m pytest" });
    }
    if manifest("composer.json").is_some_and(|value| !value["scripts"]["test"].is_null()) {
        return Some("composer test");
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recovery {
    pub kind: crate::ai::AiFailureKind,
    pub provider: String,
    pub model: String,
    pub resume_at: Option<i64>,
    #[serde(default)]
    pub account_key: String,
    #[serde(default)]
    pub shared_quota: bool,
}

pub fn executor<'a>(run: &'a Run, item: &Item) -> Option<&'a MemberSnap> {
    let id = item.intelligence.substitute.as_deref().unwrap_or(&item.member_id);
    run.members.iter().find(|m| m.member.id == id)
}

pub fn model<'a>(member: &'a MemberSnap, item: &'a Item) -> &'a str {
    if item.model.is_empty() { &member.model } else { &item.model }
}

pub fn account_key(conn: &Connection, run: &Run, member: &MemberSnap) -> String {
    crate::ai_accounts::resolve(conn, &member.provider, Some("chat"), Some(&run.workspace_id),
        crate::ai_accounts::Choice::parse(member.account_id.as_deref())).key()
}

pub fn blocked_by(conn: &Connection, run: &Run, item: &Item, recovery: &Recovery) -> bool {
    use crate::ai::AiFailureKind;
    let Some(member) = executor(run, item) else { return false };
    if member.provider != recovery.provider {
        return false;
    }
    if recovery.kind == AiFailureKind::CliMissing {
        return true;
    }
    account_key(conn, run, member) == recovery.account_key
        && (recovery.kind == AiFailureKind::AuthRequired || recovery.shared_quota || model(member, item) == recovery.model)
}

pub fn quota_reset(account: &str, provider: &str, model: &str, now: i64) -> (Option<i64>, bool) {
    let mut latest = None;
    let mut shared = false;
    for quota in crate::ai_quota::cached_readings().into_iter().filter(|q| {
        q.provider == provider && q.account_id.as_deref().map_or_else(|| q.provider.clone(), |id| format!("{}|{id}", q.provider)) == account
    }) {
        for limit in quota.limits.iter().filter(|l| l.used_percent >= 100.0) {
            let shared_window = limit.kind != "model" && limit.scope.is_empty();
            if !shared_window && limit.scope != model {
                continue;
            }
            if let Some(at) = chrono::DateTime::parse_from_rfc3339(&limit.resets_at).ok().map(|at| at.timestamp()).filter(|at| *at > now) {
                latest = latest.max(Some(at));
                shared |= shared_window;
            }
        }
    }
    if provider == "claude" {
        if let Some((limit, _)) = crate::claude::last_rate_limit(account) {
            for (percent, at) in [(limit.five_hour_pct, limit.five_hour_resets_at), (limit.seven_day_pct, limit.seven_day_resets_at)] {
                if percent >= 100.0 && at > now {
                    latest = latest.max(Some(at));
                    shared = true;
                }
            }
        }
    }
    (latest, shared)
}

pub fn stated_reset(failure: &crate::ai::AiFailure, now: i64) -> Option<i64> {
    use chrono::{TimeZone, Utc};
    if let Some(at) = failure.resets_at {
        return (at > now).then_some(at);
    }
    let phrase = failure.resets.as_deref()?.trim();
    if let Some(duration) = phrase.strip_prefix("in ") {
        let parts: Vec<_> = duration.split_whitespace().collect();
        if parts.is_empty() || parts.len() % 2 != 0 {
            return None;
        }
        let mut seconds = 0i64;
        for pair in parts.chunks_exact(2) {
            let amount: i64 = pair[0].parse().ok()?;
            let unit = match pair[1] {
                "day" | "days" => 86_400,
                "hour" | "hours" => 3_600,
                "minute" | "minutes" => 60,
                "second" | "seconds" => 1,
                _ => return None,
            };
            if amount < 0 {
                return None;
            }
            seconds = seconds.checked_add(amount.checked_mul(unit)?)?;
        }
        return (seconds > 0).then(|| now.checked_add(seconds)).flatten();
    }
    // A clock without an explicit zone (or an ambiguous daylight-saving instant) is manual.
    let (clock, zone) = phrase.strip_suffix(')')?.rsplit_once(" (")?;
    let zone: chrono_tz::Tz = zone.parse().ok()?;
    let clock = clock.trim().to_ascii_lowercase();
    let clock = match clock.len() {
        3 | 4 if clock.ends_with("am") || clock.ends_with("pm") => {
            let (hour, half) = clock.split_at(clock.len() - 2);
            format!("{hour}:00{half}")
        }
        _ => clock,
    };
    let time = chrono::NaiveTime::parse_from_str(&clock, "%I:%M%P")
        .or_else(|_| chrono::NaiveTime::parse_from_str(&clock, "%H:%M")).ok()?;
    let today = Utc.timestamp_opt(now, 0).single()?.with_timezone(&zone).date_naive();
    let instant = zone.from_local_datetime(&today.and_time(time)).single()?.timestamp();
    if instant > now {
        Some(instant)
    } else {
        zone.from_local_datetime(&today.succ_opt()?.and_time(time)).single().map(|at| at.timestamp())
    }
}

pub fn substitute<'a>(conn: &Connection, run: &'a Run, item: &Item, recovery: &Recovery) -> Option<&'a MemberSnap> {
    if item.intelligence.substitute.is_some() || item.run_in != "headless" {
        return None;
    }
    let original = executor(run, item)?;
    let next = run.members.iter().find(|m| m.member.id == original.member.escalate_to)?;
    let independent = next.provider != original.provider || (recovery.kind != crate::ai::AiFailureKind::CliMissing
        && account_key(conn, run, next) != recovery.account_key);
    let caps = crate::provider_caps::caps_of(&next.provider)?;
    let binary = crate::db::queries::get_setting(conn, &format!("{}_binary_path", next.provider)).ok().flatten()
        .filter(|path| !path.trim().is_empty()).unwrap_or(caps.default_binary);
    let available = caps.in_process || crate::ai::find_on_path(&binary).is_some();
    (independent && !next.member.advisor && next.member.run_in == "headless"
        && (next.member.repos.is_empty() || next.member.repos.contains(&item.project_id))
        && available && caps.agentic
        && if item.writes() && original.member.edits { next.member.edits } else { caps.enforces_read_only })
        .then_some(next)
}

pub fn relative_path(path: &str) -> Option<String> {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() || path.len() > 512 || path.starts_with('/') || path.contains(':') || path.chars().any(char::is_control) {
        return None;
    }
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    (!parts.is_empty() && !parts.contains(&"..")).then(|| parts.join("/"))
}

pub fn portable_text(text: &str, roots: &[&str]) -> String {
    let mut out = text.to_string();
    for root in roots.iter().copied().filter(|root| !root.is_empty()) {
        for spelling in [root.to_string(), root.replace('\\', "/")] {
            for separator in ['/', '\\'] {
                out = out.replace(&format!("{spelling}{separator}"), "");
            }
        }
    }
    out
}

pub fn overlaps(a: &Item, b: &Item) -> bool {
    if a.project_id != b.project_id || !a.writes() || !b.writes() {
        return false;
    }
    a.intelligence.paths.iter().any(|path| {
        let path = path.to_lowercase();
        b.intelligence.paths.iter().any(|other| {
            let other = other.to_lowercase();
            path == other || path.strip_prefix(&other).is_some_and(|rest| rest.starts_with('/'))
                || other.strip_prefix(&path).is_some_and(|rest| rest.starts_with('/'))
        })
    })
}

/// Count distinct pending tasks each task unlocks, including through indirect dependencies.
pub fn downstream(items: &[Item]) -> HashMap<&str, usize> {
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for item in items.iter().filter(|item| item.status == "pending") {
        for dep in &item.depends_on {
            edges.entry(dep).or_default().push(&item.id);
        }
    }
    edges.keys().map(|&id| {
        let mut pending = vec![id];
        let mut seen = HashSet::new();
        seen.insert(id);
        while let Some(next) = pending.pop() {
            for child in edges.get(next).into_iter().flatten().copied() {
                if seen.insert(child) {
                    pending.push(child);
                }
            }
        }
        (id, seen.len() - 1)
    }).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub message_id: String,
    pub run_id: String,
    pub project_id: String,
    pub body: String,
}

fn memory_key(run: &Run) -> String {
    format!("team_memory:{}:{}", run.workspace_id, run.team_id)
}

pub fn memories(conn: &Connection, run: &Run) -> rusqlite::Result<Vec<Memory>> {
    let raw = crate::db::queries::get_setting(conn, &memory_key(run))?;
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default())
}

pub fn set_memory(conn: &Connection, run: &Run, entry: Memory, keep: bool) -> rusqlite::Result<()> {
    let mut entries = memories(conn, run)?;
    entries.retain(|old| old.message_id != entry.message_id || old.project_id != entry.project_id);
    if keep {
        entries.push(entry);
        if entries.len() > 48 {
            entries.remove(0);
        }
    }
    let json = super::json(&entries);
    crate::db::queries::set_setting(conn, &memory_key(run), &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_scopes_are_portable_and_never_escape_the_project() {
        assert_eq!(relative_path(r"src\api\routes.ts").as_deref(), Some("src/api/routes.ts"));
        for path in [r"C:\src\routes.ts", r"\\host\share", "/src/routes.ts", "src/../other"] {
            assert_eq!(relative_path(path), None, "{path}");
        }
        assert_eq!(portable_text(r"See C:\repo\README.md and C:/repo/docs.", &[r"C:\repo"]), "See README.md and docs.");
    }

    #[test]
    fn only_explicitly_reported_criteria_have_evidence() {
        let report = reported_evidence(&["status code".into(), "permission check".into()],
            "Done\n```equipo\n{\"verificacion\":[{\"criterio\":2,\"evidencia\":\"403 for guest\"}]}\n```");
        assert_eq!(report[0].result, "unverified");
        assert_eq!(report[1].result, "reported");
        assert_eq!(report[1].detail, "403 for guest");
    }

    #[test]
    fn agreements_remain_scoped_to_a_team_and_workspace_and_can_be_forgotten() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let run = Run { workspace_id: "workspace".into(), team_id: "team".into(), ..Default::default() };
        let other = Run { workspace_id: "different".into(), ..run.clone() };
        let memory = Memory { message_id: "m".into(), run_id: "source".into(), project_id: "repo".into(), body: "Use the common response shape".into() };
        set_memory(&conn, &run, memory.clone(), true).unwrap();
        assert_eq!(memories(&conn, &run).unwrap()[0].project_id, "repo");
        assert!(memories(&conn, &other).unwrap().is_empty());
        set_memory(&conn, &run, memory, false).unwrap();
        assert!(memories(&conn, &run).unwrap().is_empty());
    }

    #[test]
    fn recovery_respects_the_substitutes_repository_and_engine_capabilities() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let original = MemberSnap {
            member: super::super::Member { id: "lead".into(), escalate_to: "backup".into(), ..Default::default() },
            provider: "claude".into(), model: "sonnet".into(), ..Default::default()
        };
        let backup = MemberSnap {
            member: super::super::Member { id: "backup".into(), repos: vec!["allowed".into()], ..Default::default() },
            provider: "codeflow".into(), model: "local-model".into(), effort: "high".into(), ..Default::default()
        };
        let run = Run { members: vec![original, backup], ..Default::default() };
        let recovery = Recovery {
            kind: crate::ai::AiFailureKind::Quota, provider: "claude".into(), model: "sonnet".into(),
            account_key: "claude".into(), resume_at: None, shared_quota: false,
        };
        let mut item = Item {
            member_id: "lead".into(), project_id: "denied".into(), run_in: "headless".into(), kind: "investigate".into(),
            ..Default::default()
        };
        assert!(substitute(&conn, &run, &item, &recovery).is_none());
        item.project_id = "allowed".into();
        let next = substitute(&conn, &run, &item, &recovery).unwrap();
        assert_eq!((&*next.provider, model(next, &item), &*next.effort), ("codeflow", "local-model", "high"));
    }

    #[test]
    fn uses_provider_stated_relative_times_and_explicit_zones_only() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-07T18:00:00Z").unwrap().timestamp();
        let refused = |phrase: &str| crate::ai::classify_failure(&format!("QUOTA_EXCEEDED::limit reached, resets {phrase}"));
        assert_eq!(stated_reset(&refused("in 2 hours 30 minutes"), now), Some(now + 9000));
        assert_eq!(stated_reset(&refused("4pm (America/Santiago)"), now), Some(now + 3600));
        assert_eq!(stated_reset(&refused("4pm"), now), None);
    }
}
