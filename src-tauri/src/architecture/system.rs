//! How the repositories of a system connect, worked out from what each one declares.
//!
//! [`super::repo_card`] reads, per repository, the routes it exposes, the calls it makes and the queues
//! it sends to or listens on. This lines them up: a frontend that calls `/orders/${id}` and a server that
//! exposes `/orders/:id` are one connection, and the two ends are cited.
//!
//! **Every connection says how sure it is**, and the model that later describes the system never gets to
//! raise that:
//!
//! - [`Confidence::Verified`] — both ends are in the code: the same route (parameters normalised) on both
//!   sides, or the same queue name on a producer and a listener.
//! - [`Confidence::Inferred`] — a likely match that is not exact: the route matches once a gateway prefix
//!   such as `/api` or `/v1` is ignored, a name could be several repositories, or the only link is that an
//!   environment variable's name resembles a repository's.
//! - [`Confidence::Unresolved`] — a call whose destination could not be found. It is **kept and reported**,
//!   never dropped and never guessed: the URL usually lives in a pipeline or in Azure's app settings, and
//!   "this repository calls something we cannot place" is a true and useful thing to put on a diagram.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use super::repo_card::{normalize, scan, Channel, Consumption, Exposure, RepoCard};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Verified,
    Inferred,
    /// Kept for the wire: a call that could not be placed is reported in [`SystemMap::unresolved`], not as a link.
    #[allow(dead_code)]
    Unresolved,
}

/// One connection from a repository to another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    pub from: String,
    pub to: String,
    pub channel: Channel,
    /// What carries it: `GET /orders/*`, `queue orders-created`, `env ORDERS_API_URL`.
    pub via: String,
    pub confidence: Confidence,
    /// `path:line` of the call.
    pub from_at: String,
    /// `path:line` of what answers it.
    pub to_at: String,
}

/// A call whose other end could not be placed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unresolved {
    pub from: String,
    pub via: String,
    pub at: String,
}

/// Infrastructure two or more repositories use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SharedInfra {
    pub kind: String,
    pub repos: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemMap {
    pub cards: Vec<RepoCard>,
    pub links: Vec<Link>,
    pub unresolved: Vec<Unresolved>,
    pub shared: Vec<SharedInfra>,
}

/// Prefixes a gateway commonly adds or removes: `/api`, `/v1`, `/api/v2`.
fn without_gateway_prefix(normalized: &str) -> String {
    let mut parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty()).collect();
    while let Some(first) = parts.first() {
        let version = first.len() >= 2 && first.starts_with('v') && first[1..].chars().all(|c| c.is_ascii_digit());
        if *first == "api" || version {
            parts.remove(0);
        } else {
            break;
        }
    }
    format!("/{}", parts.join("/"))
}

/// Words in a name that say nothing about *which* service it is.
const NOISE: [&str; 16] = [
    "url", "uri", "host", "api", "base", "endpoint", "service", "public", "next", "vite", "react", "app", "svc", "server", "http", "https",
];

fn tokens(name: &str) -> Vec<String> {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|token| token.len() > 2 && !NOISE.contains(&token.as_str()))
        .collect()
}

fn at(file: &str, line: usize) -> String {
    if line == 0 { file.to_string() } else { format!("{file}:{line}") }
}

fn method_ok(consumption: &str, exposure: &str) -> bool {
    consumption.is_empty() || exposure.is_empty() || exposure.eq_ignore_ascii_case("ANY") || consumption.eq_ignore_ascii_case(exposure)
}

fn http_exposure<'a>(card: &'a RepoCard) -> impl Iterator<Item = &'a Exposure> {
    card.exposes.iter().filter(|e| e.channel == Channel::Http)
}

