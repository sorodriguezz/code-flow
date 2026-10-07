//! A public address for the webhooks — `cloudflared`'s quick tunnel or Tailscale Funnel.
//!
//! The webhook server listens on 127.0.0.1 on purpose, so GitHub, Stripe or Slack cannot reach a
//! flow on this computer. When the user asks (the Programación pane), one of two tools they install
//! themselves forwards an internet address to that port:
//!
//! - **cloudflared** (`cloudflared tunnel --url http://127.0.0.1:<port>`): no account, a random
//!   `https://….trycloudflare.com` that changes every time it starts. Read off its log.
//! - **Tailscale Funnel** (`tailscale funnel --bg <port>`): the machine's own stable
//!   `https://<machine>.<tailnet>.ts.net`, for someone already on Tailscale.
//!
//! Through either, a webhook that takes **no credential is refused** (`webhook::through_tunnel`):
//! one set up for this machine must not become everybody's because a tunnel was opened.
//!
//! The choice is a setting (`flows_tunnel`), so the tunnel comes back with the webhook server after
//! a restart; it stops when the app quits.

use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Db;

const SETTING: &str = "flows_tunnel";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    /// `off`, `cloudflared` or `tailscale`.
    pub kind: String,
    /// The public base for `/hooks/…`, once known.
    pub url: Option<String>,
    pub starting: bool,
    pub error: Option<String>,
}

struct Tunnel {
    status: TunnelStatus,
    child: Option<Child>,
}

static TUNNEL: LazyLock<Mutex<Tunnel>> =
    LazyLock::new(|| Mutex::new(Tunnel { status: TunnelStatus { kind: "off".into(), ..Default::default() }, child: None }));

pub fn status() -> TunnelStatus {
    TUNNEL.lock().map(|t| t.status.clone()).unwrap_or_default()
}

/// The public URL of a webhook path, when a tunnel is up.
/// Any path of the flows' server through the tunnel — a form, an approval page.
pub fn public_url(path: &str) -> Option<String> {
    status().url.map(|base| format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/')))
}

pub fn public_hook(path: &str) -> Option<String> {
    status().url.map(|base| format!("{}/hooks/{}", base.trim_end_matches('/'), path.trim_start_matches('/')))
}

fn emit(app: &AppHandle) {
    let _ = app.emit("flows:tunnel", status());
    // The webhooks' public addresses ride on the trigger status: have it read again.
    let _ = app.emit("flows:triggers", ());
}

fn saved(app: &AppHandle) -> String {
    app.try_state::<Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| crate::db::queries::get_setting(&conn, SETTING).ok().flatten()))
        .unwrap_or_else(|| "off".into())
}

/// Turns the tunnel on (`cloudflared` / `tailscale`) or off, and remembers the choice.
pub fn set(app: &AppHandle, kind: &str) -> Result<TunnelStatus, String> {
    let kind = match kind {
        "cloudflared" | "tailscale" => kind,
        _ => "off",
    };
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::queries::set_setting(&conn, SETTING, kind).map_err(|e| e.to_string())?;
    }
    stop();
    if kind == "off" {
        emit(app);
        return Ok(status());
    }
    crate::flows::triggers::webhook::ensure_server(app)?;
    start(app, kind);
    Ok(status())
}

/// Called when the webhook server comes up: brings back the tunnel the user had on.
pub fn resume(app: &AppHandle) {
    let kind = saved(app);
    if kind != "off" && status().kind == "off" {
        start(app, &kind);
    }
}

fn start(app: &AppHandle, kind: &str) {
    let port = crate::flows::triggers::webhook::port();
    if let Ok(mut tunnel) = TUNNEL.lock() {
        tunnel.status = TunnelStatus { kind: kind.into(), url: None, starting: true, error: None };
    }
    emit(app);
    let app = app.clone();
    let kind = kind.to_string();
    std::thread::spawn(move || {
        let outcome = if kind == "tailscale" { start_tailscale(port) } else { start_cloudflared(&app, port) };
        if let Ok(mut tunnel) = TUNNEL.lock() {
            if tunnel.status.kind == kind {
                tunnel.status.starting = false;
                match outcome {
                    Ok(Some(url)) => tunnel.status.url = Some(url),
                    Ok(None) => {}
                    Err(error) => tunnel.status.error = Some(error),
                }
            }
        }
        emit(&app);
    });
}

