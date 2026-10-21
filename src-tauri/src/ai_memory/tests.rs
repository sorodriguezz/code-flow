use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);").unwrap();
    conn.execute_batch("INSERT INTO workspaces VALUES ('w1'), ('w2'); INSERT INTO projects VALUES ('p1'), ('p2');").unwrap();
    crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
    conn
}

fn new(scope: Scope, kind: Kind, title: &str, body: &str, approved: bool) -> NewMemory {
    NewMemory {
        scope: Some(scope),
        workspace_id: Some("w1".into()),
        project_id: Some("p1".into()),
        kind: Some(kind),
        title: title.into(),
        body: body.into(),
        approved,
        ..Default::default()
    }
}

/// An agent's proposal, as `cf remember` / `propose_memory` files it: no kind, source `agent`.
fn agent(title: &str, body: &str) -> NewMemory {
    NewMemory { scope: Some(Scope::Project), workspace_id: Some("w1".into()), project_id: Some("p1".into()), title: title.into(), body: body.into(), source: Some("agent".into()), ..Default::default() }
}

/// What the chat's "recuerda que…" sends: the rule as the title, a project preference.
fn said(rule: &str) -> NewMemory {
    NewMemory {
        scope: Some(Scope::Project),
        workspace_id: Some("w1".into()),
        project_id: Some("p1".into()),
        kind: Some(Kind::Preference),
        title: rule.into(),
        approved: true,
        source: Some("user".into()),
        ..Default::default()
    }
}

fn rows(conn: &Connection) -> usize {
    conn.query_row("SELECT COUNT(*) FROM ai_memories", [], |r| r.get::<_, i64>(0)).unwrap() as usize
}

/// Moves a memory (and its history) `days` into the past.
fn age(conn: &Connection, id: &str, days: i64) {
    let shift = days * DAY_MS;
    conn.execute("UPDATE ai_memories SET created_at = created_at - ?1, updated_at = updated_at - ?1 WHERE id = ?2", params![shift, id]).unwrap();
    conn.execute("UPDATE ai_memory_revisions SET at = at - ?1 WHERE memory_id = ?2", params![shift, id]).unwrap();
}

#[test]
fn duplicates_fold_into_one_and_secrets_are_redacted() {
    let conn = db();
    let a = create(&conn, new(Scope::Project, Kind::Convention, "Usar pnpm", "Nunca npm.", true)).unwrap();
    let b = create(&conn, new(Scope::Project, Kind::Convention, "usar PNPM.", "otra vez", true)).unwrap();
    assert_eq!(a.id, b.id);
    // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
    let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
    let c = create(&conn, new(Scope::Project, Kind::Fact, "Token", &token, true)).unwrap();
    assert!(c.body.contains("[REDACTED"));
    assert_eq!(revisions(&conn, &a.id).unwrap().last().unwrap().action, "created");
}

#[test]
fn evidence_is_redacted_like_the_title_and_the_body() {
    let conn = db();
    let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
    let mut proposal = agent("Servidor de pruebas", "Las pruebas usan el servidor de staging");
    proposal.evidence = vec![format!("log: export GITHUB_TOKEN={token}"), "src/app.ts".into(), "src/app.ts".into(), "  ".into()];
    let memory = propose(&conn, proposal).unwrap().0;
    assert_eq!(memory.evidence.len(), 2, "blank and repeated entries are dropped");
    assert!(memory.evidence.iter().all(|e| !e.contains("ghp_abc")), "{:?}", memory.evidence);
    // A later proposal's evidence is redacted before it is merged in, too.
    let mut again = agent("Servidor de pruebas", "");
    again.evidence = vec![format!("otra pista {token}")];
    let memory = propose(&conn, again).unwrap().0;
    assert_eq!(memory.evidence.len(), 3);
    assert!(memory.evidence.iter().all(|e| !e.contains("ghp_abc")));
}

