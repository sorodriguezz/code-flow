use super::*;

#[tokio::test]
async fn a_run_will_not_deliver_to_a_locked_branch() {
    let (_serial, _dir, db, ws, project, [lead, dev, _qa]) = fixture();
    let repo = with(&db, |c| Ok(queries::get_project(c, &project).unwrap().unwrap().local_path)).unwrap();
    sh(&repo, &["config", "branch.main.codeflowLocked", "true"]);
    let member = |id: &str, agent: &str| team::Member { id: id.into(), agent_id: agent.into(), name: id.into(), edits: true, ..Default::default() };
    let tm = with(&db, |c| {
        team::save_team(c, team::Team { workspace_id: ws.clone(), name: "Equipo".into(), lead: "l".into(), members: vec![member("l", &lead), member("d", &dev)], ..Default::default() })
    })
    .unwrap();
    let err = start_run(&db, ws.clone(), tm.id.clone(), "x".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: "main".into() }], None, None).await.unwrap_err();
    assert!(err.contains("bloqueada"), "{err}");
}

#[test]
fn session_use_counts_from_the_start_and_across_a_rollover() {
    assert_eq!(session_used((40.0, "100"), (55.0, "100")), 15.0);
    assert_eq!(session_used((40.0, "100"), (30.0, "100")), 0.0);
    // The window rolled over: the 60 points left of the old one, plus 10 of the new.
    assert_eq!(session_used((40.0, "100"), (10.0, "18100")), 70.0);
    // A reset instant that jitters between reads is the same window, not a rollover.
    assert_eq!(session_used((40.0, "2026-11-04T20:00:00+00:00"), (41.0, "2026-11-04T20:00:07+00:00")), 1.0);
    assert_eq!(session_used((40.0, "2026-11-04T20:00:00+00:00"), (40.0, "2026-11-04T20:00:03+00:00")), 0.0);
}
use std::path::Path;

pub(crate) fn sh(dir: &str, args: &[&str]) {
    let out = crate::git::cli::run_in(dir, args, &[]).unwrap();
    assert!(out.success, "git {args:?}: {}", out.detail());
}

pub(crate) struct Dir(pub(crate) std::path::PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The worktree root is process-wide: tests that set it take turns.
static SERIAL: Mutex<()> = Mutex::new(());

pub(crate) fn fixture() -> (std::sync::MutexGuard<'static, ()>, Dir, Db, String, String, [String; 3]) {
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir(std::env::temp_dir().join(format!("cf-teamrun-{}", uuid::Uuid::new_v4())));
    let repo = dir.0.join("repo").to_string_lossy().into_owned();
    std::fs::create_dir_all(&repo).unwrap();
    sh(&repo, &["init", "-q", "-b", "main"]);
    sh(&repo, &["config", "user.email", "t@example.com"]);
    sh(&repo, &["config", "user.name", "T"]);
    std::fs::write(Path::new(&repo).join("README.md"), "hola\n").unwrap();
    sh(&repo, &["add", "-A"]);
    sh(&repo, &["commit", "-q", "-m", "init"]);
    // `main` is locked by the app's default rules; these runs deliver to it on purpose.
    // Pinned in the repo's own config rather than through `set_branch_locked`, which writes
    // nothing when the shared rule list (other tests change it) happens to agree.
    sh(&repo, &["config", "branch.main.codeflowLocked", "false"]);
    *WORKTREE_ROOT.lock().unwrap() = Some(dir.0.join("worktrees"));

    let conn = Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&conn).unwrap();
    let ws = queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
    let project: crate::db::models::NewProject = serde_json::from_value(serde_json::json!({
        "workspace_id": ws.id, "name": "web", "local_path": repo, "remote_url": null, "color": "#fff", "icon": "folder"
    }))
    .unwrap();
    let project = queries::create_project(&conn, project).unwrap();
    let lead = queries::upsert_workspace_agent(&conn, None, &ws.id, "Líder", "lidera", "claude", "sonnet", "", true, None).unwrap();
    let dev = queries::upsert_workspace_agent(&conn, None, &ws.id, "Dev", "programa", "claude", "sonnet", "", true, None).unwrap();
    let qa = queries::upsert_workspace_agent(&conn, None, &ws.id, "QA", "revisa", "claude", "haiku", "", true, None).unwrap();
    let ids = [lead.id, dev.id, qa.id];
    (serial, dir, Db::new(conn), ws.id, project.id, ids)
}

pub(crate) fn item_of<'a>(state: &'a RunState, key: &str) -> &'a Item {
    state.items.iter().find(|i| i.key == key).unwrap_or_else(|| panic!("no item {key}: {:?}", state.items.iter().map(|i| &i.key).collect::<Vec<_>>()))
}

#[tokio::test]
async fn an_amendment_keeps_completed_work_and_rewires_pending_tasks_only_after_approval() {
    let (_serial, _dir, db, ws, project, [lead_id, dev_id, _]) = fixture();
    let make = |id: &str, agent_id: String| MemberSnap {
        member: team::Member { id: id.into(), name: id.into(), agent_id, ..Default::default() },
        provider: "claude".into(), model: "sonnet".into(), ..Default::default()
    };
    let run = Run {
        id: "amend-test".into(), workspace_id: ws, status: "running".into(), lead: "lead".into(),
        goal: "Build endpoint".into(), members: vec![make("lead", lead_id), make("dev", dev_id)],
        policy: Policy { max_session_pct: 0, ..Default::default() }, ..Default::default()
    };
    let mut initial = team::new_item(&run, "plan", run.members.first(), &project, "plan", "Initial plan", "");
    initial.status = "done".into();
    let mut finished = team::new_item(&run, "finished", run.members.get(1), &project, "investigate", "Finished", "");
    finished.status = "done".into();
    let worker = team::new_item(&run, "old", run.members.get(1), &project, "work", "Old rule", "");
    let mut downstream = team::new_item(&run, "next", run.members.get(1), &project, "work", "Tests", "");
    downstream.depends_on.push(worker.id.clone());
    with(&db, |conn| {
        team::insert_run(conn, &run).map_err(e2s)?;
        let root = queries::get_project(conn, &project).map_err(e2s)?.unwrap().local_path;
        team::insert_repo(conn, &RunRepo { run_id: run.id.clone(), project_id: project.clone(), name: "web".into(), integration_path: root, ..Default::default() }).map_err(e2s)?;
        for item in [&initial, &finished, &worker, &downstream] {
            team::insert_item(conn, item).map_err(e2s)?;
        }
        Ok(())
    }).unwrap();
    request_amendment(&db, &run.id, "Guests now receive 403").await.unwrap();
    let dispatch = claim(&db, &run.id).await.unwrap();
    assert_eq!(dispatch.len(), 1);
    assert_eq!(dispatch[0].item.kind, "amend");
    let proposal = r#"Se conserva la investigación y se ajusta el trabajo pendiente.
```equipo
{"mensaje":"Repetir las pruebas de acceso","items":[{"id":"new","miembro":"dev","repo":"web","tarea":"Guests receive 403","reemplaza":"old"}]}
```"#;
    let proposed = settle_core(&db, &dispatch[0].item.id, "ok", proposal, "").await.unwrap();
    assert!(proposed.run.gate.starts_with("amend:"));
    assert_eq!(item_of(&proposed, "old").status, "pending");
    assert_eq!(item_of(&proposed, "next").depends_on, vec![worker.id]);
    assert!(decide_for_gate(&db, &run.id, true, "", Some("merge")).await.is_err());
    let rejected = decide_for_gate(&db, &run.id, false, "", Some(&proposed.run.gate)).await.unwrap();
    assert_eq!(item_of(&rejected, "old").status, "pending");
    assert_eq!(rejected.run.goal, run.goal);
    request_amendment(&db, &run.id, "Guests now receive 403").await.unwrap();
    let dispatch = claim(&db, &run.id).await.unwrap();
    let proposed = settle_core(&db, &dispatch[0].item.id, "ok", proposal, "").await.unwrap();
    let approved = decide_for_gate(&db, &run.id, true, "", Some(&proposed.run.gate)).await.unwrap();
    assert_eq!(item_of(&approved, "finished").status, "done");
    assert_eq!(item_of(&approved, "old").status, "skipped");
    assert_eq!(item_of(&approved, "next").depends_on, vec![item_of(&approved, "new").id.clone()]);
    assert!(approved.run.goal.contains("Guests now receive 403"));
}

#[test]
fn impact_fingerprints_include_untracked_migrations_and_the_pr_uses_real_commits() {
    let (_serial, _dir, db, _, project, _) = fixture();
    let root = with(&db, |conn| Ok(queries::get_project(conn, &project).map_err(e2s)?.unwrap().local_path)).unwrap();
    let base = gitops::head_sha(&root).unwrap();
    assert!(gitops::inspect_impact(&root, &base, &[]).unwrap().is_none());
    sh(&root, &["checkout", "-qb", "team-draft"]);
    std::fs::create_dir(std::path::Path::new(&root).join("migrations")).unwrap();
    let migration = std::path::Path::new(&root).join("migrations/001.sql");
    std::fs::write(&migration, "CREATE TABLE sample (id INT);\n").unwrap();
    let first = gitops::inspect_impact(&root, &base, &[]).unwrap().unwrap();
    let first_work = gitops::work_fingerprint(&root, &base).unwrap();
    assert_eq!(first.files, vec!["migrations/001.sql"]);
    assert!(first.diff.contains("CREATE TABLE"));
    std::fs::write(&migration, "CREATE TABLE sample (id BIGINT);\n").unwrap();
    assert_ne!(gitops::inspect_impact(&root, &base, &[]).unwrap().unwrap().version, first.version);
    assert_ne!(gitops::work_fingerprint(&root, &base).unwrap(), first_work);
    sh(&root, &["add", "-A"]);
    sh(&root, &["commit", "-qm", "Add migration"]);
    assert!(gitops::pr_commits(&root, "main", "team-draft").unwrap().contains("Add migration"));
    assert!(gitops::pr_commits(&root, "main", "main").unwrap().is_empty());
}

