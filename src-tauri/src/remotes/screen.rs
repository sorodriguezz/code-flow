//! The remote-desktop half: VNC drawn in-app, and everything else handed to the platform's viewer.
//!
//! **What is not here, and why.** RustDesk's own protocol is not integrable: a rendezvous/relay
//! pair, NAT hole punching, VP8/VP9/AV1, a Flutter client, and AGPL-3.0 — adopting it would mean
//! operating `hbbs`/`hbbr` and relicensing this app. So the screen is reached with the protocols
//! the far machine already speaks.
//!
//! **Two routes, and which one a host takes.**
//!
//! - **Embedded** (`screen.embedded`, VNC only). RFB has a client that runs in a webview, so the
//!   pixels land in a tab beside the terminal. It cannot open a TCP socket, so [`super::wsbridge`]
//!   carries the stream over a loopback WebSocket.
//! - **The platform's viewer**, for everything else. RDP has no in-webview client worth shipping,
//!   so a Windows host still opens `mstsc` — and a user who prefers their own viewer keeps it.
//!
//! **The tunnel is what makes either worth having**, and it is the same code path for both. A VNC
//! server bound to `127.0.0.1:5900` — the only sane way to run one — is unreachable from here and
//! fully reachable through the SSH this host already has. With `tunnel` on, opening the screen
//! raises a `-L` and points the canvas (or the viewer) at loopback; nothing is exposed to any
//! network in between. Termius doesn't do screens; RustDesk doesn't do SSH tunnels.

use serde::Serialize;

use super::{ForwardKind, ForwardSpec, RemoteHostSpec, ScreenProtocol};

/// Where the viewer was actually pointed, for the UI to report.
///
/// `tunnelled` is not a detail: the user asked to reach `10.0.0.7:5900` and the viewer opened on
/// `127.0.0.1:49213`, and a screen panel that showed the second number with no explanation would
/// read as having connected to the wrong machine.
#[derive(Debug, Clone, Serialize)]
pub struct ScreenLaunch {
    pub protocol: ScreenProtocol,
    /// What the viewer was given.
    pub host: String,
    pub port: u16,
    /// What the user asked for, when a tunnel means those differ.
    pub target_host: String,
    pub target_port: u16,
    pub tunnelled: bool,
    /// The command line that ran, so a viewer that opens and immediately closes is diagnosable
    /// without a debugger. Empty when the screen is drawn in-app.
    pub viewer: String,
    /// Set when the screen is embedded: the loopback WebSocket the canvas should open. See
    /// [`super::wsbridge`].
    pub ws_url: Option<String>,
    /// The bridge token, so closing the screen can retire it.
    pub ws_token: Option<String>,
}

/// The forward id a host's screen uses.
///
/// Deterministic, so opening the screen twice replaces its tunnel rather than stacking a second one
/// on a second random port — and so closing the host's screen has something to name.
pub fn tunnel_id(host_id: &str) -> String {
    format!("screen:{host_id}")
}

/// Opens the host's screen, raising the SSH forward first if it is configured to need one.
pub async fn open(host_id: &str, host: &RemoteHostSpec) -> Result<ScreenLaunch, String> {
    host.require_screen()?;
    // Infallible after `require_screen`, which is the point of deriving it from the kind: there is
    // no second field left that could say "none" on a host the UI drew a screen button for.
    let protocol = host.kind.screen_protocol().ok_or_else(|| host.kind.refuses("open a screen"))?;
    let screen = &host.screen;

    let target_host = host.host.trim();
    if target_host.is_empty() {
        return Err("This host has no address to open a screen on.".into());
    }
    let target_port = host.effective_port();

    let (host_arg, port_arg) = if screen.tunnel {
        let spec = ForwardSpec {
            id: tunnel_id(host_id),
            kind: ForwardKind::Local,
            // The viewer is told which port it got, so there is no reason to ask for a fixed one —
            // and a fixed one collides the moment two hosts' screens are open at once.
            listen_port: 0,
            // `localhost` as resolved *on the far side*, which is the loopback-bound server this
            // whole path exists for. The far side is the machine the tunnel lands on, so a screen
            // reached through a `jump` still means the screen host's own loopback.
            target_host: "localhost".to_string(),
            target_port,
            auto: false,
            label: "screen".into(),
        };
        // Through `ssh` to this machine at *its* port, not the screen's — see `tunnel_via`.
        let active = super::forward::open(host_id, &host.tunnel_via(), &spec).await?;
        ("127.0.0.1".to_string(), active.listen_port)
    } else {
        (target_host.to_string(), target_port)
    };

    // Embedded: no viewer at all. The bridge is published against the same address the viewer
    // would have been given — which, with `tunnel` on, is the local end of the SSH forward raised
    // just above. Nothing about the tunnel changes; only who draws the pixels.
    if screen.embedded && protocol == ScreenProtocol::Vnc {
        let address = tokio::net::lookup_host((host_arg.as_str(), port_arg))
            .await
            .map_err(|e| format!("Couldn't resolve {host_arg}: {e}"))?
            .next()
            .ok_or_else(|| format!("{host_arg} resolved to no address"))?;
        let (ws_url, ws_token) = super::wsbridge::publish(address).await?;
        remember_token(host_id, &ws_token);
        return Ok(ScreenLaunch {
            protocol,
            host: host_arg,
            port: port_arg,
            target_host: target_host.to_string(),
            target_port,
            tunnelled: screen.tunnel,
            viewer: String::new(),
            ws_url: Some(ws_url),
            ws_token: Some(ws_token),
        });
    }

    // The host's own user, because on a screen row that is who logs into the screen — there is no
    // separate SSH account here to confuse it with.
    let user = host.user.trim();
    let command = viewer_command(protocol, &screen.viewer, &host_arg, port_arg, user)?;
    spawn(&command).map_err(|e| {
        // The tunnel was raised for a viewer that never started; leaving it would park an `ssh`
        // process under a screen nobody is looking at.
        if screen.tunnel {
            super::forward::close(&tunnel_id(host_id));
        }
        e
    })?;

    Ok(ScreenLaunch {
        protocol,
        host: host_arg,
        port: port_arg,
        target_host: target_host.to_string(),
        target_port,
        tunnelled: screen.tunnel,
        viewer: command.join(" "),
        ws_url: None,
        ws_token: None,
    })
}

