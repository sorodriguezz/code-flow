import type { DbKind } from "../../types/database";

/**
 * Passwords that arrive inside a connection URL or connection string.
 *
 * The password box goes to the OS keychain and never to `db_connections.spec`, which is plain text
 * in the config directory. A URL is saved *in* that spec, though, and the URL is exactly how these
 * credentials are handed out — Supabase's dashboard, Atlas, a .NET `appsettings.json` — so a pasted
 * `postgresql://app:s3cret@…` used to be stored whole, and a SQL Server `…;Password=s3cret` was not
 * even recognised as holding one (it showed up in full in the explorer's tooltip).
 *
 * So the password is lifted out on save: the spec keeps the URL without it, the keychain gets it in
 * the same slot the password box writes, and each driver adds it back at connect time — the same
 * fallback a URL with no password already had (see `pg_config`, `connection_opts`, `client_options`,
 * `build_client` and `tds_config`). Connections saved before this are migrated the same way when
 * they are loaded, and anything that *displays* a URL masks it with `maskConnectionSecrets`.
 *
 * Every form the drivers accept is covered: a URI's `user:pass@`, Postgres' `?password=` and its
 * `key=value` form, SQL Server's ADO.NET `Password=`/`Pwd=` and JDBC `password=`, and Oracle's
 * `user/pass@`. What comes back is the password *as the driver would have read it* — percent-decoded
 * from a URI, unquoted from a connection string — because the keychain value is used verbatim.
 */

export interface LiftedSecret {
  /** The URL with its password removed — what the spec keeps. */
  url: string;
  /** The password it carried, or `null` when it carried none. */
  password: string | null;
  /**
   * The login, when the form that carried the password also carried the user in a way that cannot be
   * kept without it. Only Oracle's `user/pass@host`: `user@host` is not a URL its driver reads, so
   * the user moves to the connection's own field. `null` otherwise.
   */
  user: string | null;
}

const NONE = (url: string): LiftedSecret => ({ url, password: null, user: null });

