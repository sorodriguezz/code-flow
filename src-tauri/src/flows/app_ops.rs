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

fn db(host: &AppHost) -> tauri::State<'_, Db> {
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

fn arg(args: &Value, name: &str) -> String {
    match args.get(name) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn arg_i64(args: &Value, name: &str) -> Result<i64, String> {
    match args.get(name) {
        Some(Value::Number(n)) => n.as_i64().ok_or_else(|| format!("{name} must be a whole number")),
        Some(Value::String(text)) => text.trim().trim_start_matches('#').parse().map_err(|_| format!("{name} must be a number, not \"{text}\"")),
        _ => Err(format!("{name} is missing")),
    }
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
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
