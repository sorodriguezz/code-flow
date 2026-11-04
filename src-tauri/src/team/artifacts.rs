//! What team members hand each other besides prose: the artifacts their answers carry — a
//! contract, a diagram, a test report, a document (`chat_refs::artifacts`).
//!
//! Each one is kept twice, for two readers. The app's record (`chat_artifacts`) is what the views
//! draw, versioned by name. A file in the run's folder (the same home-plus-mirror layout as a
//! chain's memory, `chain_memory`) is what the next agent opens: mirrored into every working
//! folder an item runs in, kept out of git, readable by every engine without a flag. The handoff
//! then names the file instead of pasting it — up to 24k characters of a dependency's answer used
//! to travel whole, artifacts included, and could be cut in the middle of one.

use rusqlite::Connection;

use crate::chain_memory;
use crate::chat_refs::artifacts::{self, ParsedArtifact};

use super::{Item, Run};

/// The run's folder name inside `chain-memory/` and `.codeflow/memory/`.
pub fn folder(run_id: &str) -> String {
    format!("team-{run_id}")
}

/// Where an agent in a repository finds the run's artifacts, as it is told it.
pub fn relative_folder(run_id: &str) -> String {
    chain_memory::relative_dir(&folder(run_id))
}

fn extension(kind: &str, language: &str) -> &'static str {
    match kind {
        "html" => "html",
        "markdown" => "md",
        "mermaid" => "mmd",
        "svg" => "svg",
        _ => match language.trim().to_ascii_lowercase().as_str() {
            "ts" | "typescript" => "ts",
            "tsx" => "tsx",
            "js" | "javascript" => "js",
            "rs" | "rust" => "rs",
            "py" | "python" => "py",
            "json" => "json",
            "yaml" | "yml" | "openapi" => "yaml",
            "sql" => "sql",
            "sh" | "bash" | "shell" => "sh",
            "cs" | "csharp" | "c#" => "cs",
            "java" => "java",
            "go" => "go",
            "xml" => "xml",
            "toml" => "toml",
            _ => "txt",
        },
    }
}

/// `<item key>--<artifact name>.<ext>` — flat, so the mirror copies it, and prefixed so a folder
/// listing reads as who made what.
pub fn file_name(item_key: &str, artifact: &ParsedArtifact) -> String {
    let name = artifacts::slug(&artifact.name);
    format!("{}--{}.{}", item_key, if name.is_empty() { "artefacto".to_string() } else { name }, extension(&artifact.kind, &artifact.language))
}

/// An answer without its artifact blocks: what a handoff carries now that the artifacts travel as
/// files. Text outside the blocks is kept as it was.
pub fn strip(text: &str) -> String {
    if artifacts::parse(text).is_empty() {
        return text.to_string();
    }
    fn fence(line: &str) -> Option<(char, usize, &str)> {
        let trimmed = line.trim_start();
        let c = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
        let n = trimmed.chars().take_while(|x| *x == c).count();
        (n >= 3).then(|| (c, n, &trimmed[n..]))
    }
    let mut out = String::new();
    let mut skipping: Option<(char, usize)> = None;
    for line in text.split('\n') {
        if let Some((c, n)) = skipping {
            if let Some((c2, n2, rest)) = fence(line) {
                if c2 == c && n2 >= n && rest.trim().is_empty() {
                    skipping = None;
                }
            }
            continue;
        }
        if let Some((c, n, rest)) = fence(line) {
            let info = rest.trim_start().to_lowercase();
            if info.starts_with("artefacto") || info.starts_with("artifact") {
                skipping = Some((c, n));
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Files an item's artifacts: in the app's record (stamped with the run and the item) and as files
/// in the run's folder. Returns the file names written.
pub fn file_item(conn: &Connection, run: &Run, item: &Item, text: &str) -> Vec<String> {
    let found = artifacts::parse(text);
    if found.is_empty() {
        return Vec::new();
    }
    let conversation = format!("team:{}", run.id);
    let origin = artifacts::Origin {
        workspace_id: &run.workspace_id,
        surface: "team",
        conversation_id: &conversation,
        project_id: Some(&item.project_id).filter(|p| !p.is_empty()).map(|p| p.as_str()),
        message_id: &item.id,
    };
    let _ = artifacts::store(conn, &origin, &found);
    let dir = chain_memory::dir(&folder(&run.id));
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let mut written = Vec::new();
    for artifact in &found {
        let name = file_name(&item.key, artifact);
        if std::fs::write(dir.join(&name), &artifact.content).is_ok() {
            written.push(name);
        }
    }
    written
}

/// The run's artifact files made by one item, by name.
pub fn files_of(run_id: &str, item_key: &str) -> Vec<String> {
    let prefix = format!("{item_key}--");
    let Ok(entries) = std::fs::read_dir(chain_memory::dir(&folder(run_id))) else { return Vec::new() };
    let mut names: Vec<String> = entries.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.starts_with(&prefix)).collect();
    names.sort();
    names
}

/// Puts the run's artifacts where an item is about to run.
pub fn mirror_into(run_id: &str, folders: &[String]) {
    chain_memory::mirror(&folder(run_id), folders);
}

pub fn forget(run_id: &str, folders: &[String]) {
    chain_memory::forget(&folder(run_id), folders);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_artifact_blocks_and_keeps_the_rest() {
        let text = "Listo el contrato.\n````artefacto\n{\"name\": \"contrato-otp\", \"type\": \"code\", \"language\": \"yaml\"}\nopenapi: 3.1\n````\nCualquier duda, avísame.";
        assert_eq!(strip(text), "Listo el contrato.\nCualquier duda, avísame.");
        assert_eq!(strip("sin bloques"), "sin bloques");
    }

    #[test]
    fn names_files_by_item_and_kind() {
        let a = ParsedArtifact { name: "Contrato OTP".into(), title: String::new(), kind: "code".into(), language: "yaml".into(), content: String::new() };
        assert_eq!(file_name("contrato", &a), "contrato--contrato-otp.yaml");
        let m = ParsedArtifact { name: "flujo".into(), title: String::new(), kind: "mermaid".into(), language: String::new(), content: String::new() };
        assert_eq!(file_name("p1", &m), "p1--flujo.mmd");
    }
}
