use super::*;
use crate::db::models::AgentDraft;
use serde_json::json;

fn fixture() -> (Connection, Team, String) {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn).unwrap();
    let ws = queries::create_workspace(&conn, "Workspace", "folder", "#fff").unwrap();
    let project = uid();
    conn.execute("INSERT INTO projects (id, workspace_id, name, local_path, sort_order, created_at) VALUES (?1,?2,'API','/tmp/team-chat',0,?3)", params![project, ws.id, queries::now()]).unwrap();
    let mut members = Vec::new();
    for (id, name, edits) in [
        ("lead", "Arquitecto", true),
        ("backend", "Backend", true),
        ("advisor", "Asesor", false),
    ] {
        let agent = queries::save_workspace_agent(
            &conn,
            &AgentDraft {
                workspace_id: ws.id.clone(),
                name: name.into(),
                role: name.into(),
                provider: "claude".into(),
                model: "sonnet".into(),
                enabled: true,
                edits,
                ..Default::default()
            },
        )
        .unwrap();
        members.push(super::super::Member {
            id: id.into(),
            agent_id: agent.id,
            name: name.into(),
            edits,
            advisor: id == "advisor",
            ..Default::default()
        });
    }
    let team = super::super::save_team(
        &conn,
        Team {
            workspace_id: ws.id,
            name: "Equipo API".into(),
            lead: "lead".into(),
            members,
            ..Default::default()
        },
    )
    .unwrap();
    (conn, team, project)
}

fn control() -> Control {
    Arc::new(tokio::sync::watch::channel(false).0)
}
fn delegation(member: &str, kind: &str) -> String {
    format!(
        "Lo resolverá un especialista.\n```equipo-chat\n{}\n```",
        json!({ "delegate": [{ "member": member, "kind": kind, "instruction": "Crea el endpoint y verifica el resultado" }] })
    )
}

#[test]
fn persists_chats_and_keeps_new_conversations_separate() {
    let (conn, team, project) = fixture();
    let first = open(&conn, team.clone(), &project, false).unwrap();
    let reopened = open(&conn, team.clone(), &project, false).unwrap();
    assert_eq!(first.chat.id, reopened.chat.id);
    assert_eq!(first.task.conversation_id, reopened.task.conversation_id);
    assert!(first.task.batch_id.starts_with(BATCH_PREFIX));
    append(
        &conn,
        &first.chat,
        "user",
        None,
        "Añade un endpoint",
        0,
        None,
        false,
    )
    .unwrap();
    let second = open(&conn, team.clone(), &project, true).unwrap();
    assert_ne!(first.chat.id, second.chat.id);
    assert_ne!(first.task.conversation_id, second.task.conversation_id);
    assert_eq!(
        state(&conn, &first.chat.id).unwrap().messages[0].content,
        "Añade un endpoint"
    );
    let history = history(&conn, &team.id).unwrap();
    assert_eq!(history.len(), 2);
    assert!(history
        .iter()
        .any(|entry| entry.title == "Añade un endpoint"));
}

#[test]
fn a_lead_can_suggest_a_formal_run_without_starting_delegates() {
    let (conn, team, project) = fixture();
    let chat = open(&conn, team, &project, false).unwrap().chat;
    let result = plan(
        "Propongo una corrida con los criterios acordados.\n```equipo-chat\n{\"suggest_run\":true,\"delegate\":[]}\n```",
        &chat,
    );
    assert!(result.suggest_run);
    assert!(result.delegate.is_empty() && result.errors.is_empty());
    assert_eq!(result.text, "Propongo una corrida con los criterios acordados.");
}

#[test]
fn requires_a_lead_and_checks_workspace_and_repository_permissions() {
    let (conn, mut team, project) = fixture();
    let lead = team.lead.clone();
    team.lead.clear();
    assert!(open(&conn, team.clone(), &project, false)
        .unwrap_err()
        .contains("líder"));
    team.lead = lead;
    // A repository list that names nothing usable no longer stops the chat: the lead says itself
    // what it may touch.
    team.members[0].repos = vec!["different-project".into()];
    assert!(open(&conn, team.clone(), &project, false).is_ok());
    team.members[0].repos.clear();
    team.workspace_id = "another-workspace".into();
    assert!(open(&conn, team, &project, true)
        .unwrap_err()
        .contains("Agrega un repositorio"));
}

