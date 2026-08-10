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

/** What a screen speaks. No `none`: a host either *is* a screen host or has no screen at all. */
export type ScreenProtocol = "vnc" | "rdp";

/**
 * What a host speaks, and therefore what it can be asked to do. Mirrors `remotes::RemoteKind`.
 *
 * **A row is one protocol, not one machine** — see the Rust enum's comment for the argument. `ssh`
 * is a machine you work on; `sftp` is the same transport narrowed to files (a `ForceCommand
 * internal-sftp` account has no shell and never will); `ftp`/`ftps` are a different protocol
 * entirely, with no `~/.ssh/config` and no forwards; `vnc`/`rdp` are a machine you look at, and
 * have nothing but their screen. A box you both administer and view is two rows.
 */
export type RemoteKind =
  | "ssh"
  | "sftp"
  | "ftp"
  | "ftps"
  | "vnc"
  | "rdp"
  | "s3"
  | "azure"
  | "azure_blob"
  | "azure_files"
  | "azure_queue"
  | "azure_table";

/**
 * Every kind that exists on the wire, legacy included. Mirrors the Rust enum.
 *
 * Not what the Type select offers — see `SELECTABLE_KINDS`. The four single-service Azure kinds are
 * still read and still work, but nothing creates them any more.
 */
export const REMOTE_KINDS: RemoteKind[] = [
  "ssh",
  "sftp",
  "ftp",
  "ftps",
  "vnc",
  "rdp",
  "s3",
  "azure",
  "azure_blob",
  "azure_files",
  "azure_queue",
  "azure_table",
];

/**
 * What the Type select offers, which is deliberately shorter than the list above.
 *
 * An Azure account is one row now — `azure` — because that is what an account is: one name, one
 * key, four services. Offering the four service kinds beside it would be offering four ways to make
 * the row that used to be the problem. A host already saved as one still shows its own type; see
 * `kindOptions`.
 */
export const SELECTABLE_KINDS: RemoteKind[] = [
  "ssh",
  "sftp",
  "ftp",
  "ftps",
  "vnc",
  "rdp",
  "s3",
  "azure",
];

/** The Type select's options for a host that already exists: the offered set, plus this row's own
 *  kind when it is a legacy one — a select that cannot show what it is set to is worse than a long
 *  list. */
export function kindOptions(kind: RemoteKind): RemoteKind[] {
  return SELECTABLE_KINDS.includes(kind) ? SELECTABLE_KINDS : [...SELECTABLE_KINDS, kind];
}

/** The Azure kinds, which share an account, a credential and a signing scheme and differ only in
 *  which endpoint they ask for. Mirrors `RemoteKind::is_azure`. */
export const isAzureKind = (kind: RemoteKind): boolean =>
  kind === "azure" ||
  kind === "azure_blob" ||
  kind === "azure_files" ||
  kind === "azure_queue" ||
  kind === "azure_table";

/** The cloud kinds — an account reached over HTTPS rather than a host reached over a socket. What
 *  it gates is the shape of the editor: an account and a credential where SSH has a host and a
 *  port. */
export const isCloudKind = (kind: RemoteKind): boolean => kind === "s3" || isAzureKind(kind);

/**
 * The four services under one storage account, as the account panel's rail lists them.
 *
 * `blob` and `files` double as the first segment of a browser path — `/blob/photos/cat.jpg` — which
 * is how one file browser reaches both filesystems. See `remotes::cloud::account`.
 */
export type AzureService = "blob" | "files" | "queues" | "tables";

export const AZURE_SERVICES: AzureService[] = ["blob", "files", "queues", "tables"];

/** Where the file browser starts for a service that has files. The other two have panels of their
 *  own and no path at all. */
export function azureServiceRoot(service: AzureService): string {
  return service === "files" ? "/files" : "/blob";
}

/**
 * Which service a legacy single-service row is, so opening one lands where it used to.
 *
 * A row saved as `azure_queue` opens the account panel on Queues rather than on Blob: the row still
 * says what it was for, and the panel simply has more in it than it did.
 */
