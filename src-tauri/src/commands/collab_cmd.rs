//! Commands of shared workspace chats (`crate::collab`): share, join, sync, resolve, commit, leave.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::collab::{link, remote::Remote, store, sync, worktree};
use crate::db::{chat_queries, queries, Db};

static PENDING_JOIN_LINK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// An invitation link opened from outside (a click in Slack, a second launch with the URL). Held
/// until the main window asks for it, which then shows the join dialog. Nothing joins by itself.
pub fn handle_join_link(app: &AppHandle, url: &str) -> bool {
    if !url.starts_with(link::PREFIX) {
        return false;
    }
    *PENDING_JOIN_LINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.to_string());
    let _ = app.emit("collab:join-link", ());
    crate::tray::show_main_window(app);
    true
}

#[tauri::command]
pub fn collab_take_join_link() -> Option<String> {
    PENDING_JOIN_LINK.lock().unwrap_or_else(|e| e.into_inner()).take()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub session: store::Session,
    pub repos: Vec<store::Repo>,
    pub is_owner: bool,
    /// `chat` or `run` (a shared «Equipo» run, `collab::team`).
    pub kind: String,
    /// For a run: the local run on the owner's machine (`''` on a guest's).
    pub run_id: String,
}

fn view(db: &Db, session_id: &str) -> Result<SessionView, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let session = store::session(&conn, session_id).map_err(|e| e.to_string())?.ok_or("sesión desconocida")?;
    let repos = store::repos(&conn, session_id).map_err(|e| e.to_string())?;
    let is_owner = session.role == "owner";
    let run = crate::collab::team::run_of_session(&conn, session_id).map_err(|e| e.to_string())?;
    let kind = if run.is_some() { "run" } else { "chat" }.to_string();
    let run_id = run.map(|(id, _)| id).unwrap_or_default();
    Ok(SessionView { session, repos, is_owner, kind, run_id })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// A repository as the share dialog lists it before anything is created.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCandidate {
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub repo_key: Option<String>,
    pub base: Option<String>,
    pub branch: Option<String>,
    /// Shareable uncommitted files the host has, which the session starts with.
    pub uncommitted: usize,
    /// Changed files that stay home, with why.
    pub skipped: Vec<crate::collab::manifest::Skipped>,
    /// Why this repository cannot be shared as it is, when it cannot.
    pub problem: Option<String>,
}

