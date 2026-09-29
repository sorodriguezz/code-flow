//! Reading a `SKILL.md`'s front matter — the one reader every part of the app uses.
//!
//! Three places used to read it, each with its own scan for a single key: the importer wanted
//! `name:`, the skills note wanted `description:`, and a listing of a CLI's own skills wants both
//! plus the flags that decide whether a person may pick one at all. The scans agreed on the easy
//! cases and all failed the same hard one — a **YAML block scalar**:
//!
//! ```yaml
//! description: >
//!   Ultra-compressed communication mode. Cuts token usage ~75% …
//! ```
//!
//! which is how `caveman`, sitting in `~/.agents/skills` on the machine this was written on,
//! declares itself. Read line by line, its description is the single character `>`.
//!
//! # Deliberately not a YAML parser
//!
//! Front matter is a handful of scalars, a list or two and the occasional nested map nobody here
//! reads (`metadata:`). A real parser would be a dependency and a fresh set of failure modes in
//! exchange for reading five keys, and this runs over every skill on the machine whenever a menu
//! opens. What it covers is the subset these files are actually written in — plain, quoted and
//! block scalars, flow and block lists — and anything else yields "not stated" for that key rather
//! than a wrong value.

/// What a `SKILL.md` says about itself. Every field is optional: a skill with no front matter is
/// still a skill, it just has nothing to say.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SkillMeta {
    pub name: Option<String>,
    /// Collapsed to one line: this is what a menu row and the skills note show.
    pub description: Option<String>,
    /// `user-invocable: false` hides a skill from a person's menu — the model may still use it.
    pub user_invocable: Option<bool>,
    /// `disable-model-invocation: true` means only a person can start it; the model never will.
    pub disable_model_invocation: Option<bool>,
    /// Tools the skill pre-approves while it runs (`allowed-tools`). Surfaced because it matters
    /// before copying a skill elsewhere: a skill listing `Bash` runs shell commands unasked.
    pub allowed_tools: Vec<String>,
    pub license: Option<String>,
}

impl SkillMeta {
    /// Whether a person may pick it from a menu.
    pub fn user_may_invoke(&self) -> bool {
        self.user_invocable != Some(false)
    }

    /// Whether the model may start it on its own — which is what an instruction naming it asks.
    pub fn model_may_invoke(&self) -> bool {
        self.disable_model_invocation != Some(true)
    }
}

/// Reads the front matter at the top of `text`. Text with none — no opening `---` on the first
/// line — is [`SkillMeta::default`].
pub fn parse(text: &str) -> SkillMeta {
    let mut meta = SkillMeta::default();
    // A `SKILL.md` saved by a Windows editor starts with a byte-order mark, and it would otherwise
    // make the `---` test fail and cost the skill every field for no visible reason. `lines()`
    // already drops the `\r` of a CRLF ending.
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return meta;
    }
    // Stops at the closing `---`, so a `name:` down in the instructions is never the skill's own.
    let body: Vec<&str> = lines.take_while(|line| line.trim_end() != "---").collect();

    let mut at = 0;
    while at < body.len() {
        let line = body[at];
        at += 1;
        // Only top-level keys: an indented line belongs to the key above it, and a comment or a
        // blank line to nobody.
        if line.trim().is_empty() || line.starts_with(char::is_whitespace) || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else { continue };
        let key = key.trim();
        let rest = strip_comment(rest.trim());
        // What belongs to this key: every following line that is indented or blank.
        let start = at;
        while at < body.len() && (body[at].trim().is_empty() || body[at].starts_with(char::is_whitespace)) {
            at += 1;
        }
        let block = &body[start..at];

        match key {
            "name" => meta.name = scalar(rest, block),
            "description" => meta.description = scalar(rest, block).map(|text| one_line(&text)),
            "license" => meta.license = scalar(rest, block),
            "user-invocable" => meta.user_invocable = scalar(rest, block).and_then(|v| boolean(&v)),
            "disable-model-invocation" => {
                meta.disable_model_invocation = scalar(rest, block).and_then(|v| boolean(&v))
            }
            "allowed-tools" => meta.allowed_tools = list(rest, block),
            _ => {}
        }
    }
    meta
}

