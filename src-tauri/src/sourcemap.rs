//! Source maps (revision 3) for the Node debugger: which line of the generated JavaScript V8 runs
//! a line of the TypeScript the user put a breakpoint on becomes, and back — so a breakpoint set in
//! `src/app.ts` stops where it says, and a paused frame shows the `.ts` line, not the compiled one.
//!
//! Only what that needs: the `sources` (made absolute), and the `mappings` decoded into segments
//! per generated line. Names and indexed maps (`sections`) are not read; a map that uses sections
//! parses as having no sources, and the debugger then treats the script as plain JavaScript.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;

/// One mapping segment: from a column of a generated line to a line of one source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Segment {
    column: u32,
    source: u32,
    line: u32,
}

#[derive(Debug, Clone, Default)]
pub struct SourceMap {
    /// Absolute paths (or the URL as written when it is not a file).
    pub sources: Vec<String>,
    /// Segments by generated line (0-based), each line's sorted by column.
    lines: Vec<Vec<Segment>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    #[serde(default)]
    sources: Vec<Option<String>>,
    #[serde(default)]
    source_root: Option<String>,
    #[serde(default)]
    mappings: String,
}

impl SourceMap {
    /// Parses map JSON. `base` is the folder relative sources are resolved against: the map file's
    /// own folder, or the script's for an inline map.
    pub fn parse(json: &str, base: Option<&Path>) -> Option<SourceMap> {
        // A map served over HTTP may open with `)]}'` to defeat JSON hijacking; the spec allows it.
        let json = json.trim_start().strip_prefix(")]}'").unwrap_or(json);
        let raw: Raw = serde_json::from_str(json).ok()?;
        let root = raw.source_root.unwrap_or_default();
        let sources = raw
            .sources
            .iter()
            .map(|source| resolve(&root, source.as_deref().unwrap_or_default(), base))
            .collect();
        Some(SourceMap { sources, lines: decode(&raw.mappings)? })
    }

    /// The source line (0-based) a generated position runs: the segment at or before `column`, or
    /// the line's first one when the position is before all of them.
    pub fn original(&self, line: u32, column: u32) -> Option<(&str, u32)> {
        let segments = self.lines.get(line as usize)?;
        let at = segments.partition_point(|s| s.column <= column);
        let segment = segments.get(at.saturating_sub(1))?;
        Some((self.sources.get(segment.source as usize)?.as_str(), segment.line))
    }

    /// Where V8 should stop for a breakpoint on `line` (0-based) of `source`: the first generated
    /// position mapped to that line. A line with no code of its own (a blank one, a lone brace) maps
    /// nowhere, so the next few lines are tried, as an editor's breakpoint on it would slide.
    pub fn generated(&self, source: &str, line: u32) -> Option<(u32, u32)> {
        let index = self.sources.iter().position(|s| same_path(s, source))? as u32;
        (line..=line + 3).find_map(|wanted| {
            self.lines.iter().enumerate().find_map(|(generated, segments)| {
                segments
                    .iter()
                    .find(|s| s.source == index && s.line == wanted)
                    .map(|s| (generated as u32, s.column))
            })
        })
    }

    pub fn covers(&self, source: &str) -> bool {
        self.sources.iter().any(|s| same_path(s, source))
    }
}

/// The map a script names: `data:` inline (base64 or percent-encoded), else a file beside the
/// script. `script_path` is the script's own file path, when it has one.
pub fn load(source_map_url: &str, script_path: Option<&Path>) -> Option<SourceMap> {
    let folder = script_path.and_then(Path::parent);
    if let Some(data) = source_map_url.strip_prefix("data:") {
        let (meta, payload) = data.split_once(',')?;
        let bytes = if meta.ends_with(";base64") {
            base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()?
        } else {
            percent_decode(payload).into_bytes()
        };
        return SourceMap::parse(&String::from_utf8_lossy(&bytes), folder);
    }
    let file = if let Some(path) = file_url_path(source_map_url) {
        path
    } else if Path::new(source_map_url).is_absolute() {
        PathBuf::from(source_map_url)
    } else {
        folder?.join(source_map_url)
    };
    let text = std::fs::read_to_string(&file).ok()?;
    SourceMap::parse(&text, file.parent())
}

/// `source` as an absolute path: `file://` URLs and webpack-style `webpack:///./src/x.ts` are made
/// paths, relative ones joined to `base` (after the map's `sourceRoot`).
fn resolve(root: &str, source: &str, base: Option<&Path>) -> String {
    let joined = if root.is_empty() || source.contains("://") || Path::new(source).is_absolute() {
        source.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), source)
    };
    if let Some(path) = file_url_path(&joined) {
        return normalize(&path);
    }
    let joined = joined.strip_prefix("webpack:///").map(str::to_string).unwrap_or(joined);
    if joined.contains("://") {
        return joined;
    }
    let path = Path::new(&joined);
    if path.is_absolute() {
        return normalize(path);
    }
    match base {
        Some(base) => normalize(&base.join(path)),
        None => joined,
    }
}

fn file_url_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let decoded = percent_decode(rest);
    // `file:///C:/x` on Windows: the path starts at the drive letter.
    let trimmed = if decoded.len() > 3 && decoded.as_bytes()[0] == b'/' && decoded.as_bytes()[2] == b':' { &decoded[1..] } else { &decoded[..] };
    Some(PathBuf::from(trimmed))
}