/// What sharing each repository of a workspace would involve: its identity, base, what travels and
/// what stays home. Read-only.
#[tauri::command]
pub async fn collab_share_preview(db: State<'_, Db>, workspace_id: String) -> Result<Vec<ShareCandidate>, String> {
    let projects = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::list_projects(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    blocking(move || {
        Ok(projects
            .into_iter()
            .map(|p| {
                let path = p.local_path.clone();
                let repo_key = crate::repo_identity::primary_remote(&path).and_then(|url| crate::repo_identity::canonical_remote(&url));
                let base = crate::team::gitops::head_sha(&path).ok();
                let branch = crate::team::gitops::current_branch(&path);
                let scanned = crate::collab::manifest::scan(&path, "HEAD").ok();
                let problem = if !std::path::Path::new(&path).exists() {
                    Some("no está en disco".to_string())
                } else if repo_key.is_none() {
                    Some("no tiene remoto: los demás no podrían traer su base".to_string())
                } else if base.as_deref().is_some_and(|b| !worktree::base_is_pushed(&path, b)) {
                    Some("tiene commits sin subir: haz push antes de compartir".to_string())
                } else if base.is_none() {
                    Some("no tiene commits".to_string())
                } else {
                    None
                };
                ShareCandidate {
                    project_id: p.id,
                    name: p.name,
                    path,
                    repo_key,
                    base,
                    branch,
                    uncommitted: scanned.as_ref().map(|m| m.files.len()).unwrap_or(0),
                    skipped: scanned.map(|m| m.skipped).unwrap_or_default(),
                    problem,
                }
            })
            .collect())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    pub view: SessionView,
    pub link: String,
}

/// Shares a workspace chat: opens the session in Supabase, makes the host's session worktree for
/// each repository (seeded with their uncommitted work), optionally posts the chat's history, and
/// mints the first invitation.
#[tauri::command]
pub async fn collab_share(
    db: State<'_, Db>,
    workspace_id: String,
    chat_id: String,
    project_url: String,
    nick: String,
    name: String,
    project_ids: Vec<String>,
    include_history: bool,
) -> Result<Shared, String> {
    let nick = nick.trim().to_string();
    if nick.is_empty() {
        return Err("Escribe un nick.".into());
    }
    if project_ids.is_empty() {
        return Err("Elige al menos un repositorio.".into());
    }
    let (projects, history) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if store::session_for_chat(&conn, &chat_id).map_err(|e| e.to_string())?.is_some() {
            return Err("Este chat ya está compartido.".into());
        }
        let projects: Vec<_> = queries::list_projects(&conn, &workspace_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|p| project_ids.contains(&p.id))
            .collect();
        let history = if include_history {
            chat_queries::list_messages(&conn, &chat_id, false).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        (projects, history)
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    let slug = worktree::slug(&session_id);
    let person_key = store::mint_secret();
    let owner_secret = store::mint_secret();
    let remote = Remote::new(&project_url, &person_key)?;
    // The host's own project: CodeFlow has none. Before anything is made, make sure its SQL is there.
    remote.check_schema().await?;

    // The worktrees first: a repository that cannot be shared stops the share before anything exists
    // in Supabase.
    let slug_for_git = slug.clone();
    let made = blocking(move || {
        let mut out = Vec::new();
        for p in projects {
            let repo_key = crate::repo_identity::primary_remote(&p.local_path)
                .and_then(|url| crate::repo_identity::canonical_remote(&url))
                .ok_or_else(|| format!("{}: no tiene remoto", p.name))?;
            let base = crate::team::gitops::head_sha(&p.local_path)?;
            if !worktree::base_is_pushed(&p.local_path, &base) {
                return Err(format!("{}: tiene commits sin subir; haz push antes de compartir", p.name));
            }
            let target = worktree::default_dir(&p.name, &slug_for_git);
            let copy = worktree::create(&p.local_path, &target, &slug_for_git, &base)?;
            worktree::seed(&p.local_path, &copy.path)?;
            out.push(store::Repo {
                session_id: String::new(),
                repo_key,
                name: p.name.clone(),
                project_id: p.id.clone(),
                checkout_path: p.local_path.clone(),
                worktree_path: copy.path,
                branch: copy.branch,
                base_sha: base,
                epoch: 0,
                session_project_id: String::new(),
            });
        }
        Ok(out)
    })
    .await?;

    let person_id = remote.create(&session_id, &name, &owner_secret, &nick).await.map_err(crate::collab::remote::friendly)?;
    for repo in &made {
        remote.add_repo(&session_id, &owner_secret, &repo.repo_key, &repo.name, &repo.base_sha).await?;
    }
    store::set_person_key(&session_id, &person_key)?;
    store::set_owner_secret(&session_id, &owner_secret)?;

    let session = store::Session {
        id: session_id.clone(),
        project_url: crate::supabase::trimmed_url(&project_url),
        name: name.clone(),
        role: "owner".into(),
        nick: nick.clone(),
        person_id: person_id.clone(),
        workspace_id,
        chat_id,
        status: "active".into(),
        last_seq: 0,
        created_at: String::new(),
    };
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::insert_session(&conn, &session).map_err(|e| e.to_string())?;
        for repo in &made {
            let shown = add_session_project(&conn, &session.workspace_id, &repo.project_id, &repo.worktree_path)?;
            store::insert_repo(&conn, &store::Repo { session_id: session_id.clone(), session_project_id: shown, ..repo.clone() })
                .map_err(|e| e.to_string())?;
        }
    }

    // The history goes in as the host's own turns, so a joiner reads the conversation so far.
    for row in history.iter().filter(|r| !r.content.trim().is_empty()).take(60) {
        let kind = if row.role == "user" { "user" } else { "assistant" };
        let body = serde_json::json!({
            "nick": nick, "text": row.content, "engine": row.provider.clone().unwrap_or_default(),
            "turn_id": format!("history-{}", row.id), "history": true,
        });
        let _ = remote.post(&session_id, &person_id, &format!("history-{}", row.id), kind, &body).await;
    }

    let link = mint_link(&db, &session_id, &remote, &owner_secret).await?;
    Ok(Shared { view: view(&db, &session_id)?, link })
}

pub(crate) async fn mint_link(db: &Db, session_id: &str, remote: &Remote, owner_secret: &str) -> Result<String, String> {
    let v = view(db, session_id)?;
    let token = store::mint_secret();
    remote.invite(session_id, owner_secret, &token, 24).await?;
    let anon = crate::supabase::public_anon_key(&v.session.project_url)?.ok_or("falta la anon key del proyecto")?;
    let is_run = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::collab::team::is_run_session(&conn, session_id)
    };
    Ok(link::encode(&link::Invitation {
        kind: if is_run { "run".into() } else { String::new() },
        v: 1,
        url: v.session.project_url.clone(),
        key: anon,
        token,
        name: v.session.name.clone(),
        host: v.session.nick.clone(),
        repos: v.repos.iter().map(|r| link::LinkRepo { key: r.repo_key.clone(), name: r.name.clone() }).collect(),
    }))
}

/// Adds the session worktree of `original` to the workspace as its own project («api · sesión»), so
/// the sidebar, the Editor, Git and the file watcher work on the shared copy with nothing else
/// changed. Returns its id. Created straight through `queries`: the workspace's one-copy-per-remote
/// rule is about a person's own checkouts, and this one is temporary and removed on leaving.
fn add_session_project(conn: &rusqlite::Connection, workspace_id: &str, original: &str, worktree_path: &str) -> Result<String, String> {
    let source = queries::get_project(conn, original).map_err(|e| e.to_string())?.ok_or("proyecto desconocido")?;
    let created = queries::create_project(conn, crate::db::models::NewProject {
        workspace_id: if workspace_id.is_empty() { source.workspace_id.clone() } else { workspace_id.to_string() },
        name: format!("{} · sesión", source.name),
        local_path: worktree_path.to_string(),
        remote_url: source.remote_url.clone(),
        color: source.color.clone(),
        icon: source.icon.clone(),
        ado_org: source.ado_org.clone(),
        ado_project: source.ado_project.clone(),
        ado_repo_id: source.ado_repo_id.clone(),
        github_owner: source.github_owner.clone(),
        github_repo: source.github_repo.clone(),
        github_host: source.github_host.clone(),
        gitlab_project: None,
        gitlab_host: None,
    })
    .map_err(|e| e.to_string())?;
    Ok(created.id)
}

/// Another single-use invitation for the same session (one per person).
#[tauri::command]
pub async fn collab_invite(db: State<'_, Db>, session_id: String) -> Result<String, String> {
    let (session, _) = sync::load(&db, &session_id)?;
    let remote = sync::remote_for(&session)?;
    let secret = store::owner_secret(&session_id)?;
    mint_link(&db, &session_id, &remote, &secret).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinPreview {
    pub name: String,
    pub host: String,
    pub project_url: String,
    pub repos: Vec<JoinRepo>,
    /// `chat` or `run`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRepo {
    pub key: String,
    pub name: String,
    /// The workspace project that is this repository, found by its remote.
    pub project_id: Option<String>,
    pub path: Option<String>,
}

fn match_repos(db: &Db, workspace_id: &str, invitation: &link::Invitation) -> Result<Vec<JoinRepo>, String> {
    let projects = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::list_projects(&conn, workspace_id).map_err(|e| e.to_string())?
    };
    let keyed: Vec<(Option<String>, crate::db::models::Project)> = projects
        .into_iter()
        .map(|p| (crate::repo_identity::primary_remote(&p.local_path).and_then(|u| crate::repo_identity::canonical_remote(&u)), p))
        .collect();
    Ok(invitation
        .repos
        .iter()
        .map(|r| {
            let found = keyed.iter().find(|(k, _)| k.as_deref() == Some(r.key.as_str())).map(|(_, p)| p);
            JoinRepo { key: r.key.clone(), name: r.name.clone(), project_id: found.map(|p| p.id.clone()), path: found.map(|p| p.local_path.clone()) }
        })
        .collect())
}

/// What an invitation is and whether this workspace has every repository it needs. Spends nothing.
#[tauri::command]
pub async fn collab_join_preview(db: State<'_, Db>, workspace_id: String, link_text: String) -> Result<JoinPreview, String> {
    let invitation = link::decode(&link_text)?;
    let ws = workspace_id.clone();
    let db_inner = db.inner();
    let repos = match_repos(db_inner, &ws, &invitation)?;
    let kind = if invitation.is_run() { "run" } else { "chat" }.to_string();
    Ok(JoinPreview { name: invitation.name, host: invitation.host, project_url: invitation.url, repos, kind })
}

/// Joins with a nick: spends the invitation, makes this person's session worktree for each
/// repository on the session's base, and opens a local workspace chat for the session.
#[tauri::command]
pub async fn collab_join(db: State<'_, Db>, workspace_id: String, link_text: String, nick: String) -> Result<SessionView, String> {
    let invitation = link::decode(&link_text)?;
    if invitation.is_run() {
        return join_run(&db, &workspace_id, &invitation, &nick).await;
    }
    let matched = match_repos(&db, &workspace_id, &invitation)?;
    let missing: Vec<&str> = matched.iter().filter(|r| r.project_id.is_none()).map(|r| r.name.as_str()).collect();
    if !missing.is_empty() {
        return Err(format!("Faltan repositorios en este workspace: {}. Agrégalos o clónalos y vuelve a abrir el link.", missing.join(", ")));
    }
    let nick = nick.trim().to_string();
    if nick.is_empty() {
        return Err("Escribe un nick.".into());
    }

    let person_key = store::mint_secret();
    let remote = Remote::with_key(&invitation.url, &invitation.key, &person_key);
    let joined = remote.join(&invitation.token, &nick).await?;
    if crate::supabase::public_anon_key(&invitation.url)?.is_none() {
        crate::supabase::set_credentials(&invitation.url, &invitation.key)?;
    }
    store::set_person_key(&joined.session_id, &person_key)?;

    let slug = worktree::slug(&joined.session_id);
    let plan: Vec<(crate::collab::remote::RemoteRepo, JoinRepo)> = joined
        .repos
        .iter()
        .filter_map(|r| matched.iter().find(|m| m.key == r.repo_key).map(|m| (r.clone(), m.clone())))
        .collect();
    let session_id = joined.session_id.clone();
    let made = blocking(move || {
        let mut out = Vec::new();
        for (theirs, mine) in plan {
            let checkout = mine.path.clone().unwrap_or_default();
            worktree::fetch_base(&checkout, &theirs.base_sha)?;
            let target = worktree::default_dir(&theirs.name, &slug);
            let copy = worktree::create(&checkout, &target, &slug, &theirs.base_sha)?;
            out.push(store::Repo {
                session_id: session_id.clone(),
                repo_key: theirs.repo_key,
                name: theirs.name,
                project_id: mine.project_id.unwrap_or_default(),
                checkout_path: checkout,
                worktree_path: copy.path,
                branch: copy.branch,
                base_sha: theirs.base_sha,
                epoch: theirs.epoch,
                session_project_id: String::new(),
            });
        }
        Ok(out)
    })
    .await?;

    let chat_id = uuid::Uuid::new_v4().to_string();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::create_workspace_conversation(&conn, &chat_id, &workspace_id, "", None, "", "").map_err(|e| e.to_string())?;
        let _ = chat_queries::rename(&conn, &chat_id, &joined.name);
        store::insert_session(&conn, &store::Session {
            id: joined.session_id.clone(),
            project_url: crate::supabase::trimmed_url(&invitation.url),
            name: joined.name.clone(),
            role: "editor".into(),
            nick,
            person_id: joined.person_id.clone(),
            workspace_id,
            chat_id,
            status: "active".into(),
            last_seq: 0,
            created_at: String::new(),
        })
        .map_err(|e| e.to_string())?;
        for repo in &made {
            let ws = queries::get_project(&conn, &repo.project_id).map_err(|e| e.to_string())?.map(|p| p.workspace_id).unwrap_or_default();
            let shown = add_session_project(&conn, &ws, &repo.project_id, &repo.worktree_path)?;
            store::insert_repo(&conn, &store::Repo { session_project_id: shown, ..repo.clone() }).map_err(|e| e.to_string())?;
        }
    }
    view(&db, &joined.session_id)
}

#[tauri::command]
pub fn collab_session_for_chat(db: State<'_, Db>, chat_id: String) -> Result<Option<SessionView>, String> {
    let id = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::session_for_chat(&conn, &chat_id).map_err(|e| e.to_string())?.map(|s| s.id)
    };
    id.map(|id| view(&db, &id)).transpose()
}

