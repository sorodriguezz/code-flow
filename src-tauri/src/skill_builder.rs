//! «Generar skill»: a skill written by a model from what CodeFlow reads — a repository, documents,
//! web pages, pasted text — and the `.skill` bundle a skill travels in.
//!
//! # Who reads the sources
//!
//! CodeFlow does, not the model: a document through anydoc and a page through the page reader (the
//! same two the stories' «Documento» and «Página web» sources use), a repository as its code map plus
//! the files that say what it is — README, agent notes, manifests, `docs/`. That is what makes the
//! task text-only, so a local model writes a skill as well as a cloud one.
//!
//! # The answer
//!
//! The model answers with files behind `=== FILE: <path> ===` lines (`ai::write_skill`): a marker
//! line is something a small local model gets right, where JSON with a whole Markdown document
//! escaped inside it is not. [`parse_draft`] reads that leniently and normalises what the Agent
//! Skills specification is strict about — the name above all, which must also be the folder's — so
//! what the user is shown is something that can be saved as it stands.
//!
//! # `.skill`
//!
//! A zip of the skill's folder with the folder itself at the root (`name/SKILL.md`), as Anthropic's
//! packager writes it. `commands::skills_cmd::import_skill_from_file` reads that and a flat zip.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What the sources may take of the model's input, all together. About 15k tokens: room for the
/// prompt and the answer on a local model with a 32k context, and plenty for a skill — which is a
/// distillation, so more source is rarely a better skill.
const TOTAL_CHARS: usize = 60_000;
/// No source is cut below this when several share [`TOTAL_CHARS`].
const MIN_SHARE: usize = 8_000;
/// The most files a skill written here may hold, and the most one of them may weigh.
const MAX_FILES: usize = 12;
const MAX_FILE_CHARS: usize = 200_000;
/// Front-matter limits from the specification (agentskills.io/specification).
const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 1_024;
/// Past this a `SKILL.md` body is too long to load whole on every activation.
const MAX_BODY_LINES: usize = 500;

/// One thing to write a skill from.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillSource {
    /// A repository or any folder on this machine.
    Repo { path: String },
    /// A PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, Markdown or text file.
    Document { path: String },
    /// A public web page — or a document behind a link.
    Url { url: String },
    /// Text written or pasted in place.
    Text { text: String },
}

/// One file of a skill, by its path inside the skill's folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillFile {
    pub path: String,
    pub content: String,
}

/// Something [`parse_draft`] fixed or found missing, for the UI to say in its own language.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DraftNote {
    /// `nameFixed`, `nameMissing`, `descriptionMissing`, `descriptionTrimmed`, `bodyLong`,
    /// `pathDropped`, `filesDropped`.
    pub code: &'static str,
    pub detail: String,
}

/// A skill as the model wrote it, normalised, before it is saved anywhere.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    /// `SKILL.md` first.
    pub files: Vec<SkillFile>,
    pub notes: Vec<DraftNote>,
}

/// A source read into text, with what to call it.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadSource {
    /// `repositorio`, `documento`, `página` or `texto` — the `tipo` the model is shown.
    pub kind: &'static str,
    pub name: String,
    pub text: String,
}

// ---------------------------------------------------------------------------------------- reading

/// Every source, read. The first one that cannot be read fails the lot, named — a skill written from
/// half of what the user picked would look complete and not be.
pub async fn read_sources(sources: &[SkillSource]) -> Result<Vec<ReadSource>, String> {
    let mut out = Vec::with_capacity(sources.len());
    for source in sources {
        let read = match source {
            SkillSource::Repo { path } => repository(path).await,
            SkillSource::Document { path } => crate::commands::stories_cmd::story_source_document(path.clone())
                .await
                .map(|doc| ReadSource { kind: "documento", name: doc.name, text: doc.markdown })
                .map_err(|e| format!("{path}: {e}")),
            SkillSource::Url { url } => crate::commands::stories_cmd::story_source_url(url.clone())
                .await
                .map(|page| ReadSource { kind: "página", name: format!("{} ({url})", page.name), text: page.markdown })
                .map_err(|e| format!("{url}: {e}")),
            SkillSource::Text { text } => Ok(ReadSource { kind: "texto", name: String::new(), text: text.clone() }),
        }?;
        if read.text.trim().is_empty() {
            return Err(format!("{} has nothing to read", if read.name.is_empty() { read.kind } else { read.name.as_str() }));
        }
        out.push(read);
    }
    Ok(out)
}