/// The bridge token a host's embedded screen is using, so [`close`] can retire it.
///
/// Keyed by host for the same reason the tunnel is: reopening a screen replaces the one before it
/// rather than stacking a second token that nothing would ever revoke.
fn tokens() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static TOKENS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    TOKENS.get_or_init(Default::default)
}

fn remember_token(host_id: &str, token: &str) {
    if let Ok(mut map) = tokens().lock() {
        if let Some(previous) = map.insert(host_id.to_string(), token.to_string()) {
            super::wsbridge::revoke(&previous);
        }
    }
}

/// Closes whatever the screen left running. Only the tunnel: the viewer is the user's own window
/// and killing it out from under them would be a surprise, not a cleanup.
pub fn close(host_id: &str) {
    super::forward::close(&tunnel_id(host_id));
    // And the bridge token, or a closed screen would leave a loopback route to the far host open
    // for anything on this machine that had the URL.
    if let Ok(mut map) = tokens().lock() {
        if let Some(token) = map.remove(host_id) {
            super::wsbridge::revoke(&token);
        }
    }
}

/// Hosts whose embedded screen has a bridge route published.
///
/// The half of a screen that outlives its tunnel: revoking the token is the only thing that makes a
/// stale `ws://` URL stop working, so a host can be holding this with no forward left to show.
pub fn bridged_hosts() -> Vec<String> {
    tokens()
        .lock()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// Retires every host's bridge token. The tunnels themselves are [`super::forward::close_all`]'s;
/// this is the half that would otherwise leave a loopback route to a far host live for the rest of
/// the process.
pub fn close_all() {
    if let Ok(mut map) = tokens().lock() {
        for (_, token) in map.drain() {
            super::wsbridge::revoke(&token);
        }
    }
}

/// The viewer command line: the user's own if they set one, otherwise the platform's.
fn viewer_command(
    protocol: ScreenProtocol,
    custom: &str,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Vec<String>, String> {
    let custom = custom.trim();
    if !custom.is_empty() {
        let parts = tokenize(custom)
            .into_iter()
            .map(|part| {
                part.replace("{host}", host)
                    .replace("{port}", &port.to_string())
                    .replace("{user}", user)
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return Err("The viewer command is empty.".into());
        }
        return Ok(parts);
    }
    default_viewer(protocol, host, port, user)
}

/// What to run when the host names no viewer of its own.
///
/// Each platform gets the thing it actually ships, and where it ships nothing the error names the
/// setting rather than the missing program — "install a viewer" is not actionable until you know
/// where to tell the app about it.
#[cfg(target_os = "macos")]
fn default_viewer(
    protocol: ScreenProtocol,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Vec<String>, String> {
    match protocol {
        // Screen Sharing is the system VNC client and is registered on `vnc://`.
        ScreenProtocol::Vnc => {
            let auth = if user.is_empty() { String::new() } else { format!("{user}@") };
            Ok(vec!["open".into(), format!("vnc://{auth}{host}:{port}")])
        }
        // Microsoft Remote Desktop registers `rdp://` with this query shape; without it installed
        // the URL opens nothing, which is why the custom-viewer field exists.
        ScreenProtocol::Rdp => Ok(vec![
            "open".into(),
            format!("rdp://full%20address=s:{host}:{port}"),
        ]),
    }
}

#[cfg(target_os = "windows")]
fn default_viewer(
    protocol: ScreenProtocol,
    host: &str,
    port: u16,
    _user: &str,
) -> Result<Vec<String>, String> {
    match protocol {
        // Ships with Windows.
        ScreenProtocol::Rdp => Ok(vec!["mstsc".into(), format!("/v:{host}:{port}")]),
        ScreenProtocol::Vnc => Err(
            "Windows has no built-in VNC viewer. Set a viewer command on the host — for example \
             `vncviewer {host}:{port}` — and CodeFlow will run that."
                .into(),
        ),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_viewer(
    protocol: ScreenProtocol,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Vec<String>, String> {
    // No single desktop ships either, so the first one on PATH wins and the error names all of
    // them plus the escape hatch.
    let candidates: &[(&str, Vec<String>)] = match protocol {
        ScreenProtocol::Vnc => &[
            ("vncviewer", vec![format!("{host}::{port}")]),
            ("remmina", vec!["-c".into(), format!("vnc://{host}:{port}")]),
            ("xdg-open", vec![format!("vnc://{host}:{port}")]),
        ],
        ScreenProtocol::Rdp => &[
            ("xfreerdp", vec![format!("/v:{host}:{port}"), format!("/u:{user}")]),
            ("remmina", vec!["-c".into(), format!("rdp://{host}:{port}")]),
        ],
        ScreenProtocol::None => return Err("No screen protocol.".into()),
    };
    for (program, args) in candidates {
        if which(program) {
            let mut command = vec![program.to_string()];
            command.extend(args.iter().cloned());
            return Ok(command);
        }
    }
    let names = candidates.iter().map(|(p, _)| *p).collect::<Vec<_>>().join(", ");
    Err(format!(
        "No remote-desktop viewer found on PATH (looked for {names}). Install one, or set a viewer \
         command on the host — `{{host}}` and `{{port}}` are substituted."
    ))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path).any(|dir| dir.join(program).is_file())
        })
        .unwrap_or(false)
}

/// Starts the viewer and stops caring about it.
///
/// Deliberately not waited on and not killed on drop, unlike everything else this module spawns: a
/// viewer is a window the user is now working in, and tying its lifetime to a panel in CodeFlow
/// would close their session when they switched tabs.
fn spawn(command: &[String]) -> Result<(), String> {
    let mut child = crate::proc::std_command(&command[0]);
    child.args(&command[1..]);
    child
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    child.spawn().map(|_| ()).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "`{}` isn't on PATH. Set a viewer command on the host — `{{host}}` and `{{port}}` \
                 are substituted.",
                command[0]
            )
        } else {
            format!("Couldn't start `{}`: {e}", command[0])
        }
    })
}

