//! «Navegador»: a page rendered by a real browser, without a window — a screenshot or a PDF of it,
//! its HTML or text after its JavaScript ran, or a few steps on it (click, type, press a key).
//!
//! The browser is the one already on this computer — Chrome, Edge, Brave or Chromium — started
//! headless with a profile of its own in the run's folder (never the user's, so no session of theirs
//! is ever in reach), driven over the DevTools Protocol and closed — with every process it started —
//! when the node ends.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::error::CapacityError;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::{flag, number, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

/// The browsers this node looks for, most likely first.
fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    for app in ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Google Chrome Canary"] {
        out.push(PathBuf::from(format!("/Applications/{app}.app/Contents/MacOS/{app}")));
        if let Some(home) = dirs::home_dir() {
            out.push(home.join(format!("Applications/{app}.app/Contents/MacOS/{app}")));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for base in [std::env::var("PROGRAMFILES").unwrap_or_default(), std::env::var("PROGRAMFILES(X86)").unwrap_or_default(), std::env::var("LOCALAPPDATA").unwrap_or_default()] {
            if base.is_empty() {
                continue;
            }
            out.push(PathBuf::from(&base).join(r"Google\Chrome\Application\chrome.exe"));
            out.push(PathBuf::from(&base).join(r"Microsoft\Edge\Application\msedge.exe"));
            out.push(PathBuf::from(&base).join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
        }
    }
    #[cfg(target_os = "linux")]
    for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"] {
        if let Some(path) = crate::containers::cli::find(name) {
            out.push(path);
        }
    }
    out
}

pub fn find_browser(given: &str) -> Result<PathBuf, String> {
    if !given.trim().is_empty() {
        let path = super::expand_path(given.trim());
        return if path.exists() { Ok(path) } else { Err(format!("{} does not exist", path.display())) };
    }
    candidates()
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "No Chrome, Edge, Brave or Chromium was found on this computer — install one, or choose the browser in the node".to_string())
}

/// The largest message read from the browser. Chrome sends a capture whole, as one WebSocket frame
/// of base64: a full-page screenshot or a long page's PDF passes tungstenite's 16 MiB default, and a
/// frame over the limit ended the connection without a word — the command then waited out its whole
/// time limit, and the node looked hung.
const MAX_CDP_MESSAGE: usize = 256 << 20;

/// The commands still waiting for an answer, and — once the connection is gone — why. One lock for
/// both, so a command can never be filed after the reader has already given up on the rest.
#[derive(Default)]
struct Waiting {
    answers: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    closed: Option<String>,
}

type Pending = Arc<Mutex<Waiting>>;

/// A DevTools connection: commands with ids, answers matched back, events on a channel.
struct Cdp {
    out: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next: AtomicU64,
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<Value>>,
}

impl Cdp {
    async fn connect(url: &str) -> Result<Self, String> {
        Self::connect_within(url, MAX_CDP_MESSAGE).await
    }

