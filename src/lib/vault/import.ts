/**
 * Reading another password manager's export.
 *
 * Four shapes, all of them the same job: turn somebody else's file into entries this keyring can
 * store. Bitwarden's JSON is the richest (folders, kinds, custom fields, TOTP) and the others give
 * up something — a CSV has no folders on 1Password's side and no custom-field types on anyone's.
 *
 * **Every function here is pure and none of them throw.** Text in, a result out, problems collected
 * in `warnings` — the same two invariants `lib/api/importers.ts` states, and for the same reason: a
 * parser that throws on the eleventh of four hundred entries loses the other three hundred and
 * eighty-nine, and an import that silently drops them is worse still.
 *
 * Warnings are keyed rather than English strings, which is a deliberate departure from
 * `importers.ts` (whose warnings are hardcoded English). An import screen is one of the few places
 * a user reads carefully, and reading it in the wrong language is a poor time to start.
 *
 * **What this does not do: attachments.** Bitwarden's export has none, and 1Password's `.1pux`
 * references its own by a document id the export does not resolve. A half-attached file is worse
 * than an absent one, so entries arrive without them and the warning says so.
 */

import { parseCsvGrid } from "../csv";
import type { TranslationKey } from "../i18n/translations";
import type { VaultItemKind, VaultSecret } from "../../types/vault";

/** Which file was recognised. `unknown` is a real answer — the screen says so rather than guessing. */
export type ImportFormat =
  | "bitwarden-json"
  | "bitwarden-csv"
  | "onepassword-csv"
  | "onepassword-1pux"
  | "unknown";

export interface ImportWarning {
  key: TranslationKey;
  params?: Record<string, string | number>;
}

/** One entry, ready to be created. Mirrors what `keyvaultCreateItem` takes. */
export interface ImportedItem {
  kind: VaultItemKind;
  title: string;
  subtitle: string;
  site: string;
  tags: string[];
  /** The folder's *name*; folders are created by name at commit time. `null` for the root. */
  folder: string | null;
  favorite: boolean;
  secret: VaultSecret;
}

export interface ImportResult {
  format: ImportFormat;
  folders: string[];
  items: ImportedItem[];
  warnings: ImportWarning[];
}

function empty(format: ImportFormat): ImportResult {
  return { format, folders: [], items: [], warnings: [] };
}