/// One scalar value: plain, quoted, or a `>`/`|` block (with its optional chomping indicator).
/// A plain value may continue on indented lines, which YAML folds into spaces.
fn scalar(rest: &str, block: &[&str]) -> Option<String> {
    let value = if rest.starts_with('>') || rest.starts_with('|') {
        let folded = rest.starts_with('>');
        let lines: Vec<&str> = block.iter().map(|line| line.trim()).collect();
        if folded {
            // Folded: lines join with spaces, and a blank line is a paragraph break.
            let mut out = String::new();
            for line in lines {
                if line.is_empty() {
                    out.push('\n');
                } else {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push(' ');
                    }
                    out.push_str(line);
                }
            }
            out
        } else {
            lines.join("\n")
        }
    } else if rest.is_empty() {
        return None;
    } else {
        let mut value = unquote(rest).to_string();
        // A plain scalar carried onto indented lines — quoted ones are left alone, since a quoted
        // value that spans lines is rare enough that reading only its first line is the safe miss.
        if !rest.starts_with('"') && !rest.starts_with('\'') {
            for line in block {
                let line = line.trim();
                if !line.is_empty() {
                    value.push(' ');
                    value.push_str(line);
                }
            }
        }
        value
    };
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// A list in any of the three spellings these files use: `[Bash, Read]`, `Bash, Read`, or one
/// `- Bash` per indented line.
fn list(rest: &str, block: &[&str]) -> Vec<String> {
    let items: Vec<String> = if rest.is_empty() {
        block
            .iter()
            .filter_map(|line| line.trim().strip_prefix('-'))
            .map(|item| unquote(item.trim()).to_string())
            .collect()
    } else {
        rest.trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|item| unquote(item.trim()).to_string())
            .collect()
    };
    items.into_iter().filter(|item| !item.is_empty()).collect()
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// Drops a trailing ` # comment` from an unquoted value.
fn strip_comment(value: &str) -> &str {
    if value.starts_with('"') || value.starts_with('\'') {
        return value;
    }
    match value.find(" #") {
        Some(at) => value[..at].trim_end(),
        None => value,
    }
}

fn boolean(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" => Some(true),
        "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Collapses a description to one line: a menu row and the skills note both show it inline.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shapes found in the skills on the machine this was written on, one each.
    #[test]
    fn a_folded_description_is_the_text_not_the_marker() {
        let caveman = "---\nname: caveman\ndescription: >\n  Ultra-compressed communication mode. Cuts token usage ~75% by speaking like caveman\n  while keeping full technical accuracy.\n---\n# Caveman\n";
        let meta = parse(caveman);
        assert_eq!(meta.name.as_deref(), Some("caveman"));
        assert_eq!(
            meta.description.as_deref(),
            Some("Ultra-compressed communication mode. Cuts token usage ~75% by speaking like caveman while keeping full technical accuracy.")
        );
    }

    #[test]
    fn plain_quoted_and_literal_values_all_read() {
        let md = "---\r\nname: \"xlsx\"\r\ndescription: 'Spreadsheets: read, write, chart'\r\nlicense: Proprietary. LICENSE.txt has complete terms\r\n---\r\n";
        let meta = parse(md);
        assert_eq!(meta.name.as_deref(), Some("xlsx"));
        assert_eq!(meta.description.as_deref(), Some("Spreadsheets: read, write, chart"));
        assert_eq!(meta.license.as_deref(), Some("Proprietary. LICENSE.txt has complete terms"));

        let literal = parse("---\nname: x\ndescription: |\n  line one\n  line two\n---\n");
        assert_eq!(literal.description.as_deref(), Some("line one line two"), "one line for a menu");

        let continued = parse("---\ndescription: starts here\n  and carries on\nname: y\n---\n");
        assert_eq!(continued.description.as_deref(), Some("starts here and carries on"));
        assert_eq!(continued.name.as_deref(), Some("y"));
    }

    #[test]
    fn a_bom_and_crlf_do_not_cost_the_skill_its_name() {
        assert_eq!(parse("\u{feff}---\r\nname: bom\r\n---\r\n").name.as_deref(), Some("bom"));
    }

    #[test]
    fn invocation_flags_and_tool_lists_are_read_in_every_spelling() {
        let hidden = parse("---\nname: a\nuser-invocable: false\ndisable-model-invocation: true\n---\n");
        assert!(!hidden.user_may_invoke());
        assert!(!hidden.model_may_invoke());
        assert!(parse("---\nname: b\n---\n").user_may_invoke(), "unstated means allowed");

        let flow = parse("---\nallowed-tools: [Bash, \"Read\"]\n---\n");
        assert_eq!(flow.allowed_tools, vec!["Bash", "Read"]);
        let inline = parse("---\nallowed-tools: Bash, Read\n---\n");
        assert_eq!(inline.allowed_tools, vec!["Bash", "Read"]);
        let block = parse("---\nallowed-tools:\n  - Bash\n  - Read\nname: c\n---\n");
        assert_eq!(block.allowed_tools, vec!["Bash", "Read"]);
        assert_eq!(block.name.as_deref(), Some("c"));
    }

    #[test]
    fn nothing_outside_the_front_matter_counts() {
        assert_eq!(parse("# just a heading\nname: nope\n"), SkillMeta::default());
        assert_eq!(parse("---\ndescription: x\n---\nname: nope\n").name, None);
        // Nested maps are skipped whole, not misread as top-level keys.
        let nested = parse("---\nmetadata:\n  name: inner\n  version: 2\nname: outer\n---\n");
        assert_eq!(nested.name.as_deref(), Some("outer"));
        // A trailing comment is not part of the value.
        assert_eq!(parse("---\nname: tidy # the short one\n---\n").name.as_deref(), Some("tidy"));
    }
}
