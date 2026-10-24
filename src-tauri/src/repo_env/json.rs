//! `appsettings*.json` and `launchSettings.json`: flattened the way .NET configuration reads them.
//!
//! A small parser of its own rather than `serde_json`, for two reasons. .NET's JSON provider accepts
//! `//` and `/* */` comments and trailing commas, and real `appsettings.json` files have them; and a
//! move into the Llavero rewrites *one value token* and must know exactly where it is. Every leaf
//! keeps its byte span.
//!
//! Keys are joined with `:` — `ConnectionStrings:Default` — and array items by index
//! (`Hosts:0`), which is what `IConfiguration` itself calls them.

use super::edit::{reference_value, Edit};
use super::Entry;

/// One scalar in the document.
#[derive(Debug, Clone, PartialEq)]
pub struct Leaf {
    pub path: Vec<String>,
    pub value: String,
    pub start: usize,
    pub end: usize,
    pub line: usize,
}

pub fn leaves(text: &str) -> Result<Vec<Leaf>, String> {
    let mut parser = Parser { text, bytes: text.as_bytes(), pos: 0, out: Vec::new() };
    parser.ws()?;
    if parser.pos >= parser.bytes.len() {
        return Ok(Vec::new());
    }
    parser.value(&mut Vec::new())?;
    parser.ws()?;
    if parser.pos < parser.bytes.len() {
        return Err(parser.error("unexpected text after the document"));
    }
    Ok(parser.out)
}

/// An appsettings-style file: every leaf, `:`-joined.
pub fn parse_settings(text: &str) -> Result<Vec<Entry>, String> {
    Ok(leaves(text)?
        .into_iter()
        .map(|leaf| Entry {
            key: leaf.path.join(":"),
            reference: reference_value(&leaf.value),
            value: leaf.value,
            line: leaf.line,
            sub: None,
            edit: Edit::Json { start: leaf.start, end: leaf.end },
        })
        .collect())
}

/// `launchSettings.json`: each profile's `environmentVariables`, plus the profile names (a profile
/// with no variables is still a column — that it has none is the finding).
pub fn parse_launch(text: &str) -> Result<(Vec<String>, Vec<Entry>), String> {
    let all = leaves(text)?;
    let mut profiles: Vec<String> = Vec::new();
    let mut entries = Vec::new();
    for leaf in all {
        if leaf.path.len() < 2 || !leaf.path[0].eq_ignore_ascii_case("profiles") {
            continue;
        }
        let profile = leaf.path[1].clone();
        if !profiles.contains(&profile) {
            profiles.push(profile.clone());
        }
        if leaf.path.len() == 4 && leaf.path[2].eq_ignore_ascii_case("environmentVariables") {
            entries.push(Entry {
                key: leaf.path[3].clone(),
                reference: reference_value(&leaf.value),
                value: leaf.value,
                line: leaf.line,
                sub: Some(profile),
                edit: Edit::Refused("env.refusedLaunch"),
            });
        }
    }
    Ok((profiles, entries))
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    pos: usize,
    out: Vec<Leaf>,
}

