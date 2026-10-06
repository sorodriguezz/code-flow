//! Bots that need no public URL: Telegram by long polling, Slack by Socket Mode, Discord by its
//! Gateway.
//!
//! **Every one of them is a connection this computer opens**, which is the whole point. A webhook
//! needs the internet to reach the laptop, and the webhook server listens on 127.0.0.1 — so a
//! Telegram or Slack bot set up the usual way can never call a flow. These three are the ways each
//! service offers to *pull* events instead, and with them a flow answers its bot from anywhere:
//! a phone on mobile data, a colleague in another office.
//!
//! What a message becomes is one item per message, the same shape on all three — `platform`,
//! `chat`, `user`, `userName`, `text`, `messageId` — plus what is particular to each (`raw` keeps the
//! service's own object). The reply goes out through the Conector's Telegram, Slack or Discord-bot
//! entries with `{{ $json.chat }}`, like any other message.
//!
//! **Messages from bots are ignored**, this one included: a flow that replies in the channel it
//! listens to would otherwise answer itself forever.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_util::sync::CancellationToken;

use super::TriggerView;
use crate::api::NetworkOptions;
use crate::db::{flow_run_queries, Db};
use crate::flows::run::Item;

fn text(params: &Value, name: &str) -> String {
    params.get(name).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// The token behind the trigger's credential — a bearer credential's secret, read from the keychain
/// on every connection so a rotated token is picked up on the next reconnect.
fn token(params: &Value) -> Result<String, String> {
    let id = text(params, "credential");
    if id.is_empty() {
        return Err("Choose the credential with the bot's token".into());
    }
    crate::secrets::get_secret(&crate::secrets::flow_credential_key(&id))?.ok_or_else(|| "The credential has no secret stored".to_string())
}

/// What the trigger was told to keep: a list of chats, words a message must contain, commands only.
#[derive(Clone)]
struct Filter {
    chats: Vec<String>,
    contains: String,
    commands_only: bool,
}

impl Filter {
    fn of(params: &Value) -> Self {
        Self {
            chats: text(params, "chats").split([',', ' ', '\n']).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
            contains: text(params, "textFilter").to_lowercase(),
            commands_only: params.get("commandsOnly").and_then(Value::as_bool).unwrap_or(false),
        }
    }

    fn keeps(&self, chat: &str, text: &str) -> bool {
        (self.chats.is_empty() || self.chats.iter().any(|c| c == chat))
            && (self.contains.is_empty() || text.to_lowercase().contains(&self.contains))
            && (!self.commands_only || text.trim_start().starts_with('/'))
    }
}

/// One message, in the shape all three platforms share.
fn message(platform: &str, chat: &str, user: &str, user_name: &str, text: &str, id: &str, raw: Value) -> Value {
    json!({
        "platform": platform,
        "chat": chat,
        "user": user,
        "userName": user_name,
        "text": text,
        "messageId": id,
        "at": chrono::Utc::now().to_rfc3339(),
        "raw": raw,
    })
}

type Sink = Arc<dyn Fn(Value) + Send + Sync>;

pub fn spawn(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    params: &Value,
    view: Arc<Mutex<TriggerView>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    token(params)?;
    // Option values carry a prefix so their labels do not collide with the connectors' names.
    let platform = text(params, "platform").trim_start_matches("bot").to_lowercase();
    let filter = Filter::of(params);
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(1);
        loop {
            if cancel.is_cancelled() {
                return;
            }
            let started = Instant::now();
            let fire: Sink = {
                let (app, flow_id, node_id, view, filter) = (app.clone(), flow_id.clone(), node_id.clone(), view.clone(), filter.clone());
                Arc::new(move |item: Value| {
                    let chat = item.get("chat").and_then(Value::as_str).unwrap_or_default();
                    let body = item.get("text").and_then(Value::as_str).unwrap_or_default();
                    if !filter.keeps(chat, body) {
                        return;
                    }
                    super::note_problem(&view, None);
                    if let Err(error) = super::fire(&app, &flow_id, &node_id, vec![Item::new(item)]) {
                        super::note_problem(&view, Some(error));
                    }
                })
            };
            let opened = {
                let view = view.clone();
                move || super::note_problem(&view, None)
            };
            let outcome = match token(&params) {
                Err(error) => Err(error),
                Ok(token) => match platform.as_str() {
                    "slack" => slack(&token, fire, opened, cancel.clone()).await,
                    "discord" => discord(&token, fire, opened, cancel.clone()).await,
                    _ => telegram(&app, &flow_id, &node_id, &token, fire, opened, cancel.clone()).await,
                },
            };
            if cancel.is_cancelled() {
                return;
            }
            super::note_problem(
                &view,
                Some(match outcome {
                    Ok(()) => "The connection was closed — reconnecting".to_string(),
                    Err(error) => error,
                }),
            );
            if started.elapsed() > Duration::from_secs(60) {
                wait = Duration::from_secs(1);
            }
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => return,
            }
            wait = (wait * 2).min(Duration::from_secs(60));
        }
    });
    Ok(())
}

