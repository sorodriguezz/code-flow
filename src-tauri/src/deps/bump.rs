//! Rewriting a version in a manifest without touching anything else in it.
//!
//! Every edit is a replacement of the exact characters the requirement occupies — never a parse and
//! re-serialize. A `package.json` keeps its key order and indentation, a `Cargo.toml` its comments
//! and aligned `=`, a `.csproj` its attribute order. Each bump names the requirement it expects to
//! find (`from`); a manifest that changed since the analysis simply does not match, and that bump is
//! reported as not applied rather than guessed at.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::manifests::{cargo, maven, nuget, python};
use super::{minitoml, Ecosystem};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bump {
    pub ecosystem: Ecosystem,
    pub name: String,
    /// The manifest's spelling — see `Declared::key`.
    pub key: String,
    pub section: String,
    /// The requirement as it is written now.
    pub from: String,
    /// The requirement to write.
    pub to: String,
    #[serde(default)]
    pub property: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestKind {
    PackageJson,
    CargoToml,
    MsBuild,
    Requirements,
    Pyproject,
    GoMod,
    Pom,
}

impl ManifestKind {
    pub fn of(path: &str) -> Option<Self> {
        let file = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        Some(match file.as_str() {
            "package.json" => ManifestKind::PackageJson,
            "cargo.toml" => ManifestKind::CargoToml,
            "pyproject.toml" => ManifestKind::Pyproject,
            "go.mod" => ManifestKind::GoMod,
            "pom.xml" => ManifestKind::Pom,
            "directory.packages.props" | "packages.config" => ManifestKind::MsBuild,
            f if f.ends_with(".csproj") || f.ends_with(".fsproj") || f.ends_with(".vbproj") => ManifestKind::MsBuild,
            f if f.starts_with("requirements") && f.ends_with(".txt") => ManifestKind::Requirements,
            _ => return None,
        })
    }
}

/// Applies `bumps` to `text`; the second value says, bump by bump, whether it found its place.
pub fn apply(kind: ManifestKind, text: &str, bumps: &[Bump]) -> (String, Vec<bool>) {
    let mut out = text.to_string();
    let mut applied = Vec::with_capacity(bumps.len());
    for bump in bumps {
        let next = match kind {
            ManifestKind::PackageJson => package_json(&out, bump),
            ManifestKind::CargoToml => cargo_toml(&out, bump),
            ManifestKind::MsBuild => msbuild(&out, bump),
            ManifestKind::Requirements => lines(&out, |line| requirement_line(line, bump)),
            ManifestKind::Pyproject => pyproject(&out, bump),
            ManifestKind::GoMod => lines(&out, |line| go_line(line, bump)),
            ManifestKind::Pom => pom(&out, bump),
        };
        match next {
            Some(changed) => {
                out = changed;
                applied.push(true);
            }
            None => applied.push(false),
        }
    }
    (out, applied)
}

/// Replaces `range` of `text`.
fn splice(text: &str, start: usize, end: usize, with: &str) -> String {
    format!("{}{}{}", &text[..start], with, &text[end..])
}

/// Runs `edit` over each line until one changes; keeps the file's line endings.
fn lines(text: &str, mut edit: impl FnMut(&str) -> Option<String>) -> Option<String> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        if let Some(new) = edit(body) {
            return Some(splice(text, offset, offset + body.len(), &new));
        }
        offset += line.len();
    }
    None
}

// --- package.json -----------------------------------------------------------------------------

/// The byte span of the object value of key `section` — brace to brace, strings respected.
fn json_object_span(text: &str, section: &str) -> Option<(usize, usize)> {
    let needle = format!("\"{section}\"");
    let mut search = 0;
    while let Some(found) = text[search..].find(&needle) {
        let after = search + found + needle.len();
        let rest = text[after..].trim_start();
        if let Some(rest) = rest.strip_prefix(':') {
            let rest_trim = rest.trim_start();
            if rest_trim.starts_with('{') {
                let start = text.len() - rest_trim.len();
                let bytes = text.as_bytes();
                let (mut depth, mut in_str, mut escaped) = (0i32, false, false);
                for (i, &b) in bytes.iter().enumerate().skip(start) {
                    if in_str {
                        match (escaped, b) {
                            (true, _) => escaped = false,
                            (false, b'\\') => escaped = true,
                            (false, b'"') => in_str = false,
                            _ => {}
                        }
                        continue;
                    }
                    match b {
                        b'"' => in_str = true,
                        b'{' => depth += 1,
                        b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some((start, i + 1));
                            }
                        }
                        _ => {}
                    }
                }
                return None;
            }
        }
        search = after;
    }
    None
}

