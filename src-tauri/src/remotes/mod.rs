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
//! **The one exception, and why it is one.** [`RemoteKind::Ftp`]/[`Ftps`](RemoteKind::Ftps) hosts
//! do not go through `ssh` — there is no `ssh` to go through, FTP being a different protocol on a
//! socket of its own ([`ftp`]). Everything above still holds for every other kind, and the reason
//! the exception is safe is that it is *visible*: a host declares its [`RemoteKind`], the kind
//! decides which capabilities exist, and an FTP host therefore never reaches a code path that
//! would have spawned `ssh`.
//!
//! The halves, one file each:
//!
//! - [`session`] — an interactive shell, as a pty running `ssh`. It reuses the terminal registry,
//!   so a remote session is written to, resized and closed by the same commands a local one is.
//! - [`forward`] — `-L` / `-R` / `-D`, held open independently of any session.
//! - [`screen`] — VNC/RDP, handed to the OS viewer, through a forward when the screen only
//!   answers from inside the far network.
//! - [`files`] — the file browser's one entry point, dispatching on [`RemoteKind`] to:
//! - [`sftp`] — files over SSH's SFTP subsystem, and
//! - [`ftp`] — files over FTP/FTPS, the one transport that owns its own socket.
//! - [`sshconfig`] — reading `~/.ssh/config`, because nobody's first host should be typed in.
//! - [`parse`] — turning a pasted `ssh user@host -p 2222` into a spec, because that is the shape an
//!   address actually arrives in.

pub mod files;
pub mod forward;
pub mod ftp;
pub mod keys;
pub mod cloud;
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
/// FTP's control port, and the one explicit FTPS (`AUTH TLS`) also uses — upgrading in place is
/// the whole point of explicit mode.
pub const DEFAULT_FTP_PORT: u16 = 21;
/// Implicit FTPS: TLS before a byte of FTP is spoken, on a port of its own.
pub const DEFAULT_FTPS_IMPLICIT_PORT: u16 = 990;
/// RFB's first display — `:0`. A second server on one machine is 5901, which is why this is a
/// default and not a constant the user cannot reach.
pub const DEFAULT_VNC_PORT: u16 = 5900;
/// RDP, which unlike VNC really is one port.
pub const DEFAULT_RDP_PORT: u16 = 3389;

/// What a host actually speaks — and therefore what it can be asked to do.
///
/// **A row is one protocol, not one machine.** A host is a set of flags for a command line, and the
/// flags an `ssh` needs and the flags a VNC viewer needs have almost nothing in common: a different
/// port, a different user, a different idea of what a password is. Folding them into one row means
/// every host carries the other's fields greyed out, and the editor stops being able to say what a
/// given row *is*. So a machine you both administer and look at is two rows — an SSH host and a VNC
/// host — and each shows only what it can actually do.
///
/// The one thing that does cross the line is the tunnel, and it crosses it in the direction that
/// costs nothing: a screen host reaches a loopback-bound server over `ssh` ([`screen`]) without
/// needing to know that some other row describes the same machine.
///
/// Where the line falls:
///
/// - [`Ssh`](Self::Ssh) is a machine you work *on*: shell, files, forwards. The default, and what
///   every row written before this field existed loads as.
/// - [`Sftp`](Self::Sftp) is the same `ssh` transport narrowed on purpose: an account jailed with
///   `ForceCommand internal-sftp` has files and will never have a shell. Offering it a shell button
///   is offering a button that cannot work.
/// - [`Ftp`](Self::Ftp)/[`Ftps`](Self::Ftps) do not go through `ssh` at all. No shell, no forward,
///   no config file — a different protocol on a socket of its own ([`ftp`]).
/// - [`Vnc`](Self::Vnc)/[`Rdp`](Self::Rdp) are a machine you *look at*. No shell, no files, no
///   forwards of their own — one screen, and the tunnel that reaches it.
///
/// So the variants gate *capabilities*, and the capability table below is the whole of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteKind {
    /// A machine over SSH: shell, files, forwards. The default, and what every host written before
    /// this field existed loads as.
    Ssh,
    /// Files only, over SSH's SFTP subsystem.
    Sftp,
    /// Files only, over FTP. Plaintext unless the server is reached some other way.
    Ftp,
    /// Files only, over FTP with TLS — explicit `AUTH TLS` by default, implicit when
    /// [`FtpSpec::implicit_tls`] is set.
    Ftps,
    /// A screen over RFB. The only kind that can be drawn inside the app rather than handed to a
    /// viewer — see [`ScreenSpec::embedded`].
    Vnc,
    /// A screen over RDP. Always the platform's own viewer; there is no in-webview client.
    Rdp,
    /// An S3 bucket store — Amazon's, or anything that speaks the same API (MinIO, Cloudflare R2,
    /// Wasabi, Ceph) via [`S3Spec::endpoint`]. Files, with the caveats in [`cloud`].
    S3,
    /// Azure Blob storage. Files, same caveats.
    AzureBlob,
    /// Azure File shares — SMB's protocol over HTTPS. The one Azure service in this list that has
    /// real directories rather than synthesised ones.
    AzureFiles,
    /// Azure Queue storage. Not files at all: messages, with their own view.
    AzureQueue,
    /// Azure Table storage. Not files either: entities in a schemaless grid.
    AzureTable,
}