/// The repositories (other than `from`) whose name shares a meaningful word with `variable`.
fn by_name<'a>(cards: &'a [RepoCard], from: usize, variable: &str) -> Vec<&'a RepoCard> {
    let wanted = tokens(variable);
    if wanted.is_empty() {
        return Vec::new();
    }
    cards
        .iter()
        .enumerate()
        .filter(|(at, card)| *at != from && tokens(&card.name).iter().any(|token| wanted.contains(token)))
        .map(|(_, card)| card)
        .collect()
}

/// Lines the repositories up.
pub fn link(cards: Vec<RepoCard>) -> SystemMap {
    let mut links: Vec<Link> = Vec::new();
    let mut unresolved: Vec<Unresolved> = Vec::new();

    for (from_at, consumer) in cards.iter().enumerate() {
        for call in &consumer.consumes {
            match call.channel {
                Channel::Http => http_call(&cards, from_at, consumer, call, &mut links, &mut unresolved),
                Channel::Queue => queue_call(&cards, from_at, consumer, call, &mut links),
                Channel::Timer => {}
            }
        }
    }

    // The same connection found in several files is one connection, drawn once, at its best confidence.
    let mut best: BTreeMap<(String, String, String), Link> = BTreeMap::new();
    for link in links {
        let key = (link.from.clone(), link.to.clone(), link.via.clone());
        match best.get(&key) {
            Some(existing) if rank(existing.confidence) <= rank(link.confidence) => {}
            _ => {
                best.insert(key, link);
            }
        }
    }
    let links: Vec<Link> = best.into_values().collect();
    unresolved.sort_by(|a, b| (&a.from, &a.via).cmp(&(&b.from, &b.via)));
    unresolved.dedup();

    let mut by_kind: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for card in &cards {
        for infra in &card.infra {
            let users = by_kind.entry(infra.kind.clone()).or_default();
            if !users.contains(&card.name) {
                users.push(card.name.clone());
            }
        }
    }
    let shared = by_kind.into_iter().filter(|(_, repos)| repos.len() > 1).map(|(kind, repos)| SharedInfra { kind, repos }).collect();

    SystemMap { cards, links, unresolved, shared }
}

/// Lower is surer.
fn rank(confidence: Confidence) -> u8 {
    match confidence {
        Confidence::Verified => 0,
        Confidence::Inferred => 1,
        Confidence::Unresolved => 2,
    }
}

