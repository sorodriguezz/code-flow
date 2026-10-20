//! Cutting documents into what the index stores: pieces small enough to put in front of a model,
//! each with the lines it came from, so an answer can cite `path:12-40` and the editor can open it.
//!
//! By structure, not by character count alone: Markdown at its headings (a section is what a
//! question is usually about), code at blank lines inside a window of lines (a function rarely
//! spans the gap between two of them), plain text at paragraphs.

/// The most characters one chunk holds.
pub const MAX_CHARS: usize = 1_600;
/// The most lines one code chunk holds.
const MAX_CODE_LINES: usize = 80;

/// One piece of a document.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    /// 1-based, inclusive.
    pub start_line: u32,
    pub end_line: u32,
    /// The section it belongs to (Markdown), or its first line (code) — what a result is titled by.
    pub heading: String,
    pub text: String,
}

/// What a file is, for chunking and for whether it gets vectors (prose does, code does not yet).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Markdown,
    Text,
    Code,
}

pub fn kind_of(path: &str) -> Kind {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "md" | "mdx" | "markdown" | "rst" | "adoc" => Kind::Markdown,
        "txt" | "text" | "dbml" | "log" => Kind::Text,
        _ => Kind::Code,
    }
}

/// `text` as chunks, by `path`'s kind.
pub fn chunk(path: &str, text: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    match kind_of(path) {
        Kind::Markdown => markdown(&lines),
        Kind::Text => paragraphs(&lines, 0, ""),
        Kind::Code => code(&lines),
    }
}

fn joined(lines: &[&str]) -> String {
    lines.join("\n").trim().to_string()
}

fn markdown(lines: &[&str]) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut heading = String::new();
    let mut in_fence = false;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }
        let is_heading = !in_fence && trimmed.starts_with('#') && trimmed.trim_start_matches('#').starts_with(' ');
        if is_heading && index > start {
            out.extend(paragraphs(&lines[start..index], start, &heading));
            start = index;
        }
        if is_heading {
            heading = trimmed.trim_start_matches('#').trim().to_string();
        }
    }
    out.extend(paragraphs(&lines[start..], start, &heading));
    out
}

/// Paragraph-sized pieces of `lines` (which start at line `offset`), none over [`MAX_CHARS`].
fn paragraphs(lines: &[&str], offset: usize, heading: &str) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut size = 0;
    for (index, line) in lines.iter().enumerate() {
        let next = size + line.chars().count() + 1;
        let blank = line.trim().is_empty();
        if next > MAX_CHARS && index > start {
            push(&mut out, lines, start, index, offset, heading);
            start = index;
            size = 0;
        } else if blank && size > MAX_CHARS / 2 {
            push(&mut out, lines, start, index, offset, heading);
            start = index + 1;
            size = 0;
            continue;
        }
        size += line.chars().count() + 1;
    }
    push(&mut out, lines, start, lines.len(), offset, heading);
    out
}

fn push(out: &mut Vec<Chunk>, lines: &[&str], from: usize, to: usize, offset: usize, heading: &str) {
    if from >= to {
        return;
    }
    let text = joined(&lines[from..to]);
    if text.is_empty() {
        return;
    }
    // A single line longer than the limit is cut, not dropped.
    let text = if text.chars().count() > MAX_CHARS * 2 { text.chars().take(MAX_CHARS * 2).collect() } else { text };
    out.push(Chunk { start_line: (offset + from + 1) as u32, end_line: (offset + to) as u32, heading: heading.to_string(), text });
}

fn code(lines: &[&str]) -> Vec<Chunk> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut size = 0;
    for (index, line) in lines.iter().enumerate() {
        size += line.chars().count() + 1;
        let span = index + 1 - start;
        let full = size >= MAX_CHARS || span >= MAX_CODE_LINES;
        let gap = line.trim().is_empty() && (size >= MAX_CHARS / 2 || span >= MAX_CODE_LINES / 2);
        if full || gap {
            let heading = lines[start..=index].iter().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or_default();
            let heading: String = heading.chars().take(120).collect();
            push(&mut out, lines, start, index + 1, 0, &heading);
            start = index + 1;
            size = 0;
        }
    }
    if start < lines.len() {
        let heading: String = lines[start..].iter().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or_default().chars().take(120).collect();
        push(&mut out, lines, start, lines.len(), 0, &heading);
    }
    out
}

/// A text cut into pieces of about `size` characters, overlapping by `overlap`, each ending where a
/// paragraph, line, sentence or word does when one is near — what retrieval stores, one vector each.
pub fn chunks(text: &str, size: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if size == 0 || chars.len() <= size {
        return if text.trim().is_empty() { Vec::new() } else { vec![text.trim().to_string()] };
    }
    let overlap = overlap.min(size / 2);
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let hard_end = (start + size).min(chars.len());
        let mut end = hard_end;
        if hard_end < chars.len() {
            let window: String = chars[start..hard_end].iter().collect();
            let floor = size / 2;
            for breaker in ["\n\n", "\n", ". ", " "] {
                if let Some(at) = window.rfind(breaker) {
                    let at_chars = window[..at].chars().count() + breaker.chars().count();
                    if at_chars >= floor {
                        end = start + at_chars;
                        break;
                    }
                }
            }
        }
        let piece: String = chars[start..end].iter().collect();
        if !piece.trim().is_empty() {
            out.push(piece.trim().to_string());
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(overlap).max(start + 1);
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_is_cut_at_headings_with_their_lines() {
        let text = "# Inventory\n\nIntro line.\n\n## Storage\n\nWe chose SQLite.\n\n## Retention\n\n90 days.\n";
        let chunks = chunk("docs/adr.md", text);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[1].heading, "Storage");
        assert_eq!((chunks[1].start_line, chunks[1].end_line), (5, 8));
        assert!(chunks[1].text.contains("SQLite"));
        assert_eq!(chunks[2].heading, "Retention");
    }

    #[test]
    fn a_heading_inside_a_fence_is_code_not_a_section() {
        let text = "# Doc\n\n```sh\n# not a heading\necho hi\n```\n";
        assert_eq!(chunk("a.md", text).len(), 1);
    }

    #[test]
    fn code_is_cut_into_bounded_windows_that_cover_every_line() {
        let text: String = (1..=301).map(|i| if i % 20 == 0 { String::new() } else { format!("let v{i} = {i};") }).collect::<Vec<_>>().join("\n");
        let chunks = chunk("src/a.ts", &text);
        assert!(chunks.len() >= 4);
        assert!(chunks.iter().all(|c| c.text.chars().count() <= MAX_CHARS * 2));
        assert!(chunks.iter().all(|c| c.end_line - c.start_line < MAX_CODE_LINES as u32));
        assert_eq!(chunks.last().unwrap().end_line, 301);
        assert_eq!(chunks[0].heading, "let v1 = 1;");
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_of("README.md"), Kind::Markdown);
        assert_eq!(kind_of("notes.txt"), Kind::Text);
        assert_eq!(kind_of("src/main.rs"), Kind::Code);
    }
}
