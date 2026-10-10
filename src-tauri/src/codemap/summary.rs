//! The repository map as text a model reads before its first step, and as a graph the map view
//! draws.
//!
//! **The text degrades, it is never cut.** A small project is listed whole, every file with the
//! names it declares — what lets a 7B open `src/pricing.js` for a discount bug instead of searching
//! for prose. When that does not fit the budget, the map becomes folders with their sizes and the
//! most-used symbols with where they live, and says which tools reach the rest.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use super::extract::Kind;
use super::index::Snapshot;
use super::resolve::dir_of;

/// Names listed per file in the detailed map.
const NAMES_PER_FILE: usize = 8;
/// Folder lines in the compact map.
const MAX_FOLDER_LINES: usize = 60;

fn shown_name(name: &str, kind: Kind) -> String {
    match kind {
        Kind::Function | Kind::Method => format!("{name}()"),
        Kind::Class | Kind::Interface | Kind::Type | Kind::Enum | Kind::Module => format!("{} {name}", kind.word()),
        Kind::Const => name.to_string(),
    }
}

/// What one code file declares, as one line: top-level names, a class with its members in braces.
fn file_line(map: &Snapshot, file: u32) -> String {
    let facts = map.facts(file);
    let mut parts: Vec<String> = Vec::new();
    let mut count = 0usize;
    for (index, symbol) in facts.symbols.iter().enumerate() {
        if symbol.parent.is_some() {
            continue;
        }
        if count >= NAMES_PER_FILE {
            parts.push("…".to_string());
            break;
        }
        count += 1;
        let members: Vec<&str> = facts
            .symbols
            .iter()
            .filter(|s| s.parent == Some(index as u32))
            .map(|s| s.name.as_str())
            .take(NAMES_PER_FILE)
            .collect();
        let shown = shown_name(&symbol.name, symbol.kind);
        if members.is_empty() {
            parts.push(shown);
        } else {
            let more = facts.symbols.iter().filter(|s| s.parent == Some(index as u32)).count() > members.len();
            parts.push(format!("{shown} {{ {}{} }}", members.join(", "), if more { ", …" } else { "" }));
        }
    }
    parts.join(", ")
}

/// The detailed map: every file, code files with what they declare.
fn detailed(map: &Snapshot, all_files: &[String]) -> String {
    let mut out = String::new();
    for path in all_files {
        out.push_str(path);
        if let Some(file) = map.index_of(path).filter(|f| map.path(*f) == path) {
            let line = file_line(map, file);
            if !line.is_empty() {
                out.push_str(" — ");
                out.push_str(&line);
            }
        }
        out.push('\n');
    }
    out
}