fn package_json(text: &str, bump: &Bump) -> Option<String> {
    let (start, end) = json_object_span(text, &bump.section)?;
    let span = &text[start..end];
    let re = Regex::new(&format!(r#""{}"(\s*:\s*)"{}""#, regex::escape(&bump.key), regex::escape(&bump.from))).ok()?;
    let m = re.captures(span)?;
    let whole = m.get(0)?;
    let replacement = format!("\"{}\"{}\"{}\"", bump.key, &m[1], bump.to);
    Some(splice(text, start + whole.start(), start + whole.end(), &replacement))
}

// --- Cargo.toml ---------------------------------------------------------------------------------

fn header_of(line: &str) -> Option<Vec<String>> {
    let t = line.trim_start();
    if !t.starts_with('[') {
        return None;
    }
    minitoml::parse(t).pop().map(|table| table.header)
}

/// Replaces the quoted `from` that follows `after` in `line`.
fn replace_quoted(line: &str, after: usize, from: &str, to: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{quote}{from}{quote}");
        if let Some(pos) = line[after..].find(&needle) {
            let at = after + pos + 1;
            return Some(splice(line, at, at + from.len(), to));
        }
    }
    None
}

fn key_prefix(line: &str, key: &str) -> Option<usize> {
    let t = line.trim_start();
    let indent = line.len() - t.len();
    for spelled in [key.to_string(), format!("\"{key}\""), format!("'{key}'")] {
        if let Some(rest) = t.strip_prefix(&spelled) {
            let r = rest.trim_start();
            if r.starts_with('=') {
                return Some(indent + spelled.len() + (rest.len() - r.len()) + 1);
            }
        }
    }
    None
}

fn cargo_toml(text: &str, bump: &Bump) -> Option<String> {
    let mut header: Vec<String> = vec![];
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        if let Some(h) = header_of(body) {
            header = h;
        } else if !header.is_empty() {
            let last = header.last().map(String::as_str).unwrap_or("");
            let is_dep_table = matches!(last, "dependencies" | "dev-dependencies" | "build-dependencies");
            let edited = if is_dep_table && cargo::section_label(&header) == bump.section {
                key_prefix(body, &bump.key).and_then(|after| {
                    // In an inline table the version is the string after `version`.
                    let at = body[after..].find("version").map(|p| after + p).unwrap_or(after);
                    replace_quoted(body, at, &bump.from, &bump.to)
                })
            } else if header.len() >= 2
                && last == bump.key
                && cargo::section_label(&header[..header.len() - 1]) == bump.section
            {
                key_prefix(body, "version").and_then(|after| replace_quoted(body, after, &bump.from, &bump.to))
            } else {
                None
            };
            if let Some(new) = edited {
                return Some(splice(text, offset, offset + body.len(), &new));
            }
        }
        offset += line.len();
    }
    None
}

// --- MSBuild / packages.config --------------------------------------------------------------------

