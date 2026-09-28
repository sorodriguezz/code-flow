//! Port forwards held open on their own: `ssh -N -L/-R/-D`.
//!
//! This is [`crate::datasource::tunnel`] generalized. That module raises exactly one `-L` per
//! database connection, implicitly, and the user never sees it; this one is the same mechanism with
//! the two things a *manager* needs — the other two directions, and a list you can look at and
//! close things from.
//!
//! **One process per forward, not one per host.** The opposite of the database tunnels, and for the
//! opposite reason: there, four namespaces behind one bastion must not become four SSH processes,
//! because the user never asked for any of them. Here each forward is a row the user created,
//! toggles and expects to be able to close alone — and multiplexing them onto a shared connection
//! would mean closing one either kills the others or leaves the process running with nothing to do.
//!
//! Forwards a host marks `auto` are the exception, and they are not handled here at all: they ride
//! on the session's own `ssh` (see [`super::session`]), so they live and die with the terminal.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio::net::TcpStream;

use super::{ForwardKind, ForwardSpec, RemoteHostSpec};

/// How long to wait for a local forward to start accepting before giving up. Generous, because what
/// happens in this window is a real SSH handshake against a possibly-distant host — but bounded,
/// because the alternative to giving up is a row that says "opening…" forever.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How often to try the port while waiting. Cheap: it is a loopback connect.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// A live forward, as the frontend sees it.
///
/// `listen_port` is the *resolved* port, which is the whole reason this is reported rather than
/// assumed: a spec asking for port 0 only learns which port it got by opening it, and that number
/// is what the user has to paste into whatever is going to connect through it.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveForward {
    pub id: String,
    pub host_id: String,
    pub kind: ForwardKind,
    pub listen_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub label: String,
}

struct Running {
    info: ActiveForward,
    /// Held so that dropping the entry kills the process. `kill_on_drop` does the rest.
    _child: tokio::process::Child,
}

type Registry = Mutex<HashMap<String, Running>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The `-L` / `-R` / `-D` pair for a spec, with `listen_port` taken literally.
///
/// Shared with [`super::session`], which splices these into a session's own command line for the
/// forwards marked `auto`. Local forwards bind loopback explicitly rather than relying on `ssh`'s
/// default, so a forward is never reachable from the rest of the network by accident.
pub fn flag(spec: &ForwardSpec) -> Vec<String> {
    match spec.kind {
        ForwardKind::Local => vec![
            "-L".into(),
            format!(
                "127.0.0.1:{}:{}:{}",
                spec.listen_port,
                target_host(spec),
                spec.target_port
            ),
        ],
        // The far end binds according to its own `GatewayPorts`; naming an interface here would be
        // refused by most servers, so the port is given bare.
        ForwardKind::Remote => vec![
            "-R".into(),
            format!(
                "{}:{}:{}",
                spec.listen_port,
                target_host(spec),
                spec.target_port
            ),
        ],
        ForwardKind::Dynamic => vec!["-D".into(), format!("127.0.0.1:{}", spec.listen_port)],
    }
}

/// A `Local` forward with no target host means "the far host itself", which is what `localhost`
/// resolves to *on the far side*. A `Remote` one with no target means this machine.
fn target_host(spec: &ForwardSpec) -> &str {
    match spec.target_host.trim() {
        "" => "localhost",
        host => host,
    }
}