#[test]
fn only_approved_memories_of_the_right_scope_reach_a_model() {
    let conn = db();
    create(&conn, new(Scope::Project, Kind::Decision, "Base de datos", "Usamos SQLite, no PostgreSQL.", true)).unwrap();
    create(&conn, new(Scope::Project, Kind::Decision, "Colas", "Sin Kafka.", false)).unwrap();
    create(&conn, NewMemory { scope: Some(Scope::Global), kind: Some(Kind::Preference), title: "Responde en español".into(), approved: true, ..Default::default() }).unwrap();
    let mut other = new(Scope::Project, Kind::Decision, "Otra base", "MySQL", true);
    other.project_id = Some("p2".into());
    create(&conn, other).unwrap();
    let found = relevant(&conn, Some("w1"), Some("p1"), "¿qué base de datos usamos?", false, 2_000).unwrap();
    let titles: Vec<&str> = found.iter().map(|m| m.title.as_str()).collect();
    assert!(titles.contains(&"Base de datos"));
    assert!(titles.contains(&"Responde en español"), "a preference holds for every question");
    assert!(!titles.contains(&"Colas"), "a candidate is not shown");
    assert!(!titles.contains(&"Otra base"), "another project's decision is not shown");
    assert_eq!(get(&conn, &found[0].id).unwrap().unwrap().use_count, 1);
    // A question with no project sees no project memory at all.
    let workspace_only = relevant(&conn, Some("w1"), None, "base de datos", false, 2_000).unwrap();
    assert!(workspace_only.iter().all(|m| m.scope != "project"), "{workspace_only:?}");
}

#[test]
fn local_only_memories_stay_away_from_cloud_engines() {
    let conn = db();
    let mut secret = new(Scope::Project, Kind::Fact, "Servidor interno", "La base vive en db.interna.example", true);
    secret.local_only = true;
    create(&conn, secret).unwrap();
    assert!(relevant(&conn, Some("w1"), Some("p1"), "servidor base", true, 2_000).unwrap().is_empty());
    assert_eq!(relevant(&conn, Some("w1"), Some("p1"), "servidor base", false, 2_000).unwrap().len(), 1);
}

#[test]
fn approving_a_replacement_revokes_the_old_one_and_expiry_revokes_too() {
    let conn = db();
    let old = create(&conn, new(Scope::Project, Kind::Decision, "Node 18", "Usamos Node 18.", true)).unwrap();
    let mut newer = new(Scope::Project, Kind::Decision, "Node 22", "Migramos a Node 22.", false);
    newer.supersedes = Some(old.id.clone());
    let newer = create(&conn, newer).unwrap();
    set_status(&conn, &newer.id, "approved").unwrap();
    assert_eq!(get(&conn, &old.id).unwrap().unwrap().status, "revoked");
    assert_eq!(revisions(&conn, &old.id).unwrap()[0].action, "superseded");
    let mut short = new(Scope::Project, Kind::Fact, "Sprint", "Congelado hasta el viernes", true);
    short.expires_at = Some(1);
    let short = create(&conn, short).unwrap();
    expire(&conn).unwrap();
    assert_eq!(get(&conn, &short.id).unwrap().unwrap().status, "revoked");
}

#[test]
fn a_memory_past_its_expiry_never_reaches_a_model() {
    let conn = db();
    let mut short = new(Scope::Project, Kind::Preference, "Congelado", "No se despliega esta semana", true);
    short.expires_at = Some(now() - 1);
    create(&conn, short).unwrap();
    assert!(relevant(&conn, Some("w1"), Some("p1"), "desplegar", false, 2_000).unwrap().is_empty());
}

#[test]
fn edits_are_kept_as_revisions() {
    let conn = db();
    let m = create(&conn, new(Scope::Workspace, Kind::Convention, "Commits", "En inglés", true)).unwrap();
    edit(&conn, &m.id, Patch { body: Some("En español, imperativo".into()), ..Default::default() }).unwrap();
    let history = revisions(&conn, &m.id).unwrap();
    assert_eq!(history[0].action, "edited");
    assert_eq!(history[0].body, "En español, imperativo");
}

#[test]
fn remember_requests_are_read_from_either_language() {
    assert_eq!(remember_request("Recuerda que los commits van en español.").as_deref(), Some("los commits van en español"));
    assert_eq!(remember_request("Listo. Remember that we deploy on Fridays").as_deref(), Some("we deploy on Fridays"));
    assert!(remember_request("no recuerdo qué hace esto").is_none());
    assert!(remember_request("recuerda que x").is_none(), "too short to be a rule");
}