export function serviceOfKind(kind: RemoteKind): AzureService {
  if (kind === "azure_files") return "files";
  if (kind === "azure_queue") return "queues";
  if (kind === "azure_table") return "tables";
  return "blob";
}

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_FTP_PORT = 21;
export const DEFAULT_FTPS_IMPLICIT_PORT = 990;
export const DEFAULT_VNC_PORT = 5900;
export const DEFAULT_RDP_PORT = 3389;

/**
 * What each kind can do. The single source of truth for which buttons, tabs and menu items exist.
 *
 * Mirrored from `RemoteKind`'s methods in Rust, where the same table is enforced again before
 * anything spawns — `RemoteHostSpec::require_shell` and friends for three of the four columns, and
 * `remotes::files::transport` for `files`. Duplicated deliberately: the UI needs it to *not draw*
 * the button, and the backend needs it so a bug in the UI can't make the button work anyway.
 */
export const KIND_CAPABILITIES: Record<
  RemoteKind,
  { shell: boolean; files: boolean; forwards: boolean; screen: boolean }
> = {
  ssh: { shell: true, files: true, forwards: true, screen: false },
  sftp: { shell: false, files: true, forwards: false, screen: false },
  ftp: { shell: false, files: true, forwards: false, screen: false },
  ftps: { shell: false, files: true, forwards: false, screen: false },
  // `forwards: false` is about the forwards *list* — the one the user raises and manages by hand.
  // A screen host still tunnels; that forward is the app's, lives and dies with the screen, and
  // never appears in that list. Same split as `RemoteKind::has_forwards` in Rust.
  vnc: { shell: false, files: false, forwards: false, screen: true },
  rdp: { shell: false, files: false, forwards: false, screen: true },
  // Object storage is files and nothing else — no shell to open, no port to forward, no screen.
  // What it *is* is covered in `remotes::cloud`: folders are synthesised, rename copies, and the
  // account root lists buckets.
  s3: { shell: false, files: true, forwards: false, screen: false },
  // A whole account. `files: true` is the blob and share halves, which the browser reaches through
  // one path (`/blob/…`, `/files/…`); its queues and tables are not files and are not in this
  // table — they are two of the four pages of `AzureAccountPanel`.
  azure: { shell: false, files: true, forwards: false, screen: false },
  // The legacy single-service rows. They reach files through the same account transport the row
  // above does — the credential is the account's whichever service the kind was named for — so a
  // host saved as `azure_queue` opens the same panel and simply lands on Queues.
  azure_blob: { shell: false, files: true, forwards: false, screen: false },
  azure_files: { shell: false, files: true, forwards: false, screen: false },
  azure_queue: { shell: false, files: true, forwards: false, screen: false },
  azure_table: { shell: false, files: true, forwards: false, screen: false },
};

/** Which protocol a kind *is*, when it is a screen. The kind is the protocol — there is no second
 *  field that could disagree with it. Mirrors `RemoteKind::screen_protocol`. */
export function screenProtocolOf(kind: RemoteKind): ScreenProtocol | null {
  if (kind === "vnc") return "vnc";
  if (kind === "rdp") return "rdp";
  return null;
}

/** What a kind is called in the UI. */
export const KIND_LABEL: Record<RemoteKind, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  ftps: "FTPS",
  vnc: "VNC",
  rdp: "RDP",
  s3: "S3",
  azure: "Azure Storage",
  azure_blob: "Azure Blob",
  azure_files: "Azure Files",
  azure_queue: "Azure Queue",
  azure_table: "Azure Table",
};

/** Where an S3 host's credentials come from. Mirrors `remotes::S3Auth`. */
export type S3Auth = "profile" | "access_key";

/** The S3-only half of a host. Mirrors `remotes::S3Spec`. */
export interface S3Spec {
  auth: S3Auth;
  /** The `~/.aws` profile to borrow. Empty is whatever the CLI resolves unaided. */
  profile: string;
  access_key_id: string;
  /** Empty means `us-east-1`. */
  region: string;
  /** A non-Amazon endpoint. Empty talks to AWS. */
  endpoint: string;
  /** Forced on for a custom endpoint whether or not this is set — see `S3Spec::path_style`. */
  path_style: boolean;
}

