//! The call's stage in the app: the agents' own providers for what they say, the reading aloud's
//! queue for their voices, the team's conversation for what is kept, and the team engine for the
//! work at the end.

use std::future::Future;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{CallState, Line, Speaking, Stage, Thought, LINE_EVENT, STATE_EVENT};
use crate::ai_accounts::Choice;
use crate::commands::claude_cmd::{load_ai_config_as, AiConfig, AiTask};
use crate::db::Db;
use crate::speech::Voice;
use crate::team::chat::{self, Chat};
use crate::team::engine::RepoPick;
use crate::team::{self, MemberSnap};

#[derive(Clone)]
pub struct AppStage {
    pub app: AppHandle,
}

/// Which model agents talk with when nothing was chosen for one: `fast` (the default) or `own`.
pub const TALK_KEY: &str = "team_call_talk";

/// How the call's agents talk, as the setting says: `fast` unless it says `own`.
pub fn talk_mode(conn: &rusqlite::Connection) -> &'static str {
    match crate::db::queries::get_setting(conn, TALK_KEY).ok().flatten().as_deref().map(str::trim) {
        Some("own") => "own",
        _ => "fast",
    }
}

/// `member`'s provider and account with the model it talks with in a call. In order: the one chosen
/// for that agent («Modelo en las llamadas»); else, by the call's choice, its provider's fast
/// model — its own where the provider has none — or its own. The work is always done with its own.
pub fn talk_config(conn: &rusqlite::Connection, member: &MemberSnap, workspace: &str) -> Result<(AiConfig, String), String> {
    let config = load_ai_config_as(conn, &member.provider, &member.model, Choice::parse(member.account_id.as_deref()), Some(AiTask::Chat), Some(workspace))?;
    let chosen: String = conn
        .query_row("SELECT call_model FROM workspace_agents WHERE id = ?1", [&member.member.agent_id], |row| row.get(0))
        .unwrap_or_default();
    let model = talk_model(chosen.trim(), talk_mode(conn), config.engine.commit_message_model(), &member.model);
    Ok((config, model))
}

/// The rule of [`talk_config`], on its own: `chosen` for the agent, the call's `mode`, the
/// provider's `fast` model and the agent's `own`.
pub fn talk_model(chosen: &str, mode: &str, fast: &str, own: &str) -> String {
    if !chosen.is_empty() {
        chosen.to_string()
    } else if mode == "own" || fast.trim().is_empty() {
        own.to_string()
    } else {
        fast.to_string()
    }
}

impl AppStage {
    /// [`talk_config`] for a member, read now: a choice changed mid-call applies to the next thing said.
    fn quick(&self, member: &MemberSnap, workspace: &str) -> Result<(AiConfig, String), String> {
        let db = self.app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        talk_config(&conn, member, workspace)
    }
}

impl Stage for AppStage {
    fn think(&self, call: &str, thought: Thought, written: mpsc::UnboundedSender<String>, stop: CancellationToken) -> impl Future<Output = Result<String, String>> + Send {
        let app = self.app.clone();
        let conversation = format!("team-call:{call}");
        let quick = self.quick(&thought.member, &thought.workspace);
        async move {
            let (config, model) = quick?;
            let run_id = format!("team-call-{}", uuid::Uuid::new_v4());
            let message_id = uuid::Uuid::new_v4().to_string();
            // The engine's pieces go out as an event for a window to paint; this listens for its own.
            let mine = message_id.clone();
            let listening = app.listen_any("ai:chat-delta", move |event| {
                let Ok(piece) = serde_json::from_str::<serde_json::Value>(event.payload()) else { return };
                if piece["messageId"].as_str() == Some(mine.as_str()) && piece["kind"].as_str() == Some("text") {
                    if let Some(text) = piece["text"].as_str() {
                        let _ = written.send(text.to_string());
                    }
                }
            });
            let sink = crate::ai::DeltaSink { conversation_id: conversation, message_id };
            let answer = crate::ai_runs::scoped(app.clone(), Some(run_id.clone()), async {
                crate::ai::call_line(&*config.engine, &config.binary, &model, &thought.system, &thought.ask, &thought.talk, Some(crate::ai::effort::LOW), Some(sink)).await
            });
            tokio::pin!(answer);
            let answer = tokio::select! {
                answer = &mut answer => answer,
                _ = stop.cancelled() => {
                    // Asked to stop rather than dropped: the engine's process is its to end.
                    crate::ai_runs::cancel(&run_id);
                    answer.await
                }
            };
            app.unlisten(listening);
            answer
        }
    }