/// A repository as a model needs it to write about it: its map (folders and what each file
/// declares) and the files that say what it is and how it is worked on. Never the whole tree — a
/// skill is about how to do something here, and that lives in these files far more than in code.
async fn repository(path: &str) -> Result<ReadSource, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    let text = tokio::task::spawn_blocking(move || repository_text(&root)).await.map_err(|e| e.to_string())?;
    Ok(ReadSource { kind: "repositorio", name, text })
}

/// What [`repository`] reads, and how much of each.
const REPO_DOCS: &[(&str, usize)] = &[
    ("CLAUDE.md", 8_000),
    ("AGENTS.md", 8_000),
    ("GEMINI.md", 6_000),
    ("CONTRIBUTING.md", 6_000),
    (".github/copilot-instructions.md", 4_000),
];
const REPO_MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
    "Makefile",
    "justfile",
    "Taskfile.yml",
    "docker-compose.yml",
    "compose.yaml",
    "Dockerfile",
    ".env.example",
];
const README_CHARS: usize = 15_000;
const MANIFEST_CHARS: usize = 3_000;
const DOC_CHARS: usize = 5_000;
const MAX_DOCS: usize = 10;
const MAP_CHARS: usize = 12_000;

fn repository_text(root: &Path) -> String {
    let root_str = root.to_string_lossy().to_string();
    let files = crate::search::list_files(&root_str).unwrap_or_else(|_| crate::local_agent::tools::plain_walk(root, 20_000));
    let mut out = String::new();
    let mut section = |title: &str, body: &str| {
        let body = body.trim();
        if !body.is_empty() {
            out.push_str(&format!("### {title}\n\n{body}\n\n"));
        }
    };
    let read = |rel: &str, limit: usize| -> Option<String> {
        let text = std::fs::read_to_string(root.join(rel)).ok()?;
        Some(cut_head(&crate::secret_scan::redact(&text).0, limit))
    };

    // The README first: it is the one file written to explain the project to a newcomer.
    if let Some(readme) = files.iter().find(|f| !f.contains('/') && f.to_ascii_lowercase().starts_with("readme")) {
        if let Some(text) = read(readme, README_CHARS) {
            section(readme, &text);
        }
    }
    for (rel, limit) in REPO_DOCS {
        if files.iter().any(|f| f == rel) {
            if let Some(text) = read(rel, *limit) {
                section(rel, &text);
            }
        }
    }
    match crate::codemap::orientation(&root_str, MAP_CHARS) {
        Some(map) => section("Mapa del proyecto", &map),
        // No map (not a repository the indexer reads): the file list stands in for it.
        None => section("Archivos", &files.iter().take(300).cloned().collect::<Vec<_>>().join("\n")),
    }
    for rel in REPO_MANIFESTS {
        if files.iter().any(|f| f == rel) {
            if let Some(text) = read(rel, MANIFEST_CHARS) {
                section(rel, &text);
            }
        }
    }
    let docs = files
        .iter()
        .filter(|f| (f.starts_with("docs/") || f.starts_with("doc/")) && f.to_ascii_lowercase().ends_with(".md"))
        .take(MAX_DOCS);
    for rel in docs {
        if let Some(text) = read(rel, DOC_CHARS) {
            section(rel, &text);
        }
    }
    out
}

