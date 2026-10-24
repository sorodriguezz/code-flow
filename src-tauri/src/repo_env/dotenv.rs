//! dotenv files, read with the position of every value so one can be rewritten in place.
//!
//! The same dialect `services::envfile` loads — `KEY=value`, `export`, `#` comments, single, double
//! and backtick quotes — plus what that loader never needed: a quoted value may run over several
//! lines (a PEM key is the usual case), and every value remembers where it is in the file.

use super::edit::{reference_in, reference_value, Edit};
use super::Entry;

pub fn parse(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut pos = 0;
    let mut line_no = 0;
    while pos < text.len() {
        line_no += 1;
        let line_start = pos;
        let (content_end, next) = line_bounds(text, pos);
        pos = next;
        let line = &text[line_start..content_end];
        let lead = line.len() - line.trim_start().len();
        let mut at = line_start + lead;
        let body = &text[at..content_end];
        if body.is_empty() || body.starts_with('#') {
            continue;
        }
        if let Some(rest) = body.strip_prefix("export ") {
            at += body.len() - rest.len();
            at += rest.len() - rest.trim_start().len();
        }
        let Some(eq_rel) = text[at..content_end].find('=') else { continue };
        let key = text[at..at + eq_rel].trim();
        if key.is_empty() || key.chars().any(char::is_whitespace) {
            continue;
        }
        let eq_end = at + eq_rel + 1;
        let after = &text[eq_end..content_end];
        let value_start = eq_end + (after.len() - after.trim_start().len());
        let first = text[value_start..].chars().next();

        let (value, tail_start, entry_end, lines) = match first {
            Some(quote @ ('"' | '\'' | '`')) if value_start < content_end => {
                // A quoted value may close on a later line.
                let body_start = value_start + 1;
                match closing(text, body_start, quote) {
                    Some(close) => {
                        let inner = &text[body_start..close];
                        let value = if quote == '"' { unescape(inner) } else { inner.to_string() };
                        let (close_line_end, close_next) = line_bounds(text, close);
                        let spanned = text[value_start..close].matches('\n').count();
                        (value, close + 1, (close_line_end, close_next), spanned)
                    }
                    // Unclosed: the rest of the line, the way every reader does it.
                    None => (text[body_start..content_end].to_string(), content_end, (content_end, next), 0),
                }
            }
            _ => {
                let raw = &text[value_start..content_end];
                // `KEY= # comment` is an empty KEY, not one whose value is the comment.
                let cut = if raw.starts_with('#') {
                    0
                } else {
                    raw.find(" #").or_else(|| raw.find("\t#")).unwrap_or(raw.len())
                };
                let value = raw[..cut].trim_end().to_string();
                let end = value_start + raw[..cut].trim_end().len();
                (value, end, (content_end, next), 0)
            }
        };
        let tail = &text[tail_start..entry_end.0];
        let reference = reference_value(&value).or_else(|| if value.trim().is_empty() { reference_in(tail) } else { None });
        out.push(Entry {
            key: key.to_string(),
            value,
            line: line_no,
            reference,
            sub: None,
            edit: Edit::Comment { start: eq_end, end: entry_end.0, insert: " ".into() },
        });
        line_no += lines;
        pos = entry_end.1;
    }
    out
}

/// The end of the line starting at `pos` without its line break, and where the next line starts.
pub fn line_bounds(text: &str, pos: usize) -> (usize, usize) {
    match text[pos..].find('\n') {
        Some(rel) => {
            let nl = pos + rel;
            let end = if nl > pos && text.as_bytes()[nl - 1] == b'\r' { nl - 1 } else { nl };
            (end.max(pos), nl + 1)
        }
        None => (text.len(), text.len()),
    }
}

fn closing(text: &str, from: usize, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in text[from..].char_indices() {
        if quote == '"' && ch == '\\' && !escaped {
            escaped = true;
            continue;
        }
        if ch == quote && !escaped {
            return Some(from + index);
        }
        escaped = false;
    }
    None
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::edit::apply;
    use super::*;

    fn pairs(text: &str) -> Vec<(String, String)> {
        parse(text).into_iter().map(|e| (e.key, e.value)).collect()
    }

    #[test]
    fn reads_the_common_dialect() {
        let text = "# top\nA=1\nexport B = two words # note\nC=\"quoted # not a comment\"\nD='single \\n raw'\nE=\"esc\\n\\\"x\\\"\"\n\nF=\nG= # only a comment\nbad line\n=nokey\nH=a=b\n";
        assert_eq!(
            pairs(text),
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "two words".into()),
                ("C".into(), "quoted # not a comment".into()),
                ("D".into(), "single \\n raw".into()),
                ("E".into(), "esc\n\"x\"".into()),
                ("F".into(), "".into()),
                ("G".into(), "".into()),
                ("H".into(), "a=b".into()),
            ]
        );
    }

    #[test]
    fn a_quoted_value_may_span_lines_and_line_numbers_stay_right() {
        let text = "KEY=\"-----BEGIN\nabc\n-----END\"\nNEXT=1\r\nLAST=2";
        let entries = parse(text);
        assert_eq!(entries[0].value, "-----BEGIN\nabc\n-----END");
        assert_eq!((entries[1].key.as_str(), entries[1].line), ("NEXT", 4));
        assert_eq!((entries[2].key.as_str(), entries[2].value.as_str(), entries[2].line), ("LAST", "2", 5));
    }

    #[test]
    fn a_reference_is_read_from_the_comment_of_an_empty_value() {
        let entries = parse("TOKEN= # llavero:abc-123\nOTHER=llavero:def\nKEEP=v # llavero:zzz\n");
        assert_eq!(entries[0].reference.as_deref(), Some("abc-123"));
        assert_eq!(entries[1].reference.as_deref(), Some("def"));
        assert_eq!(entries[2].reference, None, "a value with a comment beside it is a value");
    }

    #[test]
    fn rewriting_touches_only_that_value() {
        let text = "# keep me\r\nexport API_KEY = \"s3cr3t\" # old note\r\nOTHER=1\r\nPEM=\"a\nb\"\nZ=9";
        let entries = parse(text);
        let api = entries.iter().find(|e| e.key == "API_KEY").unwrap();
        let out = apply(text, &api.edit, "id1").unwrap();
        assert_eq!(out, "# keep me\r\nexport API_KEY = # llavero:id1\r\nOTHER=1\r\nPEM=\"a\nb\"\nZ=9");
        let pem = parse(text).into_iter().find(|e| e.key == "PEM").unwrap();
        assert_eq!(apply(text, &pem.edit, "p").unwrap(), "# keep me\r\nexport API_KEY = \"s3cr3t\" # old note\r\nOTHER=1\r\nPEM= # llavero:p\nZ=9");
        // And the rewritten file reads back as an empty value carrying the reference.
        let back = parse(&out).into_iter().find(|e| e.key == "API_KEY").unwrap();
        assert_eq!((back.value.as_str(), back.reference.as_deref()), ("", Some("id1")));
    }
}