    fn voice(&self, member: &str, voice: &Voice, lang: &'static str) -> Speaking {
        let (sentences, said) = crate::speech::say_stream(&self.app, &format!("call:{member}"), lang, voice.clone());
        let (done, ended) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let _ = said.await;
            let _ = done.send(());
        });
        Speaking { sentences, done: ended }
    }

    fn hush(&self) {
        crate::speech::stop();
    }

    fn state(&self, mut state: CallState) {
        // The lines travel one by one ([`LINE_EVENT`]); a window that opens late asks for them all.
        state.lines.clear();
        let _ = self.app.emit(STATE_EVENT, state);
    }

    fn line(&self, line: &Line) {
        let _ = self.app.emit(LINE_EVENT, line);
    }

    fn keep(&self, chat: &Chat, member: Option<&MemberSnap>, text: &str) {
        let db = self.app.state::<Db>();
        let Ok(conn) = db.0.lock() else { return };
        let role = if member.is_some() { "assistant" } else { "user" };
        if chat::append(&conn, chat, role, member, text, 0, None, false).is_ok() {
            drop(conn);
            chat::changed(&self.app, &chat.id);
        }
    }

    fn facts(&self, chat: &Chat, lang: &str) -> String {
        let db = self.app.state::<Db>();
        let Ok(conn) = db.0.lock() else { return String::new() };
        facts(&conn, chat, lang)
    }

    fn look(&self, chat: &Chat, member: MemberSnap, what: String, talk: String, lang: &'static str, stop: CancellationToken) -> impl Future<Output = Result<(String, String), String>> + Send {
        let app = self.app.clone();
        let chat_id = chat.id.clone();
        let quick = self.quick(&member, &chat.workspace_id);
        async move {
            let control: chat::Control = Arc::new(tokio::sync::watch::channel(false).0);
            let message = if lang == "es" {
                format!("Estás en una llamada con el equipo.\n\n## Qué te pidieron hacer\n{what}\n\n## Lo que se ha dicho en la llamada\n{talk}\n\nUsa las herramientas disponibles para resolver el pedido según tus permisos. Si te pidieron ejecutar o cambiar algo y tienes permiso, hazlo. Resume el resultado y lo que pudiste verificar.")
            } else {
                format!("You are on a call with the team.\n\n## What you were asked to do\n{what}\n\n## What has been said on the call\n{talk}\n\nUse the available tools to handle the request within your permissions. If asked to run something or make a change and you have permission, do it. Summarize the result and what you verified.")
            };
            let turn = chat::turn(&app, &chat_id, &member, message, None, chat::TurnKind::Call, &control);
            tokio::pin!(turn);
            let found = tokio::select! {
                found = &mut turn => found,
                _ = stop.cancelled() => {
                    control.send_replace(true);
                    turn.await
                }
            };
            let (full, _, _) = found?;
            // What the call hears is the gist; the whole of it is kept in the conversation.
            let said = match quick {
                Ok((config, model)) => crate::ai::spoken_summary(&*config.engine, &config.binary, &model, "", &full).await.ok(),
                Err(_) => None,
            };
            let said = said.filter(|said| !said.trim().is_empty()).unwrap_or_else(|| crate::speech::speakable(&full).chars().take(400).collect());
            Ok((full, said))
        }
    }

    fn minutes(&self, chat: &Chat, lead: MemberSnap, system: String, talk: String) -> impl Future<Output = Result<String, String>> + Send {
        let quick = self.quick(&lead, &chat.workspace_id);
        async move {
            let (config, model) = quick?;
            crate::ai::call_minutes(&*config.engine, &config.binary, &model, &system, &talk).await
        }
    }

    fn start(&self, chat: &Chat, title: String, goal: String) -> impl Future<Output = Result<String, String>> + Send {
        let app = self.app.clone();
        let (workspace, team_id) = (chat.workspace_id.clone(), chat.team_id.clone());
        let repos = repos_of(chat);
        async move {
            let db = app.state::<Db>();
            let title = Some(title).filter(|title| !title.trim().is_empty());
            let state = team::engine::start_run(db.inner(), workspace, team_id, goal, title, repos, None, None).await?;
            team::engine::changed(&app, &state.run.id);
            Ok(state.run.id)
        }
    }

    fn deafen(&self) {
        super::ear::stop();
    }
}

