//! Conversations named after what was asked in them.
//!
//! Both chats used to call a conversation by its first question, cut at sixty characters, so the
//! sidebar row and the tab read as the question itself. Now, once a conversation's first answer has
//! landed, a run of its own writes a few words naming the topic, and they replace the cut question.
//!
//! - **Routed as `chat_title`** ([`AiTask::ChatTitle`]): the engine's fast model unless Settings
//!   says otherwise, like commit messages — it runs once per new conversation, unasked.
//! - **In the background, after the answer.** The reply never waits for its title, and a first turn
//!   that failed costs no title run. If the run fails the conversation keeps the cut question, which
//!   is what it always had.
//! - **Never over a name somebody chose.** The chat workspace only replaces its automatic name
//!   (`chat_queries::retitle_if_automatic`); the repository chat only names a conversation that has
//!   no title yet (`queries::title_conversation_if_untitled`). A rename typed while the title was
//!   being written wins.
//! - **Every window is told** ([`TITLED_EVENT`]), so the sidebar, the tab and the inbox change
//!   without a reload.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::ai;
use crate::commands::claude_cmd::{load_ai_config_in, AiTask};
use crate::db::{chat_queries, queries, Db};

/// Emitted with a [`ChatTitled`] when a conversation gets the title a model wrote for it.
pub const TITLED_EVENT: &str = "chat:titled";

/// The most a written title may be, in characters: the width the cut question was held to, which
/// is what fits one sidebar row.
const MAX_TITLE_CHARS: usize = 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTitled {
    /// `"chat"` — the chat workspace — or `"panel"`, the assistant's repository chat.
    pub surface: &'static str,
    pub conversation_id: String,
    /// The repository a panel conversation is about; `None` for the chat workspace.
    pub project_id: Option<String>,
    pub title: String,
}

/// Where a written title is filed.
pub enum Target {
    /// A chat-workspace conversation: `chat_conversations.title`.
    Chat { conversation_id: String },
    /// A repository conversation: `conversation_titles`, under the app's conversation id.
    Panel { project_id: String, conversation_id: String },
}

/// Writes a title for `question` in the background and files it under `target`. Returns at once;
/// nothing is reported back but the event, and a failure leaves the conversation as it was.
/// `workspace_id` is the conversation's, so its default account runs the title too.
pub fn spawn(app: &AppHandle, workspace_id: Option<String>, question: String, target: Target) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let config = {
            let db = app.state::<Db>();
            let Ok(conn) = db.0.lock() else { return };
            match load_ai_config_in(&conn, AiTask::ChatTitle, workspace_id.as_deref()) {
                Ok(config) => config,
                Err(_) => return,
            }
        };
        let Ok(reply) = ai::chat_title(&*config.engine, &config.binary, &config.model, &question).await else {
            return;
        };
        let Some(title) = clean_title(&reply) else { return };

        let db = app.state::<Db>();
        let Ok(conn) = db.0.lock() else { return };
        let (filed, titled) = match target {
            Target::Chat { conversation_id } => (
                chat_queries::retitle_if_automatic(&conn, &conversation_id, &title),
                ChatTitled { surface: "chat", conversation_id, project_id: None, title },
            ),
            // Moved to the chat workspace while its title was being written: it lands there.
            Target::Panel { conversation_id, .. }
                if chat_queries::get_conversation(&conn, &conversation_id).ok().flatten().is_some() =>
            {
                (
                    chat_queries::retitle_if_automatic(&conn, &conversation_id, &title),
                    ChatTitled { surface: "chat", conversation_id, project_id: None, title },
                )
            }
            Target::Panel { project_id, conversation_id } => (
                queries::title_conversation_if_untitled(&conn, &project_id, &conversation_id, &title),
                ChatTitled { surface: "panel", conversation_id, project_id: Some(project_id), title },
            ),
        };
        drop(conn);
        if matches!(filed, Ok(true)) {
            let _ = app.emit(TITLED_EVENT, titled);
        }
    });
}

