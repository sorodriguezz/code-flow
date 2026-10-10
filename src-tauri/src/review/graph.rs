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
//! not necessary either: the repository map (`codemap`) reads any commit's tree straight out of
//! git's object database, with tree-sitter compiled in for the languages most code here is written
//! in, and caches every file by blob id — so the target branch of a review is mostly a cache hit.
//!
//! What the map adds over the name sweep this used to be:
//! - **Imports, not names.** A file that mentions `guardar` but imports nothing that declares the
//!   touched one is a namesake and is left out; a use the imports cannot settle (another language,
//!   an alias nothing resolves) stays, marked as found by name.
//! - **No ceiling.** The sweep stopped at 4,000 files or 16 MB to stay fast; the cache made that
//!   unnecessary.
//! - **Contract changes.** The touched declaration is compared with the target branch's: a changed
//!   signature, or a symbol the PR removed or renamed while files outside it still use the old one,
//!   leads the list — the case the whole block exists for.
//!
//! It is a **hint, never a filter**: an empty result is the normal outcome for a repository of
//! configuration files, and nothing downstream is allowed to require it.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;

use super::contract::{GraphConfig, ScopeConfig};
use super::outline::{normalize_path, same_path, ChangedFile};
use crate::codemap::extract::{self, Sym};

/// One place that references a touched symbol.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    pub file: String,
    pub line: usize,
    /// The declaration the reference sits inside, so the pointer names a function rather than a
    /// line number in the void. Empty when the reference is at top level (an import, a constant).
    pub signature: String,
    /// The file imports the declaring module (or shares its package). `false`: found by name only.
    pub confirmed: bool,
}

/// What the PR did to a symbol's contract, when it did something to it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ContractChange {
    /// The declaration up to its body differs from the target branch's.
    Signature { before: String, after: String },
    /// Declared on the target branch, gone from the PR's version of the file.
    Removed,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<ContractChange>,
}

/// Whether a name is worth looking for at all.
///
/// Short and generic identifiers (`get`, `id`, `run`, a single letter) match everywhere and would
/// bury a real caller under hundreds of coincidences. The blast radius is only useful when it is
/// specific, so an ambiguous name is dropped rather than reported badly.
fn is_searchable(name: &str) -> bool {
    crate::codemap::index::specific(name)
}

/// The declarations of `symbols` that contain a changed line — the innermost one for each line.
fn touched<'a>(symbols: &'a [Sym], changed: &std::collections::BTreeSet<usize>) -> Vec<&'a Sym> {
    let mut out: Vec<&Sym> = Vec::new();
    for line in changed {
        let line = *line as u32;
        if let Some(sym) = symbols.iter().filter(|s| s.start <= line && line <= s.end).min_by_key(|s| s.end - s.start) {
            if !out.iter().any(|known| std::ptr::eq(*known, sym)) {
                out.push(sym);
            }
        }
    }
    out
}

