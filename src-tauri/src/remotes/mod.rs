//! The Remote workspace: SSH hosts, their sessions, their port forwards and their screens.
//!
//! **Everything here goes through the system's `ssh`.** This is the same decision
//! [`crate::datasource::tunnel`] already made and documents at length, and it matters more here,
//! not less: a host manager whose sessions behave differently from the `ssh` the user types is a
//! host manager that has to reimplement `~/.ssh/config`, `ProxyJump`, the agent, hardware keys,
//! `known_hosts` and every per-host identity — badly, and forever. Spawning `ssh` inherits all of
//! it, including the failures, which are then the ones the user already knows how to fix.
//!
//! The consequence worth stating up front: **CodeFlow stores no private keys and speaks no SSH
//! protocol.** A host row is a set of flags for a command line. That is why [`RemoteHostSpec`]
//! carries `options` — anything this module hasn't modelled is still reachable as `-o Key=Value`
//! rather than being a feature request.
//!
//! The four halves, one file each:
//!
//! - [`session`] — an interactive shell, as a pty running `ssh`. It reuses the terminal registry,
//!   so a remote session is written to, resized and closed by the same commands a local one is.
//! - [`forward`] — `-L` / `-R` / `-D`, held open independently of any session.
//! - [`screen`] — VNC/RDP, handed to the OS viewer, through a forward when the screen only
//!   answers from inside the far network.
//! - [`sshconfig`] — reading `~/.ssh/config`, because nobody's first host should be typed in.
//! - [`parse`] — turning a pasted `ssh user@host -p 2222` into a spec, because that is the shape an
//!   address actually arrives in.

pub mod forward;
pub mod keys;
pub mod parse;
pub mod ping;
pub mod screen;
pub mod session;
pub mod sftp;
pub mod wsbridge;
pub mod sshconfig;

use serde::{Deserialize, Serialize};

/// The default SSH port, applied wherever a spec leaves `port` at 0.
pub const DEFAULT_SSH_PORT: u16 = 22;

/// How to authenticate. Only ever a *hint* to `ssh`: `Agent` adds no flags at all and lets the
/// user's own configuration decide, which is why it's the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteAuth {
    /// Whatever `ssh` would do unaided — the agent, then `~/.ssh/config`'s identities.
    Agent,
    /// A named private key, offered exclusively (`IdentitiesOnly=yes`).
    Key,
    /// Keyboard-interactive. The password is *not* stored in the spec — it is in the OS keychain,
    /// and it is typed into the pty by the user, since `ssh` deliberately refuses to read one from
    /// anywhere a program could supply it.
    Password,
}

impl Default for RemoteAuth {
    fn default() -> Self {
        Self::Agent
    }
}

/// What is at the other end. Cosmetic — it picks the row's glyph and the default screen protocol —
/// and deliberately not probed, because a host that is offline still has an operating system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteOs {
    Linux,
    Macos,
    Windows,
    Other,
}

impl Default for RemoteOs {
    fn default() -> Self {
        Self::Linux
    }
}

/// Which way a forward points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardKind {
    /// `-L`: a local port that reaches something on the far side.
    Local,
    /// `-R`: a port on the far side that reaches something here.
    Remote,
    /// `-D`: a local SOCKS proxy. `target_host`/`target_port` are unused.
    Dynamic,
}

/// One `-L` / `-R` / `-D`, as saved on a host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub id: String,
    pub kind: ForwardKind,
    /// The port that gets opened — locally for `Local`/`Dynamic`, on the far host for `Remote`.
    /// 0 asks the OS for a free one, which only makes sense for `Local` and `Dynamic`.
    #[serde(default)]
    pub listen_port: u16,
    /// Resolved by the *far* end for `Local` and by *this* end for `Remote`. An internal name that
    /// means nothing on this machine is exactly what a forward is usually for, so it is passed
    /// through untouched either way.
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
    /// Raise it as soon as a session to this host opens, rather than waiting to be asked.
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub label: String,
}

/// Which remote-desktop protocol a host answers on, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenProtocol {
    None,
    Vnc,
    Rdp,
}

impl Default for ScreenProtocol {
    fn default() -> Self {
        Self::None
    }
}

impl ScreenProtocol {
    pub fn default_port(self) -> u16 {
        match self {
            Self::Vnc => 5900,
            Self::Rdp => 3389,
            Self::None => 0,
        }
    }
}

