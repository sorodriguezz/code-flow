use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{protocol::PlannedItem, Item, Run};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Amendment {
    pub summary: String,
    pub cancel: Vec<String>,
    pub items: Vec<PlannedItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractSpec {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contract {
    pub name: String,
    pub path: String,
    pub version: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Impact {
    pub files: Vec<String>,
    pub diff: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Execution {
    pub provider: String,
    pub model: String,
    pub effort: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    pub project_id: String,
    pub role: String,
    pub kind: String,
    pub route: Execution,
    pub completed: usize,
    pub attempted: usize,
    pub first_pass: usize,
    pub quota_blocks: usize,
    pub median_seconds: i64,
    pub run_ids: Vec<String>,
}

pub fn fingerprint(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

pub fn contract_name(name: &str) -> Option<String> {
    let name = name.trim().to_ascii_lowercase();
    (!name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))).then_some(name)
}

pub fn publish_contracts(root: &str, specs: &[ContractSpec]) -> Result<Vec<Contract>, String> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let root = Path::new(root).canonicalize().map_err(|error| error.to_string())?;
    specs.iter().map(|spec| {
        let path = root.join(&spec.path).canonicalize().map_err(|_| format!("Falta el contrato «{}» en {}.", spec.name, spec.path))?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err(format!("El contrato «{}» debe estar dentro del repositorio.", spec.name));
        }
        let mut text = String::new();
        std::fs::File::open(&path).and_then(|file| file.take(128 * 1024 + 1).read_to_string(&mut text))
            .map_err(|error| format!("No se pudo leer el contrato «{}»: {error}", spec.name))?;
        if text.trim().is_empty() || text.len() > 128 * 1024 {
            return Err(format!("El contrato «{}» debe ser texto de hasta 128 KB.", spec.name));
        }
        let lower = spec.path.to_ascii_lowercase();
        let is_openapi = lower.contains("openapi") || lower.contains("swagger");
        if lower.ends_with(".json") {
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| format!("El contrato «{}» no tiene JSON válido: {error}", spec.name))?;
            if is_openapi
                && (!json.is_object() || (json.get("openapi").is_none() && json.get("swagger").is_none()))
            {
                return Err(format!("El contrato «{}» necesita una versión OpenAPI o Swagger.", spec.name));
            }
        } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
            let yaml = yaml_rust2::YamlLoader::load_from_str(&text)
                .map_err(|error| format!("El contrato «{}» no tiene YAML válido: {error}", spec.name))?;
            if is_openapi && !yaml.first().is_some_and(|doc| doc["openapi"].as_str().is_some() || doc["swagger"].as_str().is_some()) {
                return Err(format!("El contrato «{}» necesita una versión OpenAPI o Swagger.", spec.name));
            }
        }
        Ok(Contract { name: spec.name.clone(), path: spec.path.clone(), version: fingerprint(&[&text]), text })
    }).collect()
}

/// A contract backed by a completed delivery. Work with a commit becomes visible after integration.
pub fn latest_contracts(items: &[Item]) -> BTreeMap<&str, (&Item, &Contract)> {
    let mut latest = BTreeMap::new();
    let mut publishers: Vec<_> = items.iter().filter(|item| item.status == "done"
        && (!item.writes() || item.merged || item.commit_sha.is_empty())).collect();
    publishers.sort_by_key(|item| (&item.finished_at, &item.created_at));
    for item in publishers {
        for contract in &item.intelligence.published_contracts {
            latest.insert(contract.name.as_str(), (item, contract));
        }
    }
    latest
}

pub fn outdated_contracts<'a>(item: &'a Item, latest: &BTreeMap<&str, (&Item, &Contract)>) -> Vec<&'a str> {
    item.intelligence.used_contracts.iter().filter_map(|(name, version)| {
        (!latest.get(name.as_str()).is_some_and(|(_, contract)| contract.version == *version)).then_some(name.as_str())
    }).collect()
}

pub fn impact_path(path: &str, custom: &[String]) -> bool {
    let path = path.to_ascii_lowercase();
    let filename = path.rsplit('/').next().unwrap_or(&path);
    path.split('/').any(|part| matches!(part, "migrations" | "migration"))
        || filename.starts_with("openapi.") || filename.starts_with("swagger.") || filename == "schema.prisma"
        || custom.iter().any(|prefix| {
            let prefix = prefix.to_ascii_lowercase();
            path == prefix || path.strip_prefix(&prefix).is_some_and(|tail| tail.starts_with('/'))
        })
}