#[tokio::test]
async fn an_impact_approval_cannot_be_reused_for_an_edited_diff() {
    let (_serial, _dir, db, ws, project, _) = fixture();
    let root = with(&db, |conn| Ok(queries::get_project(conn, &project).map_err(e2s)?.unwrap().local_path)).unwrap();
    let base = gitops::head_sha(&root).unwrap();
    let run = Run {
        id: "impact-test".into(), workspace_id: ws, status: "running".into(),
        policy: Policy { impact_approval: true, ..Default::default() }, ..Default::default()
    };
    let mut item = team::new_item(&run, "impact", None, &project, "work", "Migration", "");
    item.status = "running".into();
    item.worktree_path = root.clone();
    item.intelligence.base_sha = base.clone();
    with(&db, |conn| {
        team::insert_run(conn, &run).map_err(e2s)?;
        team::insert_repo(conn, &RunRepo { run_id: run.id.clone(), project_id: project, status: "ready".into(), integration_path: root.clone(), ..Default::default() }).map_err(e2s)?;
        team::insert_item(conn, &item).map_err(e2s)
    }).unwrap();
    let migration = std::path::Path::new(&root).join("migrations/001.sql");
    std::fs::create_dir(migration.parent().unwrap()).unwrap();
    std::fs::write(&migration, "CREATE TABLE sample (id INT);\n").unwrap();
    let initial = settle_core(&db, &item.id, "ok", "Migration ready", "").await.unwrap();
    assert!(initial.run.gate.starts_with("impact:"));
    assert_eq!(gitops::head_sha(&root).unwrap(), base);
    std::fs::write(&migration, "CREATE TABLE sample (id BIGINT);\n").unwrap();
    let changed = decide_for_gate(&db, &run.id, true, "", Some(&initial.run.gate)).await.unwrap();
    assert!(changed.run.gate.starts_with("impact:"));
    assert_ne!(changed.run.gate, initial.run.gate);
    assert!(decide_for_gate(&db, &run.id, true, "", Some(&initial.run.gate)).await.is_err());
    assert_eq!(gitops::head_sha(&root).unwrap(), base);
}

#[tokio::test]
async fn provider_quota_parks_only_the_matching_route_and_preserves_the_run() {
    let (_serial, _dir, db, ws, project, _) = fixture();
    let make = |id: &str, provider: &str, model: &str| MemberSnap {
        member: team::Member { id: id.into(), name: id.into(), ..Default::default() },
        provider: provider.into(), model: model.into(), ..Default::default()
    };
    let run = Run {
        id: "quota-test".into(), workspace_id: ws, status: "running".into(), dispatches: 1,
        policy: Policy { max_session_pct: 0, ..Default::default() },
        members: vec![make("first", "claude", "sonnet"), make("second", "codex", "gpt"), make("third", "claude", "sonnet")],
        ..Default::default()
    };
    let mut first = team::new_item(&run, "first", run.members.first(), &project, "investigate", "First", "Read");
    first.status = "running".into();
    first.attempts = 1;
    let second = team::new_item(&run, "second", run.members.get(1), &project, "investigate", "Second", "Read");
    let third = team::new_item(&run, "third", run.members.get(2), &project, "investigate", "Third", "Read");
    with(&db, |conn| {
        team::insert_run(conn, &run).map_err(e2s)?;
        let project_row = queries::get_project(conn, &project).map_err(e2s)?.unwrap();
        team::insert_repo(conn, &RunRepo {
            run_id: run.id.clone(), project_id: project.clone(), integration_path: project_row.local_path,
            ..Default::default()
        }).map_err(e2s)?;
        for item in [&first, &second, &third] {
            team::insert_item(conn, item).map_err(e2s)?;
        }
        Ok(())
    }).unwrap();
    let until = chrono::Utc::now().timestamp() + 600;
    let state = settle_core(&db, &first.id, "error", "", &format!("QUOTA_EXCEEDED::Claude AI usage limit reached|{until}")).await.unwrap();
    assert_eq!(state.run.status, "running");
    assert_eq!(state.run.dispatches, 0);
    assert_eq!(item_of(&state, "first").intelligence.recovery.as_ref().unwrap().resume_at, Some(until + 5));
    let dispatches = claim(&db, &run.id).await.unwrap();
    assert_eq!(dispatches.iter().map(|dispatch| dispatch.item.key.as_str()).collect::<Vec<_>>(), vec!["second"]);
    with(&db, |conn| {
        for id in [&first.id, &third.id] {
            let mut item = team::get_item(conn, id).map_err(e2s)?.unwrap();
            assert_eq!(item.status, "waiting");
            item.intelligence.recovery.as_mut().unwrap().resume_at = Some(until - 601);
            team::update_item(conn, &item).map_err(e2s)?;
        }
        Ok(())
    }).unwrap();
    let resumed = claim(&db, &run.id).await.unwrap();
    assert_eq!(resumed.iter().map(|dispatch| dispatch.item.key.as_str()).collect::<Vec<_>>(), vec!["first", "third"]);
    assert_eq!(resumed[0].item.attempts, 1);
}

#[tokio::test]
async fn checks_distinguish_regressions_from_the_same_baseline_failure() {
    let (_serial, _dir, db, _, project, _) = fixture();
    let root = with(&db, |conn| Ok(queries::get_project(conn, &project).map_err(e2s)?.unwrap().local_path)).unwrap();
    let base = gitops::head_sha(&root).unwrap();
    let repo = RunRepo { local_path: root.clone(), name: "web".into(), ..Default::default() };
    std::fs::write(std::path::Path::new(&root).join("README.md"), "changed").unwrap();
    let run = Run::default();
    let at = CheckAt { run: &run, project_id: &project, slot: "t" };
    let regression = verify_check(&db, &at, "git diff --exit-code -- README.md", &root, Some(&repo), &base).await.unwrap();
    assert_eq!(regression.result, "regression", "{}", regression.detail);
    assert!(regression.sandbox.is_empty(), "a team that did not ask for isolation is checked on this computer");
    let existing = verify_check(&db, &at, "git rev-parse --verify refs/heads/codeflow-test-absent", &root, Some(&repo), &base).await.unwrap();
    assert_eq!(existing.result, "preexisting", "{}", existing.detail);
}

