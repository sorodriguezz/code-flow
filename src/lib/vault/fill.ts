/**
 * Turning a keyring entry into the fields of a form.
 *
 * One module for all three destinations — the database dialog, the remote host panel and the API
 * client's auth form — because the interesting part is the same argument three times over, and it
 * is easier to keep honest in one place than scattered across three components.
 *
 * The rules every mapper here follows:
 *
 * **A field the entry cannot answer is left alone, never blanked.** A fill is additive. An entry
 * that carries only a username and password must not wipe the host somebody has already typed —
 * "fill" and "reset the form to this entry" are different acts and only the first was asked for.
 *
 * **Identifiers are trimmed, secrets are not.** A host pasted with a trailing newline is a host
 * that will not resolve, so trimming it is a repair. A password with a trailing space is a
 * *different password*, and trimming it produces a credential that fails to authenticate with
 * nothing on screen to explain why.
 *
 * **Nothing is guessed across meanings.** An entry's `apiKey` does not become a database password
 * and its `privateKey` does not become an SSH key path — see `remoteFillFrom`. A mapper that
 * stretches to fill one more box is a mapper that silently puts the wrong credential in it.
 *
 * **What could not be applied is reported, not dropped.** Each result carries the count of boxes it
 * answered plus whatever it had to refuse, so the caller can say so rather than leaving the user to
 * notice.
 *
 * These functions are pure and touch no store, which is also what makes them the only part of this
 * feature that can be checked without running the app.
 */

import type { AuthConfig } from "../../types/api";
import type { DbConnectionConfig, DbKind, DbSslMode } from "../../types/database";
import { isAzureKind, type RemoteHostSpec } from "../../types/remote";
import type { VaultSecret } from "../../types/vault";