fn http_call(cards: &[RepoCard], from_at: usize, consumer: &RepoCard, call: &Consumption, links: &mut Vec<Link>, unresolved: &mut Vec<Unresolved>) {
    let here = at(&call.file, call.line);
    let method = if call.method.is_empty() { "ANY".to_string() } else { call.method.clone() };

    if let Some(path) = &call.path {
        let wanted = normalize(path);
        let via = format!("{method} {wanted}");
        let exact: Vec<(&RepoCard, &Exposure)> = cards
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != from_at)
            .flat_map(|(_, card)| http_exposure(card).map(move |e| (card, e)))
            .filter(|(_, e)| normalize(&e.name) == wanted && method_ok(&call.method, &e.method))
            .collect();
        let owners: std::collections::BTreeSet<&str> = exact.iter().map(|(card, _)| card.name.as_str()).collect();
        if !exact.is_empty() {
            // One repository answers it: both ends are in the code. Several: it is one of them, and
            // which is not something the code says — each is offered as a likely answer, not a fact.
            let confidence = if owners.len() == 1 { Confidence::Verified } else { Confidence::Inferred };
            for (card, exposure) in exact {
                links.push(Link { from: consumer.name.clone(), to: card.name.clone(), channel: Channel::Http, via: via.clone(), confidence, from_at: here.clone(), to_at: at(&exposure.file, exposure.line) });
            }
            return;
        }
        // The same route once a gateway prefix is ignored on either side.
        let bare = without_gateway_prefix(&wanted);
        let loose: Vec<(&RepoCard, &Exposure)> = cards
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != from_at)
            .flat_map(|(_, card)| http_exposure(card).map(move |e| (card, e)))
            .filter(|(_, e)| bare != "/" && without_gateway_prefix(&normalize(&e.name)) == bare && method_ok(&call.method, &e.method))
            .collect();
        if !loose.is_empty() {
            for (card, exposure) in loose {
                links.push(Link { from: consumer.name.clone(), to: card.name.clone(), channel: Channel::Http, via: via.clone(), confidence: Confidence::Inferred, from_at: here.clone(), to_at: at(&exposure.file, exposure.line) });
            }
            return;
        }
        // Nobody exposes it, but the variable that holds the base URL may name the service.
        if let Some(variable) = &call.env {
            let named = by_name(cards, from_at, variable);
            if !named.is_empty() {
                for card in named {
                    links.push(Link { from: consumer.name.clone(), to: card.name.clone(), channel: Channel::Http, via: format!("{via} (base URL from {variable})"), confidence: Confidence::Inferred, from_at: here.clone(), to_at: String::new() });
                }
                return;
            }
        }
        let base = call.env.as_ref().map_or(String::new(), |v| format!(" (base URL from {v})"));
        unresolved.push(Unresolved { from: consumer.name.clone(), via: format!("{via}{base}"), at: here });
        return;
    }

    // No path, only the variable that holds an address.
    if let Some(variable) = &call.env {
        let named = by_name(cards, from_at, variable);
        if named.is_empty() {
            unresolved.push(Unresolved { from: consumer.name.clone(), via: format!("env {variable}"), at: here.clone() });
        }
        for card in named {
            links.push(Link { from: consumer.name.clone(), to: card.name.clone(), channel: Channel::Http, via: format!("env {variable}"), confidence: Confidence::Inferred, from_at: here.clone(), to_at: String::new() });
        }
    }
}

fn queue_call(cards: &[RepoCard], from_at: usize, consumer: &RepoCard, call: &Consumption, links: &mut Vec<Link>) {
    let Some(queue) = &call.queue else { return };
    for (index, card) in cards.iter().enumerate() {
        if index == from_at {
            continue;
        }
        for listener in card.exposes.iter().filter(|e| e.channel == Channel::Queue && e.name.eq_ignore_ascii_case(queue)) {
            links.push(Link {
                from: consumer.name.clone(),
                to: card.name.clone(),
                channel: Channel::Queue,
                via: format!("queue {queue}"),
                confidence: Confidence::Verified,
                from_at: at(&call.file, call.line),
                to_at: at(&listener.file, listener.line),
            });
        }
    }
}

/// A Mermaid `sequenceDiagram` of what happens from `start`: every link leaving it, then every link
/// leaving what those reach, each once and in the order found (breadth first). Calls are solid arrows
/// and queue messages dashed; an `inferred` link says so, because a diagram is read as fact. `None`
/// when `start` is not a repository of the map or nothing leaves it.
pub fn sequence_from(map: &SystemMap, start: &str) -> Option<String> {
    if !map.cards.iter().any(|card| card.name == start) {
        return None;
    }
    let mut order = vec![start.to_string()];
    let mut lines = Vec::new();
    let mut seen_links = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::from([start.to_string()]);
    while let Some(from) = queue.pop_front() {
        for link in map.links.iter().filter(|link| link.from == from) {
            if !seen_links.insert((link.from.clone(), link.to.clone(), link.via.clone())) {
                continue;
            }
            for name in [&link.from, &link.to] {
                if !order.contains(name) {
                    order.push(name.clone());
                }
            }
            let arrow = if link.channel == Channel::Queue { "-->>" } else { "->>" };
            let note = if link.confidence == Confidence::Inferred { " (inferred)" } else { "" };
            let label = link.via.replace(['\n', ';', '#'], " ");
            lines.push(format!("    {}{arrow}{}: {label}{note}", participant(&link.from), participant(&link.to)));
            queue.push_back(link.to.clone());
        }
    }
    if lines.is_empty() {
        return None;
    }
    let mut out = String::from("sequenceDiagram\n");
    for name in &order {
        out.push_str(&format!("    participant {} as {}\n", participant(name), name.replace(['\n', ':'], " ")));
    }
    out.push_str(&lines.join("\n"));
    out.push('\n');
    Some(out)
}

