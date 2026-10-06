//! What a flow may ask of the rest of CodeFlow — the app side of [`RunHost::db_connection`],
//! [`RunHost::remote_host`] and [`RunHost::app_call`].
//!
//! **The app's own commands, called the way a window calls them.** A pull request is created by
//! `commands::ado_cmd::create_pull_request`, a note saved by `notes_save_note` (which keeps its
//! version history), a pipeline started by `start_pipeline` — with the app's `State`, so a flow
//! goes through exactly the checks, tokens and side effects a click does, and there is no second
//! copy of any of them here.
//!
//! [`RunHost::db_connection`]: super::engine::RunHost::db_connection
//! [`RunHost::remote_host`]: super::engine::RunHost::remote_host
//! [`RunHost::app_call`]: super::engine::RunHost::app_call

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

use super::engine::{LogStream, RunHost};
use super::runs::AppHost;
use crate::db::Db;

pub(super) fn db(host: &AppHost) -> tauri::State<'_, Db> {
    host.app.state::<Db>()
}

/// A saved database connection, as the console opens it: the row's spec with its keychain password.
pub(super) fn db_connection(host: &AppHost, connection_id: &str) -> Result<crate::datasource::DbConnectionConfig, String> {
    let row = {
        let state = db(host);
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        crate::db::datasource_queries::get_connection(&conn, connection_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That database connection no longer exists".to_string())?
    };
    let mut config: crate::datasource::DbConnectionConfig =
        serde_json::from_str(&row.spec).map_err(|e| format!("The connection's settings could not be read ({e})"))?;
    config.id = row.id;
    config.kind = serde_json::from_value(Value::String(row.kind.clone()))
        .map_err(|_| format!("`{}` is not a database engine this build knows", row.kind))?;
    config.resolve_password();
    Ok(config)
}

/// A host of the Remote workspace.
pub(super) fn remote_host(host: &AppHost, host_id: &str) -> Result<crate::remotes::RemoteHostSpec, String> {
    let row = {
        let state = db(host);
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        crate::db::remote_queries::get_host(&conn, host_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That host no longer exists in Remote".to_string())?
    };
    serde_json::from_str(&row.spec).map_err(|e| format!("The settings of “{}” could not be read: {e}", row.name))
}

pub(super) fn arg(args: &Value, name: &str) -> String {
    match args.get(name) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub(super) fn arg_i64(args: &Value, name: &str) -> Result<i64, String> {
    match args.get(name) {
        Some(Value::Number(n)) => n.as_i64().ok_or_else(|| format!("{name} must be a whole number")),
        Some(Value::String(text)) => text.trim().trim_start_matches('#').parse().map_err(|_| format!("{name} must be a number, not \"{text}\"")),
        _ => Err(format!("{name} is missing")),
    }
}

pub(super) fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// One operation by name. The node has already checked its parameters' shape; what is checked here
/// is what only the app knows (the repository is linked, the vault is unlocked, the host exists).
pub(super) async fn call(host: &AppHost, op: &str, args: Value, cancel: CancellationToken) -> Result<Value, String> {
    match op {
        "remote.download" | "remote.upload" => {
            let host_id = arg(&args, "hostId");
            let spec = remote_host(host, &host_id)?;
            let transfer = format!("flow-{}", uuid::Uuid::new_v4());
            let work = async {
                if op == "remote.download" {
                    crate::remotes::files::download(&host.app, &transfer, &host_id, &spec, &arg(&args, "remotePath"), &arg(&args, "localPath")).await
                } else {
                    crate::remotes::files::upload(&host.app, &transfer, &host_id, &spec, &arg(&args, "localPath"), &arg(&args, "remotePath")).await
                }
            };
            tokio::select! {
                result = work => result.map(|_| json!({"done": true})),
                _ = cancel.cancelled() => {
                    crate::remotes::files::cancel(&transfer);
                    Err(crate::ai_runs::CANCELLED_MARKER.to_string())
                }
            }
        }
        "pr.create" => {
            let summary = crate::commands::ado_cmd::create_pull_request(
                db(host),
                arg(&args, "projectId"),
                arg(&args, "title"),
                arg(&args, "description"),
                arg(&args, "source"),
                arg(&args, "target"),
                args.get("draft").and_then(Value::as_bool).unwrap_or(false),
                None,
            )
            .await?;
            to_json(summary)
        }
        "pr.merge" => {
            let choice: crate::commands::ado_cmd::MergeChoice = serde_json::from_value(json!({
                "method": arg(&args, "method"),
                "delete_source_branch": args.get("deleteSourceBranch").and_then(Value::as_bool).unwrap_or(false),
            }))
            .map_err(|e| e.to_string())?;
            let outcome = crate::commands::ado_cmd::merge_pull_request(db(host), arg(&args, "projectId"), arg_i64(&args, "prId")?, choice).await?;
            to_json(outcome)
        }
        "pr.comment" => pr_comment(host, &args).await,
        "pr.review" => pr_review(host, &args, cancel).await,
        "pr.list" | "pr.get" | "pr.decide" | "pr.threads" | "pr.threadResolve" | "pr.memoryRuns" | "pr.memoryFindings" | "pr.findingMark"
        | "pr.memoryRules" | "pr.fix" | "pr.replyDraft" => super::pr_ops::call(host, op, &args, cancel).await,
        "pipeline.start" => {
            let request: crate::ci::StartPipelineRequest = serde_json::from_value(json!({
                "definition_id": arg(&args, "definitionId"),
                "ref": arg(&args, "ref"),
                "inputs": args.get("inputs").cloned().unwrap_or_else(|| json!({})),
                "variables": args.get("variables").cloned().unwrap_or_else(|| json!([])),
            }))
            .map_err(|e| format!("The pipeline request is not valid: {e}"))?;
            to_json(crate::commands::ci_cmd::start_pipeline(db(host), arg(&args, "projectId"), request).await?)
        }
        "pipeline.runs" => {
            let branch = Some(arg(&args, "branch")).filter(|b| !b.trim().is_empty());
            to_json(crate::commands::ci_cmd::list_pipeline_runs(db(host), arg(&args, "projectId"), branch, 20).await?)
        }
        "pipeline.detail" => {
            to_json(crate::commands::ci_cmd::pipeline_run_detail(db(host), arg(&args, "projectId"), arg(&args, "runId")).await?)
        }
        "pipeline.log" => {
            let log_ref = Some(arg(&args, "logRef")).filter(|r| !r.trim().is_empty());
            let log = crate::commands::ci_cmd::fetch_pipeline_job_log(db(host), arg(&args, "projectId"), arg(&args, "runId"), arg(&args, "jobId"), log_ref).await?;
            // For whatever reads it next — usually a model: the host's markers out, and the end kept
            // when it is long, because the end is where a build says what went wrong.
            let max = args.get("maxChars").and_then(Value::as_u64).unwrap_or(20_000).clamp(500, 200_000) as usize;
            let (text, cut) = crate::ci::head_and_tail(&crate::ci::clean_ci_markers(&log.text), max);
            Ok(json!({"text": text, "truncated": log.truncated || cut}))
        }
        "pipeline.artifacts" => {
            to_json(crate::commands::ci_cmd::list_pipeline_artifacts(db(host), arg(&args, "projectId"), arg(&args, "runId")).await?)
        }
        "pipeline.artifactDownload" => {
            let bytes = crate::commands::ci_cmd::download_pipeline_artifact(
                host.app.clone(),
                db(host),
                arg(&args, "projectId"),
                arg(&args, "runId"),
                arg(&args, "artifactId"),
                arg(&args, "destination"),
                format!("flow-{}", uuid::Uuid::new_v4()),
            )
            .await?;
            Ok(json!({"bytes": bytes}))
        }
        "note.create" => {
            let workspace_id = if arg(&args, "workspaceId").is_empty() { host.workspace_id.clone() } else { arg(&args, "workspaceId") };
            // Every note lives in a book (the Notes view browses books): without one named, the
            // flow's notes go to a book of their own at the root, made the first time.
            let book_id = match arg(&args, "bookId") {
                id if !id.is_empty() => id,
                _ => {
                    let state = db(host);
                    let conn = state.0.lock().map_err(|e| e.to_string())?;
                    let name = arg(&args, "bookName");
                    let name = if name.trim().is_empty() { "Flujos".to_string() } else { name };
                    let existing: Option<String> = rusqlite::OptionalExtension::optional(conn.query_row(
                        "SELECT id FROM note_books WHERE workspace_id = ?1 AND parent_id IS NULL AND name = ?2 ORDER BY sort_order LIMIT 1",
                        rusqlite::params![workspace_id, name],
                        |row| row.get(0),
                    ))
                    .map_err(|e| e.to_string())?;
                    match existing {
                        Some(id) => id,
                        None => crate::db::note_queries::create_book(&conn, &workspace_id, None, &name, "").map_err(|e| e.to_string())?.id,
                    }
                }
            };
            let meta = crate::commands::notes_cmd::notes_create_note(
                db(host),
                workspace_id.clone(),
                book_id,
                arg(&args, "title"),
                arg(&args, "content"),
                arg(&args, "tags"),
            )?;
            let _ = host.app.emit("notes:changed", json!({ "workspaceId": workspace_id, "noteId": meta.id }));
            to_json(meta)
        }
        "note.append" => {
            let id = arg(&args, "noteId");
            let note = {
                let state = db(host);
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                crate::db::note_queries::get_note(&conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "That note no longer exists".to_string())?
            };
            let addition = arg(&args, "content");
            let content = if note.content.trim().is_empty() { addition } else { format!("{}\n\n{addition}", note.content.trim_end()) };
            let meta = crate::commands::notes_cmd::notes_save_note(db(host), id.clone(), note.title, content, note.tags)?
                .ok_or_else(|| "That note was deleted".to_string())?;
            let _ = host.app.emit("notes:changed", json!({ "workspaceId": note.workspace_id, "noteId": id }));
            to_json(meta)
        }
        "reviewer.run" => reviewer(host, &args, cancel).await,
        "service.log" => {
            let log = crate::services::supervisor::Supervisor::of(&host.app).log(&arg(&args, "serviceId"));
            let text = crate::services::log::strip_ansi(&log.text).replace("\r\n", "\n");
            let wanted = args.get("lines").and_then(Value::as_u64).unwrap_or(100) as usize;
            Ok(json!({"text": last_lines(&text, wanted), "lines": text.lines().count().min(wanted)}))
        }
        "service.waitFor" => service_wait(host, &args, cancel).await,
        "chat.send" => chat_turn(host, &args, cancel).await,
        "db.dbml" => schema_dbml(host, &args, cancel).await,
        "api.request" => {
            // The API client builds and sends it — its one `resolveRequest` — in the window.
            let mut payload = args.clone();
            payload["workspaceId"] = json!(host.workspace_id);
            super::bridge::ask(&host.app, "api.request", payload, Duration::from_secs(10 * 60), cancel).await
        }
        "vault.read" => {
            let session = host.app.state::<crate::keyvault::session::VaultSession>();
            if !session.is_unlocked() {
                return Err("The Llavero is locked — unlock it in CodeFlow and run again".to_string());
            }
            let item = crate::commands::keyvault_cmd::keyvault_get_item(db(host), session, arg(&args, "itemId"))?
                .ok_or_else(|| "That Llavero item no longer exists".to_string())?;
            let field = arg(&args, "field");
            let secret = to_json(&item.secret)?;
            let value = if field.trim().is_empty() {
                secret.get("password").or_else(|| secret.get("secret")).or_else(|| secret.get("value")).cloned().unwrap_or(secret.clone())
            } else {
                secret.get(field.trim()).cloned().ok_or_else(|| format!("The item has no field \"{}\"", field.trim()))?
            };
            Ok(json!({"title": item.meta.title, "value": value}))
        }
        "app.open" | "app.terminal" => {
            // The windows draw these; the main window listens.
            let event = if op == "app.open" { "flows:open" } else { "flows:terminal" };
            let mut payload = args.clone();
            if let Value::Object(map) = &mut payload {
                map.insert("workspaceId".into(), json!(host.workspace_id));
                map.insert("flowName".into(), json!(host.flow_name));
            }
            if op == "app.open" {
                use tauri_plugin_opener::OpenerExt;
                let target = arg(&args, "target");
                match arg(&args, "kind").as_str() {
                    "url" => {
                        host.app.opener().open_url(target.clone(), None::<&str>).map_err(|e| e.to_string())?;
                        return Ok(json!({"opened": target}));
                    }
                    "file" | "folder" => {
                        let path = super::nodes::expand_path(&target);
                        if !path.exists() {
                            return Err(format!("{} does not exist", path.display()));
                        }
                        host.app.opener().open_path(path.to_string_lossy().into_owned(), None::<&str>).map_err(|e| e.to_string())?;
                        return Ok(json!({"opened": path.to_string_lossy()}));
                    }
                    _ => {}
                }
            }
            host.app.emit(event, payload).map_err(|e| e.to_string())?;
            Ok(json!({"sent": true}))
        }
        other => Err(format!("{other} is not something a flow can ask CodeFlow for")),
    }
}

/// A plain comment on a pull request, on whichever host the repository is linked to.
async fn pr_comment(host: &AppHost, args: &Value) -> Result<Value, String> {
    use crate::commands::ado_cmd::{bitbucket_auth, github_token, gitlab_token, linked_repo, load_project, pat_for_org, LinkedRepo};
    let project = load_project(&db(host), &arg(args, "projectId"))?;
    let pr = arg_i64(args, "prId")?;
    let body = arg(args, "body");
    if body.trim().is_empty() {
        return Err("Write the comment".to_string());
    }
    let id = match linked_repo(&project)? {
        LinkedRepo::GitHub { host: server, owner, repo } => crate::github::post_pr_comment(&server, &owner, &repo, pr, &body, &github_token(&server)?).await?,
        LinkedRepo::GitLab { host: server, project: path } => crate::gitlab::post_pr_comment(&server, &path, pr, &body, &gitlab_token(&server)?).await?,
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            crate::ado::post_pr_comment(&org, &ado_project, &repo_id, pr, &body, &pat_for_org(&org)?).await?
        }
        LinkedRepo::Bitbucket { workspace, repo } => crate::bitbucket::post_pr_comment(&workspace, &repo, pr, &body, &bitbucket_auth(&workspace)?).await?,
    };
    Ok(json!({"commentId": id, "prId": pr}))
}

// ------------------------------------------------------------------------------- schema as DBML

/// A connection's schema, read as the Databases workspace's diagram reads it, written as DBML by
/// the window's emitter (`flows::bridge` — one emitter, see `lib/dbml/fromSchema.ts`) and kept where
/// asked: a DBML diagram of the workspace, found by title (made the first time, replaced after), or
/// a file.
async fn schema_dbml(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    let some = |name: &str| Some(arg(args, name)).filter(|value| !value.trim().is_empty());
    let node: crate::datasource::DbNodeRef = serde_json::from_value(json!({
        "kind": if some("schema").is_some() { "schema" } else { "database" },
        "database": some("database"),
        "schema": some("schema"),
        "name": null,
    }))
    .map_err(|e| e.to_string())?;
    let read = crate::commands::db_cmd::db_schema_diagram(
        db(host),
        host.app.state::<crate::datasource::DbRegistry>(),
        arg(args, "connectionId"),
        node,
        format!("flow-{}", uuid::Uuid::new_v4()),
    );
    let diagram = tokio::select! {
        diagram = read => to_json(diagram?)?,
        _ = cancel.cancelled() => return Err(crate::ai_runs::CANCELLED_MARKER.to_string()),
    };
    let title = arg(args, "title").trim().to_string();
    let answer = super::bridge::ask(&host.app, "dbml.fromSchema", json!({"diagram": diagram, "title": title}), Duration::from_secs(30), cancel).await?;
    let dbml = answer.get("dbml").and_then(Value::as_str).ok_or("The window answered without DBML")?.to_string();
    let mut out = json!({
        "dbml": dbml,
        "tables": answer.get("tables").cloned().unwrap_or(Value::Null),
        "notes": diagram.get("notes").cloned().unwrap_or(Value::Null),
    });
    match arg(args, "saveTo").as_str() {
        "diagram" => {
            let title = if title.is_empty() {
                diagram.get("schema").or_else(|| diagram.get("database")).and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("Esquema").to_string()
            } else {
                title
            };
            let existing = {
                let state = db(host);
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                crate::db::diagram_queries::load_tree(&conn, &host.workspace_id)
                    .map_err(|e| e.to_string())?
                    .diagrams
                    .into_iter()
                    .find(|meta| meta.title == title && meta.format == "dbml")
            };
            let id = match existing {
                Some(meta) => {
                    crate::commands::diagrams_cmd::diagrams_save_diagram(db(host), meta.id.clone(), dbml, "dbml".into(), String::new(), None, None)?;
                    meta.id
                }
                None => crate::commands::diagrams_cmd::diagrams_create_diagram(db(host), host.workspace_id.clone(), None, title.clone(), dbml, "dbml".into(), "[]".into())?.id,
            };
            let _ = host.app.emit("diagrams:changed", json!({"workspaceId": host.workspace_id, "diagramId": id}));
            out["diagramId"] = json!(id);
            out["title"] = json!(title);
        }
        "dbmlFile" => {
            let path = super::nodes::expand_path(&arg(args, "path"));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            std::fs::write(&path, out["dbml"].as_str().unwrap_or_default()).map_err(|e| format!("{}: {e}", path.display()))?;
            out["path"] = json!(path.to_string_lossy());
        }
        _ => {}
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------- the Chat

/// A turn of the Chat, through its own command (`chat_send`): the question and the answer are filed
/// in the thread as if typed there, and every window's Chat list is told (`Invalidate::Chat`).
async fn chat_turn(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    use crate::commands::chat_cmd;
    let provider = Some(arg(args, "provider")).filter(|value| !value.trim().is_empty());
    let model = Some(arg(args, "model")).filter(|value| !value.trim().is_empty());
    let title = arg(args, "title").trim().to_string();
    let mode = arg(args, "conversation");

    let found = {
        let state = db(host);
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        match mode.as_str() {
            "byId" => Some(
                crate::db::chat_queries::get_conversation(&conn, &arg(args, "conversationId"))
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "That conversation is no longer in the Chat".to_string())?,
            ),
            "newThread" => None,
            // The newest thread of this workspace with exactly this title — a flow's running log.
            _ if !title.is_empty() => crate::db::chat_queries::list_conversations(&conn, false)
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|c| c.workspace_id == host.workspace_id && c.title == title),
            _ => None,
        }
    };
    let (conversation_id, created) = match found {
        Some(conversation) => (conversation.id, false),
        None => {
            // A new thread starts on the node's engine, or on the Chat routing row's.
            let (provider, model) = match (&provider, &model) {
                (Some(provider), model) => (provider.clone(), model.clone().unwrap_or_default()),
                _ => {
                    let state = db(host);
                    let conn = state.0.lock().map_err(|e| e.to_string())?;
                    let config = crate::commands::claude_cmd::load_ai_config_in(&conn, crate::commands::claude_cmd::AiTask::Chat, Some(&host.workspace_id))?;
                    (config.provider.clone(), config.model.clone())
                }
            };
            let project = Some(arg(args, "projectId")).filter(|id| !id.trim().is_empty());
            let conversation = chat_cmd::chat_create_conversation(db(host), host.workspace_id.clone(), project, provider, model, None)?;
            if !title.is_empty() {
                chat_cmd::chat_rename_conversation(db(host), conversation.id.clone(), title.clone())?;
            }
            (conversation.id, true)
        }
    };
    let tell = |app: &tauri::AppHandle, id: &str| {
        crate::remotectl::bridge::emit_desktop_change(app, "flows", crate::remotectl::dispatch::Invalidate::Chat, None, Some(id));
    };
    tell(&host.app, &conversation_id);

    let message = arg(args, "message");
    let run_id = uuid::Uuid::new_v4().to_string();
    if !args.get("wait").and_then(Value::as_bool).unwrap_or(true) {
        // Asked, not waited for: the turn goes on in the background and lands in the thread.
        let app = host.app.clone();
        let id = conversation_id.clone();
        tokio::spawn(async move {
            let _ = chat_cmd::chat_send(app.clone(), app.state::<Db>(), id.clone(), message, Some(run_id), provider, model, Some(false), None, None).await;
            crate::remotectl::bridge::emit_desktop_change(&app, "flows", crate::remotectl::dispatch::Invalidate::Chat, None, Some(&id));
        });
        return Ok(json!({"conversationId": conversation_id, "created": created, "sent": true}));
    }
    let turn = chat_cmd::chat_send(host.app.clone(), db(host), conversation_id.clone(), message, Some(run_id.clone()), provider, model, Some(false), None, None);
    let reply = tokio::select! {
        reply = turn => reply?,
        _ = cancel.cancelled() => {
            crate::ai_runs::cancel(&run_id);
            return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
        }
    };
    tell(&host.app, &conversation_id);
    let reply = to_json(reply)?;
    Ok(json!({
        "conversationId": conversation_id,
        "created": created,
        "reply": reply.get("text"),
        "provider": reply.get("provider"),
        "model": reply.get("model"),
        "responseTimeMs": reply.get("response_time_ms"),
    }))
}

// ------------------------------------------------------------------------------- service logs

/// The last `count` lines of `text`.
fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// The first line of `text` that matches, with its capture groups.
fn matching_line(text: &str, pattern: &str, regex: Option<&regex::Regex>) -> Option<Value> {
    text.lines().find_map(|line| match regex {
        Some(regex) => regex.captures(line).map(|caps| {
            let groups: Vec<Value> = caps.iter().skip(1).map(|group| group.map(|g| json!(g.as_str())).unwrap_or(Value::Null)).collect();
            json!({"line": line.trim_end(), "groups": groups})
        }),
        None => line.contains(pattern).then(|| json!({"line": line.trim_end(), "groups": []})),
    })
}

/// Waits until a service prints a line that matches — by default one printed after the node
/// started, so a "listening on" left in the log by the last run does not answer for this one.
async fn service_wait(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    let id = arg(args, "serviceId");
    let pattern = arg(args, "pattern");
    let regex = if args.get("regex").and_then(Value::as_bool).unwrap_or(false) {
        Some(regex::Regex::new(&pattern).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let only_new = args.get("onlyNew").and_then(Value::as_bool).unwrap_or(true);
    let limit = Duration::from_secs_f64(args.get("timeoutSec").and_then(Value::as_f64).unwrap_or(120.0));
    let supervisor = crate::services::supervisor::Supervisor::of(&host.app);
    let read = || crate::services::log::strip_ansi(&supervisor.log(&id).text).replace("\r\n", "\n");
    let before = if only_new { read() } else { String::new() };
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let now = read();
        // What was printed since the node started — or, when the buffer was trimmed meanwhile and
        // no longer starts with what it held, all of it (the old part is gone anyway).
        let fresh = now.strip_prefix(before.as_str()).unwrap_or(&now);
        if let Some(found) = matching_line(fresh, &pattern, regex.as_ref()) {
            return Ok(found);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("The service printed no line with \"{pattern}\" in {} s", limit.as_secs()));
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(300)) => {}
            _ = cancel.cancelled() => return Err(crate::ai_runs::CANCELLED_MARKER.to_string()),
        }
    }
}

// ------------------------------------------------------------------------- CodeFlow's PR analyzer

/// How a remembered finding's severity ranks, for "publish from this severity up".
fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 3,
        "warning" => 2,
        _ => 1,
    }
}