#[test]
fn a_read_only_agent_cannot_gain_write_access_from_a_team() {
    let (conn, team, project) = fixture();
    conn.execute(
        "UPDATE workspace_agents SET edits = 0 WHERE id = ?1",
        [&team.members[1].agent_id],
    )
    .unwrap();
    let state = open(&conn, team, &project, false).unwrap();
    let member = state
        .chat
        .members
        .iter()
        .find(|m| m.member.id == "backend")
        .unwrap();
    assert!(!may_edit(&state.chat, member));
    assert!(!plan(&delegation("backend", "work"), &state.chat)
        .errors
        .is_empty());
    assert_eq!(
        plan(&delegation("backend", "answer"), &state.chat)
            .delegate
            .len(),
        1
    );
}

#[test]
fn validates_delegations_and_removes_the_control_protocol_from_visible_messages() {
    let (conn, team, project) = fixture();
    let chat = open(&conn, team, &project, false).unwrap().chat;
    let parsed = plan(&delegation("backend", "work"), &chat);
    assert_eq!(parsed.text, "Lo resolverá un especialista.");
    assert_eq!(parsed.delegate.len(), 1);
    assert!(parsed.delegate[0].work);
    for (member, kind) in [
        ("unknown", "work"),
        ("advisor", "work"),
        ("lead", "work"),
        ("backend", "invalid"),
    ] {
        let rejected = plan(&delegation(member, kind), &chat);
        assert!(rejected.delegate.is_empty());
        assert!(!rejected.errors.is_empty());
    }
    assert!(plan("```equipo-chat\nnot json\n```", &chat)
        .delegate
        .is_empty());
    assert_eq!(
        plan("Una respuesta directa.", &chat).text,
        "Una respuesta directa."
    );
}

#[test]
fn cli_write_permissions_follow_the_active_member_and_the_kind_of_turn() {
    let (conn, team, project) = fixture();
    let mut chat = open(&conn, team, &project, false).unwrap().chat;
    let member = chat
        .members
        .iter()
        .find(|m| m.member.id == "backend")
        .unwrap()
        .clone();
    let task = task_for(&conn, &chat, &member).unwrap();
    assert!(read_only_conversation(&conn, &task.conversation_id));
    chat.active_member_id = "backend".into();
    save(&conn, &mut chat).unwrap();
    assert!(read_only_conversation(&conn, &task.conversation_id));
    conn.execute(
        "UPDATE agent_team_chats SET active_read_only = 0 WHERE id = ?1",
        [&chat.id],
    )
    .unwrap();
    assert!(!read_only_conversation(&conn, &task.conversation_id));
    chat.active_member_id = "lead".into();
    save(&conn, &mut chat).unwrap();
    let lead_task = queries::get_agent_task(&conn, &chat.task_id)
        .unwrap()
        .unwrap();
    assert!(read_only_conversation(&conn, &lead_task.conversation_id));
    chat.members
        .iter_mut()
        .find(|m| m.member.id == "lead")
        .unwrap()
        .member
        .hands_on = true;
    save(&conn, &mut chat).unwrap();
    assert!(!read_only_conversation(&conn, &lead_task.conversation_id));
    assert!(read_only_conversation(&conn, &task.conversation_id));
}

#[test]
fn interrupted_chats_keep_history_and_stop_claiming_to_run_after_restart() {
    let (conn, team, project) = fixture();
    let mut chat = open(&conn, team, &project, false).unwrap().chat;
    append(&conn, &chat, "user", None, "Continúa", 0, None, false).unwrap();
    chat.status = "running".into();
    chat.active_run_id = "old-process".into();
    save(&conn, &mut chat).unwrap();
    recover(&conn).unwrap();
    let restored = state(&conn, &chat.id).unwrap();
    assert_eq!(restored.chat.status, "error");
    assert!(restored.chat.active_run_id.is_empty());
    assert_eq!(restored.messages.len(), 1);
    assert!(!restored.chat.error.is_empty());
}