    async fn connect_within(url: &str, max_message: usize) -> Result<Self, String> {
        let config = WebSocketConfig::default().max_message_size(Some(max_message)).max_frame_size(Some(max_message));
        let (socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false).await.map_err(|e| format!("DevTools: {e}"))?;
        let (mut sink, mut stream) = socket.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<Value>();
        let pending: Pending = Arc::new(Mutex::new(Waiting::default()));
        tokio::spawn(async move {
            while let Some(message) = out_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let reason = loop {
                match stream.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(doc) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        if let Some(id) = doc.get("id").and_then(Value::as_u64) {
                            let waiter = reader_pending.lock().ok().and_then(|mut waiting| waiting.answers.remove(&id));
                            if let Some(waiter) = waiter {
                                let answer = match doc.get("error") {
                                    Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("DevTools error").to_string()),
                                    None => Ok(doc.get("result").cloned().unwrap_or(Value::Null)),
                                };
                                let _ = waiter.send(answer);
                            }
                        } else {
                            let _ = event_tx.send(doc);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break "The browser closed".to_string(),
                    Some(Ok(_)) => {}
                    Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(CapacityError::MessageTooLong { size, max_size }))) => {
                        break format!("The browser's answer is {} MB, more than the {} MB this node reads", size.div_ceil(1 << 20), max_size >> 20);
                    }
                    Some(Err(error)) => break format!("DevTools: {error}"),
                }
            };
            // Every command still waiting hears why now, rather than each waiting out its time limit.
            if let Ok(mut waiting) = reader_pending.lock() {
                waiting.closed = Some(reason.clone());
                for (_, waiter) in waiting.answers.drain() {
                    let _ = waiter.send(Err(reason.clone()));
                }
            }
        });
        Ok(Self { out: out_tx, pending, next: AtomicU64::new(1), events: tokio::sync::Mutex::new(event_rx) })
    }

    async fn call(&self, session: Option<&str>, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut waiting = self.pending.lock().map_err(|e| e.to_string())?;
            if let Some(reason) = &waiting.closed {
                return Err(reason.clone());
            }
            waiting.answers.insert(id, tx);
        }
        self.out.send(Message::Text(message.to_string().into())).map_err(|_| "The browser closed".to_string())?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("The browser closed".into()),
            Err(_) => {
                // Its slot goes with it: an answer arriving later has nobody left to hand it to.
                if let Ok(mut waiting) = self.pending.lock() {
                    waiting.answers.remove(&id);
                }
                Err(format!("{method} did not answer in {} s", timeout.as_secs()))
            }
        }
    }

    /// Waits for an event named `method` (of `session`), up to `timeout`.
    async fn wait_event(&self, method: &str, session: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut events = self.events.lock().await;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match tokio::time::timeout(left, events.recv()).await {
                Ok(Some(event)) => {
                    if event.get("method").and_then(Value::as_str) == Some(method) && event.get("sessionId").and_then(Value::as_str) == Some(session) {
                        return true;
                    }
                }
                _ => return false,
            }
        }
    }
}

/// A started browser: its process and its DevTools address.
///
/// Chrome is a tree — the browser, a GPU process, a renderer per page, a crash handler — and
/// `kill_on_drop` reaches only the first, so the rest could outlive the node. It is started as a
/// process group of its own (`proc::own_process_group`) and stopped as one: by [`Browser::stop`] when
/// the node ends or is stopped, and on drop when the node's future is dropped before it gets there.
struct Browser {
    child: tokio::process::Child,
    ws: String,
}

