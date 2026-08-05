/**
 * Wire types for the Remote workspace.
 *
 * Mirrored one-for-one from `src-tauri/src/remotes/mod.rs` and the `Remote*` models in
 * `src-tauri/src/db/models.rs`. The names here are the serde wire names — snake_case — so renaming
 * a field on either side is a breaking change on both.
 *
 * The one thing to understand before reading the UI: **a host is a set of flags for an `ssh`
 * command line, not a connection object.** CodeFlow speaks no SSH protocol and holds no private
 * keys; every session, forward and tunnel is the system's own `ssh` with these values spliced in.
 * That is what makes a host imported as nothing but an alias still work — `~/.ssh/config` is read
 * by `ssh` itself, not by us.
 */

export type RemoteAuth = "agent" | "key" | "password";

export type RemoteOs = "linux" | "macos" | "windows" | "other";

export type ForwardKind = "local" | "remote" | "dynamic";

export type ScreenProtocol = "none" | "vnc" | "rdp";

/**
 * What a host speaks, and therefore what it can be asked to do. Mirrors `remotes::RemoteKind`.
 *
 * Not a way to split one machine into several rows — see the Rust enum's comment. `ssh` is a
 * machine with everything; `sftp` is the same transport narrowed to files (a `ForceCommand
 * internal-sftp` account has no shell and never will); `ftp`/`ftps` are a different protocol
 * entirely, with no `~/.ssh/config`, no forwards and no screen.
 */
export type RemoteKind = "ssh" | "sftp" | "ftp" | "ftps";

export const REMOTE_KINDS: RemoteKind[] = ["ssh", "sftp", "ftp", "ftps"];

/** The standard ports, applied when a screen leaves `port` at 0. */
export const SCREEN_DEFAULT_PORT: Record<ScreenProtocol, number> = {
  none: 0,
  vnc: 5900,
  rdp: 3389,
};

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_FTP_PORT = 21;
export const DEFAULT_FTPS_IMPLICIT_PORT = 990;

/**
 * What each kind can do. The single source of truth for which buttons, tabs and menu items exist.
 *
 * Mirrored from `RemoteKind`'s methods in Rust, where the same table is enforced again before
 * anything spawns — see `RemoteHostSpec::require_shell` and friends. Duplicated deliberately: the
 * UI needs it to *not draw* the button, and the backend needs it so a bug in the UI can't make the
 * button work anyway. Files are absent because every kind has them.
 */
export const KIND_CAPABILITIES: Record<
  RemoteKind,
  { shell: boolean; forwards: boolean; screen: boolean }
> = {
  ssh: { shell: true, forwards: true, screen: true },
  sftp: { shell: false, forwards: false, screen: false },
  ftp: { shell: false, forwards: false, screen: false },
  ftps: { shell: false, forwards: false, screen: false },
};

/** What a kind is called in the UI. */
export const KIND_LABEL: Record<RemoteKind, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  ftps: "FTPS",
};

export interface ForwardSpec {
  id: string;
  kind: ForwardKind;
  /** The port that gets opened — locally for `local`/`dynamic`, on the far host for `remote`.
   *  0 asks the OS for a free one, which only works for the first two. */
  listen_port: number;
  /** Resolved by the *far* end for `local` and by this one for `remote`. Empty means the host
   *  itself. */
  target_host: string;
  target_port: number;
  /** Raise it as soon as a session to this host opens. Auto forwards ride on the session's own
   *  `ssh`, so they live and die with the terminal rather than appearing in the forwards list. */
  auto: boolean;
  label: string;
}