// ------------------------------------------------------------------------------------- Telegram

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())
}

/// Telegram's `getUpdates`, long-polled. The offset is kept in the flow's state so a restart does not
/// replay what was already answered; the very first connection skips the backlog rather than running
/// the flow for every message the bot received before it existed.
async fn telegram(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    token: &str,
    fire: Sink,
    opened: impl Fn(),
    cancel: CancellationToken,
) -> Result<(), String> {
    let http = client(Duration::from_secs(70))?;
    let base = format!("https://api.telegram.org/bot{token}");
    let key = format!("bot:{node_id}:offset");
    let load = || -> Option<i64> {
        let db = app.state::<Db>();
        let conn = db.0.lock().ok()?;
        flow_run_queries::state_get(&conn, flow_id, &key).ok().flatten().and_then(|v| v.as_i64())
    };
    let save = |offset: i64| {
        let db = app.state::<Db>();
        let conn = db.0.lock();
        if let Ok(conn) = conn {
            let _ = flow_run_queries::state_set(&conn, flow_id, &key, &json!(offset), &crate::flows::engine::now_text());
        }
    };
    let get = |url: String| {
        let http = http.clone();
        async move {
            let response = http.get(&url).send().await.map_err(|e| format!("Telegram: {e}"))?;
            let status = response.status();
            let body: Value = response.json().await.map_err(|e| format!("Telegram answered something that is not JSON: {e}"))?;
            if status.as_u16() == 409 {
                return Err("This bot has a webhook set, and Telegram allows one or the other: remove it (deleteWebhook) to use it from here".to_string());
            }
            if body.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(format!("Telegram: {}", body.get("description").and_then(Value::as_str).unwrap_or("the request was refused")));
            }
            Ok::<Vec<Value>, String>(body.get("result").and_then(Value::as_array).cloned().unwrap_or_default())
        }
    };
    let mut offset = match load() {
        Some(offset) => offset,
        None => {
            let last = get(format!("{base}/getUpdates?offset=-1&timeout=0")).await?;
            let next = last.iter().filter_map(|u| u.get("update_id").and_then(Value::as_i64)).max().map_or(0, |id| id + 1);
            save(next);
            next
        }
    };
    opened();
    loop {
        let url = format!(
            "{base}/getUpdates?timeout=50&offset={offset}&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22channel_post%22%2C%22callback_query%22%5D"
        );
        let updates = tokio::select! {
            updates = get(url) => updates?,
            _ = cancel.cancelled() => return Ok(()),
        };
        for update in updates {
            if let Some(id) = update.get("update_id").and_then(Value::as_i64) {
                offset = offset.max(id + 1);
            }
            if let Some(query) = update.get("callback_query") {
                let from = query.get("from").cloned().unwrap_or(Value::Null);
                let chat = query.pointer("/message/chat/id").map(|v| v.to_string()).unwrap_or_default();
                let mut item = message(
                    "telegram",
                    &chat,
                    &from.get("id").map(|v| v.to_string()).unwrap_or_default(),
                    from.get("username").and_then(Value::as_str).unwrap_or_default(),
                    query.get("data").and_then(Value::as_str).unwrap_or_default(),
                    query.get("id").and_then(Value::as_str).unwrap_or_default(),
                    query.clone(),
                );
                item["kind"] = json!("button");
                fire(item);
                continue;
            }
            let Some(msg) = update.get("message").or_else(|| update.get("edited_message")).or_else(|| update.get("channel_post")) else { continue };
            if msg.pointer("/from/is_bot").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let from = msg.get("from").cloned().unwrap_or(Value::Null);
            fire(message(
                "telegram",
                &msg.pointer("/chat/id").map(|v| v.to_string()).unwrap_or_default(),
                &from.get("id").map(|v| v.to_string()).unwrap_or_default(),
                from.get("username").or_else(|| from.get("first_name")).and_then(Value::as_str).unwrap_or_default(),
                msg.get("text").or_else(|| msg.get("caption")).and_then(Value::as_str).unwrap_or_default(),
                &msg.get("message_id").map(|v| v.to_string()).unwrap_or_default(),
                msg.clone(),
            ));
        }
        save(offset);
    }
}

