//! One sync round of a session: what the frontend runs every few seconds while a session is open.
//!
//! A round, in order:
//!
//! 1. **Heartbeat**, so the others see this person as connected.
//! 2. **Base epochs.** A repository whose base moved (the host committed) is fetched and its worktree
//!    moved onto the new base without touching files ([`worktree::move_base`]).
//! 3. **Files.** For each repository, this machine's manifest, the session's records and the last
//!    agreed state go through [`reconcile::plan`]. Pushes upload the blob and record the new state
//!    against the version last seen, pulls write the state into the worktree, conflicts are recorded
//!    for the UI.
//! 4. **Thread.** Shared messages past the last one taken in.
//! 5. **People and locks**, for the avatars and the "turno en curso" notice.
//!
//! **Files open live** (stage E, `lib/collabLive` in the frontend) are the exception in step 3. Their
//! text belongs to the shared Yjs document while it is open, and the editor saves it on every machine,
//! so the disk follows the document. A pull or a conflict on one of them is therefore never written
//! here: it goes back in [`TickReport::live_remote`] for the frontend to merge into the document (or
//! to drop, when its author is in that document and the change is already there). Pushes go as usual —
//! they are what someone who does not have the file open receives.
//!
//! The database lock is never held across a network call: each step reads what it needs, drops the
//! guard, talks to Supabase, and locks again to write.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::manifest::{self, FileState};
use super::reconcile::{self, Action};
use super::remote::{Lock, Person, PutError, Remote, RemoteFile, SharedMessage};
use super::store::{self, Conflict, Repo, Session};
use super::worktree;
use crate::db::Db;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub session_id: String,
    pub pushed: Vec<String>,
    pub pulled: Vec<String>,
    pub conflicts: Vec<Conflict>,
    pub messages: Vec<SharedMessage>,
    pub people: Vec<Person>,
    pub locks: Vec<Lock>,
    /// Repositories whose base moved this round.
    pub rebased: Vec<String>,
    /// Files in the session (changed over the base), across repositories.
    pub session_files: usize,
    pub ended: bool,
    /// Problems that did not stop the round (one repository failing does not stop the others).
    pub errors: Vec<String>,
    /// The live channel's secret, for the frontend's Realtime connection.
    pub channel: Option<String>,
    /// This person's id in the session.
    pub me: Option<String>,
    /// What the session holds for files that are open live here, instead of writing them.
    pub live_remote: Vec<LiveRemote>,
}

/// A file the frontend has open in a live document.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct LivePath {
    pub repo_key: String,
    pub path: String,
}

/// The session's state of a live file, when it differs from this machine's disk.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRemote {
    pub repo_key: String,
    pub path: String,
    /// `None` when the session has it deleted, or its content is not text.
    pub text: Option<String>,
    pub deleted: bool,
    /// Who wrote the session's state (a person id).
    pub updated_by: Option<String>,
}

pub(crate) fn load(db: &Db, session_id: &str) -> Result<(Session, Vec<Repo>), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let session = store::session(&conn, session_id).map_err(|e| e.to_string())?.ok_or("sesión desconocida")?;
    let repos = store::repos(&conn, session_id).map_err(|e| e.to_string())?;
    Ok((session, repos))
}

pub(crate) fn remote_for(session: &Session) -> Result<Remote, String> {
    Remote::new(&session.project_url, &store::person_key(&session.id)?)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Runs one round. Errors that concern one repository go into the report; only a failure to reach
/// the session at all is an `Err`.
pub async fn tick(db: &Db, session_id: &str, live: &[LivePath]) -> Result<TickReport, String> {
    let (session, repos) = load(db, session_id)?;
    let remote = remote_for(&session)?;
    let mut report = TickReport { session_id: session_id.to_string(), ..Default::default() };

    let _ = remote.heartbeat(session_id).await;
    let watermark = remote.watermark(session_id).await?;
    report.ended = watermark.ended.is_some();
    report.channel = watermark.channel.clone();
    report.me = watermark.me.clone();

    report.people = remote.people(session_id).await.unwrap_or_default();
    let nicks: HashMap<String, String> = report.people.iter().map(|p| (p.id.clone(), p.nick.clone())).collect();

    // 2. Bases that moved.
    let remote_repos = remote.repos(session_id).await?;
    let mut repos = repos;
    for repo in repos.iter_mut() {
        let Some(theirs) = remote_repos.iter().find(|r| r.repo_key == repo.repo_key) else { continue };
        if theirs.epoch <= repo.epoch || theirs.base_sha == repo.base_sha {
            if theirs.epoch > repo.epoch {
                repo.epoch = theirs.epoch;
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                let _ = store::set_base(&conn, session_id, &repo.repo_key, &repo.base_sha, repo.epoch);
            }
            continue;
        }
        let (checkout, wt, base) = (repo.checkout_path.clone(), repo.worktree_path.clone(), theirs.base_sha.clone());
        match blocking(move || {
            worktree::fetch_base(&checkout, &base)?;
            worktree::move_base(&wt, &base)
        })
        .await
        {
            Ok(()) => {
                repo.base_sha = theirs.base_sha.clone();
                repo.epoch = theirs.epoch;
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                let _ = store::set_base(&conn, session_id, &repo.repo_key, &repo.base_sha, repo.epoch);
                report.rebased.push(repo.name.clone());
            }
            Err(e) => report.errors.push(format!("{}: {e}", repo.name)),
        }
    }

    // 3. Files.
    let all_files = remote.files(session_id).await?;
    for repo in &repos {
        let empty = BTreeMap::new();
        let theirs = all_files.get(&repo.repo_key).unwrap_or(&empty);
        let live: HashSet<&str> = live.iter().filter(|l| l.repo_key == repo.repo_key).map(|l| l.path.as_str()).collect();
        match sync_repo(db, &remote, &session, repo, theirs, &nicks, &live, &mut report).await {
            Ok(count) => report.session_files += count,
            Err(e) => report.errors.push(format!("{}: {e}", repo.name)),
        }
    }

    // 4. Thread.
    report.messages = remote.messages_after(session_id, session.last_seq).await.unwrap_or_default();
    if let Some(last) = report.messages.last() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = store::set_last_seq(&conn, session_id, last.seq);
    }

    // 5. Locks, and the conflicts as they stand after this round.
    report.locks = remote.locks(session_id).await.unwrap_or_default();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        report.conflicts = store::conflicts(&conn, session_id).unwrap_or_default();
    }
    Ok(report)
}