/// Splits a viewer command line on whitespace, honouring single and double quotes.
///
/// Not a shell: no expansion, no escapes, no operators. A viewer command is a program and some
/// flags, and running it through a shell would make `{host}` — which comes from a text field —
/// a place where a `;` matters.
fn tokenize(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    parts.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        parts.push(current);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_custom_viewer_gets_its_placeholders_filled() {
        let command =
            viewer_command(ScreenProtocol::Vnc, "vncviewer {host}::{port}", "127.0.0.1", 49213, "")
                .unwrap();
        assert_eq!(command, vec!["vncviewer", "127.0.0.1::49213"]);
    }

    #[test]
    fn a_quoted_viewer_path_stays_one_argument() {
        let command = viewer_command(
            ScreenProtocol::Rdp,
            r#""/Applications/My Viewer.app/x" /v:{host}:{port}"#,
            "10.0.0.7",
            3389,
            "",
        )
        .unwrap();
        assert_eq!(command[0], "/Applications/My Viewer.app/x");
        assert_eq!(command[1], "/v:10.0.0.7:3389");
    }

    #[test]
    fn a_host_that_looks_like_a_shell_command_is_still_one_argument() {
        let command =
            viewer_command(ScreenProtocol::Vnc, "vncviewer {host}", "a; rm -rf /", 5900, "").unwrap();
        assert_eq!(command, vec!["vncviewer", "a; rm -rf /"]);
    }

    #[test]
    fn the_user_is_substituted_where_a_viewer_wants_one() {
        let command =
            viewer_command(ScreenProtocol::Rdp, "xfreerdp /v:{host} /u:{user}", "win-db", 3389, "sam")
                .unwrap();
        assert_eq!(command, vec!["xfreerdp", "/v:win-db", "/u:sam"]);
    }

    /// The protocol's standard port is now the *kind's* default port, which is what a screen row
    /// resolves its blank `port` against — one number, in one place, for the row and the viewer.
    #[test]
    fn protocol_defaults_are_the_standard_ports() {
        assert_eq!(super::super::RemoteKind::Vnc.default_port(false), 5900);
        assert_eq!(super::super::RemoteKind::Rdp.default_port(false), 3389);
    }

    #[test]
    fn a_screen_tunnel_is_named_after_its_host_so_reopening_replaces_it() {
        assert_eq!(tunnel_id("h1"), "screen:h1");
    }
}
