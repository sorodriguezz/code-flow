import { translate, useLanguageStore } from "../../state/languageStore";
import type { TranslationKey } from "../i18n/translations";
import type {
  ApiCollection,
  ApiFolder,
  ApiProtocol,
  ApiRequestRow,
  AuthConfig,
  AuthType,
  KeyValue,
  RawLanguage,
  RequestBody,
  SavedExample,
} from "../../types/api";
import {
  childrenOf,
  folderTag,
  guessServer,
  readAuthJson,
  readSpec,
  readVariables,
  redact,
  splitUrl,
} from "./exporters";

/**
 * The reading model behind "Generate documentation".
 *
 * The other exporters write for a machine; this one writes for a person, and the person on the far
 * end is routinely not the one who built the collection. So the model is built from the *native*
 * rows rather than from `exportOpenApi`'s output: the OpenAPI writer flattens folders into tags,
 * drops every socket protocol and keeps one operation per path+verb, and each of those losses is a
 * hole in a document whose whole promise is "this is the complete list".
 *
 * `docsMarkdown.ts`, `docsHtml.ts` and `docsPdf.ts` all render *this* — three presentations of one
 * document, never three readings of the collection. That is what keeps the PDF you email and the
 * Markdown you commit from disagreeing about what the API contains.
 *
 * Two rules the renderers inherit and must not undo:
 *
 * - **No credential ever reaches the page.** An auth config is described by its *type* only
 *   ("Bearer token"), never by its values. A document like this is made to be forwarded, and a
 *   client secret in a PDF attachment is a leak nobody notices. Secret *variables* follow the
 *   exporters' existing opt-in instead, since their whole point may be to name what must be set.
 * - **Descriptions are plain text.** They pass through verbatim into Markdown, where whatever the
 *   author wrote renders on its own, and are escaped everywhere else. Rendering Markdown in the
 *   HTML but not in the PDF would make the two formats disagree, and pdfmake has no way to catch up.
 */

/** Bodies and saved responses are quoted, not archived — past this a payload is noise in a document. */
const MAX_BLOCK = 8000;

export interface DocOptions {
  /** Same opt-in the other exporters use, and only ever applied to collection variables. */
  includeSecrets: boolean;
  /** Saved responses are the bulkiest part of the document and the first thing to drop. */
  includeExamples: boolean;
}

export interface DocParam {
  name: string;
  value: string;
  description: string;
  required: boolean;
}

/** A quoted payload: a request body, one part of a GraphQL body, or a saved response. */
export interface DocBlock {
  /** "" when the block is the whole thing; names the part when a body has more than one. */
  caption: string;
  /** `json` / `xml` / `graphql` / `text` — a hint for fences and syntax colour, not a guarantee. */
  language: string;
  text: string;
  /** The payload was longer than `MAX_BLOCK` and the tail was dropped. */
  truncated: boolean;
}

export interface DocBody {
  /** Already translated: "JSON", "Form data", "GraphQL"… */
  label: string;
  blocks: DocBlock[];
  /** The rows of a form body, which read as parameters rather than as a payload. */
  fields: DocParam[];
}

export interface DocExample {
  name: string;
  status: number;
  statusText: string;
  block: DocBlock | null;
}

export interface DocEntry {
  id: string;
  name: string;
  /** The HTTP verb, or the protocol's own name where a verb would be meaningless. */
  method: string;
  protocol: ApiProtocol;
  /** The URL exactly as authored, variables and all. */
  url: string;
  /** The path alone — server prefix and query string removed — for the summary table. */
  path: string;
  /** "Auth / Tokens"; "" for a request sitting directly under the collection. */
  folderPath: string;
  description: string;
  /** The auth *type*, already translated. Never a credential. */
  auth: string;
  pathVars: DocParam[];
  query: DocParam[];
  headers: DocParam[];
  body: DocBody | null;
  examples: DocExample[];
}

export interface DocSection {
  id: string;
  /** The folder's full path; "" for the requests sitting at the collection root. */
  title: string;
  description: string;
  /** 0 at the root, 1 for a top-level folder — drives heading level and PDF indentation. */
  depth: number;
  entries: DocEntry[];
}

export interface DocVariable {
  key: string;
  value: string;
  description: string;
  /** The value was withheld because the variable is secret and secrets were not opted in. */
  withheld: boolean;
}

export interface DocDocument {
  /** BCP-47 tag for the language the labels came out in — the HTML's `lang` attribute. */
  lang: string;
  title: string;
  description: string;
  /** The collection's server, when every request agrees on one; "" otherwise. */
  baseUrl: string;
  /** The collection-level auth type, already translated. */
  auth: string;
  generatedAt: string;
  variables: DocVariable[];
  sections: DocSection[];
  /** Every entry in document order. The summary table renders from this. */
  entries: DocEntry[];
  counts: { requests: number; folders: number; undocumented: number };
  labels: DocLabels;
}

