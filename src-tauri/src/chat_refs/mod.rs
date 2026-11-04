//! Chats that know about each other: the artifacts an answer carries ([`artifacts`]), one chat
//! citing another by name or id ([`refs`]), and one chat asking another to continue
//! ([`delegate`]). The tools below ride the `codeflow_map` MCP server (`codemap::mcp`), so every
//! engine that takes it can read another chat and — on a run that may act — write to one.

pub mod artifacts;
pub mod delegate;
pub mod refs;

use serde_json::{json, Value};

pub fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    artifacts::migrate(conn)
}

/// Said when a chat's answer filed artifacts, so the lists of them refresh: `{workspaceId,
/// conversationId}`.
pub const ARTIFACTS_EVENT: &str = "chat:artifacts";

/// Files an answer's artifacts and, when there were any, says so. Never fails the turn.
pub fn file_and_announce<R: tauri::Runtime>(app: &tauri::AppHandle<R>, conn: &rusqlite::Connection, origin: &artifacts::Origin, answer: &str) {
    use tauri::Emitter;
    if let Ok(filed) = artifacts::file_answer(conn, origin, answer) {
        if !filed.is_empty() {
            let _ = app.emit(ARTIFACTS_EVENT, json!({"workspaceId": origin.workspace_id, "conversationId": origin.conversation_id}));
        }
    }
}

/// The tools' names: the four that only look, and the one that acts.
pub const READ_TOOLS: &[&str] = &["chat_list", "chat_read", "artifact_list", "artifact_read"];
pub const ACT_TOOL: &str = "chat_send";

pub fn is_tool(name: &str) -> bool {
    READ_TOOLS.contains(&name) || name == ACT_TOOL
}

/// The definitions — short, like every app tool, because they ride along on every turn.
pub fn tools(acts: bool) -> Vec<Value> {
    let read = json!({ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false });
    let mut out = vec![
        json!({
            "name": "chat_list",
            "description": "The other AI chats of this CodeFlow workspace (repository chats, workspace chats, Chat app threads): id, title, repository, turns. For when the user names another chat.",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "Part of a title to filter by. Optional."}}},
            "annotations": read,
        }),
        json!({
            "name": "chat_read",
            "description": "Reads another chat of this workspace by its title or id: every question and answer, the files it changed. Long chats come in parts (from_turn).",
            "inputSchema": {"type": "object", "properties": {
                "chat": {"type": "string", "description": "The chat's title or id"},
                "from_turn": {"type": "integer", "description": "First turn to read. Optional."}
            }, "required": ["chat"]},
            "annotations": read,
        }),
        json!({
            "name": "artifact_list",
            "description": "The artifacts saved in this workspace's chats (pages, documents, diagrams, code): name, type, newest version, which chat.",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "Part of a name to filter by. Optional."}}},
            "annotations": read,
        }),
        json!({
            "name": "artifact_read",
            "description": "An artifact's content by name — its newest version, or the one asked for.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string"},
                "version": {"type": "integer", "description": "Optional; the newest when absent"}
            }, "required": ["name"]},
            "annotations": read,
        }),
    ];
    if acts {
        out.push(json!({
            "name": "chat_send",
            "description": "Asks another chat of this workspace (by title or id) to continue: the message becomes a turn of that chat, visible there, and its answer comes back to you. Only when the user asks for it. Waits up to 10 minutes.",
            "inputSchema": {"type": "object", "properties": {
                "chat": {"type": "string", "description": "The chat's title or id"},
                "message": {"type": "string", "description": "What that chat should do"}
            }, "required": ["chat", "message"]},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        }));
    }
    out
}

/// Who is calling a tool: the workspace it may look in, and — for a chat's own turn — which chat.
pub struct Caller {
    pub workspace_id: Option<String>,
    pub conversation_id: Option<String>,
    pub acts: bool,
}

/// Runs one of [`tools`]; `None` for a name that is not one of them.
pub async fn call(caller: &Caller, name: &str, args: &Value) -> Option<Result<String, String>> {
    if !is_tool(name) {
        return None;
    }
    Some(run(caller, name, args).await)
}

