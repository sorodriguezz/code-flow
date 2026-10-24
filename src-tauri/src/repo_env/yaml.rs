//! YAML configuration — Spring's `application*.yml` and Compose files — read line by line.
//!
//! Not a YAML library: there is none in the tree, and none of them reports where a scalar sits in
//! the file, which a move into the Llavero needs. Configuration files use a small, regular corner of
//! YAML — block mappings, block sequences, quoted and plain scalars, `|`/`>` blocks, comments,
//! several documents — and that corner is what this reads. Flow collections (`{a: 1}`, `[a, b]`)
//! are kept as their text rather than expanded; anchors and tags are read as plain text.

use super::dotenv::line_bounds;
use super::edit::{reference_in, reference_value, Edit};
use super::Entry;

#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

#[derive(Debug, Clone)]
pub struct Leaf {
    pub path: Vec<Seg>,
    pub value: String,
    pub line: usize,
    /// Just past the `:` of a mapping entry; for a sequence item, where its text starts.
    pub value_from: usize,
    /// Where a sequence item's text starts (`None` for a mapping entry).
    pub item_start: Option<usize>,
    /// The end of the entry's last line, line break excluded.
    pub content_end: usize,
    /// The comment after the value, if any.
    pub comment: String,
    /// The value was written in quotes.
    pub quoted: bool,
}

struct Frame {
    indent: usize,
    seg: Seg,
    /// A sequence item's frame, which the next item at the same indent closes.
    item: bool,
    next_index: usize,
    /// A `key:` with nothing after it is a null — unless lines under it make it a parent.
    pending: Option<Leaf>,
}

pub fn leaves(text: &str) -> Vec<Leaf> {
    let mut out: Vec<Leaf> = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut pos = 0;
    let mut line_no = 0;

    fn close(stack: &mut Vec<Frame>, out: &mut Vec<Leaf>, keep: impl Fn(&Frame) -> bool) {
        while let Some(top) = stack.last() {
            if keep(top) {
                break;
            }
            let frame = stack.pop().unwrap();
            if let Some(leaf) = frame.pending {
                out.push(leaf);
            }
        }
    }
    fn path_of(stack: &[Frame]) -> Vec<Seg> {
        stack.iter().map(|f| f.seg.clone()).collect()
    }

    while pos < text.len() {
        line_no += 1;
        let line_start = pos;
        let (content_end, next) = line_bounds(text, pos);
        pos = next;
        let line = &text[line_start..content_end];
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "---" || trimmed.starts_with("--- ") || trimmed == "..." {
            close(&mut stack, &mut out, |_| false);
            continue;
        }
        let indent = line.len() - trimmed.len();
        let is_item = trimmed == "-" || trimmed.starts_with("- ");
        close(&mut stack, &mut out, |top| top.indent < indent || (top.indent == indent && is_item && !top.item));
        // Whatever is still on top now has a child, so it is not a null.
        if let Some(top) = stack.last_mut() {
            top.pending = None;
        }

        let mut col = line_start + indent;
        if is_item {
            let index = match stack.last_mut() {
                Some(parent) => {
                    let i = parent.next_index;
                    parent.next_index += 1;
                    i
                }
                None => 0,
            };
            stack.push(Frame { indent, seg: Seg::Index(index), item: true, next_index: 0, pending: None });
            let after = &text[col + 1..content_end];
            col += 1 + (after.len() - after.trim_start().len());
            if col >= content_end || text[col..content_end].starts_with('#') {
                continue;
            }
            if mapping_key(&text[col..content_end]).is_none() {
                // A scalar item.
                let (value, comment, quoted, _) = scalar(text, col, content_end);
                out.push(Leaf {
                    path: path_of(&stack),
                    value,
                    line: line_no,
                    value_from: col,
                    item_start: Some(col),
                    content_end,
                    comment,
                    quoted,
                });
                continue;
            }
        }

        let body = &text[col..content_end];
        let Some((key, key_len)) = mapping_key(body) else { continue };
        let key_indent = col - line_start;
        // Mapping keys close siblings at their own column (inside a sequence item they sit deeper
        // than the dash).
        close(&mut stack, &mut out, |top| top.indent < key_indent || (top.item && top.indent < key_indent));
        let sep_end = col + key_len;
        let rest = &text[sep_end..content_end];
        let value_start = sep_end + (rest.len() - rest.trim_start().len());
        let value_text = &text[value_start..content_end];
        let mut path = path_of(&stack);
        path.push(Seg::Key(key.clone()));

        if value_text.is_empty() || value_text.starts_with('#') {
            let comment = value_text.trim_start_matches('#').trim().to_string();
            let leaf = Leaf { path, value: String::new(), line: line_no, value_from: sep_end, item_start: None, content_end, comment, quoted: false };
            stack.push(Frame { indent: key_indent, seg: Seg::Key(key), item: false, next_index: 0, pending: Some(leaf) });
            continue;
        }
        if value_text.starts_with('|') || value_text.starts_with('>') {
            let folded = value_text.starts_with('>');
            let mut lines: Vec<&str> = Vec::new();
            let mut block_indent: Option<usize> = None;
            let mut last_end = content_end;
            let mut extra = 0;
            while pos < text.len() {
                let (end, after) = line_bounds(text, pos);
                let piece = &text[pos..end];
                let piece_indent = piece.len() - piece.trim_start().len();
                if !piece.trim().is_empty() && piece_indent <= key_indent {
                    break;
                }
                if !piece.trim().is_empty() {
                    let at = *block_indent.get_or_insert(piece_indent);
                    lines.push(piece.get(at.min(piece_indent)..).unwrap_or(""));
                    last_end = end;
                } else {
                    lines.push("");
                }
                extra += 1;
                pos = after;
            }
            while lines.last() == Some(&"") {
                lines.pop();
            }
            let value = if folded { lines.join(" ") } else { lines.join("\n") };
            out.push(Leaf { path, value, line: line_no, value_from: sep_end, item_start: None, content_end: last_end, comment: String::new(), quoted: false });
            line_no += extra;
            continue;
        }
        let (value, comment, quoted, _) = scalar(text, value_start, content_end);
        out.push(Leaf { path, value, line: line_no, value_from: sep_end, item_start: None, content_end, comment, quoted });
    }
    close(&mut stack, &mut out, |_| false);
    out.sort_by_key(|leaf| leaf.value_from);
    out
}