#[test]
fn remembering_a_new_rule_creates_it_approved() {
    let conn = db();
    let (memory, outcome) = remember(&conn, said("los commits van en español")).unwrap();
    assert_eq!(outcome, Remembered::New);
    assert_eq!(memory.status, "approved");
    assert_eq!(memory.kind, "preference");
    assert_eq!(memory.approved_at, Some(memory.created_at), "created approved: approved the moment it was made");
}

#[test]
fn remembering_an_agents_candidate_approves_it_with_the_users_kind() {
    let conn = db();
    let candidate = propose(&conn, agent("Los commits van en español", "Lo vi en el historial")).unwrap().0;
    assert_eq!((candidate.status.as_str(), candidate.kind.as_str()), ("candidate", "fact"));
    let (memory, outcome) = remember(&conn, said("los commits van en español")).unwrap();
    assert_eq!(outcome, Remembered::Approved);
    assert_eq!(memory.id, candidate.id, "the same rule, not a second row");
    assert_eq!(memory.status, "approved");
    assert_eq!(memory.kind, "preference", "the user's word decides what it is");
    assert_eq!(memory.body, "Lo vi en el historial", "an empty body from the chat never wipes one");
    let history = revisions(&conn, &memory.id).unwrap();
    assert_eq!((history[0].action.as_str(), history[0].actor.as_str()), ("approved", "user"));
    assert!(memory.approved_at.is_some());
    let found = relevant(&conn, Some("w1"), Some("p1"), "algo sin relación", false, 2_000).unwrap();
    assert!(found.iter().any(|m| m.id == memory.id), "now it reaches a model");
}

#[test]
fn remembering_an_approved_rule_with_a_new_body_updates_it_with_a_revision() {
    let conn = db();
    let first = remember(&conn, new(Scope::Project, Kind::Convention, "Commits", "En inglés", true)).unwrap().0;
    let (memory, outcome) = remember(&conn, new(Scope::Project, Kind::Convention, "commits", "En español, imperativo", true)).unwrap();
    assert_eq!(outcome, Remembered::Updated);
    assert_eq!(memory.id, first.id);
    assert_eq!(memory.body, "En español, imperativo");
    let history = revisions(&conn, &memory.id).unwrap();
    assert_eq!((history[0].action.as_str(), history[0].body.as_str()), ("edited", "En español, imperativo"));
}

#[test]
fn remembering_the_same_rule_twice_changes_nothing() {
    let conn = db();
    let first = remember(&conn, said("los tests van junto al código")).unwrap().0;
    let before = revisions(&conn, &first.id).unwrap().len();
    let (memory, outcome) = remember(&conn, said("Los tests van junto al código.")).unwrap();
    assert_eq!(outcome, Remembered::AlreadyKnown);
    assert_eq!(memory.id, first.id);
    assert_eq!(revisions(&conn, &first.id).unwrap().len(), before);
    assert_eq!(rows(&conn), 1);
}

#[test]
fn remembering_never_makes_a_local_only_memory_visible_to_the_cloud() {
    let conn = db();
    let mut private = agent("Servidor interno en db.interna.example", "");
    private.local_only = true;
    propose(&conn, private).unwrap();
    let (memory, outcome) = remember(&conn, said("servidor interno en db.interna.example")).unwrap();
    assert_eq!(outcome, Remembered::Approved);
    assert!(memory.local_only);
}

#[test]
fn creating_an_approved_memory_over_a_candidate_approves_the_candidate() {
    // The old bug: `create(approved)` returned the unapproved candidate and the chat said "learned".
    let conn = db();
    let candidate = propose(&conn, agent("Usar pnpm", "")).unwrap().0;
    let memory = create(&conn, said("usar pnpm")).unwrap();
    assert_eq!(memory.id, candidate.id);
    assert_eq!(memory.status, "approved");
}