/** Non-empty, trimmed, or `undefined` — so an empty column never becomes an empty secret field. */
function value(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * What kind of file this is, from its shape rather than its extension.
 *
 * Cheap and synchronous: it runs on every keystroke of the preview screen, so it sniffs structure
 * and never parses. A file whose extension lies — a `.txt` holding Bitwarden's JSON — is still
 * recognised, which is the case that actually happens when someone renames a download.
 */
export function detectFormat(text: string, fileName = ""): ImportFormat {
  const head = text.slice(0, 4000);
  const lower = fileName.toLowerCase();

  if (head.trimStart().startsWith("{")) {
    // 1Password's `export.data` — the JSON lifted out of a `.1pux` by the backend.
    if (/"accounts"\s*:/.test(head) && /"vaults"\s*:/.test(head)) return "onepassword-1pux";
    if (/"items"\s*:/.test(head) && /"folders"\s*:/.test(head)) return "bitwarden-json";
    if (/"encrypted"\s*:/.test(head)) return "bitwarden-json";
    return "unknown";
  }

  const firstLine = head.split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
  // Bitwarden's CSV header is fixed and unmistakable.
  if (firstLine.includes("login_username") || firstLine.includes("login_password")) {
    return "bitwarden-csv";
  }
  // 1Password 8's CSV. `otpauth` is the giveaway — no other exporter names a column that.
  if (firstLine.includes("otpauth") || (firstLine.includes("title") && firstLine.includes("url"))) {
    return "onepassword-csv";
  }
  if (lower.endsWith(".csv")) return "bitwarden-csv";
  return "unknown";
}

/** Parses whatever it is given, or says it does not recognise it. */
export function importVaultExport(text: string, fileName = ""): ImportResult {
  const format = detectFormat(text, fileName);
  switch (format) {
    case "bitwarden-json":
      return parseBitwardenJson(text);
    case "bitwarden-csv":
      return parseBitwardenCsv(text);
    case "onepassword-csv":
      return parseOnePasswordCsv(text);
    case "onepassword-1pux":
      return parseOnePux(text);
    default: {
      const result = empty("unknown");
      result.warnings.push({ key: "vault.import.unknownFormat" });
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// Bitwarden
// ---------------------------------------------------------------------------

/** Bitwarden's `type` column: 1 login, 2 secure note, 3 card, 4 identity. */
function bitwardenKind(type: unknown): VaultItemKind {
  switch (Number(type)) {
    case 2:
      return "note";
    case 3:
      return "card";
    case 4:
      return "identity";
    default:
      return "login";
  }
}

export function parseBitwardenJson(text: string): ImportResult {
  const result = empty("bitwarden-json");
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch {
    result.warnings.push({ key: "vault.import.notJson" });
    return result;
  }

  // An encrypted export is unreadable without the user's Bitwarden key, which this app has no
  // business asking for. Refused with the way out attached.
  if (document.encrypted === true) {
    result.warnings.push({ key: "vault.import.bitwardenEncrypted" });
    return result;
  }

  const folderNames = new Map<string, string>();
  for (const folder of Array.isArray(document.folders) ? document.folders : []) {
    const entry = folder as Record<string, unknown>;
    const name = value(entry.name as string);
    if (typeof entry.id === "string" && name) folderNames.set(entry.id, name);
  }

  const rawItems = Array.isArray(document.items) ? document.items : [];
  let skipped = 0;
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const title = value(item.name as string);
    if (!title) {
      // A nameless entry would arrive as an untitled row nobody can find again.
      skipped += 1;
      continue;
    }
    const kind = bitwardenKind(item.type);
    const secret: VaultSecret = {};
    let subtitle = "";
    let site = "";

    const login = item.login as Record<string, unknown> | undefined;
    if (login) {
      secret.username = value(login.username as string);
      secret.password = value(login.password as string);
      secret.totp = value(login.totp as string);
      subtitle = secret.username ?? "";
      const uris = Array.isArray(login.uris) ? login.uris : [];
      site = value((uris[0] as Record<string, unknown> | undefined)?.uri as string) ?? "";
    }

    const card = item.card as Record<string, unknown> | undefined;
    if (card) {
      secret.cardholder = value(card.cardholderName as string);
      secret.cardNumber = value(card.number as string);
      secret.cvv = value(card.code as string);
      const month = value(card.expMonth as string);
      const year = value(card.expYear as string);
      if (month || year) secret.expiry = [month, year].filter(Boolean).join("/");
      subtitle = secret.cardholder ?? "";
    }

    const identity = item.identity as Record<string, unknown> | undefined;
    if (identity) {
      const names = [identity.firstName, identity.middleName, identity.lastName]
        .map((part) => value(part as string))
        .filter(Boolean);
      secret.fullName = names.length ? names.join(" ") : undefined;
      secret.documentNumber =
        value(identity.passportNumber as string) ??
        value(identity.licenseNumber as string) ??
        value(identity.ssn as string);
      subtitle = secret.fullName ?? "";
    }

    secret.notes = value(item.notes as string);

    // Bitwarden's custom fields: `type` 1 is hidden, everything else is plain. Kept as custom
    // fields rather than guessed into named ones — a field called "PIN" on a login is the user's
    // word for something this app does not have a slot for, and inventing one would rename it.
    const fields = Array.isArray(item.fields) ? item.fields : [];
    const custom = fields
      .map((raw) => raw as Record<string, unknown>)
      .filter((field) => value(field.name as string) || value(field.value as string))
      .map((field) => ({
        name: value(field.name as string) ?? "",
        value: value(field.value as string) ?? "",
        secret: Number(field.type) === 1,
      }));
    if (custom.length) secret.custom = custom;

    const folderId = typeof item.folderId === "string" ? item.folderId : null;
    result.items.push({
      kind,
      title,
      subtitle,
      site,
      tags: [],
      folder: folderId ? (folderNames.get(folderId) ?? null) : null,
      favorite: item.favorite === true,
      secret,
    });
  }

  result.folders = [...new Set(result.items.map((item) => item.folder).filter(Boolean))] as string[];
  if (skipped > 0) result.warnings.push({ key: "vault.import.skippedUnnamed", params: { n: skipped } });
  return result;
}

/** Bitwarden's CSV header, as it writes it. */
const BITWARDEN_COLUMNS = [
  "folder",
  "favorite",
  "type",
  "name",
  "notes",
  "fields",
  "reprompt",
  "login_uri",
  "login_username",
  "login_password",
  "login_totp",
];

export function parseBitwardenCsv(text: string): ImportResult {
  const result = empty("bitwarden-csv");
  const grid = parseCsvGrid(text);
  const [header, ...rows] = grid;
  if (!header) {
    result.warnings.push({ key: "vault.import.emptyFile" });
    return result;
  }

  const index = new Map(header.map((name, at) => [name.trim().toLowerCase(), at]));
  const missing = BITWARDEN_COLUMNS.filter((column) => !index.has(column));
  // Only the ones that carry the entry itself are fatal; `reprompt` and `fields` are Bitwarden's
  // own bookkeeping and an export without them is still an export.
  if (!index.has("name")) {
    result.warnings.push({ key: "vault.import.notBitwardenCsv" });
    return result;
  }
  if (missing.length) {
    result.warnings.push({ key: "vault.import.missingColumns", params: { columns: missing.join(", ") } });
  }

  const at = (row: string[], column: string) => {
    const position = index.get(column);
    return position === undefined ? undefined : value(row[position]);
  };

  let skipped = 0;
  for (const row of rows) {
    const title = at(row, "name");
    if (!title) {
      skipped += 1;
      continue;
    }
    const secret: VaultSecret = {
      username: at(row, "login_username"),
      password: at(row, "login_password"),
      totp: at(row, "login_totp"),
      notes: at(row, "notes"),
    };
    result.items.push({
      kind: bitwardenKind(at(row, "type") === "note" ? 2 : 1),
      title,
      subtitle: secret.username ?? "",
      site: at(row, "login_uri") ?? "",
      tags: [],
      folder: at(row, "folder") ?? null,
      favorite: at(row, "favorite") === "1",
      secret,
    });
  }

  result.folders = [...new Set(result.items.map((item) => item.folder).filter(Boolean))] as string[];
  if (skipped > 0) result.warnings.push({ key: "vault.import.skippedUnnamed", params: { n: skipped } });
  return result;
}

// ---------------------------------------------------------------------------
// 1Password
// ---------------------------------------------------------------------------

/** The columns 1Password 8 writes. Anything else in the header is a custom field. */
const ONEPASSWORD_KNOWN = new Set([
  "title",
  "url",
  "username",
  "password",
  "otpauth",
  "favorite",
  "archived",
  "tags",
  "notes",
  "type",
]);

export function parseOnePasswordCsv(text: string): ImportResult {
  const result = empty("onepassword-csv");
  const grid = parseCsvGrid(text);
  const [header, ...rows] = grid;
  if (!header) {
    result.warnings.push({ key: "vault.import.emptyFile" });
    return result;
  }

  const index = new Map(header.map((name, at) => [name.trim().toLowerCase(), at]));
  if (!index.has("title")) {
    result.warnings.push({ key: "vault.import.notOnePasswordCsv" });
    return result;
  }

  const at = (row: string[], column: string) => {
    const position = index.get(column);
    return position === undefined ? undefined : value(row[position]);
  };

  let skipped = 0;
  let archived = 0;
  for (const row of rows) {
    const title = at(row, "title");
    if (!title) {
      skipped += 1;
      continue;
    }
    // Archived entries are things the user put away. Brought across, but flagged with a tag rather
    // than dropped — deciding for them which of their own entries are worth keeping is not this
    // importer's call.
    const isArchived = at(row, "archived") === "true" || at(row, "archived") === "1";
    if (isArchived) archived += 1;

    const secret: VaultSecret = {
      username: at(row, "username"),
      password: at(row, "password"),
      totp: at(row, "otpauth"),
      notes: at(row, "notes"),
    };

    // Every column 1Password did not name itself is a custom field the user added.
    const custom = header
      .map((name, position) => ({ name: name.trim(), raw: row[position] }))
      .filter(({ name, raw }) => name && !ONEPASSWORD_KNOWN.has(name.toLowerCase()) && value(raw))
      .map(({ name, raw }) => ({ name, value: value(raw) ?? "", secret: false }));
    if (custom.length) secret.custom = custom;

    const tags = (at(row, "tags") ?? "")
      .split(/[,;]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (isArchived) tags.push("archived");

    result.items.push({
      // A CSV row has no type column worth trusting, so everything arrives as a login — the shape
      // a 1Password CSV export actually holds.
      kind: "login",
      title,
      subtitle: secret.username ?? "",
      site: at(row, "url") ?? "",
      tags,
      folder: null,
      favorite: at(row, "favorite") === "true" || at(row, "favorite") === "1",
      secret,
    });
  }

  if (skipped > 0) result.warnings.push({ key: "vault.import.skippedUnnamed", params: { n: skipped } });
  if (archived > 0) result.warnings.push({ key: "vault.import.archivedTagged", params: { n: archived } });
  result.warnings.push({ key: "vault.import.csvNoFolders" });
  return result;
}

/** 1Password's category ids, from `categoryUuid`. */
function onePuxKind(category: unknown): VaultItemKind {
  switch (String(category)) {
    case "002":
      return "card";
    case "003":
      return "note";
    case "004":
      return "identity";
    case "005": // Password
    case "100": // Software licence
    case "112": // API credential
      return "key";
    // The two infrastructure categories. Their own fields — server, port, database, SSL — live in
    // 1Password's `sections`, so they arrive as custom fields rather than in the typed ones: the
    // section field ids are not documented and guessing at them would silently drop values that
    // the custom list keeps verbatim.
    case "102":
      return "database";
    case "110":
      return "server";
    case "006": // Document
      return "file";
    default:
      return "login";
  }
}

/**
 * 1Password's `.1pux`, already lifted out of its zip by `keyvault_read_import_file`.
 *
 * The shape is deeply nested — accounts hold vaults hold items hold an `item` — and every level is
 * optional in the wild, so this walks defensively rather than destructuring. The vault's *name*
 * becomes the folder, which is the closest thing the two models share.
 */
export function parseOnePux(text: string): ImportResult {
  const result = empty("onepassword-1pux");
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch {
    result.warnings.push({ key: "vault.import.notJson" });
    return result;
  }

  const accounts = Array.isArray(document.accounts) ? document.accounts : [];
  let skipped = 0;
  let withAttachments = 0;

  for (const rawAccount of accounts) {
    const vaults = Array.isArray((rawAccount as Record<string, unknown>).vaults)
      ? ((rawAccount as Record<string, unknown>).vaults as unknown[])
      : [];
    for (const rawVault of vaults) {
      const vault = rawVault as Record<string, unknown>;
      const attrs = vault.attrs as Record<string, unknown> | undefined;
      const folder = value(attrs?.name as string) ?? null;
      const items = Array.isArray(vault.items) ? vault.items : [];

      for (const wrapper of items) {
        const item = ((wrapper as Record<string, unknown>).item ?? wrapper) as Record<string, unknown>;
        const overview = (item.overview ?? {}) as Record<string, unknown>;
        const details = (item.details ?? {}) as Record<string, unknown>;

        const title = value(overview.title as string);
        if (!title) {
          skipped += 1;
          continue;
        }

        const secret: VaultSecret = {};
        // `loginFields` carries the username and password, tagged by `designation`.
        const loginFields = Array.isArray(details.loginFields) ? details.loginFields : [];
        for (const rawField of loginFields) {
          const field = rawField as Record<string, unknown>;
          const designation = String(field.designation ?? "").toLowerCase();
          if (designation === "username") secret.username = value(field.value as string);
          if (designation === "password") secret.password = value(field.value as string);
        }
        // A "Password" item carries it at the top level instead.
        secret.password = secret.password ?? value(details.password as string);
        secret.notes = value(details.notesPlain as string);

        // Sections hold everything else, including TOTP. A field's `value` is an object with
        // exactly one key naming its type — `concealed`, `string`, `totp`, `date`, `menu` — which
        // is how a secret custom field is told from a plain one without a second list.
        const custom: { name: string; value: string; secret: boolean }[] = [];
        const sections = Array.isArray(details.sections) ? details.sections : [];
        for (const rawSection of sections) {
          const fields = Array.isArray((rawSection as Record<string, unknown>).fields)
            ? ((rawSection as Record<string, unknown>).fields as unknown[])
            : [];
          for (const rawField of fields) {
            const field = rawField as Record<string, unknown>;
            const holder = (field.value ?? {}) as Record<string, unknown>;
            const [type, raw] = Object.entries(holder)[0] ?? [];
            const text = value(typeof raw === "string" ? raw : undefined);
            if (!text) continue;
            if (type === "totp") {
              secret.totp = secret.totp ?? text;
              continue;
            }
            const name = value(field.title as string) ?? value(field.id as string) ?? "";
            if (!name) continue;
            custom.push({ name, value: text, secret: type === "concealed" });
          }
        }
        if (custom.length) secret.custom = custom;

        if (Array.isArray(item.documentAttributes) || Array.isArray(details.documentAttributes)) {
          withAttachments += 1;
        }

        const urls = Array.isArray(overview.urls) ? overview.urls : [];
        const site =
          value(overview.url as string) ??
          value((urls[0] as Record<string, unknown> | undefined)?.url as string) ??
          "";
        const tags = (Array.isArray(overview.tags) ? overview.tags : [])
          .map((tag) => value(tag as string))
          .filter(Boolean) as string[];

        result.items.push({
          kind: onePuxKind(item.categoryUuid),
          title,
          subtitle: secret.username ?? "",
          site,
          tags,
          folder,
          favorite: Number(item.favIndex ?? 0) > 0,
          secret,
        });
      }
    }
  }

  result.folders = [...new Set(result.items.map((item) => item.folder).filter(Boolean))] as string[];
  if (skipped > 0) result.warnings.push({ key: "vault.import.skippedUnnamed", params: { n: skipped } });
  if (withAttachments > 0) {
    result.warnings.push({ key: "vault.import.attachmentsSkipped", params: { n: withAttachments } });
  }
  return result;
}