#[tauri::command]
pub fn collab_sessions(db: State<'_, Db>, workspace_id: String) -> Result<Vec<SessionView>, String> {
    let ids: Vec<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::active_sessions(&conn, &workspace_id).map_err(|e| e.to_string())?.into_iter().map(|s| s.id).collect()
    };
    ids.iter().map(|id| view(&db, id)).collect()
}

/// One sync round (see `collab::sync`). The frontend runs it every few seconds per open session.
#[tauri::command]
pub async fn collab_tick(db: State<'_, Db>, session_id: String, live: Option<Vec<sync::LivePath>>) -> Result<sync::TickReport, String> {
    sync::tick(&db, &session_id, live.as_deref().unwrap_or_default()).await
}

/// Where the live channel connects: the session's Supabase project and its anon key (public by design;
/// the channel's secret comes with each sync round, from `cf_collab_watermark`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConnection {
    pub url: String,
    pub anon_key: String,
}

#[tauri::command]
pub fn collab_live_connection(db: State<'_, Db>, session_id: String) -> Result<LiveConnection, String> {
    let (session, _) = sync::load(&db, &session_id)?;
    let anon_key = crate::supabase::public_anon_key(&session.project_url)?.ok_or("falta la anon key del proyecto")?;
    Ok(LiveConnection { url: crate::supabase::trimmed_url(&session.project_url), anon_key })
}