/// Raises a forward, replacing any previous one with the same id.
///
/// Returns once the forward is actually usable, not once `ssh` has been spawned — for `Local` and
/// `Dynamic`, by connecting to the port. A `Remote` forward opens a port on the far side that
/// cannot be probed from here, so it is confirmed the only other way available: by `ssh` still
/// being alive a moment later, with `ExitOnForwardFailure` making an unusable forward exit.
pub async fn open(
    host_id: &str,
    host: &RemoteHostSpec,
    spec: &ForwardSpec,
) -> Result<ActiveForward, String> {
    host.require_host()?;
    host.require_forwards()?;
    close(&spec.id);

    let mut resolved = spec.clone();
    if resolved.listen_port == 0 {
        resolved.listen_port = match spec.kind {
            ForwardKind::Local | ForwardKind::Dynamic => free_local_port()?,
            // The far end picks and announces it, and reading that back means parsing `ssh`'s
            // stderr for a line whose format is not contractual. Asking for an explicit port is a
            // fair requirement for the one direction that can't be probed either.
            ForwardKind::Remote => {
                return Err("A remote forward needs an explicit port to open on the far host.".into())
            }
        };
    } else if matches!(spec.kind, ForwardKind::Local | ForwardKind::Dynamic) {
        // Before `ssh` exists, not after: the readiness probe below is a connect to this port, and
        // with something already listening on it that connect succeeds at once — a local Postgres
        // on 5432 answered, the forward was reported open, and the user went on talking to the
        // database on their own machine believing it was the far one.
        if let Some(reason) = port_taken(resolved.listen_port).await {
            return Err(format!(
                "Port {} is already in use on this machine ({reason}), so the forward can't take it. \
                 Pick another local port, or stop what is listening there.",
                resolved.listen_port
            ));
        }
    }

    let destination = host.destination();
    // A host that signs in with a password is handed it once — see `askpass`.
    let password = super::background_password(host_id, host);
    let mut command = crate::proc::command("ssh");
    command
        .args(spawn_args(host, &resolved, password.is_some()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // The forward exists for this app; outliving it would leave a listening port and an SSH
        // session belonging to nobody.
        .kill_on_drop(true);
    // Held until this function returns — the forward is up or has failed by then, and either way
    // nothing is going to ask again.
    let _handoff = match &password {
        Some(password) => Some(super::askpass::Handoff::arm(&mut command, password)?),
        None => None,
    };

    let mut child = command.spawn().map_err(|e| super::explain_missing_ssh(&e))?;
    let mut stderr = child.stderr.take();

    let info = ActiveForward {
        id: resolved.id.clone(),
        host_id: host_id.to_string(),
        kind: resolved.kind,
        listen_port: resolved.listen_port,
        target_host: target_host(&resolved).to_string(),
        target_port: resolved.target_port,
        label: resolved.label.clone(),
    };

    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        // An `ssh` that exits is a definite failure whichever direction the forward points, and
        // waiting out the timeout to report it would make a wrong username take twenty seconds
        // while `ssh` itself said why in the first second.
        if let Ok(Some(status)) = child.try_wait() {
            let said = complaint(&mut stderr).await;
            // A host not in `known_hosts` yet is the one failure the app can fix, and is marked so
            // the trust dialog can be offered; a changed key is only explained.
            if let Some(explained) = super::host_key_failure(host, &said) {
                return Err(explained);
            }
            return Err(format!(
                "The forward to {destination} closed immediately ({status}).{said}{}",
                super::password_note(host, password.is_some())
            ));
        }
        let ready = match resolved.kind {
            ForwardKind::Local | ForwardKind::Dynamic => accepts(resolved.listen_port).await,
            // Nothing here can see the far side's new port. Half a second of staying alive past
            // `ExitOnForwardFailure` is the available evidence that it came up.
            ForwardKind::Remote => {
                tokio::time::sleep(Duration::from_millis(600)).await;
                child.try_wait().ok().flatten().is_none()
            }
        };
        if ready {
            if let Ok(mut map) = registry().lock() {
                map.insert(info.id.clone(), Running { info: info.clone(), _child: child });
            }
            return Ok(info);
        }
        if tokio::time::Instant::now() >= deadline {
            let said = complaint(&mut stderr).await;
            return Err(format!(
                "The forward to {destination} didn't come up within {}s.{said}",
                READY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Closes a forward, if it is running. Idempotent: closing one that already died is what the UI
/// does when it notices, and it must not be an error.
pub fn close(id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(id);
    }
}

/// Closes every forward belonging to one host — what deleting a host, or disconnecting from it,
/// has to do so a deleted row doesn't leave a listening port behind with nothing naming it.
pub fn close_host(host_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.retain(|_, running| running.info.host_id != host_id);
    }
}

/// Closes every forward, whatever host it belongs to.
///
/// The exit path's, for the reason [`crate::datasource::tunnel`] gives for having the same function:
/// the map is a `static`, the kill happens when [`Running`] drops, and the process ends through
/// `std::process::exit`, which runs no destructors. So without this every quit leaves an `ssh -N`
/// behind — a forwarded port still listening and an authenticated session still open on the far
/// host, reparented to init. Draining the map is what makes the drop, and therefore the kill, happen.
pub fn close_all() {
    if let Ok(mut map) = registry().lock() {
        map.clear();
    }
}

/// Every live forward.
///
/// Liveness is the child still being in the map *and* not having exited — an `ssh` that died
/// (dropped network, host rebooted) would otherwise be reported as a working tunnel, which is worse
/// than reporting nothing because the user would go looking for the fault at the far end.
pub fn list() -> Vec<ActiveForward> {
    let Ok(mut map) = registry().lock() else { return Vec::new() };
    map.retain(|_, running| running._child.try_wait().ok().flatten().is_none());
    let mut forwards: Vec<ActiveForward> = map.values().map(|r| r.info.clone()).collect();
    forwards.sort_by(|a, b| a.listen_port.cmp(&b.listen_port));
    forwards
}

fn spawn_args(host: &RemoteHostSpec, spec: &ForwardSpec, askpass: bool) -> Vec<String> {
    let mut args = host.background_args(askpass);
    // No remote command: this process exists only to hold the forward open.
    args.push("-N".into());
    // Without this a forward that can't be established leaves `ssh` running and connected, and the
    // failure surfaces as a confusing "connection refused" on a port we just reported as open.
    args.push("-o".into());
    args.push("ExitOnForwardFailure=yes".into());
    args.extend(flag(spec));
    args.push(host.destination());
    args
}

/// What `ssh` wrote to stderr, as a sentence to append to a failure.
///
/// Bounded by a short read timeout rather than by reading to EOF: on the timeout path the process
/// is still running and its stderr will never end, so an unbounded read would hang exactly where a
/// message is most needed.
async fn complaint(stderr: &mut Option<tokio::process::ChildStderr>) -> String {
    let Some(pipe) = stderr.as_mut() else { return String::new() };
    let mut buffer = Vec::new();
    let _ = tokio::time::timeout(
        Duration::from_millis(300),
        tokio::io::AsyncReadExt::read_to_end(pipe, &mut buffer),
    )
    .await;
    let text = String::from_utf8_lossy(&buffer);
    let said = text.trim();
    if said.is_empty() {
        String::new()
    } else {
        format!(" ssh said: {said}")
    }
}

/// Whether something is listening on the forwarded port yet.
async fn accepts(port: u16) -> bool {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    matches!(
        tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Why a local port can't be taken by a forward, or `None` when it is free.
///
/// Two probes, because neither alone catches everything. A **connect** finds anything that answers
/// on loopback — including a server bound to *every* interface, which on macOS a bind to
/// `127.0.0.1` would happily sit beside — and on IPv6 too, since a client dialling `localhost` may
/// resolve `::1` and reach that instead of the tunnel. A **bind** finds a port held by something
/// that is not accepting yet.
async fn port_taken(port: u16) -> Option<&'static str> {
    use std::net::{Ipv6Addr, SocketAddrV6};
    let answers = |addr: SocketAddr| async move {
        matches!(
            tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(addr)).await,
            Ok(Ok(_))
        )
    };
    if answers(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))).await {
        return Some("something answers on 127.0.0.1");
    }
    if answers(SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0))).await {
        return Some("something answers on ::1");
    }
    if TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_err() {
        return Some("it can't be bound");
    }
    None
}

