import catalogJson from "./driverCatalog.json";
import { currentPlatform, type Platform } from "../platform";
import {
  defaultConnectionConfig,
  engineInfo,
  type DbConnectionConfig,
  type DbConnectionRow,
  type DbDriverSettings,
  type DbEngineInfo,
  type DbKind,
  type DbSslMode,
  type DbUrlTemplate,
} from "../../types/database";

/**
 * The driver catalogue, as the frontend reads it.
 *
 * The same JSON the backend compiles in (`datasource/catalog.rs`), so the form can never offer a
 * driver the backend has not heard of, or draw a port it dials differently. What lives here is what
 * only the form needs: grouping and search for the Drivers list, the fields a driver's URL template
 * asks for, the URL preview, and reading the backend's "the files aren't here" errors.
 *
 * A driver is either **native** — one of the Rust sessions compiled into the app (`engine` is that
 * session's `DbKind`), nothing to download, several entries per session (CockroachDB is
 * `postgres`) — or a **JVM** driver: jars fetched on first use and run by the Java bridge. Of
 * those, Oracle and IRIS keep dedicated sessions; everything else is `jdbc`, browsed through the
 * driver's own metadata.
 */

export type DriverSupport = "complete" | "basic";

export type DriverPaging = "limit-offset" | "offset-fetch" | "fetch-first" | "limit" | "top" | "none";

export interface DriverFileDef {
  /** `group:artifact:version`, for a Maven artefact. */
  maven?: string;
  repo?: string;
  /** A direct download, for a vendor that publishes outside Maven. */
  url?: string;
  name: string;
  size: number;
  sha1?: string;
  sha256?: string;
}

export interface DriverDef {
  id: string;
  name: string;
  support: DriverSupport;
  /** The session that serves it. */
  engine: DbKind;
  /** The brand hue its glyph and dot are drawn in. */
  color: string;
  /** Two letters for its tile, where it has no glyph of its own. Not a logo: see `DriverGlyph`. */
  mark: string;
  /** 0 when the driver has none (a file, a cloud endpoint). */
  defaultPort: number;
  defaultUser?: string;
  defaultDatabase?: string;
  defaultSsl?: DbSslMode;
  /** Other names it is searched by. */
  aliases: string[];
  homepage?: string;
  /** Where the driver's licence is, for the ones whose terms the user accepts by downloading. */
  license?: string;
  class?: string;
  files?: DriverFileDef[];
  urls?: DbUrlTemplate[];
  /** Connection properties, templated like a URL. */
  properties?: Record<string, string>;
  /** What a template field is called on the form, when its name would read as code. */
  labels?: Record<string, string>;
  sql?: { dialect: string; paging: DriverPaging; explain?: string };
  /** The database is a file on this machine. */
  file?: boolean;
  /** `false` for a driver addressed by something other than a host (an account, a region). */
  host?: boolean;
  /** The platforms it works on, when not all of them. */
  platforms?: Platform[];
  /** A vendor page to get the files from by hand, for drivers nobody may redistribute. */
  manual?: string;
  /** A driver the user added rather than one from the catalogue. */
  custom?: boolean;
}

const CATALOG = catalogJson as unknown as {
  runtime: { java: number };
  drivers: DriverDef[];
};

/** Every catalogue driver, in catalogue order. */
export const DRIVER_CATALOG: readonly DriverDef[] = CATALOG.drivers;

/** The Java feature release the downloaded runtime is. */
export const JAVA_RELEASE = CATALOG.runtime.java;

const BY_ID = new Map(DRIVER_CATALOG.map((driver) => [driver.id, driver]));

export function catalogDriver(id: string): DriverDef | null {
  return BY_ID.get(id) ?? null;
}

/** The catalogue entry a connection made before drivers existed stands for. Mirrors Rust's
 *  `default_driver_id`. */