/// The sources and the user's focus, as the model's input: each source in a tag of its own, so
/// where one ends is never a matter of guessing, and each cut to its share of [`TOTAL_CHARS`].
pub fn assemble(focus: &str, sources: &[ReadSource]) -> String {
    let mut out = String::new();
    let focus = focus.trim();
    if focus.is_empty() {
        out.push_str("ENFOQUE: ninguno. Deduce de las fuentes qué tarea conviene enseñar.\n\n");
    } else {
        out.push_str(&format!("ENFOQUE DEL USUARIO:\n{focus}\n\n"));
    }
    let share = (TOTAL_CHARS / sources.len().max(1)).max(MIN_SHARE);
    for (index, source) in sources.iter().enumerate() {
        let name = source.name.replace('"', "'");
        out.push_str(&format!("<fuente n=\"{}\" tipo=\"{}\" nombre=\"{name}\">\n", index + 1, source.kind));
        out.push_str(cut_head(&source.text, share).trim());
        out.push_str("\n</fuente>\n\n");
    }
    out
}

/// `text`'s first `max` characters, ending on a line, with a note of what was left out. The head and
/// not the tail: a document says what it is about first.
pub(crate) fn cut_head(text: &str, max: usize) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_string();
    }
    let end = text.char_indices().nth(max).map(|(at, _)| at).unwrap_or(text.len());
    let kept = text[..end].rfind('\n').map(|at| &text[..at]).unwrap_or(&text[..end]);
    format!("{}\n[… {} caracteres omitidos]", kept.trim_end(), total - kept.chars().count())
}

// ---------------------------------------------------------------------------------------- parsing

/// The model's answer as a skill. `fallback_name` names it when the answer does not — the first
/// source's name, usually. Fails only when there is no `SKILL.md` to be had at all.
pub fn parse_draft(answer: &str, fallback_name: &str) -> Result<SkillDraft, String> {
    let text = crate::ai::strip_wrapper_fence(answer);
    let mut notes = Vec::new();
    let mut files: Vec<SkillFile> = Vec::new();

    let mut current: Option<(String, Vec<&str>)> = None;
    let mut before: Vec<&str> = Vec::new();
    let mut saw_marker = false;
    let finish = |entry: Option<(String, Vec<&str>)>, files: &mut Vec<SkillFile>, notes: &mut Vec<DraftNote>| {
        let Some((raw, lines)) = entry else { return };
        let Some(path) = clean_path(&raw) else {
            notes.push(DraftNote { code: "pathDropped", detail: raw });
            return;
        };
        if files.iter().any(|f| f.path == path) {
            return;
        }
        let content = unwrap_fence(&lines.join("\n"), path != "SKILL.md" && !path.ends_with(".md"));
        files.push(SkillFile { path, content });
    };
    for line in text.lines() {
        if let Some(path) = marker(line) {
            saw_marker = true;
            finish(current.take(), &mut files, &mut notes);
            current = Some((path, Vec::new()));
        } else if let Some((_, lines)) = current.as_mut() {
            lines.push(line);
        } else {
            before.push(line);
        }
    }
    finish(current.take(), &mut files, &mut notes);
    // No markers: the whole answer is the `SKILL.md` — what a model that ignored the format but
    // wrote the skill still deserves to have read.
    if !saw_marker {
        let whole = before.join("\n");
        if !whole.trim().is_empty() {
            files.push(SkillFile { path: "SKILL.md".into(), content: unwrap_fence(&whole, false) });
        }
    }

    let Some(at) = files.iter().position(|f| f.path == "SKILL.md" && !f.content.trim().is_empty()) else {
        return Err("The model did not write a SKILL.md".to_string());
    };
    let skill = files.remove(at);
    files.insert(0, skill);
    files.retain(|f| f.path == "SKILL.md" || !f.content.trim().is_empty());
    if files.len() > MAX_FILES {
        let dropped: Vec<String> = files.drain(MAX_FILES..).map(|f| f.path).collect();
        notes.push(DraftNote { code: "filesDropped", detail: dropped.join(", ") });
    }
    for file in &mut files {
        if file.content.chars().count() > MAX_FILE_CHARS {
            file.content = cut_head(&file.content, MAX_FILE_CHARS);
        }
    }

    // The name: the specification's rules, applied rather than reported — it is the folder too.
    let meta = crate::skill_meta::parse(&files[0].content);
    let written = meta.name.clone().unwrap_or_default();
    let mut name = spec_name(&written);
    if name.is_empty() {
        name = spec_name(fallback_name);
    }
    if name.is_empty() {
        name = "new-skill".to_string();
    }
    if written.trim().is_empty() {
        notes.push(DraftNote { code: "nameMissing", detail: name.clone() });
    } else if name != written.trim() {
        notes.push(DraftNote { code: "nameFixed", detail: written.trim().to_string() });
    }

    // The description: what the agent decides by. Missing is said, too long is cut, tags are dropped.
    let mut description = strip_tags(meta.description.as_deref().unwrap_or_default()).trim().to_string();
    if description.is_empty() {
        notes.push(DraftNote { code: "descriptionMissing", detail: String::new() });
    } else if description.chars().count() > MAX_DESCRIPTION {
        description = cut_words(&description, MAX_DESCRIPTION);
        notes.push(DraftNote { code: "descriptionTrimmed", detail: MAX_DESCRIPTION.to_string() });
    }

    let mut skill_md = set_key(&files[0].content, "name", &name);
    if !description.is_empty() {
        skill_md = set_key(&skill_md, "description", &description);
    }
    let body_lines = body_of(&skill_md).lines().count();
    if body_lines > MAX_BODY_LINES {
        notes.push(DraftNote { code: "bodyLong", detail: body_lines.to_string() });
    }
    files[0].content = ensure_newline(skill_md);
    Ok(SkillDraft { name, description, files, notes })
}