/// The repositories the team works in for what the call agreed: the lead's first, then every
/// other member's, each once — on the branch each has checked out.
fn repos_of(chat: &Chat) -> Vec<RepoPick> {
    let mut ids = vec![chat.project_id.clone()];
    let mut others: Vec<(&String, &chat::RepoRef)> = chat.member_repos.iter().collect();
    others.sort_by(|a, b| a.1.name.cmp(&b.1.name).then(a.0.cmp(b.0)));
    for (_, repo) in others {
        if !ids.contains(&repo.id) {
            ids.push(repo.id.clone());
        }
    }
    ids.into_iter().filter(|id| !id.is_empty()).take(team::MAX_REPOS).map(|project_id| RepoPick { project_id, target_branch: String::new() }).collect()
}

/// What this computer knows that an agent may say as fact: where the team works and what its runs
/// are doing right now. Read from the database, no model involved — which is what makes «¿cómo
/// vamos?» an answer and not a guess.
pub fn facts(conn: &rusqlite::Connection, chat: &Chat, lang: &str) -> String {
    let es = lang == "es";
    let mut out: Vec<String> = Vec::new();
    let mut repos: Vec<&str> = chat.member_repos.values().map(|repo| repo.name.as_str()).chain(std::iter::once(chat.project_name.as_str())).filter(|name| !name.is_empty()).collect();
    repos.sort_unstable();
    repos.dedup();
    if !repos.is_empty() {
        out.push(format!("- {}: {}.", if es { "Repositorios del equipo" } else { "The team's repositories" }, repos.join(", ")));
    }
    let runs: Vec<team::Run> = team::list_runs(conn, &chat.workspace_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|run| run.team_id == chat.team_id && !matches!(run.status.as_str(), "done" | "failed" | "aborted"))
        .take(3)
        .collect();
    if runs.is_empty() {
        out.push(if es { "- El equipo no tiene ninguna corrida en marcha ahora.".into() } else { "- The team has no run under way right now.".into() });
    }
    for run in runs {
        let items: Vec<team::Item> = team::list_items(conn, &run.id).unwrap_or_default().into_iter().filter(|item| !item.is_lead()).collect();
        let done = items.iter().filter(|item| item.status == "done").count();
        let waiting = if run.gate.is_empty() { String::new() } else if es { format!(", esperando la aprobación del usuario ({})", run.gate) } else { format!(", waiting for the user's approval ({})", run.gate) };
        out.push(if es {
            format!("- Corrida «{}»: {done} de {} tareas terminadas{waiting}.", run.title, items.len())
        } else {
            format!("- Run “{}”: {done} of {} tasks done{waiting}.", run.title, items.len())
        });
        for item in items.iter().filter(|item| item.status != "done").take(12) {
            let state = status(&item.status, es);
            let trouble = item.last_error.lines().next().filter(|line| !line.trim().is_empty()).map(|line| format!(" — {}", line.chars().take(160).collect::<String>())).unwrap_or_default();
            out.push(format!("  - {}: {} ({state}){trouble}", item.member_name, item.title));
        }
    }
    out.join("\n")
}

fn status(status: &str, es: bool) -> &'static str {
    match (status, es) {
        ("running", true) => "en curso",
        ("running", false) => "in progress",
        ("pending", true) => "pendiente",
        ("pending", false) => "pending",
        ("waiting", true) => "esperando una respuesta",
        ("waiting", false) => "waiting for an answer",
        ("gated", true) => "esperando aprobación",
        ("gated", false) => "waiting for approval",
        ("error", true) => "con error",
        ("error", false) => "failed",
        ("cancelled", true) | ("skipped", true) => "descartada",
        ("cancelled", false) | ("skipped", false) => "dropped",
        ("delegated", true) => "delegada",
        ("delegated", false) => "delegated",
        (_, true) => "sin empezar",
        (_, false) => "not started",
    }
}