/// `key:` at the start of `body`: the key, and how many bytes up to and including the colon.
fn mapping_key(body: &str) -> Option<(String, usize)> {
    let first = body.chars().next()?;
    if first == '"' || first == '\'' {
        let close = body[1..].find(first)? + 1;
        let after = &body[close + 1..];
        let colon = after.len() - after.trim_start_matches([' ', '\t']).len();
        if after[colon..].starts_with(':') && after[colon + 1..].chars().next().is_none_or(|c| c == ' ' || c == '\t') {
            return Some((body[1..close].to_string(), close + 1 + colon + 1));
        }
        return None;
    }
    if matches!(first, '{' | '[' | '#' | '&' | '*' | '!' | '|' | '>') {
        return None;
    }
    let mut search = 0;
    while let Some(rel) = body[search..].find(':') {
        let at = search + rel;
        if body[at + 1..].chars().next().is_none_or(|c| c == ' ' || c == '\t') {
            let key = body[..at].trim_end();
            if key.is_empty() || key.contains(" #") {
                return None;
            }
            return Some((key.to_string(), at + 1));
        }
        search = at + 1;
    }
    None
}

/// The scalar starting at `start`: its value, the comment after it, whether it was quoted, and
/// where its text ends.
fn scalar(text: &str, start: usize, end: usize) -> (String, String, bool, usize) {
    let raw = &text[start..end];
    let comment_of = |rest: &str| rest.trim().strip_prefix('#').map(|c| c.trim().to_string()).unwrap_or_default();
    match raw.chars().next() {
        Some('"') => {
            let mut out = String::new();
            let mut escaped = false;
            for (i, ch) in raw.char_indices().skip(1) {
                if escaped {
                    out.push(match ch {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        '0' => '\0',
                        other => other,
                    });
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    return (out, comment_of(&raw[i + 1..]), true, start + i + 1);
                } else {
                    out.push(ch);
                }
            }
            (out, String::new(), true, end)
        }
        Some('\'') => {
            let mut out = String::new();
            let mut chars = raw.char_indices().skip(1).peekable();
            while let Some((i, ch)) = chars.next() {
                if ch == '\'' {
                    if chars.peek().map(|(_, c)| *c) == Some('\'') {
                        chars.next();
                        out.push('\'');
                        continue;
                    }
                    return (out, comment_of(&raw[i + 1..]), true, start + i + 1);
                }
                out.push(ch);
            }
            (out, String::new(), true, end)
        }
        _ => {
            let cut = raw.find(" #").or_else(|| raw.find("\t#")).unwrap_or(raw.len());
            let value = raw[..cut].trim_end();
            let value = if matches!(value, "~" | "null" | "Null" | "NULL") { "" } else { value };
            (value.to_string(), comment_of(&raw[cut..]), false, start + raw[..cut].trim_end().len())
        }
    }
}

