import { defaultConnectionConfig, type DbConnectionConfig, type DbKind } from "../../types/database";
import { liftUrlSecret } from "./connectionSecrets";

/**
 * A connection handed from one CodeFlow to another as a single link.
 *
 * Before this, sharing a database meant reading the form out field by field — host, port, database,
 * user, the driver, the SSL mode, the tunnel — and the other person typing it all back. The link
 * carries the whole saved spec, so the recipient pastes it (or clicks it: `codeflow://` is the app's
 * own scheme) and gets the same connection.
 *
 * **The password is opt-in, and it never passes through the webview on the way out.** A saved one
 * lives only in the OS keychain and there is deliberately no command that returns it. So a link
 * without it is built here; a link with it is built by the backend (`db_copy_share_link_with_password`),
 * which reads the keychain, writes the link straight to the clipboard — hidden from clipboard
 * history and cleared after a while, like a vault secret — and hands nothing back. Both produce the
 * same shape, which `decodeShareLink` reads: `codeflow://connection?d=` + base64url(JSON), unpadded.
 *
 * It is an encoding, not encryption: anyone holding a link with a password can read the password.
 * The share dialog says so before it is copied.
 */

export const SHARE_LINK_PREFIX = "codeflow://connection?d=";
const SHARE_VERSION = 1;

/** What a link carries. */
export interface SharedConnection {
  v: number;
  name: string;
  /** The saved settings, without `id` or `password`. */
  spec: Partial<DbConnectionConfig> & { kind: DbKind };
  /** Present only when the sender chose to include it. */
  password?: string;
}

const KINDS: readonly DbKind[] = [
  "postgres",
  "supabase",
  "sqlserver",
  "iris",
  "mongodb",
  "redis",
  "mysql",
  "mariadb",
  "sqlite",
  "oracle",
  "jdbc",
];

/**
 * The payload for a saved connection, ready to encode.
 *
 * A URL that still carries a password of its own (one saved before passwords were lifted out of
 * URLs) has it removed here: "without password" has to mean without, whichever box it was typed in.
 */
export function sharePayload(name: string, config: DbConnectionConfig): SharedConnection {
  const { id: _id, password: _password, ...rest } = config;
  const lifted = liftUrlSecret(config.kind, config.url);
  return {
    v: SHARE_VERSION,
    name,
    spec: {
      ...rest,
      url: lifted.password !== null ? lifted.url : config.url,
      user: lifted.user ?? config.user,
    },
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(data: string): string {
  const normal = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The link for a payload that carries no password — see the module comment for the other kind. */
export function encodeShareLink(payload: SharedConnection): string {
  return SHARE_LINK_PREFIX + toBase64Url(JSON.stringify(payload));
}

/**
 * The connection a pasted text carries, or `null` when it carries none.
 *
 * Finds the link anywhere in the text — a chat message pasted whole, with a greeting around it or
 * wrapped in angle brackets by the app it came through — and refuses anything that does not decode
 * to a payload this build understands.
 */
export function decodeShareLink(text: string): SharedConnection | null {
  const match = /codeflow:\/\/connection\/?\?(?:[^\s"'<>]*&)?d=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(match[1]));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.v !== SHARE_VERSION) return null;
  if (typeof value.name !== "string") return null;
  const spec = value.spec as Record<string, unknown> | undefined;
  if (!spec || typeof spec !== "object" || !KINDS.includes(spec.kind as DbKind)) return null;
  const password = typeof value.password === "string" && value.password !== "" ? value.password : undefined;
  return {
    v: SHARE_VERSION,
    name: value.name,
    spec: spec as SharedConnection["spec"],
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * The settings a shared connection is saved with on this side.
 *
 * Laid over the engine's defaults, and only the fields this build knows — a link from a newer
 * version may carry settings this one has no column for, and a value of the wrong type (a port as a
 * string) is dropped rather than saved, so the form never opens on something it cannot show.
 */
export function importedConfig(shared: SharedConnection): DbConnectionConfig {
  const base = defaultConnectionConfig(shared.spec.kind);
  const next: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as (keyof DbConnectionConfig)[]) {
    if (key === "id" || key === "password" || key === "kind") continue;
    const incoming = (shared.spec as Record<string, unknown>)[key];
    if (incoming === undefined) continue;
    const expected = base[key];
    const sameType =
      Array.isArray(expected) ? Array.isArray(incoming) : typeof incoming === typeof expected || expected === null;
    if (sameType) next[key] = incoming;
  }
  return { ...(next as unknown as DbConnectionConfig), id: "", password: "", kind: shared.spec.kind };
}