/** How an Azure storage host authenticates. Mirrors `remotes::AzureAuth`. */
export type AzureAuth = "account_key" | "sas" | "entra";

/** The Azure-only half of a host. Mirrors `remotes::AzureSpec`. */
export interface AzureSpec {
  auth: AzureAuth;
  account: string;
  /** Empty means `core.windows.net`. */
  endpoint_suffix: string;
  /** A whole endpoint, replacing the one built from the account. For Azurite. */
  endpoint: string;
}

/** One queue in an account. Mirrors `remotes::cloud::queue::QueueSummary`. */
export interface QueueSummary {
  name: string;
  /** The service's own word, not a hedge in ours: the count is not transactional. -1 when the
   *  metadata read failed for this queue alone. */
  approximate_count: number;
}

/** One message. Mirrors `remotes::cloud::queue::QueueMessage`. */
export interface QueueMessage {
  id: string;
  body: string;
  /** False when the payload isn't text — shown as-is rather than mangled. */
  is_text: boolean;
  inserted_at: number;
  expires_at: number;
  /** Climbing here is the signature of a poison message. */
  dequeue_count: number;
  /** Only a *received* message has one, and deleting needs it. A peek leaves this empty. */
  pop_receipt: string;
}

/** One table. Mirrors `remotes::cloud::table::TableSummary`. */
export interface TableSummary {
  name: string;
}

/** A page of entities. Mirrors `remotes::cloud::table::TablePage`. */
export interface TablePage {
  /** Built from the data, because a Table has no schema to read. */
  columns: string[];
  rows: Record<string, unknown>[];
  next_partition_key: string;
  next_row_key: string;
}

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

/**
 * The settings a screen host has beyond its address.
 *
 * Small on purpose: the protocol is the kind, and the endpoint is the host's own `host`/`port`/
 * `user`. A screen row *is* the screen, so it has no second address to disagree with the first.
 */
