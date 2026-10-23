//! The Context Engine: what CodeFlow puts in front of a model besides the question, and a record of
//! it.
//!
//! The CLI engines (Claude, Codex, agy…) read the repository with their own tools, so this is not
//! a second retrieval system for them. What they cannot see is the *editor*: which file is open,
//! what is selected, what has been typed and not saved, what the language server is complaining
//! about. [`editor_note`] says that, within a budget, and every piece of context a turn carries —
//! these, the `@` mentions, the memories and knowledge chunks of later phases — is listed as a
//! [`ContextSource`], stored on the turn and shown as «Contexto usado».
//!
//! Unsaved buffers matter twice: the note shows them to every engine, and the in-process agent
//! (`crate::local_agent`) reads them instead of the disk and refuses to edit them — a model writing
//! a file the user is still typing into would lose one side's work.

use std::future::Future;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

pub mod need;
pub mod on_demand;
pub mod said;

tokio::task_local! {
    static UNSAVED: Vec<UnsavedBuffer>;
}

/// Runs `work` with `buffers` as the editor's unsaved files: the in-process agent started inside it
/// reads them instead of the disk and refuses to edit them ([`current_unsaved`]).
pub async fn with_unsaved<F: Future>(buffers: Vec<UnsavedBuffer>, work: F) -> F::Output {
    UNSAVED.scope(buffers, work).await
}

/// The unsaved buffers of the turn this task is running, if it was started with [`with_unsaved`].
pub fn current_unsaved() -> Vec<UnsavedBuffer> {
    UNSAVED.try_with(Clone::clone).unwrap_or_default()
}

/// The editor's state when a question is sent. Every path is relative to the repository root.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub active_path: Option<String>,
    pub cursor_line: Option<u32>,
    pub selection: Option<Selection>,
    /// Buffers with unsaved changes: the active one and any the question mentions.
    #[serde(default)]
    pub unsaved: Vec<UnsavedBuffer>,
    /// The editor's markers (language server, linters) for the active file.
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnsavedBuffer {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub path: String,
    pub line: u32,
    /// `error` | `warning` | `info` | `hint`.
    pub severity: String,
    pub message: String,
}

/// One piece of context a turn carried.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextSource {
    pub kind: SourceKind,
    /// What the chip says.
    pub label: String,
    pub path: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    ActiveFile,
    Selection,
    Unsaved,
    Diagnostics,
    Mention,
    Diff,
    Memory,
    Knowledge,
    /// Nothing of the project was attached, and why (`need::Withheld`): the label is the reason's
    /// code, which the interface words.
    Withheld,
}

impl ContextSource {
    pub fn new(kind: SourceKind, label: impl Into<String>, path: Option<&str>) -> Self {
        Self { kind, label: label.into(), path: path.map(str::to_string), start_line: None, end_line: None }
    }

    pub fn lines(mut self, start: u32, end: u32) -> Self {
        self.start_line = Some(start);
        self.end_line = Some(end.max(start));
        self
    }
}

/// How much of a selection rides the question.
pub const SELECTION_CHARS: usize = 8_000;
/// How much unsaved text, all buffers together.
pub const UNSAVED_CHARS: usize = 24_000;
/// How many diagnostics, errors first.
pub const DIAGNOSTICS_MAX: usize = 25;

/// `rel` as a path inside `repo`, or `None` when it is absolute, climbs out, or names nothing.
pub fn inside(repo: &Path, rel: &str) -> Option<String> {
    let rel = rel.trim().trim_start_matches("./");
    let path = Path::new(rel);
    if rel.is_empty() || path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    repo.join(path).exists().then(|| rel.replace('\\', "/"))
}

fn fence_language(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "ts" | "tsx" => "ts",
        "js" | "jsx" | "mjs" | "cjs" => "js",
        "rs" => "rust",
        "py" => "python",
        "java" => "java",
        "cs" => "csharp",
        "go" => "go",
        "json" => "json",
        "md" => "md",
        "css" => "css",
        "html" => "html",
        "sql" => "sql",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        _ => "",
    }
}