#[test]
fn proposals_without_a_kind_are_facts_and_the_users_are_preferences() {
    let conn = db();
    assert_eq!(propose(&conn, agent("El build tarda diez minutos", "")).unwrap().0.kind, "fact");
    let mut flow = agent("La API pública es v2", "");
    flow.source = Some("flow".into());
    assert_eq!(create(&conn, flow).unwrap().kind, "fact");
    let mut explicit = agent("Las migraciones se revisan a mano", "");
    explicit.kind = Some(Kind::Convention);
    assert_eq!(propose(&conn, explicit).unwrap().0.kind, "convention", "an explicit kind is kept");
    let user = NewMemory { title: "Responde breve".into(), approved: true, ..Default::default() };
    assert_eq!(create(&conn, user).unwrap().kind, "preference");
}

#[test]
fn approving_lets_the_user_change_the_kind() {
    let conn = db();
    let candidate = propose(&conn, agent("Los endpoints van en kebab-case", "")).unwrap().0;
    approve(&conn, &candidate.id, Some(Kind::Convention)).unwrap();
    let memory = get(&conn, &candidate.id).unwrap().unwrap();
    assert_eq!((memory.status.as_str(), memory.kind.as_str()), ("approved", "convention"));
    let other = propose(&conn, agent("El staging se borra los lunes", "")).unwrap().0;
    approve(&conn, &other.id, None).unwrap();
    assert_eq!(get(&conn, &other.id).unwrap().unwrap().kind, "fact", "no kind given: as it was");
}

#[test]
fn in_scope_matches_are_not_crowded_out_by_matches_elsewhere() {
    let conn = db();
    // Sixty short, strongly matching decisions in another repository — they outrank this one by
    // bm25, and a cap of fifty over every memory used to leave this one out.
    for i in 0..60 {
        let mut elsewhere = new(Scope::Project, Kind::Decision, &format!("Deploy {i}"), "deploy deploy deploy", true);
        elsewhere.project_id = Some("p2".into());
        create(&conn, elsewhere).unwrap();
    }
    let here = create(
        &conn,
        new(Scope::Project, Kind::Decision, "Publicación", "El deploy de este repositorio pasa por Helm, con aprobación manual del equipo de plataforma antes de producción", true),
    )
    .unwrap();
    let found = relevant(&conn, Some("w1"), Some("p1"), "¿cómo hacemos el deploy?", false, 3_000).unwrap();
    assert_eq!(found.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec![here.id.as_str()]);
}

#[test]
fn ties_go_to_the_memory_used_more() {
    let conn = db();
    let rare = create(&conn, new(Scope::Project, Kind::Preference, "Respuestas cortas", "", true)).unwrap();
    let common = create(&conn, new(Scope::Project, Kind::Preference, "Código en inglés", "", true)).unwrap();
    conn.execute("UPDATE ai_memories SET use_count = 9 WHERE id = ?1", params![common.id]).unwrap();
    let found = relevant(&conn, Some("w1"), Some("p1"), "", false, 2_000).unwrap();
    assert_eq!(found.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec![common.id.as_str(), rare.id.as_str()]);
}

#[test]
fn the_note_names_kind_approval_date_and_origin() {
    let conn = db();
    let proposal = propose(&conn, agent("Las ramas se llaman feature/<ticket>", "")).unwrap().0;
    approve(&conn, &proposal.id, Some(Kind::Convention)).unwrap();
    create(&conn, new(Scope::Project, Kind::Preference, "Responde en español", "", true)).unwrap();
    let found = relevant(&conn, Some("w1"), Some("p1"), "", false, 2_000).unwrap();
    let (note, sources) = note(&found).unwrap();
    let today = day(now()).unwrap();
    assert!(note.starts_with("\n\n---\n"), "the MCP recall strips exactly this prefix");
    assert!(note.contains("dilo en vez de suponer"), "{note}");
    assert!(note.contains(&format!("- [convención · aprobada {today} · origen: agente] Las ramas se llaman feature/<ticket>")), "{note}");
    assert!(note.contains(&format!("- [preferencia · aprobada {today}] Responde en español")), "the user's own needs no origin: {note}");
    assert_eq!(sources.len(), 2);
}

