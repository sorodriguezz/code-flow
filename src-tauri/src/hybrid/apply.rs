//! Turning a local model's answer into bytes on disk — and refusing the answers that would be
//! wrong to write.
//!
//! Everything here is pure (text in, text out) except [`write_atomic`], so every rule a small
//! model breaks has a test: an answer with prose around the code, an answer cut off before its
//! closing fence, an answer that replaced half the file with "// ... rest unchanged", a region whose
//! line numbers moved since the plan was written.

use std::path::Path;

/// Pulls the code out of an answer: the first fenced block, or — when there is no fence at all and
/// nothing reads as prose — the whole answer. Thinking blocks are dropped first.
pub fn extract_code(answer: &str) -> Result<String, String> {
    let answer = strip_think(answer);
    let lines: Vec<&str> = answer.lines().collect();
    if let Some(open) = lines.iter().position(|line| line.trim_start().starts_with("```")) {
        let fence = lines[open].trim_start();
        let ticks = fence.chars().take_while(|c| *c == '`').count();
        let closing = "`".repeat(ticks);
        let close = lines[open + 1..]
            .iter()
            .position(|line| line.trim() == closing)
            .map(|at| open + 1 + at)
            .ok_or_else(|| "The answer was cut off before its code block closed.".to_string())?;
        return Ok(lines[open + 1..close].join("\n"));
    }
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return Err("The answer was empty.".to_string());
    }
    let first = trimmed.lines().next().unwrap_or("").trim_start();
    let prose = ["Here", "Sure", "This ", "The ", "Below", "I ", "Aquí", "Claro", "Este "]
        .iter()
        .any(|start| first.starts_with(start));
    if prose {
        return Err("The answer has no code block.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Removes `<think>…</think>` blocks — some local models think out loud even when asked not to.
pub fn strip_think(answer: &str) -> String {
    let mut out = String::with_capacity(answer.len());
    let mut rest = answer;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A line that stands in for code instead of being code — the classic failure of a small model
/// asked for a whole file. Returns the offending line.
pub fn lazy_marker(code: &str) -> Option<String> {
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            // `// ...`, `# ...`, `/* ... */`, `<!-- ... -->`, `-- ...` on a line of their own.
            r"^\s*(//|#|/\*|<!--|--|\*)\s*(\.\.\.|…)",
            r"(?i)\b(rest|remainder) of (the )?(code|file|function|class|implementation|component|module)\b",
            r"(?i)\b(existing|previous|other|original) (code|implementation|content|methods|logic)( (here|remains|stays|unchanged))?\s*(\.\.\.|…)?\s*(\*/|-->)?\s*$",
            r"(?i)\b(unchanged|same as before|as before)\s*(\.\.\.|…)?\s*(\*/|-->)?\s*$",
            r"(?i)(resto del (código|archivo)|código existente|sin cambios)",
        ]
        .iter()
        .filter_map(|p| regex::Regex::new(p).ok())
        .collect()
    });
    code.lines()
        .find(|line| {
            let comment = {
                let t = line.trim_start();
                t.starts_with("//") || t.starts_with('#') || t.starts_with("/*") || t.starts_with('*') || t.starts_with("<!--") || t.starts_with("--")
            };
            patterns.iter().enumerate().any(|(i, re)| (i == 0 || comment) && re.is_match(line))
        })
        .map(|line| line.trim().to_string())
}

/// Whether `new` lost most of `old` without having been asked to. A model that rewrites a 200-line
/// file as 60 lines has usually summarised it, not edited it.
pub fn suspiciously_short(old: &str, new: &str, instruction: &str) -> bool {
    let before = old.lines().count();
    let after = new.lines().count();
    if before < 30 || after * 2 >= before {
        return false;
    }
    let lower = instruction.to_lowercase();
    let asked = ["remove", "delete", "drop", "simplif", "shorten", "elimin", "borr", "quita", "quitar", "simplific", "reduc"]
        .iter()
        .any(|word| lower.contains(word));
    !asked
}

