//! The Remote workspace's hosts from a flow: a command over SSH, and files on SFTP, FTP, SMB, S3
//! and Azure Storage.
//!
//! **A host is named, never typed.** The node points at a saved host — its address, user, key,
//! jump host and options, its password in the keychain — so a flow connects exactly the way the
//! Remote tab does. SSH runs in batch mode: a host that signs in with a password is handed it once
//! through `SSH_ASKPASS` (`remotes::askpass`), the same door the file browser uses; nothing ever
//! types into a prompt, and a host key `ssh` does not know is refused rather than accepted.

use serde_json::{json, Value};

use super::files::{describe, expand};
use super::process::{output_items, run_program};
use super::{flag, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::remotes::{RemoteAuth, RemoteKind};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "code.ssh" => ssh(ctx).await,
        "net.transfer" | "net.storage" => files(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

async fn ssh(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let host_id = ctx.param_str("host");
    if host_id.trim().is_empty() {
        return Err(NodeError::failed("Pick the host to run on"));
    }
    let spec = ctx.run.host.remote_host(host_id.trim()).map_err(NodeError::Failed)?;
    if !matches!(spec.kind, RemoteKind::Ssh) {
        return Err(NodeError::failed("That host is not an SSH host"));
    }
    spec.require_host().map_err(NodeError::Failed)?;
    let each = ctx.param_str("runFor") == "each";
    let resolved = if each { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let command = text(params, "command");
        if command.trim().is_empty() {
            return Err(NodeError::failed("Write the command to run"));
        }
        // A saved password goes through askpass, once; anything else stays in batch mode.
        let password = if matches!(spec.auth, RemoteAuth::Password) && crate::remotes::askpass::supported() {
            crate::secrets::get_secret(&crate::remotes::password_key(host_id.trim())).ok().flatten().filter(|p| !p.is_empty())
        } else {
            None
        };
        let mut args = spec.background_args(password.is_some());
        args.push(spec.destination());
        args.push(command);
        let mut env = Vec::new();
        let _handoff = match &password {
            Some(password) => {
                let mut probe = tokio::process::Command::new("ssh");
                let handoff = crate::remotes::askpass::Handoff::arm(&mut probe, password).map_err(NodeError::Failed)?;
                for (key, value) in probe.as_std().get_envs() {
                    if let Some(value) = value {
                        env.push((key.to_string_lossy().into_owned(), value.to_string_lossy().into_owned()));
                    }
                }
                Some(handoff)
            }
            None => None,
        };
        let output = run_program(ctx, "ssh", args, None, env, None).await?;
        out.extend(output_items(ctx, params, output, (each && !ctx.items().is_empty()).then_some(index))?);
    }
    Ok(vec![out])
}

fn kind_label(kind: &RemoteKind) -> &'static str {
    match kind {
        RemoteKind::Ssh | RemoteKind::Sftp => "SFTP",
        RemoteKind::Ftp | RemoteKind::Ftps => "FTP",
        RemoteKind::Smb => "SMB",
        RemoteKind::S3 => "S3",
        RemoteKind::Azure | RemoteKind::AzureBlob | RemoteKind::AzureFiles | RemoteKind::AzureQueue | RemoteKind::AzureTable => "Azure",
        RemoteKind::Vnc | RemoteKind::Rdp => "this kind of host",
    }
}

async fn files(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let host_id = ctx.param_str("host");
    if host_id.trim().is_empty() {
        return Err(NodeError::failed("Pick the host"));
    }
    let host_id = host_id.trim().to_string();
    let spec = ctx.run.host.remote_host(&host_id).map_err(NodeError::Failed)?;
    let storage = ctx.node.type_id == "net.storage";
    let fits = if storage {
        matches!(spec.kind, RemoteKind::S3 | RemoteKind::Azure | RemoteKind::AzureBlob | RemoteKind::AzureFiles)
    } else {
        matches!(spec.kind, RemoteKind::Ssh | RemoteKind::Sftp | RemoteKind::Ftp | RemoteKind::Ftps | RemoteKind::Smb)
    };
    if !fits {
        return Err(NodeError::failed(if storage {
            "That host is not an S3 or Azure Storage account — use «SFTP · FTP · SMB»"
        } else {
            "That host is not an SFTP, FTP or SMB host — use «S3 · Azure Blob»"
        }));
    }
    let resolved = ctx.resolve_each().await?;
    let paired = !ctx.items().is_empty();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let operation = text(params, "operation");
        let remote = text(params, "remotePath");
        let wrap = |json: Value| if paired { Item::paired(json, index) } else { Item::new(json) };
        match operation.as_str() {
            "download" => {
                let local = expand(&text(params, "localPath"));
                if text(params, "localPath").trim().is_empty() || !local.is_absolute() {
                    return Err(NodeError::failed("Write where the file goes on this computer"));
                }
                if local.exists() && !flag(params, "overwrite") {
                    return Err(NodeError::failed(format!("{} already exists (turn on «Overwrite»)", local.display())));
                }
                ctx.run
                    .host
                    .app_call(
                        "remote.download",
                        json!({"hostId": host_id, "remotePath": remote, "localPath": local.to_string_lossy()}),
                        ctx.cancel.clone(),
                    )
                    .await
                    .map_err(transport)?;
                out.push(wrap(json!({"file": describe(&local), "remotePath": remote, "via": kind_label(&spec.kind)})));
            }
            "upload" => {
                let local = expand(&text(params, "localPath"));
                if !local.exists() {
                    return Err(NodeError::failed(format!("{} does not exist", local.display())));
                }
                ctx.run
                    .host
                    .app_call(
                        "remote.upload",
                        json!({"hostId": host_id, "remotePath": remote, "localPath": local.to_string_lossy()}),
                        ctx.cancel.clone(),
                    )
                    .await
                    .map_err(transport)?;
                out.push(wrap(json!({"uploaded": local.to_string_lossy(), "remotePath": remote, "via": kind_label(&spec.kind)})));
            }
            "rename" => {
                let to = text(params, "newPath");
                if to.trim().is_empty() {
                    return Err(NodeError::failed("Write the new path"));
                }
                crate::remotes::files::rename(&host_id, &spec, &remote, to.trim()).await.map_err(NodeError::Failed)?;
                out.push(wrap(json!({"renamed": remote, "to": to.trim()})));
            }
            "delete" => {
                crate::remotes::files::remove(&host_id, &spec, &remote, flag(params, "isFolder")).await.map_err(NodeError::Failed)?;
                out.push(wrap(json!({"deleted": remote})));
            }
            "mkdir" => {
                crate::remotes::files::make_dir(&host_id, &spec, &remote).await.map_err(NodeError::Failed)?;
                out.push(wrap(json!({"created": remote})));
            }
            _ => {
                let page = crate::remotes::files::ListPage { prefix: text(params, "prefix"), marker: String::new() };
                let listing = tokio::select! {
                    listing = crate::remotes::files::list(&host_id, &spec, &remote, &page) => listing.map_err(NodeError::Failed)?,
                    _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
                };
                for entry in listing.entries {
                    let modified = (entry.modified > 0)
                        .then(|| chrono::DateTime::from_timestamp(entry.modified as i64, 0).map(|t| t.to_rfc3339()))
                        .flatten();
                    out.push(wrap(json!({
                        "name": entry.name,
                        "path": entry.path,
                        "isDir": entry.is_dir,
                        "size": entry.size,
                        "modifiedAt": modified,
                        "contentType": (!entry.content_type.is_empty()).then_some(entry.content_type),
                    })));
                }
                if !listing.next.is_empty() {
                    ctx.log(crate::flows::engine::LogStream::Info, "The listing has more pages; narrow it with a prefix");
                }
            }
        }
    }
    Ok(vec![out])
}

fn transport(error: String) -> NodeError {
    if error.starts_with(crate::ai_runs::CANCELLED_MARKER) {
        NodeError::Cancelled
    } else {
        NodeError::Failed(error)
    }
}
