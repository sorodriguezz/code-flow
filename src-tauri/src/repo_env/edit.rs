//! A Llavero reference written into a configuration file, and read back out of one.
//!
//! The user asked for «pasar un secreto al Llavero con un clic: el archivo queda con una referencia
//! y Servicios inyecta el valor al arrancar» (2026-10-23). The reference has two jobs that pull in
//! different directions: Services has to find it, and **every other tool that reads the file has to
//! be unharmed by it** — the same `.env` is read by `pnpm dev` in a terminal, by Docker, by CI. So
//! wherever the format allows a comment, the value is *emptied* and the id goes in a comment:
//!
//! | format | after the move | what another reader sees |
//! |---|---|---|
//! | dotenv | `KEY= # llavero:<id>` | an empty `KEY` |
//! | YAML (Spring, Compose map) | `key: # llavero:<id>` | null — Compose then takes `KEY` from the environment |
//! | Compose list | `- KEY # llavero:<id>` | a pass-through: the value comes from the environment |
//! | `.properties` | `# llavero:<id>` on the line above, `key=` | an empty property |
//! | JSON (appsettings) | `"llavero:<id>"` | that string — JSON has no comments |
//!
//! An empty value is the least surprising thing a missing secret can be: the program fails the way
//! it fails on a fresh clone, rather than connecting with a made-up password. Services then hands
//! the real value over as an **environment variable**, which is the layer every one of these
//! frameworks lets override the file (dotenv libraries never overwrite a variable already set;
//! .NET reads `A__B` after appsettings; Spring's relaxed binding reads `SPRING_DATASOURCE_PASSWORD`
//! after `application.yml`). See `inject`.
//!
//! `launchSettings.json` is the one place a move is refused: `dotnet run` applies a profile's
//! variables *over* the inherited environment, so whatever is written there wins over anything
//! Services could inject.
//!
//! Only the bytes of the edited value (and, for `.properties`, one inserted line) change; every
//! other byte of the file is written back exactly as it was read.

use regex::Regex;
use std::sync::OnceLock;

pub const PREFIX: &str = "llavero:";

/// How one entry is turned into a reference. Offsets are byte offsets into the file's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// Replace `start..end` with `{insert}# llavero:<id>`.
    Comment { start: usize, end: usize, insert: String },
    /// Replace `start..end` (a JSON value token) with `"llavero:<id>"`.
    Json { start: usize, end: usize },
    /// Clear `start..end`, and insert `# llavero:<id>{newline}` at `line_start`.
    Above { line_start: usize, start: usize, end: usize, newline: String },
    /// The format cannot carry a reference that Services could honour. The string is an i18n key.
    Refused(&'static str),
}

/// The id in a `llavero:<id>` token anywhere in `text` (a comment, or a value).
pub fn reference_in(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"llavero:([A-Za-z0-9][A-Za-z0-9_-]{0,80})").unwrap());
    re.captures(text).map(|c| c[1].to_string())
}

/// The id when a whole value *is* a reference — `llavero:<id>`, nothing else around it.
pub fn reference_value(value: &str) -> Option<String> {
    let rest = value.trim().strip_prefix(PREFIX)?;
    (!rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| rest.to_string())
}

/// `text` with `edit` applied for item `id`. Everything outside the edit is copied as it was.
pub fn apply(text: &str, edit: &Edit, id: &str) -> Result<String, String> {
    let check = |start: usize, end: usize| {
        if start <= end && end <= text.len() && text.is_char_boundary(start) && text.is_char_boundary(end) {
            Ok(())
        } else {
            Err("the file changed while it was being read — scan it again".to_string())
        }
    };
    match edit {
        Edit::Comment { start, end, insert } => {
            check(*start, *end)?;
            Ok(format!("{}{insert}# {PREFIX}{id}{}", &text[..*start], &text[*end..]))
        }
        Edit::Json { start, end } => {
            check(*start, *end)?;
            Ok(format!("{}\"{PREFIX}{id}\"{}", &text[..*start], &text[*end..]))
        }
        Edit::Above { line_start, start, end, newline } => {
            check(*start, *end)?;
            check(*line_start, *start)?;
            Ok(format!(
                "{}# {PREFIX}{id}{newline}{}{}",
                &text[..*line_start],
                &text[*line_start..*start],
                &text[*end..]
            ))
        }
        Edit::Refused(key) => Err(key.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_are_found_in_comments_and_whole_values_only() {
        assert_eq!(reference_in("# llavero:3f2a-b1").as_deref(), Some("3f2a-b1"));
        assert_eq!(reference_value("llavero:abc-1"), Some("abc-1".into()));
        assert_eq!(reference_value("llavero:"), None);
        assert_eq!(reference_value("xllavero:abc"), None);
        assert_eq!(reference_value("llavero:abc def"), None);
    }

    #[test]
    fn an_edit_outside_the_text_is_refused_not_a_panic() {
        let edit = Edit::Comment { start: 4, end: 99, insert: " ".into() };
        assert!(apply("abc", &edit, "x").is_err());
        assert_eq!(apply("abc", &Edit::Refused("env.k"), "x").unwrap_err(), "env.k");
    }
}