export interface ScreenSpec {
  protocol: ScreenProtocol;
  /** Empty means the host's own SSH address. */
  host: string;
  /** 0 means the protocol's default. */
  port: number;
  user: string;
  /**
   * Reach the screen through an SSH forward first.
   *
   * The setting the whole menu exists for: a VNC server bound to `127.0.0.1:5900` is unreachable
   * from here and fully reachable through the SSH this host already has.
   */
  tunnel: boolean;
  /** A viewer command line to use instead of the platform default. `{host}`, `{port}` and `{user}`
   *  are substituted. */
  viewer: string;
  /** Draw the screen inside CodeFlow instead of handing it to the platform's viewer. VNC only —
   *  RDP has no in-webview client, so a Windows host still opens its own. */
  embedded: boolean;
}

/** The FTP-only half of a host. Ignored unless `kind` is `ftp` or `ftps`. Mirrors `FtpSpec`. */
export interface FtpSpec {
  /** Passive mode. On by default and should stay on — active mode asks the server to dial back to
   *  this machine, which any NAT or firewall in between drops. */
  passive: boolean;
  /** TLS before a byte of FTP, rather than `AUTH TLS` on a plain connection. Moves the default
   *  port to 990. `ftps` only. */
  implicit_tls: boolean;
  /** Log in as `anonymous`, ignoring the host's user and stored password. */
  anonymous: boolean;
  /** Accept a server certificate that doesn't verify. Off by default: an FTPS host with this on is
   *  one anybody on the path can read, which is the state the `s` exists to avoid. */
  accept_invalid_certs: boolean;
}

export interface RemoteHostSpec {
  /** What this host speaks. Defaults to `ssh`, which is what every row written before this field
   *  existed loads as. */
  kind: RemoteKind;
  host: string;
  /** 0 means 22 — left at 0 so a `~/.ssh/config` alias can set its own. */
  port: number;
  /** Empty defers to `~/.ssh/config` and then to the local username, exactly as `ssh` does. */
  user: string;
  auth: RemoteAuth;
  key_file: string;
  /** A `ProxyJump` destination — `bastion`, or `user@bastion:2222`. */
  jump: string;
  os: RemoteOs;
  /**
   * Free-form labels, the second axis of organisation.
   *
   * The tree is one level deep by design (see the `group_name` column), which answers "where does
   * this machine live" and nothing else. A tag answers the crossing questions — `postgres`, `k8s`,
   * `pci` — that would otherwise be the argument for nested folders. A host has one group and any
   * number of tags, and that is the whole difference between them.
   */
  tags: string[];
  /** Verbatim `-o Key=Value` arguments, for anything the form doesn't model. */
  options: string[];
  /**
   * Forward the local SSH agent (`-A`).
   *
   * Off by default and worth leaving off: anyone with root on the far host can use the forwarded
   * socket to authenticate as you, anywhere your keys work. It exists because hopping from a
   * bastion to a machine behind it needs it.
   */
  agent_forward: boolean;
  /** A snippet from the workspace library to run on connect. Resolved by the backend, which
   *  splices its body into the remote command rather than typing it in after login. */
  startup_snippet_id: string;
  /** Run this instead of the login shell. */
  command: string;
  /** `cd` here on connect. */
  directory: string;
  screen: ScreenSpec;
  forwards: ForwardSpec[];
  /** The FTP-only settings. Meaningless unless `kind` is `ftp` or `ftps`. */
  ftp: FtpSpec;
  notes: string;
}