impl Default for RemoteKind {
    fn default() -> Self {
        Self::Ssh
    }
}

impl RemoteKind {
    /// An interactive shell. Only a full SSH host — a jailed SFTP account, an FTP server and a
    /// screen have no command to run.
    pub fn has_shell(self) -> bool {
        matches!(self, Self::Ssh)
    }

    /// Files are not in this table, and where they *are* is [`files::transport`]: the question
    /// "which file transport" and the question "any at all" have one answer, and splitting them
    /// would be two places to add a kind to. Every kind but a screen has them.
    ///
    /// Forwards the user raises and manages by hand. An SSH host only.
    ///
    /// Not the same thing as the tunnel a screen host raises for itself ([`screen`]): that one is
    /// this app's, lives and dies with the screen, and never appears in the forwards list — which
    /// is why a [`Vnc`](Self::Vnc) host can have one without answering `true` here.
    pub fn has_forwards(self) -> bool {
        matches!(self, Self::Ssh)
    }

    pub fn has_screen(self) -> bool {
        matches!(self, Self::Vnc | Self::Rdp)
    }

    /// Which remote-desktop protocol this kind *is*, if it is one. The kind is the protocol: there
    /// is no second field that could disagree with it.
    pub fn screen_protocol(self) -> Option<ScreenProtocol> {
        match self {
            Self::Vnc => Some(ScreenProtocol::Vnc),
            Self::Rdp => Some(ScreenProtocol::Rdp),
            _ => None,
        }
    }

    /// The port to assume when a spec leaves `port` at 0. `implicit_tls` only moves the answer for
    /// [`Ftps`](Self::Ftps), which is the one kind whose default port depends on *how* it is
    /// secured rather than on what it is.
    pub fn default_port(self, implicit_tls: bool) -> u16 {
        match self {
            Self::Ssh | Self::Sftp => DEFAULT_SSH_PORT,
            Self::Ftp => DEFAULT_FTP_PORT,
            Self::Ftps if implicit_tls => DEFAULT_FTPS_IMPLICIT_PORT,
            Self::Ftps => DEFAULT_FTP_PORT,
            Self::Vnc => DEFAULT_VNC_PORT,
            Self::Rdp => DEFAULT_RDP_PORT,
            // A cloud endpoint is a URL, and its port is whatever the scheme says. Naming 443 here
            // would put a port field in front of the user that changes nothing.
            Self::S3 | Self::AzureBlob | Self::AzureFiles | Self::AzureQueue | Self::AzureTable => 443,
        }
    }