/// The path of a `=== FILE: <path> ===` line, as written. Lenient about spacing, case and backticks.
fn marker(line: &str) -> Option<String> {
    let inner = line.trim().strip_prefix("===")?.strip_suffix("===")?.trim();
    let (word, rest) = inner.split_once(':')?;
    if !word.trim().eq_ignore_ascii_case("file") {
        return None;
    }
    let path = rest.trim().trim_matches(['`', '"', '\'']).trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// A path a skill may hold — `SKILL.md`, or one file directly under `references/`, `scripts/` or
/// `assets/` — normalised, or `None`. One level deep is the specification's advice, and it is also
/// what keeps a path from walking out of the skill's folder.
pub fn clean_path(raw: &str) -> Option<String> {
    let mut path = raw.trim().replace('\\', "/");
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    // `my-skill/SKILL.md`: the model wrote the folder in front.
    let parts: &[&str] = match parts.as_slice() {
        [_, last] if last.eq_ignore_ascii_case("SKILL.md") => &parts[1..],
        [_, dir, _] if matches!(*dir, "references" | "scripts" | "assets") => &parts[1..],
        _ => &parts,
    };
    let segment_ok = |s: &str| {
        !s.is_empty() && s.len() <= 100 && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    match parts {
        [one] if one.eq_ignore_ascii_case("SKILL.md") => Some("SKILL.md".to_string()),
        [dir, file] if matches!(*dir, "references" | "scripts" | "assets") && segment_ok(file) => Some(format!("{dir}/{file}")),
        _ => None,
    }
}

/// Unwraps a fence around a whole file. `any_label`: a script's fence (` ```bash `) is a wrapper too;
/// for Markdown only an unlabelled or `markdown` one is, as in [`crate::ai::strip_wrapper_fence`].
fn unwrap_fence(text: &str, any_label: bool) -> String {
    let trimmed = text.trim_matches('\n').trim_end();
    if !any_label {
        return crate::ai::strip_wrapper_fence(trimmed);
    }
    let Some(rest) = trimmed.trim_start().strip_prefix("```") else { return trimmed.to_string() };
    let Some((_, body)) = rest.split_once('\n') else { return trimmed.to_string() };
    match body.trim_end().strip_suffix("```") {
        Some(inner) if !inner.contains("```") => inner.trim_end().to_string(),
        _ => trimmed.to_string(),
    }
}

/// A name the specification accepts: lowercase ASCII letters, digits and single hyphens, at most 64
/// characters, never "claude" or "anthropic" (the platform refuses both). Empty when nothing of
/// `raw` survives.
pub fn spec_name(raw: &str) -> String {
    let folded: String = raw.chars().map(fold_char).collect::<String>().to_lowercase();
    let mut out = String::new();
    for part in folded.split(|c: char| !c.is_ascii_alphanumeric()).filter(|p| !p.is_empty()) {
        if part == "claude" || part == "anthropic" {
            continue;
        }
        let next = if out.is_empty() { part.len() } else { out.len() + 1 + part.len() };
        if next > MAX_NAME {
            if out.is_empty() {
                out.push_str(&part[..MAX_NAME]);
            }
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(part);
    }
    out
}

/// The accented letters a Spanish or Portuguese name is written with, without them.
fn fold_char(c: char) -> char {
    match c {
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'Á' | 'À' | 'Ä' | 'Â' | 'Ã' => 'a',
        'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
        'ñ' | 'Ñ' => 'n',
        'ç' | 'Ç' => 'c',
        other => other,
    }
}

/// `text` without anything shaped like an XML tag — a description may not hold one.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' && chars.peek().is_some_and(|n| n.is_ascii_alphabetic() || *n == '/') {
            for skipped in chars.by_ref() {
                if skipped == '>' {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// At most `max` characters of `text`, ending on a word.
fn cut_words(text: &str, max: usize) -> String {
    let end = text.char_indices().nth(max).map(|(at, _)| at).unwrap_or(text.len());
    let head = &text[..end];
    head.rfind(' ').map(|at| &head[..at]).unwrap_or(head).trim_end_matches([',', ';', ':', ' ']).to_string()
}

/// The front matter's `key` set to `value` — replaced where it was, `name` first and `description`
/// after it when new, and a front matter made when there is none. Every other key is kept as it is.
pub fn set_key(skill_md: &str, key: &str, value: &str) -> String {
    let text = skill_md.trim_start_matches('\u{feff}');
    let line = format!("{key}: {}", yaml_scalar(value));
    let mut lines: Vec<&str> = text.lines().collect();
    let has_front = lines.first().map(|l| l.trim_end()) == Some("---");
    let close = if has_front { lines.iter().skip(1).position(|l| l.trim_end() == "---").map(|at| at + 1) } else { None };
    let Some(close) = close else {
        return format!("---\n{line}\n---\n\n{}", text.trim_start());
    };
    let mut front: Vec<String> = Vec::new();
    let mut at = 1;
    let mut placed = false;
    while at < close {
        let current = lines[at];
        let is_key = !current.starts_with(char::is_whitespace) && current.split_once(':').is_some_and(|(k, _)| k.trim() == key);
        if is_key {
            at += 1;
            while at < close && (lines[at].trim().is_empty() || lines[at].starts_with(char::is_whitespace)) {
                at += 1;
            }
            front.push(line.clone());
            placed = true;
            continue;
        }
        front.push(current.to_string());
        at += 1;
    }
    if !placed {
        let after_name = front.iter().position(|l| l.starts_with("name:")).map(|i| i + 1);
        match (key, after_name) {
            ("description", Some(i)) => front.insert(i, line),
            _ => front.insert(0, line),
        }
    }
    let body = lines.split_off(close + 1).join("\n");
    format!("---\n{}\n---\n{body}", front.join("\n"))
}

/// `value` as a YAML scalar: plain when that reads back the same, double-quoted (JSON's escaping is
/// valid YAML) when it would not — a colon, a leading quote or dash, a `#`.
fn yaml_scalar(value: &str) -> String {
    let plain = !value.is_empty()
        && value == value.trim()
        && !value.contains(": ")
        && !value.contains(" #")
        && !value.contains('\n')
        && !value.ends_with(':')
        && !value.starts_with(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`']);
    if plain {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
    }
}

/// A `SKILL.md`'s instructions, front matter removed.
fn body_of(skill_md: &str) -> &str {
    match skill_md.strip_prefix("---") {
        Some(rest) => rest.split_once("\n---").map(|(_, after)| after).unwrap_or(rest),
        None => skill_md,
    }
}

fn ensure_newline(mut text: String) -> String {
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// The files of a draft the user is saving or downloading, checked again — they may have edited
/// paths and contents since [`parse_draft`] — with `name` written into `SKILL.md`, where it must
/// match the folder.
pub fn finalize(name: &str, files: Vec<SkillFile>) -> Result<Vec<SkillFile>, String> {
    if files.len() > MAX_FILES {
        return Err(format!("A skill written here holds at most {MAX_FILES} files"));
    }
    let mut out: Vec<SkillFile> = Vec::with_capacity(files.len());
    for file in files {
        let path = clean_path(&file.path).ok_or_else(|| format!("«{}» is not a path a skill can hold", file.path))?;
        if out.iter().any(|f| f.path == path) {
            return Err(format!("«{path}» is there twice"));
        }
        if file.content.chars().count() > MAX_FILE_CHARS {
            return Err(format!("«{path}» is too large for a skill"));
        }
        let content = if path == "SKILL.md" { ensure_newline(set_key(&file.content, "name", name)) } else { file.content };
        out.push(SkillFile { path, content });
    }
    let Some(at) = out.iter().position(|f| f.path == "SKILL.md") else {
        return Err("A skill needs a SKILL.md".to_string());
    };
    let skill = out.remove(at);
    out.insert(0, skill);
    Ok(out)
}

// ---------------------------------------------------------------------------------------- bundles

/// Writes `files` (paths inside the skill, contents, executable) as a `.skill` at `dest`: a zip
/// whose root is the folder `name/`. Written beside `dest` and renamed into place, so a failure never
/// leaves half a bundle under the name the user chose.
pub fn write_bundle(name: &str, files: &[(String, Vec<u8>, bool)], dest: &Path) -> Result<(), String> {
    use zip::write::SimpleFileOptions;
    let staging = dest.with_extension("skill.partial");
    let result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
        let base = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory(format!("{name}/"), base.unix_permissions(0o755)).map_err(|e| e.to_string())?;
        for (path, bytes, executable) in files {
            let options = base.unix_permissions(if *executable { 0o755 } else { 0o644 });
            zip.start_file(format!("{name}/{path}"), options).map_err(|e| e.to_string())?;
            zip.write_all(bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&staging);
        return Err(error);
    }
    std::fs::rename(&staging, dest).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        format!("{}: {e}", dest.display())
    })
}

/// A draft's files as a bundle's: text, and a script executable.
pub fn draft_entries(files: &[SkillFile]) -> Vec<(String, Vec<u8>, bool)> {
    files.iter().map(|f| (f.path.clone(), f.content.clone().into_bytes(), f.path.starts_with("scripts/"))).collect()
}

/// A skill folder's files as a bundle's — every file under it but packaging noise and the app's own
/// sync marker, with the executable bit as it is on disk.
pub fn folder_entries(dir: &Path) -> Result<Vec<(String, Vec<u8>, bool)>, String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>, bool)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(name.as_str(), "__MACOSX" | ".DS_Store" | ".git" | "__pycache__" | "node_modules")
                || name.ends_with(".pyc")
                || name == crate::commands::skills_cmd::SYNC_MARKER
            {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(root, &path, out)?;
            } else if kind.is_file() {
                let rel = path.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or(name);
                out.push((rel, std::fs::read(&path)?, executable(&entry.metadata()?)));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out).map_err(|e| e.to_string())?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Where a bundle goes: what the save dialog answered, with `.skill` added when it came back bare.
pub fn bundle_path(dest: &str) -> PathBuf {
    let path = PathBuf::from(dest);
    if path.extension().is_some() {
        path
    } else {
        path.with_extension("skill")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_keeps_its_nested_bullets() {
        // A `\` line continuation in a Rust string eats the next line's indentation; the two
        // front-matter keys are nested under their bullet on purpose.
        assert!(crate::ai::DEFAULT_SKILL_PROMPT.contains("nada más.\n  - `name`: minúsculas"));
        assert!(crate::ai::DEFAULT_SKILL_PROMPT.contains("\n  - `description`: una o dos frases"));
    }

    #[test]
    fn an_answer_with_markers_becomes_files_skill_md_first() {
        let answer = "Aquí está:\n=== FILE: references/api.md ===\n# API\n\nGET /x\n=== FILE: SKILL.md ===\n---\nname: Desplegar la API\ndescription: Despliega la API de facturación. Úsala al publicar.\n---\n\n# Desplegar\n\n1. `make deploy`\n=== FILE: scripts/check.sh ===\n```bash\n#!/bin/sh\ncurl -f localhost/health\n```\n";
        let draft = parse_draft(answer, "billing").unwrap();
        assert_eq!(draft.name, "desplegar-la-api");
        assert_eq!(draft.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["SKILL.md", "references/api.md", "scripts/check.sh"]);
        assert!(draft.files[0].content.starts_with("---\nname: desplegar-la-api\ndescription: Despliega la API de facturación. Úsala al publicar.\n---\n"));
        assert_eq!(draft.files[2].content, "#!/bin/sh\ncurl -f localhost/health");
        assert_eq!(draft.notes, vec![DraftNote { code: "nameFixed", detail: "Desplegar la API".into() }]);
    }

    #[test]
    fn an_answer_without_markers_is_the_skill_md() {
        let answer = "```markdown\n---\nname: writing-release-notes\ndescription: Writes release notes from merged PRs. Use when preparing a release.\n---\n\n# Release notes\n```";
        let draft = parse_draft(answer, "x").unwrap();
        assert_eq!(draft.files.len(), 1);
        assert_eq!(draft.name, "writing-release-notes");
        assert!(draft.notes.is_empty(), "{:?}", draft.notes);
        assert!(draft.files[0].content.ends_with("# Release notes\n"));
    }

    #[test]
    fn what_cannot_be_saved_is_said_or_fixed() {
        // No front matter, a path outside the skill, an XML tag in a too-long description.
        let answer = "=== FILE: SKILL.md ===\n# Hola\n=== FILE: ../../etc/passwd ===\nx\n";
        let draft = parse_draft(answer, "Guía de Estilo").unwrap();
        assert_eq!(draft.name, "guia-de-estilo");
        assert!(draft.files[0].content.starts_with("---\nname: guia-de-estilo\n---\n"));
        let codes: Vec<&str> = draft.notes.iter().map(|n| n.code).collect();
        assert!(codes.contains(&"pathDropped") && codes.contains(&"descriptionMissing"), "{codes:?}");

        let long = format!("=== FILE: SKILL.md ===\n---\nname: x-tool\ndescription: Uses <b>bold</b> {}\n---\nbody\n", "word ".repeat(400));
        let draft = parse_draft(&long, "").unwrap();
        assert!(draft.description.chars().count() <= MAX_DESCRIPTION && !draft.description.contains('<'));
        assert!(draft.notes.iter().any(|n| n.code == "descriptionTrimmed"));

        assert!(parse_draft("   ", "x").is_err());
        assert!(parse_draft("=== FILE: references/a.md ===\nonly a reference\n", "x").is_err());
    }

    #[test]
    fn names_follow_the_specification() {
        assert_eq!(spec_name("Revisión de PRs (Claude)"), "revision-de-prs");
        assert_eq!(spec_name("--pdf--processing--"), "pdf-processing");
        assert_eq!(spec_name("anthropic"), "");
        let long = spec_name(&"segment-".repeat(20));
        assert!(long.len() <= MAX_NAME && !long.ends_with('-'));
        assert_eq!(spec_name(&"x".repeat(80)).len(), MAX_NAME);
    }

    #[test]
    fn only_paths_one_level_inside_the_skill_are_kept() {
        assert_eq!(clean_path("SKILL.md").as_deref(), Some("SKILL.md"));
        assert_eq!(clean_path("./skill.md").as_deref(), Some("SKILL.md"));
        assert_eq!(clean_path("my-skill/SKILL.md").as_deref(), Some("SKILL.md"));
        assert_eq!(clean_path("references\\api.md").as_deref(), Some("references/api.md"));
        assert_eq!(clean_path("my-skill/scripts/run.sh").as_deref(), Some("scripts/run.sh"));
        for bad in ["../SKILL2.md", "references/../../x", "references/a/b.md", "notes.md", "references/.env", "/etc/passwd", "scripts/r un.sh"] {
            assert_eq!(clean_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_front_matter_key_is_replaced_in_place_and_others_are_kept() {
        let md = "---\nname: old\nlicense: MIT\ndescription: >\n  folded\n  text\nmetadata:\n  author: me\n---\n# Body\n";
        let out = set_key(md, "description", "Does: things");
        assert_eq!(out, "---\nname: old\nlicense: MIT\ndescription: \"Does: things\"\nmetadata:\n  author: me\n---\n# Body");
        let out = set_key(&out, "name", "new-name");
        assert!(out.starts_with("---\nname: new-name\nlicense: MIT\n"));
        assert_eq!(crate::skill_meta::parse(&out).description.as_deref(), Some("Does: things"));
        // Added after the name when it was not there.
        assert_eq!(set_key("---\nname: a\n---\nb", "description", "d"), "---\nname: a\ndescription: d\n---\nb");
    }

    #[test]
    fn saving_rechecks_paths_and_writes_the_folder_name_into_skill_md() {
        let files = vec![
            SkillFile { path: "references/x.md".into(), content: "x".into() },
            SkillFile { path: "SKILL.md".into(), content: "---\nname: draft\ndescription: d\n---\nbody".into() },
        ];
        let out = finalize("final-name", files).unwrap();
        assert_eq!(out[0].path, "SKILL.md");
        assert!(out[0].content.starts_with("---\nname: final-name\ndescription: d\n"));
        assert!(finalize("a", vec![SkillFile { path: "../x".into(), content: "x".into() }]).is_err());
        assert!(finalize("a", vec![SkillFile { path: "references/x.md".into(), content: "x".into() }]).is_err());
    }

    #[test]
    fn sources_are_tagged_and_cut_to_their_share() {
        let sources = vec![
            ReadSource { kind: "documento", name: "Guía \"interna\"".into(), text: "línea\n".repeat(20_000) },
            ReadSource { kind: "texto", name: String::new(), text: "corto".into() },
        ];
        let data = assemble("  ", &sources);
        assert!(data.starts_with("ENFOQUE: ninguno."));
        assert!(data.contains("<fuente n=\"1\" tipo=\"documento\" nombre=\"Guía 'interna'\">"));
        assert!(data.contains("caracteres omitidos]\n</fuente>"));
        assert!(data.contains("<fuente n=\"2\" tipo=\"texto\" nombre=\"\">\ncorto\n</fuente>"));
        assert!(data.chars().count() < TOTAL_CHARS + 1_000);
    }

    /// The bundle is what Anthropic's packager writes: the folder at the root, scripts executable,
    /// no packaging noise and no sync marker.
    #[test]
    fn a_bundle_has_the_folder_at_its_root() {
        let dir = std::env::temp_dir().join(format!("cf-skill-bundle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src/scripts")).unwrap();
        std::fs::write(dir.join("src/SKILL.md"), "---\nname: demo\n---\n").unwrap();
        std::fs::write(dir.join("src/scripts/run.sh"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("src").join(crate::commands::skills_cmd::SYNC_MARKER), "fp").unwrap();
        std::fs::write(dir.join("src/.DS_Store"), "junk").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join("src/scripts/run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let entries = folder_entries(&dir.join("src")).unwrap();
        assert_eq!(entries.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), ["SKILL.md", "scripts/run.sh"]);
        let dest = bundle_path(&dir.join("demo").to_string_lossy());
        write_bundle("demo", &entries, &dest).unwrap();
        assert_eq!(dest.extension().and_then(|e| e.to_str()), Some("skill"));

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&dest).unwrap()).unwrap();
        let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        assert_eq!(names, ["demo/", "demo/SKILL.md", "demo/scripts/run.sh"]);
        #[cfg(unix)]
        assert_eq!(zip.by_name("demo/scripts/run.sh").unwrap().unix_mode().map(|m| m & 0o777), Some(0o755));
        assert!(!dir.join("demo.skill.partial").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