/** `scheme://userinfo@rest`, with `userinfo` ending at the last `@` before any query. */
function splitUri(url: string): { scheme: string; userinfo: string | null; rest: string } | null {
  const match = /^([a-z][a-z0-9+.-]*:(?:[a-z][a-z0-9+.-]*:)*)\/\/(.*)$/i.exec(url);
  if (!match) return null;
  const [, scheme, afterSlashes] = match;
  const queryAt = afterSlashes.search(/[?#]/);
  const head = queryAt === -1 ? afterSlashes : afterSlashes.slice(0, queryAt);
  // The last `@`, as the WHATWG parser and the Postgres driver both read it: a host cannot contain
  // one, so every earlier `@` belongs to the password.
  const at = head.lastIndexOf("@");
  if (at === -1) return { scheme, userinfo: null, rest: afterSlashes };
  return { scheme, userinfo: afterSlashes.slice(0, at), rest: afterSlashes.slice(at + 1) };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A URI's `user:password@`. */
function liftFromUri(url: string): LiftedSecret {
  const parts = splitUri(url);
  if (!parts || parts.userinfo === null) return NONE(url);
  const colon = parts.userinfo.indexOf(":");
  if (colon === -1) return NONE(url);
  const user = parts.userinfo.slice(0, colon);
  const password = parts.userinfo.slice(colon + 1);
  if (password === "") return NONE(url);
  // `user@` is kept so the driver still knows who to log in as; with no user (Redis's
  // `redis://:pass@host`) the whole userinfo goes.
  const stripped = user ? `${parts.scheme}//${user}@${parts.rest}` : `${parts.scheme}//${parts.rest}`;
  return { url: stripped, password: decode(password), user: null };
}

/**
 * Postgres' `?password=…` query parameter, which libpq and `tokio-postgres` both honour — and,
 * with `pwd` too, the same parameter on the JDBC URLs that take their properties as a query.
 */
function liftFromQuery(url: string, keys: string[] = ["password"]): LiftedSecret {
  const queryAt = url.indexOf("?");
  if (queryAt === -1) return NONE(url);
  const params = url.slice(queryAt + 1).split("&");
  const key = new RegExp(`^(?:${keys.join("|")})=`, "i");
  const index = params.findIndex((param) => key.test(param));
  if (index === -1) return NONE(url);
  const password = decode(params[index].slice(params[index].indexOf("=") + 1));
  if (password === "") return NONE(url);
  params.splice(index, 1);
  const base = url.slice(0, queryAt);
  return { url: params.length > 0 ? `${base}?${params.join("&")}` : base, password, user: null };
}

/** Postgres' `host=… password=…` form. Values may be single-quoted, with `\'` and `\\` escapes. */
function liftFromKeywords(url: string): LiftedSecret {
  const match = /(^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S*)/i.exec(url);
  if (!match) return NONE(url);
  const raw = match[2];
  const password = raw.startsWith("'") ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
  if (password === "") return NONE(url);
  const stripped = (url.slice(0, match.index) + match[1] + url.slice(match.index + match[0].length))
    .replace(/\s{2,}/g, " ")
    .trim();
  return { url: stripped, password, user: null };
}

/**
 * `key=value;` pairs, split where the connection string itself splits them: on `;` outside quotes
 * and braces. Each piece keeps its original text so the string is rebuilt exactly as written.
 */
function splitPairs(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      current += character;
      if (character === quote) {
        // A doubled closer is an escaped one inside the value.
        if (quote !== "}" && text[index + 1] === quote) {
          current += quote;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === ";") {
      pieces.push(current);
      current = "";
      continue;
    }
    if ((character === '"' || character === "'") && current.slice(current.indexOf("=") + 1).trim() === "") {
      quote = character;
    } else if (character === "{") {
      quote = "}";
    }
    current += character;
  }
  pieces.push(current);
  return pieces;
}

/** A connection-string value as the driver reads it: trimmed, and unquoted or unbraced. */
function unquoteValue(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1).split(first + first).join(first);
  }
  if (first === "{" && value.endsWith("}")) return value.slice(1, -1);
  return value;
}

const keyOf = (pair: string) =>
  pair.slice(0, pair.indexOf("=")).trim().toLowerCase().replace(/\s+/g, " ");

/**
 * SQL Server's ADO.NET (`Server=…;Password=…`) and JDBC (`jdbc:sqlserver://host;password=…`)
 * strings. `Pwd` is the ODBC-era spelling both still accept.
 */
function liftFromConnectionString(url: string): LiftedSecret {
  return liftFromPairs(url, /^jdbc:sqlserver:\/\//i.test(url));
}

/** `password=`/`pwd=` among `;`-separated pairs. `jdbc`: the first piece is a JDBC URL's address,
 *  never a pair — even when it has an `=` in it (`jdbc:athena://Region=…`). */
function liftFromPairs(url: string, jdbc: boolean): LiftedSecret {
  const pieces = splitPairs(url);
  // The first piece of a JDBC URL is the server, never a pair.
  const index = pieces.findIndex(
    (pair, position) =>
      (!jdbc || position > 0) && pair.includes("=") && ["password", "pwd"].includes(keyOf(pair)),
  );
  if (index === -1) return NONE(url);
  const pair = pieces[index];
  const password = unquoteValue(pair.slice(pair.indexOf("=") + 1));
  if (password === "") return NONE(url);
  pieces.splice(index, 1);
  const stripped = pieces.join(";").replace(/;{2,}/g, ";");
  return { url: stripped, password, user: null };
}

/** Oracle's `[jdbc:oracle:thin:]user/password@host…`. */
function liftFromOracle(url: string): LiftedSecret {
  const match = /^(jdbc:oracle:thin:)?([^/@\s:"]+|"[^"]+")\/("[^"]*"|[^@]*)@(.+)$/i.exec(url);
  if (!match) return NONE(url);
  const [, prefix, rawUser, rawPassword, rest] = match;
  const password = rawPassword.startsWith('"') ? rawPassword.slice(1, -1) : rawPassword;
  if (password === "") return NONE(url);
  const user = rawUser.startsWith('"') ? rawUser.slice(1, -1) : rawUser;
  // With the driver's prefix the `@` stays: `jdbc:oracle:thin:@host…` is the credential-less form.
  // Without it the driver adds `jdbc:oracle:thin:@` itself (see `jdbc_url`).
  return { url: prefix ? `${prefix}@${rest}` : rest, password, user };
}

/**
 * Any JDBC driver's URL — the catalogue's sixty, each with its own spelling, so every shape one of
 * them uses: a URI's `user:pass@`, a `password`/`pwd` parameter after `?` or among `;` pairs (SQL
 * Server, DB2, Databricks), and Oracle's `user/pass@`. The bridge hands the lifted password back to
 * the driver as its `password` property, or under the name the driver's catalogue entry maps it to.
 */
function liftFromJdbc(url: string): LiftedSecret {
  if (/^jdbc:oracle:/i.test(url)) return liftFromOracle(url);
  const fromUri = liftFromUri(url);
  if (fromUri.password !== null) return fromUri;
  const fromQuery = liftFromQuery(url, ["password", "pwd"]);
  if (fromQuery.password !== null) return fromQuery;
  return liftFromPairs(url, true);
}

/**
 * The password a connection URL carries, lifted out, for the engine it is written for.
 *
 * `null` for a URL with no password, an empty one, or an engine whose URLs carry none (IRIS, SQLite).
 */
export function liftUrlSecret(kind: DbKind, url: string): LiftedSecret {
  const trimmed = url.trim();
  if (!trimmed) return NONE(url);
  switch (kind) {
    case "postgres":
    case "supabase": {
      if (!trimmed.includes("://")) return liftFromKeywords(trimmed);
      const fromUri = liftFromUri(trimmed);
      // Both at once is unusual, and both would be read; the query parameter is the later word.
      const fromQuery = liftFromQuery(fromUri.url);
      return fromQuery.password !== null ? fromQuery : fromUri;
    }
    case "mysql":
    case "mariadb":
    case "mongodb":
    case "redis":
      return liftFromUri(trimmed);
    case "sqlserver":
      return liftFromConnectionString(trimmed);
    case "oracle":
      return liftFromOracle(trimmed);
    case "jdbc":
      return liftFromJdbc(trimmed);
    default:
      return NONE(url);
  }
}

/** Whether a URL still carries a password of its own. */
export function urlCarriesPassword(kind: DbKind, url: string): boolean {
  return liftUrlSecret(kind, url).password !== null;
}

const MASK = "••••";

/**
 * A connection URL or connection string with every password in it masked, for display.
 *
 * Engine-agnostic on purpose: a label that has to be safe must not depend on the label knowing
 * which engine it describes, and every shape here is unambiguous on its own.
 */
export function maskConnectionSecrets(url: string): string {
  let masked = url;
  const parts = splitUri(masked);
  if (parts && parts.userinfo !== null) {
    const colon = parts.userinfo.indexOf(":");
    if (colon !== -1 && colon < parts.userinfo.length - 1) {
      masked = `${parts.scheme}//${parts.userinfo.slice(0, colon)}:${MASK}@${parts.rest}`;
    }
  }
  // `password=` / `pwd=` pairs (and libpq's `sslpassword`, a key's passphrase), whichever separator
  // carries them (`;`, `&`, `?` or a space). A quoted or braced value is masked whole, separators
  // inside it included.
  masked = masked.replace(
    /(^|[;&?\s])(\s*(?:sslpassword|password|pwd)\s*=\s*)("(?:[^"]|"")*"|'(?:[^'\\]|\\.|'')*'|\{[^}]*\}|[^;&\s]*)/gi,
    (_match, lead: string, key: string, value: string) => (value ? `${lead}${key}${MASK}` : `${lead}${key}`),
  );
  // Oracle's `user/password@`.
  masked = masked.replace(
    /^(jdbc:oracle:thin:)?([^/@\s:"]+|"[^"]+")\/("[^"]*"|[^@/]+)@/i,
    (_match, prefix: string | undefined, user: string) => `${prefix ?? ""}${user}/${MASK}@`,
  );
  return masked;
}