/// The compact map: folders with their file counts, then the most-used symbols.
fn compact(map: &Snapshot, all_files: &[String], budget: usize) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut root_files: Vec<&str> = Vec::new();
    for path in all_files {
        let dir = dir_of(path);
        if dir.is_empty() {
            root_files.push(path);
            continue;
        }
        // Counted at every level up to three deep, so `src/` shows its whole size.
        let segments: Vec<&str> = dir.split('/').collect();
        for depth in 1..=segments.len().min(3) {
            *counts.entry(segments[..depth].join("/")).or_default() += 1;
        }
    }
    let mut out = format!(
        "Project map — {} files, {} code files ({}), {} declarations. Too large to list whole: use find_symbol to locate a function or class, find_files for a file, outline for what a file declares.\n\nFolders (files):\n",
        all_files.len(),
        map.file_count(),
        languages(map).iter().map(|(lang, n)| format!("{lang} {n}")).collect::<Vec<_>>().join(", "),
        map.symbol_count(),
    );
    // Biggest folders first within each parent, three levels at most.
    let mut lines = 0usize;
    let mut children: HashMap<String, Vec<(&String, usize)>> = HashMap::new();
    for (dir, count) in &counts {
        children.entry(dir_of(dir).to_string()).or_default().push((dir, *count));
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    }
    let mut stack: Vec<(String, usize)> = vec![(String::new(), 0)];
    while let Some((parent, depth)) = stack.pop() {
        let Some(list) = children.get(&parent) else { continue };
        let mut next = Vec::new();
        for (dir, count) in list.iter() {
            if lines >= MAX_FOLDER_LINES {
                break;
            }
            out.push_str(&format!("{}{dir}/ ({count})\n", "  ".repeat(depth)));
            lines += 1;
            if depth < 2 {
                next.push(((*dir).clone(), depth + 1));
            }
        }
        // Depth-first in the listed order: the stack pops the last pushed first.
        for child in next.into_iter().rev() {
            stack.push(child);
        }
    }
    if !root_files.is_empty() {
        out.push_str(&format!("Root files: {}\n", root_files.iter().take(30).copied().collect::<Vec<_>>().join(", ")));
    }
    out.push_str("\nMost-used declarations (name — where · files that mention it):\n");
    for hit in map.key_symbols(200) {
        let line = format!("{} — {}:{} · {}\n", shown_name(&hit.name, hit.kind), hit.path, hit.start, hit.used_by);
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// The map a model reads, within `budget` characters. `all_files` is every file of the project,
/// code or not, in display order.
pub fn project_map(map: &Snapshot, all_files: &[String], budget: usize) -> String {
    let detailed = detailed(map, all_files);
    if detailed.len() <= budget {
        return format!("Project files, with what each code file declares:\n{detailed}");
    }
    compact(map, all_files, budget)
}

pub fn languages(map: &Snapshot) -> Vec<(String, usize)> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in &map.files {
        *counts.entry(language_name(&row.facts.lang).to_string()).or_default() += 1;
    }
    let mut list: Vec<(String, usize)> = counts.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list
}

pub fn language_name(family: &str) -> &str {
    match family {
        "ts" => "TypeScript/JavaScript",
        "java" => "Java/Kotlin",
        "cs" => "C#",
        "py" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "php" => "PHP",
        "rb" => "Ruby",
        "swift" => "Swift",
        "dart" => "Dart",
        "c" => "C/C++",
        "sql" => "SQL",
        "cos" => "ObjectScript",
        "sh" => "Shell",
        "ps" => "PowerShell",
        other => other,
    }
}

// ------------------------------------------------------------------------------------ tool text