/// Answers «is there a container engine» for one test, and gives the machine's own answer back
/// when it ends.
struct Engine;
impl Engine {
    fn set(there: bool) -> Self {
        *team::sandbox::FORCED.lock().unwrap_or_else(|e| e.into_inner()) = Some(there);
        Engine
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        *team::sandbox::FORCED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[tokio::test]
async fn checks_that_must_run_isolated_never_fall_back_to_this_computer_on_their_own() {
    let (_serial, _dir, db, ws, project, [_, dev, _]) = fixture();
    let _engine = Engine::set(false);
    let policy = Policy {
        approve_merge: false,
        sandbox: "checks".into(),
        checks: vec![team::Check { repo: "*".into(), command: "touch ran-on-this-computer".into(), when: "item".into(), kind: "unit".into(), ..Default::default() }],
        ..Default::default()
    };
    let tm = solo_team(&db, &ws, &dev, policy);
    let state = start_run(&db, ws, tm.id, "haz uno".into(), None, vec![RepoPick { project_id: project, target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let cwd = d[0].cwd.clone();
    std::fs::write(Path::new(&cwd).join("uno.txt"), "x\n").unwrap();

    // No engine: the work is not failed, not passed, and not checked on the host. It waits.
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.", "").await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!((item.status.as_str(), item.attempts), ("gated", 1), "{}", item.last_error);
    assert_eq!((state.run.status.as_str(), state.run.gate.clone()), ("gated", format!("sandbox:{}", item.id)));
    assert!(state.run.gate_note.contains("no responde") || state.run.gate_note.contains("motor"), "{}", state.run.gate_note);
    assert!(!Path::new(&cwd).join("ran-on-this-computer").exists(), "nothing ran on the host");
    assert!(item.commit_sha.is_empty());

    // «Try again, isolated» with the engine still gone: it waits again, at no cost to the member.
    let state = decide(&db, &run_id, true, "").await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!((item.status.as_str(), item.attempts, state.run.gate.clone()), ("gated", 1, format!("sandbox:{}", item.id)));
    assert!(!Path::new(&cwd).join("ran-on-this-computer").exists());

    // The user lets this run check on this computer: it does, and the channel keeps who said so.
    let state = decide(&db, &run_id, false, "").await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!(item.status, "done", "{}", item.last_error);
    assert_eq!(state.run.policy.sandbox, "off");
    assert!(item.intelligence.sandbox_hold.is_empty());
    assert!(item.intelligence.evidence.iter().any(|e| e.source == "check" && e.result == "passed" && e.sandbox.is_empty()));
    assert!(state.messages.iter().any(|m| m.kind == "decision" && m.body.contains("sin aislamiento")));
    assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
}

#[tokio::test]
async fn a_small_request_skips_the_advisor_and_the_lead_s_last_look() {
    let (_serial, _dir, db, ws, project, [lead, dev, adv]) = fixture();
    let member = |id: &str, agent: &str, name: &str, edits: bool, advisor: bool| team::Member {
        id: id.into(),
        agent_id: agent.into(),
        name: name.into(),
        edits,
        advisor,
        max_parallel: 1,
        ..Default::default()
    };
    let mut policy = Policy { single_pass: false, ..Default::default() };
    policy.approve_plan = false;
    policy.approve_merge = false;
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy,
                members: vec![member("l", &lead, "Líder", false, false), member("d", &dev, "Dev", true, false), member("a", &adv, "Asesor", false, true)],
                ..Default::default()
            },
        )
    })
    .unwrap();
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Cambia el color del botón".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(d[0].message.contains("\"chico\""), "the lead is told it can say so");
    let plan = "Es chico.\n```equipo\n{\"items\":[{\"id\":\"color\",\"miembro\":\"dev\",\"tarea\":\"cambia el color\"}],\"chico\":true}\n```";
    settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();

    // Straight to the dev: no advisor reading the plan.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.key, "color");
    std::fs::write(Path::new(&d[0].cwd).join("boton.css"), "button { color: red }\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();

    // Delivered, merged and landed: no last look of the lead's, no advisor before finishing.
    assert_eq!(state.run.status, "done", "{}", state.run.last_reason);
    assert!(state.items.iter().all(|i| i.kind != "advise" && i.kind != "final"), "{:?}", state.items.iter().map(|i| &i.kind).collect::<Vec<_>>());
    assert!(claim(&db, &run_id).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_run_that_opens_a_pr_publishes_its_branch_and_waits_when_the_host_refuses() {
    let (_serial, dir, db, ws, project, [lead, dev, _]) = fixture();
    let repo = with(&db, |c| Ok(queries::get_project(c, &project).unwrap().unwrap().local_path)).unwrap();
    let origin = dir.0.join("origin.git").to_string_lossy().into_owned();
    sh(&dir.0.to_string_lossy(), &["init", "-q", "--bare", &origin]);
    sh(&repo, &["remote", "add", "origin", &origin]);
    sh(&repo, &["push", "-q", "origin", "main"]);
    let member = |id: &str, agent: &str, edits: bool| team::Member { id: id.into(), agent_id: agent.into(), name: id.into(), edits, max_parallel: 1, ..Default::default() };
    let unit = team::Check { repo: project.clone(), command: "true".into(), when: "agent".into(), kind: "unit".into(), write: true, ..Default::default() };
    let policy = Policy { single_pass: false, approve_plan: false, approve_merge: false, integrate: "pr".into(), checks: vec![unit], ..Default::default() };
    let tm = with(&db, |c| {
        team::save_team(c, team::Team { workspace_id: ws.clone(), name: "Equipo".into(), lead: "l".into(), policy, members: vec![member("l", &lead, false), member("d", &dev, true)], ..Default::default() })
    })
    .unwrap();
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Cambia el color del botón".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: "main".into() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(d[0].message.contains("· pruebas: Pruebas unitarias (`true`, se escriben)"), "the lead sees the repository's suites");
    let plan = "```equipo\n{\"items\":[{\"id\":\"color\",\"miembro\":\"d\",\"tarea\":\"cambia el color\"}],\"chico\":true}\n```";
    settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(d[0].message.contains("## Pruebas de este repositorio\n- Pruebas unitarias: `true` — la corres tú"), "the member is told what to run and write");
    std::fs::write(Path::new(&d[0].cwd).join("boton.css"), "button { color: red }\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();

    // The repository is linked to no host, so the pull request cannot open: the run waits at
    // the integration question with the reason, and the branch is already on origin.
    assert_eq!((state.run.status.as_str(), state.run.gate.as_str()), ("gated", "merge"), "{}", state.run.last_reason);
    assert!(state.run.gate_note.contains("no se pudo abrir el PR"), "{}", state.run.gate_note);
    let r = &state.repos[0];
    assert_eq!(r.status, "failed");
    assert!(!r.last_error.is_empty());
    let remote = crate::git::cli::run_in(&origin, &["rev-parse", "--verify", &format!("refs/heads/{}", r.integration_branch)], &[]).unwrap();
    assert!(remote.success, "the team's branch was published: {}", remote.detail());
    let main = crate::git::cli::run_in(&repo, &["log", "--format=%s", "main"], &[]).unwrap().stdout;
    assert!(!main.contains("color"), "nothing landed on main: {main}");

    let body = pr_body(&state, r, "## Objetivo\nx");
    assert!(body.contains("Abierto por el equipo «Equipo» de CodeFlow."), "{body}");
    assert!(!body.contains("Otros repositorios"), "one repository, nothing to point at: {body}");
}

#[test]
fn a_failure_the_repository_already_had_blocks_only_when_the_team_asks_to_fix_it() {
    let ignore = Policy::default();
    assert_eq!(ignore.baseline_failures, "ignore");
    let fix = Policy { baseline_failures: "fix".into(), ..Default::default() };
    assert!(check_passes(&ignore, "passed") && check_passes(&fix, "passed"));
    assert!(check_passes(&ignore, "preexisting"));
    assert!(!check_passes(&fix, "preexisting"));
    for result in ["regression", "failed"] {
        assert!(!check_passes(&ignore, result) && !check_passes(&fix, result), "what the change broke blocks: {result}");
    }
    assert_eq!(Policy { baseline_failures: "otro".into(), ..Default::default() }.sane().baseline_failures, "ignore");
}

#[test]
fn a_team_nobody_set_up_gets_the_detected_suites_and_runs_only_the_fast_ones() {
    let root = std::env::temp_dir().join(format!("cf-auto-suites-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"vitest run","test:integration":"vitest -c int","test:e2e":"playwright test"}}"#).unwrap();
    let path = root.to_string_lossy().into_owned();
    let run = Run { policy: Policy::default(), ..Default::default() };
    assert!(run.policy.auto_checks, "on for new teams");
    let suites = suites_for(&run, "p1", &path);
    let found: Vec<(&str, &str)> = suites.iter().map(|c| (c.kind.as_str(), c.when.as_str())).collect();
    assert_eq!(found, vec![("unit", "item"), ("integration", "agent"), ("e2e", "agent")], "unattended, integration is only told");
    assert!(suites.iter().all(|c| c.repo == "p1"));

    // What the user set up for the repository replaces the detection.
    let mine = team::Check { repo: "p1".into(), command: "make check".into(), when: "final".into(), ..Default::default() };
    let run = Run { policy: Policy { checks: vec![mine.clone()], ..Default::default() }, ..Default::default() };
    assert_eq!(suites_for(&run, "p1", &path), vec![mine]);
    assert_eq!(suites_for(&run, "p2", &path).len(), 3, "another repository still gets its own");
    let off = Run { policy: Policy { auto_checks: false, ..Default::default() }, ..Default::default() };
    assert!(suites_for(&off, "p1", &path).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_plan_called_small_that_spreads_work_runs_as_a_normal_one() {
    let plan_of = |members: &[&str], repos: &[&str]| -> Vec<Item> {
        members.iter().zip(repos).map(|(m, r)| Item { member_id: m.to_string(), project_id: r.to_string(), kind: "work".into(), ..Default::default() }).collect()
    };
    assert!(is_small(&plan_of(&["d"], &["p1"])));
    assert!(is_small(&plan_of(&["d", "d"], &["p1", "p2"])), "one task in each repository that changes");
    assert!(is_small(&plan_of(&["d", "q"], &["p1", "p2"])), "two members, one task per repository");
    assert!(!is_small(&plan_of(&["a", "b", "c", "d"], &["p1", "p2", "p3", "p4"])), "too many tasks");
    assert!(!is_small(&plan_of(&["d", "d"], &["p1", "p1"])), "two tasks in one repository");
    assert!(!is_small(&[]));
}

#[tokio::test]
async fn a_led_team_plans_works_in_parallel_reviews_and_lands_on_main() {
    let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
    let member = |id: &str, agent: &str, name: &str, edits: bool| team::Member {
        id: id.into(),
        agent_id: agent.into(),
        name: name.into(),
        edits,
        max_parallel: 2,
        ..Default::default()
    };
    let mut policy = Policy { single_pass: false, ..Default::default() };
    policy.review = team::ReviewPolicy { enabled: true, reviewer: "q".into(), ..Default::default() };
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy,
                members: vec![member("l", &lead, "Líder", false), member("d", &dev, "Dev", true), member("q", &qa, "QA", false)],
                ..Default::default()
            },
        )
    })
    .unwrap();

    let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea a, b y c".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    assert_eq!(state.repos[0].target_branch, "main");
    let integ = state.repos[0].integration_path.clone();
    assert!(Path::new(&integ).join("README.md").exists());

    // The lead plans: a and b in parallel, c after both.
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.kind, "plan");
    assert_eq!(d[0].cwd, integ);
    assert!(d[0].message.contains("**Dev**"));
    let plan = "Reparto.\n```equipo\n{\"mensaje\":\"a y b a la vez\",\"items\":[\
        {\"id\":\"a\",\"miembro\":\"dev\",\"tarea\":\"crea a.txt\"},\
        {\"id\":\"b\",\"miembro\":\"Dev\",\"tarea\":\"crea b.txt\"},\
        {\"id\":\"c\",\"miembro\":\"dev\",\"tarea\":\"crea c.txt\",\"depende_de\":[\"a\",\"b\"]}]}\n```";
    let state = settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    assert_eq!(state.run.status, "gated");
    assert_eq!(state.run.gate, "plan");
    assert!(claim(&db, &run_id).await.unwrap().is_empty(), "nothing starts before the plan is approved");
    decide(&db, &run_id, true, "").await.unwrap();

    // a and b at once, each in its own worktree.
    let d = claim(&db, &run_id).await.unwrap();
    let keys: Vec<&str> = d.iter().map(|x| x.item.key.as_str()).collect();
    assert_eq!(keys, vec!["a", "b"]);
    assert_ne!(d[0].cwd, d[1].cwd);
    for x in &d {
        std::fs::write(Path::new(&x.cwd).join(format!("{}.txt", x.item.key)), "x\n").unwrap();
    }
    settle_core(&db, &d[0].item.id, "ok", "Hecho a.\n```equipo\n{\"para\":\"qa\",\"texto\":\"mira a.txt\"}\n```", "").await.unwrap();
    let state = settle_core(&db, &d[1].item.id, "ok", "Hecho b.", "").await.unwrap();
    assert!(!item_of(&state, "a").commit_sha.is_empty());
    assert!(state.messages.iter().any(|m| m.kind == "note" && m.to_name == "QA"));

    // QA reviews both, read only; one is sent back once.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 2);
    assert!(d.iter().all(|x| x.item.kind == "review"));
    assert!(d.iter().any(|x| x.message.contains("mira a.txt")), "the note reaches the reviewer");
    let rev_a = d.iter().find(|x| x.item.key == "a-rev").unwrap();
    let rev_b = d.iter().find(|x| x.item.key == "b-rev").unwrap();
    settle_core(&db, &rev_a.item.id, "ok", "VERDICT: FIX\nFINDINGS:\n- [must] a.txt:1 — vacío — escribe algo", "").await.unwrap();
    let state = settle_core(&db, &rev_b.item.id, "ok", "VERDICT: OK", "").await.unwrap();
    assert!(item_of(&state, "b").merged);
    assert!(!item_of(&state, "a").merged);

    // The fix continues a's task in a's worktree, then passes review.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.key, "a-fix");
    assert_eq!(d[0].cwd, item_of(&state, "a").worktree_path);
    assert_eq!(d[0].task.as_ref().map(|t| t.id.clone()), Some(item_of(&state, "a").task_id.clone()));
    std::fs::write(Path::new(&d[0].cwd).join("a.txt"), "algo\n").unwrap();
    settle_core(&db, &d[0].item.id, "ok", "Arreglado.", "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.kind, "review");
    let state = settle_core(&db, &d[0].item.id, "ok", "VERDICT: OK", "").await.unwrap();
    assert!(item_of(&state, "a").merged);

    // c starts from the integrated work.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.key, "c");
    assert!(Path::new(&d[0].cwd).join("a.txt").exists() && Path::new(&d[0].cwd).join("b.txt").exists());
    assert!(d[0].message.contains("Hecho a."), "c receives both handoffs");
    std::fs::write(Path::new(&d[0].cwd).join("c.txt"), "c\n").unwrap();
    settle_core(&db, &d[0].item.id, "ok", "Hecho c.", "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    settle_core(&db, &d[0].item.id, "ok", "VERDICT: OK", "").await.unwrap();

    // The lead's last look, then the merge gate.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.kind, "final");
    let state = settle_core(&db, &d[0].item.id, "ok", "Completo.\n```equipo\n{\"terminar\":true}\n```", "").await.unwrap();
    assert_eq!(state.run.gate, "merge");
    let repo = state.repos[0].local_path.clone();
    assert!(!Path::new(&repo).join("a.txt").exists());
    let state = decide(&db, &run_id, true, "").await.unwrap();
    assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
    for f in ["a.txt", "b.txt", "c.txt"] {
        assert!(Path::new(&repo).join(f).exists(), "{f} landed on main");
    }
    assert_eq!(std::fs::read_to_string(Path::new(&repo).join("a.txt")).unwrap(), "algo\n");
    assert!(!Path::new(&integ).exists(), "worktrees cleaned up");
    let left = crate::git::cli::run_in(&repo, &["branch", "--list", "codeflow/*"], &[]).unwrap().stdout;
    assert!(left.trim().is_empty(), "the run's branches are gone once their work is in main: {left}");
}

#[tokio::test]
async fn a_sub_lead_plans_its_branch_and_hands_the_summary_up() {
    let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
    let member = |id: &str, agent: &str, name: &str, edits: bool, reports_to: &str, leads: bool| team::Member {
        id: id.into(),
        agent_id: agent.into(),
        name: name.into(),
        edits,
        reports_to: reports_to.into(),
        leads,
        ..Default::default()
    };
    let mut policy = Policy { single_pass: false, ..Default::default() };
    policy.approve_plan = false;
    policy.comms = "tree".into();
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy,
                members: vec![
                    member("l", &lead, "Líder", false, "", false),
                    member("s", &qa, "Sub", false, "l", true),
                    member("d", &dev, "Dev", true, "s", false),
                ],
                ..Default::default()
            },
        )
    })
    .unwrap();
    // A cycle is refused before anything runs.
    let cyclic = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Ciclo".into(),
                lead: "l".into(),
                members: vec![member("l", &lead, "Líder", false, "", false), member("a", &dev, "A", true, "b", false), member("b", &qa, "B", true, "a", false)],
                ..Default::default()
            },
        )
    });
    assert!(cyclic.unwrap_err().contains("ciclo"));

    let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea d.txt".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();

    // The lead hands the whole branch to the sub-lead: that becomes a delegate, not work.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.kind, "plan");
    settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"rama\",\"miembro\":\"Sub\",\"tarea\":\"organiza: crea d.txt\"}]}\n```", "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.kind, "delegate");
    assert!(d[0].message.contains("Planificas tu propia rama"));
    assert!(d[0].message.contains("**Dev**") && !d[0].message.contains("**Líder**"), "a sub-lead sees only its branch");

    // The sub-lead plans for its report; the branch stays open while that runs.
    let delegate_id = d[0].item.id.clone();
    let state = settle_core(&db, &delegate_id, "ok", "```equipo\n{\"items\":[{\"id\":\"d\",\"miembro\":\"Dev\",\"tarea\":\"crea d.txt\"}]}\n```", "").await.unwrap();
    assert_eq!(item_of(&state, "rama").status, "delegated");
    assert_eq!(item_of(&state, "d").parent, delegate_id);

    // The member reports «to the lead»: with tree comms that is its sub-lead.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "d");
    std::fs::write(Path::new(&d[0].cwd).join("d.txt"), "d\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.\n```equipo\n{\"para\":\"líder\",\"texto\":\"listo d\"}\n```", "").await.unwrap();
    assert!(state.messages.iter().any(|m| m.kind == "note" && m.to_name == "Sub" && m.body.contains("listo d")));
    assert!(item_of(&state, "d").merged);

    // With its work closed, the branch closes and hands its summary up.
    let rama = item_of(&state, "rama");
    assert_eq!(rama.status, "done", "{rama:?}");
    assert!(rama.output_text.contains("`d`"));

    // The lead's last look and the merge.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.kind, "final");
    let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"terminar\":true}\n```", "").await.unwrap();
    assert_eq!(state.run.gate, "merge");
    let state = decide(&db, &run_id, true, "").await.unwrap();
    assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
}

