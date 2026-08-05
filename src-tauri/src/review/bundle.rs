//! The reading bundle a worker gets: the code that needs reviewing, and nothing else.
//!
//! This is the single biggest change to how a review is fed. Before, the model got the diff — the
//! changed lines with three lines of context — and had to either judge a change without the code
//! around it or go re-read whole files itself, once per touched symbol, over-reading at every
//! margin. Here the trimming happens **once, exactly**: each block carries a touched symbol's
//! *whole* range with numbered lines, and `>` marks what the pull request introduced or modified,
//! so the worker tells new code from context without ever opening the diff.
//!
//! On a 1500-line file with two touched methods, that difference is most of a review's cost.
//!
//! Three budgets keep the worst case bounded, in the order that matters more than the exact
//! numbers: padding around untouched ranges shrinks first, then untouched ranges are dropped, then
//! the ranges with the fewest changed lines go. If a whole group still overflows, its least-changed
//! files degrade to a **stub** — path, symbols and changed line numbers, no content. Nothing is ever
//! silently cut: every omission is stated in the bundle, and the model has the repository checked
//! out, so anything trimmed is one `Read` away.

use std::collections::{BTreeMap, BTreeSet};

use super::contract::{BundleConfig, LevelContract};
use super::outline::ChangedFile;

/// A file with no recognised symbols is included whole when it is at most this long — a small
/// `.json` or `.sql` is cheaper to read entire than to reason about in fragments.
const WHOLE_FILE_THRESHOLD: usize = 400;

/// Context around a changed line in a file with no symbols, where there is no range to fall back on.
const NO_OUTLINE_CONTEXT: usize = 12;

/// Ceiling on the standalone blocks emitted for changed lines that fall outside every symbol
/// (imports, top-level constants). Caps the worst case: a whole-file reformat.
const MAX_ORPHAN_BLOCKS: usize = 200;

/// One group's bundle, ready to be piped to a worker.
#[derive(Debug, Clone)]
pub struct Bundle {
    pub group_id: usize,
    pub text: String,
    /// Paths that had to be degraded to a stub to fit the group's budget — reported to the run log
    /// so a bundle that lost content says so out loud.
    pub degraded: Vec<String>,
    /// Files actually rendered into this bundle.
    pub files: Vec<String>,
}

