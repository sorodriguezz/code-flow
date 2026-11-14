//! The session's side in Supabase, over PostgREST: the functions of `collab_schema.sql` and the reads
//! its policies allow. No client library, the same way `supabase.rs` works. Every request sends the
//! project's anon key and this person's key in `x-cf-person`.

use std::collections::BTreeMap;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::manifest::FileState;
use crate::supabase;

pub const PERSON_HEADER: &str = "x-cf-person";

/// Where and as whom: one project, one person in it.
#[derive(Clone)]
pub struct Remote {
    url: String,
    anon_key: String,
    person_key: String,
}

impl Remote {
    pub fn new(project_url: &str, person_key: &str) -> Result<Self, String> {
        let anon_key = supabase::public_anon_key(project_url)?
            .ok_or_else(|| format!("no hay anon key guardada para {}", supabase::trimmed_url(project_url)))?;
        Ok(Self { url: supabase::trimmed_url(project_url), anon_key, person_key: person_key.to_string() })
    }

    /// For a joiner who has the anon key from the invitation but nothing stored yet.
    pub fn with_key(project_url: &str, anon_key: &str, person_key: &str) -> Self {
        Self { url: supabase::trimmed_url(project_url), anon_key: anon_key.to_string(), person_key: person_key.to_string() }
    }