#[tokio::test]
async fn the_lead_sees_its_areas_and_a_small_change_through_a_sub_lead_skips_the_ceremony() {
    let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
    let member = |id: &str, agent: &str, name: &str, edits: bool, boss: &str, leads: bool| team::Member {
        id: id.into(),
        agent_id: agent.into(),
        name: name.into(),
        edits,
        reports_to: boss.into(),
        leads,
        ..Default::default()
    };
    let mut policy = Policy { single_pass: false, ..Default::default() };
    policy.approve_plan = false;
    policy.approve_merge = false;
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy,
                members: vec![
                    member("l", &lead, "Tech lead", false, "", false),
                    member("s", &qa, "Líder backend", false, "l", true),
                    member("d", &dev, "Dev backend", true, "s", false),
                ],
                ..Default::default()
            },
        )
    })
    .unwrap();
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Cambia el timeout de la API".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(d[0].message.contains("**sub-líder**") && d[0].message.contains("entre Dev backend"), "{}", d[0].message);
    assert!(d[0].message.contains("en el área de Líder backend"), "{}", d[0].message);
    assert!(d[0].message.contains("Áreas con sub-líder"));

    // The lead hands it to the backend's sub-lead and calls it small.
    let plan = "```equipo\n{\"items\":[{\"id\":\"api\",\"miembro\":\"Líder backend\",\"tarea\":\"sube el timeout\"}],\"chico\":true}\n```";
    settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.kind, "delegate");
    settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"t\",\"miembro\":\"Dev backend\",\"tarea\":\"sube el timeout a 30 s\"}]}\n```", "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.member_name, "Dev backend");
    std::fs::write(Path::new(&d[0].cwd).join("timeout.txt"), "30\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();
    assert_eq!(state.run.status, "done", "{}", state.run.last_reason);
    assert!(state.items.iter().all(|i| i.kind != "final" && i.kind != "advise"));
}

#[tokio::test]
async fn a_run_over_its_budget_waits_and_approval_grows_it() {
    let (_serial, _dir, db, ws, project, [lead, dev, _qa]) = fixture();
    let mut policy = Policy { single_pass: false, ..Default::default() };
    policy.approve_plan = false;
    policy.budget_usd = 0.5;
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy,
                members: vec![
                    team::Member { id: "l".into(), agent_id: lead.clone(), name: "Líder".into(), edits: false, ..Default::default() },
                    team::Member { id: "d".into(), agent_id: dev.clone(), name: "Dev".into(), ..Default::default() },
                ],
                ..Default::default()
            },
        )
    })
    .unwrap();
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea x".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    // The plan turn cost more than the budget.
    with(&db, |c| {
        c.execute("UPDATE agent_tasks SET cost_usd = 0.75 WHERE id = ?1", rusqlite::params![d[0].item.task_id]).map_err(e2s)?;
        Ok(())
    })
    .unwrap();
    settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"x\",\"miembro\":\"Dev\",\"tarea\":\"crea x\"}]}\n```", "").await.unwrap();
    assert!(claim(&db, &run_id).await.unwrap().is_empty());
    let state = state_of(&db, &run_id).unwrap();
    assert_eq!(state.run.gate, "budget");
    let state = decide(&db, &run_id, true, "").await.unwrap();
    assert_eq!(state.run.status, "running");
    assert!((state.run.policy.budget_usd - 0.75).abs() < 1e-9);
    assert!(!claim(&db, &run_id).await.unwrap().is_empty() || state_of(&db, &run_id).unwrap().run.gate == "budget");
}