pub fn cyclic(items: &[Item]) -> bool {
    let mut deps: HashMap<&str, HashSet<&str>> = items.iter().filter(|item| matches!(item.status.as_str(), "pending" | "waiting" | "gated"))
        .map(|item| (item.id.as_str(), item.depends_on.iter().map(String::as_str).collect())).collect();
    let live: HashSet<_> = deps.keys().copied().collect();
    for incoming in deps.values_mut() {
        incoming.retain(|id| live.contains(id));
    }
    while !deps.is_empty() {
        let ready: HashSet<_> = deps.iter().filter_map(|(id, incoming)| incoming.is_empty().then_some(*id)).collect();
        if ready.is_empty() {
            return true;
        }
        deps.retain(|id, incoming| {
            incoming.retain(|dep| !ready.contains(dep));
            !ready.contains(id)
        });
    }
    false
}

pub fn wire_contracts(existing: &[Item], fresh: &mut [Item]) -> Result<(), String> {
    let latest = latest_contracts(existing);
    let mut producers: HashMap<String, (String, String)> = HashMap::new();
    let pending = existing.iter().filter(|task| {
        matches!(task.status.as_str(), "pending" | "running" | "waiting" | "gated")
            || (task.status == "done" && task.writes() && !task.merged && !task.commit_sha.is_empty())
    });
    for task in pending.chain(fresh.iter()) {
        let mut names = HashSet::new();
        for spec in &task.intelligence.contract_specs {
            if task.kind == "delegate" {
                return Err(format!("El contrato «{}» necesita una tarea que entregue el archivo, no una delegación de planificación.", spec.name));
            }
            if !names.insert(&spec.name) {
                return Err(format!("«{}» declara dos veces el contrato «{}».", task.title, spec.name));
            }
            if let Some((_, previous_branch)) = producers.insert(spec.name.clone(), (task.id.clone(), task.branch.clone())) {
                if task.branch.is_empty() || previous_branch != task.branch {
                    return Err(format!("Hay más de un productor pendiente para el contrato «{}».", spec.name));
                }
            }
        }
    }
    for task in fresh.iter_mut() {
        for name in &task.intelligence.requires_contracts {
            match producers.get(name) {
                Some((id, branch)) if id != &task.id && (branch.is_empty() || branch != &task.branch) => {
                    if !task.depends_on.contains(id) {
                        task.depends_on.push(id.clone());
                    }
                }
                _ if latest.contains_key(name.as_str()) => {}
                _ => return Err(format!("«{}» necesita el contrato «{name}», pero falta un productor.", task.title)),
            }
        }
    }
    let graph: Vec<_> = existing.iter().chain(fresh.iter()).cloned().collect();
    if cyclic(&graph) {
        return Err("Las dependencias de contratos forman un ciclo.".into());
    }
    Ok(())
}

/// Replacing a pending task preserves the waiting edges. Replacing completed work means adding a
/// follow-up, with the original delivery kept as a dependency and as part of the audit trail.
pub fn amendment_changes(existing: &mut [Item], plans: &[PlannedItem], fresh: &mut [Item], cancel: &[String]) -> Result<(), String> {
    let mut replacements = HashMap::new();
    for (plan, new) in plans.iter().zip(fresh.iter_mut()).filter(|(plan, _)| !plan.replaces.is_empty()) {
        let old = existing.iter().find(|task| task.key == plan.replaces && !task.is_lead())
            .ok_or_else(|| format!("La tarea «{}» que se quiere reemplazar no existe.", plan.replaces))?;
        if !matches!(old.status.as_str(), "pending" | "done" | "error" | "skipped") || replacements.contains_key(&old.id) {
            return Err(format!("No se puede reemplazar «{}» en su estado actual.", old.title));
        }
        if old.project_id != new.project_id {
            return Err(format!("La corrección de «{}» debe usar su repositorio.", old.title));
        }
        if old.status == "done" && !new.depends_on.contains(&old.id) {
            new.depends_on.push(old.id.clone());
        }
        if old.status != "done" {
            new.depends_on.retain(|id| id != &old.id);
        }
        replacements.insert(old.id.clone(), (new.id.clone(), old.status == "pending"));
    }
    let canceled: HashSet<_> = existing.iter().filter(|task| cancel.contains(&task.key) || replacements.get(&task.id).is_some_and(|(_, pending)| *pending))
        .map(|task| task.id.clone()).collect();
    for key in cancel {
        if !existing.iter().any(|task| &task.key == key && task.status == "pending" && !task.is_lead()) {
            return Err(format!("Solo se pueden retirar tareas pendientes, revisa «{key}»."));
        }
    }
    for task in existing.iter_mut().chain(fresh.iter_mut()) {
        if canceled.contains(&task.id) {
            task.status = "skipped".into();
            continue;
        }
        if !matches!(task.status.as_str(), "pending" | "gated" | "waiting") {
            continue;
        }
        for dep in &mut task.depends_on {
            if let Some((next, _)) = replacements.get(dep).filter(|(next, _)| next != &task.id) {
                dep.clone_from(next);
            } else if canceled.contains(dep) {
                return Err(format!("«{}» todavía necesita una tarea que se quiere retirar.", task.title));
            }
        }
    }
    wire_contracts(existing, fresh)
}