    /// Whether this project can hold sessions: the script is there and is the one this build speaks.
    pub async fn check_schema(&self) -> Result<(), String> {
        let version = self.rpc("cf_collab_version", json!({})).await.map_err(friendly)?;
        match version.as_i64() {
            Some(v) if v >= super::SCHEMA_VERSION => Ok(()),
            Some(v) => Err(format!(
                "El SQL de chats compartidos de este proyecto es de una versión anterior ({v}; esta versión de CodeFlow usa la {}). Cópialo de nuevo y córrelo en el SQL editor: es idempotente.",
                super::SCHEMA_VERSION
            )),
            None => Err(format!("cf_collab_version devolvió algo inesperado: {version}")),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> Result<reqwest::RequestBuilder, String> {
        let http = supabase::client()?;
        Ok(http
            .request(method, format!("{}/rest/v1/{path}", self.url))
            .header("apikey", &self.anon_key)
            .bearer_auth(&self.anon_key)
            .header(PERSON_HEADER, &self.person_key))
    }

    async fn rpc(&self, function: &str, body: Value) -> Result<Value, String> {
        let response = self
            .request(reqwest::Method::POST, &format!("rpc/{function}"))?
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let text = supabase::read_body(response).await?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| format!("{function}: {e}"))
    }

    async fn select(&self, path_and_query: &str) -> Result<Value, String> {
        let response = self.request(reqwest::Method::GET, path_and_query)?.send().await.map_err(|e| e.to_string())?;
        let text = supabase::read_body(response).await?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    async fn insert(&self, table: &str, rows: Value, ignore_duplicates: bool) -> Result<(), String> {
        let mut request = self.request(reqwest::Method::POST, table)?.json(&rows);
        request = request.header(
            "Prefer",
            if ignore_duplicates { "resolution=ignore-duplicates,return=minimal" } else { "return=minimal" },
        );
        let response = request.send().await.map_err(|e| e.to_string())?;
        supabase::read_body(response).await.map(|_| ())
    }

    // -----------------------------------------------------------------------
    // Sessions and people
    // -----------------------------------------------------------------------

    /// Opens a session with this person as its host. Returns the host's person id.
    pub async fn create(&self, id: &str, name: &str, owner_secret: &str, nick: &str) -> Result<String, String> {
        let value = self
            .rpc(
                "cf_collab_create",
                json!({
                    "p_id": id, "p_name": name, "p_owner_hash": sha(owner_secret),
                    "p_nick": nick, "p_key_hash": sha(&self.person_key),
                }),
            )
            .await?;
        value.as_str().map(str::to_string).ok_or_else(|| "cf_collab_create no devolvió una persona".into())
    }

    pub async fn add_repo(&self, session: &str, owner_secret: &str, repo_key: &str, name: &str, base: &str) -> Result<(), String> {
        self.rpc(
            "cf_collab_add_repo",
            json!({ "p_session": session, "p_owner_secret": owner_secret, "p_repo_key": repo_key, "p_name": name, "p_base": base }),
        )
        .await
        .map(|_| ())
    }

    /// A new single-use invitation token. Only its hash reaches the project.
    pub async fn invite(&self, session: &str, owner_secret: &str, token: &str, hours: i64) -> Result<String, String> {
        let value = self
            .rpc(
                "cf_collab_invite",
                json!({ "p_session": session, "p_owner_secret": owner_secret, "p_token_hash": sha(token), "p_hours": hours }),
            )
            .await?;
        Ok(value.as_str().unwrap_or_default().to_string())
    }

    pub async fn join(&self, token: &str, nick: &str) -> Result<Joined, String> {
        let value = self
            .rpc("cf_collab_join", json!({ "p_token": token, "p_nick": nick, "p_key_hash": sha(&self.person_key) }))
            .await
            .map_err(friendly)?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    pub async fn heartbeat(&self, session: &str) -> Result<(), String> {
        self.rpc("cf_collab_heartbeat", json!({ "p_session": session })).await.map(|_| ())
    }

    pub async fn people(&self, session: &str) -> Result<Vec<Person>, String> {
        let value = self
            .select(&format!(
                "cf_collab_people?session_id=eq.{session}&removed_at=is.null&select=id,nick,role,last_seen&order=joined_at.asc"
            ))
            .await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    pub async fn remove_person(&self, session: &str, owner_secret: &str, person: &str) -> Result<(), String> {
        self.rpc("cf_collab_remove_person", json!({ "p_session": session, "p_owner_secret": owner_secret, "p_person": person }))
            .await
            .map(|_| ())
    }

    pub async fn end(&self, session: &str, owner_secret: &str) -> Result<(), String> {
        self.rpc("cf_collab_end", json!({ "p_session": session, "p_owner_secret": owner_secret })).await.map(|_| ())
    }

    pub async fn repos(&self, session: &str) -> Result<Vec<RemoteRepo>, String> {
        let value = self.select(&format!("cf_collab_repos?session_id=eq.{session}&select=repo_key,name,base_sha,epoch")).await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    pub async fn advance_base(&self, session: &str, owner_secret: &str, repo_key: &str, base: &str, paths: &[String]) -> Result<i64, String> {
        let value = self
            .rpc(
                "cf_collab_advance_base",
                json!({ "p_session": session, "p_owner_secret": owner_secret, "p_repo_key": repo_key, "p_base": base, "p_paths": paths }),
            )
            .await?;
        Ok(value.as_i64().unwrap_or_default())
    }

    pub async fn watermark(&self, session: &str) -> Result<Watermark, String> {
        let value = self.rpc("cf_collab_watermark", json!({ "p_session": session })).await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    // -----------------------------------------------------------------------
    // Files and blobs
    // -----------------------------------------------------------------------

    /// Every file record of the session, by repository then path.
    pub async fn files(&self, session: &str) -> Result<BTreeMap<String, BTreeMap<String, RemoteFile>>, String> {
        let value = self
            .select(&format!(
                "cf_collab_files?session_id=eq.{session}&select=repo_key,path,state,sha,size,is_binary,version,updated_by"
            ))
            .await?;
        let rows: Vec<FileRow> = serde_json::from_value(value).map_err(|e| e.to_string())?;
        let mut out: BTreeMap<String, BTreeMap<String, RemoteFile>> = BTreeMap::new();
        for row in rows {
            out.entry(row.repo_key.clone()).or_default().insert(row.path.clone(), row.into_remote());
        }
        Ok(out)
    }

    pub async fn put_blob(&self, session: &str, sha: &str, bytes: &[u8]) -> Result<(), String> {
        let content = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.insert("cf_collab_blobs?on_conflict=session_id,sha", json!([{ "session_id": session, "sha": sha, "content_b64": content }]), true)
            .await
    }

    pub async fn blob(&self, session: &str, sha: &str) -> Result<Vec<u8>, String> {
        let value = self.select(&format!("cf_collab_blobs?session_id=eq.{session}&sha=eq.{sha}&select=content_b64")).await?;
        let content = value
            .get(0)
            .and_then(|row| row.get("content_b64"))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("falta el contenido {sha}"))?;
        base64::engine::general_purpose::STANDARD.decode(content).map_err(|e| e.to_string())
    }

    /// Records a file's new state against the version last seen. `Err(PutError::Conflict(v))` when
    /// someone moved it meanwhile.
    pub async fn put_file(&self, session: &str, repo_key: &str, path: &str, expected: i64, state: &FileState) -> Result<i64, PutError> {
        let (kind, sha, size, binary) = match state {
            FileState::Base => ("base", Value::Null, Value::Null, false),
            FileState::Deleted => ("deleted", Value::Null, Value::Null, false),
            FileState::Present { sha, size, binary } => ("present", json!(sha), json!(size), *binary),
        };
        let result = self
            .rpc(
                "cf_collab_put_file",
                json!({
                    "p_session": session, "p_repo_key": repo_key, "p_path": path, "p_expected": expected,
                    "p_state": kind, "p_sha": sha, "p_size": size, "p_binary": binary,
                }),
            )
            .await;
        match result {
            Ok(value) => Ok(value.as_i64().unwrap_or(expected + 1)),
            Err(message) => Err(match conflict_version(&message) {
                Some(version) => PutError::Conflict(version),
                None => PutError::Other(message),
            }),
        }
    }

    // -----------------------------------------------------------------------
    // The shared thread and turn locks
    // -----------------------------------------------------------------------

    pub async fn post(&self, session: &str, person: &str, id: &str, kind: &str, body: &Value) -> Result<(), String> {
        self.insert(
            "cf_collab_messages?on_conflict=id",
            json!([{ "id": id, "session_id": session, "person_id": person, "kind": kind, "body": body }]),
            true,
        )
        .await
    }

    pub async fn messages_after(&self, session: &str, seq: i64) -> Result<Vec<SharedMessage>, String> {
        let value = self
            .select(&format!(
                "cf_collab_messages?session_id=eq.{session}&seq=gt.{seq}&order=seq.asc&limit=200&select=seq,id,person_id,kind,body,created_at"
            ))
            .await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// Takes every repository in `repos` for `turn`, or none: `false` when another turn holds one.
    pub async fn lock(&self, session: &str, repos: &[String], turn: &str, ttl_seconds: i64) -> Result<bool, String> {
        let value = self
            .rpc("cf_collab_lock", json!({ "p_session": session, "p_repos": repos, "p_turn": turn, "p_ttl_seconds": ttl_seconds }))
            .await?;
        Ok(value.as_bool().unwrap_or(false))
    }

    pub async fn unlock(&self, session: &str, turn: &str) -> Result<(), String> {
        self.rpc("cf_collab_unlock", json!({ "p_session": session, "p_turn": turn })).await.map(|_| ())
    }

    pub async fn locks(&self, session: &str) -> Result<Vec<Lock>, String> {
        let value = self
            .select(&format!("cf_collab_locks?session_id=eq.{session}&select=repo_key,person_id,turn_id,expires_at"))
            .await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
}

/// SHA-256 (hex) of a secret, the way `cf_collab_hash` computes it on the server.
pub fn sha(secret: &str) -> String {
    super::manifest::hash_bytes(secret.as_bytes())
}

/// `cf_conflict:<n>` in an error message, as the version the server holds.
pub fn conflict_version(message: &str) -> Option<i64> {
    let rest = message.split("cf_conflict:").nth(1)?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// The server's error codes in the words the join dialog shows.
/// A project whose SQL editor never ran `collab_schema.sql`: PostgREST cannot find the function or
/// the table it was asked for.
pub fn schema_missing(message: &str) -> bool {
    message.contains("PGRST202")
        || message.contains("PGRST205")
        || message.contains("Could not find the function")
        || message.contains("Could not find the table")
        || (message.contains("cf_collab_") && message.contains("does not exist"))
}

pub const SCHEMA_MISSING: &str = "Este proyecto Supabase no tiene instalado el SQL de chats compartidos. Cópialo desde el diálogo de compartir y córrelo una vez en el SQL editor del proyecto.";

pub fn friendly(message: String) -> String {
    if schema_missing(&message) {
        return SCHEMA_MISSING.to_string();
    }
    let known = [
        ("cf_invite_unknown", "La invitación no existe. Pide un link nuevo."),
        ("cf_invite_used", "Esa invitación ya se usó. Pide un link nuevo."),
        ("cf_invite_expired", "La invitación venció. Pide un link nuevo."),
        ("cf_session_ended", "La sesión ya terminó."),
        ("cf_nick_taken", "Ese nick ya está en uso en la sesión. Elige otro."),
        ("cf_nick_required", "Escribe un nick."),
        ("cf_not_member", "Ya no eres parte de esta sesión."),
        ("cf_not_owner", "Solo el anfitrión puede hacer esto."),
        ("cf_seat_taken", "Ese puesto ya lo ocupó otra persona."),
        ("cf_seat_free", "Ese puesto quedó libre: nadie puede tomar su tarea ahora."),
        ("cf_task_gone", "Esa tarea ya no te espera: el anfitrión la retiró o la volvió a ofrecer."),
        ("cf_too_large", "La corrida es demasiado grande para publicarla entera."),
    ];
    known.iter().find(|(code, _)| message.contains(code)).map(|(_, text)| text.to_string()).unwrap_or(message)
}

#[derive(Debug)]
pub enum PutError {
    Conflict(i64),
    Other(String),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Joined {
    pub session_id: String,
    pub name: String,
    pub person_id: String,
    pub repos: Vec<RemoteRepo>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RemoteRepo {
    pub repo_key: String,
    pub name: String,
    pub base_sha: String,
    #[serde(default)]
    pub epoch: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub nick: String,
    pub role: String,
    #[serde(alias = "last_seen")]
    pub last_seen: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct Watermark {
    pub files: Option<String>,
    pub messages: Option<i64>,
    #[serde(default)]
    pub epochs: i64,
    pub ended: Option<String>,
    /// The live channel's secret (schema 2): see `collab_schema.sql`.
    #[serde(default)]
    pub channel: Option<String>,
    /// This person's id in the session.
    #[serde(default)]
    pub me: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileRow {
    repo_key: String,
    path: String,
    state: String,
    sha: Option<String>,
    size: Option<i64>,
    is_binary: bool,
    version: i64,
    updated_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteFile {
    pub state: FileState,
    pub version: i64,
    pub updated_by: Option<String>,
}

impl FileRow {
    fn into_remote(self) -> RemoteFile {
        let state = match (self.state.as_str(), self.sha) {
            ("present", Some(sha)) => FileState::Present { sha, size: self.size.unwrap_or(0).max(0) as u64, binary: self.is_binary },
            ("deleted", _) => FileState::Deleted,
            _ => FileState::Base,
        };
        RemoteFile { state, version: self.version, updated_by: self.updated_by }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedMessage {
    pub seq: i64,
    pub id: String,
    #[serde(alias = "person_id")]
    pub person_id: Option<String>,
    pub kind: String,
    pub body: Value,
    #[serde(alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    #[serde(alias = "repo_key")]
    pub repo_key: String,
    #[serde(alias = "person_id")]
    pub person_id: String,
    #[serde(alias = "turn_id")]
    pub turn_id: String,
    #[serde(alias = "expires_at")]
    pub expires_at: String,
}

// ---------------------------------------------------------------------------
// Shared «Equipo» runs (schema 3)
// ---------------------------------------------------------------------------

/// A member of a shared run that someone other than its owner fills.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    #[serde(alias = "member_id")]
    pub member_id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// Who is in it, `None` while it is free.
    #[serde(alias = "person_id")]
    pub person_id: Option<String>,
    /// The agent's name on its person's machine, and its engine id. Nothing else about it.
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub engine: String,
}

/// One seat's task, as the owner offered it and as its person answered.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTask {
    #[serde(alias = "item_id")]
    pub item_id: String,
    pub attempt: i64,
    #[serde(alias = "member_id")]
    pub member_id: String,
    #[serde(alias = "person_id")]
    pub person_id: String,
    #[serde(alias = "repo_key")]
    pub repo_key: String,
    /// `work` or `review`.
    pub kind: String,
    pub title: String,
    pub message: String,
    /// Whether the task changes code (`work`); a review only reads.
    pub writes: bool,
    /// The run's target branch: the basis both machines share is on it.
    pub target: String,
    #[serde(alias = "start_sha")]
    pub start_sha: String,
    #[serde(alias = "start_bundle", default)]
    pub start_bundle: Option<String>,
    /// `offered`, `accepted`, `done`, `failed`, `declined` or `withdrawn`.
    pub status: String,
    #[serde(alias = "result_text", default)]
    pub result_text: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(alias = "result_sha", default)]
    pub result_sha: Option<String>,
    #[serde(alias = "result_bundle", default)]
    pub result_bundle: Option<String>,
    #[serde(alias = "updated_at", default)]
    pub updated_at: String,
}

/// What the owner offers: a [`RemoteTask`] before anyone answered it.
#[derive(Debug, Clone, Serialize)]
pub struct Offer<'a> {
    pub item_id: &'a str,
    pub attempt: i64,
    pub member_id: &'a str,
    pub repo_key: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub message: &'a str,
    pub writes: bool,
    pub target: &'a str,
    pub start_sha: &'a str,
    pub start_bundle: Option<&'a str>,
}

const TASK_COLS: &str = "item_id,attempt,member_id,person_id,repo_key,kind,title,message,writes,target,start_sha,start_bundle,status,result_text,error,result_sha,result_bundle,updated_at";

impl Remote {
    pub async fn open_seats(&self, session: &str, owner_secret: &str, seats: &[(String, String, String)]) -> Result<(), String> {
        let seats: Vec<Value> = seats.iter().map(|(id, name, role)| json!({ "member_id": id, "name": name, "role": role })).collect();
        self.rpc("cf_collab_open_seats", json!({ "p_session": session, "p_owner_secret": owner_secret, "p_seats": seats }))
            .await
            .map(|_| ())
            .map_err(friendly)
    }

    pub async fn seats(&self, session: &str) -> Result<Vec<Seat>, String> {
        let value = self
            .select(&format!("cf_collab_seats?session_id=eq.{session}&select=member_id,name,role,person_id,agent,engine&order=member_id.asc"))
            .await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    pub async fn take_seat(&self, session: &str, member: &str, agent: &str, engine: &str) -> Result<(), String> {
        self.rpc("cf_collab_take_seat", json!({ "p_session": session, "p_member": member, "p_agent": agent, "p_engine": engine }))
            .await
            .map(|_| ())
            .map_err(friendly)
    }

    /// Gives a seat back: one's own, or (with the owner secret) anyone's.
    pub async fn free_seat(&self, session: &str, member: &str, owner_secret: Option<&str>) -> Result<(), String> {
        self.rpc("cf_collab_free_seat", json!({ "p_session": session, "p_member": member, "p_owner_secret": owner_secret.unwrap_or("") }))
            .await
            .map(|_| ())
            .map_err(friendly)
    }

    pub async fn offer(&self, session: &str, owner_secret: &str, offer: &Offer<'_>) -> Result<(), String> {
        self.rpc("cf_collab_offer", json!({ "p_session": session, "p_owner_secret": owner_secret, "p_task": offer }))
            .await
            .map(|_| ())
            .map_err(friendly)
    }

    pub async fn withdraw(&self, session: &str, owner_secret: &str, item: &str) -> Result<(), String> {
        self.rpc("cf_collab_withdraw", json!({ "p_session": session, "p_owner_secret": owner_secret, "p_item": item }))
            .await
            .map(|_| ())
    }

    /// Every task of the session, or only those offered to `person`.
    pub async fn tasks(&self, session: &str, person: Option<&str>) -> Result<Vec<RemoteTask>, String> {
        let filter = person.map(|p| format!("&person_id=eq.{p}")).unwrap_or_default();
        let value = self.select(&format!("cf_collab_tasks?session_id=eq.{session}{filter}&select={TASK_COLS}&order=created_at.asc")).await?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn report(
        &self,
        session: &str,
        item: &str,
        attempt: i64,
        status: &str,
        text: &str,
        error: &str,
        sha: &str,
        bundle: &str,
    ) -> Result<(), String> {
        self.rpc(
            "cf_collab_report",
            json!({
                "p_session": session, "p_item": item, "p_attempt": attempt, "p_status": status,
                "p_text": text, "p_error": error, "p_sha": sha, "p_bundle": bundle
            }),
        )
        .await
        .map(|_| ())
        .map_err(friendly)
    }

    pub async fn publish_run(&self, session: &str, owner_secret: &str, state: &Value) -> Result<(), String> {
        self.rpc("cf_collab_publish_run", json!({ "p_session": session, "p_owner_secret": owner_secret, "p_state": state }))
            .await
            .map(|_| ())
    }

    /// The owner's latest picture of the run, `None` before the first.
    pub async fn run_state(&self, session: &str) -> Result<Option<Value>, String> {
        let value = self.select(&format!("cf_collab_runs?session_id=eq.{session}&select=state")).await?;
        Ok(value.get(0).and_then(|row| row.get("state")).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_versions_are_read_out_of_the_error() {
        assert_eq!(conflict_version("cf_conflict:7"), Some(7));
        assert_eq!(conflict_version("P0001: cf_conflict:12 (hint)"), Some(12));
        assert_eq!(conflict_version("cf_blob_missing"), None);
    }

    #[test]
    fn server_codes_become_sentences() {
        assert_eq!(friendly("cf_nick_taken".into()), "Ese nick ya está en uso en la sesión. Elige otro.");
        assert_eq!(friendly("network down".into()), "network down");
    }

    #[test]
    fn file_rows_become_states() {
        let row: FileRow = serde_json::from_value(json!({
            "repo_key": "r", "path": "a.png", "state": "present", "sha": "ab", "size": 4,
            "is_binary": true, "version": 3, "updated_by": null
        }))
        .unwrap();
        assert_eq!(row.into_remote(), RemoteFile {
            state: FileState::Present { sha: "ab".into(), size: 4, binary: true },
            version: 3,
            updated_by: None,
        });
        let deleted: FileRow = serde_json::from_value(json!({
            "repo_key": "r", "path": "x", "state": "deleted", "sha": null, "size": null,
            "is_binary": false, "version": 1, "updated_by": "p"
        }))
        .unwrap();
        assert_eq!(deleted.into_remote().state, FileState::Deleted);
    }

    #[test]
    fn the_secret_hash_matches_what_postgres_computes() {
        // encode(sha256(convert_to('abc', 'UTF8')), 'hex')
        assert_eq!(sha("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn a_project_without_the_script_is_told_so_in_words() {
        // What PostgREST answers when the host never ran collab_schema.sql in their project.
        let missing = [
            "Could not find the function public.cf_collab_version without parameters in the schema cache (Perhaps you meant to call the function public.version)",
            "PGRST202: whatever",
            "relation \"public.cf_collab_files\" does not exist",
        ];
        for message in missing {
            assert_eq!(friendly(message.to_string()), SCHEMA_MISSING, "{message}");
        }
        assert_eq!(friendly("cf_nick_taken".into()), "Ese nick ya está en uso en la sesión. Elige otro.");
        assert!(!schema_missing("relation \"public.notes\" does not exist"));
    }
}