#[tokio::test]
async fn the_advisor_reads_the_plan_before_it_runs() {
    let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
    with(&db, |c| {
        queries::set_setting(c, crate::decide::SETTING_KEY, r#"{"engine":"off"}"#).map_err(e2s)?;
        Ok(())
    })
    .unwrap();
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                members: vec![
                    team::Member { id: "l".into(), agent_id: lead.clone(), name: "Líder".into(), edits: false, ..Default::default() },
                    team::Member { id: "d".into(), agent_id: dev.clone(), name: "Dev".into(), ..Default::default() },
                    team::Member { id: "a".into(), agent_id: qa.clone(), name: "Asesor".into(), edits: false, advisor: true, ..Default::default() },
                ],
                policy: Policy { single_pass: false, ..Default::default() },
                ..Default::default()
            },
        )
    })
    .unwrap();
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea y.txt".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(!d[0].message.contains("**Asesor**"), "the advisor is never offered as a worker");
    let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"y\",\"miembro\":\"Dev\",\"tarea\":\"crea y.txt\"}]}\n```", "").await.unwrap();
    // No gate yet: the advisor reads first, and the work waits for it.
    assert_eq!(state.run.status, "running");
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.kind, "advise");
    assert!(d[0].message.contains("El líder propone este plan"));
    let state = settle_core(&db, &d[0].item.id, "ok", "Falta un test para y.txt.", "").await.unwrap();
    assert_eq!(state.run.gate, "plan");
    assert!(state.run.gate_note.contains("Falta un test"));
    assert!(state.messages.iter().any(|m| m.kind == "advice"));
    decide(&db, &run_id, true, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "y");
}

/// A team with no lead and one fixed step for its only member.
pub(crate) fn solo_team(db: &Db, ws: &str, dev: &str, policy: Policy) -> team::Team {
    with(db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.into(),
                name: "Fijo".into(),
                lead: String::new(),
                policy,
                plan: vec![team::PlanStep { key: "uno".into(), member: "d".into(), instruction: "haz uno".into(), ..Default::default() }],
                members: vec![team::Member { id: "d".into(), agent_id: dev.into(), name: "Dev".into(), ..Default::default() }],
                ..Default::default()
            },
        )
    })
    .unwrap()
}

#[tokio::test]
async fn a_late_answer_from_a_replaced_dispatch_closes_nothing() {
    let (_serial, _dir, db, ws, project, [_, dev, _]) = fixture();
    let tm = solo_team(&db, &ws, &dev, Policy { approve_merge: false, single_pass: false, ..Default::default() });
    let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let first = claim(&db, &run_id).await.unwrap();
    let old = first[0].item.intelligence.dispatch_id.clone();
    assert!(!old.is_empty(), "every claim names its dispatch");

    // The user stops the turn; the run is resumed and the item is claimed again.
    settle_inner(&db, &first[0].item.id, Some(&old), "cancelled", "", "", None).await.unwrap();
    with(&db, |c| team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)).unwrap();
    let second = claim(&db, &run_id).await.unwrap();
    let new = second[0].item.intelligence.dispatch_id.clone();
    assert_ne!(old, new);

    // The stopped turn answers after all: it is not this attempt's answer.
    let state = settle_inner(&db, &first[0].item.id, Some(&old), "ok", "Hecho hace rato.", "", None).await.unwrap();
    assert_eq!(item_of(&state, "uno").status, "running", "the late answer settled the new attempt");
    assert!(item_of(&state, "uno").output_text.is_empty());

    // The attempt that is running settles it.
    let state = settle_inner(&db, &second[0].item.id, Some(&new), "ok", "Hecho.", "", None).await.unwrap();
    assert_eq!(item_of(&state, "uno").status, "done");
}

#[tokio::test]
async fn a_turn_called_off_while_it_queued_never_starts_and_costs_nothing() {
    let (_serial, _dir, db, ws, project, [_, dev, _]) = fixture();
    let tm = solo_team(&db, &ws, &dev, Policy { approve_merge: false, ..Default::default() });
    let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let (item_id, dispatch) = (d[0].item.id.clone(), d[0].item.intelligence.dispatch_id.clone());
    assert_eq!(d[0].item.intelligence.phase, "queued", "claimed is not started: it waits for a slot");

    // The run is paused while the turn waits for its slot: the slot comes, the turn must not start.
    with(&db, |c| team::set_run_status(c, &run_id, "paused", "", "").map_err(e2s)).unwrap();
    assert!(!turn_started(&db, &item_id, &dispatch));
    let state = settle_inner(&db, &item_id, Some(&dispatch), "unstarted", "", "", None).await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!((item.status.as_str(), item.attempts, item.intelligence.phase.as_str()), ("pending", 0, ""));
    assert_eq!(state.run.dispatches, 0, "a turn that never ran is not a dispatch spent");

    // Resumed, it is claimed again and this time its turn starts: the clock runs from here.
    with(&db, |c| team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)).unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(!turn_started(&db, &item_id, "otro-despacho"), "only the dispatch that holds the item starts it");
    assert!(turn_started(&db, &item_id, &d[0].item.intelligence.dispatch_id));
    let state = state_of(&db, &run_id).unwrap();
    assert_eq!(item_of(&state, "uno").intelligence.phase, "running");
}

#[tokio::test]
async fn a_folder_the_app_cannot_make_costs_the_member_no_attempt() {
    let (_serial, dir, db, ws, project, [_, dev, _]) = fixture();
    let tm = solo_team(&db, &ws, &dev, Policy { approve_merge: false, ..Default::default() });
    let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    // Something is already where the item's worktree goes.
    let slug = state.repos[0].integration_branch.trim_start_matches("codeflow/team-").to_string();
    let taken = dir.0.join("worktrees").join("web").join(format!("team-{slug}-uno"));
    std::fs::create_dir_all(taken.parent().unwrap()).unwrap();
    std::fs::write(&taken, "ocupado").unwrap();

    let due = |db: &Db| {
        with(db, |c| {
            for mut item in team::list_items(c, &run_id).map_err(e2s)? {
                if let Some(recovery) = item.intelligence.recovery.as_mut() {
                    recovery.resume_at = Some(0);
                    team::update_item(c, &item).map_err(e2s)?;
                }
            }
            Ok(())
        })
        .unwrap()
    };
    for round in 1..intelligence::MAX_INFRA_FAILURES {
        assert!(claim(&db, &run_id).await.unwrap().is_empty(), "nothing runs without its folder");
        let state = state_of(&db, &run_id).unwrap();
        let item = item_of(&state, "uno");
        assert_eq!((item.status.as_str(), item.attempts, state.run.dispatches), ("waiting", 0, 0), "round {round}");
        assert!(item.intelligence.recovery.as_ref().is_some_and(|r| r.resume_at.is_some()), "it has a time to try again");
        due(&db);
    }
    // It does not try forever: the run stops for the user, with the reason.
    assert!(claim(&db, &run_id).await.unwrap().is_empty());
    let state = state_of(&db, &run_id).unwrap();
    assert_eq!(item_of(&state, "uno").status, "error");
    assert_eq!(item_of(&state, "uno").attempts, 0);
    assert_eq!(state.run.status, "gated");
    assert!(state.run.gate_note.contains("no pudo preparar la carpeta"), "{}", state.run.gate_note);

    // With the path free, «seguir» gets it going.
    std::fs::remove_file(&taken).unwrap();
    decide(&db, &run_id, true, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.attempts, 1);
}

#[tokio::test]
async fn a_dependency_no_task_has_holds_the_item_until_someone_decides() {
    let (_serial, _dir, db, ws, project, [lead, dev, _]) = fixture();
    let plan = "```equipo\n{\"items\":[{\"id\":\"front\",\"miembro\":\"Dev\",\"tarea\":\"haz el front\",\"depende_de\":[\"contrato-api\"]}]}\n```";

    // With tries left, the lead is asked to correct its plan and nothing of it is created.
    let policy = Policy { single_pass: false, approve_plan: false, approve_merge: false, max_attempts: 2, ..Default::default() };
    let tm = led_team(&db, &ws, &lead, &dev, policy);
    let state = start_run(&db, ws.clone(), tm.id, "Haz el front".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    assert!(state.items.iter().all(|i| i.key != "front"), "a plan to be corrected creates nothing");
    let again = claim(&db, &run_id).await.unwrap();
    assert_eq!(again[0].item.kind, "plan");
    assert!(again[0].message.contains("dependencias que no existen"), "{}", again[0].message);

    // Out of tries, the task is kept — and held: it never starts on its own.
    let state = settle_core(&db, &again[0].item.id, "ok", plan, "").await.unwrap();
    let front = item_of(&state, "front");
    assert_eq!(front.intelligence.missing_deps, vec!["contrato-api".to_string()]);
    assert_eq!(front.status, "pending");
    assert_eq!(state.run.status, "gated", "{}", state.run.gate_note);
    assert!(state.run.gate.starts_with("deps:"), "{}", state.run.gate);
    assert!(state.run.gate_note.contains("contrato-api"));
    assert!(claim(&db, &run_id).await.unwrap().is_empty());

    // The user lets it go on without it.
    let state = decide(&db, &run_id, true, "").await.unwrap();
    assert!(item_of(&state, "front").intelligence.missing_deps.is_empty());
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "front");
}

