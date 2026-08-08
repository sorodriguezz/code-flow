//! SSH tunnels, for the databases that only answer from inside somebody else's network.
//!
//! A tunnel is one `ssh -N -L 127.0.0.1:<local>:<db host>:<db port> <bastion>` process. The driver
//! then connects to `127.0.0.1:<local>` and knows nothing about any of this — which is the whole
//! design: every engine gets tunnelling for free, because none of them can tell the difference.
//!
//! **Why the system's `ssh` and not an SSH library.** A pure-Rust client (`russh`) would mean
//! reimplementing, badly, everything the user's SSH setup already does: `~/.ssh/config` with its
//! `Host` aliases and `ProxyJump`, the agent, hardware keys, `known_hosts`, per-host identities,
//! passphrase handling. On a machine that already pushes to git over SSH, all of that is configured
//! and working. Spawning `ssh` inherits it exactly — a tunnel behaves like the `ssh` command the
//! user would have typed, including its failures, which are then the ones they know how to fix. The
//! cost is a dependency on the binary: present by default on macOS, on Linux, and on Windows 10 and
//! later (`OpenSSH.Client`, an on-by-default optional feature). [`explain_missing_ssh`] is what a
//! machine without it gets told.
//!
//! **One tunnel per connection, not per session.** The explorer opens a session per database, and
//! four namespaces behind one bastion should not be four SSH processes. They are keyed by
//! connection id here, the same way [`super::jvm`] keeps one JVM for every IRIS session.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::net::TcpStream;

use super::DbConnectionConfig;

/// How long to wait for the forwarded port to start accepting before giving up. Generous, because
/// what happens in this window is a real SSH handshake against a possibly-distant host — but
/// bounded, because the alternative to giving up is a dialog that hangs.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How often to try the port while waiting. Cheap: it is a loopback connect.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub struct Tunnel {
    /// The loopback port the driver connects to.
    pub local_port: u16,
    /// Held so that dropping the tunnel kills the process. `kill_on_drop` does the rest.
    _child: tokio::process::Child,
}

type Tunnels = Mutex<HashMap<String, Arc<Tunnel>>>;

fn tunnels() -> &'static Tunnels {
    static TUNNELS: OnceLock<Tunnels> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The tunnel for this connection, opening one if there isn't a live one already.
///
/// Liveness is the forwarded port still accepting, not the child still being in the map: an `ssh`
/// that died — a dropped network, a bastion that rebooted — leaves a process entry behind but
/// nothing listening, and handing that back would fail the connect with a confusing "connection
/// refused on localhost".
pub async fn open(config: &DbConnectionConfig) -> Result<Arc<Tunnel>, String> {
    if let Some(existing) = lookup(&config.id) {
        if accepts(existing.local_port).await {
            return Ok(existing);
        }
        close(&config.id);
    }

    let tunnel = Arc::new(spawn(config).await?);
    if let Ok(mut map) = tunnels().lock() {
        map.insert(config.id.clone(), tunnel.clone());
    }
    Ok(tunnel)
}

/// Closes a connection's tunnel, if it has one. Called when its sessions go away, so a workspace
/// left open overnight isn't also an SSH session left open overnight.
pub fn close(connection_id: &str) {
    if let Ok(mut map) = tunnels().lock() {
        map.remove(connection_id);
    }
}

/// Closes every tunnel. For the app's exit path, and it is the only thing that gets the `ssh`
/// children killed at all.
///
/// `kill_on_drop` (see [`spawn`]) fires when the [`Tunnel`] drops — but the map holding them is a
/// `static`, and the process ends through `std::process::exit`, which runs no destructors. So
/// without this call every quit leaves an `ssh -N -L` behind: a forwarded port still listening and
/// an authenticated session still open on the bastion, reparented to init and belonging to nobody.
/// Draining the map here is what makes the drop — and therefore the kill — actually happen.
pub fn close_all() {
    if let Ok(mut map) = tunnels().lock() {
        map.clear();
    }
}

fn lookup(connection_id: &str) -> Option<Arc<Tunnel>> {
    tunnels().lock().ok()?.get(connection_id).cloned()
}