/// A free loopback port, found by binding one and letting it go.
///
/// Racy in principle — something else could take it between the bind and `ssh`'s — and fine in
/// practice, because the window is microseconds and `ExitOnForwardFailure` turns a loss into a
/// clean failure rather than a forward that silently forwards nothing.
pub fn free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("couldn't reserve a local port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("couldn't read the reserved local port: {e}"))?
        .port();
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forward(kind: ForwardKind) -> ForwardSpec {
        ForwardSpec {
            id: "f".into(),
            kind,
            listen_port: 15432,
            target_host: "db.internal".into(),
            target_port: 5432,
            auto: false,
            label: String::new(),
        }
    }

    #[test]
    fn a_local_forward_binds_loopback_only() {
        assert_eq!(
            flag(&forward(ForwardKind::Local)),
            vec!["-L", "127.0.0.1:15432:db.internal:5432"]
        );
    }

    #[test]
    fn a_remote_forward_leaves_the_bind_address_to_the_server() {
        assert_eq!(
            flag(&forward(ForwardKind::Remote)),
            vec!["-R", "15432:db.internal:5432"]
        );
    }

    #[test]
    fn a_dynamic_forward_ignores_the_target() {
        assert_eq!(
            flag(&forward(ForwardKind::Dynamic)),
            vec!["-D", "127.0.0.1:15432"]
        );
    }

    #[test]
    fn an_unnamed_target_means_the_far_host_itself() {
        let mut spec = forward(ForwardKind::Local);
        spec.target_host = "  ".into();
        assert_eq!(flag(&spec), vec!["-L", "127.0.0.1:15432:localhost:5432"]);
    }

    #[test]
    fn a_held_open_forward_never_runs_a_remote_command_and_fails_loudly() {
        let host = RemoteHostSpec { host: "bastion".into(), ..Default::default() };
        let args = spawn_args(&host, &forward(ForwardKind::Local), false);
        assert!(args.contains(&"-N".to_string()));
        assert!(args.contains(&"ExitOnForwardFailure=yes".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert_eq!(args.last().unwrap(), "bastion");
    }

    #[tokio::test]
    async fn a_port_something_listens_on_is_reported_taken_and_a_free_one_is_not() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_taken(port).await.is_some());
        drop(listener);
        assert!(port_taken(port).await.is_none());
    }

    /// The bug this guards: a local service on the port answered the readiness probe, and the
    /// forward was reported open while every connection went to this machine. The refusal has to
    /// come before `ssh` is started — this host could not be reached at all, so an answer that took
    /// the ssh path would say something else entirely.
    #[tokio::test]
    async fn a_forward_onto_a_busy_local_port_is_refused_before_ssh_starts() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let host = RemoteHostSpec { host: "unreachable.example.invalid".into(), ..Default::default() };
        let mut spec = forward(ForwardKind::Local);
        spec.id = format!("busy-{port}");
        spec.listen_port = port;

        let error = open("h1", &host, &spec).await.unwrap_err();
        assert!(error.contains(&format!("Port {port} is already in use")), "{error}");
        assert!(list().iter().all(|active| active.id != spec.id), "nothing was registered");
        drop(listener);
    }
}
