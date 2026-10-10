//! One consistent picture of a repository's code — every file's facts plus what they add up to:
//! where each name is declared, which files use it, and which files import which.
//!
//! A [`Snapshot`] is immutable and shared (`Arc`): the agent's tools, the review and the map view
//! all read the same one, and a refresh builds a new one rather than editing it under a reader.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;

use super::extract::{Facts, Kind, Sym};
use super::resolve::{knows_imports, same_scope, Resolution, Resolver};

/// How many hops of re-exports (`export * from`, a package's `__init__.py`, `pub use`) are followed
/// when deciding whether a file reaches another.
const REEXPORT_DEPTH: usize = 3;

pub struct FileRow {
    pub path: String,
    pub facts: Arc<Facts>,
}

pub struct Snapshot {
    pub files: Vec<FileRow>,
    by_path: HashMap<String, u32>,
    decls: HashMap<String, Vec<(u32, u32)>>,
    users: HashMap<String, Vec<(u32, u32)>>,
    /// Files each file imports, re-exports followed.
    edges: Vec<Vec<u32>>,
    imported_by: Vec<Vec<u32>>,
    /// Whether a file's imports are all accounted for — the only files whose silence about a module
    /// can rule a use of it out.
    knows: Vec<bool>,
    /// Imports from outside the project, per file.
    external: Vec<Vec<String>>,
}

/// One declaration, as every query answers it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub path: String,
    pub name: String,
    pub kind: Kind,
    pub start: u32,
    pub end: u32,
    pub label: String,
    /// The enclosing symbol's name (a method's class).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Files that mention the name, its own excluded — by name, so an upper bound.
    pub used_by: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub path: String,
    pub line: u32,
    /// The declaration the use sits inside; empty at top level.
    pub signature: String,
    /// The file imports the declaring file (or shares its package): this is that symbol, not a
    /// namesake.
    pub confirmed: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub declarations: Vec<SymbolHit>,
    pub usages: Vec<Usage>,
    /// Files that mention the name but import nothing that declares it — namesakes, left out.
    pub ruled_out: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    pub name: String,
    pub kind: Kind,
    pub start: u32,
    pub end: u32,
    pub label: String,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOutline {
    pub path: String,
    pub lang: String,
    pub lines: u32,
    pub precise: bool,
    pub symbols: Vec<OutlineSymbol>,
    /// Project files this one imports.
    pub imports: Vec<String>,
    /// Imports from outside the project (packages, the standard library).
    pub external: Vec<String>,
    /// Project files that import this one.
    pub imported_by: Vec<String>,
}