/// The whole shared thread, for drawing a session's chat when it is opened.
#[tauri::command]
pub async fn collab_thread(db: State<'_, Db>, session_id: String) -> Result<Vec<crate::collab::remote::SharedMessage>, String> {
    let (session, _) = sync::load(&db, &session_id)?;
    let remote = sync::remote_for(&session)?;
    let mut all = Vec::new();
    let mut after = 0;
    loop {
        let page = remote.messages_after(&session_id, after).await?;
        let Some(last) = page.last().map(|m| m.seq) else { break };
        let full = page.len() >= 200;
        all.extend(page);
        after = last;
        if !full {
            break;
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn collab_resolve(db: State<'_, Db>, session_id: String, repo_key: String, path: String, keep_mine: bool) -> Result<(), String> {
    sync::resolve(&db, &session_id, &repo_key, &path, keep_mine).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    pub repo: String,
    pub commit: Option<String>,
    pub files: usize,
}

/// The host commits the session's shared files in each repository, pushes the session branch and
/// moves the session's base to that commit. The others follow on their next sync round.
#[tauri::command]
pub async fn collab_commit(db: State<'_, Db>, session_id: String, message: String) -> Result<Vec<Committed>, String> {
    let (session, repos) = sync::load(&db, &session_id)?;
    if session.role != "owner" {
        return Err("Solo el anfitrión hace commit durante la sesión.".into());
    }
    let message = if message.trim().is_empty() { format!("Sesión compartida: {}", session.name) } else { message };
    let remote = sync::remote_for(&session)?;
    let secret = store::owner_secret(&session_id)?;
    let mut out = Vec::new();
    for repo in repos {
        let (wt, base, msg, branch) = (repo.worktree_path.clone(), repo.base_sha.clone(), message.clone(), repo.branch.clone());
        let (commit, paths) = blocking(move || {
            let done = worktree::commit_shared(&wt, &base, &msg)?;
            if done.0.is_some() {
                worktree::push_branch(&wt, &branch)?;
            }
            Ok(done)
        })
        .await?;
        if let Some(sha) = &commit {
            let epoch = remote.advance_base(&session_id, &secret, &repo.repo_key, sha, &paths).await?;
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            store::set_base(&conn, &session_id, &repo.repo_key, sha, epoch).map_err(|e| e.to_string())?;
            store::drop_agreed_except(&conn, &session_id, &repo.repo_key, &[]).map_err(|e| e.to_string())?;
        }
        out.push(Committed { repo: repo.name, commit, files: paths.len() });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Left {
    pub repo: String,
    pub branch: String,
    pub commit: Option<String>,
    /// The worktree stayed on disk (it held files the session never shares).
    pub kept: bool,
    pub discarded: bool,
}

/// Leaves a session. `keep` commits this copy's work onto the session branch (which stays for a merge
/// or a push); otherwise the worktree and its branch are discarded. The host leaving ends the session
/// for everyone.
#[tauri::command]
pub async fn collab_leave(app: AppHandle, db: State<'_, Db>, session_id: String, keep: bool) -> Result<Vec<Left>, String> {
    let is_run = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::collab::team::is_run_session(&conn, &session_id)
    };
    if is_run {
        leave_run(&app, &db, &session_id).await?;
        return Ok(Vec::new());
    }
    let (session, repos) = sync::load(&db, &session_id)?;
    if session.role == "owner" {
        if let (Ok(remote), Ok(secret)) = (sync::remote_for(&session), store::owner_secret(&session_id)) {
            let _ = remote.end(&session_id, &secret).await;
        }
    }
    let name = session.name.clone();
    let out = blocking(move || {
        let mut out = Vec::new();
        for repo in repos {
            if keep {
                let closed = worktree::close(&repo.checkout_path, &repo.worktree_path, &repo.base_sha, &format!("Sesión compartida: {name}"))?;
                out.push(Left { repo: repo.name, branch: closed.branch, commit: closed.commit, kept: closed.kept, discarded: false });
            } else {
                let _ = crate::git::worktree::remove(&repo.checkout_path, &repo.worktree_path, true);
                let _ = crate::git::cli::run_in(&repo.checkout_path, &["branch", "-D", &repo.branch], &[]);
                out.push(Left { repo: repo.name, branch: repo.branch, commit: None, kept: false, discarded: true });
            }
        }
        Ok(out)
    })
    .await?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for repo in store::repos(&conn, &session_id).map_err(|e| e.to_string())? {
            if !repo.session_project_id.is_empty() {
                let _ = queries::delete_project(&conn, &repo.session_project_id);
            }
        }
        store::set_status(&conn, &session_id, "left").map_err(|e| e.to_string())?;
    }
    store::forget_credentials(&session_id);
    Ok(out)
}

/// The host removes one person from the session.
#[tauri::command]
pub async fn collab_remove_person(db: State<'_, Db>, session_id: String, person_id: String) -> Result<(), String> {
    let (session, _) = sync::load(&db, &session_id)?;
    let remote = sync::remote_for(&session)?;
    remote.remove_person(&session_id, &store::owner_secret(&session_id)?, &person_id).await
}

/// The SQL that sets up shared chats in a Supabase project, for the "copy" button.
#[tauri::command]
pub fn collab_install_sql() -> String {
    crate::collab::SCHEMA_SQL.to_string()
}

// ---------------------------------------------------------------------------
// Shared «Equipo» runs (`collab::team`)
// ---------------------------------------------------------------------------

/// A member of a run as the share dialog offers it: may it be a seat, and why not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatCandidate {
    pub member_id: String,
    pub name: String,
    pub role: String,
    pub engine: String,
    /// Why it cannot be a seat (the lead and sub-leads plan, and planning stays with the run).
    pub fixed: Option<String>,
}

#[tauri::command]
pub fn collab_run_candidates(db: State<'_, Db>, run_id: String) -> Result<Vec<SeatCandidate>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let run = crate::team::get_run(&conn, &run_id).map_err(|e| e.to_string())?.ok_or("la corrida ya no existe")?;
    Ok(run
        .members
        .iter()
        .map(|m| SeatCandidate {
            member_id: m.member.id.clone(),
            name: m.member.name.clone(),
            role: m.member.role.clone(),
            engine: m.provider.clone(),
            fixed: if m.member.id == run.lead {
                Some("lidera la corrida".into())
            } else if m.member.leads {
                Some("planifica una rama del equipo".into())
            } else {
                None
            },
        })
        .collect())
}

/// Shares an «Equipo» run: opens a session of kind `run` on the owner's Supabase project, makes the
/// chosen members seats for others, and mints the first invitation. Nothing about the run changes
/// until someone takes a seat.
#[tauri::command]
pub async fn collab_run_share(
    app: AppHandle,
    db: State<'_, Db>,
    run_id: String,
    project_url: String,
    nick: String,
    seats: Vec<String>,
) -> Result<Shared, String> {
    let nick = nick.trim().to_string();
    if nick.is_empty() {
        return Err("Escribe un nick.".into());
    }
    let (run, repos) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if crate::collab::team::session_of_run(&conn, &run_id).map_err(|e| e.to_string())?.is_some() {
            return Err("Esta corrida ya está compartida.".into());
        }
        let run = crate::team::get_run(&conn, &run_id).map_err(|e| e.to_string())?.ok_or("la corrida ya no existe")?;
        let repos = crate::team::list_repos(&conn, &run_id).map_err(|e| e.to_string())?;
        (run, repos)
    };
    if matches!(run.status.as_str(), "done" | "aborted" | "failed") {
        return Err("La corrida ya terminó.".into());
    }
    let allowed: Vec<String> = crate::collab::team::seatable(&run).into_iter().map(|m| m.member.id.clone()).collect();
    let seats: Vec<String> = seats.into_iter().filter(|s| allowed.contains(s)).collect();
    if seats.is_empty() {
        return Err("Elige al menos un puesto para otra persona.".into());
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let person_key = store::mint_secret();
    let owner_secret = store::mint_secret();
    let remote = Remote::new(&project_url, &person_key)?;
    remote.check_schema().await?;

    // Every repository needs a commit both machines have: its target branch on the shared remote.
    let checked = blocking(move || {
        let mut out = Vec::new();
        for r in repos {
            let key = crate::repo_identity::primary_remote(&r.local_path)
                .and_then(|url| crate::repo_identity::canonical_remote(&url))
                .ok_or_else(|| format!("{}: no tiene remoto", r.name))?;
            let tip = if r.integration_branch.is_empty() { r.target_branch.clone() } else { r.integration_branch.clone() };
            let basis = crate::collab::bundle::basis(&r.local_path, &tip, &r.target_branch).map_err(|e| format!("{}: {e}", r.name))?;
            out.push((r, key, basis));
        }
        Ok(out)
    })
    .await?;

    let title = if run.title.trim().is_empty() { run.team_name.clone() } else { run.title.clone() };
    let person_id = remote.create(&session_id, &title, &owner_secret, &nick).await.map_err(crate::collab::remote::friendly)?;
    for (r, key, basis) in &checked {
        remote.add_repo(&session_id, &owner_secret, key, &r.name, basis).await?;
    }
    let seat_rows: Vec<(String, String, String)> = run
        .members
        .iter()
        .filter(|m| seats.contains(&m.member.id))
        .map(|m| (m.member.id.clone(), m.member.name.clone(), m.member.role.clone()))
        .collect();
    remote.open_seats(&session_id, &owner_secret, &seat_rows).await?;
    store::set_person_key(&session_id, &person_key)?;
    store::set_owner_secret(&session_id, &owner_secret)?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::insert_session(&conn, &store::Session {
            id: session_id.clone(),
            project_url: crate::supabase::trimmed_url(&project_url),
            name: title.clone(),
            role: "owner".into(),
            nick: nick.clone(),
            person_id: person_id.clone(),
            workspace_id: run.workspace_id.clone(),
            chat_id: String::new(),
            status: "active".into(),
            last_seq: 0,
            created_at: String::new(),
        })
        .map_err(|e| e.to_string())?;
        crate::collab::team::record_share(&conn, &session_id, &run, &seats)?;
        for (r, key, basis) in &checked {
            store::insert_repo(&conn, &store::Repo {
                session_id: session_id.clone(),
                repo_key: key.clone(),
                name: r.name.clone(),
                project_id: r.project_id.clone(),
                checkout_path: r.local_path.clone(),
                worktree_path: String::new(),
                branch: String::new(),
                base_sha: basis.clone(),
                epoch: 0,
                session_project_id: String::new(),
            })
            .map_err(|e| e.to_string())?;
        }
    }
    let _ = app.emit("team:changed", serde_json::json!({ "runId": run.id }));
    let link = mint_link(&db, &session_id, &remote, &owner_secret).await?;
    Ok(Shared { view: view(&db, &session_id)?, link })
}

/// The shared session of a run, on its owner's machine.
#[tauri::command]
pub fn collab_run_for(db: State<'_, Db>, run_id: String) -> Result<Option<SessionView>, String> {
    let id = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::collab::team::session_of_run(&conn, &run_id).map_err(|e| e.to_string())?
    };
    id.map(|id| view(&db, &id)).transpose()
}