fn normalized(signature: &str) -> String {
    signature.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The blast radius of the symbols `files` touched, resolved against `target_ref`.
///
/// Returns contract changes first, then the widest radiuses, truncated to the configured caps: a
/// symbol with two hundred callers is exactly the one worth knowing about, and exactly the one that
/// must not enter a prompt whole.
pub fn blast_radius(
    repo_path: &str,
    target_ref: &str,
    files: &[ChangedFile],
    scope: &ScopeConfig,
    cfg: &GraphConfig,
) -> Vec<Impact> {
    if !cfg.enabled || files.is_empty() {
        return Vec::new();
    }
    let Ok(map) = crate::codemap::snapshot_at(repo_path, target_ref) else { return Vec::new() };
    let changed_paths: HashSet<String> = files.iter().map(|f| normalize_path(&f.path)).collect();

    // What each changed file touched, by name — and what it removed. A name touched in two changed
    // files is ambiguous: reporting callers of "one of them" would be a guess, so it is dropped.
    let mut owner: BTreeMap<String, Option<(String, Option<ContractChange>)>> = BTreeMap::new();
    for file in files {
        let path = normalize_path(&file.path);
        let head = if file.is_readable() { extract::extract(&path, &file.content) } else { extract::Facts::default() };
        let before = map.index_of(&path).filter(|i| map.path(*i) == path).map(|i| map.facts(i).clone());
        let mut claims: Vec<(String, Option<ContractChange>)> = Vec::new();
        for sym in touched(&head.symbols, &file.changed) {
            let change = before.as_ref().and_then(|facts| {
                let old = facts.symbols.iter().find(|s| s.name == sym.name && s.kind == sym.kind)?;
                (normalized(&old.signature) != normalized(&sym.signature))
                    .then(|| ContractChange::Signature { before: old.signature.clone(), after: sym.signature.clone() })
            });
            claims.push((sym.name.clone(), change));
        }
        if let Some(facts) = &before {
            for old in facts.symbols.iter().filter(|s| s.parent.is_none() || !s.kind.is_container()) {
                if !head.symbols.iter().any(|s| s.name == old.name) {
                    claims.push((old.name.clone(), Some(ContractChange::Removed)));
                }
            }
        }
        for (name, change) in claims {
            if !is_searchable(&name) {
                continue;
            }
            owner
                .entry(name)
                .and_modify(|slot| {
                    if slot.as_ref().is_some_and(|(home, _)| home != &path) {
                        *slot = None;
                    }
                })
                .or_insert_with(|| Some((path.clone(), change)));
        }
    }

    let mut out: Vec<Impact> = Vec::new();
    for (symbol, slot) in owner {
        let Some((home, change)) = slot else { continue };
        let report = map.usages(&symbol, Some(&home), usize::MAX);
        let mut callers: Vec<Caller> = report
            .usages
            .into_iter()
            .filter(|usage| super::plan::in_scope(&usage.path, scope))
            // A file the PR changed too is reviewed in its own right — and for a removed symbol,
            // the PR probably updated it.
            .filter(|usage| !(matches!(change, Some(ContractChange::Removed)) && changed_paths.iter().any(|p| same_path(p, &usage.path))))
            .map(|usage| Caller { file: usage.path, line: usage.line as usize, signature: usage.signature, confirmed: usage.confirmed })
            .collect();
        if callers.is_empty() {
            continue;
        }
        callers.sort_by(|a, b| b.confirmed.cmp(&a.confirmed).then_with(|| a.file.cmp(&b.file)));
        let total = callers.len();
        callers.truncate(cfg.max_callers);
        out.push(Impact { symbol, file: home, callers, callers_total: total, change });
    }
    out.sort_by(|a, b| {
        b.change.is_some().cmp(&a.change.is_some()).then_with(|| b.callers_total.cmp(&a.callers_total)).then_with(|| a.symbol.cmp(&b.symbol))
    });
    out.truncate(cfg.max_symbols);
    out
}

/// The blast radius rendered as one review-prompt context block.
///
/// Stated as pointers and framed as a hint, because that is what it is: imports settle most uses,
/// but a use found by name only is said to be one, and the model is told to go look rather than
/// that these are definitely callers.
pub fn block(impacts: &[Impact]) -> Option<String> {
    if impacts.is_empty() {
        return None;
    }
    let mut out = String::from(
        "\nOtros lugares del repositorio que usan los símbolos que toca este PR, según el mapa del \
         repositorio (los imports se resolvieron: un archivo que solo tiene otro símbolo con el mismo \
         nombre ya quedó fuera). Es una PISTA: confirma abriendo el archivo antes de reportar nada. \
         Úsalo sobre todo para cambios de contrato — si el cambio rompe a alguno de estos, ese es un \
         hallazgo.\n\n",
    );
    for impact in impacts {
        out.push_str(&format!("- `{}` ({}) — {} referencia(s):\n", impact.symbol, impact.file, impact.callers_total));
        match &impact.change {
            Some(ContractChange::Signature { before, after }) => {
                out.push_str(&format!("  ⚠ Cambió la firma: `{before}` → `{after}`\n"));
            }
            Some(ContractChange::Removed) => {
                out.push_str("  ⚠ Este PR lo elimina o lo renombra, y estos archivos fuera del PR todavía lo usan:\n");
            }
            None => {}
        }
        for caller in &impact.callers {
            let by_name = if caller.confirmed { "" } else { " (solo por nombre)" };
            match caller.signature.is_empty() {
                true => out.push_str(&format!("  - `{}:{}`{by_name}\n", caller.file, caller.line)),
                false => out.push_str(&format!("  - `{}:{}` — {}{by_name}\n", caller.file, caller.line, caller.signature)),
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
    use std::collections::BTreeSet;

    #[test]
    fn only_specific_names_are_worth_searching_for() {
        assert!(is_searchable("PagoRepository"));
        assert!(is_searchable("guardarPago"));
        assert!(!is_searchable("get"), "would match everywhere");
        assert!(!is_searchable("id"));
        assert!(!is_searchable("x"));
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
        let file = changed("src/a.ts", "export function alpha() {}\n", &[1]);
        let impacts = blast_radius("/definitely/not/a/repo", "main", &[file], &ScopeConfig::default(), &GraphConfig::default());
        assert!(impacts.is_empty());
    }

    fn changed(path: &str, content: &str, lines: &[usize]) -> ChangedFile {
        let changed: BTreeSet<usize> = lines.iter().copied().collect();
        ChangedFile {
            path: path.into(),
            status: "modified".into(),
            lines: content.lines().count(),
            content: content.into(),
            deletions: 0,
            symbols: super::super::outline::symbols_for(path, content, &changed),
            changed,
        }
    }

    /// The target branch: `applyDiscount` used by the cart, and a namesake in `legacy.ts` that
    /// imports nothing.
    fn repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codeflow-review-graph-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        std::fs::write(dir.join("src/pricing.ts"), "export function applyDiscount(price: number) {\n  return price;\n}\n\nexport function formatPrice(p: number) {\n  return `$${p}`;\n}\n").unwrap();
        std::fs::write(dir.join("src/cart.ts"), "import { applyDiscount, formatPrice } from './pricing';\nexport function cartTotal() {\n  return formatPrice(applyDiscount(1));\n}\n").unwrap();
        std::fs::write(dir.join("src/legacy.ts"), "export function legacy() {\n  return applyDiscount(2);\n}\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        dir
    }

    #[test]
    fn a_changed_signature_leads_with_its_real_callers_only() {
        let dir = repo();
        let head = "export function applyDiscount(price: number, percent: number) {\n  return price - price * percent / 100;\n}\n\nexport function formatPrice(p: number) {\n  return `$${p}`;\n}\n";
        let file = changed("src/pricing.ts", head, &[1, 2]);
        let impacts = blast_radius(dir.to_str().unwrap(), "HEAD", &[file], &ScopeConfig::default(), &GraphConfig::default());
        assert_eq!(impacts.len(), 1, "{impacts:?}");
        let impact = &impacts[0];
        assert_eq!(impact.symbol, "applyDiscount");
        assert!(matches!(&impact.change, Some(ContractChange::Signature { after, .. }) if after.contains("percent")));
        let files: Vec<&str> = impact.callers.iter().map(|c| c.file.as_str()).collect();
        assert_eq!(files, vec!["src/cart.ts"], "legacy.ts imports nothing that declares it");
        assert!(impact.callers[0].confirmed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_removed_symbol_still_used_outside_the_pr_is_reported() {
        let dir = repo();
        let head = "export function applyDiscount(price: number) {\n  return price;\n}\n";
        let mut file = changed("src/pricing.ts", head, &[]);
        file.deletions = 4;
        let impacts = blast_radius(dir.to_str().unwrap(), "HEAD", &[file], &ScopeConfig::default(), &GraphConfig::default());
        let removed = impacts.iter().find(|i| i.symbol == "formatPrice").expect("formatPrice was removed");
        assert_eq!(removed.change, Some(ContractChange::Removed));
        assert_eq!(removed.callers[0].file, "src/cart.ts");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_block_is_absent_when_there_is_nothing_to_say() {
        assert!(block(&[]).is_none());
    }

    #[test]
    fn the_block_names_pointers_contract_changes_and_how_many_were_left_out() {
        let impacts = vec![Impact {
            symbol: "guardarPago".into(),
            file: "src/services/pago.ts".into(),
            callers: vec![
                Caller {
                    file: "src/controllers/pagoController.ts".into(),
                    line: 42,
                    signature: "async function crearPago(req, res)".into(),
                    confirmed: true,
                },
                Caller { file: "db/procs.sql".into(), line: 7, signature: String::new(), confirmed: false },
            ],
            callers_total: 12,
            change: Some(ContractChange::Signature { before: "guardarPago(p)".into(), after: "guardarPago(p, opts)".into() }),
        }];
        let block = block(&impacts).expect("impacts produce a block");
        assert!(block.contains("guardarPago"));
        assert!(block.contains("src/controllers/pagoController.ts:42"));
        assert!(block.contains("crearPago"));
        assert!(block.contains("(+10 más)"));
        assert!(block.contains("Cambió la firma"));
        assert!(block.contains("`db/procs.sql:7` (solo por nombre)"));
        assert!(block.contains("PISTA"), "it is framed as a hint, not as a fact");
    }
}