fn clip(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        (text.to_string(), false)
    } else {
        (text.chars().take(max).collect(), true)
    }
}

/// Unsaved buffers that really differ from the file on disk, kept to the repository.
pub fn unsaved_in(ctx: &EditorContext, repo: &Path) -> Vec<UnsavedBuffer> {
    ctx.unsaved
        .iter()
        .filter_map(|buffer| {
            let rel = inside(repo, &buffer.path)?;
            let disk = std::fs::read_to_string(repo.join(&rel)).unwrap_or_default();
            (disk != buffer.content).then(|| UnsavedBuffer { path: rel, content: buffer.content.clone() })
        })
        .collect()
}

/// What the engine is told about the editor, appended to the message like the mention notes, and
/// the sources it used. Empty when the editor has nothing to add.
pub fn editor_note(ctx: &EditorContext, repo: &Path) -> (String, Vec<ContextSource>) {
    let mut lines: Vec<String> = Vec::new();
    let mut sources = Vec::new();

    if let Some(active) = ctx.active_path.as_deref().and_then(|p| inside(repo, p)) {
        lines.push(match ctx.cursor_line {
            Some(line) => format!("- Archivo abierto: {active} (cursor en la línea {line})"),
            None => format!("- Archivo abierto: {active}"),
        });
        sources.push(ContextSource::new(SourceKind::ActiveFile, active.clone(), Some(&active)));
    }

    if let Some(selection) = &ctx.selection {
        if let Some(path) = inside(repo, &selection.path).filter(|_| !selection.text.trim().is_empty()) {
            let (text, cut) = clip(&selection.text, SELECTION_CHARS);
            lines.push(format!(
                "- Selección en {path}, líneas {}–{}:\n```{}\n{text}\n```{}",
                selection.start_line,
                selection.end_line,
                fence_language(&path),
                if cut { "\n(selección recortada)" } else { "" }
            ));
            sources.push(
                ContextSource::new(SourceKind::Selection, format!("{path}:{}-{}", selection.start_line, selection.end_line), Some(&path))
                    .lines(selection.start_line, selection.end_line),
            );
        }
    }

    let mut left = UNSAVED_CHARS;
    for buffer in unsaved_in(ctx, repo) {
        if left == 0 {
            break;
        }
        let (text, cut) = clip(&buffer.content, left);
        left = left.saturating_sub(text.chars().count());
        lines.push(format!(
            "- {} tiene cambios SIN GUARDAR en el editor. Esta es la versión del editor, que difiere del disco; respóndela a ella:\n```{}\n{text}\n```{}",
            buffer.path,
            fence_language(&buffer.path),
            if cut { "\n(recortado)" } else { "" }
        ));
        sources.push(ContextSource::new(SourceKind::Unsaved, buffer.path.clone(), Some(&buffer.path)));
    }

    let mut diagnostics: Vec<&Diagnostic> = ctx.diagnostics.iter().filter(|d| inside(repo, &d.path).is_some()).collect();
    diagnostics.sort_by_key(|d| match d.severity.as_str() {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    });
    if !diagnostics.is_empty() {
        let shown: Vec<String> = diagnostics
            .iter()
            .take(DIAGNOSTICS_MAX)
            .map(|d| format!("  - {}:{} {}: {}", d.path, d.line, d.severity, d.message.lines().next().unwrap_or_default()))
            .collect();
        lines.push(format!("- Diagnósticos del editor ({}):\n{}", diagnostics.len(), shown.join("\n")));
        sources.push(ContextSource::new(SourceKind::Diagnostics, format!("{} diagnósticos", diagnostics.len()), None));
    }

    if lines.is_empty() {
        return (String::new(), sources);
    }
    (
        format!("\n\n---\nContexto del editor de CodeFlow (lo adjunta la app, no lo escribió el usuario):\n{}", lines.join("\n")),
        sources,
    )
}

