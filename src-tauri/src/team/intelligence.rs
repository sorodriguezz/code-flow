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

/// The test suites a repository has, read off its manifests and config files: what the user
/// starts from in the team's «Pruebas» tab before saying which run when and which the members
/// write. Each comes with a default the user can change — unit tests and lint after every task
/// (fast, and what the members write), integration once at the end, e2e told to the members only,
/// since it usually needs a browser or a running service. `repo` is left for the caller.
pub fn detect_suites(root: &std::path::Path) -> Vec<super::Check> {
    fn add(out: &mut Vec<super::Check>, kind: &str, label: &str, command: String) {
        if out.iter().any(|c| c.command == command) {
            return;
        }
        let (when, write) = match kind {
            "unit" => ("item", true),
            "lint" => ("item", false),
            "integration" => ("final", false),
            _ => ("agent", false),
        };
        out.push(super::Check { repo: String::new(), command, when: when.into(), kind: kind.into(), label: label.into(), write });
    }
    let mut out: Vec<super::Check> = Vec::new();
    let read_json = |name: &str| std::fs::read_to_string(root.join(name)).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let exists = |name: &str| root.join(name).exists();
    let any_of = |names: &[&str]| names.iter().any(|n| root.join(n).is_file());

    if let Some(package) = read_json("package.json") {
        let manager = package["packageManager"].as_str().and_then(|value| value.split('@').next()).map(str::to_string).unwrap_or_else(|| {
            if exists("pnpm-lock.yaml") { "pnpm" } else if exists("yarn.lock") { "yarn" } else if exists("bun.lock") || exists("bun.lockb") { "bun" } else { "npm" }.to_string()
        });
        let run = |script: &str| match (manager.as_str(), script) {
            ("npm", "test") => "npm test".to_string(),
            ("npm", s) => format!("npm run {s}"),
            ("yarn", s) => format!("yarn {s}"),
            ("bun", s) => format!("bun run {s}"),
            (_, "test") => "pnpm test".to_string(),
            (_, s) => format!("pnpm run {s}"),
        };
        let scripts = package["scripts"].as_object().cloned().unwrap_or_default();
        let has = |name: &str| scripts.get(name).and_then(|v| v.as_str()).is_some_and(|v| !v.trim().is_empty() && !v.contains("no test specified"));
        let unit = ["test:unit", "unit"].into_iter().find(|s| has(s));
        if let Some(script) = unit {
            add(&mut out, "unit", "", run(script));
        }
        if has("test") {
            add(&mut out, if unit.is_some() { "other" } else { "unit" }, if unit.is_some() { "Todas las pruebas" } else { "" }, run("test"));
        }
        if let Some(script) = ["test:integration", "test:int", "integration"].into_iter().find(|s| has(s)) {
            add(&mut out, "integration", "", run(script));
        }
        let e2e = ["test:e2e", "e2e", "test:playwright", "playwright", "cy:run", "cypress:run"].into_iter().find(|s| has(s));
        if let Some(script) = e2e {
            add(&mut out, "e2e", "", run(script));
        } else if any_of(&["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
            add(&mut out, "e2e", "Playwright", "npx playwright test".into());
        } else if any_of(&["cypress.config.ts", "cypress.config.js", "cypress.config.mjs", "cypress.json"]) {
            add(&mut out, "e2e", "Cypress", "npx cypress run".into());
        }
        if has("lint") {
            add(&mut out, "lint", "Lint", run("lint"));
        }
        if let Some(script) = ["typecheck", "type-check", "check-types", "tsc"].into_iter().find(|s| has(s)) {
            add(&mut out, "lint", "Tipos", run(script));
        }
    }
    if exists("Cargo.toml") {
        add(&mut out, "unit", "", if exists("Cargo.lock") { "cargo test --locked" } else { "cargo test" }.into());
    }
    if exists("go.mod") {
        add(&mut out, "unit", "", "go test ./...".into());
    }
    let pom = std::fs::read_to_string(root.join("pom.xml")).ok();
    if let Some(pom) = &pom {
        let mvn = if cfg!(windows) && exists("mvnw.cmd") { "mvnw.cmd" } else if !cfg!(windows) && exists("mvnw") { "./mvnw" } else { "mvn" };
        add(&mut out, "unit", "", format!("{mvn} test"));
        if pom.contains("maven-failsafe-plugin") {
            add(&mut out, "integration", "", format!("{mvn} verify"));
        }
    }
    if pom.is_none() && any_of(&["build.gradle", "build.gradle.kts"]) {
        let gradle = if cfg!(windows) && exists("gradlew.bat") { "gradlew.bat" } else if !cfg!(windows) && exists("gradlew") { "./gradlew" } else { "gradle" };
        add(&mut out, "unit", "", format!("{gradle} test"));
    }
    let python = if cfg!(windows) { "python -m pytest" } else { "python3 -m pytest" };
    if exists("pytest.ini") || exists("conftest.py") || std::fs::read_to_string(root.join("pyproject.toml")).is_ok_and(|text| text.contains("[tool.pytest")) {
        add(&mut out, "unit", "", python.to_string());
        for (dir, kind) in [("tests/integration", "integration"), ("tests/e2e", "e2e")] {
            if root.join(dir).is_dir() {
                add(&mut out, kind, "", format!("{python} {dir}"));
            }
        }
    }
    if read_json("composer.json").is_some_and(|value| !value["scripts"]["test"].is_null()) {
        add(&mut out, "unit", "", "composer test".into());
    }
    let dotnet = std::fs::read_dir(root).into_iter().flatten().flatten().any(|e| {
        let name = e.file_name().to_string_lossy().to_lowercase();
        name.ends_with(".sln") || name.ends_with(".csproj")
    });
    if dotnet {
        add(&mut out, "unit", "", "dotnet test".into());
    }
    if out.is_empty() && std::fs::read_to_string(root.join("Makefile")).is_ok_and(|m| m.lines().any(|l| l.starts_with("test:"))) {
        add(&mut out, "unit", "", "make test".into());
    }
    out
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
    fn suites_are_read_off_what_each_repository_has() {
        let root = std::env::temp_dir().join(format!("cf-suites-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(root.join("playwright.config.ts"), "").unwrap();
        std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"vitest run","test:integration":"vitest -c int","lint":"eslint .","typecheck":"tsc --noEmit"}}"#).unwrap();
        let suites = detect_suites(&root);
        let found: Vec<(&str, &str, &str, bool)> = suites.iter().map(|c| (c.kind.as_str(), c.command.as_str(), c.when.as_str(), c.write)).collect();
        assert_eq!(found, vec![
            ("unit", "pnpm test", "item", true),
            ("integration", "pnpm run test:integration", "final", false),
            ("e2e", "npx playwright test", "agent", false),
            ("lint", "pnpm run lint", "item", false),
            ("lint", "pnpm run typecheck", "item", false),
        ]);

        // A repository with no tests has no suites — nothing for the members to run or invent.
        let bare = root.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        assert!(detect_suites(&bare).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

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