#[test]
fn unused_memories_are_flagged_stale_without_being_deleted() {
    let conn = db();
    let old = create(&conn, new(Scope::Project, Kind::Preference, "Usar tabs", "", true)).unwrap();
    age(&conn, &old.id, STALE_DAYS + 10);
    let fresh = create(&conn, new(Scope::Project, Kind::Preference, "Usar comillas dobles", "", true)).unwrap();
    let pending = propose(&conn, agent("Algo viejo propuesto", "")).unwrap().0;
    age(&conn, &pending.id, STALE_DAYS + 10);
    assert!(get(&conn, &old.id).unwrap().unwrap().stale);
    assert!(!get(&conn, &fresh.id).unwrap().unwrap().stale);
    assert!(!get(&conn, &pending.id).unwrap().unwrap().stale, "only approved memories are reviewed for use");
    let stale = list(&conn, &Filter { project_id: Some("p1".into()), stale: true, ..Default::default() }).unwrap();
    assert_eq!(stale.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec![old.id.as_str()]);
    // Used again: no longer stale. And nothing was ever deleted.
    relevant(&conn, Some("w1"), Some("p1"), "", false, 2_000).unwrap();
    assert!(!get(&conn, &old.id).unwrap().unwrap().stale);
    assert_eq!(rows(&conn), 3);
}

#[test]
fn near_duplicate_proposals_fold_into_the_existing_one_as_evidence() {
    let conn = db();
    let mut first = agent("Usar pnpm en CI", "Los workflows instalan con pnpm");
    first.evidence = vec!["run:1".into()];
    let first = propose(&conn, first).unwrap().0;
    // A title that contains the other's as a phrase.
    let mut longer = agent("Usar pnpm en CI siempre", "");
    longer.evidence = vec!["run:2".into()];
    let (memory, outcome) = propose(&conn, longer).unwrap();
    assert_eq!((memory.id.as_str(), outcome), (first.id.as_str(), Remembered::AlreadyKnown));
    assert_eq!(memory.evidence, vec!["run:1".to_string(), "run:2".to_string()]);
    let history = revisions(&conn, &first.id).unwrap();
    assert_eq!((history[0].action.as_str(), history[0].title.as_str(), history[0].actor.as_str()), ("proposed", "Usar pnpm en CI siempre", "agent"));
    // The same body under another title.
    let same_body = propose(&conn, agent("Instalación", "los workflows instalan con PNPM.")).unwrap().0;
    assert_eq!(same_body.id, first.id);
    // Proposed again word for word: no new revision.
    let before = revisions(&conn, &first.id).unwrap().len();
    propose(&conn, agent("Usar pnpm en CI", "Los workflows instalan con pnpm")).unwrap();
    assert_eq!(revisions(&conn, &first.id).unwrap().len(), before);
    assert_eq!(rows(&conn), 1);
}

#[test]
fn similar_titles_about_different_things_stay_apart() {
    let conn = db();
    let a = propose(&conn, agent("Cuidado al cambiar src/pay.ts", "")).unwrap().0;
    let b = propose(&conn, agent("Cuidado al cambiar src/pay.tsx", "")).unwrap().0;
    let c = propose(&conn, agent("Tests", "")).unwrap().0;
    let d = propose(&conn, agent("Tests de integración lentos", "")).unwrap().0;
    assert_ne!(a.id, b.id, "a different file is a different word");
    assert_ne!(c.id, d.id, "a one-word title is too short to be a phrase of another");
    // Another repository's memory is not a duplicate either.
    let mut elsewhere = agent("Cuidado al cambiar src/pay.ts", "");
    elsewhere.project_id = Some("p2".into());
    assert_ne!(propose(&conn, elsewhere).unwrap().0.id, a.id);
}