/// The screen half of a host.
///
/// Separate from the SSH half because they are genuinely different endpoints that merely usually
/// live on one machine: a jump box has a shell and no screen, a Windows server has a screen whose
/// SSH is only there to tunnel to it, and `host` being empty (meaning "same as the SSH host") is
/// the common case rather than the only one.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScreenSpec {
    #[serde(default)]
    pub protocol: ScreenProtocol,
    /// Empty means the host's own SSH address.
    #[serde(default)]
    pub host: String,
    /// 0 means the protocol's default — 5900 for VNC, 3389 for RDP.
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// Reach the screen through an SSH forward to this host first.
    ///
    /// This is the setting the whole menu exists for. A VNC server bound to `127.0.0.1:5900` — the
    /// only sane way to run one — is unreachable from here and fully reachable through the SSH
    /// this host already has. With it on, opening the screen raises the forward, points the viewer
    /// at loopback, and nothing is exposed to the network in between.
    #[serde(default)]
    pub tunnel: bool,
    /// A viewer command line to use instead of the platform default. `{host}`, `{port}` and
    /// `{user}` are substituted; see [`screen`].
    #[serde(default)]
    pub viewer: String,
    /// Draw the screen inside CodeFlow instead of handing it to the platform's viewer.
    ///
    /// VNC only — RFB has an in-webview client and a WebSocket bridge to reach it ([`wsbridge`]);
    /// RDP has neither, so a Windows host still opens `mstsc`.
    #[serde(default)]
    pub embedded: bool,
}

/// Everything about a host that isn't a database column: the `spec` blob of a `remote_hosts` row.
///
/// One JSON blob rather than columns, for the reason `db_connections.spec` gives — a new flag
/// ships without a migration. Everything is `#[serde(default)]` so a row written by an older build
/// still loads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RemoteHostSpec {
    /// The address `ssh` connects to. May be a `Host` alias from `~/.ssh/config`, in which case
    /// almost everything else here can stay empty and the user's own config decides.
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// Empty defers to `~/.ssh/config` and then to the local username, exactly as `ssh` does.
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub auth: RemoteAuth,
    #[serde(default)]
    pub key_file: String,
    /// A `ProxyJump` destination — `bastion`, or `user@bastion:2222`.
    #[serde(default)]
    pub jump: String,
    #[serde(default)]
    pub os: RemoteOs,
    /// Free-form labels — the crossing axis the one-level tree deliberately doesn't have. Never
    /// read by this module; carried so the spec stays the single place a host is described.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Verbatim `-o Key=Value` arguments, one per entry, for anything not modelled above.
    #[serde(default)]
    pub options: Vec<String>,
    /// Forward the local SSH agent (`-A`).
    ///
    /// Off by default, and worth leaving off: anyone with root on the far host can use the
    /// forwarded socket to authenticate as you, anywhere your keys work. It is here because
    /// hopping from a bastion to a machine behind it needs it, which is exactly the case this
    /// app's jump-host support otherwise leaves half-solved.
    #[serde(default)]
    pub agent_forward: bool,
    /// A snippet from the workspace's library to run on connect.
    ///
    /// Resolved by the command layer, not here: this module never touches the database, and the
    /// spec that reaches [`session`] already has the body spliced into `command`.
    #[serde(default)]
    pub startup_snippet_id: String,
    /// Run this instead of the login shell. Empty opens a shell.
    #[serde(default)]
    pub command: String,
    /// `cd` here on connect. Applied by appending to the remote command, so it works without
    /// assuming anything about the far shell's rc files.
    #[serde(default)]
    pub directory: String,
    #[serde(default)]
    pub screen: ScreenSpec,
    #[serde(default)]
    pub forwards: Vec<ForwardSpec>,
    #[serde(default)]
    pub notes: String,
}