/// What `find_symbol` answers, for a model to read: one declaration per line.
pub fn symbols_text(hits: &[super::index::SymbolHit], query: &str) -> String {
    if hits.is_empty() {
        return format!("No declaration named {query:?}. Try a shorter part of the name, or search the text.");
    }
    hits.iter()
        .map(|hit| {
            let owner = hit.parent.as_deref().map(|p| format!(" in {p}")).unwrap_or_default();
            format!(
                "{}:{}-{}  {} {}{}  — {}  (mentioned in {} other file{})",
                hit.path,
                hit.start,
                hit.end,
                hit.kind.word(),
                hit.name,
                owner,
                hit.label,
                hit.used_by,
                if hit.used_by == 1 { "" } else { "s" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What `find_usages` answers.
pub fn usages_text(report: &super::index::UsageReport, name: &str) -> String {
    if report.declarations.is_empty() {
        return format!("No declaration named {name:?} in this project.");
    }
    let mut out = String::from("Declared at:\n");
    for hit in &report.declarations {
        out.push_str(&format!("  {}:{}  {}\n", hit.path, hit.start, hit.label));
    }
    if report.usages.is_empty() {
        out.push_str("No other file uses it.");
    } else {
        out.push_str("Used in:\n");
        for usage in &report.usages {
            let inside = if usage.signature.is_empty() { String::new() } else { format!("  (in {})", usage.signature) };
            let unsure = if usage.confirmed { "" } else { "  [by name only]" };
            out.push_str(&format!("  {}:{}{inside}{unsure}\n", usage.path, usage.line));
        }
    }
    if report.ruled_out > 0 {
        // Worded so it cannot be read as more users: a model once summarised "1 other file mentions
        // the name" as "it's also used by one other file".
        out.push_str(&format!(
            "\nNot uses of this one: {} other file{} {} its own, different {name} (or mention{} the name without importing this file) — leave {} out.",
            report.ruled_out,
            if report.ruled_out == 1 { "" } else { "s" },
            if report.ruled_out == 1 { "has" } else { "have" },
            if report.ruled_out == 1 { "s" } else { "" },
            if report.ruled_out == 1 { "it" } else { "them" },
        ));
    }
    out.trim_end().to_string()
}

/// What `outline` answers: the file's declarations with their line ranges, and its neighbours.
pub fn outline_text(outline: &super::index::FileOutline) -> String {
    let mut out = format!("{} — {} lines\n", outline.path, outline.lines);
    if outline.symbols.is_empty() {
        out.push_str("No declarations found.\n");
    }
    for symbol in &outline.symbols {
        out.push_str(&format!(
            "{}{}-{}  {} {}\n",
            "  ".repeat(symbol.depth as usize + 1),
            symbol.start,
            symbol.end,
            symbol.kind.word(),
            symbol.name
        ));
    }
    if !outline.imports.is_empty() {
        out.push_str(&format!("Imports: {}\n", outline.imports.join(", ")));
    }
    if !outline.imported_by.is_empty() {
        let shown: Vec<&str> = outline.imported_by.iter().take(20).map(String::as_str).collect();
        let more = outline.imported_by.len().saturating_sub(shown.len());
        out.push_str(&format!(
            "Imported by: {}{}\n",
            shown.join(", "),
            if more > 0 { format!(" and {more} more") } else { String::new() }
        ));
    }
    out.trim_end().to_string()
}

// ------------------------------------------------------------------------------- starting points

/// Words too common in a story to say anything about where it lands.
const STOPWORDS: &[&str] = &[
    "para", "como", "cuando", "donde", "desde", "hasta", "sobre", "entre", "este", "esta", "estos", "estas", "debe", "deben",
    "puede", "pueden", "quiero", "usuario", "usuarios", "sistema", "dado", "entonces", "cuando", "tiene", "tener", "hacer",
    "nuevo", "nueva", "todos", "todas", "cada", "solo", "otro", "otra", "with", "that", "this", "should", "when", "then",
    "given", "user", "users", "want", "from", "have", "into", "they", "their", "will", "able", "also", "como", "para",
    "historia", "criterio", "criterios", "aceptacion", "acceptance", "story", "feature", "scenario", "escenario",
];

fn fold(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'Á' => 'a',
            'é' | 'è' | 'ë' | 'ê' | 'É' => 'e',
            'í' | 'ì' | 'ï' | 'î' | 'Í' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'Ó' => 'o',
            'ú' | 'ù' | 'ü' | 'û' | 'Ú' => 'u',
            'ñ' | 'Ñ' => 'n',
            other => other.to_ascii_lowercase(),
        })
        .collect()
}

/// `PagoService` → `pago`, `service`; `guardar_pago` → `guardar`, `pago`.
fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        current.push(c);
    }
    if !current.is_empty() {
        words.push(current);
    }
    words.into_iter().map(|w| fold(&w)).filter(|w| w.len() >= 4).collect()
}

fn story_words(text: &str) -> std::collections::HashSet<String> {
    fold(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 4 && !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// Whether two words name the same thing: equal, or one a prefix of the other past five letters
/// (`pago` / `pagos`, `factura` / `facturacion`).
fn same_word(a: &str, b: &str) -> bool {
    a == b || (a.len().min(b.len()) >= 5 && (a.starts_with(b) || b.starts_with(a)))
}

/// The files a piece of prose — a user story — most plausibly lands in: those whose declarations
/// and path share its words, weighted towards declarations and, a little, towards what many files
/// use. A hint for an analyst to start reading from, stated as one — it matches words, not meaning.
pub fn starting_points(map: &Snapshot, text: &str, limit: usize) -> Vec<(String, Vec<String>)> {
    let words = story_words(text);
    if words.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(f64, String, Vec<String>)> = Vec::new();
    for (index, row) in map.files.iter().enumerate() {
        let mut score = 0.0;
        let mut hits: Vec<String> = Vec::new();
        for symbol in &row.facts.symbols {
            let matched = name_words(&symbol.name).iter().filter(|w| words.iter().any(|s| same_word(w, s))).count();
            if matched > 0 {
                score += 3.0 * matched as f64;
                if !hits.contains(&symbol.name) && hits.len() < 6 {
                    hits.push(symbol.name.clone());
                }
            }
        }
        let path_matches = row.path.split('/').flat_map(|segment| name_words(super::resolve::stem(segment))).filter(|w| words.iter().any(|s| same_word(w, s))).count();
        score += 2.0 * path_matches as f64;
        if score == 0.0 {
            continue;
        }
        score += (map.imported_by(index as u32).len() as f64 + 1.0).ln() * 0.5;
        scored.push((score, row.path.clone(), hits));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, path, hits)| (path, hits)).collect()
}

// ------------------------------------------------------------------------------------------ graph

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    /// A folder (`src/lib`) or a file path.
    pub id: String,
    pub label: String,
    pub folder: bool,
    pub files: usize,
    pub symbols: usize,
    pub lines: u64,
    /// The language most of it is written in.
    pub lang: String,
    /// Files outside this node that import something in it.
    pub imported_by: usize,
    /// The top-level folder it belongs to (`src`, `src-tauri`…), `""` at the root — what the global
    /// view colours by.
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEdge {
    pub from: String,
    pub to: String,
    /// Import relationships between the two (file → file pairs).
    pub weight: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapGraph {
    /// The folder shown, `""` for the root.
    pub focus: String,
    pub nodes: Vec<MapNode>,
    pub edges: Vec<MapEdge>,
    pub files: usize,
    pub symbols: usize,
    pub languages: Vec<(String, usize)>,
}

/// The node a path belongs to when looking at `focus`: its child folder, or the file itself when it
/// sits directly in `focus`. `None` outside `focus`.
fn group_of(path: &str, focus: &str) -> Option<(String, bool)> {
    let rest = if focus.is_empty() { path } else { path.strip_prefix(focus)?.strip_prefix('/')? };
    match rest.split_once('/') {
        Some((child, _)) => Some((if focus.is_empty() { child.to_string() } else { format!("{focus}/{child}") }, true)),
        None => Some((path.to_string(), false)),
    }
}

/// The map one level below `focus`: its subfolders and its own files, and the imports between them.
/// A focus with a single subfolder and no files of its own opens that subfolder instead — a
/// `src/` that holds everything is a click nobody needs.
pub fn graph(map: &Snapshot, focus: &str) -> MapGraph {
    let mut focus = focus.trim_matches('/').to_string();
    loop {
        let mut groups: Vec<(String, bool)> =
            map.files.iter().filter_map(|row| group_of(&row.path, &focus)).collect::<Vec<_>>();
        groups.sort();
        groups.dedup();
        match groups.as_slice() {
            [(only, true)] => focus = only.clone(),
            _ => break,
        }
    }

    struct Acc {
        folder: bool,
        files: usize,
        symbols: usize,
        lines: u64,
        langs: HashMap<String, usize>,
        imported_by: std::collections::HashSet<u32>,
    }
    let mut nodes: BTreeMap<String, Acc> = BTreeMap::new();
    let mut member: Vec<Option<String>> = Vec::with_capacity(map.files.len());
    for row in &map.files {
        let group = group_of(&row.path, &focus);
        if let Some((id, folder)) = &group {
            let acc = nodes.entry(id.clone()).or_insert_with(|| Acc {
                folder: *folder,
                files: 0,
                symbols: 0,
                lines: 0,
                langs: HashMap::new(),
                imported_by: Default::default(),
            });
            acc.files += 1;
            acc.symbols += row.facts.symbols.len();
            acc.lines += row.facts.lines as u64;
            *acc.langs.entry(row.facts.lang.clone()).or_default() += 1;
        }
        member.push(group.map(|(id, _)| id));
    }
    let mut weights: HashMap<(String, String), usize> = HashMap::new();
    for (file, from) in member.iter().enumerate() {
        for target in map.edges(file as u32) {
            let to = &member[*target as usize];
            match (from, to) {
                (Some(from), Some(to)) if from != to => {
                    *weights.entry((from.clone(), to.clone())).or_default() += 1;
                    if let Some(acc) = nodes.get_mut(to) {
                        acc.imported_by.insert(file as u32);
                    }
                }
                // Imported from outside the focus: still counts towards how central it is.
                (None, Some(to)) => {
                    if let Some(acc) = nodes.get_mut(to) {
                        acc.imported_by.insert(file as u32);
                    }
                }
                _ => {}
            }
        }
    }
    let nodes: Vec<MapNode> = nodes
        .into_iter()
        .map(|(id, acc)| {
            let label = id.rsplit('/').next().unwrap_or(&id).to_string();
            let lang = acc.langs.iter().max_by_key(|(_, n)| **n).map(|(l, _)| language_name(l).to_string()).unwrap_or_default();
            let group = if acc.folder || id.contains('/') { id.split('/').next().unwrap_or_default().to_string() } else { String::new() };
            MapNode { label, folder: acc.folder, files: acc.files, symbols: acc.symbols, lines: acc.lines, lang, imported_by: acc.imported_by.len(), group, id }
        })
        .collect();
    let mut edges: Vec<MapEdge> = weights.into_iter().map(|((from, to), weight)| MapEdge { from, to, weight }).collect();
    edges.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.to.cmp(&b.to)));
    MapGraph { focus, nodes, edges, files: map.file_count(), symbols: map.symbol_count(), languages: languages(map) }
}

/// The node a file belongs to in the global view: itself (`None`, every file shown), or its folder
/// cut to at most `depth` segments — a file directly in `src-tauri/src` belongs to that folder's node,
/// not to a node of its own, or a shallow folder of a hundred files would fill the canvas alone. A
/// file at the repository root is always its own node.
fn global_key(path: &str, depth: Option<usize>) -> (String, bool) {
    let dir = dir_of(path);
    match depth {
        Some(depth) if !dir.is_empty() => {
            let segments: Vec<&str> = dir.split('/').collect();
            (segments[..depth.min(segments.len())].join("/"), true)
        }
        _ => (path.to_string(), false),
    }
}

/// The whole project on one canvas: every file when they fit in `max_nodes`, otherwise folders cut
/// at the deepest level that still fits — the finest picture of the whole that can be read at once.
/// Imports between the nodes are the edges; `group` (the top-level folder) is what tells the
/// regions apart.
pub fn global_graph(map: &Snapshot, max_nodes: usize) -> MapGraph {
    let deepest = map.files.iter().map(|f| dir_of(&f.path).split('/').filter(|s| !s.is_empty()).count()).max().unwrap_or(0);
    let count = |depth: Option<usize>| {
        let mut keys: Vec<String> = map.files.iter().map(|f| global_key(&f.path, depth).0).collect();
        keys.sort();
        keys.dedup();
        keys.len()
    };
    let depth = if map.file_count() <= max_nodes {
        None
    } else {
        Some((1..=deepest.max(1)).rev().find(|d| count(Some(*d)) <= max_nodes).unwrap_or(1))
    };

    struct Acc {
        folder: bool,
        files: usize,
        symbols: usize,
        lines: u64,
        langs: HashMap<String, usize>,
        imported_by: std::collections::HashSet<u32>,
    }
    let mut nodes: BTreeMap<String, Acc> = BTreeMap::new();
    let member: Vec<String> = map
        .files
        .iter()
        .map(|row| {
            let (id, folder) = global_key(&row.path, depth);
            let acc = nodes.entry(id.clone()).or_insert_with(|| Acc {
                folder,
                files: 0,
                symbols: 0,
                lines: 0,
                langs: HashMap::new(),
                imported_by: Default::default(),
            });
            acc.files += 1;
            acc.symbols += row.facts.symbols.len();
            acc.lines += row.facts.lines as u64;
            *acc.langs.entry(row.facts.lang.clone()).or_default() += 1;
            id
        })
        .collect();
    let mut weights: HashMap<(String, String), usize> = HashMap::new();
    for (file, from) in member.iter().enumerate() {
        for target in map.edges(file as u32) {
            let to = &member[*target as usize];
            if from != to {
                *weights.entry((from.clone(), to.clone())).or_default() += 1;
                if let Some(acc) = nodes.get_mut(to) {
                    acc.imported_by.insert(file as u32);
                }
            }
        }
    }
    let nodes: Vec<MapNode> = nodes
        .into_iter()
        .map(|(id, acc)| {
            let label = id.rsplit('/').next().unwrap_or(&id).to_string();
            let lang = acc.langs.iter().max_by_key(|(_, n)| **n).map(|(l, _)| language_name(l).to_string()).unwrap_or_default();
            let group = if id.contains('/') || acc.folder { id.split('/').next().unwrap_or_default().to_string() } else { String::new() };
            MapNode { label, folder: acc.folder, files: acc.files, symbols: acc.symbols, lines: acc.lines, lang, imported_by: acc.imported_by.len(), group, id }
        })
        .collect();
    let mut edges: Vec<MapEdge> = weights.into_iter().map(|((from, to), weight)| MapEdge { from, to, weight }).collect();
    edges.sort_by(|a, b| a.from.cmp(&b.from).then_with(|| a.to.cmp(&b.to)));
    MapGraph { focus: String::new(), nodes, edges, files: map.file_count(), symbols: map.symbol_count(), languages: languages(map) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codemap::extract::extract;
    use crate::codemap::index::FileRow;
    use std::sync::Arc;

    fn snapshot(files: &[(&str, &str)]) -> Snapshot {
        Snapshot::build(
            files.iter().map(|(path, content)| FileRow { path: path.to_string(), facts: Arc::new(extract(path, content)) }).collect(),
        )
    }

    #[test]
    fn a_small_project_is_listed_whole_with_its_names() {
        let map = snapshot(&[
            ("src/cart.js", "function cartTotal(items) { return 0; }\nmodule.exports = { cartTotal };\n"),
            ("src/repo.ts", "export class PagoRepository {\n  guardar() {}\n  buscar() {}\n}\n"),
        ]);
        let all = vec!["README.md".to_string(), "src/cart.js".to_string(), "src/repo.ts".to_string()];
        let text = project_map(&map, &all, 4_000);
        assert!(text.contains("README.md\n"));
        assert!(text.contains("src/cart.js — cartTotal()"), "{text}");
        assert!(text.contains("src/repo.ts — class PagoRepository { guardar, buscar }"), "{text}");
    }

    #[test]
    fn a_large_project_becomes_folders_and_key_symbols_within_budget() {
        let mut files: Vec<(String, String)> = Vec::new();
        files.push(("src/lib/pricing.ts".into(), "export function applyDiscount(p: number) { return p; }\n".into()));
        for i in 0..80 {
            files.push((format!("src/feature{i}/view{i}.ts"), format!("import {{ applyDiscount }} from '../lib/pricing';\nexport function view{i}() {{ return applyDiscount({i}); }}\n")));
        }
        let rows: Vec<(&str, &str)> = files.iter().map(|(p, c)| (p.as_str(), c.as_str())).collect();
        let map = snapshot(&rows);
        let all: Vec<String> = files.iter().map(|(p, _)| p.clone()).collect();
        let text = project_map(&map, &all, 2_000);
        assert!(text.len() <= 2_000 + 200, "stays near the budget: {}", text.len());
        assert!(text.starts_with("Project map"));
        assert!(text.contains("src/ (81)"));
        assert!(text.contains("applyDiscount() — src/lib/pricing.ts:1 · 80"), "{text}");
    }

    #[test]
    fn the_global_view_shows_every_file_when_it_fits_and_folders_when_it_does_not() {
        let map = snapshot(&[
            ("src/lib/pricing.ts", "export function applyDiscount(p) { return p; }\n"),
            ("src/app/cart.ts", "import { applyDiscount } from '../lib/pricing';\nexport const c = applyDiscount(1);\n"),
            ("src/app/deep/checkout.ts", "import { applyDiscount } from '../../lib/pricing';\nexport const d = applyDiscount(2);\n"),
            ("build.ts", "export const x = 1;\n"),
        ]);
        let whole = global_graph(&map, 100);
        let ids: Vec<&str> = whole.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["build.ts", "src/app/cart.ts", "src/app/deep/checkout.ts", "src/lib/pricing.ts"], "every file");
        assert!(whole.edges.iter().any(|e| e.from == "src/app/deep/checkout.ts" && e.to == "src/lib/pricing.ts"));
        assert_eq!(whole.nodes.iter().find(|n| n.id == "src/lib/pricing.ts").unwrap().group, "src");
        assert_eq!(whole.nodes.iter().find(|n| n.id == "build.ts").unwrap().group, "");

        let folded = global_graph(&map, 3);
        let ids: Vec<&str> = folded.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["build.ts", "src/app", "src/lib"], "folders at the deepest level that fits");
        let edge = folded.edges.iter().find(|e| e.from == "src/app" && e.to == "src/lib").unwrap();
        assert_eq!(edge.weight, 2);
    }

    #[test]
    fn a_story_points_at_the_files_that_share_its_words() {
        let map = snapshot(&[
            ("src/pagos/PagoService.ts", "export class PagoService {\n  registrarPago() {}\n}\n"),
            ("src/facturas/facturacion.ts", "export function emitirFactura() {}\n"),
            ("src/ui/Header.ts", "export function Header() {}\n"),
        ]);
        let points = starting_points(&map, "Como usuario quiero registrar un pago con tarjeta y que se emita la factura.", 5);
        let paths: Vec<&str> = points.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths.first(), Some(&"src/pagos/PagoService.ts"), "{points:?}");
        assert!(paths.contains(&"src/facturas/facturacion.ts"));
        assert!(!paths.contains(&"src/ui/Header.ts"));
        assert!(points[0].1.contains(&"registrarPago".to_string()));
    }

    #[test]
    fn the_graph_groups_by_folder_and_skips_a_lone_root() {
        let map = snapshot(&[
            ("src/lib/pricing.ts", "export function applyDiscount(p) { return p; }\n"),
            ("src/app/cart.ts", "import { applyDiscount } from '../lib/pricing';\nexport const c = applyDiscount(1);\n"),
            ("src/app/checkout.ts", "import { applyDiscount } from '../lib/pricing';\nexport const d = applyDiscount(2);\n"),
            ("src/main.ts", "import './app/cart';\n"),
        ]);
        let graph = graph(&map, "");
        assert_eq!(graph.focus, "src", "the only top folder opens by itself");
        let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec!["src/app", "src/lib", "src/main.ts"]);
        let edge = graph.edges.iter().find(|e| e.from == "src/app" && e.to == "src/lib").unwrap();
        assert_eq!(edge.weight, 2);
        let lib = graph.nodes.iter().find(|n| n.id == "src/lib").unwrap();
        assert_eq!(lib.imported_by, 2);
        let inner = super::graph(&map, "src/app");
        assert_eq!(inner.nodes.len(), 2);
        assert!(inner.edges.is_empty(), "imports leaving the focus are not edges");
    }
}
