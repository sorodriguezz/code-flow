//! Java `.properties` (Spring's `application*.properties`), with positions.
//!
//! The format has no trailing comments — a `#` after a value is part of the value — so a moved
//! value carries its reference on the comment line **above** it (`# llavero:<id>`), the only place
//! the format lets one go.

use super::dotenv::line_bounds;
use super::edit::{reference_in, reference_value, Edit};
use super::Entry;

pub fn parse(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut pos = 0;
    let mut line_no = 0;
    // The comment line just above, which may hold a reference.
    let mut previous_comment: Option<String> = None;
    while pos < text.len() {
        line_no += 1;
        let line_start = pos;
        let (mut content_end, mut next) = line_bounds(text, pos);
        pos = next;
        let line = &text[line_start..content_end];
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            previous_comment = None;
            continue;
        }
        if trimmed.starts_with('#') || trimmed.starts_with('!') {
            previous_comment = Some(trimmed[1..].trim().to_string());
            continue;
        }
        let key_start = line_start + (line.len() - trimmed.len());
        let first_line_end = content_end;
        // A logical line goes on while a line ends in an odd number of backslashes.
        let mut logical = String::new();
        let mut piece_start = key_start;
        let first_line = line_no;
        loop {
            let piece = &text[piece_start..content_end];
            let slashes = piece.len() - piece.trim_end_matches('\\').len();
            if slashes % 2 == 1 && next > content_end {
                logical.push_str(&piece[..piece.len() - 1]);
                let (end, after) = line_bounds(text, next);
                let cont = &text[next..end];
                piece_start = next + (cont.len() - cont.trim_start().len());
                content_end = end;
                pos = after;
                next = after;
                line_no += 1;
                if piece_start >= text.len() {
                    break;
                }
                continue;
            }
            logical.push_str(piece);
            break;
        }

        // The key runs to the first unescaped `=`, `:` or whitespace.
        let bytes = text.as_bytes();
        let mut at = key_start;
        while at < first_line_end {
            match bytes[at] {
                b'\\' => at += 2,
                b'=' | b':' | b' ' | b'\t' | b'\x0c' => break,
                _ => at += 1,
            }
        }
        let at = at.min(first_line_end);
        let key = unescape(&text[key_start..at]);
        // The separator: whitespace, at most one `=` or `:`, whitespace.
        let mut sep_end = at;
        while sep_end < first_line_end && matches!(bytes[sep_end], b' ' | b'\t' | b'\x0c') {
            sep_end += 1;
        }
        if sep_end < first_line_end && matches!(bytes[sep_end], b'=' | b':') {
            sep_end += 1;
        } else {
            // Whitespace alone separates; clearing the value then leaves `key` on its own.
            sep_end = at;
        }
        // The key sits on the first physical line, so its length there is its length in `logical`.
        let rest = logical.get(at - key_start..).unwrap_or("");
        let rest = rest.trim_start_matches([' ', '\t', '\x0c']);
        let rest = rest.strip_prefix(['=', ':']).unwrap_or(rest);
        let value = unescape(rest.trim_start_matches([' ', '\t', '\x0c']));

        let reference = reference_value(&value)
            .or_else(|| if value.is_empty() { previous_comment.as_deref().and_then(reference_in) } else { None });
        previous_comment = None;
        let crlf = text[first_line_end..].starts_with("\r\n") || (first_line_end == text.len() && text.contains("\r\n"));
        let newline = if crlf { "\r\n" } else { "\n" };
        out.push(Entry {
            key,
            value,
            line: first_line,
            reference,
            sub: None,
            edit: Edit::Above { line_start, start: sep_end, end: content_end, newline: newline.to_string() },
        });
    }
    out
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
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('f') => out.push('\u{c}'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                out.push(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32).unwrap_or('\u{fffd}'));
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::edit::apply;
    use super::*;

    const TEXT: &str = "# Spring\nserver.port=8080\nspring.datasource.password = s3cret#not-a-comment\nspring.datasource.url: jdbc:h2:mem\nkey\\ with\\ space value here\nlong = one, \\\n       two\n! bang comment\nempty=\nlast=\\u0041z";

    #[test]
    fn reads_separators_continuations_and_escapes() {
        let got: Vec<(String, String)> = parse(TEXT).into_iter().map(|e| (e.key, e.value)).collect();
        let want: Vec<(String, String)> = [
            ("server.port", "8080"),
            ("spring.datasource.password", "s3cret#not-a-comment"),
            ("spring.datasource.url", "jdbc:h2:mem"),
            ("key with space", "value here"),
            ("long", "one, two"),
            ("empty", ""),
            ("last", "Az"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(got, want);
        assert_eq!(parse(TEXT)[5].line, 9);
    }

    #[test]
    fn the_reference_goes_on_the_line_above_and_reads_back() {
        let entries = parse(TEXT);
        let pw = entries.iter().find(|e| e.key == "spring.datasource.password").unwrap();
        let out = apply(TEXT, &pw.edit, "r1").unwrap();
        assert_eq!(out, TEXT.replace("spring.datasource.password = s3cret#not-a-comment", "# llavero:r1\nspring.datasource.password ="));
        let back = parse(&out);
        let moved = back.iter().find(|e| e.key == "spring.datasource.password").unwrap();
        assert_eq!((moved.value.as_str(), moved.reference.as_deref()), ("", Some("r1")));
        // A continued value is cleared whole.
        let long = entries.iter().find(|e| e.key == "long").unwrap();
        assert!(apply(TEXT, &long.edit, "l").unwrap().contains("# llavero:l\nlong =\n! bang"));
    }

    #[test]
    fn crlf_files_get_a_crlf_reference_line() {
        let text = "a=1\r\nb=2\r\n";
        let b = parse(text).into_iter().find(|e| e.key == "b").unwrap();
        assert_eq!(apply(text, &b.edit, "x").unwrap(), "a=1\r\n# llavero:x\r\nb=\r\n");
    }
}