pub fn recommendations(conn: &Connection, run: &Run, repos: &[super::RunRepo]) -> rusqlite::Result<Vec<Recommendation>> {
    #[derive(Default)]
    struct Stats { completed: usize, attempted: usize, first_pass: usize, quota_blocks: usize, durations: Vec<i64>, runs: Vec<String> }
    let allowed: HashSet<_> = repos.iter().map(|r| r.project_id.as_str()).collect();
    let mut groups: BTreeMap<_, Stats> = BTreeMap::new();
    for previous in super::list_runs(conn, &run.workspace_id)?.into_iter()
        .filter(|previous| previous.team_id == run.team_id && previous.id != run.id && previous.status == "done").take(40)
    {
        let items = super::list_items(conn, &previous.id)?;
        for item in items.iter().filter(|i| {
            allowed.contains(i.project_id.as_str()) && matches!(i.kind.as_str(), "work" | "investigate" | "review")
                && matches!(i.status.as_str(), "done" | "error") && i.attempts > 0
        }) {
            let Some(member) = super::intelligence::executor(&previous, &item) else { continue };
            let route = item.intelligence.execution.clone().unwrap_or_else(|| Execution {
                provider: member.provider.clone(), model: super::intelligence::model(member, &item).to_string(), effort: member.effort.clone(),
            });
            let key = |route| (item.project_id.clone(), member.member.role.clone(), item.kind.clone(), route);
            for event in &item.intelligence.quota_events {
                groups.entry(key(event.clone())).or_default().quota_blocks += 1;
            }
            let stats = groups.entry(key(route)).or_default();
            stats.attempted += 1;
            if item.status == "done" {
                stats.completed += 1;
                let corrected = items.iter().any(|candidate| candidate.kind == "work" && candidate.ref_item == item.id && candidate.attempts > 0);
                stats.first_pass += usize::from(item.attempts == 1 && !corrected);
                if let (Ok(start), Ok(end)) = (chrono::DateTime::parse_from_rfc3339(&item.started_at), chrono::DateTime::parse_from_rfc3339(&item.finished_at)) {
                    stats.durations.push((end - start).num_seconds().max(0));
                }
            }
            if !stats.runs.contains(&previous.id) && stats.runs.len() < 4 {
                stats.runs.push(previous.id.clone());
            }
        }
    }
    let mut result = groups.into_iter().filter_map(|((project_id, role, kind, route), mut stats)| {
        if stats.attempted < 2 || stats.completed == 0 {
            return None;
        }
        stats.durations.sort_unstable();
        Some(Recommendation {
            project_id, role, kind, route, completed: stats.completed, attempted: stats.attempted, first_pass: stats.first_pass, quota_blocks: stats.quota_blocks,
            median_seconds: stats.durations.get(stats.durations.len() / 2).copied().unwrap_or_default(), run_ids: stats.runs,
        })
    }).collect::<Vec<_>>();
    result.sort_by_key(|r| (std::cmp::Reverse(r.first_pass * 100 / r.attempted), r.quota_blocks * 100 / r.attempted, std::cmp::Reverse(r.attempted), r.median_seconds));
    result.truncate(24);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::intelligence::ItemIntelligence;

    fn item(id: &str, status: &str) -> Item {
        Item { id: id.into(), key: id.into(), title: id.into(), project_id: "repo".into(), status: status.into(), kind: "work".into(), ..Default::default() }
    }

    #[test]
    fn a_contract_links_across_repositories_and_a_new_version_flags_consumers() {
        let mut producer = item("api", "pending");
        producer.intelligence.contract_specs.push(ContractSpec { name: "api-v1".into(), path: "openapi.json".into() });
        let mut consumer = item("web", "pending");
        consumer.project_id = "web-repo".into();
        consumer.intelligence.requires_contracts.push("api-v1".into());
        wire_contracts(&[producer.clone()], std::slice::from_mut(&mut consumer)).unwrap();
        assert_eq!(consumer.depends_on, vec!["api"]);
        assert!(wire_contracts(&[], std::slice::from_mut(&mut consumer)).is_err());
        let mut published = producer;
        published.status = "done".into();
        published.commit_sha = "abc".into();
        published.intelligence.published_contracts.push(Contract { name: "api-v1".into(), path: "openapi.json".into(), version: "first".into(), text: "{}".into() });
        assert!(latest_contracts(&[published.clone()]).is_empty());
        wire_contracts(&[published.clone()], std::slice::from_mut(&mut consumer)).unwrap();
        assert_eq!(consumer.depends_on, vec!["api"]);
        published.merged = true;
        consumer.intelligence.used_contracts.insert("api-v1".into(), "first".into());
        assert!(outdated_contracts(&consumer, &latest_contracts(&[published.clone()])).is_empty());
        published.intelligence.published_contracts[0].version = "next".into();
        assert_eq!(outdated_contracts(&consumer, &latest_contracts(&[published])), vec!["api-v1"]);
    }

    #[test]
    fn validates_contract_files_and_rejects_paths_outside_the_checkout() {
        struct TempDir(std::path::PathBuf);
        impl Drop for TempDir {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let path = std::env::temp_dir().join(format!("cf-contract-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let dir = TempDir(path);
        let root = dir.0.join("repo");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("openapi.yaml"), "openapi: 3.1.0\npaths: {}\n").unwrap();
        std::fs::write(root.join("openapi.json"), "{\"paths\": {}}").unwrap();
        std::fs::write(dir.0.join("outside.json"), "{}").unwrap();
        let spec = |path: &str| ContractSpec { name: "api".into(), path: path.into() };
        let first = publish_contracts(root.to_str().unwrap(), &[spec("openapi.yaml")]).unwrap();
        assert_eq!(first[0].version.len(), 64);
        assert!(publish_contracts(root.to_str().unwrap(), &[spec("openapi.json")]).is_err());
        assert!(publish_contracts(root.to_str().unwrap(), &[spec("../outside.json")]).is_err());
    }

    #[test]
    fn recommendations_use_the_actual_route_and_exclude_other_workspaces() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&db).unwrap();
        let workspace = crate::db::queries::create_workspace(&db, "workspace", "folder", "#fff").unwrap();
        let mut member = super::super::MemberSnap { provider: "claude".into(), model: "old".into(), ..Default::default() };
        member.member.id = "dev".into();
        member.member.role = "Backend".into();
        let run = Run { id: "prior".into(), workspace_id: workspace.id.clone(), team_id: "team".into(), status: "done".into(), members: vec![member], ..Default::default() };
        super::super::insert_run(&db, &run).unwrap();
        let route = Execution { provider: "codex".into(), model: "route".into(), effort: "high".into() };
        for key in ["first", "second"] {
            let task = Item {
                run_id: run.id.clone(), member_id: "dev".into(), attempts: 1,
                intelligence: ItemIntelligence { execution: Some(route.clone()), quota_events: vec![route.clone()], ..Default::default() },
                ..item(key, "done")
            };
            super::super::insert_item(&db, &task).unwrap();
        }
        let active = Run { id: "active".into(), ..run };
        let repo = super::super::RunRepo { project_id: "repo".into(), ..Default::default() };
        let rows = recommendations(&db, &active, std::slice::from_ref(&repo)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].route, route);
        assert_eq!((rows[0].first_pass, rows[0].quota_blocks), (2, 2));
        assert_eq!(rows[0].run_ids, vec!["prior"]);
        let other = Run { workspace_id: "other".into(), ..active };
        assert!(recommendations(&db, &other, &[repo]).unwrap().is_empty());
    }
}
