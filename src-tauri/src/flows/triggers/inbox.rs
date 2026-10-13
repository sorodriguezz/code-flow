//! The incoming-mail trigger: a mailbox looked at over IMAP every minute or so; each new message
//! that matches the criteria runs the flow once, as one item (`flows::mail::read`).
//!
//! **New means a higher UID.** The first look learns where the mailbox is (its UIDVALIDITY and the
//! next UID) and fires nothing; later looks fire the matching messages above that. A server that
//! renumbers the mailbox (a new UIDVALIDITY) is learned again rather than replayed whole.
//!
//! **The position moves only once the messages are in hand.** It is written after they were fetched,
//! read and marked — a look that failed halfway looks again from the same place instead of passing over
//! the mail it was about to deliver — and it is kept in the flow's state, so mail that arrives while
//! the app is closed (or the flow is being saved, which re-arms it) is delivered by the next look
//! rather than absorbed into a new baseline.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use super::{note_problem, TriggerView};
use crate::db::{flow_run_queries, Db};
use crate::flows::mail;
use crate::flows::run::Item;

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// Where the last look left a mailbox.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub validity: Option<u32>,
    pub last_uid: u32,
}

/// The UIDs to fire from `matching`, and where the mailbox is left — nothing on the first look, or
/// when the server renumbered it.
pub fn advance(position: Option<Position>, validity: Option<u32>, uid_next: Option<u32>, matching: &[u32]) -> (Vec<u32>, Position) {
    let top = matching.iter().copied().max().unwrap_or(0).max(uid_next.unwrap_or(1).saturating_sub(1));
    match position {
        Some(before) if before.validity == validity => {
            let new: Vec<u32> = matching.iter().copied().filter(|uid| *uid > before.last_uid).collect();
            (new, Position { validity, last_uid: top.max(before.last_uid) })
        }
        _ => (Vec::new(), Position { validity, last_uid: top }),
    }
}

/// Where this trigger keeps its position: per node, mailbox and account, so pointing the node at
/// another mailbox starts from that one's present rather than another's UIDs.
fn position_key(node_id: &str, credential: &str, mailbox: &str) -> String {
    format!("inbox:{node_id}:{credential}:{mailbox}:position")
}

fn load_position(app: &AppHandle, flow_id: &str, key: &str) -> Option<Position> {
    let db = app.state::<Db>();
    let conn = db.0.lock().ok()?;
    let value = flow_run_queries::state_get(&conn, flow_id, key).ok().flatten()?;
    Some(Position { validity: value.get("validity").and_then(Value::as_u64).map(|v| v as u32), last_uid: value.get("lastUid").and_then(Value::as_u64)? as u32 })
}

fn save_position(app: &AppHandle, flow_id: &str, key: &str, position: Position) {
    let db = app.state::<Db>();
    let conn = db.0.lock();
    if let Ok(conn) = conn {
        let value = json!({"validity": position.validity, "lastUid": position.last_uid});
        let _ = flow_run_queries::state_set(&conn, flow_id, key, &value, &crate::flows::engine::now_text());
    }
}

pub fn check(app: &AppHandle, flow_id: &str, params: &Value) -> Result<(), String> {
    let credential = text(params, "credential");
    if credential.is_empty() {
        return Err("choose the IMAP account".into());
    }
    super::credential_row(app, flow_id, &credential, &["imap"])?;
    mail::mailbox_name(&text(params, "mailbox"))?;
    mail::criteria(&text(params, "imapCriteria"))?;
    Ok(())
}

pub fn spawn(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let credential = text(params, "credential");
    let mailbox = mail::mailbox_name(&text(params, "mailbox"))?;
    let criteria = mail::criteria(&text(params, "imapCriteria"))?;
    let mark_read = params.get("markRead").and_then(Value::as_bool).unwrap_or(false);
    let folder = Some(text(params, "attachmentsFolder")).filter(|f| !f.is_empty()).map(|f| crate::flows::nodes::expand_path(&f));
    let interval = Duration::from_secs(params.get("intervalSec").and_then(Value::as_f64).unwrap_or(60.0).max(30.0) as u64);
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    let key = position_key(&node_id, &credential, &mailbox);
    tauri::async_runtime::spawn(async move {
        let mut position: Option<Position> = load_position(&app, &flow_id, &key);
        loop {
            let before = position;
            let look = look(&app, &flow_id, &credential, &mailbox, &criteria, mark_read, folder.as_deref(), &mut position);
            let outcome = tokio::select! {
                outcome = look => outcome,
                _ = cancel.cancelled() => return,
            };
            if position != before {
                if let Some(position) = position {
                    save_position(&app, &flow_id, &key, position);
                }
            }
            match outcome {
                Ok((items, unread)) => {
                    note_problem(&view, unread);
                    for item in items {
                        if let Err(error) = super::fire_event(&app, &flow_id, &node_id, vec![Item::new(item)]) {
                            note_problem(&view, Some(error));
                        }
                    }
                }
                Err(error) => note_problem(&view, Some(error)),
            }
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = cancel.cancelled() => return,
            }
        }
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn look(
    app: &AppHandle,
    flow_id: &str,
    credential: &str,
    mailbox: &str,
    criteria: &str,
    mark_read: bool,
    folder: Option<&std::path::Path>,
    position: &mut Option<Position>,
) -> Result<(Vec<Value>, Option<String>), String> {
    // Read on every look: a password replaced in the vault is used from the next one.
    let (row, secret) = super::credential_row(app, flow_id, credential, &["imap"])?;
    let account = mail::Account::of(&row.meta, secret)?;
    let mut session = mail::open(&account).await?;
    let result = async {
        let selected = session.select(mailbox).await.map_err(|e| format!("{mailbox}: {e}"))?;
        let matching = mail::search(&mut session, criteria).await?;
        let (new, next) = advance(*position, selected.uid_validity, selected.uid_next, &matching);
        let mut items = Vec::new();
        // A message that cannot be read is told about and passed over — it would fail the same way
        // on every look, and the mail behind it must not wait for it.
        let mut unread: Option<String> = None;
        for (uid, raw, flags) in mail::fetch(&mut session, &new).await? {
            let folder: Option<PathBuf> = folder.map(|f| f.to_path_buf());
            match mail::read(uid, &raw, &flags, mailbox, folder.as_deref()) {
                Ok(item) => items.push(item),
                Err(error) => unread = Some(format!("message {uid} could not be read: {error}")),
            }
        }
        if mark_read {
            mail::mark_read(&mut session, &new).await?;
        }
        // Everything above worked: only now does the position move past these messages.
        *position = Some(next);
        Ok((items, unread))
    }
    .await;
    let _ = session.logout().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_look_learns_and_a_renumbered_mailbox_is_learned_again() {
        let (new, at) = advance(None, Some(7), Some(120), &[100, 110]);
        assert!(new.is_empty());
        assert_eq!(at, Position { validity: Some(7), last_uid: 119 });
        let (new, at) = advance(Some(at), Some(7), Some(124), &[110, 121, 123]);
        assert_eq!(new, vec![121, 123]);
        assert_eq!(at.last_uid, 123);
        let (new, at) = advance(Some(at), Some(8), Some(5), &[1, 2, 3]);
        assert!(new.is_empty());
        assert_eq!(at, Position { validity: Some(8), last_uid: 4 });
    }
}