// ---------------------------------------------------------------------------------------- Slack

/// Slack's Socket Mode: `apps.connections.open` with the app-level token (`xapp-…`) hands back a
/// WebSocket; every envelope on it is acknowledged by id, as Slack requires within three seconds.
async fn slack(token: &str, fire: Sink, opened: impl Fn(), cancel: CancellationToken) -> Result<(), String> {
    let http = client(Duration::from_secs(20))?;
    let open: Value = http
        .post("https://slack.com/api/apps.connections.open")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Slack: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Slack: {e}"))?;
    if open.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = open.get("error").and_then(Value::as_str).unwrap_or("refused");
        return Err(match error {
            "not_allowed_token_type" | "invalid_auth" => "Slack wants the app-level token (xapp-…, with connections:write) for Socket Mode".to_string(),
            other => format!("Slack: {other}"),
        });
    }
    let url = open.get("url").and_then(Value::as_str).ok_or("Slack gave no Socket Mode address")?.to_string();
    let network = NetworkOptions::default();
    let stream = tokio::select! {
        stream = crate::api::ws::dial(&url, &[], &[], &network) => stream?,
        _ = cancel.cancelled() => return Ok(()),
    };
    let (mut writer, mut reader) = stream.split();
    loop {
        let frame = tokio::select! {
            frame = reader.next() => frame,
            _ = cancel.cancelled() => {
                let _ = writer.send(Message::Close(None)).await;
                return Ok(());
            }
        };
        let Some(frame) = frame else { return Ok(()) };
        let frame = frame.map_err(|e| format!("Slack: {e}"))?;
        let body = match frame {
            Message::Text(text) => text.to_string(),
            Message::Ping(data) => {
                let _ = writer.send(Message::Pong(data)).await;
                continue;
            }
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let Ok(envelope) = serde_json::from_str::<Value>(&body) else { continue };
        if let Some(id) = envelope.get("envelope_id").and_then(Value::as_str) {
            writer.send(Message::text(json!({"envelope_id": id}).to_string())).await.map_err(|e| format!("Slack: {e}"))?;
        }
        match envelope.get("type").and_then(Value::as_str).unwrap_or_default() {
            "hello" => opened(),
            "disconnect" => return Ok(()),
            "events_api" => {
                let Some(event) = envelope.pointer("/payload/event") else { continue };
                let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
                if !matches!(kind, "message" | "app_mention") || event.get("bot_id").is_some() {
                    continue;
                }
                if event.get("subtype").and_then(Value::as_str).is_some_and(|s| s != "thread_broadcast" && s != "file_share") {
                    continue;
                }
                let mut item = message(
                    "slack",
                    event.get("channel").and_then(Value::as_str).unwrap_or_default(),
                    event.get("user").and_then(Value::as_str).unwrap_or_default(),
                    event.get("user").and_then(Value::as_str).unwrap_or_default(),
                    event.get("text").and_then(Value::as_str).unwrap_or_default(),
                    event.get("ts").and_then(Value::as_str).unwrap_or_default(),
                    event.clone(),
                );
                item["kind"] = json!(kind);
                item["threadTs"] = event.get("thread_ts").cloned().unwrap_or(Value::Null);
                fire(item);
            }
            "slash_commands" => {
                let Some(payload) = envelope.get("payload") else { continue };
                let field = |name: &str| payload.get(name).and_then(Value::as_str).unwrap_or_default();
                let mut item = message("slack", field("channel_id"), field("user_id"), field("user_name"), &format!("{} {}", field("command"), field("text")).trim().to_string(), field("trigger_id"), payload.clone());
                item["kind"] = json!("command");
                item["responseUrl"] = json!(field("response_url"));
                fire(item);
            }
            _ => {}
        }
    }
}

// -------------------------------------------------------------------------------------- Discord

/// What the bot asks the Gateway for: guild messages, direct messages and their content.
const DISCORD_INTENTS: u64 = (1 << 9) | (1 << 12) | (1 << 15);