/// `"12-15"` / `"12"` as the line range a comment hangs from — `None` when it does not read as one,
/// the honest answer (the host then gets an unanchored comment), never an invented line. The rule the
/// phone's publish follows too.
fn location_of(finding: &crate::review_memory::MemoryFinding) -> Option<crate::commands::ado_cmd::CommentLocation> {
    let file = finding.archivo.clone()?;
    let lines = finding.lineas.as_deref()?.trim();
    let (start, end) = match lines.split_once(['-', '–']) {
        Some((a, b)) => (a.trim().parse::<i64>().ok()?, b.trim().parse::<i64>().ok()?),
        None => {
            let line = lines.parse::<i64>().ok()?;
            (line, line)
        }
    };
    (start >= 1).then(|| crate::commands::ado_cmd::CommentLocation { file, start_line: start, end_line: end.max(start) })
}

/// A finding as a flow reads it — the stored one, in the flow's words.
fn finding_json(finding: &crate::review_memory::MemoryFinding) -> Value {
    json!({
        "id": finding.id,
        "severity": finding.severity,
        "type": finding.tipo,
        "category": finding.categoria,
        "title": finding.subtitulo,
        "file": finding.archivo,
        "lines": finding.lineas,
        "confidence": finding.confianza,
        "state": finding.estado,
        "delta": finding.delta,
        "threadId": finding.thread_id,
    })
}