impl Browser {
    /// SIGTERM to the whole group, a moment, then SIGKILL (`taskkill /T` on Windows).
    async fn stop(&mut self) {
        crate::ai_runs::kill_tree(&mut self.child).await;
        // Reaped, so the drop below finds nothing left to stop: `id()` is `None` once waited for.
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let Some(pid) = self.child.id() else { return };
        #[cfg(unix)]
        {
            // SAFETY: integers only; the pid is the group id (`proc::own_process_group`), and a group
            // that has already gone answers ESRCH, which is fine.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        #[cfg(windows)]
        {
            // Not waited for: a drop is no place to block, and `/T` walks the tree by itself.
            let _ = crate::proc::std_command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }
}

async fn launch(binary: &Path, profile: &Path, width: u32, height: u32) -> Result<Browser, String> {
    std::fs::create_dir_all(profile).map_err(|e| e.to_string())?;
    let mut cmd = crate::proc::command(binary);
    cmd.args([
        "--headless=new".to_string(),
        "--disable-gpu".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-extensions".into(),
        "--hide-scrollbars".into(),
        "--mute-audio".into(),
        "--remote-debugging-port=0".into(),
        format!("--window-size={width},{height}"),
        format!("--user-data-dir={}", profile.display()),
        "about:blank".into(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    crate::proc::own_process_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", binary.display()))?;
    let stderr = child.stderr.take().ok_or("The browser gave no output")?;
    let mut lines = BufReader::new(stderr).lines();
    // Chrome says where its DevTools listen on stderr: `DevTools listening on ws://127.0.0.1:PORT/devtools/browser/ID`.
    let ws = tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.split("DevTools listening on ").nth(1) {
                return Some(rest.trim().to_string());
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .ok_or("The browser did not open its DevTools in time")?;
    // Keep draining stderr so the browser never blocks on a full pipe.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Ok(Browser { child, ws })
}

/// One step of «Pasos»: `click`, `type`, `press`, `wait`, `waitFor`, `eval`, `goto`, `scroll`.
async fn run_step(cdp: &Cdp, session: &str, step: &Value, timeout: Duration) -> Result<Option<Value>, String> {
    let action = step.get("action").and_then(Value::as_str).unwrap_or_default();
    let selector = step.get("selector").and_then(Value::as_str).unwrap_or_default();
    let eval = |expression: String| async move {
        let answer = cdp.call(Some(session), "Runtime.evaluate", json!({"expression": expression, "awaitPromise": true, "returnByValue": true}), timeout).await?;
        if let Some(exception) = answer.get("exceptionDetails") {
            return Err(exception.pointer("/exception/description").and_then(Value::as_str).unwrap_or("The script failed").to_string());
        }
        Ok(answer.pointer("/result/value").cloned().unwrap_or(Value::Null))
    };
    let selector_js = serde_json::to_string(selector).unwrap_or_default();
    match action {
        "click" => {
            let point = eval(format!(
                "(() => {{ const el = document.querySelector({selector_js}); if (!el) return null; el.scrollIntoView({{block:'center'}}); const r = el.getBoundingClientRect(); return {{x: r.left + r.width/2, y: r.top + r.height/2}}; }})()"
            ))
            .await?;
            let (x, y) = (point.get("x").and_then(Value::as_f64).ok_or(format!("No element matches {selector}"))?, point.get("y").and_then(Value::as_f64).unwrap_or(0.0));
            for kind in ["mousePressed", "mouseReleased"] {
                cdp.call(Some(session), "Input.dispatchMouseEvent", json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}), timeout).await?;
            }
            Ok(None)
        }
        "type" => {
            let found = eval(format!("(() => {{ const el = document.querySelector({selector_js}); if (!el) return false; el.focus(); return true; }})()")).await?;
            if found != Value::Bool(true) {
                return Err(format!("No element matches {selector}"));
            }
            let value = step.get("text").and_then(Value::as_str).unwrap_or_default();
            cdp.call(Some(session), "Input.insertText", json!({"text": value}), timeout).await?;
            Ok(None)
        }
        "press" => {
            let key = step.get("key").and_then(Value::as_str).unwrap_or("Enter");
            let (code, vk) = match key {
                "Enter" => ("Enter", 13),
                "Tab" => ("Tab", 9),
                "Escape" => ("Escape", 27),
                "Backspace" => ("Backspace", 8),
                "ArrowDown" => ("ArrowDown", 40),
                "ArrowUp" => ("ArrowUp", 38),
                _ => (key, 0),
            };
            for kind in ["keyDown", "keyUp"] {
                let mut event = json!({"type": kind, "key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk});
                if kind == "keyDown" && key == "Enter" {
                    event["text"] = json!("\r");
                }
                cdp.call(Some(session), "Input.dispatchKeyEvent", event, timeout).await?;
            }
            Ok(None)
        }
        "wait" => {
            let ms = step.get("ms").and_then(Value::as_u64).unwrap_or(1000).min(60_000);
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(None)
        }
        "waitFor" => {
            wait_for(cdp, session, selector, timeout).await?;
            Ok(None)
        }
        "goto" => {
            let url = step.get("url").and_then(Value::as_str).unwrap_or_default();
            navigate(cdp, session, url, timeout).await?;
            Ok(None)
        }
        "scroll" => {
            eval("window.scrollTo(0, document.body.scrollHeight)".into()).await?;
            Ok(None)
        }
        "eval" => {
            let script = step.get("script").and_then(Value::as_str).unwrap_or_default();
            Ok(Some(eval(script.to_string()).await?))
        }
        other => Err(format!("Unknown step \"{other}\" — click, type, press, wait, waitFor, goto, scroll or eval")),
    }
}

async fn wait_for(cdp: &Cdp, session: &str, selector: &str, timeout: Duration) -> Result<(), String> {
    if selector.trim().is_empty() {
        return Ok(());
    }
    let deadline = Instant::now() + timeout;
    let expression = format!("!!document.querySelector({})", serde_json::to_string(selector).unwrap_or_default());
    loop {
        let answer = cdp.call(Some(session), "Runtime.evaluate", json!({"expression": expression, "returnByValue": true}), Duration::from_secs(10)).await?;
        if answer.pointer("/result/value") == Some(&Value::Bool(true)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("{selector} never appeared"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn navigate(cdp: &Cdp, session: &str, url: &str, timeout: Duration) -> Result<(), String> {
    let address = if url.contains("://") || url.starts_with("about:") || url.starts_with("data:") { url.to_string() } else { format!("https://{url}") };
    let answer = cdp.call(Some(session), "Page.navigate", json!({"url": address}), timeout).await?;
    if let Some(error) = answer.get("errorText").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        return Err(format!("{address}: {error}"));
    }
    // A page that never finishes loading (a stream, a beacon) is used as it is after the time limit.
    let _ = cdp.wait_event("Page.loadEventFired", session, timeout).await;
    Ok(())
}

fn save_bytes(params: &Value, ctx: &NodeCtx, data: &str, extension: &str) -> Result<Value, NodeError> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| NodeError::failed(e.to_string()))?;
    let asked = text(params, "savePath");
    let path = if asked.trim().is_empty() {
        ctx.run.host.work_dir().join(format!("pagina-{}.{extension}", &uuid::Uuid::new_v4().simple().to_string()[..8]))
    } else {
        super::expand_path(asked.trim())
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| NodeError::failed(e.to_string()))?;
    }
    std::fs::write(&path, &bytes).map_err(|e| NodeError::failed(format!("{}: {e}", path.display())))?;
    Ok(super::binary::reference_of(&path))
}

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let each = ctx.param_str("runFor") != "once" && !ctx.items().is_empty();
    let resolved = if each { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    let first = resolved.first().cloned().unwrap_or(Value::Null);
    let binary = find_browser(&text(&first, "browserPath")).map_err(NodeError::Failed)?;
    let width = number(&first, "viewportWidth").unwrap_or(1280.0).clamp(320.0, 3840.0) as u32;
    let height = number(&first, "viewportHeight").unwrap_or(800.0).clamp(240.0, 2160.0) as u32;
    let profile = ctx.run.host.work_dir().join(format!("browser-{}", ctx.node.id));
    let mut browser = launch(&binary, &profile, width, height).await.map_err(NodeError::Failed)?;
    ctx.log(LogStream::Info, &format!("{} started headless", binary.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let work = async {
        let cdp = Cdp::connect(&browser.ws).await.map_err(NodeError::Failed)?;
        let mut out = Vec::new();
        for (index, params) in resolved.iter().enumerate() {
            let timeout = Duration::from_millis(number(params, "timeoutMs").unwrap_or(30_000.0).clamp(2000.0, 300_000.0) as u64);
            let fail = |e: String| NodeError::Failed(e);
            let target = cdp.call(None, "Target.createTarget", json!({"url": "about:blank"}), timeout).await.map_err(fail)?;
            let target_id = target.get("targetId").and_then(Value::as_str).unwrap_or_default().to_string();
            let attached = cdp.call(None, "Target.attachToTarget", json!({"targetId": target_id, "flatten": true}), timeout).await.map_err(fail)?;
            let session = attached.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
            cdp.call(Some(&session), "Page.enable", json!({}), timeout).await.map_err(fail)?;
            cdp.call(Some(&session), "Runtime.enable", json!({}), timeout).await.map_err(fail)?;
            cdp.call(Some(&session), "Emulation.setDeviceMetricsOverride", json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}), timeout).await.map_err(fail)?;
            let url = text(params, "url");
            if url.trim().is_empty() {
                return Err(NodeError::failed("Write the page's address"));
            }
            navigate(&cdp, &session, url.trim(), timeout).await.map_err(fail)?;
            wait_for(&cdp, &session, &text(params, "waitFor"), timeout).await.map_err(fail)?;
            let extra = number(params, "waitMs").unwrap_or(0.0).clamp(0.0, 60_000.0) as u64;
            if extra > 0 {
                tokio::time::sleep(Duration::from_millis(extra)).await;
            }
            let op = text(params, "browserOp");
            let mut results = Vec::new();
            if op == "browserRun" {
                let steps: Value = match params.get("browserSteps") {
                    Some(Value::String(s)) if !s.trim().is_empty() => serde_json::from_str(s).map_err(|e| NodeError::failed(format!("The steps are not JSON: {e}")))?,
                    Some(Value::Array(list)) => Value::Array(list.clone()),
                    _ => json!([]),
                };
                for (n, step) in steps.as_array().cloned().unwrap_or_default().iter().enumerate() {
                    match run_step(&cdp, &session, step, timeout).await {
                        Ok(Some(value)) => results.push(value),
                        Ok(None) => {}
                        Err(error) => return Err(NodeError::failed(format!("Step {}: {error}", n + 1))),
                    }
                }
            }
            let info = cdp
                .call(Some(&session), "Runtime.evaluate", json!({"expression": "({url: location.href, title: document.title})", "returnByValue": true}), timeout)
                .await
                .map_err(fail)?;
            let mut item = info.pointer("/result/value").cloned().unwrap_or(json!({}));
            match op.as_str() {
                "browserShot" => {
                    let mut request = json!({"format": "png", "captureBeyondViewport": true});
                    if flag(params, "fullPage") {
                        let metrics = cdp.call(Some(&session), "Page.getLayoutMetrics", json!({}), timeout).await.map_err(fail)?;
                        let w = metrics.pointer("/cssContentSize/width").and_then(Value::as_f64).unwrap_or(width as f64);
                        let h = metrics.pointer("/cssContentSize/height").and_then(Value::as_f64).unwrap_or(height as f64).min(30_000.0);
                        request["clip"] = json!({"x": 0, "y": 0, "width": w, "height": h, "scale": 1});
                    }
                    let shot = cdp.call(Some(&session), "Page.captureScreenshot", request, timeout).await.map_err(fail)?;
                    item["file"] = save_bytes(params, ctx, shot.get("data").and_then(Value::as_str).unwrap_or_default(), "png")?;
                }
                "browserPdf" => {
                    let pdf = cdp.call(Some(&session), "Page.printToPDF", json!({"printBackground": true, "preferCSSPageSize": true}), timeout).await.map_err(fail)?;
                    item["file"] = save_bytes(params, ctx, pdf.get("data").and_then(Value::as_str).unwrap_or_default(), "pdf")?;
                }
                _ => {
                    let html = cdp
                        .call(Some(&session), "Runtime.evaluate", json!({"expression": "document.documentElement.outerHTML", "returnByValue": true}), timeout)
                        .await
                        .map_err(fail)?
                        .pointer("/result/value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let base = item.get("url").and_then(Value::as_str).and_then(|u| url::Url::parse(u).ok());
                    match op.as_str() {
                        "browserHtml" => item["html"] = json!(html),
                        "browserText" => {
                            let page = super::utils::page_markdown(&html, base.as_ref());
                            item["markdown"] = page.get("markdown").cloned().unwrap_or(Value::Null);
                            item["text"] = super::utils::page_text(&html, base.as_ref()).get("text").cloned().unwrap_or(Value::Null);
                        }
                        _ => {
                            item["results"] = json!(results);
                            item["markdown"] = super::utils::page_markdown(&html, base.as_ref()).get("markdown").cloned().unwrap_or(Value::Null);
                        }
                    }
                }
            }
            let _ = cdp.call(None, "Target.closeTarget", json!({"targetId": target_id}), Duration::from_secs(5)).await;
            out.push(if ctx.items().is_empty() { Item::new(item) } else { Item::paired(item, if each { index } else { 0 }) });
        }
        let _ = cdp.call(None, "Browser.close", json!({}), Duration::from_secs(5)).await;
        Ok::<_, NodeError>(out)
    };
    let result = tokio::select! {
        result = work => result,
        _ = ctx.cancel.cancelled() => Err(NodeError::Cancelled),
    };
    browser.stop().await;
    let _ = std::fs::remove_dir_all(&profile);
    Ok(vec![result?])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the browser on this computer: `CODEFLOW_LIVE_BROWSER=1 cargo test --lib
    /// flows::nodes::browser -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_render() {
        if std::env::var("CODEFLOW_LIVE_BROWSER").is_err() {
            return;
        }
        let binary = find_browser("").expect("a browser");
        let profile = std::env::temp_dir().join(format!("cf-browser-{}", uuid::Uuid::new_v4()));
        let mut browser = launch(&binary, &profile, 800, 600).await.unwrap();
        let cdp = Cdp::connect(&browser.ws).await.unwrap();
        let target = cdp.call(None, "Target.createTarget", json!({"url": "about:blank"}), Duration::from_secs(10)).await.unwrap();
        let attached = cdp.call(None, "Target.attachToTarget", json!({"targetId": target["targetId"], "flatten": true}), Duration::from_secs(10)).await.unwrap();
        let session = attached["sessionId"].as_str().unwrap().to_string();
        cdp.call(Some(&session), "Page.enable", json!({}), Duration::from_secs(10)).await.unwrap();
        navigate(&cdp, &session, "data:text/html,<h1 id=t>Hola</h1><input id=q><script>document.title='ok'</script>", Duration::from_secs(10)).await.unwrap();
        run_step(&cdp, &session, &json!({"action": "type", "selector": "#q", "text": "abc"}), Duration::from_secs(10)).await.unwrap();
        let value = run_step(&cdp, &session, &json!({"action": "eval", "script": "document.querySelector('#q').value + document.title"}), Duration::from_secs(10)).await.unwrap();
        assert_eq!(value, Some(json!("abcok")));
        let shot = cdp.call(Some(&session), "Page.captureScreenshot", json!({"format": "png"}), Duration::from_secs(10)).await.unwrap();
        assert!(shot["data"].as_str().unwrap().len() > 100);
        browser.stop().await;
        let _ = std::fs::remove_dir_all(&profile);
    }

    /// An answer over the limit fails the command waiting for it at once, and every command after it,
    /// where it used to end the connection without a word and leave the command to its time limit.
    #[tokio::test]
    async fn an_answer_over_the_limit_fails_at_once_instead_of_hanging() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            // Whatever it is asked, the browser answers with a capture too big for the client's limit.
            if let Some(Ok(Message::Text(asked))) = socket.next().await {
                let id = serde_json::from_str::<Value>(asked.as_str()).unwrap()["id"].clone();
                let answer = json!({"id": id, "result": {"data": "A".repeat(4096)}});
                let _ = socket.send(Message::Text(answer.to_string().into())).await;
            }
            // Held open: the client must not need a close to learn it was refused.
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let cdp = Cdp::connect_within(&format!("ws://{address}"), 1024).await.unwrap();
        let started = Instant::now();
        let error = cdp.call(None, "Page.captureScreenshot", json!({}), Duration::from_secs(20)).await.unwrap_err();
        assert!(error.contains("more than"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5), "failed at once, not at its time limit");
        let again = cdp.call(None, "Page.printToPDF", json!({}), Duration::from_secs(20)).await.unwrap_err();
        assert_eq!(again, error, "the connection is known to be gone");
    }
}