    /// What this kind is called in a message to the user.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ssh => "SSH",
            Self::Sftp => "SFTP",
            Self::Ftp => "FTP",
            Self::Ftps => "FTPS",
            Self::Vnc => "VNC",
            Self::Rdp => "RDP",
            Self::S3 => "S3",
            Self::AzureBlob => "Azure Blob",
            Self::AzureFiles => "Azure Files",
            Self::AzureQueue => "Azure Queue",
            Self::AzureTable => "Azure Table",
        }
    }

    /// The refusal for an operation this kind cannot perform.
    ///
    /// Enforced in the backend rather than only by hiding the button, and that is the point: the
    /// capability table is what keeps an FTP host from ever reaching a code path that spawns `ssh`,
    /// and a guarantee that lives only in the UI is a guarantee one wrong `if` removes.
    fn refuses(self, what: &str) -> String {
        format!("This is a {} host — it can't {what}.", self.label())
    }
}

/// The FTP-only half of a host. Ignored entirely unless [`RemoteHostSpec::kind`] is
/// [`RemoteKind::Ftp`] or [`RemoteKind::Ftps`].
///
/// Kept as its own struct rather than loose fields on the spec for the reason [`ScreenSpec`] is:
/// these are meaningless for four fifths of the hosts in the list, and burying them one level down
/// says so.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtpSpec {
    /// Passive mode (`PASV`/`EPSV`) — the server names the data port and we dial out.
    ///
    /// Defaults to on, and should essentially always stay on: active mode asks the *server* to
    /// open a connection back to this machine, which any NAT or local firewall in between will
    /// drop. It is here because a handful of old servers still only do active.
    #[serde(default = "yes")]
    pub passive: bool,
    /// Wrap the control connection in TLS before speaking FTP, instead of connecting in the clear
    /// and issuing `AUTH TLS`. [`RemoteKind::Ftps`] only, and it moves the default port to 990.
    #[serde(default)]
    pub implicit_tls: bool,
    /// Log in as `anonymous`, ignoring the host's user and stored password.
    #[serde(default)]
    pub anonymous: bool,
    /// Accept a server certificate that doesn't verify.
    ///
    /// Off by default and deliberately not hidden behind a friendlier name: an FTPS host with this
    /// on is an FTPS host anybody on the path can read, which is the state the `s` was added to
    /// avoid. It exists because self-signed certificates on internal appliances are real.
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

fn yes() -> bool {
    true
}

impl Default for FtpSpec {
    fn default() -> Self {
        Self { passive: true, implicit_tls: false, anonymous: false, accept_invalid_certs: false }
    }
}

/// Where an S3 host's credentials come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum S3Auth {
    /// A named profile from `~/.aws`, resolved by **the AWS CLI itself** — see
    /// [`cloud::aws::credentials`]. The default, and the one that works for a human being: SSO,
    /// MFA, assumed roles and IMDS have all already happened in Amazon's own flow, and CodeFlow
    /// stores no credential at all.
    #[default]
    Profile,
    /// An access key ID and a secret access key, the secret in the OS keychain. For a machine
    /// account, a MinIO box, or anyone without the CLI installed.
    AccessKey,
}

/// The S3-only half of a host. Ignored unless `kind` is [`RemoteKind::S3`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct S3Spec {
    #[serde(default)]
    pub auth: S3Auth,
    /// The `~/.aws` profile to borrow. Empty means whatever `AWS_PROFILE`, and then `default`,
    /// resolve to — the same thing the CLI would do unaided.
    #[serde(default)]
    pub profile: String,
    /// The access key ID for [`S3Auth::AccessKey`]. The secret half is in the keychain, and the
    /// session token — for temporary credentials — beside it.
    #[serde(default)]
    pub access_key_id: String,
    /// Where the bucket is. Empty means `us-east-1`, which is what the API assumes when a request
    /// arrives unrouted, and what a signature has to claim to be accepted by the redirect.
    #[serde(default)]
    pub region: String,
    /// A non-Amazon endpoint — `https://minio.internal:9000`, `https://<id>.r2.cloudflarestorage.com`.
    /// Empty talks to AWS.
    #[serde(default)]
    pub endpoint: String,
    /// Address buckets as `endpoint/bucket/key` rather than `bucket.endpoint/key`.
    ///
    /// Forced on for a custom endpoint whether or not this is set, because virtual-host addressing
    /// against an IP or a bare hostname cannot work — there is no wildcard DNS in front of a MinIO
    /// container. Exposed anyway for the S3-compatible services that *do* have it and prefer it.
    #[serde(default)]
    pub path_style: bool,
}