/// Discord's Gateway: identify with the bot token, keep the heartbeat the hello asked for, read
/// `MESSAGE_CREATE`. A reconnect identifies again — simpler than resuming, and a missed message
/// in the second it takes is the trade.
async fn discord(token: &str, fire: Sink, opened: impl Fn(), cancel: CancellationToken) -> Result<(), String> {
    let http = client(Duration::from_secs(20))?;
    let gateway: Value = http
        .get("https://discord.com/api/v10/gateway/bot")
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
        .map_err(|e| format!("Discord: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Discord: {e}"))?;
    let Some(base) = gateway.get("url").and_then(Value::as_str) else {
        return Err(format!("Discord: {}", gateway.get("message").and_then(Value::as_str).unwrap_or("the bot token was refused")));
    };
    let address = format!("{base}/?v=10&encoding=json");
    let network = NetworkOptions::default();
    let stream = tokio::select! {
        stream = crate::api::ws::dial(&address, &[], &[], &network) => stream?,
        _ = cancel.cancelled() => return Ok(()),
    };
    let (mut writer, mut reader) = stream.split();
    let mut sequence: Value = Value::Null;
    let mut beat = tokio::time::interval(Duration::from_secs(3600));
    beat.tick().await;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = writer.send(Message::Close(None)).await;
                return Ok(());
            }
            _ = beat.tick() => {
                writer.send(Message::text(json!({"op": 1, "d": sequence}).to_string())).await.map_err(|e| format!("Discord: {e}"))?;
            }
            frame = reader.next() => {
                let Some(frame) = frame else { return Ok(()) };
                let body = match frame.map_err(|e| format!("Discord: {e}"))? {
                    Message::Text(text) => text.to_string(),
                    Message::Close(close) => {
                        return match close.map(|c| u16::from(c.code)) {
                            Some(4004) => Err("Discord refused the bot token".into()),
                            Some(4014) => Err("Discord: turn on the Message Content intent for this bot in the developer portal".into()),
                            _ => Ok(()),
                        };
                    }
                    _ => continue,
                };
                let Ok(event) = serde_json::from_str::<Value>(&body) else { continue };
                if let Some(s) = event.get("s").filter(|s| !s.is_null()) {
                    sequence = s.clone();
                }
                match event.get("op").and_then(Value::as_u64) {
                    Some(10) => {
                        let every = event.pointer("/d/heartbeat_interval").and_then(Value::as_u64).unwrap_or(41_250);
                        beat = tokio::time::interval(Duration::from_millis(every));
                        beat.tick().await;
                        let identify = json!({
                            "op": 2,
                            "d": {
                                "token": token,
                                "intents": DISCORD_INTENTS,
                                "properties": {"os": std::env::consts::OS, "browser": "codeflow", "device": "codeflow"},
                            },
                        });
                        writer.send(Message::text(identify.to_string())).await.map_err(|e| format!("Discord: {e}"))?;
                    }
                    Some(1) => {
                        writer.send(Message::text(json!({"op": 1, "d": sequence}).to_string())).await.map_err(|e| format!("Discord: {e}"))?;
                    }
                    Some(7) | Some(9) => return Ok(()),
                    Some(0) => match event.get("t").and_then(Value::as_str) {
                        Some("READY") => opened(),
                        Some("MESSAGE_CREATE") => {
                            let Some(d) = event.get("d") else { continue };
                            if d.pointer("/author/bot").and_then(Value::as_bool) == Some(true) {
                                continue;
                            }
                            let field = |pointer: &str| d.pointer(pointer).and_then(Value::as_str).unwrap_or_default();
                            let mut item = message("discord", field("/channel_id"), field("/author/id"), field("/author/username"), field("/content"), field("/id"), d.clone());
                            item["guild"] = d.get("guild_id").cloned().unwrap_or(Value::Null);
                            fire(item);
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filter_keeps_what_was_asked() {
        let filter = Filter::of(&json!({"chats": "1, -100", "textFilter": "Deploy", "commandsOnly": true}));
        assert!(filter.keeps("1", "/deploy api"));
        assert!(!filter.keeps("2", "/deploy api"), "another chat");
        assert!(!filter.keeps("1", "deploy api"), "not a command");
        assert!(!filter.keeps("-100", "/status"), "missing the words");
        assert!(Filter::of(&json!({})).keeps("anything", "anything"));
    }
}
