import { liftUrlSecret, maskConnectionSecrets } from "./connectionSecrets";
import type { DbKind } from "../../types/database";

/**
 * A connection's details as plain lines to paste in a chat:
 *
 *     HOST: db.internal
 *     PORT: 5432
 *     USER: app
 *     DATABASE: shop
 *
 * The quick way to tell someone where a database is. The secure share (`ConnectionShareDialogs`)
 * is the way to hand over the connection itself. **Never a password**: nothing here reads the
 * keychain, and a password inside a URL is taken out before the URL is copied.
 *
 * Read from what the form shows, unsaved edits included: it is what the person is looking at.
 */

export interface ConnectionTextInput {
  kind: DbKind;
  /** Which half of the form is on screen. */
  mode: "fields" | "url";
  url: string;
  host: string;
  port: number | null;
  defaultPort: number | null;
  user: string;
  database: string;
  /** A file on this machine (SQLite, DuckDB…): its path is what there is to say. */
  file: boolean;
  /** A JDBC driver's own fields (an account, a warehouse…), with the label the form gives them. */
  extras?: { label: string; value: string }[];
}

/** The URL with any password removed, then anything password-shaped that is left masked. */
export function shareableUrl(kind: DbKind, url: string): string {
  return maskConnectionSecrets(liftUrlSecret(kind, url.trim()).url);
}

/** Host, port, user and database out of a `scheme://user@host:port/db` URL, when it is one. */
export function urlParts(url: string): { host: string; port: string; user: string; database: string } | null {
  const match = /^(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^:/?#;,]+)(?::(\d+))?(?:\/([^?#;]*))?/i.exec(url.trim());
  if (!match) return null;
  const decode = (s: string | undefined) => {
    try {
      return decodeURIComponent(s ?? "");
    } catch {
      return s ?? "";
    }
  };
  const userinfo = match[1] ?? "";
  return {
    host: match[2],
    port: match[3] ?? "",
    user: decode(userinfo.split(":")[0]),
    database: decode((match[4] ?? "").split("/")[0]),
  };
}

export function connectionText(input: ConnectionTextInput): string {
  const lines: string[] = [];
  const add = (label: string, value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value).trim();
    if (text) lines.push(`${label}: ${text}`);
  };

  if (input.mode === "url" && input.url.trim()) {
    const url = shareableUrl(input.kind, input.url);
    add("URL", url);
    const parts = urlParts(url);
    if (parts) {
      add("HOST", parts.host);
      add("PORT", parts.port || input.defaultPort);
      add("USER", parts.user || input.user);
      add("DATABASE", parts.database);
    } else {
      add("USER", input.user);
    }
    return lines.join("\n");
  }

  if (input.file) {
    add("FILE", input.database);
  } else {
    add("HOST", input.host || "localhost");
    add("PORT", input.port || input.defaultPort);
    add("USER", input.user);
    add("DATABASE", input.database);
  }
  for (const extra of input.extras ?? []) add(extra.label.toUpperCase(), extra.value);
  return lines.join("\n");
}