/**
 * Every heading the renderers need, translated once here.
 *
 * The renderers are then free of i18n entirely, which matters because two of them produce a file
 * that outlives the session: a document generated in Spanish has to *stay* Spanish, and a renderer
 * that called `translate` at render time would be reading a store that the reader of the PDF has
 * no relationship with.
 */
export interface DocLabels {
  overview: string;
  summary: string;
  contents: string;
  baseUrl: string;
  auth: string;
  variables: string;
  variable: string;
  name: string;
  method: string;
  path: string;
  description: string;
  folder: string;
  parameter: string;
  value: string;
  required: string;
  yes: string;
  no: string;
  pathParams: string;
  queryParams: string;
  headers: string;
  body: string;
  examples: string;
  status: string;
  fullUrl: string;
  noDescription: string;
  none: string;
  root: string;
  truncated: string;
  withheld: string;
  generatedAt: string;
  generatedBy: string;
  requests: string;
  folders: string;
  undocumented: string;
  page: string;
  of: string;
  filterPlaceholder: string;
}

function labels(): DocLabels {
  const t = (key: TranslationKey) => translate(key);
  return {
    overview: t("api.docs.overview"),
    summary: t("api.docs.summary"),
    contents: t("api.docs.contents"),
    baseUrl: t("api.docs.baseUrl"),
    auth: t("api.docs.auth"),
    variables: t("api.docs.variables"),
    variable: t("api.docs.variable"),
    name: t("api.docs.name"),
    method: t("api.docs.method"),
    path: t("api.docs.path"),
    description: t("api.docs.description"),
    folder: t("api.docs.folder"),
    parameter: t("api.docs.parameter"),
    value: t("api.docs.value"),
    required: t("api.docs.required"),
    yes: t("api.docs.yes"),
    no: t("api.docs.no"),
    pathParams: t("api.docs.pathParams"),
    queryParams: t("api.docs.queryParams"),
    headers: t("api.docs.headers"),
    body: t("api.docs.body"),
    examples: t("api.docs.examples"),
    status: t("api.docs.status"),
    fullUrl: t("api.docs.fullUrl"),
    noDescription: t("api.docs.noDescription"),
    none: t("api.docs.none"),
    root: t("api.docs.root"),
    truncated: t("api.docs.truncated"),
    withheld: t("api.docs.withheld"),
    generatedAt: t("api.docs.generatedAt"),
    generatedBy: t("api.docs.generatedBy"),
    requests: t("api.docs.requests"),
    folders: t("api.docs.folders"),
    undocumented: t("api.docs.undocumented"),
    page: t("api.docs.page"),
    of: t("api.docs.of"),
    filterPlaceholder: t("api.docs.filterPlaceholder"),
  };
}

// ---------------------------------------------------------------------------
// Human labels for machine enums
// ---------------------------------------------------------------------------

const AUTH_LABELS: Record<AuthType, TranslationKey> = {
  inherit: "api.docs.authType.inherit",
  none: "api.docs.authType.none",
  basic: "api.docs.authType.basic",
  bearer: "api.docs.authType.bearer",
  apikey: "api.docs.authType.apikey",
  digest: "api.docs.authType.digest",
  oauth2: "api.docs.authType.oauth2",
  jwt: "api.docs.authType.jwt",
  awsv4: "api.docs.authType.awsv4",
};

/**
 * The auth type in words. Note what is *not* here: the values.
 *
 * `AuthConfig` carries passwords, client secrets and live access tokens, and this string is bound
 * for a file the user will attach to an email. The type is the whole documentable fact — a reader
 * needs to know they must present a bearer token, not which one the author happened to have.
 */
function authLabel(auth: AuthConfig | null, topLevel: boolean): string {
  // "Inherit" at the collection root has nothing above it to inherit from, so it means "none".
  if (!auth || (auth.type === "inherit" && topLevel)) return translate("api.docs.authType.none");
  return translate(AUTH_LABELS[auth.type] ?? "api.docs.authType.none");
}

/** Protocol names are product names — they read the same in every language, so they aren't keys. */
const PROTOCOL_NAMES: Record<Exclude<ApiProtocol, "http">, string> = {
  graphql: "GraphQL",
  websocket: "WebSocket",
  socketio: "Socket.IO",
  grpc: "gRPC",
  mqtt: "MQTT",
};

/**
 * What goes in the document's verb column.
 *
 * Deliberately not the tree's `badgeShort`: that abbreviates to fit a 30px column ("WS", "IO"), and
 * a document has the width to spell it out for a reader who has never seen the app.
 */