/// Finds a tool on the user's PATH — the app's own PATH is not a login shell's on macOS, so the usual
/// Homebrew prefixes are tried too.
fn find_tool(name: &str) -> Option<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/Applications/Tailscale.app/Contents/MacOS"] {
        dirs.push(extra.into());
    }
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let capital = if cfg!(target_os = "macos") && name == "tailscale" { Some("Tailscale".to_string()) } else { None };
    dirs.into_iter().find_map(|dir| {
        let candidate = dir.join(&exe);
        if candidate.is_file() {
            return Some(candidate);
        }
        capital.as_ref().map(|c| dir.join(c)).filter(|c| c.is_file())
    })
}

fn start_cloudflared(app: &AppHandle, port: u16) -> Result<Option<String>, String> {
    let tool = find_tool("cloudflared").ok_or("cloudflared is not installed (brew install cloudflared, or cloudflare.com/products/tunnel)")?;
    // No console window on Windows (`proc::std_command`).
    let mut command = crate::proc::std_command(tool);
    command
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("cloudflared did not start: {e}"))?;
    let stderr = child.stderr.take().ok_or("cloudflared gave no log to read")?;
    if let Ok(mut tunnel) = TUNNEL.lock() {
        tunnel.child = Some(child);
    }
    let pattern = regex::Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").map_err(|e| e.to_string())?;
    let app = app.clone();
    // The address appears a few lines in; the reader keeps draining afterwards so the pipe never fills.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !sent {
                if let Some(found) = pattern.find(&line) {
                    let _ = tx.send(found.as_str().to_string());
                    sent = true;
                }
            }
        }
        // The process ended: say so, unless it was stopped on purpose.
        if let Ok(mut tunnel) = TUNNEL.lock() {
            if tunnel.status.kind == "cloudflared" && tunnel.child.is_some() {
                tunnel.child = None;
                tunnel.status.url = None;
                tunnel.status.error = Some("cloudflared stopped".into());
            }
        }
        emit(&app);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(45)) {
        Ok(url) => Ok(Some(url)),
        Err(_) => Err("cloudflared did not report an address within 45 seconds".into()),
    }
}

fn start_tailscale(port: u16) -> Result<Option<String>, String> {
    let tool = find_tool("tailscale").ok_or("Tailscale is not installed (tailscale.com/download)")?;
    let run = |args: &[&str]| -> Result<String, String> {
        let output = crate::proc::std_command(&tool).args(args).output().map_err(|e| format!("tailscale: {e}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(format!("tailscale: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    };
    run(&["funnel", "--bg", &port.to_string()])?;
    let status: serde_json::Value = serde_json::from_str(&run(&["status", "--json"])?).map_err(|e| format!("tailscale: {e}"))?;
    let dns = status.pointer("/Self/DNSName").and_then(serde_json::Value::as_str).unwrap_or_default().trim_end_matches('.').to_string();
    if dns.is_empty() {
        return Err("Tailscale did not say this machine's name".into());
    }
    Ok(Some(format!("https://{dns}")))
}

/// Stops whatever tunnel is up. For Tailscale that turns this port's funnel off again; the rest of
/// the tailnet's serve configuration is left alone.
pub fn stop() {
    let (kind, child) = match TUNNEL.lock() {
        Ok(mut tunnel) => {
            let kind = std::mem::replace(&mut tunnel.status, TunnelStatus { kind: "off".into(), ..Default::default() }).kind;
            (kind, tunnel.child.take())
        }
        Err(_) => return,
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    if kind == "tailscale" {
        if let Some(tool) = find_tool("tailscale") {
            let port = crate::flows::triggers::webhook::port().to_string();
            let _ = crate::proc::std_command(&tool).args(["funnel", "--https=443", "off"]).output();
            let _ = crate::proc::std_command(&tool).args(["funnel", &port, "off"]).output();
        }
    }
}