impl Snapshot {
    pub fn build(mut rows: Vec<FileRow>) -> Snapshot {
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        let by_path: HashMap<String, u32> = rows.iter().enumerate().map(|(i, row)| (row.path.clone(), i as u32)).collect();

        let mut decls: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        for (file, row) in rows.iter().enumerate() {
            for (sym, symbol) in row.facts.symbols.iter().enumerate() {
                decls.entry(symbol.name.clone()).or_default().push((file as u32, sym as u32));
            }
        }
        let mut users: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
        for (file, row) in rows.iter().enumerate() {
            for (name, line) in &row.facts.refs {
                if decls.contains_key(name) {
                    users.entry(name.clone()).or_default().push((file as u32, *line));
                }
            }
        }

        let pairs: Vec<(&str, &Facts)> = rows.iter().map(|row| (row.path.as_str(), row.facts.as_ref())).collect();
        let resolver = Resolver::new(&pairs);
        let mut direct: Vec<Vec<u32>> = Vec::with_capacity(rows.len());
        let mut reexports: Vec<Vec<u32>> = Vec::with_capacity(rows.len());
        let mut knows = Vec::with_capacity(rows.len());
        let mut external = Vec::with_capacity(rows.len());
        for (file, row) in rows.iter().enumerate() {
            let file = file as u32;
            let mut missing = Vec::new();
            let mut outside = Vec::new();
            let mut collect = |specs: &[String], into: &mut Vec<u32>| {
                for spec in specs {
                    match resolver.resolve(file, &row.facts, spec) {
                        Resolution::Files(found) => into.extend(found.into_iter().filter(|f| *f != file)),
                        Resolution::Unresolved => missing.push(spec.clone()),
                        Resolution::External => outside.push(spec.clone()),
                    }
                }
            };
            let mut imports = Vec::new();
            collect(&row.facts.imports, &mut imports);
            let mut exported = Vec::new();
            collect(&row.facts.reexports, &mut exported);
            imports.extend(exported.iter().copied());
            imports.sort_unstable();
            imports.dedup();
            exported.sort_unstable();
            exported.dedup();
            knows.push(knows_imports(&row.facts.lang) && missing.is_empty());
            outside.dedup();
            external.push(outside);
            direct.push(imports);
            reexports.push(exported);
        }

        // Importing a barrel reaches what it re-exports.
        let mut edges = direct.clone();
        for (file, reached) in edges.iter_mut().enumerate() {
            let mut seen: HashSet<u32> = reached.iter().copied().collect();
            let mut frontier: Vec<u32> = direct[file].clone();
            for _ in 0..REEXPORT_DEPTH {
                let mut next = Vec::new();
                for via in frontier {
                    for target in &reexports[via as usize] {
                        if *target as usize != file && seen.insert(*target) {
                            next.push(*target);
                        }
                    }
                }
                if next.is_empty() {
                    break;
                }
                reached.extend(next.iter().copied());
                frontier = next;
            }
            reached.sort_unstable();
        }
        let mut imported_by = vec![Vec::new(); rows.len()];
        for (file, targets) in direct.iter().enumerate() {
            for target in targets {
                imported_by[*target as usize].push(file as u32);
            }
        }

        Snapshot { files: rows, by_path, decls, users, edges, imported_by, knows, external }
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn symbol_count(&self) -> usize {
        self.files.iter().map(|f| f.facts.symbols.len()).sum()
    }

    pub fn index_of(&self, path: &str) -> Option<u32> {
        let path = crate::review::outline::normalize_path(path);
        self.by_path.get(&path).copied().or_else(|| {
            // A path the caller spelled from somewhere else (`app/foo.ts` for `src/app/foo.ts`): one
            // file ending in it is that file; several are ambiguous.
            let needle = format!("/{path}");
            let mut hits = self.files.iter().enumerate().filter(|(_, row)| row.path.ends_with(&needle));
            match (hits.next(), hits.next()) {
                (Some((index, _)), None) => Some(index as u32),
                _ => None,
            }
        })
    }

    pub fn facts(&self, file: u32) -> &Facts {
        &self.files[file as usize].facts
    }

    pub fn path(&self, file: u32) -> &str {
        &self.files[file as usize].path
    }

    pub fn edges(&self, file: u32) -> &[u32] {
        &self.edges[file as usize]
    }

    pub fn imported_by(&self, file: u32) -> &[u32] {
        &self.imported_by[file as usize]
    }

    fn sym(&self, file: u32, sym: u32) -> &Sym {
        &self.facts(file).symbols[sym as usize]
    }

    /// Distinct files mentioning `name`, `except` excluded.
    pub fn mentions(&self, name: &str, except: u32) -> usize {
        let Some(users) = self.users.get(name) else { return 0 };
        let mut files: Vec<u32> = users.iter().map(|(f, _)| *f).filter(|f| *f != except).collect();
        files.dedup();
        files.len()
    }

    fn hit(&self, file: u32, sym: u32) -> SymbolHit {
        let symbol = self.sym(file, sym);
        SymbolHit {
            path: self.path(file).to_string(),
            name: symbol.name.clone(),
            kind: symbol.kind,
            start: symbol.start,
            end: symbol.end,
            label: symbol.label.clone(),
            parent: symbol.parent.and_then(|p| self.facts(file).symbols.get(p as usize)).map(|p| p.name.clone()),
            used_by: self.mentions(&symbol.name, file),
        }
    }

    /// Declarations named `query`: exact first, then ignoring case, then by prefix, then containing
    /// it — the best kind of match that finds anything wins.
    pub fn find_symbol(&self, query: &str, limit: usize) -> Vec<SymbolHit> {
        let query = query.trim().trim_end_matches("()");
        if query.is_empty() {
            return Vec::new();
        }
        // `Class.method` / `Class::method`: the method, inside that class.
        let (owner, wanted) = match query.rsplit_once("::").or_else(|| query.rsplit_once('.')) {
            Some((owner, member)) if !owner.is_empty() && !member.is_empty() => (Some(owner.rsplit(['.', ':']).next().unwrap_or(owner)), member),
            _ => (None, query),
        };
        let lower = wanted.to_lowercase();
        let mut ranked: Vec<(u8, (u32, u32))> = Vec::new();
        for (name, places) in &self.decls {
            let rank = if name == wanted {
                0
            } else {
                let name_lower = name.to_lowercase();
                if name_lower == lower {
                    1
                } else if name_lower.starts_with(&lower) {
                    2
                } else if lower.len() >= 3 && name_lower.contains(&lower) {
                    3
                } else {
                    continue;
                }
            };
            ranked.extend(places.iter().map(|place| (rank, *place)));
        }
        if let Some(owner) = owner {
            ranked.retain(|(_, (file, sym))| {
                let symbol = self.sym(*file, *sym);
                symbol.parent.and_then(|p| self.facts(*file).symbols.get(p as usize)).is_some_and(|p| p.name == owner)
            });
        }
        let best = ranked.iter().map(|(rank, _)| *rank).min();
        let mut hits: Vec<SymbolHit> = ranked
            .into_iter()
            .filter(|(rank, _)| Some(*rank) == best || *rank <= 1)
            .map(|(_, (file, sym))| self.hit(file, sym))
            .collect();
        hits.sort_by(|a, b| b.used_by.cmp(&a.used_by).then_with(|| a.path.cmp(&b.path)).then_with(|| a.start.cmp(&b.start)));
        hits.truncate(limit);
        hits
    }

    /// Whether `user` reaches `owner`: imports it (re-exports followed), or shares its package.
    pub fn links(&self, user: u32, owner: u32) -> bool {
        user == owner
            || self.edges(user).binary_search(&owner).is_ok()
            || same_scope(self.path(user), self.facts(user), self.path(owner), self.facts(owner))
    }

    /// The innermost declaration of `file` containing `line`.
    pub fn enclosing(&self, file: u32, line: u32) -> Option<&Sym> {
        self.facts(file).symbols.iter().filter(|s| s.start <= line && line <= s.end).min_by_key(|s| s.end - s.start)
    }

    /// Where `name` is used. With `in_file`, only the declaration in that file counts; without it,
    /// every declaration of the name does, and a use is attributed to whichever its file reaches.
    ///
    /// A file that mentions the name, imports nothing that declares it, and has every import of its
    /// own accounted for, is a namesake and is left out (`ruled_out`). Anything the imports cannot
    /// settle — another language, a file with an unresolved alias — is kept, unconfirmed.
    pub fn usages(&self, name: &str, in_file: Option<&str>, limit: usize) -> UsageReport {
        let name = name.trim().trim_end_matches("()");
        let name = name.rsplit(['.', ':']).next().unwrap_or(name);
        let Some(places) = self.decls.get(name) else { return UsageReport::default() };
        let home = in_file.and_then(|path| self.index_of(path));
        let places: Vec<(u32, u32)> = places.iter().copied().filter(|(file, _)| home.is_none_or(|h| h == *file)).collect();
        if places.is_empty() {
            return UsageReport::default();
        }
        let owners: Vec<u32> = {
            let mut owners: Vec<u32> = places.iter().map(|(file, _)| *file).collect();
            owners.dedup();
            owners
        };
        let mut report = UsageReport { declarations: places.iter().map(|(f, s)| self.hit(*f, *s)).collect(), ..Default::default() };
        let mut seen: HashSet<u32> = HashSet::new();
        for (file, line) in self.users.get(name).map(Vec::as_slice).unwrap_or_default() {
            if owners.contains(file) || !seen.insert(*file) {
                continue;
            }
            let confirmed = owners.iter().any(|owner| self.links(*file, *owner));
            if !confirmed {
                let user = self.facts(*file);
                let same_family = owners.iter().all(|owner| self.facts(*owner).lang == user.lang);
                if same_family && self.knows[*file as usize] {
                    report.ruled_out += 1;
                    continue;
                }
            }
            let signature = self.enclosing(*file, *line).map(|s| s.label.clone()).unwrap_or_default();
            report.usages.push(Usage { path: self.path(*file).to_string(), line: *line, signature, confirmed });
        }
        report.usages.sort_by(|a, b| b.confirmed.cmp(&a.confirmed).then_with(|| a.path.cmp(&b.path)));
        report.usages.truncate(limit);
        report
    }

    pub fn outline(&self, path: &str) -> Option<FileOutline> {
        let file = self.index_of(path)?;
        let facts = self.facts(file);
        let depth_of = |sym: &Sym| {
            let mut depth = 0;
            let mut parent = sym.parent;
            while let Some(p) = parent {
                depth += 1;
                parent = facts.symbols.get(p as usize).and_then(|s| s.parent);
            }
            depth
        };
        let symbols = facts
            .symbols
            .iter()
            .map(|s| OutlineSymbol { name: s.name.clone(), kind: s.kind, start: s.start, end: s.end, label: s.label.clone(), depth: depth_of(s) })
            .collect();
        Some(FileOutline {
            path: self.path(file).to_string(),
            lang: super::summary::language_name(&facts.lang).to_string(),
            lines: facts.lines,
            precise: facts.precise,
            symbols,
            imports: self.edges(file).iter().map(|f| self.path(*f).to_string()).collect(),
            external: self.external[file as usize].clone(),
            imported_by: self.imported_by(file).iter().map(|f| self.path(*f).to_string()).collect(),
        })
    }

    /// The module-level declarations other files use most — counting only files that reach the
    /// declaring file (by import or package), so a method name every file calls (`filter`, `push`)
    /// does not lead because of its namesakes.
    pub fn key_symbols(&self, limit: usize) -> Vec<SymbolHit> {
        let mut counted: Vec<(usize, u32, u32)> = Vec::new();
        for (name, places) in &self.decls {
            if !specific(name) {
                continue;
            }
            let Some(users) = self.users.get(name) else { continue };
            for (file, sym) in places {
                let symbol = self.sym(*file, *sym);
                if symbol.parent.is_some() || symbol.kind == Kind::Module {
                    continue;
                }
                let mut files: Vec<u32> = users.iter().map(|(f, _)| *f).filter(|f| f != file && self.links(*f, *file)).collect();
                files.dedup();
                if !files.is_empty() {
                    counted.push((files.len(), *file, *sym));
                }
            }
        }
        counted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| self.path(a.1).cmp(self.path(b.1))));
        counted
            .into_iter()
            .take(limit)
            .map(|(count, file, sym)| SymbolHit { used_by: count, ..self.hit(file, sym) })
            .collect()
    }
}