#[tokio::test]
async fn a_branch_whose_work_failed_does_not_close_as_done() {
    let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
    let member = |id: &str, agent: &str, name: &str, edits: bool, reports_to: &str, leads: bool| team::Member {
        id: id.into(), agent_id: agent.into(), name: name.into(), edits, reports_to: reports_to.into(), leads, ..Default::default()
    };
    let policy = Policy { single_pass: false, approve_plan: false, max_attempts: 1, lead_rounds: 6, ..Default::default() };
    let tm = with(&db, |c| {
        team::save_team(c, team::Team {
            workspace_id: ws.clone(), name: "Equipo".into(), lead: "l".into(), policy,
            members: vec![member("l", &lead, "Líder", false, "", false), member("s", &qa, "Sub", false, "l", true), member("d", &dev, "Dev", true, "s", false)],
            ..Default::default()
        })
    })
    .unwrap();
    let state = start_run(&db, ws, tm.id, "Dos archivos".into(), None, vec![RepoPick { project_id: project, target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"rama\",\"miembro\":\"Sub\",\"tarea\":\"organiza\"}]}\n```", "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"a\",\"miembro\":\"Dev\",\"tarea\":\"crea a.txt\"},{\"id\":\"b\",\"miembro\":\"Dev\",\"tarea\":\"crea b.txt\",\"depende_de\":[\"a\"]}]}\n```", "").await.unwrap();

    // One of the branch's two tasks is delivered, the other fails for good.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "a");
    std::fs::write(Path::new(&d[0].cwd).join("a.txt"), "a\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.", "").await.unwrap();
    assert_eq!(item_of(&state, "rama").status, "delegated", "the branch is open while its work is");
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "b");
    let state = settle_core(&db, &d[0].item.id, "error", "", "no compila").await.unwrap();

    let rama = item_of(&state, "rama");
    assert_eq!(rama.intelligence.outcome, "partial");
    assert_eq!(rama.status, "done");
    assert!(rama.output_text.contains("cerró incompleta"), "{}", rama.output_text);
    assert!(state.messages.iter().any(|m| m.kind == "finding" && m.body.contains("cerró incompleta")));
}

#[tokio::test]
async fn done_takes_more_than_the_member_saying_so() {
    let (_serial, _dir, db, ws, project, [lead, dev, _]) = fixture();
    let policy = Policy { single_pass: false, approve_plan: false, approve_merge: false, max_attempts: 2, dod: "block".into(), ..Default::default() };
    let tm = led_team(&db, &ws, &lead, &dev, policy);
    let state = start_run(&db, ws, tm.id, "Sube el timeout".into(), None, vec![RepoPick { project_id: project, target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let plan = "```equipo\n{\"items\":[{\"id\":\"t\",\"miembro\":\"Dev\",\"tarea\":\"sube el timeout\",\"criterios\":[\"el timeout es 60 s\"]}]}\n```";
    settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(d[0].message.contains("sin_cambios"), "the member is told how to say it changed nothing");

    // «Listo», with no evidence for the criterion: not done.
    std::fs::write(Path::new(&d[0].cwd).join("t.txt"), "60\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();
    let item = item_of(&state, "t");
    assert_eq!(item.status, "pending", "{}", item.last_error);
    assert!(item.feedback.contains("No reportaste evidencia"), "{}", item.feedback);

    // With the evidence it is, and what the app itself ran is told apart from what the member said.
    let d = claim(&db, &run_id).await.unwrap();
    let reply = "Listo.\n```equipo\n{\"verificacion\":[{\"criterio\":1,\"evidencia\":\"t.txt dice 60\"}]}\n```";
    let state = settle_core(&db, &d[0].item.id, "ok", reply, "").await.unwrap();
    let item = item_of(&state, "t");
    assert_eq!(item.status, "done", "{}", item.last_error);
    assert!(item.intelligence.evidence.iter().any(|e| e.source == "agent" && e.result == "reported"));
}

#[tokio::test]
async fn work_that_changed_nothing_has_to_say_why() {
    let (_serial, _dir, db, ws, project, [_, dev, _]) = fixture();
    let policy = Policy { approve_merge: false, single_pass: false, max_attempts: 2, dod: "block".into(), ..Default::default() };
    let tm = solo_team(&db, &ws, &dev, policy);
    let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    // No file changed, no reason given.
    let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();
    assert_eq!(item_of(&state, "uno").status, "pending");
    assert!(item_of(&state, "uno").feedback.contains("No cambiaste ningún archivo"));
    // It was already so, and it says how it knows.
    let d = claim(&db, &run_id).await.unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Ya estaba en 60 s (config.ts:12).\n```equipo\n{\"sin_cambios\":\"ya_estaba\"}\n```", "").await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!((item.status.as_str(), item.intelligence.no_change.as_str()), ("done", "already_satisfied"));
}

#[tokio::test]
async fn a_restart_hands_back_what_was_queued_and_keeps_what_was_half_done() {
    let (_serial, _dir, db, ws, project, [_, dev, _]) = fixture();
    let tm = solo_team(&db, &ws, &dev, Policy { approve_merge: false, ..Default::default() });
    let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();

    // The app closes while the turn still waits for its slot: nothing was spent.
    let d = claim(&db, &run_id).await.unwrap();
    let old = d[0].item.intelligence.dispatch_id.clone();
    with(&db, |c| team::recover_after_restart(c).map_err(e2s)).unwrap();
    let state = state_of(&db, &run_id).unwrap();
    let item = item_of(&state, "uno");
    assert_eq!((state.run.status.as_str(), item.status.as_str(), item.attempts), ("paused", "pending", 0));
    assert!(item.intelligence.dispatch_id.is_empty() && item.feedback.is_empty());
    // Whatever outlived the app cannot settle the item any more.
    let state = settle_inner(&db, &d[0].item.id, Some(&old), "ok", "tarde", "", None).await.unwrap();
    assert_eq!(item_of(&state, "uno").status, "pending");

    // Closed again, this time with the turn at work: the next attempt is told about its folder.
    with(&db, |c| team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)).unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(turn_started(&db, &d[0].item.id, &d[0].item.intelligence.dispatch_id));
    with(&db, |c| team::recover_after_restart(c).map_err(e2s)).unwrap();
    let state = state_of(&db, &run_id).unwrap();
    let item = item_of(&state, "uno");
    assert_eq!((item.status.as_str(), item.attempts), ("pending", 1), "a turn that ran spent its attempt");
    assert!(item.feedback.contains("se interrumpió"), "{}", item.feedback);
}

pub(crate) fn led_team(db: &Db, ws: &str, lead: &str, dev: &str, policy: Policy) -> team::Team {
    let member = |id: &str, agent: &str, name: &str, edits: bool| team::Member { id: id.into(), agent_id: agent.into(), name: name.into(), edits, max_parallel: 1, ..Default::default() };
    with(db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.into(),
                name: "Equipo".into(),
                lead: "l".into(),
                policy,
                members: vec![member("l", lead, "Líder", false), member("d", dev, "Dev", true)],
                ..Default::default()
            },
        )
    })
    .unwrap()
}

#[tokio::test]
async fn a_lead_that_never_plans_anything_usable_leaves_the_run_stuck_not_done() {
    let (_serial, _dir, db, ws, project, [lead, dev, _]) = fixture();
    // `single_pass`: one attempt, no last look — the shape where one bad answer used to be
    // enough to reach «Todo está hecho» with nothing done.
    let tm = led_team(&db, &ws, &lead, &dev, Policy { approve_plan: false, ..Default::default() });
    let state = start_run(&db, ws, tm.id, "Arregla el login".into(), None, vec![RepoPick { project_id: project, target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Creo que habría que revisar el login.", "").await.unwrap();
    assert_eq!(state.run.status, "gated", "{}", state.run.gate_note);
    assert_eq!(state.run.gate, format!("stuck:{}", d[0].item.id));
    assert_eq!(item_of(&state, "plan").status, "error");

    // «Seguir» gives the lead one more try, with what the user said.
    decide(&db, &run_id, true, "Asígnaselo al dev").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.key, "plan");
    assert!(d[0].message.contains("Asígnaselo al dev"), "{}", d[0].message);
}

#[tokio::test]
async fn a_lead_round_that_changed_nothing_stops_instead_of_asking_again() {
    let (_serial, _dir, db, ws, project, [lead, dev, _]) = fixture();
    let policy = Policy { single_pass: false, approve_plan: false, approve_merge: false, lead_rounds: 6, ..Default::default() };
    let tm = led_team(&db, &ws, &lead, &dev, policy);
    let state = start_run(&db, ws, tm.id, "Sube el timeout".into(), None, vec![RepoPick { project_id: project, target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let plan = "```equipo\n{\"items\":[{\"id\":\"t\",\"miembro\":\"Dev\",\"tarea\":\"sube el timeout\"}]}\n```";
    settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "t");
    // The member finishes without changing a file: the round left nothing.
    let state = settle_core(&db, &d[0].item.id, "ok", "Ya estaba en 30 s.", "").await.unwrap();
    assert_eq!(state.run.status, "gated", "{}", state.run.gate_note);
    assert!(state.run.gate.starts_with("stuck:"), "{}", state.run.gate);
    assert!(state.run.gate_note.contains("no dejó cambios"), "{}", state.run.gate_note);
    assert!(state.items.iter().all(|i| i.kind != "final"), "no last look was started");

    // Going on is the user's call: the last look then runs once.
    decide(&db, &run_id, true, "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].item.kind, "final");
}

#[tokio::test]
async fn questions_wait_for_the_user_and_failures_escalate() {
    let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Fijo".into(),
                lead: String::new(),
                policy: Policy { approve_merge: false, commit: "squash".into(), max_attempts: 1, single_pass: false, ..Default::default() },
                plan: vec![team::PlanStep { key: "uno".into(), member: "d".into(), instruction: "haz uno".into(), ..Default::default() }],
                members: vec![
                    team::Member { id: "d".into(), agent_id: dev.clone(), name: "Dev".into(), escalate_to: "s".into(), ..Default::default() },
                    team::Member { id: "s".into(), agent_id: lead.clone(), name: "Senior".into(), ..Default::default() },
                    team::Member { id: "q".into(), agent_id: qa.clone(), name: "QA".into(), ..Default::default() },
                ],
                ..Default::default()
            },
        )
    })
    .unwrap();
    let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let d = claim(&db, &run_id).await.unwrap();
    // A question to the user parks the item.
    let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"para\":\"usuario\",\"tipo\":\"pregunta\",\"texto\":\"¿rojo o azul?\",\"opciones\":[\"rojo\",\"azul\"]}\n```", "").await.unwrap();
    assert_eq!(item_of(&state, "uno").status, "waiting");
    let q = state.messages.iter().find(|m| m.kind == "question").unwrap().id.clone();
    answer_question(&db, &q, "azul").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert!(d[0].message.contains("¿rojo o azul? → azul"));
    // It fails (one attempt) and goes to the senior.
    let state = settle_core(&db, &d[0].item.id, "error", "", "se rompió").await.unwrap();
    assert_eq!(item_of(&state, "uno").status, "error");
    let esc = item_of(&state, "uno-esc");
    assert_eq!(esc.member_name, "Senior");
    let d = claim(&db, &run_id).await.unwrap();
    std::fs::write(Path::new(&d[0].cwd).join("uno.txt"), "1\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "listo", "").await.unwrap();
    // No lead, no merge approval: it lands as one squashed commit.
    assert_eq!(state.run.status, "done", "{}", state.run.gate_note);
    let repo = &state.repos[0].local_path;
    assert!(Path::new(repo).join("uno.txt").exists());
    let log = crate::git::cli::run_in(repo, &["log", "--oneline"], &[]).unwrap().stdout;
    assert_eq!(log.lines().count(), 2, "{log}");
}

/// A shared run (`collab::team`): work of a free seat waits, work of a taken seat is handed off
/// with no task of its own here, survives a restart, and settles like any other once its
/// person's commit is in its worktree.
#[tokio::test]
async fn a_shared_run_holds_a_free_seat_and_hands_a_taken_one_off() {
    let (_serial, _dir, db, ws, project, [lead, dev, _qa]) = fixture();
    let member = |id: &str, agent: &str, name: &str, edits: bool| team::Member {
        id: id.into(),
        agent_id: agent.into(),
        name: name.into(),
        edits,
        max_parallel: 2,
        ..Default::default()
    };
    let tm = with(&db, |c| {
        team::save_team(
            c,
            team::Team {
                workspace_id: ws.clone(),
                name: "Equipo".into(),
                lead: "l".into(),
                members: vec![member("l", &lead, "Líder", false), member("d", &dev, "Dev", true)],
                ..Default::default()
            },
        )
    })
    .unwrap();
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea a".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
        .await
        .unwrap();
    let run_id = state.run.id.clone();

    // Shared, with Dev as a seat nobody has taken yet.
    with(&db, |c| {
        crate::collab::store::insert_session(
            c,
            &crate::collab::store::Session {
                id: "s1".into(),
                project_url: "https://x.supabase.co".into(),
                name: "Equipo".into(),
                role: "owner".into(),
                nick: "Ana".into(),
                person_id: "pa".into(),
                workspace_id: ws.clone(),
                chat_id: String::new(),
                status: "active".into(),
                last_seq: 0,
                created_at: String::new(),
            },
        )
        .map_err(e2s)?;
        let run = team::get_run(c, &run_id).map_err(e2s)?.unwrap();
        crate::collab::store::insert_repo(
            c,
            &crate::collab::store::Repo {
                session_id: "s1".into(),
                repo_key: "github.com/acme/web".into(),
                name: "web".into(),
                project_id: project.clone(),
                checkout_path: String::new(),
                worktree_path: String::new(),
                branch: String::new(),
                base_sha: String::new(),
                epoch: 0,
                session_project_id: String::new(),
            },
        )
        .map_err(e2s)?;
        crate::collab::team::record_share(c, "s1", &run, &["d".into(), "l".into()])
    })
    .unwrap();
    let seats = with(&db, |c| crate::collab::team::seats(c, "s1").map_err(e2s)).unwrap();
    assert_eq!(seats.iter().map(|s| s.member_id.as_str()).collect::<Vec<_>>(), vec!["d"], "the lead is never a seat");

    // The lead plans here, as always.
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.kind, "plan");
    assert!(d[0].task.is_some());
    let plan = "Reparto.\n```equipo\n{\"items\":[{\"id\":\"a\",\"miembro\":\"dev\",\"tarea\":\"crea a.txt\"}]}\n```";
    settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
    decide(&db, &run_id, true, "").await.unwrap();

    // A free seat: its work waits.
    assert!(claim(&db, &run_id).await.unwrap().is_empty());
    let state = state_of(&db, &run_id).unwrap();
    assert_eq!(item_of(&state, "a").status, "pending");

    // Someone takes it: the work goes out, with no task and no engine here.
    with(&db, |c| c.execute("UPDATE collab_run_seats SET person_id = 'pb', nick = 'Beto' WHERE member_id = 'd'", []).map(|_| ()).map_err(e2s)).unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].run_in, crate::collab::team::RUN_IN_REMOTE);
    assert!(d[0].task.is_none());
    assert!(Path::new(&d[0].cwd).is_dir(), "its worktree exists here, for the result to land in");
    crate::collab::team::queue_offer(&db, &run_id, &d[0]).unwrap();
    let queued: String = with(&db, |c| c.query_row("SELECT state FROM collab_run_jobs WHERE item_id = ?1", [&d[0].item.id], |r| r.get(0)).map_err(e2s)).unwrap();
    assert_eq!(queued, "queued");

    // Closing the app does not take it back: it is still running on the other machine.
    with(&db, |c| team::recover_after_restart(c).map_err(e2s)).unwrap();
    let state = state_of(&db, &run_id).unwrap();
    assert_eq!(item_of(&state, "a").status, "running");
    with(&db, |c| c.execute("UPDATE agent_team_runs SET status = 'running' WHERE id = ?1", [&run_id]).map(|_| ()).map_err(e2s)).unwrap();

    // Their commit arrives in the worktree; the item settles and integrates as if it ran here.
    std::fs::write(Path::new(&d[0].cwd).join("a.txt"), "de Beto\n").unwrap();
    sh(&d[0].cwd, &["add", "-A"]);
    sh(&d[0].cwd, &["commit", "-q", "-m", "Equipo: crea a.txt"]);
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho a.", "").await.unwrap();
    assert!(item_of(&state, "a").merged, "{:?}", item_of(&state, "a"));

    // Nobody in the seat any more: the run stops sharing, and Dev's next work runs here again.
    with(&db, |c| c.execute("UPDATE collab_sessions SET status = 'ended' WHERE id = 's1'", []).map(|_| ()).map_err(e2s)).unwrap();
    assert_eq!(with(&db, |c| Ok(crate::collab::team::route(c, &run_id, "d", "work"))).unwrap(), crate::collab::team::Route::Local);
}