function methodLabel(protocol: ApiProtocol, method: string): string {
  if (protocol !== "http") return PROTOCOL_NAMES[protocol];
  return (method.trim() || "GET").toUpperCase();
}

const RAW_LABELS: Record<RawLanguage, string> = {
  json: "JSON",
  xml: "XML",
  text: "Text",
  javascript: "JavaScript",
  html: "HTML",
};

// ---------------------------------------------------------------------------
// Payload quoting
// ---------------------------------------------------------------------------

/** Pretty-prints JSON so a minified body doesn't reach the page as one unreadable line. */
function prettyIfJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function block(text: string, language: string, caption = ""): DocBlock | null {
  if (!text.trim()) return null;
  const full = language === "json" ? prettyIfJson(text) : text;
  const truncated = full.length > MAX_BLOCK;
  return { caption, language, text: truncated ? full.slice(0, MAX_BLOCK) : full, truncated };
}

/** The language of a saved response: what the server said it was, else what the body looks like. */
function exampleLanguage(example: SavedExample): string {
  const contentType =
    example.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
  if (contentType.includes("json")) return "json";
  if (contentType.includes("xml")) return "xml";
  if (contentType.includes("html")) return "html";
  if (contentType) return "text";
  const trimmed = example.body.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "text";
}

// ---------------------------------------------------------------------------
// Building the entries
// ---------------------------------------------------------------------------

/**
 * `required` is inferred, because the request model has no such flag.
 *
 * What it does have is `enabled`, the checkbox that decides whether a row is sent — and in practice
 * that is exactly how the toggle gets used: the parameters a call needs stay ticked, the optional
 * ones people leave unticked next to them as a reminder that they exist. Reading it as "required"
 * is therefore the honest summary of the author's intent, and it beats dropping the unticked rows,
 * which would quietly shorten the "complete list".
 */
function toParams(rows: KeyValue[], alwaysRequired: boolean): DocParam[] {
  return rows
    .filter((row) => row.key.trim())
    .map((row) => ({
      name: row.key,
      value: row.type === "file" ? row.src || "" : row.value,
      description: row.description.trim(),
      required: alwaysRequired || row.enabled,
    }));
}

/** The params table plus anything typed straight into the URL that the table doesn't already list. */
function queryParams(url: string, rows: KeyValue[]): DocParam[] {
  const params = toParams(rows, false);
  const known = new Set(params.map((p) => p.name));
  for (const inline of splitUrl(url).inlineParams) {
    if (!inline.key || known.has(inline.key)) continue;
    known.add(inline.key);
    params.push({ name: inline.key, value: inline.value, description: "", required: true });
  }
  return params;
}

function buildBody(body: RequestBody): DocBody | null {
  switch (body.mode) {
    case "none":
      return null;
    case "raw": {
      const quoted = block(body.raw, body.rawLanguage);
      return quoted ? { label: RAW_LABELS[body.rawLanguage], blocks: [quoted], fields: [] } : null;
    }
    case "formdata": {
      const fields = toParams(body.formdata, false);
      return fields.length
        ? { label: translate("api.docs.body.formdata"), blocks: [], fields }
        : null;
    }
    case "urlencoded": {
      const fields = toParams(body.urlencoded, false);
      return fields.length
        ? { label: translate("api.docs.body.urlencoded"), blocks: [], fields }
        : null;
    }
    case "binary":
      return body.binaryPath
        ? {
            label: translate("api.docs.body.binary"),
            blocks: [{ caption: "", language: "text", text: body.binaryPath, truncated: false }],
            fields: [],
          }
        : null;
    case "graphql": {
      const blocks: DocBlock[] = [];
      const query = block(body.graphql.query, "graphql");
      if (query) blocks.push(query);
      // `{}` is the default the editor ships with; quoting it would be noise on every GraphQL call.
      if (body.graphql.variables.trim() && body.graphql.variables.trim() !== "{}") {
        const vars = block(body.graphql.variables, "json", translate("api.docs.body.graphqlVars"));
        if (vars) blocks.push(vars);
      }
      return blocks.length ? { label: "GraphQL", blocks, fields: [] } : null;
    }
    default:
      return null;
  }
}

interface BuildContext {
  folders: ApiFolder[];
  requests: ApiRequestRow[];
  serverPrefix: string;
  options: DocOptions;
}