impl Parser<'_> {
    fn line_of(&self, at: usize) -> usize {
        self.text[..at].matches('\n').count() + 1
    }

    fn error(&self, what: &str) -> String {
        format!("line {}: {what}", self.line_of(self.pos.min(self.text.len())))
    }

    /// Whitespace, comments and a byte-order mark.
    fn ws(&mut self) -> Result<(), String> {
        loop {
            if self.text[self.pos..].starts_with('\u{feff}') {
                self.pos += 3;
                continue;
            }
            match self.bytes.get(self.pos) {
                Some(b' ' | b'\t' | b'\r' | b'\n') => self.pos += 1,
                Some(b'/') if self.bytes.get(self.pos + 1) == Some(&b'/') => {
                    while self.pos < self.bytes.len() && self.bytes[self.pos] != b'\n' {
                        self.pos += 1;
                    }
                }
                Some(b'/') if self.bytes.get(self.pos + 1) == Some(&b'*') => {
                    let Some(rel) = self.text[self.pos + 2..].find("*/") else {
                        return Err(self.error("a comment is never closed"));
                    };
                    self.pos += 2 + rel + 2;
                }
                _ => return Ok(()),
            }
        }
    }

    fn value(&mut self, path: &mut Vec<String>) -> Result<(), String> {
        match self.bytes.get(self.pos) {
            Some(b'{') => self.object(path),
            Some(b'[') => self.array(path),
            Some(b'"') => {
                let start = self.pos;
                let value = self.string()?;
                self.leaf(path, value, start);
                Ok(())
            }
            Some(_) => {
                let start = self.pos;
                while self.pos < self.bytes.len() && !matches!(self.bytes[self.pos], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n' | b'/') {
                    self.pos += 1;
                }
                let raw = &self.text[start..self.pos];
                if raw.is_empty() {
                    return Err(self.error("a value was expected"));
                }
                let value = if raw == "null" { String::new() } else { raw.to_string() };
                self.leaf(path, value, start);
                Ok(())
            }
            None => Err(self.error("the document ends early")),
        }
    }

    fn leaf(&mut self, path: &[String], value: String, start: usize) {
        let line = self.line_of(start);
        self.out.push(Leaf { path: path.to_vec(), value, start, end: self.pos, line });
    }

    fn object(&mut self, path: &mut Vec<String>) -> Result<(), String> {
        self.pos += 1;
        loop {
            self.ws()?;
            match self.bytes.get(self.pos) {
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(b'"') => {}
                _ => return Err(self.error("a key in quotes was expected")),
            }
            let key = self.string()?;
            self.ws()?;
            if self.bytes.get(self.pos) != Some(&b':') {
                return Err(self.error("':' was expected"));
            }
            self.pos += 1;
            self.ws()?;
            path.push(key);
            self.value(path)?;
            path.pop();
            self.ws()?;
            match self.bytes.get(self.pos) {
                Some(b',') => self.pos += 1,
                Some(b'}') => {}
                _ => return Err(self.error("',' or '}' was expected")),
            }
        }
    }

    fn array(&mut self, path: &mut Vec<String>) -> Result<(), String> {
        self.pos += 1;
        let mut index = 0;
        loop {
            self.ws()?;
            if self.bytes.get(self.pos) == Some(&b']') {
                self.pos += 1;
                return Ok(());
            }
            path.push(index.to_string());
            self.value(path)?;
            path.pop();
            index += 1;
            self.ws()?;
            match self.bytes.get(self.pos) {
                Some(b',') => self.pos += 1,
                Some(b']') => {}
                _ => return Err(self.error("',' or ']' was expected")),
            }
        }
    }

    /// A string token at `pos`, unescaped; `pos` ends just past its closing quote.
    fn string(&mut self) -> Result<String, String> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let Some(ch) = self.text[self.pos..].chars().next() else {
                return Err(self.error("a string is never closed"));
            };
            self.pos += ch.len_utf8();
            match ch {
                '"' => return Ok(out),
                '\\' => {
                    let Some(esc) = self.text[self.pos..].chars().next() else {
                        return Err(self.error("a string is never closed"));
                    };
                    self.pos += esc.len_utf8();
                    match esc {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'u' => {
                            let high = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&high) && self.text[self.pos..].starts_with("\\u") {
                                self.pos += 2;
                                let low = self.hex4()?;
                                0x10000 + ((high - 0xD800) << 10) + (low.wrapping_sub(0xDC00) & 0x3FF)
                            } else {
                                high
                            };
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        other => out.push(other),
                    }
                }
                other => out.push(other),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self.text.get(self.pos..self.pos + 4).ok_or_else(|| self.error("a \\u escape is cut short"))?;
        let code = u32::from_str_radix(digits, 16).map_err(|_| self.error("a \\u escape is not hexadecimal"))?;
        self.pos += 4;
        Ok(code)
    }
}

#[cfg(test)]
mod tests {
    use super::super::edit::apply;
    use super::*;

    const SETTINGS: &str = "\u{feff}{\n  // dev only\n  \"ConnectionStrings\": { \"Default\": \"Server=.;Pwd=x\\\"y\" },\n  \"Logging\": { \"LogLevel\": { \"Default\": \"Information\", } },\n  /* block */ \"Hosts\": [\"a\", \"b\"],\n  \"Port\": 5000, \"On\": true, \"Off\": null,\n  \"Empty\": {}, \"Emoji\": \"\\ud83d\\ude00\"\n}\n";

    #[test]
    fn flattens_like_iconfiguration_comments_and_trailing_commas_included() {
        let entries = parse_settings(SETTINGS).unwrap();
        let pairs: Vec<(&str, &str)> = entries.iter().map(|e| (e.key.as_str(), e.value.as_str())).collect();
        assert_eq!(
            pairs,
            vec![
                ("ConnectionStrings:Default", "Server=.;Pwd=x\"y"),
                ("Logging:LogLevel:Default", "Information"),
                ("Hosts:0", "a"),
                ("Hosts:1", "b"),
                ("Port", "5000"),
                ("On", "true"),
                ("Off", ""),
                ("Emoji", "😀"),
            ]
        );
        assert_eq!(entries[0].line, 3);
    }

    #[test]
    fn a_broken_document_says_where() {
        assert!(parse_settings("{ \"a\": 1 \"b\": 2 }").unwrap_err().starts_with("line 1"));
        assert!(parse_settings("{\n\"a\": \"open").is_err());
        assert!(parse_settings("").unwrap().is_empty());
    }

    #[test]
    fn rewriting_replaces_one_token_and_nothing_else() {
        let entries = parse_settings(SETTINGS).unwrap();
        let conn = &entries[0];
        let out = apply(SETTINGS, &conn.edit, "k1").unwrap();
        assert_eq!(out, SETTINGS.replace("\"Server=.;Pwd=x\\\"y\"", "\"llavero:k1\""));
        let back = parse_settings(&out).unwrap();
        assert_eq!(back[0].reference.as_deref(), Some("k1"));
        // A number becomes a string reference too.
        let port = entries.iter().find(|e| e.key == "Port").unwrap();
        assert!(apply(SETTINGS, &port.edit, "p").unwrap().contains("\"Port\": \"llavero:p\", \"On\""));
    }

    #[test]
    fn launch_settings_are_per_profile_and_never_movable() {
        let text = r#"{ "profiles": { "http": { "commandName": "Project", "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development", "API_KEY": "x" } }, "IIS": { "commandName": "IISExpress" } } }"#;
        let (profiles, entries) = parse_launch(text).unwrap();
        assert_eq!(profiles, vec!["http".to_string(), "IIS".to_string()]);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].sub.as_deref(), Some("http"));
        assert_eq!(entries[1].edit, Edit::Refused("env.refusedLaunch"));
    }
}