#[test]
fn the_pane_pages_a_workspace_with_its_global_memories() {
    let conn = db();
    create(&conn, NewMemory { scope: Some(Scope::Global), title: "Global uno".into(), approved: true, ..Default::default() }).unwrap();
    for title in ["Espacio uno", "Espacio dos"] {
        create(&conn, new(Scope::Workspace, Kind::Convention, title, "", true)).unwrap();
    }
    for title in ["Repo uno", "Repo dos"] {
        create(&conn, new(Scope::Project, Kind::Decision, title, "", true)).unwrap();
    }
    propose(&conn, agent("Repo propuesta", "")).unwrap();
    let mut other = new(Scope::Workspace, Kind::Convention, "Otro espacio", "", true);
    other.workspace_id = Some("w2".into());
    create(&conn, other).unwrap();

    let all = Filter { workspace_id: Some("w1".into()), include_global: true, limit: Some(4), ..Default::default() };
    let first = page(&conn, &all).unwrap();
    assert_eq!((first.rows.len(), first.total, first.candidates, first.stale), (4, 6, 1, 0));
    assert_eq!(first.rows[0].status, "candidate", "proposals first");
    let second = page(&conn, &Filter { offset: Some(4), ..all.clone() }).unwrap();
    assert_eq!(second.rows.len(), 2);
    assert!(second.rows.iter().all(|m| !first.rows.iter().any(|f| f.id == m.id)), "pages do not overlap");
    assert!(first.rows.iter().chain(&second.rows).all(|m| m.title != "Otro espacio"), "another workspace's stays out");

    let repo = page(&conn, &Filter { project_id: Some("p1".into()), status: Some("approved".into()), ..Default::default() }).unwrap();
    assert_eq!((repo.total, repo.candidates), (2, 1), "the chip counts the place's proposals whatever the status filter");
    let global = page(&conn, &Filter { scope: Some("global".into()), ..Default::default() }).unwrap();
    assert_eq!(global.total, 1);
}

#[test]
fn replacing_an_approved_memory_from_the_pane_revokes_the_old_one_at_once() {
    let conn = db();
    let old = create(&conn, new(Scope::Project, Kind::Decision, "Node 18", "", true)).unwrap();
    let newer = create(&conn, new(Scope::Project, Kind::Decision, "Node 22", "", true)).unwrap();
    assert!(edit(&conn, &newer.id, Patch { supersedes: Some(newer.id.clone()), ..Default::default() }).is_err(), "not itself");
    assert!(edit(&conn, &newer.id, Patch { supersedes: Some("nope".into()), ..Default::default() }).is_err(), "not a memory that does not exist");
    let edited = edit(&conn, &newer.id, Patch { supersedes: Some(old.id.clone()), expires_at: Some(now() + DAY_MS), local_only: Some(true), kind: Some(Kind::Fact), ..Default::default() }).unwrap();
    assert_eq!(edited.supersedes.as_deref(), Some(old.id.as_str()));
    assert_eq!(edited.supersedes_title.as_deref(), Some("Node 18"), "the pane names what it replaces");
    assert!(edited.local_only && edited.expires_at.is_some() && edited.kind == "fact");
    assert_eq!(get(&conn, &old.id).unwrap().unwrap().status, "revoked");
    let cleared = edit(&conn, &newer.id, Patch { clear_supersedes: true, clear_expiry: true, ..Default::default() }).unwrap();
    assert!(cleared.supersedes.is_none() && cleared.expires_at.is_none());
}

#[test]
fn repeated_reverts_propose_a_candidate() {
    let conn = db();
    for i in 0..3 {
        crate::experiences::record(
            &conn,
            crate::experiences::NewExperience {
                workspace_id: Some("w1".into()),
                project_id: Some("p1".into()),
                source: Some(crate::experiences::Source::CheckpointRestore),
                signal: Some(crate::experiences::Signal::Reverted),
                run_ref: Some(format!("checkpoint:{i}")),
                detail: serde_json::json!({ "paths": ["src/pay.ts"] }),
                ..Default::default()
            },
        )
        .unwrap();
    }
    let proposed = propose_from_experiences(&conn, "w1").unwrap();
    assert_eq!(proposed.len(), 1);
    assert_eq!(proposed[0].status, "candidate");
    assert_eq!(proposed[0].kind, "fact", "a warning about one file is not an always-on rule");
    assert!(proposed[0].body.contains("src/pay.ts"));
    assert_eq!(proposed[0].evidence.len(), 3);
    assert!(proposed[0].evidence.iter().all(|e| e.starts_with("experience:")));
    // Asked again: nothing new, still one row.
    assert!(propose_from_experiences(&conn, "w1").unwrap().is_empty());
    assert_eq!(rows(&conn), 1);
}
