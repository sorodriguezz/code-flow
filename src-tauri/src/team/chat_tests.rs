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
    )
    .unwrap();
    let second = open(&conn, team.clone(), &project, true).unwrap();
    assert_ne!(first.chat.id, second.chat.id);
    assert_ne!(first.task.conversation_id, second.task.conversation_id);
    assert_eq!(
        state(&conn, &first.chat.id).unwrap().messages[0].content,
        "Añade un endpoint"
    );
    let history = history(&conn, &team.id, &project).unwrap();
    assert_eq!(history.len(), 2);
    assert!(history
        .iter()
        .any(|entry| entry.title == "Añade un endpoint"));
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
    team.members[0].repos = vec!["different-project".into()];
    assert!(open(&conn, team.clone(), &project, false)
        .unwrap_err()
        .contains("acceso"));
    team.members[0].repos.clear();
    team.workspace_id = "another-workspace".into();
    assert!(open(&conn, team, &project, false)
        .unwrap_err()
        .contains("espacios distintos"));
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
    append(&conn, &chat, "user", None, "Continúa", 0, None).unwrap();
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