export function defaultDriverId(kind: DbKind): string {
  switch (kind) {
    case "postgres":
      return "postgresql";
    case "jdbc":
      return "";
    default:
      return kind;
  }
}

/** The driver a connection uses: the one it names, or its engine's own. */
export function connectionDriverId(config: Pick<DbConnectionConfig, "kind" | "driver_id">): string {
  return config.driver_id || defaultDriverId(config.kind);
}

/** The driver a saved row was made with, read from its spec without parsing the rest of it. */
export function rowDriverId(row: Pick<DbConnectionRow, "kind" | "spec">): string {
  try {
    const spec = JSON.parse(row.spec) as Partial<DbConnectionConfig>;
    if (typeof spec.driver_id === "string" && spec.driver_id) return spec.driver_id;
  } catch {
    // A spec that doesn't parse is reported where it is used; here it is just "the default".
  }
  return defaultDriverId(row.kind);
}

/** Two letters for a name: the initials of two words, or the first two letters of one. */
function monogramOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? "?";
  return word.charAt(0).toUpperCase() + word.slice(1, 2).toLowerCase();
}

/** A driver the user added, as the rest of the app reads a driver. */
export function customDriverDef(settings: DbDriverSettings): DriverDef {
  const base = catalogDriver(settings.basedOn);
  return {
    id: settings.id,
    name: settings.name.trim() || settings.id,
    support: "basic",
    engine: "jdbc",
    color: base?.color ?? "#64748b",
    mark: monogramOf(settings.name.trim() || "Custom"),
    defaultPort: 0,
    aliases: [],
    class: settings.class,
    files: [],
    urls: settings.urls,
    properties: {},
    sql: base?.sql,
    custom: true,
  };
}

/**
 * A driver with the user's changes applied — their URL templates before the catalogue's, as the
 * backend's `resolve` orders them — or `null` for an id that is neither in the catalogue nor added.
 */
export function effectiveDriver(id: string, settings: readonly DbDriverSettings[]): DriverDef | null {
  const own = settings.find((entry) => entry.id === id);
  if (own?.custom) return customDriverDef(own);
  const def = catalogDriver(id);
  if (!def) return null;
  if (!own || own.urls.length === 0) return def;
  return { ...def, urls: [...own.urls, ...(def.urls ?? [])] };
}

/** Whether the driver runs in the Java bridge — and so has files, and a runtime, to download. */
export function isJvmDriver(def: Pick<DriverDef, "engine">): boolean {
  return def.engine === "jdbc" || def.engine === "oracle" || def.engine === "iris";
}

/** Whether the driver works on the platform this app is running on. */
export function availableHere(def: Pick<DriverDef, "platforms">, platform = currentPlatform()): boolean {
  return !def.platforms?.length || platform === "unknown" || def.platforms.includes(platform);
}

/** The total size of the driver's catalogue files. */
export function driverDownloadSize(def: DriverDef): number {
  return (def.files ?? []).reduce((sum, file) => sum + file.size, 0);
}

/** The version a person reads beside a driver file: the artefact's, or the file's own name. */
export function driverFileVersion(file: DriverFileDef): string {
  return file.maven?.split(":")[2] ?? file.name;
}

/** The driver's version as the Drivers list shows it — its first file's. */
export function driverVersion(def: DriverDef): string | null {
  const first = def.files?.[0];
  return first ? driverFileVersion(first) : null;
}

/**
 * The engine metadata a connection's form and tabs read, dressed for its driver: the driver's name
 * rather than the session's, its default port, its word for "database".
 */
export function driverEngineInfo(def: DriverDef | null, kind: DbKind): DbEngineInfo {
  const base = engineInfo(def?.engine ?? kind);
  if (!def) return base;
  return {
    ...base,
    label: def.name,
    defaultPort: def.defaultPort || base.defaultPort,
    defaultUser: def.defaultUser ?? base.defaultUser,
    defaultSsl: def.defaultSsl ?? base.defaultSsl,
    databaseLabel: def.labels?.database ?? base.databaseLabel,
    urlPlaceholder: def.engine === "jdbc" ? def.urls?.[0]?.template ?? base.urlPlaceholder : base.urlPlaceholder,
    file: def.engine === "jdbc" ? Boolean(def.file) : base.file,
  };
}