/// A name Mermaid accepts as an id.
fn participant(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

/// The repositories whose current commit is not the one their card was read at — the map no longer
/// describes them. A card read outside git (`head` empty) is never reported: there is nothing to compare.
/// Blocking: it asks git.
#[cfg(test)]
pub fn stale(map: &SystemMap) -> Vec<String> {
    map.cards
        .iter()
        .filter(|card| !card.head.is_empty() && super::repo_card::head_of(Path::new(&card.path)) != card.head)
        .map(|card| card.name.clone())
        .collect()
}

/// Reads every repository and links them. Blocking.
pub fn scan_system(paths: &[String]) -> Result<SystemMap, String> {
    let mut cards = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
        if !seen.insert(canonical.clone()) {
            continue;
        }
        cards.push(scan(Path::new(path))?);
    }
    // Two repositories with the same folder name would read as one in every line below.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for card in &mut cards {
        let count = counts.entry(card.name.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            card.name = format!("{}#{}", card.name, count);
        }
    }
    Ok(link(cards))
}

/// The map as text for the model: what each repository is, what connects them and how sure each
/// connection is, with the places in the code. Cut to `budget` characters, keeping the connections —
/// they are the part nothing else supplies.
pub fn digest(map: &SystemMap, budget: usize) -> String {
    let mut out = String::from(
        "SYSTEM MAP — read from the code of each repository, without a model. Every connection below was found in the code; \
         `verified` means both ends are cited, `inferred` means it is a likely match and must be drawn as uncertain, and \
         `unresolved` calls could not be placed and must be listed as such, not connected to a guess.\n\n",
    );
    out.push_str("## Connections\n");
    if map.links.is_empty() {
        out.push_str("(none found)\n");
    }
    for link in &map.links {
        let cites = if link.to_at.is_empty() { link.from_at.clone() } else { format!("{} → {}", link.from_at, link.to_at) };
        out.push_str(&format!("- {} → {} · {} · {} · {}\n", link.from, link.to, link.via, confidence_word(link.confidence), cites));
    }
    if !map.unresolved.is_empty() {
        out.push_str("\n## Unresolved calls (the other end is not in these repositories)\n");
        for call in &map.unresolved {
            out.push_str(&format!("- {} calls {} · {}\n", call.from, call.via, call.at));
        }
    }
    if !map.shared.is_empty() {
        out.push_str("\n## Shared infrastructure\n");
        for shared in &map.shared {
            out.push_str(&format!("- {}: {}\n", shared.kind, shared.repos.join(", ")));
        }
    }
    out.push_str("\n## Repositories\n");
    for card in &map.cards {
        let http = card.exposes.iter().filter(|e| e.channel == Channel::Http).count();
        let queues: Vec<&str> = card.exposes.iter().filter(|e| e.channel == Channel::Queue).map(|e| e.name.as_str()).collect();
        let infra: Vec<&str> = card.infra.iter().map(|i| i.kind.as_str()).collect();
        out.push_str(&format!("### {} — {:?} ({})\n", card.name, card.role, card.role_reason));
        out.push_str(&format!("exposes {http} HTTP route(s)"));
        if !queues.is_empty() {
            out.push_str(&format!(", listens on {}", queues.join(", ")));
        }
        if !infra.is_empty() {
            out.push_str(&format!("; uses {}", infra.join(", ")));
        }
        out.push('\n');
        for exposure in card.exposes.iter().filter(|e| e.channel == Channel::Http).take(12) {
            out.push_str(&format!("  - {} {} ({})\n", exposure.method, exposure.name, at(&exposure.file, exposure.line)));
        }
    }
    if out.len() > budget {
        let mut cut = budget;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n[… repositories cut to fit]");
    }
    out
}