/// Whether a name is specific enough that its uses say something — `get`, `id`, `run` match
/// everywhere.
pub fn specific(name: &str) -> bool {
    const TOO_COMMON: [&str; 30] = [
        "get", "set", "run", "new", "add", "map", "of", "to", "on", "do", "is", "has", "at", "in", "for", "if", "value", "data",
        "name", "type", "item", "list", "main", "init", "props", "state", "default", "index", "test", "self",
    ];
    name.len() >= 4 && !TOO_COMMON.contains(&name.to_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codemap::extract::extract;

    fn snapshot(files: &[(&str, &str)]) -> Snapshot {
        Snapshot::build(
            files.iter().map(|(path, content)| FileRow { path: path.to_string(), facts: Arc::new(extract(path, content)) }).collect(),
        )
    }

    fn repo() -> Snapshot {
        snapshot(&[
            ("src/pricing.ts", "export function applyDiscount(price: number, pct: number) {\n  return price * pct;\n}\n"),
            ("src/cart.ts", "import { applyDiscount } from './pricing';\nexport function cartTotal(items) {\n  return applyDiscount(1, 2);\n}\n"),
            ("src/barrel/index.ts", "export * from '../pricing';\n"),
            ("src/checkout.ts", "import { applyDiscount } from './barrel';\nexport function pay() {\n  return applyDiscount(3, 4);\n}\n"),
            ("src/other.ts", "// applyDiscount in prose\nfunction applyDiscount(a) { return a; }\nexport const x = applyDiscount(1);\n"),
            ("src/legacy.ts", "export function useIt() {\n  return applyDiscount(5, 6);\n}\n"),
        ])
    }

    #[test]
    fn usages_follow_imports_and_barrels_and_rule_out_namesakes() {
        let map = repo();
        let report = map.usages("applyDiscount", Some("src/pricing.ts"), 50);
        let paths: Vec<&str> = report.usages.iter().map(|u| u.path.as_str()).collect();
        assert!(paths.contains(&"src/cart.ts"));
        assert!(paths.contains(&"src/checkout.ts"), "reached through the barrel's export *");
        assert!(!paths.contains(&"src/other.ts"), "declares its own namesake");
        assert!(!paths.contains(&"src/legacy.ts"), "imports nothing that declares it");
        assert_eq!(report.ruled_out, 2, "other.ts's own namesake and legacy.ts, which imports neither");
        assert!(report.usages.iter().all(|u| u.confirmed));
        let cart = report.usages.iter().find(|u| u.path == "src/cart.ts").unwrap();
        assert_eq!(cart.line, 1, "the first mention");
        assert!(map.usages("applyDiscount", Some("src/other.ts"), 50).usages.is_empty());
    }

    #[test]
    fn find_symbol_ranks_exact_matches_and_reads_class_members() {
        let map = snapshot(&[
            ("a.ts", "export class Cart {\n  total() { return 1; }\n}\nexport function totalize() {}\n"),
            ("b.ts", "export class Order {\n  total() { return 2; }\n}\n"),
        ]);
        let hits = map.find_symbol("total", 10);
        assert_eq!(hits.len(), 2, "both exact methods, not the prefix match: {hits:?}");
        let hits = map.find_symbol("Cart.total", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.ts");
        assert_eq!(hits[0].parent.as_deref(), Some("Cart"));
        let hits = map.find_symbol("totaliz", 10);
        assert_eq!(hits[0].name, "totalize");
    }

    #[test]
    fn an_unresolved_alias_keeps_its_uses_unconfirmed() {
        let map = snapshot(&[
            ("src/pricing.ts", "export function applyDiscount(p) { return p; }\n"),
            ("src/aliased.ts", "import { applyDiscount } from '@/somewhere/pricing';\nexport const y = applyDiscount(1);\n"),
        ]);
        let report = map.usages("applyDiscount", None, 10);
        assert_eq!(report.usages.len(), 1);
        assert!(!report.usages[0].confirmed, "the alias could be this file, or not");
    }

    #[test]
    fn outline_lists_symbols_imports_and_importers() {
        let map = repo();
        let outline = map.outline("src/pricing.ts").unwrap();
        assert_eq!(outline.symbols[0].name, "applyDiscount");
        assert!(outline.imported_by.contains(&"src/cart.ts".to_string()));
        let cart = map.outline("cart.ts").expect("a path ending is enough when it is unique");
        assert_eq!(cart.imports, vec!["src/pricing.ts"]);
    }

    #[test]
    fn key_symbols_lead_with_the_most_used() {
        let map = repo();
        let keys = map.key_symbols(5);
        assert_eq!(keys[0].name, "applyDiscount");
    }
}