/// The title in a reply, or `None` when there is none to read.
///
/// Asked for one bare line, a model still sometimes says more: a lead-in ending in a colon, the
/// title in quotes or bold, a `Título:` label, a full stop. Those come off, and a reply that is a
/// sentence after all is held to one sidebar row on a word, rather than overflowing it.
fn clean_title(reply: &str) -> Option<String> {
    let line = reply
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```") && !line.ends_with(':'))?;
    let mut title = line.trim_start_matches(['#', '>', '-', ' ']).trim().to_string();
    for label in ["título:", "titulo:", "title:"] {
        if title.to_lowercase().starts_with(label) {
            title = title.chars().skip(label.chars().count()).collect::<String>().trim().to_string();
        }
    }
    let title = chat_queries::truncate_on_word(unwrap(&title), MAX_TITLE_CHARS);
    (!title.is_empty()).then_some(title)
}

/// What a whole title can come wrapped in. Pairs, so a mark that belongs to the title — `` `cargo`
/// build cache`` — is left where it is.
const WRAPS: [(&str, &str); 10] = [
    ("**", "**"),
    ("__", "__"),
    ("\"", "\""),
    ("'", "'"),
    ("`", "`"),
    ("*", "*"),
    ("_", "_"),
    ("«", "»"),
    ("“", "”"),
    ("‘", "’"),
];

/// The title without the quotes, emphasis and closing full stop around it, however they nest.
fn unwrap(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim().trim_end_matches(['.', '。']).trim_end();
        match WRAPS.iter().find_map(|(open, close)| trimmed.strip_prefix(open)?.strip_suffix(close)) {
            Some(inner) => text = inner,
            None => return trimmed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::clean_title;

    #[test]
    fn a_bare_title_is_taken_as_it_is() {
        assert_eq!(clean_title("Configurar CI en paralelo").as_deref(), Some("Configurar CI en paralelo"));
        assert_eq!(clean_title("  Deploy rollback plan\n").as_deref(), Some("Deploy rollback plan"));
    }

    /// The decorations the prompt asks it not to write, which it sometimes writes anyway.
    #[test]
    fn quotes_bold_labels_and_the_full_stop_come_off() {
        assert_eq!(clean_title("\"Configurar CI en paralelo.\"").as_deref(), Some("Configurar CI en paralelo"));
        assert_eq!(clean_title("Título: **Migrar a Postgres**").as_deref(), Some("Migrar a Postgres"));
        assert_eq!(clean_title("Title: `cargo` build cache").as_deref(), Some("`cargo` build cache"));
        assert_eq!(clean_title("“Plan de pruebas”.").as_deref(), Some("Plan de pruebas"));
        assert_eq!(clean_title("«Errores de memoria en Rust»").as_deref(), Some("Errores de memoria en Rust"));
        assert_eq!(clean_title("## Ordenar commits por fecha").as_deref(), Some("Ordenar commits por fecha"));
    }

    #[test]
    fn a_lead_in_and_a_fence_are_skipped_for_the_title_under_them() {
        let chatty = "Claro, aquí tienes un título:\n\nRevisión del flujo de login";
        assert_eq!(clean_title(chatty).as_deref(), Some("Revisión del flujo de login"));
        assert_eq!(clean_title("```\nFix flaky upload test\n```").as_deref(), Some("Fix flaky upload test"));
    }

    #[test]
    fn nothing_to_read_is_none_rather_than_an_empty_title() {
        assert_eq!(clean_title(""), None);
        assert_eq!(clean_title("   \n\n"), None);
        assert_eq!(clean_title("\"\""), None);
    }

    /// A model that answered with a sentence still names one row, cut where a word ends.
    #[test]
    fn a_sentence_is_held_to_one_row_on_a_word() {
        let long = "Cómo configurar el despliegue automático de la aplicación en varios entornos de prueba";
        let title = clean_title(long).unwrap();
        assert!(title.chars().count() <= super::MAX_TITLE_CHARS);
        assert!(long.starts_with(&title));
        assert!(!title.ends_with(' '));
    }
}