/// Syncs one repository. Returns how many files the session holds for it after the round.
async fn sync_repo(
    db: &Db,
    remote: &Remote,
    session: &Session,
    repo: &Repo,
    theirs: &BTreeMap<String, RemoteFile>,
    nicks: &HashMap<String, String>,
    live: &HashSet<&str>,
    report: &mut TickReport,
) -> Result<usize, String> {
    let (wt, base) = (repo.worktree_path.clone(), repo.base_sha.clone());
    let local = blocking(move || manifest::scan(&wt, &base)).await?;

    let agreed_full = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::agreed(&conn, &session.id, &repo.repo_key).map_err(|e| e.to_string())?
    };
    let agreed: BTreeMap<String, FileState> = agreed_full.iter().map(|(p, (s, _))| (p.clone(), s.clone())).collect();
    let remote_states: BTreeMap<String, FileState> = theirs.iter().map(|(p, f)| (p.clone(), f.state.clone())).collect();
    let version_of = |path: &str| theirs.get(path).map(|f| f.version).unwrap_or(0);

    let plan = reconcile::plan(&agreed, &local.files, &remote_states);
    let mut still_conflicting: Vec<String> = Vec::new();
    for (path, action) in plan {
        let local_state = manifest::state_of(&local.files, &path).clone();
        let remote_state = manifest::state_of(&remote_states, &path).clone();
        if live.contains(path.as_str()) && matches!(action, Action::Pull | Action::Conflict) {
            match live_remote(remote, session, repo, &path, &remote_state).await {
                Ok((text, deleted)) => report.live_remote.push(LiveRemote {
                    repo_key: repo.repo_key.clone(),
                    path: path.clone(),
                    text,
                    deleted,
                    updated_by: theirs.get(&path).and_then(|f| f.updated_by.clone()),
                }),
                Err(e) => report.errors.push(format!("{}/{path}: {e}", repo.name)),
            }
            continue;
        }
        let result = match action {
            Action::Push => push(remote, session, repo, &path, &local_state, version_of(&path)).await.map(|v| {
                report.pushed.push(path.clone());
                Some((local_state.clone(), v))
            }),
            Action::Pull => pull(remote, session, repo, &path, &remote_state).await.map(|()| {
                report.pulled.push(path.clone());
                Some((remote_state.clone(), version_of(&path)))
            }),
            Action::Settle => Ok(Some((local_state.clone(), version_of(&path)))),
            Action::Conflict => {
                still_conflicting.push(path.clone());
                let by = theirs.get(&path).and_then(|f| f.updated_by.as_ref()).and_then(|id| nicks.get(id)).cloned().unwrap_or_default();
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                let _ = store::set_conflict(&conn, &session.id, &Conflict {
                    repo_key: repo.repo_key.clone(),
                    path: path.clone(),
                    local: local_state.clone(),
                    remote: remote_state.clone(),
                    remote_by: by,
                    detected_at: String::new(),
                });
                Ok(None)
            }
        };
        match result {
            Ok(Some((state, version))) => {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                let _ = store::set_agreed(&conn, &session.id, &repo.repo_key, &path, &state, version);
                let _ = store::clear_conflict(&conn, &session.id, &repo.repo_key, &path);
            }
            Ok(None) => {}
            // Two machines saving the same live document a moment apart: the next round settles it.
            Err(_) if live.contains(path.as_str()) => {}
            Err(e) => report.errors.push(format!("{}/{path}: {e}", repo.name)),
        }
    }

    // A conflict that this round no longer sees (someone resolved it by hand, or both converged) goes.
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for c in store::conflicts(&conn, &session.id).unwrap_or_default() {
            if c.repo_key == repo.repo_key && !still_conflicting.contains(&c.path) {
                let _ = store::clear_conflict(&conn, &session.id, &repo.repo_key, &c.path);
            }
        }
        // Paths the session stopped recording (the base moved past them) are agreed at the base again.
        let keep: Vec<String> = theirs.keys().cloned().collect();
        let _ = store::drop_agreed_except(&conn, &session.id, &repo.repo_key, &keep);
    }
    Ok(theirs.values().filter(|f| f.state != FileState::Base).count().max(local.files.len()))
}