fn confidence_word(confidence: Confidence) -> &'static str {
    match confidence {
        Confidence::Verified => "verified",
        Confidence::Inferred => "inferred",
        Confidence::Unresolved => "unresolved",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A small system: a frontend, a BFF, a core service with a database and Redis, and an Azure
    /// Function on a queue that also uses Redis. Named the way teams name them.
    fn system(tag: &str) -> (PathBuf, Vec<String>) {
        let base = std::env::temp_dir().join(format!("cf-sys-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let web = base.join("shop-web");
        write(&web, "package.json", r#"{"dependencies":{"next":"14","react-dom":"18"}}"#);
        write(
            &web,
            "src/api.ts",
            "export const order = (id: string) => fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/orders/${id}`);\nexport const ping = () => fetch('/api/health');\nexport const legacy = () => fetch(`${process.env.NEXT_PUBLIC_REPORTS_URL}/v2/reports/9`);\n",
        );
        let bff = base.join("shop-bff");
        write(&bff, "package.json", r#"{"dependencies":{"express":"4","axios":"1"}}"#);
        write(
            &bff,
            "src/server.ts",
            "app.get('/orders/:id', async (req, res) => {\n  const r = await axios.get(`${process.env.ORDERS_CORE_URL}/internal/orders/${req.params.id}`);\n  const s = client.createSender('orders-created');\n  res.json(r.data);\n});\napp.get('/health', (q, r) => r.send('ok'));\n",
        );
        let core = base.join("orders-core");
        write(&core, "package.json", r#"{"dependencies":{"express":"4","pg":"8","ioredis":"5"}}"#);
        write(&core, "src/routes.ts", "app.get('/internal/orders/:id', (req, res) => res.json({}));\n");
        let func = base.join("orders-fn");
        write(&func, "host.json", "{}");
        write(&func, "package.json", r#"{"dependencies":{"@azure/functions":"4","ioredis":"5"}}"#);
        write(&func, "src/on.ts", "app.serviceBusQueue('onOrder', { queueName: 'orders-created', connection: 'SB', handler });\n");
        let paths = [&web, &bff, &core, &func].map(|p| p.display().to_string()).to_vec();
        (base, paths)
    }

    fn find<'a>(map: &'a SystemMap, from: &str, to: &str) -> Vec<&'a Link> {
        map.links.iter().filter(|l| l.from == from && l.to == to).collect()
    }

    #[test]
    fn a_call_and_the_route_that_answers_it_are_one_verified_connection_with_both_ends_cited() {
        let (base, paths) = system("verified");
        let map = scan_system(&paths).unwrap();
        let web_to_bff: Vec<&Link> = find(&map, "shop-web", "shop-bff").into_iter().filter(|l| l.via.contains("orders")).collect();
        assert_eq!(web_to_bff.len(), 1, "{:?}", map.links);
        assert_eq!(web_to_bff[0].confidence, Confidence::Verified);
        assert_eq!(web_to_bff[0].via, "GET /orders/*", "`${{id}}` and `:id` are the same route");
        assert_eq!(web_to_bff[0].from_at, "src/api.ts:1");
        assert_eq!(web_to_bff[0].to_at, "src/server.ts:1");

        let bff_to_core = find(&map, "shop-bff", "orders-core");
        assert_eq!(bff_to_core.len(), 1, "{:?}", map.links);
        assert_eq!(bff_to_core[0].confidence, Confidence::Verified);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_queue_name_on_a_producer_and_a_listener_is_a_verified_queue_connection() {
        let (base, paths) = system("queue");
        let map = scan_system(&paths).unwrap();
        let queue = find(&map, "shop-bff", "orders-fn");
        assert_eq!(queue.len(), 1, "{:?}", map.links);
        assert_eq!((queue[0].channel, queue[0].confidence), (Channel::Queue, Confidence::Verified));
        assert_eq!(queue[0].via, "queue orders-created");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_route_that_matches_only_without_a_gateway_prefix_is_inferred_not_verified() {
        let (base, paths) = system("prefix");
        // The frontend calls /api/health; the BFF exposes /health. Same thing behind a gateway — probably.
        let map = scan_system(&paths).unwrap();
        let health: Vec<&Link> = map.links.iter().filter(|l| l.via.contains("health")).collect();
        assert_eq!(health.len(), 1, "{:?}", map.links);
        assert_eq!((health[0].to.as_str(), health[0].confidence), ("shop-bff", Confidence::Inferred));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_call_nobody_exposes_is_kept_as_unresolved_and_never_pinned_on_a_guess() {
        let (base, paths) = system("unresolved");
        let map = scan_system(&paths).unwrap();
        // `/v2/reports/9` and `NEXT_PUBLIC_REPORTS_URL`: no repository is called "reports" and none exposes it.
        assert!(map.unresolved.iter().any(|u| u.from == "shop-web" && u.via.contains("reports")), "{:?}", map.unresolved);
        assert!(map.links.iter().all(|l| !l.via.contains("reports")), "{:?}", map.links);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn shared_infrastructure_is_found_across_repositories_and_not_drawn_as_a_link_between_them() {
        let (base, paths) = system("shared");
        let map = scan_system(&paths).unwrap();
        let redis = map.shared.iter().find(|s| s.kind == "redis").expect("redis is used by two repositories");
        assert_eq!(redis.repos, vec!["orders-core".to_string(), "orders-fn".to_string()]);
        assert!(find(&map, "orders-core", "orders-fn").is_empty(), "sharing a Redis is not a call");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_base_url_variable_named_like_a_repository_is_an_inferred_link_with_no_path() {
        let a = RepoCard {
            name: "dashboard".into(),
            path: String::new(),
            role: super::super::repo_card::Role::Frontend,
            role_reason: String::new(),
            exposes: vec![],
            consumes: vec![Consumption { channel: Channel::Http, method: String::new(), path: None, env: Some("BILLING_API_URL".into()), queue: None, file: "a.ts".into(), line: 3 }],
            infra: vec![],
            head: String::new(),
        };
        let b = RepoCard { name: "billing-service".into(), consumes: vec![], ..a.clone() };
        let map = link(vec![a, b]);
        assert_eq!(map.links.len(), 1);
        assert_eq!((map.links[0].confidence, map.links[0].to.as_str()), (Confidence::Inferred, "billing-service"));
        assert!(map.unresolved.is_empty());
    }

    #[test]
    fn a_pull_makes_the_card_stale_and_a_folder_outside_git_never_is() {
        let dir = std::env::temp_dir().join(format!("cf-stale-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let out = crate::proc::std_command("git").arg("-C").arg(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "{args:?}");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "1").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "one"]);
        let map = scan_system(&[dir.display().to_string()]).unwrap();
        assert!(!map.cards[0].head.is_empty());
        assert!(stale(&map).is_empty());
        std::fs::write(dir.join("a.txt"), "2").unwrap();
        git(&["commit", "-qam", "two"]);
        assert_eq!(stale(&map), vec![map.cards[0].name.clone()]);
        let loose = std::env::temp_dir().join(format!("cf-nogit-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&loose).unwrap();
        assert!(stale(&scan_system(&[loose.display().to_string()]).unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&loose);
    }

    #[test]
    fn a_sequence_follows_the_links_outward_once_each() {
        let card = |name: &str| RepoCard {
            name: name.into(),
            path: String::new(),
            role: super::super::repo_card::Role::Core,
            role_reason: String::new(),
            exposes: vec![],
            consumes: vec![],
            infra: vec![],
            head: String::new(),
        };
        let link = |from: &str, to: &str, channel, via: &str, confidence| Link {
            from: from.into(),
            to: to.into(),
            channel,
            via: via.into(),
            confidence,
            from_at: String::new(),
            to_at: String::new(),
        };
        let map = SystemMap {
            cards: vec![card("web-app"), card("orders-api"), card("mailer")],
            links: vec![
                link("web-app", "orders-api", Channel::Http, "POST /orders", Confidence::Verified),
                link("orders-api", "mailer", Channel::Queue, "queue order-created", Confidence::Inferred),
                link("mailer", "web-app", Channel::Http, "GET /back", Confidence::Verified),
            ],
            unresolved: vec![],
            shared: vec![],
        };
        let text = sequence_from(&map, "web-app").unwrap();
        assert!(text.starts_with("sequenceDiagram\n"));
        assert!(text.contains("web_app->>orders_api: POST /orders"), "{text}");
        assert!(text.contains("orders_api-->>mailer: queue order-created (inferred)"), "{text}");
        assert!(text.contains("participant orders_api as orders-api"));
        assert!(sequence_from(&map, "nobody").is_none());
        // Nothing leaves a repository that only receives.
        let only = SystemMap { links: vec![], ..map };
        assert!(sequence_from(&only, "web-app").is_none());
    }

    #[test]
    fn a_repository_never_connects_to_itself() {
        let card = RepoCard {
            name: "solo".into(),
            path: String::new(),
            role: super::super::repo_card::Role::Core,
            role_reason: String::new(),
            exposes: vec![Exposure { channel: Channel::Http, method: "GET".into(), name: "/x".into(), file: "a.ts".into(), line: 1 }],
            consumes: vec![Consumption { channel: Channel::Http, method: "GET".into(), path: Some("/x".into()), env: None, queue: None, file: "a.ts".into(), line: 2 }],
            infra: vec![],
            head: String::new(),
        };
        let map = link(vec![card]);
        assert!(map.links.is_empty());
        assert_eq!(map.unresolved.len(), 1, "a call to its own route is not a connection to anything else");
    }

    #[test]
    fn the_digest_leads_with_the_connections_and_states_how_sure_each_is() {
        let (base, paths) = system("digest");
        let map = scan_system(&paths).unwrap();
        let text = digest(&map, 40_000);
        assert!(text.contains("## Connections") && text.find("## Connections") < text.find("## Repositories"));
        assert!(text.contains("shop-web → shop-bff · GET /orders/* · verified · src/api.ts:1 → src/server.ts:1"), "{text}");
        assert!(text.contains("inferred"));
        assert!(text.contains("## Unresolved calls") && text.contains("redis: orders-core, orders-fn"));
        // A tight budget cuts the repositories, never the connections.
        let short = digest(&map, 900);
        assert!(short.contains("## Connections") && short.contains("verified"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn two_folders_with_the_same_name_stay_two_repositories() {
        let a = std::env::temp_dir().join(format!("cf-dup-a-{}", std::process::id())).join("api");
        let b = std::env::temp_dir().join(format!("cf-dup-b-{}", std::process::id())).join("api");
        for dir in [&a, &b] {
            write(dir, "package.json", "{}");
        }
        let map = scan_system(&[a.display().to_string(), b.display().to_string()]).unwrap();
        let names: Vec<&str> = map.cards.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["api", "api#2"]);
        for dir in [&a, &b] {
            let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        }
    }

    #[test]
    fn the_gateway_prefix_is_only_what_a_gateway_adds() {
        assert_eq!(without_gateway_prefix("/api/v1/orders/*"), "/orders/*");
        assert_eq!(without_gateway_prefix("/v2/reports/*"), "/reports/*");
        assert_eq!(without_gateway_prefix("/orders/*"), "/orders/*");
        assert_eq!(without_gateway_prefix("/api"), "/");
        assert_eq!(without_gateway_prefix("/very/api/x"), "/very/api/x");
    }
}