/// CodeFlow's PR analyzer on one pull request: the panel's own command — `review_pull_request` for a
/// linked repository, `review_pr_from_link` for one this machine does not hold — so the levels, the
/// policy, the memory and the history row are the panel's. Then, when asked, the new findings from
/// a severity up are published as threads and the fixed ones closed, through `publish_pr_review`
/// (one thread per finding for the pull request's whole life). Findings already published and still
/// present are left alone: an automatic run that replied "still here" on every one would be noise.
async fn pr_review(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    use crate::commands::ado_cmd;
    let job_id = uuid::Uuid::new_v4().to_string();
    let level = Some(arg(args, "level")).filter(|level| !level.trim().is_empty()).unwrap_or_else(|| "completo".into());
    let provider = Some(arg(args, "provider")).filter(|value| !value.trim().is_empty());
    let model = Some(arg(args, "model")).filter(|value| !value.trim().is_empty());
    let by_link = arg(args, "source") == "link";
    let project_id = arg(args, "projectId");
    let pr_id = if by_link { 0 } else { arg_i64(args, "prId")? };
    let url = arg(args, "url");
    let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);

    let review = async {
        if by_link {
            ado_cmd::review_pr_from_link(
                host.app.clone(),
                db(host),
                url.clone(),
                job_id.clone(),
                level.clone(),
                host.workspace_id.clone(),
                provider.clone(),
                model.clone(),
                None,
            )
            .await
        } else {
            ado_cmd::review_pull_request(host.app.clone(), db(host), project_id.clone(), pr_id, job_id.clone(), level.clone(), force, provider.clone(), model.clone(), None)
                .await
        }
    };
    let text = tokio::select! {
        result = review => result?,
        _ = cancel.cancelled() => {
            crate::ai_runs::cancel(&job_id);
            return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
        }
    };
    if text.is_empty() {
        // How a stopped review comes back from the command.
        return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
    }
    if let Some(reason) = text.strip_prefix(crate::commands::review_pipeline::SKIP_MARKER) {
        // The plan stopped to ask (a draft, an enormous diff): the panel's "review anyway" is the
        // node's "Review drafts too".
        return Ok(json!({"status": "needsConfirmation", "message": reason.trim(), "prId": pr_id, "level": level}));
    }
    if let Some(reason) = text.strip_prefix("⏭️") {
        return Ok(json!({"status": "skipped", "message": reason.trim(), "prId": pr_id, "level": level}));
    }
    if by_link {
        // Nothing is remembered for a repository this machine does not hold: the report is the answer.
        return Ok(json!({"status": "reviewed", "source": "link", "url": url, "level": level, "report": text}));
    }

    // Same commit, nothing new said on the pull request: the last review still holds, and is what
    // the flow gets — status `unchanged`, so it can tell.
    let unchanged = text.starts_with('🔁');
    let run = {
        let state = db(host);
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let id = if unchanged {
            crate::db::queries::latest_review_run_id(&conn, &project_id, pr_id).map_err(|e| e.to_string())?
        } else {
            Some(job_id.clone())
        };
        match id {
            Some(id) => crate::db::queries::get_review_run(&conn, &id).map_err(|e| e.to_string())?,
            None => None,
        }
    };
    let Some(run) = run else {
        return Ok(json!({"status": if unchanged { "unchanged" } else { "reviewed" }, "prId": pr_id, "level": level, "report": text}));
    };
    let meta: Value = serde_json::from_str(&run.meta).unwrap_or(Value::Null);
    let findings: Vec<crate::review_memory::MemoryFinding> = serde_json::from_str(&run.findings).unwrap_or_default();
    let count = |severity: &str| findings.iter().filter(|f| f.severity == severity && matches!(f.estado.as_str(), "abierto" | "posteado")).count();
    let mut answer = json!({
        "status": if unchanged { "unchanged" } else { "reviewed" },
        "runId": run.id,
        "prId": run.pr_id,
        "title": meta.get("pr_title"),
        "url": meta.get("url"),
        "author": meta.get("author"),
        "sourceBranch": meta.get("source_branch"),
        "targetBranch": meta.get("target_branch"),
        "provider": meta.get("provider"),
        "level": run.level,
        "iteration": run.iter,
        "engine": meta.get("engine"),
        "model": meta.get("model"),
        "gate": if meta.get("quality_gate").and_then(Value::as_bool).unwrap_or(true) { "pass" } else { "fail" },
        "counts": {
            "critical": count("critical"),
            "warning": count("warning"),
            "info": count("info"),
            "open": findings.iter().filter(|f| matches!(f.estado.as_str(), "abierto" | "posteado")).count(),
            "resolved": findings.iter().filter(|f| f.estado == "resuelto").count(),
            "total": findings.len(),
        },
        "findings": findings.iter().map(finding_json).collect::<Vec<_>>(),
        "report": if unchanged { run.review_md.clone() } else { text },
    });
    if unchanged {
        answer["message"] = json!("The pull request has not changed since its last review");
    }

    let publish = arg(args, "publish");
    if !unchanged && matches!(publish.as_str(), "findings" | "findingsAndSummary") {
        let floor = severity_rank(&Some(arg(args, "minSeverity")).filter(|s| !s.is_empty()).unwrap_or_else(|| "warning".into()));
        let chosen: Vec<&crate::review_memory::MemoryFinding> = findings
            .iter()
            .filter(|f| {
                (f.estado == "abierto" && severity_rank(&f.severity) >= floor && !f.comentario_md.trim().is_empty())
                    || (f.estado == "resuelto" && f.thread_id.is_some())
            })
            .collect();
        let items: Vec<ado_cmd::PostFindingItem> = chosen
            .iter()
            .map(|f| ado_cmd::PostFindingItem {
                id: Some(f.id.clone()),
                file: f.archivo.clone(),
                category: f.categoria.clone(),
                content: f.comentario_md.clone(),
                location: location_of(f),
            })
            .collect();
        let with_summary = publish == "findingsAndSummary";
        if items.is_empty() && !with_summary {
            answer["published"] = json!({"items": [], "summaryPosted": null});
        } else {
            let summary = with_summary.then(|| {
                let opened = chosen.iter().filter(|f| f.estado == "abierto").count();
                let closed = chosen.len() - opened;
                let gate = if answer["gate"] == "pass" { "✅ pasa" } else { "❌ no pasa" };
                let mut body = format!(
                    "**Revisión de CodeFlow** · nivel {} · iteración {}\n\nPuerta de calidad: {gate}\n\n{} hallazgo(s) nuevo(s) publicado(s), {} resuelto(s) cerrado(s).",
                    run.level, run.iter, opened, closed
                );
                for f in chosen.iter().filter(|f| f.estado == "abierto") {
                    body.push_str(&format!("\n- `{}` {}", f.id, f.subtitulo));
                }
                body
            });
            let outcome = ado_cmd::publish_pr_review(db(host), project_id.clone(), pr_id, run.id.clone(), items, with_summary, summary).await?;
            answer["published"] = to_json(outcome)?;
        }
    }
    Ok(answer)
}

