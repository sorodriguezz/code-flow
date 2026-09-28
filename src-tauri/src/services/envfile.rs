//! A service's `.env` files: read at every start, layered under the variables the service itself
//! defines.
//!
//! Most projects keep their local configuration in a `.env` beside the code, and every framework's
//! own dev command reads it — but a service started here used to get only the variables typed into
//! its form, so the same command that worked in a terminal came up without its database URL. A
//! service now names the files it loads (relative to its working folder), in order: a later file
//! overrides an earlier one, and the form's own variables override them all, because those are the
//! ones written for this service in particular.
//!
//! The syntax is the common subset every dotenv reader agrees on: `KEY=value`, an optional
//! `export`, `#` comments, and single- or double-quoted values (double quotes take `\n`, `\t`, `\"`
//! and `\\`). No `${VAR}` expansion — readers disagree about it, and a value read literally is the
//! one that cannot surprise anybody.
//!
//! A file that is missing is not an error: it is said in the service's console, and the service
//! starts without it. That is the difference from a keyring reference (see `supervisor::env_of`),
//! which is refused — a file can be created later, a reference that cannot be resolved cannot.

use std::path::{Path, PathBuf};

/// What reading a service's env files produced: the variables, in load order, and a line for the
/// console about each file that could not be read.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Loaded {
    pub vars: Vec<(String, String)>,
    pub notes: Vec<String>,
}

/// The file names in a service's `env_files` column. A malformed value is no files, not a failed
/// start: the column is written by the app, and a hand-edited row should cost its files, not the
/// service.
pub fn files_of(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|file| file.trim().to_string())
        .filter(|file| !file.is_empty())
        .collect()
}