fn reference_of(leaf: &Leaf, value: &str) -> Option<String> {
    reference_value(value).or_else(|| if value.trim().is_empty() { reference_in(&leaf.comment) } else { None })
}

/// Spring-style: every leaf, `.`-joined, list items as `[i]`.
pub fn parse_flat(text: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    for leaf in leaves(text) {
        let mut key = String::new();
        for seg in &leaf.path {
            match seg {
                Seg::Key(k) => {
                    if !key.is_empty() {
                        key.push('.');
                    }
                    key.push_str(k);
                }
                Seg::Index(i) => key.push_str(&format!("[{i}]")),
            }
        }
        let edit = if leaf.item_start.is_some() {
            Edit::Refused("env.refusedYamlList")
        } else {
            Edit::Comment { start: leaf.value_from, end: leaf.content_end, insert: " ".into() }
        };
        let reference = reference_of(&leaf, &leaf.value);
        // Several documents may set the same key; the last one read is the one a reader without
        // profiles ends up with.
        out.retain(|e| e.key != key);
        out.push(Entry { key, value: leaf.value, line: leaf.line, reference, sub: None, edit });
    }
    out.sort_by_key(|e| e.line);
    out
}

/// A Compose file: each service's `environment`, map or list form, plus every service's name.
pub fn parse_compose(text: &str) -> (Vec<String>, Vec<Entry>) {
    let mut services: Vec<String> = Vec::new();
    let mut entries = Vec::new();
    for leaf in leaves(text) {
        let (Some(Seg::Key(top)), Some(Seg::Key(service))) = (leaf.path.first(), leaf.path.get(1)) else { continue };
        if top != "services" {
            continue;
        }
        if !services.contains(service) {
            services.push(service.clone());
        }
        if leaf.path.len() != 4 || leaf.path[2] != Seg::Key("environment".into()) {
            continue;
        }
        match &leaf.path[3] {
            Seg::Key(key) => {
                let reference = reference_of(&leaf, &leaf.value);
                entries.push(Entry {
                    key: key.clone(),
                    value: leaf.value.clone(),
                    line: leaf.line,
                    reference,
                    sub: Some(service.clone()),
                    edit: Edit::Comment { start: leaf.value_from, end: leaf.content_end, insert: " ".into() },
                });
            }
            Seg::Index(_) => {
                let item = &leaf.value;
                let (key, value) = match item.split_once('=') {
                    Some((k, v)) => (k.trim().to_string(), v.to_string()),
                    None => (item.trim().to_string(), String::new()),
                };
                if key.is_empty() {
                    continue;
                }
                let start = leaf.item_start.unwrap_or(leaf.value_from);
                let edit = if leaf.quoted {
                    Edit::Comment { start, end: leaf.content_end, insert: format!("{key} ") }
                } else {
                    let raw = &text[start..leaf.content_end];
                    let cut = raw.find('=').unwrap_or_else(|| raw.find(" #").unwrap_or(raw.len()));
                    Edit::Comment { start: start + raw[..cut].trim_end().len(), end: leaf.content_end, insert: " ".into() }
                };
                let reference = reference_of(&leaf, &value);
                entries.push(Entry { key, value, line: leaf.line, reference, sub: Some(service.clone()), edit });
            }
        }
    }
    (services, entries)
}

#[cfg(test)]
mod tests {
    use super::super::edit::apply;
    use super::*;

    fn pairs(entries: &[Entry]) -> Vec<(String, String)> {
        entries.iter().map(|e| (e.key.clone(), e.value.clone())).collect()
    }

    const SPRING: &str = "# app\nserver:\n  port: 8080 # http\nspring:\n  datasource:\n    url: \"jdbc:postgresql://localhost/app\"\n    password: 's3''cret'\n    username:\n  profiles:\n    active: dev\napp:\n  hosts:\n    - a.example\n    - b.example\n  banner: |\n    line one\n    line two\n  empty: ~\n---\nserver:\n  port: 9090\n";