/// Uploads a local state. The bytes are re-read and re-hashed: the file may have changed since the
/// scan, and what gets recorded must be what was uploaded.
pub(crate) async fn push(remote: &Remote, session: &Session, repo: &Repo, path: &str, state: &FileState, expected: i64) -> Result<i64, String> {
    let mut state = state.clone();
    if let FileState::Present { .. } = state {
        let rel = worktree::safe_relative(path)?;
        let full = std::path::Path::new(&repo.worktree_path).join(rel);
        let bytes = blocking(move || std::fs::read(&full).map_err(|e| e.to_string())).await?;
        let sha = manifest::hash_bytes(&bytes);
        let binary = bytes.iter().take(8000).any(|b| *b == 0);
        state = FileState::Present { sha: sha.clone(), size: bytes.len() as u64, binary };
        remote.put_blob(&session.id, &sha, &bytes).await?;
    }
    match remote.put_file(&session.id, &repo.repo_key, path, expected, &state).await {
        Ok(version) => Ok(version),
        Err(PutError::Conflict(v)) => Err(format!("alguien lo cambió antes (versión {v}); se reintenta en la próxima vuelta")),
        Err(PutError::Other(e)) => Err(e),
    }
}

/// Writes the session's state of `path` into this machine's worktree.
pub(crate) async fn pull(remote: &Remote, session: &Session, repo: &Repo, path: &str, state: &FileState) -> Result<(), String> {
    let bytes = match state {
        FileState::Present { sha, .. } => Some(remote.blob(&session.id, sha).await?),
        _ => None,
    };
    let (wt, base, path, state) = (repo.worktree_path.clone(), repo.base_sha.clone(), path.to_string(), state.clone());
    blocking(move || worktree::write_state(&wt, &base, &path, &state, bytes.as_deref())).await
}

/// The text of the session's state of a live file, without writing it: `(text, deleted)`.
async fn live_remote(remote: &Remote, session: &Session, repo: &Repo, path: &str, state: &FileState) -> Result<(Option<String>, bool), String> {
    let bytes = match state {
        FileState::Present { binary: true, .. } => return Ok((None, false)),
        FileState::Present { sha, .. } => Some(remote.blob(&session.id, sha).await?),
        FileState::Deleted => return Ok((None, true)),
        FileState::Base => {
            let (wt, base, path) = (repo.worktree_path.clone(), repo.base_sha.clone(), path.to_string());
            blocking(move || worktree::base_text(&wt, &base, &path)).await?
        }
    };
    Ok(match bytes {
        Some(bytes) => (String::from_utf8(bytes).ok(), false),
        None => (None, true),
    })
}

/// Settles a recorded conflict by the person's choice: `mine` records the local state over the
/// session's, `theirs` writes the session's state into the worktree.
pub async fn resolve(db: &Db, session_id: &str, repo_key: &str, path: &str, keep_mine: bool) -> Result<(), String> {
    let (session, repos) = load(db, session_id)?;
    let repo = repos.into_iter().find(|r| r.repo_key == repo_key).ok_or("repositorio desconocido en la sesión")?;
    let remote = remote_for(&session)?;
    let files = remote.files(session_id).await?;
    let theirs = files.get(repo_key).and_then(|m| m.get(path)).cloned();
    let version = theirs.as_ref().map(|f| f.version).unwrap_or(0);
    let state = if keep_mine {
        let (wt, base) = (repo.worktree_path.clone(), repo.base_sha.clone());
        let local = blocking(move || manifest::scan(&wt, &base)).await?;
        let mine = manifest::state_of(&local.files, path).clone();
        let v = push(&remote, &session, &repo, path, &mine, version).await?;
        (mine, v)
    } else {
        let remote_state = theirs.map(|f| f.state).unwrap_or(FileState::Base);
        pull(&remote, &session, &repo, path, &remote_state).await?;
        (remote_state, version)
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::set_agreed(&conn, session_id, repo_key, path, &state.0, state.1).map_err(|e| e.to_string())?;
    store::clear_conflict(&conn, session_id, repo_key, path).map_err(|e| e.to_string())
}