/// `..` and `.` resolved without touching the disk (the files need not exist where the map says —
/// only the spelling has to match what the editor sends).
fn normalize(path: &Path) -> String {
    let mut parts: Vec<std::path::Component> = Vec::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(parts.last(), Some(std::path::Component::Normal(_))) {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    parts.iter().collect::<PathBuf>().to_string_lossy().into_owned()
}

/// The same file, compared as the platform's file system compares names.
pub fn same_path(a: &str, b: &str) -> bool {
    let key = |p: &str| {
        let unified = p.replace('\\', "/");
        if cfg!(windows) {
            unified.to_ascii_lowercase()
        } else {
            unified
        }
    };
    key(a) == key(b)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The `mappings` string: `;` between generated lines, `,` between segments, each segment base64
/// VLQ fields relative to the previous one (the column to the previous in its line, the others to
/// the previous segment anywhere). Segments with one field map to nothing and are dropped.
fn decode(mappings: &str) -> Option<Vec<Vec<Segment>>> {
    let mut lines = Vec::new();
    let (mut source, mut line) = (0i64, 0i64);
    for text in mappings.split(';') {
        let mut column = 0i64;
        let mut segments = Vec::new();
        for field in text.split(',').filter(|f| !f.is_empty()) {
            let values = vlq(field)?;
            column += *values.first()?;
            if values.len() >= 4 {
                source += values[1];
                line += values[2];
                if column >= 0 && source >= 0 && line >= 0 {
                    segments.push(Segment { column: column as u32, source: source as u32, line: line as u32 });
                }
            }
        }
        segments.sort_by_key(|s| s.column);
        lines.push(segments);
    }
    Some(lines)
}

fn vlq(field: &str) -> Option<Vec<i64>> {
    let mut values = Vec::new();
    let (mut value, mut shift) = (0i64, 0u32);
    for ch in field.bytes() {
        let digit = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as i64;
        value += (digit & 31) << shift;
        if digit & 32 == 0 {
            let negative = value & 1 == 1;
            let magnitude = value >> 1;
            values.push(if negative { -magnitude } else { magnitude });
            value = 0;
            shift = 0;
        } else {
            shift += 5;
            if shift > 60 {
                return None;
            }
        }
    }
    Some(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `tsc` output for:
    //   0 const a: number = 1;
    //   1
    //   2 function f() {
    //   3   return a;
    //   4 }
    // compiled (real `tsc --sourceMap` output) to `"use strict";` on line 0, the blank line dropped:
    //   1 const a = 1;  2 function f() {  3     return a;  4 }
    const MAP: &str = r#"{"version":3,"file":"app.js","sourceRoot":"","sources":["../src/app.ts"],"names":[],"mappings":";AAAA,MAAM,CAAC,GAAW,CAAC,CAAC;AAEpB,SAAS,CAAC;IACR,OAAO,CAAC,CAAC;AACX,CAAC"}"#;

    #[test]
    fn vlq_decodes_signed_values() {
        assert_eq!(vlq("AAAA"), Some(vec![0, 0, 0, 0]));
        assert_eq!(vlq("D"), Some(vec![-1]));
        assert_eq!(vlq("gB"), Some(vec![16]));
        assert_eq!(vlq("!"), None);
    }

    #[test]
    fn maps_both_ways_and_resolves_sources() {
        let map = SourceMap::parse(MAP, Some(Path::new("/repo/dist"))).unwrap();
        assert_eq!(map.sources, vec![normalize(Path::new("/repo/src/app.ts"))]);
        let source = map.sources[0].clone();
        // `return a;` is source line 3 and generated line 3; the closing brace, 4 and 4.
        assert_eq!(map.generated(&source, 3), Some((3, 4)));
        assert_eq!(map.original(3, 4), Some((source.as_str(), 3)));
        assert_eq!(map.original(4, 0), Some((source.as_str(), 4)));
        // The blank source line 1 slides to the function on source line 2, generated line 2.
        assert_eq!(map.generated(&source, 1).map(|(line, _)| line), Some(2));
        // The `"use strict"` line maps to nothing.
        assert_eq!(map.original(0, 0), None);
        assert!(map.covers(&source));
        assert!(!map.covers("/repo/src/other.ts"));
    }

    #[test]
    fn inline_maps_load_from_data_urls() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(MAP);
        let map = load(&format!("data:application/json;charset=utf-8;base64,{encoded}"), Some(Path::new("/repo/dist/app.js"))).unwrap();
        assert_eq!(map.sources, vec![normalize(Path::new("/repo/src/app.ts"))]);
    }

    #[test]
    fn webpack_and_file_urls_become_paths() {
        assert_eq!(resolve("", "file:///repo/src/a.ts", None), normalize(Path::new("/repo/src/a.ts")));
        assert_eq!(resolve("", "webpack:///./src/a.ts", Some(Path::new("/repo"))), normalize(Path::new("/repo/src/a.ts")));
        assert_eq!(resolve("src", "a.ts", Some(Path::new("/repo"))), normalize(Path::new("/repo/src/a.ts")));
    }
}