export interface ScreenSpec {
  /**
   * Reach the screen through an SSH forward first.
   *
   * The setting the whole feature exists for: a VNC server bound to `127.0.0.1:5900` is unreachable
   * from here and fully reachable over `ssh` to the same machine — this host's address at *its*
   * default port, through `jump` when one is set.
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
  /** The S3-only settings. Meaningless unless `kind` is `s3`. */
  s3: S3Spec;
  /** The Azure-only settings. Meaningless unless `isAzureKind(kind)`. */
  azure: AzureSpec;
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

/**
 * What a pasted Azure connection string was understood to mean. Mirrors
 * `commands::remote_cmd::ParsedAzureConnection`.
 *
 * `secret` is separate from `spec` and stays that way: the spec is written to the workspace
 * database as JSON, and an account key belongs in the keychain. Whoever creates the row puts one in
 * each place.
 */
export interface ParsedAzureConnection {
  spec: RemoteHostSpec;
  /** What to call the row — the account name. */
  name: string;
  /** The account key or SAS token. Never stored in the spec. */
  secret: string;
  auth: AzureAuth;
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
    s3: { auth: "profile", profile: "", access_key_id: "", region: "", endpoint: "", path_style: false },
    azure: { auth: "account_key", account: "", endpoint_suffix: "", endpoint: "" },
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
      s3: { ...base.s3, ...(parsed.s3 ?? {}) },
      azure: { ...base.azure, ...(parsed.azure ?? {}) },
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

/** The port this kind implies when a spec leaves `port` at 0 — 22, 21, 990, 5900 or 3389. */
export function defaultPortFor(spec: RemoteHostSpec): number {
  switch (spec.kind) {
    case "ftp":
      return DEFAULT_FTP_PORT;
    case "ftps":
      // Explicit FTPS upgrades the control connection in place, so it stays on 21.
      return spec.ftp.implicit_tls ? DEFAULT_FTPS_IMPLICIT_PORT : DEFAULT_FTP_PORT;
    case "vnc":
      return DEFAULT_VNC_PORT;
    case "rdp":
      return DEFAULT_RDP_PORT;
    case "s3":
    case "azure":
    case "azure_blob":
    case "azure_files":
    case "azure_queue":
    case "azure_table":
      // A cloud endpoint is a URL and its port is the scheme's. Naming 443 in a field would be a
      // control that changes nothing.
      return 443;
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
 *
 * **A cloud account has no hostname, and asking for one is what kept Connect greyed out.** This
 * used to read `spec.host` for every kind, so an Azure account with its name, its key and its
 * endpoints all filled in still reported "no address" — the one field it can never have. What
 * stands in its place is what each cloud actually needs before a request can be signed: an account
 * (or an endpoint) for Azure, and for S3 an access key when that is the scheme, since a profile
 * resolves to something without anything being typed here at all.
 */
export function hasAddress(spec: RemoteHostSpec): boolean {
  if (isAzureKind(spec.kind)) {
    return spec.azure.account.trim().length > 0 || spec.azure.endpoint.trim().length > 0;
  }
  if (spec.kind === "s3") {
    return spec.s3.auth === "profile" || spec.s3.access_key_id.trim().length > 0;
  }
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
  // A cloud row's one line is the account, not an address it hasn't got. Written as the endpoint it
  // will actually talk to, because that is the string the user can check against the portal —
  // `contoso.blob.core.windows.net` is recognisable in a way `contoso` alone is not.
  if (isAzureKind(spec.kind)) {
    const endpoint = spec.azure.endpoint.trim();
    if (endpoint) return endpoint;
    const account = spec.azure.account.trim();
    if (!account) return "";
    const suffix = spec.azure.endpoint_suffix.trim() || "core.windows.net";
    return `${account}.${suffix}`;
  }
  if (spec.kind === "s3") {
    const endpoint = spec.s3.endpoint.trim();
    const where = endpoint || `s3 · ${spec.s3.region.trim() || "us-east-1"}`;
    const who =
      spec.s3.auth === "profile" ? spec.s3.profile.trim() || "default" : spec.s3.access_key_id.trim();
    return who ? `${where} · ${who}` : where;
  }

  const host = spec.host.trim();
  if (!host) return "";
  const user = spec.user.trim();
  const target = user ? `${user}@${host}` : host;
  const port = spec.port && spec.port !== defaultPortFor(spec) ? `:${spec.port}` : "";
  const jump = spec.jump.trim() ? ` via ${spec.jump.trim()}` : "";
  return `${target}${port}${jump}`;
}

/**
 * The URL one Azure service on this account will actually be asked for.
 *
 * The same arithmetic `remotes::cloud::azure::endpoint` does, repeated here for one reason: the
 * editor can then *show* the four endpoints as they are typed, which is how a wrong suffix or a
 * misspelt account is caught before a request fails with a DNS error. It is a preview, never an
 * input — every request is still built in Rust.
 */
export function azureEndpoint(
  spec: RemoteHostSpec,
  service: "blob" | "file" | "queue" | "table",
): string {
  const custom = spec.azure.endpoint.trim();
  if (custom) return custom;
  const account = spec.azure.account.trim();
  if (!account) return "";
  const suffix = spec.azure.endpoint_suffix.trim() || "core.windows.net";
  return `https://${account}.${service}.${suffix}`;
}

/** How a forward reads in a list: `5432 → db.internal:5432`, or the SOCKS form for a dynamic one. */
export function describeForward(forward: ForwardSpec | ActiveForward): string {
  const listen = forward.listen_port === 0 ? "auto" : String(forward.listen_port);
  if (forward.kind === "dynamic") return `SOCKS :${listen}`;
  const target = `${forward.target_host || "localhost"}:${forward.target_port}`;
  return forward.kind === "local" ? `${listen} → ${target}` : `${target} → ${listen}`;
}