/// Every shared run of a workspace this machine is in, as its owner or as a guest: each needs its
/// round running (the owner's is what hands work off), whether or not its view is open.
#[tauri::command]
pub fn collab_run_sessions(db: State<'_, Db>, workspace_id: String) -> Result<Vec<SessionView>, String> {
    let ids: Vec<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id FROM collab_sessions s JOIN collab_runs r ON r.session_id = s.id
                 WHERE s.workspace_id = ?1 AND s.status = 'active' ORDER BY s.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&workspace_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    ids.iter().map(|id| view(&db, id)).collect()
}

/// One round of a shared run: the owner's or a guest's, by this machine's role in it.
#[tauri::command]
pub async fn collab_run_tick(app: AppHandle, db: State<'_, Db>, session_id: String) -> Result<crate::collab::team::RunTick, String> {
    let (session, _) = sync::load(&db, &session_id)?;
    if session.role == "owner" {
        crate::collab::team::owner_tick(&app, &db, &session_id).await
    } else {
        crate::collab::team::guest_tick(&db, &session_id).await
    }
}

/// The owner changes which members are seats.
#[tauri::command]
pub async fn collab_run_set_seats(app: AppHandle, db: State<'_, Db>, session_id: String, seats: Vec<String>) -> Result<(), String> {
    let (session, _) = sync::load(&db, &session_id)?;
    let remote = sync::remote_for(&session)?;
    let secret = store::owner_secret(&session_id)?;
    let run = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (run_id, _) = crate::collab::team::run_of_session(&conn, &session_id).map_err(|e| e.to_string())?.ok_or("no es una corrida compartida")?;
        crate::team::get_run(&conn, &run_id).map_err(|e| e.to_string())?.ok_or("la corrida ya no existe")?
    };
    let allowed: Vec<&crate::team::MemberSnap> = crate::collab::team::seatable(&run).into_iter().filter(|m| seats.contains(&m.member.id)).collect();
    let rows: Vec<(String, String, String)> = allowed.iter().map(|m| (m.member.id.clone(), m.member.name.clone(), m.member.role.clone())).collect();
    remote.open_seats(&session_id, &secret, &rows).await?;
    // The next round takes the seats in; withdrawn tasks come back with it.
    crate::collab::team::owner_tick(&app, &db, &session_id).await.map(|_| ())
}