/** `driverEngineInfo` for a saved row. Custom drivers need their settings — see `useDriverStore`. */
export function rowEngineInfo(
  row: Pick<DbConnectionRow, "kind" | "spec">,
  settings: readonly DbDriverSettings[] = [],
): DbEngineInfo {
  return driverEngineInfo(effectiveDriver(rowDriverId(row), settings), row.kind);
}

/** A blank connection for a driver: its engine's defaults, then the driver's own. */
export function newConnectionConfig(def: DriverDef): DbConnectionConfig {
  const config = defaultConnectionConfig(def.engine);
  config.driver_id = def.id;
  if (def.defaultUser !== undefined) config.user = def.defaultUser;
  if (def.defaultDatabase) config.database = def.defaultDatabase;
  if (def.defaultSsl) config.ssl = def.defaultSsl;
  // No "localhost" for a file or a cloud account — it would name the connection after a host it
  // never talks to.
  if (def.engine === "jdbc" && (def.file || def.host === false)) config.host = "";
  return config;
}

/**
 * `SELECT * FROM target` capped at `rows`, in the paging a driver's engine speaks — what "Select
 * rows" drops into a console, which runs it as written.
 */
export function limitedSelect(target: string, paging: DriverPaging | undefined, rows: number): string {
  switch (paging) {
    case "top":
      return `SELECT TOP ${rows} * FROM ${target}`;
    case "offset-fetch":
    case "fetch-first":
      return `SELECT * FROM ${target} FETCH FIRST ${rows} ROWS ONLY`;
    // No clause the engine accepts: the console's row cap is what bounds it.
    case "none":
      return `SELECT * FROM ${target}`;
    default:
      return `SELECT * FROM ${target} LIMIT ${rows}`;
  }
}

// ---------------------------------------------------------------------------
// URL templates — mirror `catalog::render_template`
// ---------------------------------------------------------------------------

/**
 * Renders a URL template the way the backend does: `{name}` is a field's value, `{name::default}`
 * falls back to the default when the field is empty, and `[ … ]` is kept only when every field
 * inside it has a value of its own. Groups nest; anything else is literal.
 */
export function renderTemplate(template: string, value: (name: string) => string): string {
  const cursor = { at: 0 };
  return renderPart(template, cursor, value, false).text;
}

function renderPart(
  template: string,
  cursor: { at: number },
  value: (name: string) => string,
  inGroup: boolean,
): { text: string; complete: boolean } {
  let text = "";
  let complete = true;
  while (cursor.at < template.length) {
    const c = template[cursor.at];
    if (c === "{") {
      const close = template.indexOf("}", cursor.at);
      if (close === -1) {
        text += c;
        cursor.at += 1;
        continue;
      }
      const inside = template.slice(cursor.at + 1, close);
      const split = inside.indexOf("::");
      const name = (split === -1 ? inside : inside.slice(0, split)).trim();
      const fallback = split === -1 ? "" : inside.slice(split + 2);
      const given = value(name);
      if (given === "") {
        complete = false;
        text += fallback;
      } else {
        text += given;
      }
      cursor.at = close + 1;
    } else if (c === "[") {
      cursor.at += 1;
      const inner = renderPart(template, cursor, value, true);
      if (inner.complete) text += inner.text;
    } else if (c === "]" && inGroup) {
      cursor.at += 1;
      return { text, complete };
    } else {
      text += c;
      cursor.at += 1;
    }
  }
  return { text, complete };
}

export interface TemplateField {
  name: string;
  /** What stands in when the field is left empty. */
  fallback?: string;
  /** Inside an optional part: leaving it empty drops that part rather than leaving a hole. */
  optional: boolean;
}