async fn run(caller: &Caller, name: &str, args: &Value) -> Result<String, String> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let workspace = caller.workspace_id.clone().ok_or("no se sabe en qué workspace corre este turno")?;
    let with = |f: &dyn Fn(&rusqlite::Connection) -> Result<String, String>| {
        crate::ai_usage::with_conn(|conn| f(conn)).unwrap_or_else(|| Err("CodeFlow is not ready yet".into()))
    };
    match name {
        "chat_list" => with(&|conn| {
            let query = artifacts::slug(&text("query"));
            let all = refs::list_chats(conn, &workspace).map_err(|e| e.to_string())?;
            let lines: Vec<String> = all
                .iter()
                .filter(|c| text("query").is_empty() || artifacts::slug(&c.title).contains(&query))
                .filter(|c| caller.conversation_id.as_deref() != Some(c.id.as_str()))
                .take(60)
                .map(|c| {
                    format!(
                        "- «{}» · id {} · {}{} · {} turnos · {}",
                        if c.title.is_empty() { "(sin título)" } else { &c.title },
                        c.id,
                        c.surface,
                        c.project_name.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(),
                        c.turns,
                        c.updated_at.get(..16).unwrap_or(&c.updated_at)
                    )
                })
                .collect();
            Ok(if lines.is_empty() { "No hay otros chats.".into() } else { lines.join("\n") })
        }),
        "chat_read" => with(&|conn| {
            let chat = refs::resolve(conn, &workspace, &text("chat"))?;
            Ok(refs::transcript(conn, &chat, args.get("from_turn").and_then(Value::as_i64)))
        }),
        "artifact_list" => with(&|conn| {
            let query = artifacts::slug(&text("query"));
            let all = artifacts::list(conn, &workspace, None).map_err(|e| e.to_string())?;
            let lines: Vec<String> = all
                .iter()
                .filter(|a| text("query").is_empty() || a.name.contains(&query))
                .take(80)
                .map(|a| format!("- {} · {} · v{} · «{}» · chat {}", a.name, a.kind, a.version, a.title, a.conversation_id))
                .collect();
            Ok(if lines.is_empty() { "No hay artefactos.".into() } else { lines.join("\n") })
        }),
        "artifact_read" => with(&|conn| {
            let wanted = text("name");
            match artifacts::get(conn, &workspace, &wanted, args.get("version").and_then(Value::as_i64)).map_err(|e| e.to_string())? {
                Some(a) => Ok(format!(
                    "{} v{} de {} ({}{}) — «{}»\n\n{}",
                    a.summary.name,
                    a.summary.version,
                    a.summary.versions,
                    a.summary.kind,
                    if a.summary.language.is_empty() { String::new() } else { format!(", {}", a.summary.language) },
                    a.summary.title,
                    a.content
                )),
                None => Err(format!("no hay ningún artefacto «{wanted}»")),
            }
        }),
        _ => {
            if !caller.acts {
                return Err("chat_send is not available to a read-only run".into());
            }
            let from = caller.conversation_id.clone().ok_or("chat_send solo se puede usar desde un chat")?;
            let message = text("message");
            if message.is_empty() {
                return Err("message is required".into());
            }
            let (target, from_title) = with_pair(&workspace, &text("chat"), &from)?;
            let app = crate::ai_usage::app().ok_or("CodeFlow is not ready yet")?;
            let answer = delegate::request(app, &target, &message, &from, &from_title).await?;
            Ok(format!("Respuesta de «{}»:\n\n{answer}", target.title))
        }
    }
}

fn with_pair(workspace: &str, handle: &str, from: &str) -> Result<(refs::ChatRef, String), String> {
    crate::ai_usage::with_conn(|conn| {
        let target = refs::resolve(conn, workspace, handle)?;
        let title = refs::list_chats(conn, workspace)
            .ok()
            .and_then(|all| all.into_iter().find(|c| c.id == from).map(|c| c.title))
            .unwrap_or_default();
        Ok((target, title))
    })
    .unwrap_or_else(|| Err("CodeFlow is not ready yet".into()))
}
