//! Inbox search without loading transcripts or process traces into the webview.
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantChatHit {
    pub project_id: String,
    pub conversation_id: String,
    pub snippet: String,
}

/// Unicode-aware, literal matching: `_`, `%` and backslashes are ordinary search characters.
/// Return a short window around the match, never a process trace or an entire answer.
pub fn matching_snippet(text: &str, needle: &str) -> Option<String> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    let lowered = text.to_lowercase();
    let offset = lowered.find(&needle)?;
    let mut lowered_bytes = 0;
    let mut match_char = 0;
    for (index, ch) in text.chars().enumerate() {
        if lowered_bytes >= offset {
            match_char = index;
            break;
        }
        lowered_bytes += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
    }
    let start = match_char.saturating_sub(40);
    let excerpt: String = text.chars().skip(start).take(180).collect();
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        excerpt,
        if text.chars().count() > start + 180 {
            "…"
        } else {
            ""
        }
    ))
}

pub fn search(
    conn: &Connection,
    project_ids: &[String],
    workspace_id: Option<&str>,
    query: &str,
) -> rusqlite::Result<Vec<AssistantChatHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    let mut seen = HashSet::new();
    // Deliberately omit trace: it can be hundreds of kilobytes per turn and is not a chat message.
    let mut repo_turns = conn.prepare(
        "SELECT session_id, question, answer, context FROM activity_log
         WHERE project_id = ?1 AND session_id IS NOT NULL ORDER BY created_at DESC",
    )?;
    for project_id in project_ids {
        let turns = repo_turns.query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for turn in turns {
            let (id, question, answer, context) = turn?;
            if id.starts_with(super::queries::AGENT_CONVERSATION_PREFIX)
                || seen.contains(&(project_id.clone(), id.clone()))
            {
                continue;
            }
            let snippet = [&question, &answer, context.as_deref().unwrap_or("")]
                .into_iter()
                .find_map(|text| matching_snippet(text, query));
            if let Some(snippet) = snippet {
                seen.insert((project_id.clone(), id.clone()));
                hits.push(AssistantChatHit {
                    project_id: project_id.clone(),
                    conversation_id: id,
                    snippet,
                });
            }
        }
    }
    // Workspace chats have a separate transcript. General Chat-app conversations must not leak
    // into the assistant, nor should another workspace's results appear in this one's inbox.
    if let Some(workspace_id) = workspace_id {
        let mut statement = conn.prepare(
            "SELECT c.id, m.content FROM chat_conversations c
             JOIN chat_messages m ON m.conversation_id = c.id
             WHERE c.workspace_id = ?1 AND c.workspace_scope = 1
             ORDER BY m.created_at DESC, m.turn DESC",
        )?;
        let rows = statement.query_map(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, content) = row?;
            let key = (String::new(), id.clone());
            if seen.contains(&key) {
                continue;
            }
            if let Some(snippet) = matching_snippet(&content, query) {
                seen.insert(key);
                hits.push(AssistantChatHit {
                    project_id: String::new(),
                    conversation_id: id,
                    snippet,
                });
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE activity_log (project_id TEXT, session_id TEXT, question TEXT, answer TEXT, context TEXT, created_at TEXT);
            CREATE TABLE chat_conversations (id TEXT, workspace_id TEXT, workspace_scope INTEGER);
            CREATE TABLE chat_messages (conversation_id TEXT, content TEXT, created_at TEXT, turn INTEGER);
            INSERT INTO activity_log VALUES ('p1','thread','First question','Fixed ACCIÓN in src/api_key.ts',NULL,'1');
            INSERT INTO activity_log VALUES ('p1','thread','Another question','ACCIÓN succeeded',NULL,'2');
            INSERT INTO activity_log VALUES ('p2','other','Question','ACCIÓN in another repo',NULL,'1');
            INSERT INTO activity_log VALUES ('p1','agent-task','Question','ACCIÓN in an agent',NULL,'1');
            INSERT INTO activity_log VALUES ('p1','context','Question','Answer','src/connection.ts','1');
            INSERT INTO chat_conversations VALUES ('workspace','w1',1),('other-workspace','w2',1),('general-chat','w1',0);
            INSERT INTO chat_messages VALUES ('workspace','ACCIÓN failed with timeout','1',0),('other-workspace','ACCIÓN','1',0),('general-chat','ACCIÓN','1',0);") .unwrap();
        conn
    }

    #[test]
    fn finds_old_answers_without_leaking_other_repos_or_agent_tasks() {
        let hits = search(&fixture(), &["p1".into()], None, "acción").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, "thread");
        assert!(hits[0].snippet.contains("ACCIÓN"));
    }

    #[test]
    fn workspace_search_is_scoped_and_not_the_general_chat_app() {
        let hits = search(&fixture(), &[], Some("w1"), "timeout").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, "workspace");
        assert!(hits[0].project_id.is_empty());
        assert_eq!(
            search(&fixture(), &[], Some("w2"), "timeout")
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn filenames_and_wildcard_characters_are_literal() {
        assert_eq!(
            search(&fixture(), &["p1".into()], None, "api_key.ts")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            search(&fixture(), &["p1".into()], None, "connection.ts")
                .unwrap()
                .len(),
            1
        );
        assert!(search(&fixture(), &["p1".into()], None, "%")
            .unwrap()
            .is_empty());
        assert!(search(&fixture(), &["p1".into()], None, "  ")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn snippets_stay_bounded_and_keep_unicode_characters_intact() {
        let text = format!("{}İ ACCIÓN {}", "á".repeat(220), "ñ".repeat(300));
        let snippet = matching_snippet(&text, "acción").unwrap();
        assert!(snippet.contains("ACCIÓN"));
        assert!(snippet.chars().count() <= 182);
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
    }
}
