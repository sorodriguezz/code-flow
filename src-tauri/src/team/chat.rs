//! A conversation addressed to a team. The lead answers or delegates real turns to its members;
//! every turn uses the ordinary repository-chat engine, permissions, checkpoints and accounts.

use super::{MemberSnap, Policy, Team};
use crate::db::{models::AgentTask, queries, Db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const BATCH_PREFIX: &str = "team-chat:";
const MAX_DELEGATIONS: usize = 4;
const MAX_ROUNDS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub team_id: String,
    pub team_name: String,
    pub team_updated_at: String,
    pub lead_id: String,
    pub task_id: String,
    pub members: Vec<MemberSnap>,
    pub policy: Policy,
    pub status: String,
    pub active_member_id: String,
    pub active_run_id: String,
    pub error: String,
    pub revision: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub member_id: String,
    pub member_name: String,
    pub content: String,
    pub provider: String,
    pub model: String,
    pub trace_id: Option<String>,
    pub response_time_ms: i64,
    pub created_at: String,
    #[serde(default)]
    pub suggest_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    pub chat: Chat,
    pub task: AgentTask,
    pub messages: Vec<Message>,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_team_chats (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
            team_id TEXT NOT NULL,
            team_updated_at TEXT NOT NULL,
            data TEXT NOT NULL,
            active_read_only INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_team_chats_team ON agent_team_chats(team_id, project_id, created_at);
         CREATE TABLE IF NOT EXISTS agent_team_chat_messages (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            chat_id TEXT NOT NULL REFERENCES agent_team_chats(id) ON DELETE CASCADE,
            data TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_team_chat_messages_chat ON agent_team_chat_messages(chat_id, sequence);",
    )
}

fn e2s(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn get(conn: &Connection, id: &str) -> Result<Chat, String> {
    let raw: String = conn
        .query_row(
            "SELECT data FROM agent_team_chats WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(e2s)?;
    serde_json::from_str(&raw).map_err(e2s)
}

fn save(conn: &Connection, chat: &mut Chat) -> Result<(), String> {
    chat.revision += 1;
    conn.execute(
        "UPDATE agent_team_chats SET data = ?2 WHERE id = ?1",
        params![chat.id, serde_json::to_string(chat).map_err(e2s)?],
    )
    .map_err(e2s)?;
    Ok(())
}

fn append(
    conn: &Connection,
    chat: &Chat,
    role: &str,
    member: Option<&MemberSnap>,
    text: &str,
    elapsed: i64,
    trace: Option<String>,
    suggest_run: bool,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let message = Message {
        id: uid(),
        role: role.into(),
        content: text.into(),
        member_id: member.map(|m| m.member.id.clone()).unwrap_or_default(),
        member_name: member.map(|m| m.member.name.clone()).unwrap_or_default(),
        provider: member.map(|m| m.provider.clone()).unwrap_or_default(),
        model: member.map(|m| m.model.clone()).unwrap_or_default(),
        trace_id: trace,
        response_time_ms: elapsed,
        created_at: queries::now(),
        suggest_run,
    };
    conn.execute(
        "INSERT INTO agent_team_chat_messages (id, chat_id, data) VALUES (?1, ?2, ?3)",
        params![
            message.id,
            chat.id,
            serde_json::to_string(&message).map_err(e2s)?
        ],
    )
    .map_err(e2s)?;
    Ok(())
}

pub fn state(conn: &Connection, id: &str) -> Result<ChatState, String> {
    let chat = get(conn, id)?;
    let task = queries::get_agent_task(conn, &chat.task_id)
        .map_err(e2s)?
        .ok_or("La conversación ya no existe.")?;
    let mut statement = conn
        .prepare("SELECT data FROM agent_team_chat_messages WHERE chat_id = ?1 ORDER BY sequence")
        .map_err(e2s)?;
    let raw = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(e2s)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e2s)?;
    let messages = raw
        .iter()
        .map(|raw| serde_json::from_str(raw).map_err(e2s))
        .collect::<Result<Vec<Message>, String>>()?;
    Ok(ChatState {
        chat,
        task,
        messages,
    })
}

fn may_edit(chat: &Chat, member: &MemberSnap) -> bool {
    member.member.edits
        && !member.member.advisor
        && (!(member.member.leads || member.member.id == chat.lead_id) || member.member.hands_on)
}

fn prompt(chat: &Chat, member: &MemberSnap) -> String {
    let members = chat
        .members
        .iter()
        .map(|m| {
            format!(
                "- {} | {} | {} | {} | reporta a: {}",
                m.member.id,
                m.member.name,
                m.member.role,
                if may_edit(chat, m) {
                    "puede escribir y editar"
                } else {
                    "solo lectura"
                },
                if m.member.reports_to.is_empty() {
                    &chat.lead_id
                } else {
                    &m.member.reports_to
                },
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mode = if member.member.id == chat.lead_id {
        "Eres la entrada del equipo: el usuario te habla a ti. Decide quién puede resolver cada pedido por su rol y permisos.
Responde tú mismo si conoces la respuesta; usa herramientas y realiza el trabajo directamente si tus permisos lo permiten.
Cuando haga falta otra especialidad, delega solo las partes necesarias a miembros reales del listado. No inventes miembros, respuestas ni acciones ejecutadas.
No conviertas una pregunta sencilla en un plan ni consultes a todo el equipo por rutina.
Si el encargo necesita varios pasos dependientes o revisión formal, ofrece convertirlo en corrida. Resume el objetivo y los criterios acordados, termina con un bloque equipo-chat con `{\"suggest_run\":true,\"delegate\":[]}` y espera a que el usuario elija. Si pide expresamente que lo resuelvas en este chat, sigue aquí.
Para delegar termina tu respuesta con este bloque JSON (no lo expliques al usuario):
```equipo-chat
{\"delegate\":[{\"member\":\"ID_DEL_MIEMBRO\",\"kind\":\"answer\",\"instruction\":\"Pregunta o trabajo concreto con el contexto necesario\"}]}
```
kind=answer consulta en solo lectura. kind=work permite escribir/editar al miembro si tiene permiso.
El sistema ejecuta esas delegaciones y te devuelve resultados reales. Entonces responde o pide la siguiente parte si es indispensable.
Sin delegaciones, escribe una respuesta normal. Si necesitas información del usuario, usa una pregunta normal con opciones y espera su respuesta.
Si no puedes editar, delega la implementación a quien sí puede. Nunca digas que solo puedes planificar cuando otro miembro puede ejecutar."
    } else {
        "El líder te consulta o encarga trabajo dentro de esta conversación. Resuelve la instrucción concreta con tus herramientas y permisos.
Si te encargan escribir o editar y está permitido, hazlo: no te limites a describir qué harías. Informa archivos y verificaciones reales.
Una consulta answer es solo lectura. No uses protocolos de corridas ni crees planes de equipo: responde al encargo y el líder coordina."
    };
    format!("{}\n\n# Chat del equipo «{}»\nTu nombre: {}\nTu rol: {}\nPermisos en este chat: {}.\n{}\n\n## Equipo disponible\n{}",
        member.prompt, chat.team_name, member.member.name, member.member.role,
        if may_edit(chat, member) { "puedes escribir y editar cuando el pedido lo requiera" } else { "solo lectura; no escribas archivos" }, mode, members)
}

fn task_for(conn: &Connection, chat: &Chat, member: &MemberSnap) -> Result<AgentTask, String> {
    let batch = format!("{BATCH_PREFIX}{}:{}", chat.id, member.member.id);
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM agent_tasks WHERE batch_id = ?1 AND project_id = ?2 LIMIT 1",
            params![batch, chat.project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(e2s)?;
    if let Some(id) = existing {
        return queries::get_agent_task(conn, &id)
            .map_err(e2s)?
            .ok_or("La conversación ya no existe.".into());
    }
    let mut task = queries::create_agent_task_with_id(
        conn,
        &uid(),
        &chat.workspace_id,
        &chat.project_id,
        &member.member.agent_id,
        &member.member.name,
        &member.provider,
        &member.model,
        &prompt(chat, member),
        "",
        &format!("{} · {}", chat.team_name, member.member.name),
        "",
        member.account_id.as_deref(),
        ("", ""),
        &batch,
    )
    .map_err(e2s)?;
    queries::update_agent_task_run(conn, &task.id, "idle", &task.model, 0, "").map_err(e2s)?;
    task.status = "idle".into();
    Ok(task)
}

pub fn open(
    conn: &Connection,
    team: Team,
    project_id: &str,
    fresh: bool,
) -> Result<ChatState, String> {
    let project = queries::get_project(conn, project_id)
        .map_err(e2s)?
        .ok_or("Abre un repositorio para conversar con el equipo.")?;
    if team.workspace_id != project.workspace_id {
        return Err("El equipo y el repositorio pertenecen a espacios distintos.".into());
    }
    if team.lead.is_empty() {
        return Err("Elige un líder del equipo para usar su chat.".into());
    }
    if !fresh {
        let id: Option<String> = conn.query_row("SELECT id FROM agent_team_chats WHERE team_id = ?1 AND project_id = ?2 AND team_updated_at = ?3 ORDER BY created_at DESC LIMIT 1",
            params![team.id, project_id, team.updated_at], |row| row.get(0)).optional().map_err(e2s)?;
        if let Some(id) = id {
            return state(conn, &id);
        }
    }
    let agents = queries::list_workspace_agents(conn, &team.workspace_id).map_err(e2s)?;
    let mut members = Vec::new();
    for member in &team.members {
        let Some(agent) = agents.iter().find(|a| a.id == member.agent_id && a.enabled) else {
            if member.id == team.lead {
                return Err("El agente líder no está disponible: revisa el equipo.".into());
            }
            continue;
        };
        if (!member.repos.is_empty() && !member.repos.iter().any(|id| id == project_id))
            || (!agent.repos.is_empty() && !agent.repos.iter().any(|id| id == project_id))
        {
            continue;
        }
        if agent.provider.trim().is_empty() || agent.model.trim().is_empty() {
            continue;
        }
        let mut member = member.clone();
        if member.name.trim().is_empty() {
            member.name = agent.name.clone();
        }
        if member.role.trim().is_empty() {
            member.role = agent.role.clone();
        }
        member.edits &= agent.edits;
        members.push(MemberSnap {
            member,
            provider: agent.provider.clone(),
            model: agent.model.clone(),
            effort: agent.effort.clone(),
            prompt: agent.prompt.clone(),
            account_id: agent.account_id.clone(),
        });
    }
    let lead = members
        .iter()
        .find(|m| m.member.id == team.lead)
        .ok_or("El líder no tiene modelo o acceso a este repositorio.")?
        .clone();
    let mut chat = Chat {
        id: uid(),
        workspace_id: team.workspace_id,
        project_id: project_id.into(),
        project_name: project.name,
        team_id: team.id,
        team_name: team.name,
        team_updated_at: team.updated_at,
        lead_id: team.lead,
        task_id: String::new(),
        members,
        policy: team.policy,
        status: "idle".into(),
        active_member_id: String::new(),
        active_run_id: String::new(),
        error: String::new(),
        revision: 0,
        created_at: queries::now(),
    };
    let tx = conn.unchecked_transaction().map_err(e2s)?;
    chat.task_id = task_for(&tx, &chat, &lead)?.id;
    tx.execute("INSERT INTO agent_team_chats (id, workspace_id, project_id, task_id, team_id, team_updated_at, data, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![chat.id, chat.workspace_id, chat.project_id, chat.task_id, chat.team_id, chat.team_updated_at, serde_json::to_string(&chat).map_err(e2s)?, chat.created_at]).map_err(e2s)?;
    tx.commit().map_err(e2s)?;
    state(conn, &chat.id)
}

/// Enforced by the same CLI analysis mode as solo read-only agents, not just by a prompt.
pub fn read_only_conversation(conn: &Connection, conversation_id: &str) -> bool {
    let batch: Option<String> = conn
        .query_row(
            "SELECT batch_id FROM agent_tasks WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(tail) = batch.as_deref().and_then(|b| b.strip_prefix(BATCH_PREFIX)) else {
        return false;
    };
    let Some((chat_id, member_id)) = tail.split_once(':') else {
        return true;
    };
    let Ok(chat) = get(conn, chat_id) else {
        return true;
    };
    let Some(member) = chat.members.iter().find(|m| m.member.id == member_id) else {
        return true;
    };
    let active_read_only: bool = conn
        .query_row(
            "SELECT active_read_only FROM agent_team_chats WHERE id = ?1",
            [chat_id],
            |row| row.get(0),
        )
        .unwrap_or(true);
    !may_edit(&chat, member) || chat.active_member_id != member_id || active_read_only
}

#[derive(Debug)]
struct Delegation {
    member: MemberSnap,
    instruction: String,
    work: bool,
}
#[derive(Debug, Default)]
struct Plan {
    text: String,
    delegate: Vec<Delegation>,
    errors: Vec<String>,
    suggest_run: bool,
}

fn plan(text: &str, chat: &Chat) -> Plan {
    let mut out = Plan::default();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if !line.trim().eq_ignore_ascii_case("```equipo-chat") {
            out.text.push_str(line);
            out.text.push('\n');
            continue;
        }
        let mut raw = String::new();
        let mut closed = false;
        for line in lines.by_ref() {
            if line.trim() == "```" {
                closed = true;
                break;
            }
            raw.push_str(line);
            raw.push('\n');
        }
        let parsed = if closed {
            serde_json::from_str::<serde_json::Value>(&raw).ok()
        } else {
            None
        };
        let suggests_run = parsed.as_ref().and_then(|p| p.get("suggest_run")).and_then(|v| v.as_bool()).unwrap_or(false);
        let Some(values) = parsed
            .as_ref()
            .and_then(|p| p.get("delegate"))
            .and_then(|p| p.as_array())
        else {
            if suggests_run && parsed.as_ref().is_some_and(|p| p.get("delegate").is_none()) {
                out.suggest_run = true;
                continue;
            }
            out.errors
                .push("Formato de delegación inválido; usa delegate como una lista JSON.".into());
            continue;
        };
        out.suggest_run |= suggests_run;
        for value in values {
            let who = value.get("member").and_then(|v| v.as_str()).unwrap_or("");
            let instruction = value
                .get("instruction")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let found: Vec<_> = chat
                .members
                .iter()
                .filter(|m| m.member.id == who || m.member.name.eq_ignore_ascii_case(who))
                .collect();
            let kind = value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("answer");
            if found.len() != 1 || instruction.is_empty() || !matches!(kind, "answer" | "work") {
                out.errors.push(format!("Delegación inválida para «{who}»: usa un miembro único, una instrucción y kind answer/work."));
                continue;
            }
            let member = found[0];
            if member.member.id == chat.lead_id || (kind == "work" && !may_edit(chat, member)) {
                out.errors.push(format!(
                    "«{}» no puede recibir esta delegación; respeta sus permisos.",
                    member.member.name
                ));
                continue;
            }
            if out.delegate.len() >= MAX_DELEGATIONS {
                out.errors
                    .push("Delega como máximo cuatro partes por mensaje.".into());
                break;
            }
            out.delegate.push(Delegation {
                member: member.clone(),
                instruction: instruction.chars().take(24_000).collect(),
                work: kind == "work",
            });
        }
    }
    out.suggest_run &= out.delegate.is_empty() && out.errors.is_empty();
    out.text = out.text.trim().to_string();
    out
}

pub fn recover(conn: &Connection) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("SELECT id FROM agent_team_chats")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        if let Ok(mut chat) = get(conn, &id) {
            if chat.status == "running" || chat.status == "cancelling" {
                chat.status = "error".into();
                chat.error =
                    "La conversación se interrumpió. Puedes escribir al equipo para continuar."
                        .into();
                chat.active_run_id.clear();
                chat.active_member_id.clear();
                save(conn, &mut chat)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            }
        }
    }
    Ok(())
}

type Control = Arc<tokio::sync::watch::Sender<bool>>;
static RUNNING: LazyLock<Mutex<HashMap<String, Control>>> = LazyLock::new(Default::default);
struct Registration(String);
impl Drop for Registration {
    fn drop(&mut self) {
        RUNNING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

fn with_conn<T, R: tauri::Runtime>(
    app: &AppHandle<R>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(e2s)?;
    f(&conn)
}

fn changed<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("team-chat:changed", serde_json::json!({ "chatId": id }));
}

fn cancelled(control: &Control) -> Result<(), String> {
    if *control.borrow() {
        Err(crate::ai_runs::CANCELLED_MARKER.into())
    } else {
        Ok(())
    }
}

async fn turn(
    app: &AppHandle,
    chat_id: &str,
    member: &MemberSnap,
    message: String,
    files: Option<Vec<String>>,
    read_only: bool,
    control: &Control,
) -> Result<(String, i64, Option<String>), String> {
    cancelled(control)?;
    let mut stop = control.subscribe();
    let _permit = tokio::select! {
        permit = crate::runner::governor::acquire(app, &member.model) => permit,
        _ = stop.changed() => return Err(crate::ai_runs::CANCELLED_MARKER.into()),
    };
    cancelled(control)?;
    let run_id = format!("team-chat-{}", uid());
    let (task, session) = with_conn(app, |conn| {
        let mut chat = get(conn, chat_id)?;
        let task = task_for(conn, &chat, member)?;
        chat.active_member_id = member.member.id.clone();
        chat.active_run_id = run_id.clone();
        conn.execute(
            "UPDATE agent_team_chats SET active_read_only = ?2 WHERE id = ?1",
            params![chat_id, read_only],
        )
        .map_err(e2s)?;
        save(conn, &mut chat)?;
        queries::update_agent_task_run(conn, &task.id, "running", &task.model, task.turns, "")
            .map_err(e2s)?;
        let session = conn.query_row("SELECT engine_session_id FROM activity_log WHERE session_id = ?1 AND engine_session_id IS NOT NULL AND engine_session_id <> '' ORDER BY created_at DESC LIMIT 1",
            [&task.conversation_id], |row| row.get::<_, String>(0)).optional().map_err(e2s)?;
        Ok((task, session))
    })?;
    changed(app, chat_id);
    let started = std::time::Instant::now();
    let reply_future = crate::commands::claude_cmd::send_chat_message(
        app.clone(),
        app.state::<Db>(),
        task.project_id.clone(),
        message,
        session,
        Some(task.conversation_id.clone()),
        Some(run_id.clone()),
        Some(member.provider.clone()),
        Some(member.model.clone()),
        Some(task.prompt.clone()),
        member.account_id.clone(),
        None,
        None,
        files,
        Some(member.effort.clone()),
        Some(false),
        None,
    );
    tokio::pin!(reply_future);
    let mut retry_cancel = tokio::time::interval(std::time::Duration::from_millis(50));
    let reply = loop {
        tokio::select! {
            reply = &mut reply_future => break reply,
            _ = stop.changed() => { crate::ai_runs::cancel(&run_id); },
            // A stop can arrive just before the engine registers its run. Keep the request alive
            // until registration, rather than allowing that race to start an uncancellable turn.
            _ = retry_cancel.tick(), if *control.borrow() => { crate::ai_runs::cancel(&run_id); },
        }
    };
    let elapsed = started.elapsed().as_millis() as i64;
    with_conn(app, |conn| {
        let (status, error) = match &reply {
            Ok(_) => ("idle", ""),
            Err(error) if error.contains(crate::ai_runs::CANCELLED_MARKER) => ("cancelled", ""),
            Err(error) => ("error", error.as_str()),
        };
        let model = reply
            .as_ref()
            .ok()
            .and_then(|reply| reply.model.as_deref())
            .unwrap_or(&task.model);
        queries::update_agent_task_run(
            conn,
            &task.id,
            status,
            model,
            task.turns + i64::from(reply.is_ok()),
            error,
        )
        .map_err(e2s)
    })?;
    let reply = reply?;
    let trace = with_conn(app, |conn| {
        Ok(conn.query_row("SELECT id FROM activity_log WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 1", [&task.conversation_id], |row| row.get::<_, String>(0)).optional().map_err(e2s)?)
    })?;
    Ok((reply.text, elapsed, trace))
}

type TurnResult = Result<(String, i64, Option<String>), String>;
type TurnFuture = std::pin::Pin<Box<dyn std::future::Future<Output = TurnResult> + Send>>;

async fn drive_with<R: tauri::Runtime>(
    app: &AppHandle<R>,
    chat: &Chat,
    message: String,
    files: Vec<crate::commands::chat_attach::ChatAttachment>,
    control: &Control,
    mut run: impl FnMut(MemberSnap, String, Option<Vec<String>>, bool) -> TurnFuture,
) -> Result<(), String> {
    let lead = chat
        .members
        .iter()
        .find(|m| m.member.id == chat.lead_id)
        .ok_or("El líder no está disponible.")?;
    let mut next = message.clone();
    let mut delegated = 0;
    for round in 0..MAX_ROUNDS {
        cancelled(control)?;
        if round + 1 == MAX_ROUNDS || delegated >= MAX_DELEGATIONS {
            next.push_str("\n\nEsta es la respuesta final de este turno: no delegues más. Resume lo comprobado, lo que hiciste y cualquier limitación real.");
        }
        let ids = (round == 0 && !files.is_empty())
            .then(|| files.iter().map(|file| file.id.clone()).collect());
        let (reply, elapsed, trace) = run(lead.clone(), next, ids, !may_edit(chat, lead)).await?;
        let parsed = plan(&reply, chat);
        with_conn(app, |conn| {
            append(
                conn,
                chat,
                "assistant",
                Some(lead),
                &parsed.text,
                elapsed,
                trace,
                parsed.suggest_run,
            )
        })?;
        changed(app, &chat.id);
        cancelled(control)?;
        if parsed.delegate.is_empty() && parsed.errors.is_empty() {
            return Ok(());
        }
        if round + 1 == MAX_ROUNDS || delegated >= MAX_DELEGATIONS {
            return Err("El equipo alcanzó el límite de coordinación de este mensaje. Puedes continuar escribiendo en el chat.".into());
        }
        let mut results = parsed.errors;
        for request in parsed
            .delegate
            .into_iter()
            .take(MAX_DELEGATIONS - delegated)
        {
            cancelled(control)?;
            let task = with_conn(app, |conn| task_for(conn, chat, &request.member))?;
            let mut attachments = Vec::new();
            for file in &files {
                attachments.push(
                    crate::commands::chat_attach::repo_chat_attach_file(
                        task.conversation_id.clone(),
                        file.path.clone(),
                    )?
                    .id,
                );
            }
            let instruction = format!("## Pedido del usuario\n{}\n\n## Encargo del líder\n{}\n\nEste encargo es {}. Resuelve la parte asignada y responde con resultados reales.", message,
                request.instruction, if request.work { "de ejecución: escribe y edita si hace falta, según tus permisos" } else { "una consulta de solo lectura" });
            let (text, elapsed, trace) = run(
                request.member.clone(),
                instruction,
                (!attachments.is_empty()).then_some(attachments),
                !request.work,
            )
            .await?;
            with_conn(app, |conn| {
                append(
                    conn,
                    chat,
                    "assistant",
                    Some(&request.member),
                    &text,
                    elapsed,
                    trace,
                    false,
                )
            })?;
            changed(app, &chat.id);
            results.push(format!(
                "### {}\n{}",
                request.member.member.name,
                text.chars().take(24_000).collect::<String>()
            ));
            delegated += 1;
        }
        next = format!("Resultados reales del equipo para el pedido del usuario: {}\n\n{}\n\nResponde al usuario con este contexto. No repitas encargos ya resueltos; delega otra parte solo si es imprescindible.", message, results.join("\n\n"));
    }
    Ok(())
}

async fn drive(
    app: &AppHandle,
    chat: &Chat,
    message: String,
    files: Vec<crate::commands::chat_attach::ChatAttachment>,
    control: &Control,
) -> Result<(), String> {
    let run_app = app.clone();
    let chat_id = chat.id.clone();
    let run_control = control.clone();
    drive_with(
        app,
        chat,
        message,
        files,
        control,
        move |member, message, files, read_only| {
            let app = run_app.clone();
            let id = chat_id.clone();
            let control = run_control.clone();
            Box::pin(
                async move { turn(&app, &id, &member, message, files, read_only, &control).await },
            )
        },
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    id: String,
    title: String,
    created_at: String,
}

pub fn history(
    conn: &Connection,
    team_id: &str,
    project_id: &str,
) -> Result<Vec<ChatSummary>, String> {
    let mut statement = conn.prepare("SELECT id, created_at FROM agent_team_chats WHERE team_id = ?1 AND project_id = ?2 ORDER BY created_at DESC LIMIT 64").map_err(e2s)?;
    let rows = statement
        .query_map(params![team_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(e2s)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(e2s)?;
    rows.into_iter().map(|(id, created_at)| {
        let first: Option<String> = conn.query_row("SELECT data FROM agent_team_chat_messages WHERE chat_id = ?1 ORDER BY sequence LIMIT 1", [&id], |row| row.get(0)).optional().map_err(e2s)?;
        let title = first.and_then(|raw| serde_json::from_str::<Message>(&raw).ok()).map(|message| message.content.lines().next().unwrap_or("").chars().take(80).collect()).unwrap_or_default();
        Ok(ChatSummary { id, title, created_at })
    }).collect()
}

#[tauri::command]
pub fn team_chat_history(
    db: State<'_, Db>,
    team_id: String,
    project_id: String,
) -> Result<Vec<ChatSummary>, String> {
    let conn = db.0.lock().map_err(e2s)?;
    history(&conn, &team_id, &project_id)
}

#[tauri::command]
pub fn team_chat_open(
    db: State<'_, Db>,
    team_id: String,
    project_id: String,
    fresh: Option<bool>,
) -> Result<ChatState, String> {
    let conn = db.0.lock().map_err(e2s)?;
    let team = super::get_team(&conn, &team_id)
        .map_err(e2s)?
        .ok_or("El equipo ya no existe.")?;
    open(&conn, team, &project_id, fresh.unwrap_or(false))
}

#[tauri::command]
pub fn team_chat_state(db: State<'_, Db>, chat_id: String) -> Result<ChatState, String> {
    let conn = db.0.lock().map_err(e2s)?;
    state(&conn, &chat_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDraft {
    pub team_id: String,
    pub project_id: String,
    pub goal: String,
    pub attachments: Vec<crate::commands::chat_attach::ChatAttachment>,
}

#[tauri::command]
pub async fn team_chat_draft(db: State<'_, Db>, chat_id: String) -> Result<ChatDraft, String> {
    let state = {
        let conn = db.0.lock().map_err(e2s)?;
        state(&conn, &chat_id)?
    };
    if matches!(state.chat.status.as_str(), "running" | "cancelling") {
        return Err("Espera a que termine el turno antes de convertirlo en tarea.".into());
    }
    let note = crate::ai::attachment_note(&[]);
    let user_text = |message: &Message| message.content.split_once(note.as_str()).map_or(message.content.as_str(), |(text, _)| text).to_string();
    let last_request = state.messages.iter().rfind(|message| message.role == "user").map(&user_text)
        .ok_or("El chat todavía no tiene un pedido.")?;
    let recent = &state.messages[state.messages.len().saturating_sub(20)..];
    let context: Vec<_> = recent.iter().map(|message| {
        let (name, body) = if message.role == "user" {
            ("Usuario", user_text(message))
        } else {
            (message.member_name.as_str(), message.content.clone())
        };
        format!("**{name}**\n{}", body.chars().take(2500).collect::<String>())
    }).collect();
    let conversation_id = state.task.conversation_id;
    let mentioned: Vec<_> = state.messages.into_iter().filter(|message| message.role == "user").map(|message| message.content).collect();
    let attachments = tokio::task::spawn_blocking(move || {
        crate::commands::chat_attach::repo_conversation_attachments(&conversation_id).into_iter()
            .filter(|file| {
                let reference = format!("({})", file.path);
                mentioned.iter().any(|message| message.split_once(note.as_str()).is_some_and(|(_, files)| files.contains(&reference)))
            })
            .map(|file| {
                let mut copied = crate::commands::chat_attach::crew_attach_file(file.path)?;
                copied.name = file.name;
                Ok(copied)
            }).collect::<Result<Vec<_>, String>>()
    }).await.map_err(e2s)??;
    Ok(ChatDraft {
        team_id: state.chat.team_id,
        project_id: state.chat.project_id,
        goal: format!("{}\n\n## Contexto del chat\nUsa los acuerdos y criterios de esta conversación para planificar el encargo.\n\n{}", last_request.trim(), context.join("\n\n")),
        attachments,
    })
}

#[tauri::command]
pub fn team_chat_send(
    app: AppHandle,
    db: State<'_, Db>,
    chat_id: String,
    message: String,
    attachments: Option<Vec<String>>,
) -> Result<ChatState, String> {
    if message.trim().is_empty() {
        return Err("Escribe un mensaje para el equipo.".into());
    }
    let (cancel, _) = tokio::sync::watch::channel(false);
    let control = Arc::new(cancel);
    {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if running.contains_key(&chat_id) {
            return Err("El equipo está respondiendo a este chat.".into());
        }
        running.insert(chat_id.clone(), control.clone());
    }
    let registration = Registration(chat_id.clone());
    let (chat, files, answer) = {
        let conn = db.0.lock().map_err(e2s)?;
        let mut chat = get(&conn, &chat_id)?;
        let task = queries::get_agent_task(&conn, &chat.task_id)
            .map_err(e2s)?
            .ok_or("La conversación ya no existe.")?;
        let stored =
            crate::commands::chat_attach::repo_conversation_attachments(&task.conversation_id);
        let ids = attachments.unwrap_or_default();
        let files: Vec<_> = stored
            .into_iter()
            .filter(|file| ids.contains(&file.id))
            .collect();
        let note = crate::ai::attachment_note(
            &files
                .iter()
                .map(|file| crate::ai::AiAttachment {
                    path: file.path.clone(),
                    name: file.name.clone(),
                    is_image: file.is_image,
                })
                .collect::<Vec<_>>(),
        );
        let tx = conn.unchecked_transaction().map_err(e2s)?;
        chat.status = "running".into();
        chat.error.clear();
        append(
            &tx,
            &chat,
            "user",
            None,
            &format!("{}{note}", message.trim()),
            0,
            None,
            false,
        )?;
        save(&tx, &mut chat)?;
        tx.commit().map_err(e2s)?;
        let answer = state(&conn, &chat_id)?;
        (chat, files, answer)
    };
    changed(&app, &chat_id);
    tauri::async_runtime::spawn(async move {
        let _registration = registration;
        let result = drive(&app, &chat, message, files, &control).await;
        let _ = with_conn(&app, |conn| {
            let mut chat = get(conn, &chat_id)?;
            let stopped = *control.borrow()
                || result
                    .as_ref()
                    .is_err_and(|e| e.contains(crate::ai_runs::CANCELLED_MARKER));
            chat.status = if result.is_ok() || stopped {
                "idle"
            } else {
                "error"
            }
            .into();
            chat.error = if stopped {
                "Se detuvo la respuesta del equipo. Los cambios ya realizados se conservan.".into()
            } else {
                result.err().unwrap_or_default()
            };
            chat.active_run_id.clear();
            chat.active_member_id.clear();
            save(conn, &mut chat)
        });
        changed(&app, &chat_id);
    });
    Ok(answer)
}

#[tauri::command]
pub fn team_chat_cancel(app: AppHandle, db: State<'_, Db>, chat_id: String) -> Result<(), String> {
    if let Some(control) = RUNNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&chat_id)
    {
        control.send_replace(true);
    }
    let run_id = {
        let conn = db.0.lock().map_err(e2s)?;
        let mut chat = get(&conn, &chat_id)?;
        if chat.status == "running" {
            chat.status = "cancelling".into();
            save(&conn, &mut chat)?;
        }
        chat.active_run_id
    };
    if !run_id.is_empty() {
        crate::ai_runs::cancel(&run_id);
    }
    changed(&app, &chat_id);
    Ok(())
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;