async fn spawn(config: &DbConnectionConfig) -> Result<Tunnel, String> {
    let host = config.ssh_host.trim();
    if host.is_empty() {
        return Err("This connection is set to use an SSH tunnel but names no SSH host. Fill it \
                    in, or turn the tunnel off."
            .to_string());
    }
    let local_port = free_local_port()?;
    let target_host = if config.host.trim().is_empty() { "localhost" } else { config.host.trim() };
    let target_port = config.effective_port();
    let destination = match config.ssh_user.trim() {
        "" => host.to_string(),
        user => format!("{user}@{host}"),
    };

    let mut command = crate::proc::command("ssh");
    command
        .args(ssh_args(config, local_port, target_host, target_port, &destination))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // The tunnel exists for this app's sessions; outliving it would leave a forwarded port and
        // an SSH session belonging to nobody.
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| explain_missing_ssh(&e))?;
    let mut stderr = child.stderr.take();

    // Wait for the forward to come up, watching for the process dying as the other outcome. An
    // `ssh` that exits is a definite failure, and waiting out the timeout to report it would make a
    // wrong username take twenty seconds — while `ssh` itself said why in the first second.
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if accepts(local_port).await {
            return Ok(Tunnel { local_port, _child: child });
        }
        if let Ok(Some(status)) = child.try_wait() {
            let said = complaint(&mut stderr).await;
            return Err(format!(
                "The SSH tunnel to {destination} closed immediately ({status}).{said}"
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let said = complaint(&mut stderr).await;
            return Err(format!(
                "The SSH tunnel to {destination} didn't come up within {}s. CodeFlow ran: \
                 ssh -N -L 127.0.0.1:{local_port}:{target_host}:{target_port} {destination}{said}",
                READY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// What `ssh` wrote to stderr, as a sentence to append to a failure.
///
/// Bounded by a short read timeout rather than by reading to EOF: on the timeout path the process
/// is still running and its stderr will never end, so an unbounded read would hang exactly where a
/// message is most needed.
async fn complaint(stderr: &mut Option<tokio::process::ChildStderr>) -> String {
    let Some(pipe) = stderr.as_mut() else { return String::new() };
    let mut buffer = Vec::new();
    let read = tokio::time::timeout(
        Duration::from_millis(300),
        tokio::io::AsyncReadExt::read_to_end(pipe, &mut buffer),
    )
    .await;
    // A timeout still leaves whatever arrived before it in `buffer`, which is the useful part.
    let _ = read;
    let text = String::from_utf8_lossy(&buffer);
    let said = text.trim();
    if said.is_empty() {
        String::new()
    } else {
        format!(" ssh said: {said}")
    }
}

/// The command line, as its own function so the flags can be asserted on without a bastion.
///
/// `target_host` is resolved by the *far* end: an internal name that means nothing here is exactly
/// what a tunnel is usually for, so it is passed through untouched.
fn ssh_args(
    config: &DbConnectionConfig,
    local_port: u16,
    target_host: &str,
    target_port: u16,
    destination: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        // No remote command: this process exists only to hold the forward open.
        "-N".into(),
        "-L".into(),
        format!("127.0.0.1:{local_port}:{target_host}:{target_port}"),
        // Never prompt. A password or passphrase prompt would go to a terminal this process does
        // not have, and the tunnel would hang on it rather than failing — so an identity that
        // needs typing is reported as a failure the user can act on instead.
        "-o".into(),
        "BatchMode=yes".into(),
        // Notice a dead bastion in ~30s rather than holding a socket that will never answer.
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
        // Without this a forward that can't be established leaves `ssh` running and connected,
        // and the failure would surface as a confusing "connection refused" on loopback.
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
    ];
    if config.ssh_port != 0 && config.ssh_port != 22 {
        args.push("-p".into());
        args.push(config.ssh_port.to_string());
    }
    let key = config.ssh_key_file.trim();
    if !key.is_empty() {
        // `IdentitiesOnly` so a named key is the one actually offered: without it `ssh` presents
        // every agent identity first, and a server counting authentication attempts can refuse
        // before reaching the key that would have worked.
        args.push("-i".into());
        args.push(key.to_string());
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }
    args.push(destination.to_string());
    args
}

/// Whether something is listening on the forwarded port yet.
async fn accepts(port: u16) -> bool {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    matches!(
        tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// A free loopback port, found by binding one and letting it go.
///
/// Racy in principle — something else could take it between the bind and `ssh`'s — and fine in
/// practice, because the window is microseconds and `ExitOnForwardFailure` turns a loss into a
/// clean failure rather than a tunnel that silently forwards nothing.
fn free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("couldn't reserve a local port for the SSH tunnel: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("couldn't read the reserved local port: {e}"))?
        .port();
    Ok(port)
}

/// What to say when `ssh` isn't there. The remedy differs by platform and naming it saves a search.
fn explain_missing_ssh(error: &std::io::Error) -> String {
    if error.kind() != std::io::ErrorKind::NotFound {
        return format!("couldn't start the SSH tunnel: {error}");
    }
    let remedy = if cfg!(windows) {
        "Windows ships one as an optional feature: Settings → System → Optional features → \
         Add a feature → OpenSSH Client."
    } else {
        "Install an OpenSSH client and make sure `ssh` is on PATH."
    };
    format!("CodeFlow tunnels through the `ssh` command, and there isn't one on PATH. {remedy}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::{DbKind, DbSslMode};

    fn config() -> DbConnectionConfig {
        DbConnectionConfig {
            id: "c".into(),
            kind: DbKind::Postgres,
            host: "db.internal".into(),
            port: 5432,
            database: "app".into(),
            user: "postgres".into(),
            password: String::new(),
            auth_method: crate::datasource::DbAuthMethod::Password,
            tenant_id: String::new(),
            url: String::new(),
            ssl: DbSslMode::Disable,
            options: Vec::new(),
            read_only: false,
            connect_timeout_ms: 0,
            show_all_databases: false,
            visible_schemas: Vec::new(),
            schemas_filtered: false,
            schema_filter: String::new(),
            schema_filter_enabled: true,
            object_filter: String::new(),
            object_filter_enabled: true,
            schema_object_filters: Vec::new(),
            keep_alive_secs: 0,
            auto_disconnect_secs: 0,
            startup_script: String::new(),
            ssl_ca_file: String::new(),
            ssl_cert_file: String::new(),
            ssl_key_file: String::new(),
            ssh_enabled: true,
            ssh_host: "bastion.example.com".into(),
            ssh_port: 0,
            ssh_user: "deploy".into(),
            ssh_key_file: String::new(),
        }
    }

    /// The forward is the whole point, and it is one positional string that has to be exactly
    /// right: local side bound to loopback, remote side resolved by the bastion.
    #[test]
    fn the_forward_binds_loopback_and_names_the_far_side() {
        let args = ssh_args(&config(), 54321, "db.internal", 5432, "deploy@bastion.example.com");
        let forward = args.iter().position(|a| a == "-L").map(|i| &args[i + 1]).unwrap();
        assert_eq!(forward, "127.0.0.1:54321:db.internal:5432");
        assert_eq!(args.last().unwrap(), "deploy@bastion.example.com");
        // Nothing may wait for a human: this process has no terminal to prompt on.
        assert!(args.iter().any(|a| a == "BatchMode=yes"), "{args:?}");
        assert!(args.iter().any(|a| a == "ExitOnForwardFailure=yes"), "{args:?}");
    }

    /// The default port stays off the command line, so `~/.ssh/config` can still decide it.
    #[test]
    fn only_a_non_default_ssh_port_is_passed() {
        let mut config = config();
        assert!(!ssh_args(&config, 1, "h", 2, "d").iter().any(|a| a == "-p"));

        config.ssh_port = 22;
        assert!(!ssh_args(&config, 1, "h", 2, "d").iter().any(|a| a == "-p"));

        config.ssh_port = 2222;
        let args = ssh_args(&config, 1, "h", 2, "d");
        let port = args.iter().position(|a| a == "-p").map(|i| &args[i + 1]).unwrap();
        assert_eq!(port, "2222");
    }

    /// A named key has to be the one actually offered — otherwise the agent's identities go first
    /// and a server that counts attempts refuses before reaching it.
    #[test]
    fn a_named_key_is_offered_alone() {
        let mut config = config();
        config.ssh_key_file = "  ~/.ssh/db_key  ".into();
        let args = ssh_args(&config, 1, "h", 2, "d");
        let key = args.iter().position(|a| a == "-i").map(|i| &args[i + 1]).unwrap();
        assert_eq!(key, "~/.ssh/db_key", "the path is trimmed");
        assert!(args.iter().any(|a| a == "IdentitiesOnly=yes"), "{args:?}");
    }

    /// The port has to be free *and* reported — a zero would forward nothing.
    #[test]
    fn a_reserved_port_is_a_real_one() {
        let port = free_local_port().unwrap();
        assert!(port > 0);
    }

    /// The message for a missing binary has to name the fix, since "No such file or directory" on
    /// its own reads as a problem with the database rather than with the machine.
    #[test]
    fn a_missing_ssh_client_explains_itself() {
        let error = std::io::Error::new(std::io::ErrorKind::NotFound, "not found");
        let message = explain_missing_ssh(&error);
        assert!(message.contains("PATH"), "{message}");
        assert!(message.contains("OpenSSH"), "{message}");
    }
}