/// The sources of the `@` mentions a question carried, as [`crate::ai::mentioned_paths`] names
/// them (`path` or `path (líneas a-b)`).
pub fn mention_sources(mentioned: &[String]) -> Vec<ContextSource> {
    mentioned
        .iter()
        .map(|entry| {
            let (path, lines) = match entry.split_once(" (líneas ") {
                Some((path, rest)) => (path, rest.trim_end_matches(')').split_once('-')),
                None => (entry.as_str(), None),
            };
            let source = ContextSource::new(SourceKind::Mention, entry.clone(), Some(path));
            match lines.and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?))) {
                Some((a, b)) => source.lines(a, b),
                None => source,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codeflow-context-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.ts"), "export const a = 1;\n").unwrap();
        std::fs::write(dir.join("src/b.ts"), "export const b = 2;\n").unwrap();
        dir
    }

    #[test]
    fn paths_must_stay_inside_the_repository() {
        let dir = repo();
        assert_eq!(inside(&dir, "src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(inside(&dir, "./src/a.ts").as_deref(), Some("src/a.ts"));
        assert!(inside(&dir, "../etc/passwd").is_none());
        assert!(inside(&dir, "/etc/passwd").is_none());
        assert!(inside(&dir, "src/missing.ts").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_note_carries_file_selection_unsaved_and_diagnostics() {
        let dir = repo();
        let ctx = EditorContext {
            active_path: Some("src/a.ts".into()),
            cursor_line: Some(1),
            selection: Some(Selection { path: "src/a.ts".into(), start_line: 1, end_line: 1, text: "export const a = 1;".into() }),
            unsaved: vec![
                UnsavedBuffer { path: "src/a.ts".into(), content: "export const a = 42;\n".into() },
                // Same as disk: not unsaved at all.
                UnsavedBuffer { path: "src/b.ts".into(), content: "export const b = 2;\n".into() },
                UnsavedBuffer { path: "../outside.ts".into(), content: "x".into() },
            ],
            diagnostics: vec![
                Diagnostic { path: "src/a.ts".into(), line: 1, severity: "warning".into(), message: "unused".into() },
                Diagnostic { path: "src/a.ts".into(), line: 1, severity: "error".into(), message: "Type 'string' is not assignable".into() },
            ],
        };
        let (note, sources) = editor_note(&ctx, &dir);
        assert!(note.contains("Archivo abierto: src/a.ts (cursor en la línea 1)"));
        assert!(note.contains("líneas 1–1"));
        assert!(note.contains("export const a = 42;"), "the editor's version, not the disk's");
        assert!(!note.contains("src/b.ts tiene cambios"), "a buffer equal to disk is not unsaved");
        assert!(!note.contains("outside"));
        let errors_first = note.find("error:").unwrap() < note.find("warning:").unwrap();
        assert!(errors_first);
        let kinds: Vec<SourceKind> = sources.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec![SourceKind::ActiveFile, SourceKind::Selection, SourceKind::Unsaved, SourceKind::Diagnostics]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn nothing_to_say_is_an_empty_note() {
        let dir = repo();
        let (note, sources) = editor_note(&EditorContext::default(), &dir);
        assert!(note.is_empty() && sources.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unsaved_text_is_budgeted() {
        let dir = repo();
        let big = "x".repeat(UNSAVED_CHARS + 500);
        let ctx = EditorContext { unsaved: vec![UnsavedBuffer { path: "src/a.ts".into(), content: big }], ..Default::default() };
        let (note, _) = editor_note(&ctx, &dir);
        assert!(note.contains("(recortado)"));
        assert!(note.chars().count() < UNSAVED_CHARS + 1_000);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mention_sources_keep_line_ranges() {
        let sources = mention_sources(&["src/a.ts".to_string(), "src/b.ts (líneas 3-9)".to_string()]);
        assert_eq!(sources[0].path.as_deref(), Some("src/a.ts"));
        assert_eq!((sources[1].start_line, sources[1].end_line), (Some(3), Some(9)));
        assert_eq!(sources[1].path.as_deref(), Some("src/b.ts"));
    }
}
