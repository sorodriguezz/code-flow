//! Blast radius: who else in the repository uses the symbols this pull request touched.
//!
//! The gap it closes is real and nothing else in the pipeline sees it. Every other input is
//! *intra-PR* — the diff, the bundles, the outline all describe the changed files and nothing
//! beyond them — so a signature change that breaks eleven call sites elsewhere in the repository
//! reads exactly like one that breaks none.
//!
//! **Built here rather than by an external indexer.** The transversal runbook shells out to
//! Graphify (Python + tree-sitter, installed with `uv`) and caches a networkx graph per branch.
//! That is not portable to an app that promises to install nothing on the user's machine, and it is
//! not necessary either: the repository is already checked out, `git2` reads any commit's tree
//! without touching the working directory, and the contract this feeds is explicitly *pointers
//! only* — `file:line` plus the enclosing signature, never source. A regex sweep over the target
//! branch answers exactly that question.
//!
//! It is a **hint, never a filter**: an empty result is the normal outcome for a repository of
//! configuration files, and nothing downstream is allowed to require it.

use std::collections::{BTreeMap, HashMap};

use regex::{escape, Regex, RegexSet};
use serde::Serialize;

use super::contract::{GraphConfig, ScopeConfig};
use super::outline::{declarations, normalize_path, symbol_name, ChangedFile};

/// Ceiling on how many files the sweep will open. A monorepo has tens of thousands, and this is a
/// hint — spending a minute of I/O on it would be worse than not having it.
const MAX_FILES_SCANNED: usize = 4_000;

/// Ceiling on total bytes read, for the same reason. Whichever ceiling is hit first stops the sweep.
const MAX_BYTES_SCANNED: usize = 16 * 1024 * 1024;

/// A file bigger than this is generated, vendored or minified in practice — never the caller
/// somebody wants to be told about.
const MAX_FILE_BYTES: usize = 512 * 1024;

/// One place that references a touched symbol.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    pub file: String,
    pub line: usize,
    /// The declaration the reference sits inside, so the pointer names a function rather than a
    /// line number in the void. Empty when the reference is at top level (an import, a constant).
    pub signature: String,
}

/// One touched symbol and everything that reaches it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Impact {
    pub symbol: String,
    /// Where the symbol is declared — the file the pull request changed.
    pub file: String,
    pub callers: Vec<Caller>,
    /// The real total, since `callers` is truncated.
    pub callers_total: usize,
}

/// Extensions worth sweeping. Anything else cannot call a function.
const CODE_EXT: [&str; 30] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "cs", "java", "kt",
    "kts", "scala", "swift", "dart", "go", "rs", "py", "rb", "php", "sql", "cls", "mac", "int",
    "inc", "c", "cpp", "h",
];