/** A stored host: the database row, whose `spec` is `RemoteHostSpec` as JSON. */
export interface RemoteHostRow {
  id: string;
  workspace_id: string;
  name: string;
  /** Free text. Empty is "ungrouped". */
  group_name: string;
  spec: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A command to send into a session. Workspace-scoped: the point is that it runs on many hosts. */
export interface RemoteSnippet {
  id: string;
  workspace_id: string;
  name: string;
  body: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** One thing that was opened against a host, and how it went. Mirrors `RemoteLogEntry`. */
export interface RemoteLogEntry {
  id: string;
  host_id: string;
  host_name: string;
  /** `session` | `forward` | `screen` | `files`. */
  kind: string;
  detail: string;
  /** Empty when it worked. */
  error: string;
  at: string;
}

/**
 * A folder in the host tree. Mirrors `RemoteGroupRow`.
 *
 * Carries no members — a host's `group_name` is still what puts it in a group. The row exists so a
 * group can exist while *empty*, which membership alone cannot express: without it, a folder
 * vanishes the moment you empty it, including between creating it and filling it.
 */
export interface RemoteGroupRow {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface RemoteWorkspaceTree {
  hosts: RemoteHostRow[];
  groups: RemoteGroupRow[];
  snippets: RemoteSnippet[];
}

/** A live forward. `listen_port` is the *resolved* one, which is why this is reported back rather
 *  than assumed: a spec asking for port 0 only learns which port it got by opening it. */
export interface ActiveForward {
  id: string;
  host_id: string;
  kind: ForwardKind;
  listen_port: number;
  target_host: string;
  target_port: number;
  label: string;
}

/** Where the viewer was actually pointed. `tunnelled` is not a detail — the user asked for
 *  `10.0.0.7:5900` and the viewer opened on `127.0.0.1:49213`. */
export interface ScreenLaunch {
  protocol: ScreenProtocol;
  host: string;
  port: number;
  target_host: string;
  target_port: number;
  tunnelled: boolean;
  /** Empty when the screen is drawn in-app. */
  viewer: string;
  /** Set when embedded: the loopback WebSocket the canvas opens. */
  ws_url: string | null;
  ws_token: string | null;
}

/** One entry in a directory — remote or local, deliberately the same shape so one component draws
 *  both panes. Mirrors `remotes::sftp`. */
export interface RemoteFile {
  name: string;
  /** Absolute. The frontend never joins paths for navigation, only for a transfer's destination. */
  path: string;
  is_dir: boolean;
  is_link: boolean;
  size: number;
  /** Unix epoch seconds, or 0 when the server didn't say. */
  modified: number;
  /** `drwxr-xr-x`, rendered by the backend. Empty on Windows, which has no such thing. */
  permissions: string;
}

export interface RemoteListing {
  path: string;
  entries: RemoteFile[];
}

/**
 * An identity this machine already has — a key in `~/.ssh`, or one the agent is holding.
 *
 * Discovered, never owned: CodeFlow has no key store of its own, because a private key we held
 * would be the one thing `ssh` could not see. Mirrors `remotes::keys`.
 */
export interface SshKey {
  /** Absolute path to the private key, for `-i`. Empty for an agent-only identity whose private
   *  half may not be on this disk at all (a hardware key). */
  path: string;
  label: string;
  kind: string;
  comment: string;
  /** Whether the agent is holding it. The useful column: one it holds needs no `-i` at all. */
  in_agent: boolean;
}

/** What a typed or pasted `ssh` line was understood to mean. Mirrors `remotes::parse`. */
export interface ParsedCommand {
  spec: RemoteHostSpec;
  /** A name to offer if it gets saved — the bare hostname. */
  name: string;
  /** Flags recognised as flags but not modelled, verbatim. Shown, never silently dropped: a pasted
   *  `-L 5432:db:5432` otherwise produces a session the user believes has a tunnel. */
  ignored: string[];
}

/** One `Host` block from `~/.ssh/config`, before it becomes a row. */
export interface ImportedHost {
  name: string;
  spec: RemoteHostSpec;
}

export interface ImportResult {
  created: RemoteHostRow[];
  /** Named rather than counted, because "3 skipped" invites the question this answers. */
  skipped: string[];
}

/** A new host's spec. Everything empty and `auth: "agent"`, which is the form that adds no `ssh`
 *  flags at all and lets the user's own configuration decide. */
export function defaultHostSpec(): RemoteHostSpec {
  return {
    kind: "ssh",
    host: "",
    port: 0,
    user: "",
    auth: "agent",
    key_file: "",
    jump: "",
    os: "linux",
    tags: [],
    options: [],
    agent_forward: false,
    startup_snippet_id: "",
    command: "",
    directory: "",
    screen: {
      protocol: "none",
      host: "",
      port: 0,
      user: "",
      tunnel: false,
      viewer: "",
      embedded: true,
    },
    forwards: [],
    ftp: {
      passive: true,
      implicit_tls: false,
      anonymous: false,
      accept_invalid_certs: false,
    },
    notes: "",
  };
}

/**
 * Parses a row's `spec`, filling in anything a row written by an older build is missing.
 *
 * Never throws: a host whose JSON is unreadable still has to render, because the row is the only
 * place the user can go to fix it. What they get is a blank form with the name intact, which is
 * recoverable — an explorer that crashes is not.
 */
export function parseHostSpec(row: RemoteHostRow): RemoteHostSpec {
  const base = defaultHostSpec();
  try {
    const parsed = JSON.parse(row.spec) as Partial<RemoteHostSpec>;
    return {
      ...base,
      ...parsed,
      screen: { ...base.screen, ...(parsed.screen ?? {}) },
      ftp: { ...base.ftp, ...(parsed.ftp ?? {}) },
      forwards: parsed.forwards ?? [],
      options: parsed.options ?? [],
      tags: parsed.tags ?? [],
    };
  } catch {
    return base;
  }
}

/** What this host can be asked to do. The one place the UI should ask. */
export function capabilities(spec: RemoteHostSpec) {
  return KIND_CAPABILITIES[spec.kind] ?? KIND_CAPABILITIES.ssh;
}

/** The port this kind implies when a spec leaves `port` at 0 — 22, 21 or 990. */
export function defaultPortFor(spec: RemoteHostSpec): number {
  switch (spec.kind) {
    case "ftp":
      return DEFAULT_FTP_PORT;
    case "ftps":
      // Explicit FTPS upgrades the control connection in place, so it stays on 21.
      return spec.ftp.implicit_tls ? DEFAULT_FTPS_IMPLICIT_PORT : DEFAULT_FTP_PORT;
    default:
      return DEFAULT_SSH_PORT;
  }
}

/** The port a host actually connects on. */
export function effectivePort(spec: RemoteHostSpec): number {
  return spec.port || defaultPortFor(spec);
}

/**
 * Whether this host has enough to connect at all.
 *
 * The backend refuses an addressless host too, and has to — it is not the only caller. But an
 * error toast is the wrong answer to a question the UI can see coming: the message would be
 * "open it and fill in the hostname", which is a thing the app can simply *do*. So the callers
 * check this first and open the editor instead, and the Rust check stays as the backstop.
 */
export function hasAddress(spec: RemoteHostSpec): boolean {
  return spec.host.trim().length > 0;
}

/**
 * The one-line summary under a host's name in the tree.
 *
 * The port shows only when it isn't the one this kind implies — `:21` under every FTP host is noise
 * that pushes the part worth reading off the end, and the same is true of `:22` under every SSH
 * one. `jump` is SSH-only and simply never set on the others.
 */
export function describeHost(spec: RemoteHostSpec): string {
  const host = spec.host.trim();
  if (!host) return "";
  const user = spec.user.trim();
  const target = user ? `${user}@${host}` : host;
  const port = spec.port && spec.port !== defaultPortFor(spec) ? `:${spec.port}` : "";
  const jump = spec.jump.trim() ? ` via ${spec.jump.trim()}` : "";
  return `${target}${port}${jump}`;
}

/** How a forward reads in a list: `5432 → db.internal:5432`, or the SOCKS form for a dynamic one. */
export function describeForward(forward: ForwardSpec | ActiveForward): string {
  const listen = forward.listen_port === 0 ? "auto" : String(forward.listen_port);
  if (forward.kind === "dynamic") return `SOCKS :${listen}`;
  const target = `${forward.target_host || "localhost"}:${forward.target_port}`;
  return forward.kind === "local" ? `${listen} → ${target}` : `${target} → ${listen}`;
}