/// Merges overlapping or adjacent ranges and clips them to the file. Without it, two adjacent
/// symbols with context would emit the same lines twice.
fn merge_ranges(ranges: &[(usize, usize)], total: usize) -> Vec<(usize, usize)> {
    let mut clean: Vec<(usize, usize)> = ranges
        .iter()
        .filter(|(s, e)| *s <= total && *e >= 1)
        .map(|(s, e)| ((*s).max(1), (*e).min(total)))
        .filter(|(s, e)| s <= e)
        .collect();
    clean.sort_unstable();

    let mut out: Vec<(usize, usize)> = Vec::new();
    for (start, end) in clean {
        match out.last_mut() {
            Some(last) if start <= last.1 + 1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

fn changed_in(a: usize, b: usize, changed: &BTreeSet<usize>) -> usize {
    changed.range(a..=b).count()
}

/// A single range that busts the whole budget on its own — one enormous method. Steps 1–3 can only
/// keep or drop whole ranges, so this windows down to the changed lines themselves, shrinking their
/// padding 3→0, and if even that overflows keeps only as many changed lines as fit.
fn shrink_oversized(
    a: usize,
    b: usize,
    changed: &BTreeSet<usize>,
    total: usize,
    max_lines: usize,
) -> Vec<(usize, usize)> {
    let points: Vec<usize> = changed.range(a..=b).copied().collect();
    let points = if points.is_empty() { vec![a] } else { points };
    for pad in [3usize, 2, 1, 0] {
        let candidate: Vec<(usize, usize)> = points
            .iter()
            .map(|ln| (ln.saturating_sub(pad).max(1), ln + pad))
            .collect();
        let merged = merge_ranges(&candidate, total);
        if merged.iter().map(|(x, y)| y - x + 1).sum::<usize>() <= max_lines {
            return merged;
        }
    }
    let kept: Vec<(usize, usize)> =
        points.iter().take(max_lines.max(1)).map(|ln| (*ln, *ln)).collect();
    merge_ranges(&kept, total)
}

/// Trims ranges to at most `max_lines` in total, returning `(ranges, lines omitted)`.
///
/// The order is the point: padding on ranges with no changed line goes first, then those ranges
/// entirely, then the remainder sorted by how much of the change each one actually holds. What
/// survives is always the code the pull request touched.
///
/// **Takes the ranges unmerged, and merges only at the end.** Merging first is what the equivalent
/// script does and it defeats the first two steps entirely: an untouched 500-line symbol sitting
/// immediately above a touched one becomes *one* range holding a change, so it can neither be
/// shrunk nor dropped, and the whole thing falls through to being windowed down to the bare changed
/// lines — losing the very method the reviewer needed to see. Overlap is handled by counting
/// through [`merge_ranges`] rather than by pre-merging.
fn cap_ranges(
    ranges: Vec<(usize, usize)>,
    changed: &BTreeSet<usize>,
    total: usize,
    max_lines: usize,
    context: usize,
) -> (Vec<(usize, usize)>, usize) {
    let span_of = |r: &[(usize, usize)]| -> usize {
        merge_ranges(r, total).iter().map(|(a, b)| b - a + 1).sum()
    };
    let before = span_of(&ranges);
    if max_lines == 0 || before <= max_lines {
        return (merge_ranges(&ranges, total), 0);
    }

    let mut entries: Vec<(usize, usize, usize)> =
        ranges.iter().map(|(a, b)| (*a, *b, changed_in(*a, *b, changed))).collect();
    let total_of = |e: &[(usize, usize, usize)]| -> usize {
        span_of(&e.iter().map(|(a, b, _)| (*a, *b)).collect::<Vec<_>>())
    };

    // (1) shrink the padding of ranges that hold no change, one line off each end per round.
    for _ in 0..context {
        if total_of(&entries) <= max_lines {
            break;
        }
        for e in entries.iter_mut() {
            if e.2 == 0 && e.1 > e.0 {
                e.0 += 1;
                e.1 -= 1;
            }
        }
    }

    // (2) drop the changed-free ranges outright.
    if total_of(&entries) > max_lines {
        entries.retain(|e| e.2 > 0);
    }

    // (3) keep the ranges holding the most change, until the budget is spent.
    if total_of(&entries) > max_lines {
        entries.sort_by(|a, b| b.2.cmp(&a.2));
        let mut kept: Vec<(usize, usize, usize)> = Vec::new();
        let mut running = 0usize;
        for e in entries {
            let span = e.1 - e.0 + 1;
            if !kept.is_empty() && running + span > max_lines {
                continue;
            }
            running += span;
            kept.push(e);
        }
        entries = kept;
    }

    // (4) one range oversized all by itself survives (3) whole — window it instead of dropping it.
    if entries.len() == 1 && entries[0].1 - entries[0].0 + 1 > max_lines {
        let (a, b, _) = entries[0];
        let final_ranges = shrink_oversized(a, b, changed, total, max_lines);
        let after = span_of(&final_ranges);
        return (final_ranges, before.saturating_sub(after));
    }

    let final_ranges = merge_ranges(
        &entries.iter().map(|(a, b, _)| (*a, *b)).collect::<Vec<_>>(),
        total,
    );
    let after = span_of(&final_ranges);
    (final_ranges, before.saturating_sub(after))
}

/// Which ranges of a file to include.
///
/// With symbols, each touched symbol's range plus padding, and a block for any changed line that
/// falls outside every one of them (imports, top-level constants). Without symbols, the whole file
/// when it is short, otherwise the changed zones with wide context.
fn ranges_for(file: &ChangedFile, context: usize, max_lines: usize) -> (Vec<(usize, usize)>, usize) {
    let total = file.lines;
    if total == 0 {
        return (Vec::new(), 0);
    }

    if file.symbols.is_empty() {
        let ranges = if total <= WHOLE_FILE_THRESHOLD || file.changed.is_empty() {
            vec![(1, total)]
        } else {
            merge_ranges(
                &file
                    .changed
                    .iter()
                    .map(|ln| (ln.saturating_sub(NO_OUTLINE_CONTEXT).max(1), ln + NO_OUTLINE_CONTEXT))
                    .collect::<Vec<_>>(),
                total,
            )
        };
        return cap_ranges(ranges, &file.changed, total, max_lines, NO_OUTLINE_CONTEXT);
    }

    let mut ranges: Vec<(usize, usize)> = file
        .symbols
        .iter()
        .map(|s| (s.start.saturating_sub(context).max(1), s.end + context))
        .collect();

    // Padding counts as covered: a line already visible in a margin does not need its own block.
    let covered = merge_ranges(&ranges, total);
    let orphans: Vec<usize> = file
        .changed
        .iter()
        .filter(|ln| !covered.iter().any(|(a, b)| (a..=b).contains(ln)))
        .take(MAX_ORPHAN_BLOCKS)
        .copied()
        .collect();
    ranges.extend(
        orphans
            .iter()
            .map(|ln| (ln.saturating_sub(context).max(1), ln + context)),
    );

    // Unmerged on purpose — see `cap_ranges`, which merges once it has decided what survives.
    cap_ranges(ranges, &file.changed, total, max_lines, context)
}

/// Renders one file's blocks. Returns `(text, lines emitted)`.
fn render_file(file: &ChangedFile, context: usize, max_lines: usize) -> (String, usize) {
    let lines: Vec<&str> = file.content.lines().collect();
    let total = lines.len();
    let (ranges, capped) = ranges_for(file, context, max_lines);
    let width = total.to_string().len();

    let mut out = format!(
        "=== {} · {} líneas · {} ===\n",
        file.path,
        total,
        if file.status.is_empty() { "modified" } else { &file.status }
    );

    let mut emitted = 0usize;
    for (start, end) in &ranges {
        let label = file.symbols.iter().find(|s| s.start >= *start && s.start <= *end).map(|s| &s.label);
        match label {
            Some(label) => out.push_str(&format!("--- líneas {start}-{end} · {label}\n")),
            None if !file.symbols.is_empty() => {
                out.push_str(&format!("--- líneas {start}-{end} · cambios fuera de símbolos\n"))
            }
            None => out.push_str(&format!("--- líneas {start}-{end}\n")),
        }
        for i in *start..=*end {
            let mark = if file.changed.contains(&i) { ">" } else { " " };
            out.push_str(&format!("{mark}{i:>width$} | {}\n", lines[i - 1], width = width));
            emitted += 1;
        }
        out.push('\n');
    }

    let left_out = total.saturating_sub(emitted).saturating_sub(capped);
    if capped > 0 {
        out.push_str(&format!(
            "[... {capped} línea(s) omitidas por el tope de {max_lines} líneas/archivo; \
             abre `{}` con tus herramientas si necesitas el resto ...]\n\n",
            file.path
        ));
    }
    if left_out > 0 {
        out.push_str(&format!(
            "[... {left_out} línea(s) del archivo no incluidas; abre `{}` con tus herramientas \
             si necesitas el resto ...]\n\n",
            file.path
        ));
    }
    (out, emitted)
}

/// The degraded rendering for a file dropped from an oversized group: enough to find the code
/// (path, symbols, changed lines) and none of its content.
fn stub_block(file: &ChangedFile) -> String {
    let mut out = format!(
        "=== {} · {} líneas · {} ===\n[... archivo degradado a stub por el tope de KB del grupo; \
         ábrelo con tus herramientas para revisarlo ...]\n",
        file.path, file.lines, file.status
    );
    if !file.symbols.is_empty() {
        out.push_str("símbolos tocados:\n");
        for s in &file.symbols {
            out.push_str(&format!("  {}-{}  {}\n", s.start, s.end, s.label));
        }
    }
    if !file.changed.is_empty() {
        let listed: Vec<String> = file.changed.iter().take(60).map(|n| n.to_string()).collect();
        let more = file.changed.len().saturating_sub(listed.len());
        out.push_str(&format!("líneas cambiadas: {}", listed.join(", ")));
        if more > 0 {
            out.push_str(&format!(" (+{more} más)"));
        }
        out.push('\n');
    }
    out.push('\n');
    out
}

/// The contract header every bundle carries.
///
/// It travels with the code rather than in each worker's prompt because with N groups that was N
/// copies of the same checklist — and because a worker had no way of knowing the threshold its
/// findings would be held to, which is exactly the number that decides whether writing one is worth
/// the tokens.
fn header(
    group_id: usize,
    total_groups: usize,
    file_count: usize,
    contract: &LevelContract,
    lenses: &BTreeMap<u8, String>,
) -> String {
    let mut out = format!(
        "# Bundle de revisión · grupo {group_id} de {total_groups} · {file_count} archivo(s)\n\
         # '>' marca las líneas que introdujo o modificó el PR.\n\
         # Tienes el repositorio completo abierto: si necesitas más contexto del que trae este \
         bundle (un callee, otra parte del archivo), ábrelo con tus herramientas.\n#\n"
    );
    out.push_str(&format!(
        "# Nivel {} · reporta solo {} con confianza >= {} (Blocker >= {}).\n",
        contract.level,
        contract.severity_labels().join("/"),
        contract.min_confidence,
        contract.min_confidence_blocker,
    ));
    out.push_str("# Lentes a aplicar sobre este bundle:\n");
    for n in &contract.lenses {
        if let Some(label) = lenses.get(n) {
            out.push_str(&format!("#   {n}. {label}\n"));
        }
    }
    out.push_str(
        "# Descartes en todos los niveles: código preexistente (igual en la rama destino), lo ya \
         discutido\n#   en los comentarios del PR, y tipos/lint/formato (los cubre CI).\n\n",
    );
    out
}

/// Builds one group's bundle, degrading files to stubs if the whole thing overflows its budget.
pub fn render_group(
    group_id: usize,
    total_groups: usize,
    files: &[&ChangedFile],
    contract: &LevelContract,
    lenses: &BTreeMap<u8, String>,
    cfg: &BundleConfig,
) -> Bundle {
    let readable: Vec<&&ChangedFile> = files.iter().filter(|f| f.is_readable()).collect();

    let mut blocks: Vec<String> = Vec::with_capacity(readable.len());
    for file in &readable {
        blocks.push(render_file(file, cfg.context_lines, cfg.max_lines_per_file).0);
    }

    let assemble = |blocks: &[String]| -> String {
        let mut text = header(group_id, total_groups, blocks.len(), contract, lenses);
        text.push_str(&blocks.join("\n"));
        text
    };

    let max_bytes = cfg.max_kb_per_group.saturating_mul(1024);
    let mut text = assemble(&blocks);
    let mut degraded: Vec<String> = Vec::new();

    if max_bytes > 0 && text.len() > max_bytes {
        // Least-changed first: the file a group least needs full source for is the one whose change
        // is smallest.
        let mut order: Vec<usize> = (0..readable.len()).collect();
        order.sort_by_key(|i| readable[*i].changed.len());
        for i in order {
            blocks[i] = stub_block(readable[i]);
            degraded.push(readable[i].path.clone());
            text = assemble(&blocks);
            if text.len() <= max_bytes {
                break;
            }
        }
    }

    Bundle {
        group_id,
        text,
        degraded,
        files: readable.iter().map(|f| f.path.clone()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::contract::{resolve_level_contract, ReviewEngineConfig};
    use crate::review::outline::Symbol;

    fn lenses() -> BTreeMap<u8, String> {
        crate::review::contract::parse_lenses(crate::review::contract::DEFAULT_LENSES)
    }

    fn contract() -> LevelContract {
        resolve_level_contract("completo", &ReviewEngineConfig::default())
    }

    fn file(lines: usize, changed: &[usize], symbols: Vec<Symbol>) -> ChangedFile {
        let content: String =
            (1..=lines).map(|i| format!("linea {i}\n")).collect::<Vec<_>>().join("");
        ChangedFile {
            path: "src/a.ts".into(),
            status: "modified".into(),
            lines: content.lines().count(),
            content,
            changed: changed.iter().copied().collect(),
            deletions: 0,
            symbols,
        }
    }

    #[test]
    fn adjacent_ranges_are_merged_rather_than_emitted_twice() {
        let merged = merge_ranges(&[(1, 5), (6, 9), (20, 25)], 100);
        assert_eq!(merged, vec![(1, 9), (20, 25)]);
    }

    #[test]
    fn ranges_are_clipped_to_the_file() {
        assert_eq!(merge_ranges(&[(0, 500)], 10), vec![(1, 10)]);
        assert!(merge_ranges(&[(50, 60)], 10).is_empty());
    }

    #[test]
    fn a_touched_symbol_arrives_whole_with_its_changed_lines_marked() {
        let f = file(200, &[52, 53], vec![Symbol { start: 50, end: 60, label: "fn pagar()".into() }]);
        let (text, emitted) = render_file(&f, 3, 800);
        assert!(text.contains("fn pagar()"), "the block is labelled with its symbol");
        assert!(text.contains(">  52 |") || text.contains("> 52 |"), "changed lines carry '>'");
        assert!(text.contains("  50 |") || text.contains(" 50 |"));
        assert!(emitted >= 11, "the whole symbol range, plus padding");
        assert!(emitted < 200, "and nothing like the whole file");
        assert!(text.contains("no incluidas"), "what was left out is stated");
    }

    #[test]
    fn a_short_file_with_no_symbols_comes_whole() {
        let f = file(80, &[10], vec![]);
        let (text, emitted) = render_file(&f, 3, 800);
        assert_eq!(emitted, 80);
        assert!(!text.contains("no incluidas"));
    }

    #[test]
    fn a_long_file_with_no_symbols_falls_back_to_the_changed_zones() {
        let f = file(2000, &[1000], vec![]);
        let (_, emitted) = render_file(&f, 3, 800);
        assert_eq!(emitted, NO_OUTLINE_CONTEXT * 2 + 1, "the changed line with wide context");
    }

    /// The per-file cap has to bite, and it has to keep the code the PR actually touched.
    #[test]
    fn the_per_file_cap_keeps_the_changed_code_and_says_what_it_dropped() {
        let symbols = vec![
            Symbol { start: 1, end: 500, label: "sin cambios".into() },
            Symbol { start: 501, end: 700, label: "con cambios".into() },
        ];
        let f = file(2000, &[600, 601, 602], symbols);
        let (text, emitted) = render_file(&f, 3, 300);
        assert!(emitted <= 300, "the cap is respected ({emitted} lines)");
        assert!(text.contains("con cambios"), "the touched symbol survives");
        assert!(!text.contains("sin cambios"), "the untouched one is what gets dropped");
        assert!(text.contains("tope de 300 líneas/archivo"));
    }

    /// One enormous method is the case step (4) exists for: it cannot be dropped (it is the only
    /// thing there) and it cannot be kept whole.
    #[test]
    fn a_single_oversized_symbol_is_windowed_not_dropped() {
        let f = file(3000, &[1500], vec![Symbol { start: 1, end: 3000, label: "gigante".into() }]);
        let (text, emitted) = render_file(&f, 3, 100);
        assert!(emitted > 0, "something survives");
        assert!(emitted <= 100);
        assert!(text.contains("1500"), "and it is the changed line");
    }

    #[test]
    fn changed_lines_outside_every_symbol_get_their_own_block() {
        // Line 3 is an import, outside the symbol at 50-60.
        let f = file(200, &[3, 55], vec![Symbol { start: 50, end: 60, label: "fn x()".into() }]);
        let (text, _) = render_file(&f, 3, 800);
        assert!(text.contains("cambios fuera de símbolos"));
        assert!(text.contains("> 3 |") || text.contains(">  3 |"));
    }

    #[test]
    fn the_header_carries_the_level_contract_and_its_lenses() {
        let f = file(50, &[10], vec![]);
        let bundle = render_group(1, 3, &[&f], &contract(), &lenses(), &BundleConfig::default());
        assert!(bundle.text.contains("grupo 1 de 3"));
        assert!(bundle.text.contains("Nivel completo"));
        assert!(bundle.text.contains("confianza >= 60"));
        assert!(bundle.text.contains("Blocker >= 50"));
        assert!(bundle.text.contains("2. Seguridad"), "the level's lenses travel with the code");
        assert!(!bundle.text.contains("6. Mantenibilidad general"), "and only the level's");
    }

    #[test]
    fn an_oversized_group_degrades_its_least_changed_files_to_stubs() {
        // Both files render large (one symbol spanning the whole file), so the choice of which one
        // gives way is decided by how much of the change each holds — which is the point.
        let whole = |n: usize| vec![Symbol { start: 1, end: n, label: "todo".into() }];
        let barely = ChangedFile { path: "src/barely.ts".into(), ..file(1200, &[5, 6], whole(1200)) };
        let heavily =
            ChangedFile { path: "src/heavily.ts".into(), ..file(1200, &(1..=40).collect::<Vec<_>>(), whole(1200)) };
        // A per-file cap low enough to bite would trim both files before the group budget ever
        // mattered, so this test raises it: the decision under test is the group-level one.
        let cfg = BundleConfig { max_kb_per_group: 30, max_lines_per_file: 5_000, context_lines: 3 };
        let bundle = render_group(1, 1, &[&barely, &heavily], &contract(), &lenses(), &cfg);
        assert_eq!(bundle.degraded, vec!["src/barely.ts".to_string()], "the least-changed file goes first");
        assert!(bundle.text.contains("degradado a stub"));
        assert!(bundle.text.contains("símbolos tocados:"), "the stub still says where to look");
        assert!(bundle.text.contains("linea 1200"), "the most-changed file keeps its content");
    }

    /// A group that fits keeps every file whole — the degradation path must not fire by default.
    #[test]
    fn a_group_within_budget_degrades_nothing() {
        let a = ChangedFile { path: "src/a.ts".into(), ..file(60, &[3], vec![]) };
        let b = ChangedFile { path: "src/b.ts".into(), ..file(60, &[3], vec![]) };
        let bundle = render_group(1, 1, &[&a, &b], &contract(), &lenses(), &BundleConfig::default());
        assert!(bundle.degraded.is_empty());
        assert_eq!(bundle.files.len(), 2);
    }

    #[test]
    fn a_deletion_never_reaches_a_bundle() {
        let deleted = ChangedFile {
            path: "src/gone.ts".into(),
            status: "deleted".into(),
            content: String::new(),
            lines: 0,
            changed: BTreeSet::new(),
            deletions: 0,
            symbols: vec![],
        };
        let bundle = render_group(1, 1, &[&deleted], &contract(), &lenses(), &BundleConfig::default());
        assert!(bundle.files.is_empty());
        assert!(!bundle.text.contains("src/gone.ts"));
    }
}