#[tauri::command]
pub async fn collab_run_take_seat(db: State<'_, Db>, session_id: String, member_id: String, agent_id: String) -> Result<(), String> {
    crate::collab::team::take_seat(&db, &session_id, &member_id, &agent_id).await
}

#[tauri::command]
pub async fn collab_run_free_seat(db: State<'_, Db>, session_id: String, member_id: String) -> Result<(), String> {
    crate::collab::team::free_seat(&db, &session_id, &member_id).await
}

#[tauri::command]
pub async fn collab_run_accept(app: AppHandle, session_id: String, item_id: String) -> Result<(), String> {
    crate::collab::team::accept(&app, &session_id, &item_id).await
}

#[tauri::command]
pub async fn collab_run_decline(db: State<'_, Db>, session_id: String, item_id: String, reason: Option<String>) -> Result<(), String> {
    crate::collab::team::decline(&db, &session_id, &item_id, reason.as_deref().unwrap_or_default()).await
}

#[tauri::command]
pub async fn collab_run_note(db: State<'_, Db>, session_id: String, to: String, text: String) -> Result<(), String> {
    crate::collab::team::note(&db, &session_id, &to, &text).await
}

/// Joins a shared run: spends the invitation, and records which local clone is each repository.
/// No worktree is made yet: each accepted task gets its own.
async fn join_run(db: &Db, workspace_id: &str, invitation: &link::Invitation, nick: &str) -> Result<SessionView, String> {
    let matched = match_repos(db, workspace_id, invitation)?;
    let missing: Vec<&str> = matched.iter().filter(|r| r.project_id.is_none()).map(|r| r.name.as_str()).collect();
    if !missing.is_empty() {
        return Err(format!("Faltan repositorios en este workspace: {}. Agrégalos o clónalos y vuelve a abrir el link.", missing.join(", ")));
    }
    let nick = nick.trim().to_string();
    if nick.is_empty() {
        return Err("Escribe un nick.".into());
    }
    let person_key = store::mint_secret();
    let remote = Remote::with_key(&invitation.url, &invitation.key, &person_key);
    let joined = remote.join(&invitation.token, &nick).await?;
    if crate::supabase::public_anon_key(&invitation.url)?.is_none() {
        crate::supabase::set_credentials(&invitation.url, &invitation.key)?;
    }
    store::set_person_key(&joined.session_id, &person_key)?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::insert_session(&conn, &store::Session {
            id: joined.session_id.clone(),
            project_url: crate::supabase::trimmed_url(&invitation.url),
            name: joined.name.clone(),
            role: "editor".into(),
            nick,
            person_id: joined.person_id.clone(),
            workspace_id: workspace_id.to_string(),
            chat_id: String::new(),
            status: "active".into(),
            last_seq: 0,
            created_at: String::new(),
        })
        .map_err(|e| e.to_string())?;
        crate::collab::team::record_join(&conn, &joined.session_id, &joined.name)?;
        for theirs in &joined.repos {
            let Some(mine) = matched.iter().find(|m| m.key == theirs.repo_key) else { continue };
            store::insert_repo(&conn, &store::Repo {
                session_id: joined.session_id.clone(),
                repo_key: theirs.repo_key.clone(),
                name: theirs.name.clone(),
                project_id: mine.project_id.clone().unwrap_or_default(),
                checkout_path: mine.path.clone().unwrap_or_default(),
                worktree_path: String::new(),
                branch: String::new(),
                base_sha: theirs.base_sha.clone(),
                epoch: theirs.epoch,
                session_project_id: String::new(),
            })
            .map_err(|e| e.to_string())?;
        }
    }
    view(db, &joined.session_id)
}

/// Leaves a shared run. The owner ends it for everyone and every task out on another machine comes
/// back to be retried here; a guest gives their seats back.
async fn leave_run(app: &AppHandle, db: &Db, session_id: &str) -> Result<(), String> {
    let (session, _) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session).ok();
    if session.role == "owner" {
        if let (Some(remote), Ok(secret)) = (remote.as_ref(), store::owner_secret(session_id)) {
            let _ = remote.end(session_id, &secret).await;
        }
        crate::collab::team::stop_sharing(app, db, session_id).await?;
    } else {
        let mine: Vec<String> = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            crate::collab::team::seats(&conn, session_id).map_err(|e| e.to_string())?.into_iter().filter(|s| s.person_id == session.person_id).map(|s| s.member_id).collect()
        };
        if let Some(remote) = remote.as_ref() {
            for member in mine {
                let _ = remote.free_seat(session_id, &member, None).await;
            }
        }
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::set_status(&conn, session_id, if session.role == "owner" { "ended" } else { "left" }).map_err(|e| e.to_string())?;
    }
    store::forget_credentials(session_id);
    Ok(())
}