#[tokio::test]
async fn the_lead_can_answer_without_starting_any_member_turn() {
    let (conn, team, project) = fixture();
    let chat = open(&conn, team, &project, false).unwrap().chat;
    let app = tauri::test::mock_app();
    app.manage(Db::new(conn));
    let mut calls = Vec::new();
    drive_with(
        app.handle(),
        &chat,
        "¿Qué hace el equipo?".into(),
        vec![],
        &control(),
        |member, _, _, read_only| {
            calls.push(member.member.id.clone());
            assert!(read_only);
            Box::pin(async { Ok(("Definimos e implementamos la API.".into(), 10, None)) })
        },
    )
    .await
    .unwrap();
    assert_eq!(calls, vec!["lead"]);
    let stored = with_conn(app.handle(), |conn| state(conn, &chat.id)).unwrap();
    assert_eq!(stored.messages[0].member_id, "lead");
}

#[tokio::test]
async fn executes_a_delegated_edit_and_gives_the_real_result_back_to_the_lead() {
    let (conn, team, project) = fixture();
    let chat = open(&conn, team, &project, false).unwrap().chat;
    let app = tauri::test::mock_app();
    app.manage(Db::new(conn));
    let temp = std::env::temp_dir().join(format!("codeflow-team-chat-{}", uid()));
    std::fs::create_dir(&temp).unwrap();
    let file = temp.join("endpoint.ts");
    let mut calls = Vec::new();
    drive_with(
        app.handle(),
        &chat,
        "Crea un endpoint".into(),
        vec![],
        &control(),
        |member, message, _, read_only| {
            calls.push(member.member.id.clone());
            let text = match calls.len() {
                1 => {
                    assert!(read_only);
                    delegation("backend", "work")
                }
                2 => {
                    assert_eq!(member.member.id, "backend");
                    assert!(!read_only);
                    assert!(message.contains("Crea el endpoint"));
                    std::fs::write(&file, "export const endpoint = () => 'ok';").unwrap();
                    "Creé endpoint.ts y verifiqué el resultado.".into()
                }
                3 => {
                    assert!(message.contains("Creé endpoint.ts"));
                    "El equipo creó el endpoint.".into()
                }
                _ => panic!("unnecessary model turn"),
            };
            Box::pin(async move { Ok((text, 10, None)) })
        },
    )
    .await
    .unwrap();
    assert_eq!(calls, vec!["lead", "backend", "lead"]);
    assert!(std::fs::read_to_string(&file).unwrap().contains("endpoint"));
    let stored = with_conn(app.handle(), |conn| state(conn, &chat.id)).unwrap();
    assert_eq!(
        stored
            .messages
            .iter()
            .map(|m| m.member_id.as_str())
            .collect::<Vec<_>>(),
        vec!["lead", "backend", "lead"]
    );
    assert!(stored
        .messages
        .iter()
        .all(|m| !m.content.contains("```equipo-chat")));
    std::fs::remove_dir_all(temp).unwrap();
}

#[tokio::test]
async fn stopping_before_a_handoff_prevents_a_member_from_starting() {
    let (conn, team, project) = fixture();
    let chat = open(&conn, team, &project, false).unwrap().chat;
    let app = tauri::test::mock_app();
    app.manage(Db::new(conn));
    let stop = control();
    let mut calls = 0;
    let result = drive_with(
        app.handle(),
        &chat,
        "Hazlo".into(),
        vec![],
        &stop,
        |_, _, _, _| {
            calls += 1;
            stop.send_replace(true);
            let response = delegation("backend", "work");
            Box::pin(async move { Ok((response, 10, None)) })
        },
    )
    .await;
    assert!(result
        .unwrap_err()
        .contains(crate::ai_runs::CANCELLED_MARKER));
    assert_eq!(calls, 1);
}