fn msbuild(text: &str, bump: &Bump) -> Option<String> {
    for caps in nuget::tag_re().captures_iter(text) {
        let attrs = caps.get(2)?;
        let name = nuget::attr(attrs.as_str(), "Include")
            .or_else(|| nuget::attr(attrs.as_str(), "Update"))
            .or_else(|| nuget::attr(attrs.as_str(), "id"));
        if !name.is_some_and(|n| n.eq_ignore_ascii_case(&bump.key)) {
            continue;
        }
        let re = Regex::new(&format!(r#"(?i)\bversion(\s*=\s*)"{}""#, regex::escape(&bump.from))).ok()?;
        if let Some(m) = re.find(attrs.as_str()) {
            let inner = &attrs.as_str()[m.start()..m.end()];
            let quote = inner.find('"')?;
            let at = attrs.start() + m.start() + quote + 1;
            return Some(splice(text, at, at + bump.from.len(), &bump.to));
        }
        if &caps[3] != "/" {
            let end = caps.get(0)?.end();
            let close = text[end..].find("</PackageReference>").map(|c| end + c)?;
            let child = Regex::new(&format!(r"<Version>(\s*){}(\s*)</Version>", regex::escape(&bump.from))).ok()?;
            if let Some(m) = child.captures(&text[end..close]) {
                let g = m.get(0)?;
                let at = end + g.start() + "<Version>".len() + m[1].len();
                return Some(splice(text, at, at + bump.from.len(), &bump.to));
            }
        }
    }
    None
}

// --- Python -------------------------------------------------------------------------------------

fn requirement_line(line: &str, bump: &Bump) -> Option<String> {
    let (name, spec) = python::pep508(line)?;
    if Ecosystem::Pypi.normalize(&name) != Ecosystem::Pypi.normalize(&bump.key) || spec != bump.from || bump.from.is_empty() {
        return None;
    }
    let after = line.find(&name)? + name.len();
    let pos = line[after..].find(&bump.from)? + after;
    Some(splice(line, pos, pos + bump.from.len(), &bump.to))
}

fn quoted_strings(line: &str) -> Vec<(usize, usize)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#""([^"\\]*)"|'([^']*)'"#).unwrap());
    re.captures_iter(line).filter_map(|c| c.get(1).or_else(|| c.get(2)).map(|m| (m.start(), m.end()))).collect()
}

fn pyproject(text: &str, bump: &Bump) -> Option<String> {
    let poetry = bump.section.starts_with("tool.poetry");
    lines(text, |line| {
        if poetry {
            let after = key_prefix(line, &bump.key)?;
            let at = line[after..].find("version").map(|p| after + p).unwrap_or(after);
            return replace_quoted(line, at, &bump.from, &bump.to);
        }
        for (start, end) in quoted_strings(line) {
            let inner = &line[start..end];
            if let Some(new) = requirement_line(inner, bump) {
                return Some(splice(line, start, end, &new));
            }
        }
        None
    })
}

// --- go.mod -------------------------------------------------------------------------------------

fn go_line(line: &str, bump: &Bump) -> Option<String> {
    let code = line.split("//").next().unwrap_or(line);
    let spec = code.trim().strip_prefix("require").map(str::trim).unwrap_or(code.trim());
    let mut parts = spec.split_whitespace();
    if parts.next()? != bump.key || parts.next()? != bump.from {
        return None;
    }
    let after = line.find(&bump.key)? + bump.key.len();
    let pos = line[after..].find(&bump.from)? + after;
    Some(splice(line, pos, pos + bump.from.len(), &bump.to))
}

// --- pom.xml ------------------------------------------------------------------------------------

fn pom(text: &str, bump: &Bump) -> Option<String> {
    if let Some(prop) = &bump.property {
        let re = Regex::new(&format!(r"<{p}>(\s*){v}(\s*)</{p}>", p = regex::escape(prop), v = regex::escape(&bump.from))).ok()?;
        let m = re.captures(text)?;
        let at = m.get(0)?.start() + prop.len() + 2 + m[1].len();
        return Some(splice(text, at, at + bump.from.len(), &bump.to));
    }
    let (group, artifact) = bump.key.split_once(':')?;
    for caps in maven::dependency_re().captures_iter(text) {
        let body = caps.get(1)?;
        if maven::element(body.as_str(), "groupId").as_deref() != Some(group) || maven::element(body.as_str(), "artifactId").as_deref() != Some(artifact) {
            continue;
        }
        let re = Regex::new(&format!(r"<version>(\s*){}(\s*)</version>", regex::escape(&bump.from))).ok()?;
        if let Some(m) = re.captures(body.as_str()) {
            let at = body.start() + m.get(0)?.start() + "<version>".len() + m[1].len();
            return Some(splice(text, at, at + bump.from.len(), &bump.to));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bump(eco: Ecosystem, key: &str, section: &str, from: &str, to: &str) -> Bump {
        Bump { ecosystem: eco, name: key.into(), key: key.into(), section: section.into(), from: from.into(), to: to.into(), property: None }
    }

    #[test]
    fn package_json_edits_only_the_named_section() {
        let text = "{\n  \"name\": \"web\",\n  \"dependencies\": {\n    \"react\":   \"^18.2.0\",\n    \"vite\": \"^5.0.0\"\n  },\n  \"devDependencies\": {\n    \"vite\": \"^5.0.0\"\n  }\n}\n";
        let (out, ok) = apply(ManifestKind::PackageJson, text, &[bump(Ecosystem::Npm, "vite", "devDependencies", "^5.0.0", "^5.4.10")]);
        assert_eq!(ok, vec![true]);
        assert_eq!(out, text.replacen("    \"vite\": \"^5.0.0\"\n  }\n}", "    \"vite\": \"^5.4.10\"\n  }\n}", 1));
        assert!(out.contains("\"react\":   \"^18.2.0\""), "spacing kept");
        let (_, ok) = apply(ManifestKind::PackageJson, text, &[bump(Ecosystem::Npm, "react", "dependencies", "^17.0.0", "^18.3.1")]);
        assert_eq!(ok, vec![false], "a requirement that changed since the analysis is not guessed at");
    }

    #[test]
    fn cargo_toml_edits_plain_inline_and_table_forms() {
        let text = "[dependencies]\nserde = { version = \"1.0.190\", features = [\"derive\"] } # keep\nsyn    = \"2\"\n\n[dev-dependencies]\nsyn = \"2\"\n\n[dependencies.cc]\nversion = '1.0'\n";
        let (out, ok) = apply(
            ManifestKind::CargoToml,
            text,
            &[
                bump(Ecosystem::Cargo, "serde", "dependencies", "1.0.190", "1.0.210"),
                bump(Ecosystem::Cargo, "syn", "dev-dependencies", "2", "2.0.80"),
                bump(Ecosystem::Cargo, "cc", "dependencies", "1.0", "1.1"),
            ],
        );
        assert_eq!(ok, vec![true, true, true]);
        assert_eq!(
            out,
            "[dependencies]\nserde = { version = \"1.0.210\", features = [\"derive\"] } # keep\nsyn    = \"2\"\n\n[dev-dependencies]\nsyn = \"2.0.80\"\n\n[dependencies.cc]\nversion = '1.1'\n"
        );
    }

    #[test]
    fn msbuild_edits_attribute_child_and_legacy_forms() {
        let text = "<ItemGroup>\n  <PackageReference Version=\"13.0.1\" Include=\"Newtonsoft.Json\" />\n  <PackageReference Include=\"Dapper\">\n    <Version>2.0.123</Version>\n  </PackageReference>\n</ItemGroup>\n";
        let (out, ok) = apply(
            ManifestKind::MsBuild,
            text,
            &[
                bump(Ecosystem::Nuget, "newtonsoft.json", "PackageReference", "13.0.1", "13.0.3"),
                bump(Ecosystem::Nuget, "Dapper", "PackageReference", "2.0.123", "2.1.35"),
            ],
        );
        assert_eq!(ok, vec![true, true]);
        assert!(out.contains("<PackageReference Version=\"13.0.3\" Include=\"Newtonsoft.Json\" />"));
        assert!(out.contains("<Version>2.1.35</Version>"));
        let legacy = "<packages>\n  <package id=\"jQuery\" version=\"3.6.0\" targetFramework=\"net48\" />\n</packages>";
        let (out, ok) = apply(ManifestKind::MsBuild, legacy, &[bump(Ecosystem::Nuget, "jQuery", "package", "3.6.0", "3.7.1")]);
        assert_eq!(ok, vec![true]);
        assert!(out.contains("version=\"3.7.1\" targetFramework"));
    }

    #[test]
    fn python_edits_requirements_and_pyproject() {
        let text = "requests == 2.31.0  # http\nDjango>=4.2,<5\n";
        let (out, ok) = apply(ManifestKind::Requirements, text, &[bump(Ecosystem::Pypi, "requests", "requirements", "== 2.31.0", "== 2.32.3")]);
        assert_eq!((out.as_str(), ok), ("requests == 2.32.3  # http\nDjango>=4.2,<5\n", vec![true]));

        let py = "[project]\ndependencies = [\n  \"httpx>=0.27\",\n  'rich~=13.7',\n]\n\n[tool.poetry.dependencies]\nuvicorn = { version = \"^0.29\", extras = [\"standard\"] }\n";
        let (out, ok) = apply(
            ManifestKind::Pyproject,
            py,
            &[
                bump(Ecosystem::Pypi, "rich", "dependencies", "~=13.7", "~=13.9"),
                bump(Ecosystem::Pypi, "uvicorn", "tool.poetry.dependencies", "^0.29", "^0.32"),
            ],
        );
        assert_eq!(ok, vec![true, true]);
        assert!(out.contains("'rich~=13.9',"));
        assert!(out.contains("uvicorn = { version = \"^0.32\", extras = [\"standard\"] }"));
    }

    #[test]
    fn go_mod_and_pom_edits() {
        let gomod = "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/net v0.17.0 // indirect\n)\n";
        let (out, ok) = apply(ManifestKind::GoMod, gomod, &[bump(Ecosystem::Go, "golang.org/x/net", "require (indirect)", "v0.17.0", "v0.23.0")]);
        assert_eq!(ok, vec![true]);
        assert!(out.contains("\tgolang.org/x/net v0.23.0 // indirect\n"));

        let pom = "<project><properties>\n  <jackson.version>2.15.2</jackson.version>\n</properties><dependencies>\n<dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version> 32.1.2-jre </version></dependency>\n</dependencies></project>";
        let mut b = bump(Ecosystem::Maven, "com.fasterxml.jackson.core:jackson-databind", "compile", "2.15.2", "2.18.1");
        b.property = Some("jackson.version".into());
        let (out, ok) = apply(ManifestKind::Pom, pom, &[b, bump(Ecosystem::Maven, "com.google.guava:guava", "compile", "32.1.2-jre", "33.3.1-jre")]);
        assert_eq!(ok, vec![true, true]);
        assert!(out.contains("<jackson.version>2.18.1</jackson.version>"));
        assert!(out.contains("<version> 33.3.1-jre </version>"));
    }

    #[test]
    fn knows_each_manifest_by_its_name() {
        assert_eq!(ManifestKind::of("apps/web/package.json"), Some(ManifestKind::PackageJson));
        assert_eq!(ManifestKind::of("src/App/App.csproj"), Some(ManifestKind::MsBuild));
        assert_eq!(ManifestKind::of("requirements-dev.txt"), Some(ManifestKind::Requirements));
        assert_eq!(ManifestKind::of("README.md"), None);
    }
}