/// Finds a region again. The plan's numbers are tried first; when the line there is no longer the
/// one the plan saw, the anchor is looked for and the region moves with it — but only if it appears
/// exactly once, because an anchor matching twice is a guess about which one was meant.
pub fn reanchor(lines: &[&str], start: u32, end: u32, first_line: &str) -> Result<(usize, usize), String> {
    let anchor = first_line.trim();
    let span = (end - start) as usize;
    let at = start as usize - 1;
    if lines.get(at).is_some_and(|line| line.trim() == anchor) && at + span < lines.len() {
        return Ok((at, at + span));
    }
    let hits: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.trim() == anchor).map(|(i, _)| i).collect();
    match hits.as_slice() {
        [only] if only + span < lines.len() => Ok((*only, only + span)),
        [] => Err(format!("The region starting \"{anchor}\" is no longer in the file.")),
        _ => Err(format!("\"{anchor}\" appears more than once; the region can't be found reliably.")),
    }
}

/// Replaces line ranges (0-based, inclusive) with new text, **from the bottom up** so that every
/// range is still where it was when the next one is applied.
pub fn splice(original: &str, mut replacements: Vec<(usize, usize, String)>) -> String {
    let newline = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let ends_with_newline = original.ends_with('\n');
    let mut lines: Vec<String> = original.lines().map(str::to_string).collect();
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    for (start, end, text) in replacements {
        let end = end.min(lines.len().saturating_sub(1));
        let new_lines: Vec<String> = text.lines().map(str::to_string).collect();
        lines.splice(start..=end, new_lines);
    }
    let mut out = lines.join(newline);
    if ends_with_newline {
        out.push_str(newline);
    }
    out
}

/// A whole-file answer, shaped like the file it replaces: the same line endings, and a final
/// newline exactly when the original had one (or, for a new file, always).
pub fn conform(original: Option<&str>, new: &str) -> String {
    let newline = if original.is_some_and(|o| o.contains("\r\n")) { "\r\n" } else { "\n" };
    let mut out = new.lines().collect::<Vec<_>>().join(newline);
    if original.map_or(true, |o| o.ends_with('\n')) && !out.is_empty() {
        out.push_str(newline);
    }
    out
}

/// Lines added and removed between two versions, by the longest common subsequence of lines.
/// Exact for the sizes a task writes; capped so a pathological pair costs nothing.
pub fn line_stats(old: &str, new: &str) -> (i64, i64) {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    if a.len() * b.len() > 4_000_000 {
        return (b.len() as i64, a.len() as i64);
    }
    let mut prev = vec![0usize; b.len() + 1];
    for line in &a {
        let mut row = vec![0usize; b.len() + 1];
        for (j, other) in b.iter().enumerate() {
            row[j + 1] = if line == other { prev[j] + 1 } else { row[j].max(prev[j + 1]) };
        }
        prev = row;
    }
    let common = prev[b.len()];
    ((b.len() - common) as i64, (a.len() - common) as i64)
}