/** The fields a template asks for, in the order it asks, each once. */
export function templateFields(template: string): TemplateField[] {
  const fields: TemplateField[] = [];
  let depth = 0;
  for (let at = 0; at < template.length; at += 1) {
    const c = template[at];
    if (c === "[") {
      depth += 1;
    } else if (c === "]" && depth > 0) {
      depth -= 1;
    } else if (c === "{") {
      const close = template.indexOf("}", at);
      if (close === -1) break;
      const inside = template.slice(at + 1, close);
      const split = inside.indexOf("::");
      const name = (split === -1 ? inside : inside.slice(0, split)).trim();
      const fallback = split === -1 ? undefined : inside.slice(split + 2);
      if (name && !fields.some((field) => field.name === name)) {
        fields.push({ name, fallback, optional: depth > 0 });
      }
      at = close;
    }
  }
  return fields;
}

/** The fields the connection form has boxes of its own for. Everything else is `url_values`. */
const STANDARD_FIELDS = new Set(["host", "port", "database", "file", "user", "password"]);

export interface DriverForm {
  /** The template the form is filling in, or `null` when the driver has none. */
  template: DbUrlTemplate | null;
  host: TemplateField | null;
  port: TemplateField | null;
  database: TemplateField | null;
  file: TemplateField | null;
  /** Whether the user and password boxes mean anything for this driver. */
  credentials: boolean;
  /** Fields of the driver's own — an account, a region, a catalog — with the label to show. */
  extra: (TemplateField & { label: string })[];
}

/** `camelCase` and `snake_case` field names as words: `httpPath` → "Http path". */
function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The label a template field goes by on the form. */
export function fieldLabel(def: DriverDef, name: string): string {
  return def.labels?.[name] ?? humanize(name);
}

/** The URL template a connection uses: the one it names, or the driver's first. */
export function chosenTemplate(def: DriverDef, name: string): DbUrlTemplate | null {
  const urls = def.urls ?? [];
  return urls.find((url) => name !== "" && url.name === name) ?? urls[0] ?? null;
}

/**
 * What the connection form asks for, for a JDBC driver and one of its URL templates: the fields the
 * template uses and the ones its connection properties use, the standard ones mapped to the form's
 * own boxes.
 */
export function driverForm(def: DriverDef, templateName: string): DriverForm {
  const template = chosenTemplate(def, templateName);
  const fields = template ? templateFields(template.template) : [];
  for (const property of Object.values(def.properties ?? {})) {
    for (const field of templateFields(property)) {
      // From a property, a field is never needed to make the URL whole — an empty one is left out.
      if (!fields.some((known) => known.name === field.name)) fields.push({ ...field, optional: true });
    }
  }
  const find = (name: string) => fields.find((field) => field.name === name) ?? null;
  const usesCredentials = fields.some((field) => field.name === "user" || field.name === "password");
  return {
    template,
    host: find("host"),
    port: find("port"),
    database: find("database"),
    file: find("file"),
    // The bridge hands `user` and `password` to every driver, so the boxes are there unless the
    // driver is a local file with no notion of a login (DuckDB, an embedded Derby).
    credentials: usesCredentials || !(def.file && !def.defaultUser) || !template,
    extra: fields
      .filter((field) => !STANDARD_FIELDS.has(field.name))
      .map((field) => ({ ...field, label: fieldLabel(def, field.name) })),
  };
}

/** The value one template field has on a connection. Mirrors the backend's `field_value`. */
export function fieldValue(config: DbConnectionConfig, def: DriverDef, name: string): string {
  switch (name) {
    case "host":
      return config.host.trim();
    case "port": {
      const port = config.port || def.defaultPort;
      return port ? String(port) : "";
    }
    case "database":
    case "file":
      return config.database.trim();
    case "user":
      return config.user;
    case "password":
      return config.password;
    default:
      return config.url_values.find(([key]) => key === name)?.[1].trim() ?? "";
  }
}