/// How an Azure storage host authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AzureAuth {
    /// One of the account's two access keys, in the keychain. Signs with Shared Key.
    #[default]
    AccountKey,
    /// A shared access signature — the query string, with or without its leading `?`. Scoped and
    /// expiring, which is what makes it the right thing to paste into somebody else's machine.
    Sas,
    /// A bearer token from `az account get-access-token`, for tenants where account keys are
    /// disabled by policy. Borrows the session `az login` established, exactly as
    /// [`crate::datasource::entra`] does for Azure SQL — CodeFlow registers no application and
    /// stores no credential.
    Entra,
}

/// The Azure-only half of a host. Ignored unless `kind` [`RemoteKind::is_azure`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AzureSpec {
    #[serde(default)]
    pub auth: AzureAuth,
    /// The storage account name — the `contoso` in `contoso.blob.core.windows.net`.
    #[serde(default)]
    pub account: String,
    /// The DNS suffix, for sovereign and government clouds. Empty means `core.windows.net`.
    #[serde(default)]
    pub endpoint_suffix: String,
    /// A whole endpoint, replacing the one built from the account and suffix. For Azurite and for
    /// accounts behind a private endpoint with a name of their own.
    #[serde(default)]
    pub endpoint: String,
}

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

/// Which remote-desktop protocol a screen speaks.
///
/// There is no `None`: a host either *is* a screen host — [`RemoteKind::Vnc`] or
/// [`RemoteKind::Rdp`] — or has no screen at all. This is what [`RemoteKind::screen_protocol`]
/// hands back, and the only way to obtain one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenProtocol {
    Vnc,
    Rdp,
}

/// The settings a screen host has beyond its address.
///
/// Small on purpose. The protocol is the kind, and the endpoint is the host's own `host`/`port`/
/// `user` — a screen row *is* the screen, so it has no second address to disagree with the first.
/// What is left is the three genuine choices: whether to reach it through `ssh`, whether to draw it
/// here, and what to open it with.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScreenSpec {
    /// Reach the screen through an SSH forward first.
    ///
    /// This is the setting the whole feature exists for. A VNC server bound to `127.0.0.1:5900` —
    /// the only sane way to run one — is unreachable from here and fully reachable over `ssh` to
    /// the same machine. With it on, opening the screen raises a `-L`, points the viewer at
    /// loopback, and nothing is exposed to the network in between. See [`screen::open`] for which
    /// `ssh` that is: this host's address at *its* default port, through `jump` when one is set.
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
    /// What this host speaks, and therefore what it can be asked to do. See [`RemoteKind`] — and
    /// note that it defaults to [`RemoteKind::Ssh`], which is what every row written before this
    /// field existed loads as.
    #[serde(default)]
    pub kind: RemoteKind,
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
    /// The FTP-only settings. Meaningless unless `kind` is `Ftp` or `Ftps`.
    #[serde(default)]
    pub ftp: FtpSpec,
    /// The S3-only settings. Meaningless unless `kind` is [`RemoteKind::S3`].
    #[serde(default)]
    pub s3: S3Spec,
    /// The Azure-only settings. Meaningless unless [`RemoteKind::is_azure`].
    #[serde(default)]
    pub azure: AzureSpec,
    #[serde(default)]
    pub notes: String,
}