impl RemoteHostSpec {
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            DEFAULT_SSH_PORT
        } else {
            self.port
        }
    }

    /// `user@host` when a user is named, bare `host` otherwise — the argument `ssh` calls the
    /// destination. Leaving the user off is not a fallback but a feature: it is what lets a `Host`
    /// alias supply its own `User`.
    pub fn destination(&self) -> String {
        let host = self.host.trim();
        match self.user.trim() {
            "" => host.to_string(),
            user => format!("{user}@{host}"),
        }
    }

    /// The flags every `ssh` this module spawns carries, minus anything about *what* the
    /// connection is for.
    ///
    /// `interactive` is the one real fork. A pty session must be free to prompt — for a password,
    /// for a passphrase, for a `known_hosts` fingerprint — because the user is looking at a
    /// terminal and can answer. A background forward has no terminal to prompt into and would hang
    /// on the question forever, so it gets `BatchMode=yes` and fails with something actionable
    /// instead.
    pub fn base_args(&self, interactive: bool) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();

        let port = self.effective_port();
        if port != DEFAULT_SSH_PORT {
            args.push("-p".into());
            args.push(port.to_string());
        }

        let key = self.key_file.trim();
        if !key.is_empty() {
            // `IdentitiesOnly` so a named key is the one actually offered: without it `ssh`
            // presents every agent identity first, and a server counting authentication attempts
            // can refuse before reaching the key that would have worked.
            args.push("-i".into());
            args.push(key.to_string());
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }

        let jump = self.jump.trim();
        if !jump.is_empty() {
            args.push("-J".into());
            args.push(jump.to_string());
        }

        if self.agent_forward {
            args.push("-A".into());
        }

        if !interactive {
            args.push("-o".into());
            args.push("BatchMode=yes".into());
        }

        // Notice a dead host in ~30s rather than holding a socket that will never answer. On an
        // interactive session this is also what keeps a laptop's sleep from leaving a terminal
        // that accepts typing and sends it nowhere.
        args.push("-o".into());
        args.push("ServerAliveInterval=15".into());
        args.push("-o".into());
        args.push("ServerAliveCountMax=2".into());

        for option in &self.options {
            let option = option.trim();
            if option.is_empty() {
                continue;
            }
            args.push("-o".into());
            args.push(option.to_string());
        }

        args
    }

    /// The one validation worth doing before spawning anything: a host with no address produces an
    /// `ssh` invocation whose error names no host, which is the least useful failure available.
    pub fn require_host(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("This host has no address. Open it and fill in the hostname.".into());
        }
        Ok(())
    }
}

/// The keychain key a host's password or key passphrase is stored under.
///
/// Keyed by host id rather than by hostname: two rows may legitimately point at the same machine
/// with different credentials, and a shared key would make editing one silently change the other.
pub fn password_key(host_id: &str) -> String {
    format!("remote-password:{host_id}")
}

/// What to say when `ssh` isn't there. The remedy differs by platform and naming it saves a search.
///
/// Shared by [`session`], [`forward`] and [`screen`] — they all spawn the same binary, so they all
/// have the same thing to say when it is missing.
pub fn explain_missing_ssh(error: &std::io::Error) -> String {
    if error.kind() != std::io::ErrorKind::NotFound {
        return format!("couldn't start ssh: {error}");
    }
    let remedy = if cfg!(windows) {
        "Windows ships one as an optional feature: Settings → System → Optional features → \
         Add a feature → OpenSSH Client."
    } else {
        "Install an OpenSSH client and make sure `ssh` is on PATH."
    };
    format!("CodeFlow's Remote workspace runs the `ssh` command, and there isn't one on PATH. {remedy}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RemoteHostSpec {
        RemoteHostSpec {
            host: "web-01.example.com".into(),
            user: "deploy".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_plain_host_gets_no_flags_at_all() {
        assert_eq!(spec().base_args(true), vec!["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"]);
    }

    #[test]
    fn the_default_port_is_left_off_so_ssh_config_can_set_it() {
        let mut s = spec();
        s.port = 22;
        assert!(!s.base_args(true).contains(&"-p".to_string()));
        s.port = 2222;
        assert!(s.base_args(true).windows(2).any(|w| w == ["-p", "2222"]));
    }

    #[test]
    fn a_named_key_is_offered_exclusively() {
        let mut s = spec();
        s.key_file = "~/.ssh/prod".into();
        let args = s.base_args(true);
        assert!(args.contains(&"IdentitiesOnly=yes".to_string()));
    }

    #[test]
    fn agent_forwarding_is_off_unless_asked_for() {
        assert!(!spec().base_args(true).contains(&"-A".to_string()));
        let mut s = spec();
        s.agent_forward = true;
        assert!(s.base_args(true).contains(&"-A".to_string()));
    }

    #[test]
    fn only_background_ssh_gets_batch_mode() {
        assert!(!spec().base_args(true).contains(&"BatchMode=yes".to_string()));
        assert!(spec().base_args(false).contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn an_empty_user_leaves_the_destination_bare_for_ssh_config_to_fill() {
        let mut s = spec();
        assert_eq!(s.destination(), "deploy@web-01.example.com");
        s.user = "  ".into();
        assert_eq!(s.destination(), "web-01.example.com");
    }

    #[test]
    fn a_spec_written_by_an_older_build_still_loads() {
        let spec: RemoteHostSpec = serde_json::from_str(r#"{"host":"a.example.com"}"#).unwrap();
        assert_eq!(spec.host, "a.example.com");
        assert_eq!(spec.effective_port(), 22);
        assert_eq!(spec.auth, RemoteAuth::Agent);
        assert_eq!(spec.screen.protocol, ScreenProtocol::None);
    }
}