/** A trimmed identifier — host, user, region. `""` means the entry does not answer this. */
function field(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A secret, verbatim. See the module docs for why this one does not trim. */
function raw(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}

/** A port, or `null` for anything that is not one. `0` is not a port; it is this app's word for
 *  "the engine's default", and an entry that says `0` is an entry that says nothing. */
function port(value: string | undefined): number | null {
  const parsed = Number.parseInt(field(value), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

/**
 * Engine names as people write them, mapped to the six this app speaks.
 *
 * Wider than the `DbKind` union on purpose: the entry was typed by a human — or imported from
 * 1Password, where the field is free text — and `postgresql` is not a different engine from
 * `postgres`. Anything not here simply does not match, which is reported rather than corrected.
 */
const DB_ALIASES: Record<string, DbKind> = {
  postgres: "postgres",
  postgresql: "postgres",
  psql: "postgres",
  pgsql: "postgres",
  pg: "postgres",
  supabase: "supabase",
  sqlserver: "sqlserver",
  "sql server": "sqlserver",
  mssql: "sqlserver",
  "ms sql": "sqlserver",
  "azure sql": "sqlserver",
  iris: "iris",
  intersystems: "iris",
  "intersystems iris": "iris",
  cache: "iris",
  mongodb: "mongodb",
  mongo: "mongodb",
  redis: "redis",
  valkey: "redis",
};

/** SSL modes as drivers spell them, mapped to the three this app has. */
const DB_SSL_ALIASES: Record<string, DbSslMode> = {
  disable: "disable",
  disabled: "disable",
  off: "disable",
  none: "disable",
  no: "disable",
  allow: "disable",
  prefer: "require",
  require: "require",
  required: "require",
  yes: "require",
  on: "require",
  true: "require",
  verify_full: "verify_full",
  "verify-full": "verify_full",
  "verify full": "verify_full",
  full: "verify_full",
  verify_ca: "verify_full",
  "verify-ca": "verify_full",
};

export interface DbFill {
  patch: Partial<DbConnectionConfig>;
  /** `null` when the entry carries no password. The box is then left as it was — which, for a saved
   *  connection, is what keeps the password already in the keychain. */
  password: string | null;
  /** How many boxes the entry answered. `0` means it had nothing this form wants, which is worth
   *  saying out loud rather than reporting a successful fill of nothing. */
  filled: number;
  /**
   * The engine the entry names, when it is not the one the dialog is set to.
   *
   * **Reported, never applied.** Switching engine in the dialog resets every field to that engine's
   * defaults, so a fill that also switched would throw away the values it had just written — and
   * the engine was already answered, by the menu that opened the dialog. Saying "this entry says
   * mysql" lets the user decide; changing it under them does not.
   */
  engineMismatch: string | null;
}

/**
 * A keyring entry as database connection fields.
 *
 * `mode` is the dialog's own fields-or-URL switch, and it decides which half is filled: the two are
 * alternatives where the URL silently wins, so writing both would hand the user a form whose
 * visible fields are not the ones being used.
 */
export function dbFillFrom(secret: VaultSecret, kind: DbKind, mode: "fields" | "url"): DbFill {
  const patch: Partial<DbConnectionConfig> = {};
  let filled = 0;

  const engine = field(secret.engine).toLowerCase();
  const matched = DB_ALIASES[engine] ?? null;
  const engineMismatch = engine !== "" && matched !== kind ? field(secret.engine) : null;

  const url = raw(secret.connectionString);
  if (mode === "url") {
    if (url) {
      patch.url = url;
      filled += 1;
    }
  } else {
    const host = field(secret.host);
    if (host) {
      patch.host = host;
      filled += 1;
    }
    const parsedPort = port(secret.port);
    if (parsedPort !== null) {
      patch.port = parsedPort;
      filled += 1;
    }
    const database = field(secret.database);
    if (database) {
      patch.database = database;
      filled += 1;
    }
    const user = field(secret.username);
    if (user) {
      patch.user = user;
      filled += 1;
    }
    const ssl = DB_SSL_ALIASES[field(secret.sslMode).toLowerCase()];
    if (ssl) {
      patch.ssl = ssl;
      filled += 1;
    }
  }

  // Not `raw(...) || null`: an entry whose password is a single space is an entry with a password.
  const password = typeof secret.password === "string" && secret.password !== "" ? secret.password : null;
  if (password !== null) filled += 1;

  return { patch, password, filled, engineMismatch };
}

// ---------------------------------------------------------------------------
// Remote hosts
// ---------------------------------------------------------------------------

export interface RemoteFill {
  patch: Partial<RemoteHostSpec>;
  /** The host's one secret slot — an SSH or FTP password, an S3 secret key, an Azure key or SAS. */
  password: string | null;
  filled: number;
  /**
   * Set when the entry carries private-key *material* that had nowhere to go.
   *
   * CodeFlow speaks no SSH protocol: every session is the system's own `ssh`, which takes a key as a
   * **path** (`key_file`). A PEM body cannot be written into that box — doing so would produce a
   * host that fails to connect with an error about a missing file. The honest move is to say the
   * key was left behind, so the user writes it to disk themselves.
   */
  privateKeyIgnored: boolean;
}

/**
 * A keyring entry as a remote host's settings.
 *
 * Takes the whole current spec rather than just the kind, because three of the four shapes live in
 * nested objects (`ftp`, `s3`, `azure`) that have to be merged rather than replaced — a patch that
 * wrote a fresh `s3` would silently reset the settings it had no opinion about.
 */
export function remoteFillFrom(secret: VaultSecret, current: RemoteHostSpec): RemoteFill {
  const patch: Partial<RemoteHostSpec> = {};
  let filled = 0;
  let password: string | null = null;
  const privateKeyIgnored = field(secret.privateKey) !== "";

  const take = (secretValue: string | undefined) => {
    const value = raw(secretValue);
    if (value === "" || password !== null) return;
    password = value;
    filled += 1;
  };

  const kind = current.kind;

  if (kind === "s3") {
    const s3 = { ...current.s3 };
    let touched = false;
    const accessKey = field(secret.accessKeyId);
    if (accessKey) {
      s3.access_key_id = accessKey;
      touched = true;
      filled += 1;
    }
    const region = field(secret.region);
    if (region) {
      s3.region = region;
      touched = true;
      filled += 1;
    }
    const endpoint = field(secret.endpoint);
    if (endpoint) {
      s3.endpoint = endpoint;
      touched = true;
      filled += 1;
    }
    // Only when the entry actually brought a key pair. An entry with nothing but a region must not
    // move a host off the `~/.aws` profile it was working with.
    if (accessKey || raw(secret.secretAccessKey)) {
      s3.auth = "access_key";
      touched = true;
    }
    if (touched) patch.s3 = s3;
    take(secret.secretAccessKey);
  } else if (isAzureKind(kind)) {
    const azure = { ...current.azure };
    let touched = false;
    // The account name, which for Azure is what an access key id is for S3 — the identifier half of
    // the pair. `bucket` is the container, which is a path here rather than a setting.
    const account = field(secret.accessKeyId) || field(secret.username);
    if (account) {
      azure.account = account;
      touched = true;
      filled += 1;
    }
    const endpoint = field(secret.endpoint);
    if (endpoint) {
      azure.endpoint = endpoint;
      touched = true;
      filled += 1;
    }
    // A SAS and an account key are different credentials in the same box, and which one it is
    // decides how every request is signed — so the auth mode follows whichever the entry carries.
    if (raw(secret.token)) {
      azure.auth = "sas";
      touched = true;
      take(secret.token);
    } else if (raw(secret.secretAccessKey) || raw(secret.password)) {
      azure.auth = "account_key";
      touched = true;
      take(secret.secretAccessKey || secret.password);
    }
    if (touched) patch.azure = azure;
  } else {
    const host = field(secret.host);
    if (host) {
      patch.host = host;
      filled += 1;
    }
    const parsedPort = port(secret.port);
    if (parsedPort !== null) {
      patch.port = parsedPort;
      filled += 1;
    }
    const user = field(secret.username);
    if (user) {
      patch.user = user;
      filled += 1;
    }
    take(secret.password);

    if (kind === "ftp" || kind === "ftps") {
      // A host being given a login is a host that is not logging in anonymously. Left alone when
      // the entry brought neither, so a fill of a region cannot silently change how it connects.
      if ((user || password !== null) && current.ftp.anonymous) {
        patch.ftp = { ...current.ftp, anonymous: false };
      }
    } else if (password !== null && current.auth !== "password") {
      // Same argument: an entry that carries a password is an answer to "how does this authenticate".
      patch.auth = "password";
    }
  }

  return { patch, password, filled, privateKeyIgnored };
}

// ---------------------------------------------------------------------------
// API client auth
// ---------------------------------------------------------------------------

export interface AuthFill {
  auth: AuthConfig;
  filled: number;
}

/**
 * A keyring entry as the API client's auth config, for whichever type the form is already set to.
 *
 * The type is **not** changed. It is a decision about the request — what the server expects — not
 * about the credential, and an entry with both a username and an API key would otherwise get a vote
 * on something it knows nothing about.
 *
 * `oauth2` is deliberately absent. Its client id and secret are half a flow whose other half is a
 * token URL, a grant and a scope; filling two boxes of six looks like a completed form and is not
 * one. `jwt` is absent for the same reason — its secret is signing material, paired with claims.
 */
export function authFillFrom(auth: AuthConfig, secret: VaultSecret): AuthFill {
  let filled = 0;
  const count = <T,>(value: T, changed: boolean): T => {
    if (changed) filled += 1;
    return value;
  };
  const user = field(secret.username);
  const pass = raw(secret.password);

  switch (auth.type) {
    case "basic":
    case "digest": {
      const next = { ...auth[auth.type] };
      if (user) next.username = count(user, true);
      if (pass) next.password = count(pass, true);
      return { auth: { ...auth, [auth.type]: next }, filled };
    }
    case "bearer": {
      // A bearer token is whichever of these the entry happens to call it. All three are the same
      // thing — an opaque string sent as-is — unlike the database mapper's fields, which are not.
      const token = raw(secret.token) || raw(secret.apiKey) || pass;
      if (!token) return { auth, filled: 0 };
      return { auth: { ...auth, bearer: { token } }, filled: 1 };
    }
    case "apikey": {
      const value = raw(secret.apiKey) || raw(secret.token) || pass;
      if (!value) return { auth, filled: 0 };
      return { auth: { ...auth, apikey: { ...auth.apikey, value } }, filled: 1 };
    }
    case "awsv4": {
      const next = { ...auth.awsv4 };
      const accessKey = field(secret.accessKeyId);
      if (accessKey) next.accessKey = count(accessKey, true);
      if (raw(secret.secretAccessKey)) next.secretKey = count(raw(secret.secretAccessKey), true);
      if (raw(secret.token)) next.sessionToken = count(raw(secret.token), true);
      const region = field(secret.region);
      if (region) next.region = count(region, true);
      return { auth: { ...auth, awsv4: next }, filled };
    }
    default:
      return { auth, filled: 0 };
  }
}

/** Whether a fill would have anywhere to put anything, given the auth type on screen. Drives
 *  whether the button is offered at all — a button that can only ever say "nothing to fill" is
 *  worse than no button. */
export function authFillSupported(type: AuthConfig["type"]): boolean {
  return type === "basic" || type === "digest" || type === "bearer" || type === "apikey" || type === "awsv4";
}