/// Reads `files` from `cwd`, in order.
pub fn load(files: &[String], cwd: Option<&Path>) -> Loaded {
    let mut loaded = Loaded::default();
    for file in files {
        let path = PathBuf::from(file);
        let full = if path.is_absolute() {
            path
        } else if let Some(cwd) = cwd {
            cwd.join(path)
        } else {
            loaded.notes.push(format!("env file {file} skipped: the service has no folder to find it in"));
            continue;
        };
        match std::fs::read_to_string(&full) {
            Ok(text) => loaded.vars.extend(parse(&text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                loaded.notes.push(format!("env file {file} not found — started without it"));
            }
            Err(e) => loaded.notes.push(format!("env file {file} could not be read: {e}")),
        }
    }
    loaded
}

/// `base` with `over` on top: a key in both takes `over`'s value, and the order is otherwise kept.
pub fn merge(base: Vec<(String, String)>, over: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = Vec::with_capacity(base.len() + over.len());
    for (key, value) in base.into_iter().chain(over) {
        match merged.iter_mut().find(|(known, _)| *known == key) {
            Some(entry) => entry.1 = value,
            None => merged.push((key, value)),
        }
    }
    merged
}

/// Parses dotenv text. Lines that are not assignments are skipped, the way every reader skips them.
pub fn parse(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((key, rest)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || key.chars().any(char::is_whitespace) {
            continue;
        }
        out.push((key.to_string(), value(rest.trim())));
    }
    out
}

/// One value: quoted, or bare with any ` #comment` after it taken off.
fn value(raw: &str) -> String {
    let mut chars = raw.chars();
    match chars.next() {
        Some(quote @ ('"' | '\'')) => {
            let body = &raw[1..];
            // Up to the closing quote; an unclosed one takes the rest of the line.
            let end = if quote == '"' { closing_double_quote(body) } else { body.find('\'') };
            let inner = &body[..end.unwrap_or(body.len())];
            if quote == '"' {
                unescape(inner)
            } else {
                inner.to_string()
            }
        }
        _ => {
            let cut = raw.find(" #").or_else(|| raw.find("\t#")).unwrap_or(raw.len());
            raw[..cut].trim_end().to_string()
        }
    }
}

/// The index of the first `"` in `body` not escaped by a backslash.
fn closing_double_quote(body: &str) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in body.char_indices() {
        match ch {
            '\\' if !escaped => escaped = true,
            '"' if !escaped => return Some(index),
            _ => escaped = false,
        }
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

/// The env files in `dir`, for the form to offer: `.env`, `.env.local`, `.env.development`… — not
/// the templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`), which hold
/// placeholders rather than configuration. `.env` first, then by name.
pub fn list(dir: &Path) -> Vec<String> {
    const TEMPLATES: [&str; 4] = ["example", "sample", "template", "dist"];
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| {
            let is_env = name == ".env" || name.starts_with(".env.");
            let template = name.rsplit('.').next().is_some_and(|last| TEMPLATES.contains(&last));
            is_env && !template
        })
        .collect();
    found.sort_by(|a, b| (a != ".env").cmp(&(b != ".env")).then(a.cmp(b)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn dotenv_text_reads_the_way_every_framework_reads_it() {
        let text = "# local settings\n\
                    PORT=4001\n\
                    export NODE_ENV=development\n\
                    DATABASE_URL=\"postgres://u:p@localhost/db\"\n\
                    GREETING='hello # not a comment'\n\
                    MULTI=\"one\\ntwo \\\"quoted\\\"\" # trailing comment\n\
                    BARE=value # comment\n\
                    EMPTY=\n\
                    not an assignment\n\
                    =no-key\n\
                    SPACED KEY=x\n\
                    URL=http://host/#anchor\n";
        assert_eq!(
            parse(text),
            pairs(&[
                ("PORT", "4001"),
                ("NODE_ENV", "development"),
                ("DATABASE_URL", "postgres://u:p@localhost/db"),
                ("GREETING", "hello # not a comment"),
                ("MULTI", "one\ntwo \"quoted\""),
                ("BARE", "value"),
                ("EMPTY", ""),
                ("URL", "http://host/#anchor"),
            ])
        );
    }

    #[test]
    fn later_sources_override_earlier_ones_in_place() {
        let merged = merge(pairs(&[("A", "1"), ("B", "2")]), pairs(&[("B", "3"), ("C", "4")]));
        assert_eq!(merged, pairs(&[("A", "1"), ("B", "3"), ("C", "4")]));
    }

    #[test]
    fn files_load_in_order_and_a_missing_one_is_said_not_fatal() {
        let dir = std::env::temp_dir().join(format!("cf-envfile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "A=1\nB=from-env\n").unwrap();
        std::fs::write(dir.join(".env.local"), "B=from-local\n").unwrap();
        let loaded = load(&[".env".into(), ".env.local".into(), ".env.missing".into()], Some(&dir));
        assert_eq!(loaded.vars, pairs(&[("A", "1"), ("B", "from-env"), ("B", "from-local")]));
        assert_eq!(loaded.notes.len(), 1);
        assert!(loaded.notes[0].contains(".env.missing"), "{:?}", loaded.notes);
        // In the merge the later file wins.
        assert_eq!(merge(Vec::new(), loaded.vars), pairs(&[("A", "1"), ("B", "from-local")]));

        // A relative file needs a folder to be relative to.
        let homeless = load(&[".env".into()], None);
        assert!(homeless.vars.is_empty());
        assert_eq!(homeless.notes.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_folder_offers_its_env_files_but_not_their_templates() {
        let dir = std::env::temp_dir().join(format!("cf-envlist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".env.d")).unwrap();
        for name in [".env.local", ".env", ".env.example", ".env.production", ".envrc", "app.env", ".env.sample"] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        assert_eq!(list(&dir), vec![".env", ".env.local", ".env.production"]);
        assert!(list(&dir.join("nope")).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bad_column_is_no_files() {
        assert_eq!(files_of(r#"[".env", " ", ".env.local "]"#), vec![".env", ".env.local"]);
        assert!(files_of("not json").is_empty());
        assert!(files_of("").is_empty());
    }
}