/// Against a real engine: `cargo test --lib team::engine::tests::a_team_with_isolated_checks -- --ignored`.
#[tokio::test]
#[ignore = "needs a running container engine"]
async fn a_team_with_isolated_checks_verifies_in_a_container_and_leaves_nothing_behind() {
    let (_serial, _dir, db, ws, project, [_, dev, _]) = fixture();
    let policy = Policy {
        approve_merge: false,
        sandbox: "checks".into(),
        sandbox_image: "node:22-bookworm-slim".into(),
        checks: vec![
            team::Check { repo: "*".into(), command: "test -f uno.txt && touch made-in-the-copy".into(), when: "item".into(), kind: "unit".into(), ..Default::default() },
            team::Check { repo: "*".into(), command: "grep -q listo uno.txt".into(), when: "item".into(), kind: "unit".into(), ..Default::default() },
        ],
        max_attempts: 2,
        single_pass: false,
        ..Default::default()
    };
    let tm = solo_team(&db, &ws, &dev, policy);
    let cache = team::sandbox::home_volume(&project);
    let state = start_run(&db, ws, tm.id, "haz uno".into(), None, vec![RepoPick { project_id: project, target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let repo = state.repos[0].local_path.clone();

    // The second check fails in the container: that is the work's failure, and it goes back.
    let d = claim(&db, &run_id).await.unwrap();
    std::fs::write(Path::new(&d[0].cwd).join("uno.txt"), "a medias\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.", "").await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!(item.status, "pending", "{:?}", state.run.gate_note);
    assert!(item.feedback.contains("grep -q listo uno.txt"), "{}", item.feedback);

    // Fixed: both pass, isolated, and what a check wrote never reached the tree that is committed.
    let d = claim(&db, &run_id).await.unwrap();
    std::fs::write(Path::new(&d[0].cwd).join("uno.txt"), "listo\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.", "").await.unwrap();
    let item = item_of(&state, "uno");
    assert_eq!(item.status, "done", "{} · {:?}", item.last_error, state.run.gate_note);
    let checks: Vec<_> = item.intelligence.evidence.iter().filter(|e| e.source == "check").collect();
    assert_eq!(checks.len(), 2);
    assert!(checks.iter().all(|e| e.result == "passed" && e.sandbox == "node:22-bookworm-slim" && !e.sha.is_empty()), "{checks:?}");
    assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
    assert!(Path::new(&repo).join("uno.txt").exists(), "the work landed");
    assert!(!Path::new(&repo).join("made-in-the-copy").exists(), "what the check wrote stayed in its copy");

    // The run's copies go with it (asked off to the side when the run closed).
    team::sandbox::forget_run(&run_id).await;
    let target = crate::containers::engine::Target { runtime: "docker".into(), context: None };
    let left = target.run_owned(vec!["volume".into(), "ls".into(), "-q".into(), "--filter".into(), format!("label={}={run_id}", team::sandbox::LABEL_RUN)], std::time::Duration::from_secs(30)).await.unwrap();
    assert!(left.stdout.trim().is_empty(), "{}", left.stdout);
    // The repository's cache is kept between runs by design; this repository lived for one test.
    let _ = target.run_owned(vec!["volume".into(), "rm".into(), "-f".into(), cache], std::time::Duration::from_secs(30)).await;
}

#[tokio::test]
async fn the_same_task_goes_to_two_teams_from_one_commit_and_the_same_checks_score_both() {
    let (_serial, _dir, db, ws, project, [lead, dev, _]) = fixture();
    let repo = with(&db, |c| Ok(queries::get_project(c, &project).unwrap().unwrap().local_path)).unwrap();
    let solo = solo_team(&db, &ws, &dev, Policy::default());
    let led = led_team(&db, &ws, &lead, &dev, Policy::default());
    assert!(eval_start(&db, &ws, "", "haz uno", &project, "", std::slice::from_ref(&solo.id), &[]).await.unwrap_err().contains("al menos dos"));

    let eval = eval_start(&db, &ws, "", "haz uno", &project, "", &[solo.id.clone(), led.id.clone(), solo.id.clone()], &["test -f uno.txt".into()]).await.unwrap();
    assert_eq!((eval.title.as_str(), eval.base_branch.as_str(), eval.entries.len()), ("haz uno", "main", 2), "a team named twice runs once");
    assert_eq!(eval.base_sha, gitops::head_sha(&repo).unwrap());
    // `main` moves on: the comparison does not follow it.
    std::fs::write(Path::new(&repo).join("despues.txt"), "x\n").unwrap();
    sh(&repo, &["add", "-A"]);
    sh(&repo, &["commit", "-q", "-m", "después"]);

    // The fixed team does the task; nothing asks a person, and nothing lands.
    let first = eval.entries[0].run_id.clone();
    let d = claim(&db, &first).await.unwrap();
    assert!(!Path::new(&d[0].cwd).join("despues.txt").exists(), "every team starts from the pinned commit");
    std::fs::write(Path::new(&d[0].cwd).join("uno.txt"), "x\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.", "").await.unwrap();
    assert_eq!((state.run.status.as_str(), state.repos[0].status.as_str()), ("done", "left"), "{:?}", state.run.gate_note);
    assert!(!Path::new(&repo).join("uno.txt").exists(), "a comparison never lands on the repository's branch");

    // The led team delivers something else.
    let second = eval.entries[1].run_id.clone();
    let d = claim(&db, &second).await.unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"t\",\"miembro\":\"Dev\",\"tarea\":\"haz otro\"}]}\n```", "").await.unwrap();
    assert_eq!(state.run.status, "running", "no plan gate in a comparison: {:?}", state.run.gate);
    let d = claim(&db, &second).await.unwrap();
    std::fs::write(Path::new(&d[0].cwd).join("otro.txt"), "x\n").unwrap();
    std::fs::write(Path::new(&d[0].cwd).join("mas.txt"), "x\ny\n").unwrap();
    let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.", "").await.unwrap();
    assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);

    // Both closed, neither scored: the same check runs on each result.
    let shown = with(&db, |c| team::lab::view(c, &eval).map_err(e2s)).unwrap();
    assert_eq!(shown.state, "scoring");
    let eval = eval_score(&db, &eval.id).await.unwrap();
    let shown = with(&db, |c| team::lab::view(c, &eval).map_err(e2s)).unwrap();
    assert_eq!((shown.state.as_str(), shown.winner.as_str()), ("decided", first.as_str()));
    let (one, two) = (&shown.entries[0], &shown.entries[1]);
    assert_eq!((one.rank, one.passed, one.files, one.insertions), (1, 1, 1, 1));
    assert_eq!((two.rank, two.passed, two.files, two.insertions), (2, 0, 2, 3));
    assert_eq!((one.tasks_done, one.tasks_total, two.tasks_done, two.tasks_total), (1, 1, 1, 1));
    // Scored once: asking again runs nothing and changes nothing.
    assert_eq!(eval_score(&db, &eval.id).await.unwrap().updated_at, eval.updated_at);

    // The comparison goes; its runs are ordinary runs and stay.
    eval_delete(&db, &eval.id).await.unwrap();
    assert!(!gitops::branch_exists(&repo, &eval.pin_branch));
    assert!(with(&db, |c| team::get_run(c, &first).map_err(e2s)).unwrap().is_some());
}

#[tokio::test]
async fn a_run_forks_from_before_a_task_without_touching_the_original() {
    let (_serial, _dir, db, ws, project, [lead, dev, _]) = fixture();
    let policy = Policy { single_pass: false, approve_plan: false, approve_merge: false, ..Default::default() };
    let tm = led_team(&db, &ws, &lead, &dev, policy);
    let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea a y b".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None).await.unwrap();
    let run_id = state.run.id.clone();
    let repo = state.repos[0].local_path.clone();
    let d = claim(&db, &run_id).await.unwrap();
    let plan = "```equipo\n{\"items\":[{\"id\":\"a\",\"miembro\":\"Dev\",\"tarea\":\"crea a.txt\"},{\"id\":\"b\",\"miembro\":\"Dev\",\"tarea\":\"crea b.txt con REST\",\"depende_de\":[\"a\"]}]}\n```";
    let state = settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();

    // Nothing to fork from before a task has a starting point in the code.
    let err = fork_run(&db, &run_id, &item_of(&state, "b").id, "", "").await.unwrap_err();
    assert!(err.contains("todavía no empezó"), "{err}");

    let d = claim(&db, &run_id).await.unwrap();
    std::fs::write(Path::new(&d[0].cwd).join("a.txt"), "a\n").unwrap();
    settle_core(&db, &d[0].item.id, "ok", "Hecho a.", "").await.unwrap();
    let d = claim(&db, &run_id).await.unwrap();
    assert_eq!(d[0].item.key, "b");

    // b is under way. The fork starts from just before it, with another idea of what b should be.
    let fork = fork_run(&db, &run_id, &d[0].item.id, "Crea b.txt, pero con gRPC", "").await.unwrap();
    assert_ne!(fork.run.id, run_id);
    assert_eq!(fork.run.title, "↳ Crea a y b");
    let target = fork.repos[0].target_branch.clone();
    assert!(target.starts_with("codeflow/fork-"), "{target}");
    assert!(Path::new(&fork.repos[0].integration_path).join("a.txt").exists(), "what was done before the task is where the fork starts");
    assert!(fork.run.goal.starts_with("Crea b.txt, pero con gRPC"));
    assert!(fork.run.goal.contains("`a` crea a.txt") && fork.run.goal.contains("no lo rehagas"), "{}", fork.run.goal);
    assert!(fork.run.goal.contains("El objetivo original era: Crea a y b"));
    assert!(!fork.run.policy.approve_plan, "the same team keeps the rules the original ran with");
    assert!(fork.messages.iter().any(|m| m.body.contains("Bifurcada de «Crea a y b»")));

    // The original goes on as if nothing had happened, and says where it was forked.
    let original = state_of(&db, &run_id).unwrap();
    assert_eq!(item_of(&original, "b").status, "running");
    assert!(original.messages.iter().any(|m| m.kind == "status" && m.body.contains("bifurcó esta corrida")));
    std::fs::write(Path::new(&d[0].cwd).join("b.txt"), "rest\n").unwrap();
    let original = settle_core(&db, &d[0].item.id, "ok", "Hecho b.", "").await.unwrap();
    assert!(item_of(&original, "b").merged);

    // The fork delivers into its own branch: the repository's branch never sees it.
    let d = claim(&db, &fork.run.id).await.unwrap();
    assert_eq!(d[0].item.kind, "plan");
    settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"b\",\"miembro\":\"Dev\",\"tarea\":\"crea b.txt con gRPC\"}]}\n```", "").await.unwrap();
    let d = claim(&db, &fork.run.id).await.unwrap();
    assert!(!Path::new(&d[0].cwd).join("b.txt").exists(), "the original's b is not in the fork");
    std::fs::write(Path::new(&d[0].cwd).join("b.txt"), "grpc\n").unwrap();
    settle_core(&db, &d[0].item.id, "ok", "Hecho b.", "").await.unwrap();
    let d = claim(&db, &fork.run.id).await.unwrap();
    let forked = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"terminar\":true}\n```", "").await.unwrap();
    assert_eq!(forked.run.status, "done", "{:?} {:?}", forked.run.gate, forked.run.gate_note);
    let on_fork = crate::git::cli::run_in(&repo, &["show", &format!("{target}:b.txt")], &[]).unwrap();
    assert_eq!(on_fork.stdout.trim(), "grpc");
    let on_main = crate::git::cli::run_in(&repo, &["show", "main:b.txt"], &[]).unwrap();
    assert!(!on_main.success || on_main.stdout.trim() != "grpc", "main is the original's to deliver to");
}