fn is_code(path: &str) -> bool {
    path.rsplit_once('.')
        .map(|(_, ext)| CODE_EXT.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Whether a name is worth looking for at all.
///
/// Short and generic identifiers (`get`, `id`, `run`, a single letter) match everywhere and would
/// bury a real caller under hundreds of coincidences. The blast radius is only useful when it is
/// specific, so an ambiguous name is dropped rather than reported badly.
fn is_searchable(name: &str) -> bool {
    const TOO_COMMON: [&str; 24] = [
        "get", "set", "run", "new", "add", "map", "id", "of", "to", "on", "do", "is", "has", "at",
        "in", "for", "if", "value", "data", "name", "type", "item", "list", "main",
    ];
    name.len() >= 4 && !TOO_COMMON.contains(&name.to_lowercase().as_str())
}

/// Every blob under `refname`, as `(path, content)`, bounded by the sweep's ceilings.
fn walk_tree(repo_path: &str, refname: &str, scope: &ScopeConfig) -> Vec<(String, String)> {
    let Ok(paths) = crate::git::diff::list_tree(repo_path, refname) else { return Vec::new() };

    let mut out = Vec::new();
    let mut bytes = 0usize;
    for path in paths {
        if out.len() >= MAX_FILES_SCANNED || bytes >= MAX_BYTES_SCANNED {
            break;
        }
        if !is_code(&path) || !super::plan::in_scope(&path, scope) {
            continue;
        }
        let Ok(content) = crate::git::diff::file_at_ref(repo_path, refname, &path) else { continue };
        if content.len() > MAX_FILE_BYTES {
            continue;
        }
        bytes += content.len();
        out.push((path, content));
    }
    out
}

/// The blast radius of the symbols `files` touched, resolved against `target_ref`.
///
/// Returns the widest radiuses first and truncates to the configured caps: a symbol with two
/// hundred callers is exactly the one worth knowing about, and exactly the one that must not enter
/// a prompt whole.
pub fn blast_radius(
    repo_path: &str,
    target_ref: &str,
    files: &[ChangedFile],
    scope: &ScopeConfig,
    cfg: &GraphConfig,
) -> Vec<Impact> {
    if !cfg.enabled {
        return Vec::new();
    }

    // Which symbol each searchable name belongs to. A name declared in two changed files is
    // ambiguous — reporting callers of "one of them" would be a guess, so it is dropped.
    let mut owner: BTreeMap<String, Option<String>> = BTreeMap::new();
    for file in files {
        for symbol in &file.symbols {
            let Some(name) = symbol_name(&symbol.label).filter(|n| is_searchable(n)) else { continue };
            owner
                .entry(name)
                .and_modify(|slot| {
                    if slot.as_deref() != Some(file.path.as_str()) {
                        *slot = None;
                    }
                })
                .or_insert_with(|| Some(file.path.clone()));
        }
    }
    let names: Vec<String> =
        owner.iter().filter(|(_, home)| home.is_some()).map(|(n, _)| n.clone()).collect();
    if names.is_empty() {
        return Vec::new();
    }

    // One pass per file for all names at once: a per-name scan over a whole repository is the
    // difference between a second and a minute.
    let patterns: Vec<String> = names.iter().map(|n| format!(r"\b{}\b", escape(n))).collect();
    let Ok(set) = RegexSet::new(&patterns) else { return Vec::new() };
    let compiled: Vec<Regex> = patterns.iter().filter_map(|p| Regex::new(p).ok()).collect();
    if compiled.len() != names.len() {
        return Vec::new();
    }

    let mut hits: HashMap<String, Vec<Caller>> = HashMap::new();
    for (path, content) in walk_tree(repo_path, target_ref, scope) {
        let matched: Vec<usize> = set.matches(&content).into_iter().collect();
        if matched.is_empty() {
            continue;
        }
        // Only resolved once, and only for a file that actually matched something.
        let decls = declarations(&path, &content);

        for index in matched {
            let name = &names[index];
            // A symbol's own declaration file is not a caller of itself.
            if owner
                .get(name)
                .and_then(|h| h.as_deref())
                .is_some_and(|home| super::outline::same_path(home, &path))
            {
                continue;
            }
            for (i, line) in content.lines().enumerate() {
                if !compiled[index].is_match(line) {
                    continue;
                }
                let lineno = i + 1;
                let signature = decls
                    .iter()
                    .filter(|d| d.start <= lineno && lineno <= d.end)
                    .next_back()
                    .map(|d| d.label.clone())
                    .unwrap_or_default();
                hits.entry(name.clone()).or_default().push(Caller {
                    file: normalize_path(&path),
                    line: lineno,
                    signature,
                });
                // One pointer per file per symbol: the point is "this file uses it", and eleven
                // lines of the same file crowd out ten other callers.
                break;
            }
        }
    }

    let mut out: Vec<Impact> = hits
        .into_iter()
        .filter_map(|(symbol, mut callers)| {
            let home = owner.get(&symbol)?.clone()?;
            callers.sort_by(|a, b| a.file.cmp(&b.file));
            let total = callers.len();
            callers.truncate(cfg.max_callers);
            Some(Impact { symbol, file: home, callers, callers_total: total })
        })
        .collect();

    out.sort_by(|a, b| b.callers_total.cmp(&a.callers_total).then_with(|| a.symbol.cmp(&b.symbol)));
    out.truncate(cfg.max_symbols);
    out
}

/// The blast radius rendered as one review-prompt context block.
///
/// Stated as pointers and framed as a hint, because that is what it is: the sweep proves a name
/// appears there, not that it is the same symbol. Telling the model to go look is right; telling it
/// these are definitely callers would not be.
pub fn block(impacts: &[Impact]) -> Option<String> {
    if impacts.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nOtros lugares del repositorio que mencionan los símbolos que toca este PR. Es una \
         PISTA, no una certeza: se detectó por nombre, así que confirma abriendo el archivo antes \
         de reportar nada. Úsalo sobre todo para cambios de contrato o de firma — si el cambio \
         rompe a alguno de estos, ese es un hallazgo.\n\n",
    );
    for impact in impacts {
        out.push_str(&format!("- `{}` ({}) — {} referencia(s):\n", impact.symbol, impact.file, impact.callers_total));
        for caller in &impact.callers {
            match caller.signature.is_empty() {
                true => out.push_str(&format!("  - `{}:{}`\n", caller.file, caller.line)),
                false => out.push_str(&format!("  - `{}:{}` — {}\n", caller.file, caller.line, caller.signature)),
            }
        }
        if impact.callers_total > impact.callers.len() {
            out.push_str(&format!("  - (+{} más)\n", impact.callers_total - impact.callers.len()));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_specific_names_are_worth_searching_for() {
        assert!(is_searchable("PagoRepository"));
        assert!(is_searchable("guardarPago"));
        assert!(!is_searchable("get"), "would match everywhere");
        assert!(!is_searchable("id"));
        assert!(!is_searchable("x"));
    }

    #[test]
    fn only_files_that_could_call_something_are_swept() {
        assert!(is_code("src/a.ts"));
        assert!(is_code("Pkg/Cls.cls"));
        assert!(!is_code("README.md"));
        assert!(!is_code("logo.png"));
        assert!(!is_code("Makefile"));
    }

    #[test]
    fn a_disabled_graph_costs_nothing() {
        let cfg = GraphConfig { enabled: false, ..Default::default() };
        let impacts = blast_radius("/nonexistent", "main", &[], &ScopeConfig::default(), &cfg);
        assert!(impacts.is_empty());
    }

    /// A repository that cannot be read is a missing hint, never a failed review.
    #[test]
    fn an_unreadable_repository_yields_no_hint_rather_than_an_error() {
        let impacts = blast_radius(
            "/definitely/not/a/repo",
            "main",
            &[],
            &ScopeConfig::default(),
            &GraphConfig::default(),
        );
        assert!(impacts.is_empty());
    }

    #[test]
    fn the_block_is_absent_when_there_is_nothing_to_say() {
        assert!(block(&[]).is_none());
    }

    #[test]
    fn the_block_names_pointers_and_says_how_many_were_left_out() {
        let impacts = vec![Impact {
            symbol: "guardarPago".into(),
            file: "src/services/pago.ts".into(),
            callers: vec![Caller {
                file: "src/controllers/pagoController.ts".into(),
                line: 42,
                signature: "async function crearPago(req, res)".into(),
            }],
            callers_total: 12,
        }];
        let block = block(&impacts).expect("impacts produce a block");
        assert!(block.contains("guardarPago"));
        assert!(block.contains("src/controllers/pagoController.ts:42"));
        assert!(block.contains("crearPago"));
        assert!(block.contains("(+11 más)"));
        assert!(block.contains("PISTA"), "it is framed as a hint, not as a fact");
    }
}