/// Runs the Reviewer on a repository — build, tests, the local SonarQube and its gate — and waits
/// for it to end.
async fn reviewer(host: &AppHost, args: &Value, cancel: CancellationToken) -> Result<Value, String> {
    let project = crate::commands::ado_cmd::load_project(&db(host), &arg(args, "projectId"))?;
    let suggestion = crate::reviewer::detect::suggest(std::path::Path::new(&project.local_path), &project.name, "");
    let pick = |name: &str, suggested: &str| {
        let written = arg(args, name);
        if written.trim().is_empty() { suggested.to_string() } else { written }
    };
    let request = crate::reviewer::analysis::RunRequest {
        project_id: project.id.clone(),
        repo_path: project.local_path.clone(),
        project_name: project.name.clone(),
        project_key: suggestion.project_key.clone(),
        prepare: pick("prepare", &suggestion.prepare),
        build: pick("build", &suggestion.build),
        test: pick("test", &suggestion.test),
        exclusions: arg(args, "exclusions"),
    };
    let run_id = crate::commands::reviewer_cmd::reviewer_run(host.app.clone(), db(host), request)?;
    host.log(&arg(args, "nodeId"), LogStream::Info, &format!("Reviewer started on {}", project.name));
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = cancel.cancelled() => {
                crate::reviewer::analysis::cancel(&run_id);
                return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
            }
        }
        let still = crate::reviewer::analysis::active_run().is_some_and(|active| active.run_id == run_id);
        if !still {
            break;
        }
    }
    let summary = crate::reviewer::analysis::last(&suggestion.project_key);
    Ok(json!({"projectKey": suggestion.project_key, "summary": to_json(summary)?}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(file: Option<&str>, lines: Option<&str>) -> crate::review_memory::MemoryFinding {
        serde_json::from_value(json!({
            "id": "F-001", "severity": "warning", "tipo": "Bug", "categoria": "null", "subtitulo": "x",
            "archivo": file, "lineas": lines, "confianza": 80,
        }))
        .unwrap()
    }

    #[test]
    fn a_service_line_is_found_by_text_or_by_pattern() {
        let log = "starting\n  VITE ready in 300 ms\n  Local: http://localhost:5173/\n";
        assert_eq!(matching_line(log, "ready in", None).unwrap()["line"], "  VITE ready in 300 ms");
        let port = regex::Regex::new(r"localhost:(\d+)").unwrap();
        assert_eq!(matching_line(log, "", Some(&port)).unwrap()["groups"], json!(["5173"]));
        assert!(matching_line(log, "error", None).is_none());
        assert_eq!(last_lines("a\nb\nc", 2), "b\nc");
        assert_eq!(last_lines("a", 5), "a");
    }

    #[test]
    fn a_finding_hangs_from_its_lines_or_from_nothing() {
        let range = |f| location_of(&f).map(|l| (l.file, l.start_line, l.end_line));
        assert_eq!(range(finding(Some("a.rs"), Some("12-15"))), Some(("a.rs".into(), 12, 15)));
        assert_eq!(range(finding(Some("a.rs"), Some(" 7 "))), Some(("a.rs".into(), 7, 7)));
        assert_eq!(range(finding(Some("a.rs"), Some("15–12"))), Some(("a.rs".into(), 15, 15)), "never backwards");
        assert_eq!(range(finding(Some("a.rs"), Some("cerca del final"))), None);
        assert_eq!(range(finding(Some("a.rs"), Some("0"))), None);
        assert_eq!(range(finding(None, Some("3"))), None);
        assert!(severity_rank("critical") > severity_rank("warning") && severity_rank("warning") > severity_rank("info"));
    }
}
