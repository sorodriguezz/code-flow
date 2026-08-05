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

/** The standard ports, applied when a screen leaves `port` at 0. */
export const SCREEN_DEFAULT_PORT: Record<ScreenProtocol, number> = {
  none: 0,
  vnc: 5900,
  rdp: 3389,
};

export const DEFAULT_SSH_PORT = 22;

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
}

export interface RemoteHostSpec {
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
  /** Run this instead of the login shell. */
  command: string;
  /** `cd` here on connect. */
  directory: string;
  screen: ScreenSpec;
  forwards: ForwardSpec[];
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

export interface RemoteWorkspaceTree {
  hosts: RemoteHostRow[];
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
  viewer: string;
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
    host: "",
    port: 0,
    user: "",
    auth: "agent",
    key_file: "",
    jump: "",
    os: "linux",
    tags: [],
    options: [],
    command: "",
    directory: "",
    screen: { protocol: "none", host: "", port: 0, user: "", tunnel: false, viewer: "" },
    forwards: [],
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
      forwards: parsed.forwards ?? [],
      options: parsed.options ?? [],
      tags: parsed.tags ?? [],
    };
  } catch {
    return base;
  }
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

/** The one-line summary under a host's name in the tree: what `ssh` would be given. */
export function describeHost(spec: RemoteHostSpec): string {
  const host = spec.host.trim();
  if (!host) return "";
  const user = spec.user.trim();
  const target = user ? `${user}@${host}` : host;
  const port = spec.port && spec.port !== DEFAULT_SSH_PORT ? `:${spec.port}` : "";
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
