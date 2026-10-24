//! Just enough TOML to read `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `poetry.lock` and
//! `uv.lock` — tables, arrays of tables, keys, strings, arrays and inline tables.
//!
//! Not the `toml` crate on purpose: it is not a direct dependency (adding one means a new notices
//! entry and a pinned version shared with Tauri's own), and the report has to *survive* a manifest a
//! strict parser refuses — one bad line in a 300-line `pyproject.toml` must not hide the other
//! dependencies. Writing back never goes through here: bumps are textual edits (see `bump.rs`), so a
//! user's comments and alignment stay exactly where they were.

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Array(Vec<Value>),
    Table(Vec<(String, Value)>),
    /// Numbers, booleans, dates — kept as written; nothing here reads them.
    Other(String),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Table(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Dotted keys split: `serde.workspace = true` is `["serde", "workspace"]`.
    pub key: Vec<String>,
    pub value: Value,
    /// 1-based, for the report's "where".
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub header: Vec<String>,
    /// `[[package]]` rather than `[package]`.
    pub array: bool,
    pub entries: Vec<Entry>,
}

impl Table {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|e| e.key.len() == 1 && e.key[0] == key).map(|e| &e.value)
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }
}

struct Cursor<'a> {
    chars: Vec<char>,
    pos: usize,
    line: usize,
    _src: &'a str,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += 1;
        if c == '\n' {
            self.line += 1;
        }
        Some(c)
    }

    fn skip_inline_ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\r')) {
            self.bump();
        }
    }

    /// Whitespace, newlines and comments — what may sit between the items of an array.
    fn skip_all_ws(&mut self) {
        loop {
            match self.peek() {
                Some(' ' | '\t' | '\r' | '\n') => {
                    self.bump();
                }
                Some('#') => self.skip_line(),
                _ => break,
            }
        }
    }

    fn skip_line(&mut self) {
        while let Some(c) = self.peek() {
            if c == '\n' {
                break;
            }
            self.bump();
        }
    }

    fn starts_with(&self, s: &str) -> bool {
        s.chars().enumerate().all(|(i, c)| self.peek_at(i) == Some(c))
    }
}

/// Reads a document. Never fails: a line it cannot read is skipped, and every table and key it
/// could read is returned.
pub fn parse(text: &str) -> Vec<Table> {
    let mut c = Cursor { chars: text.chars().collect(), pos: 0, line: 1, _src: text };
    let mut tables = vec![Table { header: vec![], array: false, entries: vec![] }];
    loop {
        c.skip_all_ws();
        let Some(ch) = c.peek() else { break };
        if ch == '[' {
            let array = c.peek_at(1) == Some('[');
            c.bump();
            if array {
                c.bump();
            }
            c.skip_inline_ws();
            let header = read_key(&mut c);
            c.skip_inline_ws();
            if c.peek() == Some(']') {
                c.bump();
                if array && c.peek() == Some(']') {
                    c.bump();
                }
                tables.push(Table { header, array, entries: vec![] });
            }
            c.skip_line();
            continue;
        }
        let line = c.line;
        let key = read_key(&mut c);
        c.skip_inline_ws();
        if key.is_empty() || c.peek() != Some('=') {
            c.skip_line();
            continue;
        }
        c.bump();
        c.skip_inline_ws();
        match read_value(&mut c) {
            Some(value) => {
                if let Some(table) = tables.last_mut() {
                    table.entries.push(Entry { key, value, line });
                }
            }
            None => {}
        }
        c.skip_line();
    }
    tables
}

fn read_key(c: &mut Cursor) -> Vec<String> {
    let mut parts = Vec::new();
    loop {
        c.skip_inline_ws();
        let part = match c.peek() {
            Some('"') => read_basic(c),
            Some('\'') => read_literal(c),
            _ => {
                let mut s = String::new();
                while let Some(ch) = c.peek() {
                    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                        s.push(ch);
                        c.bump();
                    } else {
                        break;
                    }
                }
                if s.is_empty() {
                    return parts;
                }
                s
            }
        };
        parts.push(part);
        c.skip_inline_ws();
        if c.peek() == Some('.') {
            c.bump();
        } else {
            return parts;
        }
    }
}