impl RemoteHostSpec {
    /// The port to connect to, resolving 0 against whatever this host's protocol defaults to —
    /// 22, 21 or 990. Kind-aware rather than always-22 because `port` left at 0 means "the usual
    /// one", and the usual one is not the same number for every kind.
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            self.kind.default_port(self.ftp.implicit_tls)
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

    /// Refuses the operation unless this host's kind can do it. See [`RemoteKind::refuses`] for why
    /// this is checked here and not left to the UI.
    pub fn require_shell(&self) -> Result<(), String> {
        if self.kind.has_shell() {
            Ok(())
        } else {
            Err(self.kind.refuses("open a shell"))
        }
    }

    pub fn require_forwards(&self) -> Result<(), String> {
        if self.kind.has_forwards() {
            Ok(())
        } else {
            Err(self.kind.refuses("forward a port"))
        }
    }

    pub fn require_screen(&self) -> Result<(), String> {
        if self.kind.has_screen() {
            Ok(())
        } else {
            Err(self.kind.refuses("open a screen"))
        }
    }

    /// The `ssh` that reaches this screen host's tunnel.
    ///
    /// A screen row's `port` is the *screen's* port — 5900, 3389 — so it cannot also be the one
    /// `ssh` dials. This hands back the same host with the port dropped back to 22 and the kind set
    /// to [`RemoteKind::Ssh`], which is what [`screen::open`] forwards through. `jump`, `key_file`,
    /// `agent_forward` and the verbatim `-o` options all survive, because those are about reaching
    /// the machine and are as true here as anywhere.
    ///
    /// `user` does not: on a screen row it is the *screen's* user (`Administrator` on an RDP box),
    /// and handing that to `ssh -l` would fail for a reason nothing on screen explains. The tunnel
    /// therefore connects as `~/.ssh/config` says, which is what an SSH row with an empty user does
    /// too. A tunnel that needs a different one says so in `jump` (`me@box`) or in an `-o User=`.
    pub fn tunnel_via(&self) -> Self {
        Self { kind: RemoteKind::Ssh, port: 0, user: String::new(), ..self.clone() }
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
        // No `kind` in the blob means SSH, which is what every row written before the field
        // existed is — and, now that screens are kinds of their own, also what keeps such a row
        // out of the screen paths rather than half into them.
        assert_eq!(spec.kind, RemoteKind::Ssh);
        assert!(!spec.screen.tunnel);
    }

    /// A screen row's `port` is the screen's, so the `ssh` its tunnel rides on has to go back to
    /// 22 — and drop the screen's user, which is not an SSH account.
    #[test]
    fn a_screen_tunnel_dials_ssh_rather_than_the_screens_own_port() {
        let mut s = spec();
        s.kind = RemoteKind::Vnc;
        s.user = "Administrator".into();
        s.jump = "bastion".into();
        assert_eq!(s.effective_port(), DEFAULT_VNC_PORT);

        let via = s.tunnel_via();
        assert_eq!(via.effective_port(), DEFAULT_SSH_PORT);
        assert_eq!(via.destination(), "web-01.example.com");
        // What reaching the machine needs survives; what logging into the screen needs does not.
        assert_eq!(via.jump, "bastion");
        assert!(!via.base_args(false).contains(&"-p".to_string()));
    }

    #[test]
    fn a_screen_has_only_its_screen() {
        for kind in [RemoteKind::Vnc, RemoteKind::Rdp] {
            assert!(kind.has_screen());
            assert!(!kind.has_shell());
            assert!(!kind.has_forwards());
        }
        assert!(!RemoteKind::Ssh.has_screen(), "an SSH row is a machine you work on, not one you look at");
        assert_eq!(RemoteKind::Vnc.screen_protocol(), Some(ScreenProtocol::Vnc));
        assert_eq!(RemoteKind::Rdp.screen_protocol(), Some(ScreenProtocol::Rdp));
        assert_eq!(RemoteKind::Ssh.screen_protocol(), None);
    }
}