/// Writes through a temporary file in the same folder and renames it over the target, so a crash
/// mid-write leaves the old file or the new one — never half of either.
pub fn write_atomic(target: &Path, content: &str) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| "no parent folder".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = parent.join(format!(".{name}.codeflow-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, content).map_err(|e| e.to_string())?;
    // Keep the original's permissions (an executable script stays executable).
    if let Ok(meta) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(&temp, meta.permissions());
    }
    std::fs::rename(&temp, target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

/// SHA-256 of a file's text, or empty when there is no file — recorded before and after a task so
/// a run cut off between the write and the status update can tell which one happened.
pub fn hash_text(text: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    text.map(|t| hex::encode(Sha256::digest(t.as_bytes()))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_fenced_block_is_the_code() {
        let answer = "Here you go:\n```ts\nexport const a = 1;\nexport const b = 2;\n```\nAnything else?";
        assert_eq!(extract_code(answer).unwrap(), "export const a = 1;\nexport const b = 2;");
    }

    #[test]
    fn longer_fences_hold_inner_fences() {
        let answer = "````md\n# Doc\n```ts\nconst x = 1;\n```\n````";
        assert_eq!(extract_code(answer).unwrap(), "# Doc\n```ts\nconst x = 1;\n```");
    }

    #[test]
    fn a_cut_off_block_and_bare_prose_are_refused() {
        assert!(extract_code("```ts\nexport function a() {\n  return 1;").unwrap_err().contains("cut off"));
        assert!(extract_code("Here is what I would change: rename the function.").is_err());
        assert!(extract_code("   ").is_err());
        assert_eq!(extract_code("export const a = 1;").unwrap(), "export const a = 1;", "no fence, no prose: the code itself");
    }

    #[test]
    fn thinking_is_dropped_before_reading() {
        let answer = "<think>The user wants a constant.</think>\n```js\nconst a = 1;\n```";
        assert_eq!(extract_code(answer).unwrap(), "const a = 1;");
        assert_eq!(strip_think("a<think>never closed"), "a");
    }

    #[test]
    fn placeholders_are_caught_and_real_code_is_not() {
        assert!(lazy_marker("function a() {}\n// ... rest of the code\n").is_some());
        assert!(lazy_marker("class A {\n  // existing methods unchanged\n}").is_some());
        assert!(lazy_marker("def f():\n    # ...\n").is_some());
        assert!(lazy_marker("// resto del código igual").is_some());
        // Ordinary code and comments that merely mention the words.
        assert!(lazy_marker("const rest = items.slice(1);\n// spread the rest of the args\nf(...rest);").is_none());
        assert!(lazy_marker("// Keeps the previous value when the input is unchanged by the user.").is_none());
        assert!(lazy_marker("const range = [...Array(3).keys()];").is_none());
    }

    #[test]
    fn a_rewrite_that_lost_most_of_the_file_is_suspicious_unless_asked() {
        let old = (0..100).map(|i| format!("line {i}\n")).collect::<String>();
        let new = (0..20).map(|i| format!("line {i}\n")).collect::<String>();
        assert!(suspiciously_short(&old, &new, "Add a field to the config."));
        assert!(!suspiciously_short(&old, &new, "Remove the deprecated helpers."));
        assert!(!suspiciously_short("a\nb\n", "a\n", "anything"), "short files are never judged");
    }

    #[test]
    fn regions_follow_their_anchor_when_lines_move() {
        let lines = ["import x", "", "fn a() {", "  1", "}", "fn b() {", "  2", "}"];
        assert_eq!(reanchor(&lines, 6, 8, "fn b() {").unwrap(), (5, 7));
        // Two lines were inserted above since the plan: the anchor finds it.
        let moved = ["import x", "import y", "import z", "", "fn a() {", "  1", "}", "fn b() {", "  2", "}"];
        assert_eq!(reanchor(&moved, 6, 8, "fn b() {").unwrap(), (7, 9));
        assert!(reanchor(&moved, 6, 8, "fn c() {").is_err());
        let twice = ["}", "x", "}", "y"];
        assert!(reanchor(&twice, 9, 9, "}").unwrap_err().contains("more than once"));
    }

    #[test]
    fn splicing_runs_bottom_up_and_keeps_line_endings() {
        let original = "a\nb\nc\nd\ne\n";
        let out = splice(original, vec![(1, 1, "B1\nB2".into()), (3, 4, "DE".into())]);
        assert_eq!(out, "a\nB1\nB2\nc\nDE\n");
        let crlf = "a\r\nb\r\nc";
        assert_eq!(splice(crlf, vec![(1, 1, "X".into())]), "a\r\nX\r\nc");
    }

    #[test]
    fn whole_files_take_the_shape_of_the_one_they_replace() {
        assert_eq!(conform(Some("a\r\nb\r\n"), "x\ny"), "x\r\ny\r\n");
        assert_eq!(conform(Some("a\nb"), "x\ny\n"), "x\ny");
        assert_eq!(conform(None, "x"), "x\n");
    }

    #[test]
    fn line_stats_count_what_changed() {
        assert_eq!(line_stats("a\nb\nc\n", "a\nB\nc\nd\n"), (2, 1));
        assert_eq!(line_stats("", "x\ny\n"), (2, 0));
    }

    #[test]
    fn atomic_writes_replace_the_file_whole() {
        let dir = std::env::temp_dir().join(format!("cf-hybrid-apply-{}", uuid::Uuid::new_v4()));
        let target = dir.join("nested/out.txt");
        write_atomic(&target, "one\n").unwrap();
        write_atomic(&target, "two\n").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "two\n");
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap()).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1, "no temporary file is left behind");
        std::fs::remove_dir_all(dir).ok();
    }
}