fn read_basic(c: &mut Cursor) -> String {
    if c.starts_with("\"\"\"") {
        c.pos += 3;
        let mut s = String::new();
        while c.peek().is_some() && !c.starts_with("\"\"\"") {
            if let Some(ch) = c.bump() {
                s.push(ch);
            }
        }
        c.pos += 3.min(c.chars.len().saturating_sub(c.pos));
        return s.trim_start_matches('\n').to_string();
    }
    c.bump();
    let mut s = String::new();
    while let Some(ch) = c.peek() {
        if ch == '"' || ch == '\n' {
            break;
        }
        c.bump();
        if ch == '\\' {
            match c.bump() {
                Some('n') => s.push('\n'),
                Some('t') => s.push('\t'),
                Some(other) => s.push(other),
                None => {}
            }
        } else {
            s.push(ch);
        }
    }
    if c.peek() == Some('"') {
        c.bump();
    }
    s
}

fn read_literal(c: &mut Cursor) -> String {
    if c.starts_with("'''") {
        c.pos += 3;
        let mut s = String::new();
        while c.peek().is_some() && !c.starts_with("'''") {
            if let Some(ch) = c.bump() {
                s.push(ch);
            }
        }
        c.pos += 3.min(c.chars.len().saturating_sub(c.pos));
        return s;
    }
    c.bump();
    let mut s = String::new();
    while let Some(ch) = c.peek() {
        if ch == '\'' || ch == '\n' {
            break;
        }
        s.push(ch);
        c.bump();
    }
    if c.peek() == Some('\'') {
        c.bump();
    }
    s
}

fn read_value(c: &mut Cursor) -> Option<Value> {
    match c.peek()? {
        '"' => Some(Value::Str(read_basic(c))),
        '\'' => Some(Value::Str(read_literal(c))),
        '[' => {
            c.bump();
            let mut items = Vec::new();
            loop {
                c.skip_all_ws();
                match c.peek() {
                    None => return Some(Value::Array(items)),
                    Some(']') => {
                        c.bump();
                        return Some(Value::Array(items));
                    }
                    Some(',') => {
                        c.bump();
                    }
                    Some(_) => {
                        let before = c.pos;
                        if let Some(v) = read_value(c) {
                            items.push(v);
                        }
                        if c.pos == before {
                            c.bump();
                        }
                    }
                }
            }
        }
        '{' => {
            c.bump();
            let mut entries = Vec::new();
            loop {
                c.skip_all_ws();
                match c.peek() {
                    None => return Some(Value::Table(entries)),
                    Some('}') => {
                        c.bump();
                        return Some(Value::Table(entries));
                    }
                    Some(',') => {
                        c.bump();
                    }
                    Some(_) => {
                        let key = read_key(c);
                        c.skip_inline_ws();
                        if key.is_empty() || c.peek() != Some('=') {
                            c.bump();
                            continue;
                        }
                        c.bump();
                        c.skip_inline_ws();
                        if let Some(v) = read_value(c) {
                            entries.push((key.join("."), v));
                        }
                    }
                }
            }
        }
        _ => {
            let mut s = String::new();
            while let Some(ch) = c.peek() {
                if matches!(ch, ',' | ']' | '}' | '\n' | '#') {
                    break;
                }
                s.push(ch);
                c.bump();
            }
            Some(Value::Other(s.trim().to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tables_keys_and_inline_values() {
        let doc = parse(
            r#"
# comment
[package]
name = "demo"

[dependencies]
serde = { version = "1.0", features = ["derive"] } # trailing
tokio.workspace = true
"quoted-name" = '0.3'

[target.'cfg(windows)'.dependencies]
winapi = "0.3"

[[package]]
name = "a"
version = "1.0.0"
"#,
        );
        let deps = doc.iter().find(|t| t.header == ["dependencies"]).unwrap();
        assert_eq!(deps.get("serde").and_then(|v| v.get("version")).and_then(Value::as_str), Some("1.0"));
        assert_eq!(deps.entries[1].key, vec!["tokio", "workspace"]);
        assert_eq!(deps.str("quoted-name"), Some("0.3"));
        assert_eq!(deps.entries[0].line, 7);
        assert!(doc.iter().any(|t| t.header == ["target", "cfg(windows)", "dependencies"]));
        let pkg = doc.iter().find(|t| t.array).unwrap();
        assert_eq!(pkg.str("version"), Some("1.0.0"));
    }

    #[test]
    fn reads_multi_line_arrays_and_survives_garbage() {
        let doc = parse(
            "[project]\ndependencies = [\n  \"requests>=2.31\",  # http\n  'rich',\n]\nthis is not toml\nname = \"x\"\n",
        );
        let project = &doc[1];
        match project.get("dependencies") {
            Some(Value::Array(items)) => assert_eq!(items.len(), 2),
            other => panic!("{other:?}"),
        }
        assert_eq!(project.str("name"), Some("x"));
    }
}