function buildEntry(row: ApiRequestRow, ctx: BuildContext): DocEntry {
  const view = readSpec(row);
  let path = splitUrl(view.url).base;
  if (ctx.serverPrefix && path.startsWith(ctx.serverPrefix)) {
    path = path.slice(ctx.serverPrefix.length);
  }
  return {
    id: row.id,
    name: row.name.trim() || view.url || translate("api.docs.untitled"),
    method: methodLabel(view.protocol, view.method),
    protocol: view.protocol,
    url: view.url,
    path: path || "/",
    folderPath: folderTag(row.folder_id, ctx.folders),
    description: view.description.trim(),
    auth: authLabel(view.auth, false),
    pathVars: toParams(view.pathVars, true),
    query: queryParams(view.url, view.params),
    headers: toParams(view.headers, false),
    body: buildBody(view.body),
    examples: ctx.options.includeExamples
      ? view.examples.map((example) => ({
          name: example.name.trim() || translate("api.docs.untitledExample"),
          status: example.status,
          statusText: example.statusText,
          block: block(example.body, exampleLanguage(example)),
        }))
      : [],
  };
}

/**
 * Depth-first, one section per folder, each holding only the requests directly inside it.
 *
 * A level's own requests are emitted before its subfolders' sections even when `sort_order`
 * interleaves the two in the tree. That is the difference between a tree and a document: a reader
 * scrolling a heading expects everything under it to belong to it, and a request that appeared
 * after a subsection would read as part of that subsection.
 */
function collectSections(
  collectionId: string,
  folder: ApiFolder | null,
  depth: number,
  ctx: BuildContext,
  out: DocSection[],
): void {
  const nodes = childrenOf(collectionId, folder?.id ?? null, ctx.folders, ctx.requests);
  const entries = nodes
    .filter((node) => node.kind === "request")
    .map((node) => buildEntry((node as { request: ApiRequestRow }).request, ctx));

  const description = folder?.description.trim() ?? "";
  // An empty folder that says nothing about itself is scaffolding, not a chapter.
  if (entries.length || description) {
    out.push({
      id: folder?.id ?? "root",
      title: folder ? folderTag(folder.id, ctx.folders) : "",
      description,
      depth,
      entries,
    });
  }

  for (const node of nodes) {
    if (node.kind === "folder") {
      collectSections(collectionId, node.folder, depth + 1, ctx, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildDocDocument(
  collection: ApiCollection,
  allFolders: ApiFolder[],
  allRequests: ApiRequestRow[],
  options: DocOptions,
): DocDocument {
  const folders = allFolders.filter((f) => f.collection_id === collection.id);
  const requests = allRequests.filter((r) => r.collection_id === collection.id);
  const variables = redact(readVariables(collection.variables) ?? [], options.includeSecrets);
  const server = guessServer(
    variables,
    requests.map((row) => readSpec(row).url),
  );

  const ctx: BuildContext = { folders, requests, serverPrefix: server.prefix, options };
  const sections: DocSection[] = [];
  collectSections(collection.id, null, 0, ctx, sections);
  const entries = sections.flatMap((section) => section.entries);

  /**
   * The root section is named here, not in the renderers, and only when it has company.
   *
   * Requests sitting directly under the collection have no folder to be titled after, and the two
   * readings of that are both right in different collections: with folders alongside them they are
   * "the ungrouped ones" and need a heading to stop them reading as part of whatever came before;
   * without any folders at all they are simply *the* endpoints, and a "Ungrouped" heading over the
   * entire document is noise. Deciding it once, here, is what keeps the three renderers from each
   * inventing their own fallback — and then disagreeing about it.
   */
  const root = sections.find((section) => section.id === "root");
  if (root && sections.length > 1) root.title = translate("api.docs.root");

  const language = useLanguageStore.getState().language;
  return {
    lang: language,
    title: collection.name.trim() || translate("api.docs.untitledCollection"),
    description: collection.description.trim(),
    baseUrl: server.url,
    auth: authLabel(readAuthJson(collection.auth), true),
    generatedAt: new Date().toLocaleString(language === "es" ? "es-ES" : "en-US", {
      dateStyle: "long",
      timeStyle: "short",
    }),
    variables: variables
      .filter((v) => v.enabled && v.key.trim())
      .map((v) => ({
        key: v.key,
        value: v.initialValue || v.currentValue,
        description: v.description.trim(),
        withheld: v.secret && !options.includeSecrets,
      })),
    sections,
    entries,
    counts: {
      requests: entries.length,
      folders: folders.length,
      undocumented: entries.filter((entry) => !entry.description).length,
    },
    labels: labels(),
  };
}

/**
 * A filename stem safe on every platform, so the save dialog opens on something sensible.
 *
 * Decomposes first and then drops the combining marks, which turns "Colección" into "Coleccion"
 * rather than "Colecci-n" — a collection named in Spanish should not come out of here punctuated
 * by the places its accents used to be. The escapes are spelled out because the range is invisible
 * characters: written literally, the regex reads as an empty character class.
 */
export function docFileStem(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "api-docs";
}