#[test]
fn the_chat_belongs_to_the_workspace_and_places_each_member_in_a_repository_it_may_use() {
    let (conn, mut team, open_in_app) = fixture();
    let core = uid();
    conn.execute("INSERT INTO projects (id, workspace_id, name, local_path, sort_order, created_at) VALUES (?1,?2,'Core','/tmp/team-chat-core',1,?3)", params![core, team.workspace_id, queries::now()]).unwrap();

    // The lead may only work in Core, while the app has the other repository open: the chat still
    // opens, the lead works in Core and the backend member, unrestricted, where the app is.
    team.members[0].repos = vec![core.clone()];
    team = super::super::save_team(&conn, team).unwrap();
    let chat = open(&conn, team.clone(), &open_in_app, false).unwrap().chat;
    assert_eq!(chat.project_id, core);
    assert_eq!(chat.repo_of("lead").name, "Core");
    assert_eq!(chat.repo_of("backend").id, open_in_app);
    assert!(prompt(&chat, &chat.members[0]).contains("Trabajas en el repositorio: Core"));
    let backend = chat.members.iter().find(|m| m.member.id == "backend").unwrap();
    assert_eq!(task_for(&conn, &chat, backend).unwrap().project_id, open_in_app);

    // No repository open at all is fine too.
    assert!(open(&conn, team.clone(), "", true).is_ok());

    // Reopening from another repository finds the same conversation: it is the team's.
    assert_eq!(open(&conn, team.clone(), &core, false).unwrap().chat.id, history(&conn, &team.id).unwrap()[0].id);
}

#[test]
fn repository_lists_guide_the_lead_instead_of_blocking_it_and_stale_ones_are_forgotten() {
    let (conn, mut team, project) = fixture();
    let agent_id = team.members[0].agent_id.clone();
    let core = uid();
    conn.execute("INSERT INTO projects (id, workspace_id, name, local_path, sort_order, created_at) VALUES (?1,?2,'Core','/tmp/team-chat-core',1,?3)", params![core, team.workspace_id, queries::now()]).unwrap();

    // The user's case: the seat allows Core, the agent allows API, nothing in common. The chat
    // opens; the lead starts where the app is (API, which one side names) and is told both.
    conn.execute("UPDATE workspace_agents SET repos = ?1 WHERE id = ?2", params![format!("[\"{project}\"]"), agent_id]).unwrap();
    team.members[0].repos = vec![core.clone()];
    team = super::super::save_team(&conn, team).unwrap();
    let chat = open(&conn, team.clone(), &project, false).unwrap().chat;
    assert_eq!(chat.repo_of("lead").id, project);
    let told = prompt(&chat, &chat.members[0]);
    assert!(told.contains("Tus repositorios asignados son: API, Core"), "{told}");

    // A model is the one thing it cannot do without.
    conn.execute("UPDATE workspace_agents SET model = '' WHERE id = ?1", params![agent_id]).unwrap();
    let err = open(&conn, team.clone(), &project, true).unwrap_err();
    assert!(err.contains("no tiene modelo"), "{err}");
    conn.execute("UPDATE workspace_agents SET model = 'sonnet' WHERE id = ?1", params![agent_id]).unwrap();

    // Cleaning stale ids drops them where a live repository is left, and never empties a list
    // (empty would mean "every repository").
    conn.execute("UPDATE workspace_agents SET repos = ?1 WHERE id = ?2", params![format!("[\"removed-long-ago\",\"{project}\"]"), agent_id]).unwrap();
    team.members[0].repos = vec!["removed-long-ago".into(), project.clone()];
    super::super::save_team(&conn, team.clone()).unwrap();
    let other_agent = team.members[1].agent_id.clone();
    conn.execute("UPDATE workspace_agents SET repos = '[\"gone\"]' WHERE id = ?1", params![other_agent]).unwrap();
    super::super::forget_missing_repositories(&conn).unwrap();
    let repos_of = |id: &str| -> String { conn.query_row("SELECT repos FROM workspace_agents WHERE id = ?1", params![id], |r| r.get(0)).unwrap() };
    assert_eq!(repos_of(&agent_id), format!("[\"{project}\"]"));
    assert_eq!(repos_of(&other_agent), "[\"gone\"]");
    let saved = super::super::list_teams(&conn, &team.workspace_id).unwrap();
    assert_eq!(saved[0].members[0].repos, vec![project.clone()]);
    let fresh = saved.into_iter().next().unwrap();
    assert!(open(&conn, fresh, &project, true).is_ok());
}