    #[test]
    fn spring_yaml_flattens_with_dots_and_documents_merge() {
        let entries = parse_flat(SPRING);
        let mut got = pairs(&entries);
        got.sort();
        let mut want: Vec<(String, String)> = [
            ("spring.datasource.url", "jdbc:postgresql://localhost/app"),
            ("spring.datasource.password", "s3'cret"),
            ("spring.datasource.username", ""),
            ("spring.profiles.active", "dev"),
            ("app.hosts[0]", "a.example"),
            ("app.hosts[1]", "b.example"),
            ("app.banner", "line one\nline two"),
            ("app.empty", ""),
            ("server.port", "9090"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn rewriting_a_spring_value_keeps_every_other_byte() {
        let entries = parse_flat(SPRING);
        let password = entries.iter().find(|e| e.key == "spring.datasource.password").unwrap();
        let out = apply(SPRING, &password.edit, "id9").unwrap();
        assert_eq!(out, SPRING.replace("password: 's3''cret'", "password: # llavero:id9"));
        let back = parse_flat(&out);
        let moved = back.iter().find(|e| e.key == "spring.datasource.password").unwrap();
        assert_eq!((moved.value.as_str(), moved.reference.as_deref()), ("", Some("id9")));
        // A list item cannot carry a reference.
        assert!(matches!(entries.iter().find(|e| e.key == "app.hosts[0]").unwrap().edit, Edit::Refused(_)));
    }

    const COMPOSE: &str = "services:\n  api:\n    image: api\n    environment:\n      DB_URL: postgres://db\n      TOKEN: \"abc\" # secret\n      EMPTY:\n  worker:\n    environment:\n    - QUEUE=jobs\n    - PASSTHROUGH\n    - \"QUOTED=x y\"\n  db:\n    image: postgres\n";

    #[test]
    fn compose_reads_both_environment_forms_per_service() {
        let (services, entries) = parse_compose(COMPOSE);
        assert_eq!(services, vec!["api", "worker", "db"]);
        let got: Vec<(String, String, String)> =
            entries.iter().map(|e| (e.sub.clone().unwrap(), e.key.clone(), e.value.clone())).collect();
        let want: Vec<(String, String, String)> = [
            ("api", "DB_URL", "postgres://db"),
            ("api", "TOKEN", "abc"),
            ("api", "EMPTY", ""),
            ("worker", "QUEUE", "jobs"),
            ("worker", "PASSTHROUGH", ""),
            ("worker", "QUOTED", "x y"),
        ]
        .iter()
        .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()))
        .collect();
        assert_eq!(got, want);
    }

    #[test]
    fn compose_rewrites_become_pass_throughs() {
        let (_, entries) = parse_compose(COMPOSE);
        let find = |k: &str| entries.iter().find(|e| e.key == k).unwrap();
        assert_eq!(apply(COMPOSE, &find("TOKEN").edit, "t").unwrap(), COMPOSE.replace("TOKEN: \"abc\" # secret", "TOKEN: # llavero:t"));
        assert_eq!(apply(COMPOSE, &find("QUEUE").edit, "q").unwrap(), COMPOSE.replace("- QUEUE=jobs", "- QUEUE # llavero:q"));
        assert_eq!(apply(COMPOSE, &find("QUOTED").edit, "z").unwrap(), COMPOSE.replace("- \"QUOTED=x y\"", "- QUOTED # llavero:z"));
        let out = apply(COMPOSE, &find("QUEUE").edit, "q").unwrap();
        let (_, back) = parse_compose(&out);
        let moved = back.iter().find(|e| e.key == "QUEUE").unwrap();
        assert_eq!((moved.value.as_str(), moved.reference.as_deref()), ("", Some("q")));
    }

    #[test]
    fn a_sequence_at_the_parents_indent_and_maps_inside_items() {
        let text = "list:\n- name: a\n  value: 1\n- name: b\nafter: x\n";
        let got = pairs(&parse_flat(text));
        assert_eq!(
            got,
            vec![
                ("list[0].name".to_string(), "a".to_string()),
                ("list[0].value".to_string(), "1".to_string()),
                ("list[1].name".to_string(), "b".to_string()),
                ("after".to_string(), "x".to_string()),
            ]
        );
    }
}
