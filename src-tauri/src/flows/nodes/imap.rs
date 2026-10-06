//! The IMAP node: read a mailbox's messages (`flows::mail`), mark them read or move them — what a
//! flow does with mail besides waiting for it (that is the "Correo entrante" trigger).

use serde_json::{json, Value};

use super::{flag, number, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::mail;
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let id = ctx.param_str("credential");
    if id.trim().is_empty() {
        return Err(NodeError::failed("Pick the IMAP account"));
    }
    let credential = ctx.credential(id.trim()).await?;
    if credential.kind != "imap" {
        return Err(NodeError::failed("The credential is not an IMAP account"));
    }
    let account = mail::Account::of(&credential.meta, credential.secret).map_err(NodeError::Failed)?;
    let paired = !ctx.items().is_empty();
    let mut session = tokio::select! {
        session = mail::open(&account) => session.map_err(NodeError::Failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let mut out = Vec::new();
    let mut failure = None;
    for (index, params) in resolved.iter().enumerate() {
        let work = one(ctx, &mut session, params);
        let answers = tokio::select! {
            answers = work => answers,
            _ = ctx.cancel.cancelled() => Err(NodeError::Cancelled),
        };
        match answers {
            Ok(list) => out.extend(list.into_iter().map(|json| if paired { Item::paired(json, index) } else { Item::new(json) })),
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    let _ = session.logout().await;
    match failure {
        Some(error) => Err(error),
        None => Ok(vec![out]),
    }
}

/// `"12, 15 18"` or a list of numbers → UIDs.
pub fn uids_of(value: Option<&Value>) -> Vec<u32> {
    match value {
        Some(Value::Array(list)) => list.iter().filter_map(|v| v.as_u64().map(|n| n as u32).or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))).collect(),
        Some(Value::Number(n)) => n.as_u64().map(|n| vec![n as u32]).unwrap_or_default(),
        Some(Value::String(s)) => s.split(|c: char| c == ',' || c.is_whitespace()).filter_map(|p| p.trim().parse().ok()).collect(),
        _ => Vec::new(),
    }
}

async fn one(ctx: &NodeCtx, session: &mut mail::Session, params: &Value) -> Result<Vec<Value>, NodeError> {
    let mailbox = mail::mailbox_name(&text(params, "mailbox")).map_err(NodeError::Failed)?;
    session.select(&mailbox).await.map_err(|e| NodeError::failed(format!("{mailbox}: {e}")))?;
    match text(params, "imapOp").as_str() {
        "imapMarkRead" | "imapMove" => {
            let uids = uids_of(params.get("uids"));
            if uids.is_empty() {
                return Err(NodeError::failed("Write the messages' UIDs (the \"uid\" a read gives)"));
            }
            if text(params, "imapOp") == "imapMove" {
                let target = text(params, "targetMailbox");
                mail::move_to(session, &uids, &target).await.map_err(NodeError::Failed)?;
                ctx.log(LogStream::Info, &format!("{} message(s) moved to {target}", uids.len()));
                Ok(vec![json!({"uids": uids, "movedTo": target})])
            } else {
                mail::mark_read(session, &uids).await.map_err(NodeError::Failed)?;
                Ok(vec![json!({"uids": uids, "unread": false})])
            }
        }
        _ => {
            let criteria = mail::criteria(&text(params, "imapCriteria")).map_err(NodeError::Failed)?;
            let mut uids = mail::search(session, &criteria).await.map_err(NodeError::Failed)?;
            // The newest ones, when there are more than asked for.
            let limit = number(params, "maxResults").map(|n| n.max(0.0) as usize).filter(|n| *n > 0).unwrap_or(10);
            if uids.len() > limit {
                uids = uids.split_off(uids.len() - limit);
            }
            let folder = Some(text(params, "attachmentsFolder")).filter(|f| !f.is_empty()).map(|f| super::expand_path(&f));
            let mut out = Vec::new();
            for (uid, raw, flags) in mail::fetch(session, &uids).await.map_err(NodeError::Failed)? {
                out.push(mail::read(uid, &raw, &flags, &mailbox, folder.as_deref()).map_err(NodeError::Failed)?);
            }
            if flag(params, "markRead") {
                mail::mark_read(session, &uids).await.map_err(NodeError::Failed)?;
            }
            ctx.log(LogStream::Info, &format!("{mailbox}: {} message(s) for {criteria}", out.len()));
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uids_are_read_from_text_or_lists() {
        assert_eq!(uids_of(Some(&json!("12, 15 18"))), vec![12, 15, 18]);
        assert_eq!(uids_of(Some(&json!([3, "4"]))), vec![3, 4]);
        assert_eq!(uids_of(Some(&json!(9))), vec![9]);
        assert!(uids_of(None).is_empty());
    }
}