#[test]
fn a_message_sent_without_files_is_kept_as_it_was_written() {
    assert_eq!(stored_question("  hola  ", &[]), "hola");

    let file = crate::commands::chat_attach::ChatAttachment {
        id: "a3f19c2e-captura.png".into(),
        name: "captura.png".into(),
        path: "/state/a3f19c2e-captura.png".into(),
        bytes: 12,
        is_image: true,
    };
    let kept = stored_question("mira esto", &[file]);
    assert!(kept.starts_with("mira esto\n\nArchivos adjuntos a este mensaje"), "{kept}");
    assert!(kept.ends_with("- captura.png (/state/a3f19c2e-captura.png)"), "{kept}");
}

#[test]
fn deleting_a_conversation_takes_its_turns_and_leaves_the_team_s_other_ones() {
    let (conn, team, project) = fixture();
    let kept = open(&conn, team.clone(), &project, false).unwrap();
    append(&conn, &kept.chat, "user", None, "Esta se queda", 0, None, false).unwrap();
    let gone = open(&conn, team.clone(), &project, true).unwrap();
    append(&conn, &gone.chat, "user", None, "Esta se va", 0, None, false).unwrap();
    // A member that took a turn has a task of its own in the conversation, with its transcript.
    let backend = gone.chat.members.iter().find(|m| m.member.id == "backend").unwrap();
    let member_task = task_for(&conn, &gone.chat, backend).unwrap();
    for conversation in [&gone.task.conversation_id, &member_task.conversation_id, &kept.task.conversation_id] {
        conn.execute(
            "INSERT INTO activity_log (id, project_id, session_id, question, answer, created_at) VALUES (?1,?2,?3,'q','a',?4)",
            params![uid(), project, conversation, queries::now()],
        )
        .unwrap();
    }

    // Not while the team is answering it: the turn would go on with nowhere to report.
    let mut busy = gone.chat.clone();
    busy.status = "running".into();
    save(&conn, &mut busy).unwrap();
    assert!(delete(&conn, &gone.chat.id).unwrap_err().contains("Detén"));
    busy.status = "idle".into();
    save(&conn, &mut busy).unwrap();

    let mut conversations = delete(&conn, &gone.chat.id).unwrap();
    conversations.sort();
    let mut expected = vec![gone.task.conversation_id.clone(), member_task.conversation_id.clone()];
    expected.sort();
    assert_eq!(conversations, expected);

    let count = |sql: &str, value: &str| conn.query_row(sql, [value], |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM agent_team_chats WHERE id = ?1", &gone.chat.id), 0);
    assert_eq!(count("SELECT COUNT(*) FROM agent_team_chat_messages WHERE chat_id = ?1", &gone.chat.id), 0);
    assert_eq!(count("SELECT COUNT(*) FROM agent_tasks WHERE batch_id LIKE ?1", &format!("{BATCH_PREFIX}{}:%", gone.chat.id)), 0);
    for conversation in &expected {
        assert_eq!(count("SELECT COUNT(*) FROM activity_log WHERE session_id = ?1", conversation), 0);
    }

    // The other conversation is whole, and is the one the team opens next.
    let rest = history(&conn, &team.id).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].title, "Esta se queda");
    assert_eq!(state(&conn, &kept.chat.id).unwrap().messages.len(), 1);
    assert_eq!(count("SELECT COUNT(*) FROM activity_log WHERE session_id = ?1", &kept.task.conversation_id), 1);
    assert_eq!(open(&conn, team, &project, false).unwrap().chat.id, kept.chat.id);

    // Asked twice — two windows — the second finds nothing and says nothing.
    assert!(delete(&conn, &gone.chat.id).unwrap().is_empty());
}