/** A connection's `url_values` with one field set — or removed, when emptied. */
export function withUrlValue(values: [string, string][], name: string, value: string): [string, string][] {
  const rest = values.filter(([key]) => key !== name);
  return value === "" ? rest : [...rest, [name, value]];
}

/**
 * The JDBC URL a connection will open, as the backend builds it — the pasted one when there is one,
 * the rendered template otherwise. Passwords are masked: this is for showing.
 */
export function jdbcUrlPreview(config: DbConnectionConfig, def: DriverDef): string | null {
  if (config.url.trim()) return config.url.trim();
  const template = chosenTemplate(def, config.url_template);
  if (!template) return null;
  return renderTemplate(template.template, (name) =>
    name === "password" ? (config.password ? "••••" : "") : fieldValue(config, def, name),
  );
}

// ---------------------------------------------------------------------------
// "The files aren't here"
// ---------------------------------------------------------------------------

/** Mirrors `drivers::MISSING` and `drivers::MANUAL`. */
const MISSING = "driver-files-missing:";
const MANUAL = "driver-files-manual:";

export interface DriverFilesError {
  /** `missing`: a download fixes it. `manual`: the files have to be added by hand. */
  kind: "missing" | "manual";
  driverId: string;
  /** The sentence, without the marker. */
  message: string;
}

/**
 * Reads the backend's "this driver's files aren't on disk" error, wherever in a message it ended up
 * — a connect can wrap it in a sentence of its own.
 */
export function driverFilesError(error: unknown): DriverFilesError | null {
  const text = String(error);
  for (const [marker, kind] of [
    [MISSING, "missing"],
    [MANUAL, "manual"],
  ] as const) {
    const at = text.indexOf(marker);
    if (at === -1) continue;
    const rest = text.slice(at + marker.length);
    const newline = rest.indexOf("\n");
    const driverId = (newline === -1 ? rest : rest.slice(0, newline)).trim();
    const message = newline === -1 ? "" : rest.slice(newline + 1).trim();
    return { kind, driverId, message: message || text.slice(0, at).trim() };
  }
  return null;
}

/** An error as a person should read it: the driver marker taken out, when there is one. */
export function driverErrorText(error: unknown): string {
  return driverFilesError(error)?.message ?? String(error);
}

// ---------------------------------------------------------------------------
// The Drivers list
// ---------------------------------------------------------------------------

/** How well a driver is matched by what was typed: lower is better, `null` is no match. */
function matchRank(def: DriverDef, needle: string): number | null {
  const name = def.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.split(/[\s()/–-]+/).some((word) => word.startsWith(needle))) return 1;
  if (def.aliases.some((alias) => alias.toLowerCase().startsWith(needle))) return 2;
  if (def.id.includes(needle)) return 3;
  if (name.includes(needle)) return 4;
  return null;
}

/** The drivers matching a search, best first; all of them, in order, for an empty one. */
export function searchDrivers(drivers: readonly DriverDef[], query: string): DriverDef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...drivers];
  return drivers
    .map((def, index) => ({ def, index, rank: matchRank(def, needle) }))
    .filter((entry): entry is { def: DriverDef; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.def);
}

export type DriverGroup = "complete" | "basic" | "user";

/** Which heading a driver sits under in the list. */
export function driverGroup(def: DriverDef): DriverGroup {
  return def.custom ? "user" : def.support;
}

/** The drivers under each heading, alphabetically — the order a list of sixty is searched by eye. */
export function groupDrivers(drivers: readonly DriverDef[]): { group: DriverGroup; drivers: DriverDef[] }[] {
  const order: DriverGroup[] = ["complete", "basic", "user"];
  return order
    .map((group) => ({
      group,
      drivers: drivers
        .filter((def) => driverGroup(def) === group)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((entry) => entry.drivers.length > 0);
}

/** `12.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
