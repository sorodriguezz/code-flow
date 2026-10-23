//! The workspace's contexts in a chat: the ones that go with every session, and the ones the model
//! reads when a question needs them.
//!
//! A context is a named block the user wrote for the AI (Settings › Revisión › Contexto): a team's
//! conventions, an architecture brief, a glossary. Every enabled one used to open every chat
//! session in full, whatever the question — a long document paid for by a "gracias". A context
//! marked «a demanda» is listed instead, by its name and its first line, and read with
//! [`TOOL`] (the map's MCP server for a CLI, the in-process agent's own tool) when the model decides
//! it needs it. An engine that cannot call the tool gets it whole, as before: it would never see it
//! otherwise.
//!
//! Only the chats: a PR review, a story or an analysis is handed every enabled context, as always —
//! they answer about material they were given, and a review that skipped a team's rule would be a
//! worse review.

use rusqlite::Connection;

use crate::db::models::ReviewContext;

/// The tool's name, for the MCP server and the in-process agent alike.
pub const TOOL: &str = "read_context";

/// The most characters [`read`] hands over, as `knowledge::read_note`'s limit.
const READ_CHARS: usize = 40_000;

/// The longest first line the listing quotes.
const SUMMARY_CHARS: usize = 140;

/// The contexts a chat session opens with: the enabled ones whole, except — when the engine can call
/// [`TOOL`] (`tools`) — the on-demand ones, which go as one listing to read from.
pub fn for_chat(contexts: Vec<ReviewContext>, tools: bool) -> Vec<(String, String)> {
    let mut whole = Vec::new();
    let mut listed = Vec::new();
    for context in contexts.into_iter().filter(|c| c.enabled) {
        if context.on_demand && tools {
            listed.push(context);
        } else {
            whole.push((context.name, context.content));
        }
    }
    if !listed.is_empty() {
        whole.push(("Workspace contexts to read when needed".to_string(), listing(&listed)));
    }
    whole
}

fn listing(contexts: &[ReviewContext]) -> String {
    let mut text = format!(
        "These contexts of the workspace are not included here. When the question needs one, read it with {TOOL} (its name); otherwise leave it unread.\n"
    );
    for context in contexts {
        text.push_str(&format!("  - {}: {}\n", context.name.trim(), summary(&context.content)));
    }
    text
}

/// What a context is about, in its own words: its first line with something on it, without the
/// Markdown that dresses it.
fn summary(content: &str) -> String {
    let line = content
        .lines()
        .map(|line| line.trim().trim_start_matches(['#', '-', '*', '>', ' ']).trim())
        .find(|line| !line.is_empty())
        .unwrap_or("(no description)");
    if line.chars().count() > SUMMARY_CHARS {
        format!("{}…", line.chars().take(SUMMARY_CHARS).collect::<String>())
    } else {
        line.to_string()
    }
}

/// How many of `workspace_id`'s enabled contexts wait to be read — what decides whether [`TOOL`] is
/// offered at all: a definition nobody can use is tokens paid on every turn.
pub fn waiting(conn: &Connection, workspace_id: &str) -> usize {
    crate::db::queries::list_review_contexts(conn, workspace_id)
        .map(|list| list.iter().filter(|c| c.enabled && c.on_demand).count())
        .unwrap_or(0)
}

/// One of `workspace_id`'s enabled contexts, whole, by its name (any case). `cloud`: the reader is a
/// cloud engine, so a credential pasted into it leaves as a placeholder — the user's rule that a
/// secret is used, never handed over.
pub fn read(conn: &Connection, workspace_id: &str, name: &str, cloud: bool) -> Result<String, String> {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return Err(format!("name is empty: name one of the contexts the listing gave ({TOOL})"));
    }
    let contexts = crate::db::queries::list_review_contexts(conn, workspace_id).map_err(|e| e.to_string())?;
    let enabled: Vec<&ReviewContext> = contexts.iter().filter(|c| c.enabled).collect();
    let Some(context) = enabled.iter().find(|c| c.name.trim().to_lowercase() == wanted) else {
        let names: Vec<&str> = enabled.iter().map(|c| c.name.trim()).collect();
        return Err(if names.is_empty() {
            "This workspace has no contexts.".to_string()
        } else {
            format!("No context called {name:?}. The workspace has: {}", names.join(", "))
        });
    };
    let mut body = context.content.clone();
    if cloud {
        body = crate::secret_scan::redact(&body).0;
    }
    if body.chars().count() > READ_CHARS {
        body = format!("{}\n\n(cut at {READ_CHARS} characters)", body.chars().take(READ_CHARS).collect::<String>());
    }
    Ok(format!("<context name=\"{}\">\n{body}\n</context>", context.name.trim()))
}

/// The workspace a run at `root` reads contexts from: its project's, or the workspace chat's.
pub fn workspace_of_root(conn: &Connection, root: &str) -> Option<String> {
    crate::knowledge::owning_project(conn, root)
        .map(|p| p.workspace_id)
        .filter(|ws| !ws.is_empty())
        .or_else(|| crate::workspace_chat::workspace_of_dir(conn, root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(name: &str, content: &str, enabled: bool, on_demand: bool) -> ReviewContext {
        ReviewContext {
            id: name.to_string(),
            workspace_id: "w1".into(),
            name: name.into(),
            content: content.into(),
            enabled,
            on_demand,
            created_at: String::new(),
        }
    }

    #[test]
    fn an_on_demand_context_is_listed_for_an_engine_with_the_tool_and_whole_for_one_without() {
        let contexts = vec![
            context("Convenciones", "Usar pnpm.", true, false),
            context("Arquitectura", "# Arquitectura hexagonal\n\nPuertos y adaptadores…", true, true),
            context("Apagado", "No va.", false, true),
        ];
        let with = for_chat(contexts.clone(), true);
        assert_eq!(with[0], ("Convenciones".to_string(), "Usar pnpm.".to_string()));
        assert_eq!(with.len(), 2);
        assert!(with[1].1.contains("- Arquitectura: Arquitectura hexagonal"), "{}", with[1].1);
        assert!(!with[1].1.contains("Puertos"), "only the first line");
        assert!(!with.iter().any(|(_, text)| text.contains("No va")), "a disabled context goes nowhere");

        let without = for_chat(contexts, false);
        assert_eq!(without.len(), 2);
        assert!(without.iter().any(|(name, text)| name == "Arquitectura" && text.contains("Puertos")));
        assert!(for_chat(vec![context("Convenciones", "Usar pnpm.", true, false)], true).len() == 1, "nothing to list, no listing");
    }

    #[test]
    fn a_context_is_read_by_its_name_in_any_case_and_a_secret_stays_home() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE review_contexts (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, content TEXT, enabled INTEGER, created_at TEXT, on_demand INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
        let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        crate::db::queries::upsert_review_context(&conn, Some("a".into()), "w1", "Arquitectura", &format!("Puertos.\nGITHUB_TOKEN={token}"), true, true).unwrap();
        crate::db::queries::upsert_review_context(&conn, Some("b".into()), "w1", "Glosario", "Siniestro: …", false, true).unwrap();
        assert_eq!(waiting(&conn, "w1"), 1);
        let text = read(&conn, "w1", "  arquitectura ", true).unwrap();
        assert!(text.contains("Puertos.") && !text.contains("ghp_abc"), "{text}");
        assert!(read(&conn, "w1", "arquitectura", false).unwrap().contains("ghp_abc"), "the local model is on this machine");
        let missing = read(&conn, "w1", "Glosario", true).unwrap_err();
        assert!(missing.ends_with("The workspace has: Arquitectura"), "a disabled context is not offered: {missing}");
    }
}
