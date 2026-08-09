import {
  defaultAuth,
  defaultBody,
  type ApiCollection,
  type ApiEnvironment,
  type ApiFolder,
  type ApiProtocol,
  type ApiRequestRow,
  type ApiVariable,
  type AuthConfig,
  type AuthType,
  type BodyMode,
  type KeyValue,
  type RawLanguage,
  type RequestBody,
  type SavedExample,
} from "../../types/api";

/**
 * Writers for the export side of the API client.
 *
 * Postman v2.1 and OpenAPI 3.1 are interchange formats and therefore lossy by construction —
 * neither can express a gRPC call, an MQTT subscription or a saved WebSocket draft.
 * `exportNativeCollection` is the one that round-trips, because it ships the raw DB rows
 * untouched and the importer rebuilds them verbatim.
 *
 * `includeSecrets` is false at every call site by default: an exported collection routinely ends
 * up committed to a repo, so a variable flagged `secret` leaves with an empty value unless the
 * user explicitly opts in. Every exporter below applies that rule, the native one included.
 *
 * The readers in "Reading back what the DB stored" and the tree walkers below are exported for
 * `docs.ts`, which is an exporter too — it just writes for a human rather than for another tool.
 * They are the only supported way to turn a stored `spec` blob back into typed values; parsing
 * that JSON anywhere else would fork the tolerance rules these apply to older or partial blobs.
 */

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface ExportOptions {
  includeSecrets: boolean;
}

/** The native envelope. `importers.ts` reads this back; keep the two in step. */
export interface NativeExport {
  format: "codeflow-api";
  version: 1;
  collection: ApiCollection;
  folders: ApiFolder[];
  requests: ApiRequestRow[];
}

const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const AUTH_TYPES: AuthType[] = [
  "inherit",
  "none",
  "basic",
  "bearer",
  "apikey",
  "digest",
  "oauth2",
  "jwt",
  "awsv4",
];
const BODY_MODES: BodyMode[] = ["none", "raw", "formdata", "urlencoded", "binary", "graphql"];
const RAW_LANGUAGES: RawLanguage[] = ["json", "xml", "text", "javascript", "html"];

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseJsonSafe(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function oneOf<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === "string" && (allowed as string[]).includes(v) ? (v as T) : fallback;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Reading back what the DB stored
// ---------------------------------------------------------------------------

/**
 * The slice of `ApiRequestSpec` the interchange exporters can actually express. Protocol-specific
 * settings are deliberately absent: nothing in Postman or OpenAPI holds them, and the native
 * exporter never parses the spec at all, so this narrow view is the whole need.
 */
export interface ExportView {
  protocol: ApiProtocol;
  method: string;
  url: string;
  params: KeyValue[];
  pathVars: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: AuthConfig | null;
  preScript: string;
  postScript: string;
  description: string;
  examples: SavedExample[];
}

function readKeyValues(v: unknown): KeyValue[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((row) => ({
    id: str(row.id) || crypto.randomUUID(),
    key: str(row.key),
    value: str(row.value),
    description: str(row.description),
    enabled: row.enabled !== false,
    type: row.type === "file" ? ("file" as const) : ("text" as const),
    src: str(row.src),
  }));
}

function readBody(v: unknown): RequestBody {
  const base = defaultBody();
  if (!isObj(v)) return base;
  const gql = isObj(v.graphql) ? v.graphql : {};
  return {
    mode: oneOf(v.mode, BODY_MODES, base.mode),
    raw: str(v.raw),
    rawLanguage: oneOf(v.rawLanguage, RAW_LANGUAGES, base.rawLanguage),
    formdata: readKeyValues(v.formdata),
    urlencoded: readKeyValues(v.urlencoded),
    binaryPath: str(v.binaryPath),
    graphql: {
      query: str(gql.query),
      variables: str(gql.variables) || "{}",
      operationName: str(gql.operationName),
    },
  };
}

/** Merges a stored `AuthConfig` onto the defaults so a partial/older blob can't produce holes. */
function readAuth(v: unknown): AuthConfig | null {
  if (!isObj(v) || typeof v.type !== "string") return null;
  const auth = defaultAuth(oneOf(v.type, AUTH_TYPES, "inherit"));
  if (isObj(v.basic)) auth.basic = { username: str(v.basic.username), password: str(v.basic.password) };
  if (isObj(v.bearer)) auth.bearer = { token: str(v.bearer.token) };
  if (isObj(v.apikey)) {
    auth.apikey = {
      key: str(v.apikey.key),
      value: str(v.apikey.value),
      addTo: v.apikey.addTo === "query" ? "query" : "header",
    };
  }
  if (isObj(v.digest)) {
    auth.digest = { username: str(v.digest.username), password: str(v.digest.password) };
  }
  if (isObj(v.jwt)) {
    auth.jwt = {
      ...auth.jwt,
      algorithm: oneOf(
        v.jwt.algorithm,
        ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384"],
        "HS256",
      ),
      secret: str(v.jwt.secret),
      secretBase64: v.jwt.secretBase64 === true,
      headerJson: str(v.jwt.headerJson) || "{}",
      payloadJson: str(v.jwt.payloadJson) || "{}",
      addTo: v.jwt.addTo === "query" ? "query" : "header",
      headerPrefix: str(v.jwt.headerPrefix),
      queryParamName: str(v.jwt.queryParamName),
    };
  }
  if (isObj(v.awsv4)) {
    auth.awsv4 = {
      accessKey: str(v.awsv4.accessKey),
      secretKey: str(v.awsv4.secretKey),
      sessionToken: str(v.awsv4.sessionToken),
      region: str(v.awsv4.region),
      service: str(v.awsv4.service),
    };
  }
  if (isObj(v.oauth2)) {
    const o = v.oauth2;
    auth.oauth2 = {
      ...auth.oauth2,
      grantType: oneOf(
        o.grantType,
        ["authorization_code", "authorization_code_pkce", "client_credentials", "password", "implicit"],
        "client_credentials",
      ),
      authUrl: str(o.authUrl),
      accessTokenUrl: str(o.accessTokenUrl),
      clientId: str(o.clientId),
      clientSecret: str(o.clientSecret),
      scope: str(o.scope),
      state: str(o.state),
      username: str(o.username),
      password: str(o.password),
      redirectUri: str(o.redirectUri),
      audience: str(o.audience),
      resource: str(o.resource),
      clientAuth: o.clientAuth === "body" ? "body" : "header",
      accessToken: str(o.accessToken),
      refreshToken: str(o.refreshToken),
      expiresAt: num(o.expiresAt, 0),
      headerPrefix: str(o.headerPrefix),
      addTo: o.addTo === "query" ? "query" : "header",
    };
  }
  return auth;
}

/** `readAuth` for the collection/folder columns, which hold the config as its own JSON string. */
export function readAuthJson(json: string): AuthConfig | null {
  return readAuth(parseJsonSafe(json));
}

function readExamples(v: unknown): SavedExample[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((e) => ({
    id: str(e.id) || crypto.randomUUID(),
    name: str(e.name),
    status: num(e.status, 200),
    statusText: str(e.statusText),
    headers: readKeyValues(e.headers),
    body: str(e.body),
  }));
}

export function readSpec(row: ApiRequestRow): ExportView {
  const parsed = parseJsonSafe(row.spec);
  const spec = isObj(parsed) ? parsed : {};
  return {
    protocol: row.protocol,
    method: str(spec.method) || row.method || "GET",
    url: str(spec.url) || row.url,
    params: readKeyValues(spec.params),
    pathVars: readKeyValues(spec.pathVars),
    headers: readKeyValues(spec.headers),
    body: readBody(spec.body),
    auth: readAuth(spec.auth),
    preScript: str(spec.preScript),
    postScript: str(spec.postScript),
    description: str(spec.description),
    examples: readExamples(spec.examples),
  };
}

export function readVariables(json: string): ApiVariable[] | null {
  const parsed = parseJsonSafe(json);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isObj).map((v) => ({
    id: str(v.id) || crypto.randomUUID(),
    key: str(v.key),
    initialValue: str(v.initialValue),
    currentValue: str(v.currentValue),
    secret: v.secret === true,
    enabled: v.enabled !== false,
    description: str(v.description),
  }));
}

/**
 * The single choke point for the secret guard. Both values are cleared, not just `initialValue`:
 * `currentValue` is the one a token-refresh script writes to, so it is the likelier leak.
 */
export function redact(vars: ApiVariable[], includeSecrets: boolean): ApiVariable[] {
  if (includeSecrets) return vars;
  return vars.map((v) => (v.secret ? { ...v, initialValue: "", currentValue: "" } : v));
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

export type TreeNode =
  | { kind: "folder"; order: number; folder: ApiFolder }
  | { kind: "request"; order: number; request: ApiRequestRow };

/** Folders and requests share one ordering space under a parent, so they interleave by `sort_order`. */
export function childrenOf(
  collectionId: string,
  parentId: string | null,
  folders: ApiFolder[],
  requests: ApiRequestRow[],
): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const f of folders) {
    if (f.collection_id === collectionId && (f.parent_id ?? null) === parentId) {
      nodes.push({ kind: "folder", order: f.sort_order, folder: f });
    }
  }
  for (const r of requests) {
    if (r.collection_id === collectionId && (r.folder_id ?? null) === parentId) {
      nodes.push({ kind: "request", order: r.sort_order, request: r });
    }
  }
  return nodes.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// URL splitting, shared by the Postman and OpenAPI writers
// ---------------------------------------------------------------------------

export interface SplitUrl {
  base: string;
  fragment: string;
  inlineParams: { key: string; value: string }[];
}

export function splitUrl(raw: string): SplitUrl {
  const hashAt = raw.indexOf("#");
  const fragment = hashAt >= 0 ? raw.slice(hashAt) : "";
  const withoutHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const qAt = withoutHash.indexOf("?");
  if (qAt < 0) return { base: withoutHash, fragment, inlineParams: [] };
  const inlineParams = withoutHash
    .slice(qAt + 1)
    .split("&")
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0
        ? { key: pair, value: "" }
        : { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
  return { base: withoutHash.slice(0, qAt), fragment, inlineParams };
}

interface UrlParts {
  protocol: string;
  host: string[];
  port: string;
  path: string[];
}

function urlParts(base: string): UrlParts {
  let rest = base;
  let protocol = "";
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rest);
  if (scheme) {
    protocol = scheme[1];
    rest = rest.slice(scheme[0].length);
  }
  const slash = rest.indexOf("/");
  let authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const pathText = slash >= 0 ? rest.slice(slash + 1) : "";
  let port = "";
  const portMatch = /:(\d+|\{\{[^}]*\}\})$/.exec(authority);
  if (portMatch) {
    port = portMatch[1];
    authority = authority.slice(0, portMatch.index);
  }
  // `{{base.url}}` would be shredded by a naive split on ".", so a templated authority stays whole.
  const host = authority.includes("{{")
    ? [authority].filter(Boolean)
    : authority.split(".").filter(Boolean);
  return { protocol, host, port, path: pathText ? pathText.split("/") : [] };
}

// ---------------------------------------------------------------------------
// Postman Collection v2.1
// ---------------------------------------------------------------------------

function pmKeyValues(rows: KeyValue[]): Json[] {
  return rows.map((row) => {
    const out: Json = { key: row.key, value: row.value };
    if (row.description) out.description = row.description;
    if (!row.enabled) out.disabled = true;
    return out;
  });
}

function pmFormData(rows: KeyValue[]): Json[] {
  return rows.map((row) => {
    const out: Json = { key: row.key };
    if (row.type === "file") {
      out.type = "file";
      out.src = row.src ?? "";
    } else {
      out.type = "text";
      out.value = row.value;
    }
    if (row.description) out.description = row.description;
    if (!row.enabled) out.disabled = true;
    return out;
  });
}

/** Postman stores auth parameters as `[{ key, value, type }]`; the object form it also accepts is
 * silently normalized away on re-export, so we write the array form it produces itself. */
function pmAuthParams(values: Record<string, string | number | boolean>): Json[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value,
    type: typeof value === "string" ? "string" : "any",
  }));
}

function pmAuth(auth: AuthConfig | null): Json | undefined {
  if (!auth || auth.type === "inherit") return undefined;
  switch (auth.type) {
    case "none":
      return { type: "noauth" };
    case "basic":
      return {
        type: "basic",
        basic: pmAuthParams({ username: auth.basic.username, password: auth.basic.password }),
      };
    case "bearer":
      return { type: "bearer", bearer: pmAuthParams({ token: auth.bearer.token }) };
    case "apikey":
      return {
        type: "apikey",
        apikey: pmAuthParams({
          key: auth.apikey.key,
          value: auth.apikey.value,
          in: auth.apikey.addTo,
        }),
      };
    case "digest":
      return {
        type: "digest",
        digest: pmAuthParams({ username: auth.digest.username, password: auth.digest.password }),
      };
    case "jwt":
      return {
        type: "jwt",
        jwt: pmAuthParams({
          algorithm: auth.jwt.algorithm,
          secret: auth.jwt.secret,
          isSecretBase64Encoded: auth.jwt.secretBase64,
          payload: auth.jwt.payloadJson,
          header: auth.jwt.headerJson,
          addTokenTo: auth.jwt.addTo === "query" ? "queryParams" : "header",
          headerPrefix: auth.jwt.headerPrefix,
          queryParamKey: auth.jwt.queryParamName,
        }),
      };
    case "awsv4":
      return {
        type: "awsv4",
        awsv4: pmAuthParams({
          accessKey: auth.awsv4.accessKey,
          secretKey: auth.awsv4.secretKey,
          sessionToken: auth.awsv4.sessionToken,
          region: auth.awsv4.region,
          service: auth.awsv4.service,
        }),
      };
    case "oauth2": {
      const o = auth.oauth2;
      const grant =
        o.grantType === "authorization_code_pkce"
          ? "authorization_code_with_pkce"
          : o.grantType === "password"
            ? "password_credentials"
            : o.grantType;
      return {
        type: "oauth2",
        oauth2: pmAuthParams({
          grant_type: grant,
          authUrl: o.authUrl,
          accessTokenUrl: o.accessTokenUrl,
          clientId: o.clientId,
          clientSecret: o.clientSecret,
          scope: o.scope,
          state: o.state,
          username: o.username,
          password: o.password,
          redirect_uri: o.redirectUri,
          audience: o.audience,
          resource: o.resource,
          client_authentication: o.clientAuth,
          accessToken: o.accessToken,
          refreshToken: o.refreshToken,
          addTokenTo: o.addTo === "query" ? "queryParams" : "header",
          headerPrefix: o.headerPrefix,
          tokenType: "Bearer",
        }),
      };
    }
  }
}

function pmEvents(preScript: string, postScript: string): Json[] | undefined {
  const events: Json[] = [];
  if (preScript.trim()) {
    events.push({
      listen: "prerequest",
      script: { type: "text/javascript", exec: preScript.split("\n") },
    });
  }
  if (postScript.trim()) {
    events.push({ listen: "test", script: { type: "text/javascript", exec: postScript.split("\n") } });
  }
  return events.length ? events : undefined;
}

function pmBody(body: RequestBody): Json | undefined {
  switch (body.mode) {
    case "raw":
      return {
        mode: "raw",
        raw: body.raw,
        options: { raw: { language: body.rawLanguage } },
      };
    case "formdata":
      return { mode: "formdata", formdata: pmFormData(body.formdata) };
    case "urlencoded":
      return { mode: "urlencoded", urlencoded: pmKeyValues(body.urlencoded) };
    case "binary":
      return { mode: "file", file: { src: body.binaryPath } };
    case "graphql":
      return {
        mode: "graphql",
        graphql: {
          query: body.graphql.query,
          variables: body.graphql.variables,
          ...(body.graphql.operationName ? { operationName: body.graphql.operationName } : {}),
        },
      };
    case "none":
      return undefined;
  }
}

function pmUrl(view: ExportView): Json {
  const { base, fragment, inlineParams } = splitUrl(view.url);
  const query = [
    ...inlineParams.map((p) => ({ key: p.key, value: p.value, enabled: true, description: "" })),
    ...view.params.map((p) => ({
      key: p.key,
      value: p.value,
      enabled: p.enabled,
      description: p.description,
    })),
  ];
  const enabled = query.filter((q) => q.enabled);
  const queryText = enabled
    .map((q) => (q.value ? `${q.key}=${q.value}` : q.key))
    .join("&");
  const raw = `${base}${queryText ? `?${queryText}` : ""}${fragment}`;

  const parts = urlParts(base);
  const out: Json = { raw };
  if (parts.protocol) out.protocol = parts.protocol;
  if (parts.host.length) out.host = parts.host;
  if (parts.port) out.port = parts.port;
  if (parts.path.length) out.path = parts.path;
  if (query.length) {
    out.query = query.map((q) => {
      const entry: Json = { key: q.key, value: q.value };
      if (q.description) entry.description = q.description;
      if (!q.enabled) entry.disabled = true;
      return entry;
    });
  }
  if (view.pathVars.length) {
    out.variable = view.pathVars.map((v) => {
      const entry: Json = { key: v.key, value: v.value };
      if (v.description) entry.description = v.description;
      return entry;
    });
  }
  return out;
}

function pmRequestObject(view: ExportView, name: string): Json {
  const request: Json = {
    method: view.method || "GET",
    header: pmKeyValues(view.headers),
    url: pmUrl(view),
  };
  const auth = pmAuth(view.auth);
  if (auth) request.auth = auth;
  const body = pmBody(view.body);
  if (body) request.body = body;

  // Postman has no notion of a socket/gRPC item, so the protocol survives only as a note in the
  // description — better a documented downgrade than a request that vanishes from the export.
  const notes =
    view.protocol === "http" || view.protocol === "graphql"
      ? view.description
      : [view.description, `[CodeFlow] original protocol: ${view.protocol} (${name})`]
          .filter(Boolean)
          .join("\n\n");
  if (notes) request.description = notes;
  return request;
}

function pmResponses(view: ExportView, request: Json): Json[] | undefined {
  if (!view.examples.length) return undefined;
  return view.examples.map((ex) => ({
    name: ex.name || `${ex.status}`,
    originalRequest: request,
    status: ex.statusText,
    code: ex.status,
    _postman_previewlanguage: ex.body.trimStart().startsWith("{") ? "json" : "text",
    header: pmKeyValues(ex.headers),
    cookie: [],
    body: ex.body,
  }));
}

function pmItems(
  collectionId: string,
  parentId: string | null,
  folders: ApiFolder[],
  requests: ApiRequestRow[],
): Json[] {
  return childrenOf(collectionId, parentId, folders, requests).map((node) => {
    if (node.kind === "folder") {
      const f = node.folder;
      const item: Json = {
        name: f.name,
        item: pmItems(collectionId, f.id, folders, requests),
      };
      if (f.description) item.description = f.description;
      const auth = pmAuth(readAuth(parseJsonSafe(f.auth)));
      if (auth) item.auth = auth;
      const events = pmEvents(f.pre_script, f.post_script);
      if (events) item.event = events;
      return item;
    }
    const row = node.request;
    const view = readSpec(row);
    const request = pmRequestObject(view, row.name);
    const item: Json = { name: row.name, request };
    const events = pmEvents(view.preScript, view.postScript);
    if (events) item.event = events;
    const responses = pmResponses(view, request);
    if (responses) item.response = responses;
    return item;
  });
}

/**
 * Postman Collection v2.1. Variables are written with `type: "string"` because the v2.1 schema's
 * enum has no `"secret"` member — the secret flag itself is the one thing this format drops, which
 * is why the native export exists.
 */
export function exportPostmanCollection(
  collection: ApiCollection,
  folders: ApiFolder[],
  requests: ApiRequestRow[],
  opts: ExportOptions,
): string {
  const info: Json = {
    _postman_id: collection.id,
    name: collection.name,
    schema: POSTMAN_SCHEMA,
    _exporter_id: "codeflow",
  };
  if (collection.description) info.description = collection.description;

  const out: Json = { info, item: pmItems(collection.id, null, folders, requests) };

  const auth = pmAuth(readAuth(parseJsonSafe(collection.auth)));
  if (auth) out.auth = auth;
  const events = pmEvents(collection.pre_script, collection.post_script);
  if (events) out.event = events;

  const vars = redact(readVariables(collection.variables) ?? [], opts.includeSecrets);
  if (vars.length) {
    out.variable = vars.map((v) => {
      const entry: Json = { key: v.key, value: v.initialValue, type: "string" };
      if (v.description) entry.description = v.description;
      if (!v.enabled) entry.disabled = true;
      return entry;
    });
  }
  return pretty(out);
}

// ---------------------------------------------------------------------------
// Native format
// ---------------------------------------------------------------------------

/**
 * Ships the DB rows verbatim, so protocol settings, gRPC/MQTT config and saved examples all
 * survive a round trip. The only thing rewritten is the collection's variable blob, because the
 * secret guard has to hold here too.
 */
export function exportNativeCollection(
  collection: ApiCollection,
  folders: ApiFolder[],
  requests: ApiRequestRow[],
  opts: ExportOptions,
): string {
  const vars = readVariables(collection.variables);
  const scoped: ApiCollection = {
    ...collection,
    // Blanked, not carried: an export is a file meant to be shared, and the workspace id says
    // nothing to whoever opens it while identifying the machine it came from. Import re-parents
    // the collection to whatever workspace is active anyway, so nothing is lost by dropping it.
    workspace_id: "",
    variables: vars ? JSON.stringify(redact(vars, opts.includeSecrets)) : collection.variables,
  };
  const payload: NativeExport = {
    format: "codeflow-api",
    version: 1,
    collection: scoped,
    folders: folders
      .filter((f) => f.collection_id === collection.id)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order),
    requests: requests
      .filter((r) => r.collection_id === collection.id)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order),
  };
  return pretty(payload);
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/**
 * Postman's environment shape, which both Postman and our own importer read. Only `initialValue`
 * travels — `currentValue` is session state (a script's freshly minted access token lives there),
 * and shipping it in a file meant for sharing is exactly the leak this format avoids.
 */
export function exportEnvironment(env: ApiEnvironment, opts: ExportOptions): string {
  const vars = redact(readVariables(env.variables) ?? [], opts.includeSecrets);
  return pretty({
    id: env.id,
    name: env.name,
    values: vars.map((v) => ({
      key: v.key,
      value: v.initialValue,
      type: v.secret ? "secret" : "default",
      enabled: v.enabled,
      ...(v.description ? { description: v.description } : {}),
    })),
    _postman_variable_scope: env.is_global ? "globals" : "environment",
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: "CodeFlow",
  });
}

// ---------------------------------------------------------------------------
// OpenAPI 3.1
// ---------------------------------------------------------------------------

const SERVER_VARIABLE_KEYS = ["baseurl", "base_url", "host", "url", "server", "endpoint"];

/** What every request is hanging off, when there is one. */
export interface ServerGuess {
  /** The literal text to strip off a request URL to leave the path — `{{baseUrl}}` or an origin. */
  prefix: string;
  /** The same thing resolved for display: a variable's value rather than its name. */
  url: string;
}

/**
 * Guesses the collection's server two ways, in order: a collection variable named like a base URL
 * that the requests actually start with, else a single origin shared by every request. Anything
 * less consistent than that isn't a server, so the prefix comes back empty and callers keep the
 * full URL. Shared with `docs.ts`, which shows the same guess as the document's base URL.
 */
export function guessServer(vars: ApiVariable[], urls: string[]): ServerGuess {
  const serverVar = vars.find((v) => SERVER_VARIABLE_KEYS.includes(v.key.toLowerCase()));
  if (serverVar && urls.some((u) => u.startsWith(`{{${serverVar.key}}}`))) {
    const prefix = `{{${serverVar.key}}}`;
    return { prefix, url: serverVar.initialValue || serverVar.currentValue || prefix };
  }
  const origins = urls
    .map((u) => /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)/.exec(u)?.[1] ?? "")
    .filter(Boolean);
  if (origins.length && origins.every((o) => o === origins[0])) {
    return { prefix: origins[0], url: origins[0] };
  }
  return { prefix: "", url: "" };
}

/** Schema inferred from a concrete example, so a generated spec still documents its own shape. */
function schemaOfValue(value: unknown, depth = 0): Json {
  if (value === null || depth > 6) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? schemaOfValue(value[0], depth + 1) : {} };
  }
  if (typeof value === "object") {
    const properties: Json = {};
    for (const [k, v] of Object.entries(value as Json)) properties[k] = schemaOfValue(v, depth + 1);
    return { type: "object", properties };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function oasSecurityScheme(auth: AuthConfig): { name: string; scheme: Json } | null {
  switch (auth.type) {
    case "basic":
      return { name: "basicAuth", scheme: { type: "http", scheme: "basic" } };
    case "bearer":
      return { name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } };
    case "digest":
      return { name: "digestAuth", scheme: { type: "http", scheme: "digest" } };
    case "jwt":
      return {
        name: "jwtAuth",
        scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      };
    case "apikey":
      return {
        name: "apiKeyAuth",
        scheme: {
          type: "apiKey",
          in: auth.apikey.addTo,
          name: auth.apikey.key || "api-key",
        },
      };
    case "awsv4":
      // No native OpenAPI equivalent; described as the header it ends up producing.
      return {
        name: "awsSigV4",
        scheme: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "AWS Signature Version 4",
        },
      };
    case "oauth2": {
      const o = auth.oauth2;
      const scopes: Json = {};
      for (const s of o.scope.split(/[\s,]+/).filter(Boolean)) scopes[s] = "";
      const flow: Json = { scopes };
      if (o.accessTokenUrl) flow.tokenUrl = o.accessTokenUrl;
      if (o.authUrl) flow.authorizationUrl = o.authUrl;
      const flowName =
        o.grantType === "client_credentials"
          ? "clientCredentials"
          : o.grantType === "password"
            ? "password"
            : o.grantType === "implicit"
              ? "implicit"
              : "authorizationCode";
      return { name: "oauth2Auth", scheme: { type: "oauth2", flows: { [flowName]: flow } } };
    }
    default:
      return null;
  }
}

function oasPath(url: string, serverPrefix: string): string {
  let path = url;
  if (serverPrefix && path.startsWith(serverPrefix)) path = path.slice(serverPrefix.length);
  const { base } = splitUrl(path);
  path = base;
  // `:id` is our path-variable syntax; OpenAPI wants `{id}`.
  path = path.replace(/:([A-Za-z_][A-Za-z0-9_-]*)/g, "{$1}");
  if (!path.startsWith("/")) path = `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function oasOperationId(name: string, used: Set<string>): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) =>
    c ? c.toUpperCase() : "",
  );
  const base = (cleaned || "operation").replace(/^[0-9]+/, "");
  let id = base || "operation";
  let n = 2;
  while (used.has(id)) id = `${base}${n++}`;
  used.add(id);
  return id;
}

function oasRequestBody(body: RequestBody): Json | undefined {
  switch (body.mode) {
    case "raw": {
      if (body.rawLanguage === "json") {
        const parsed = parseJsonSafe(body.raw);
        if (parsed !== undefined) {
          return {
            required: true,
            content: { "application/json": { schema: schemaOfValue(parsed), example: parsed } },
          };
        }
      }
      const mime =
        body.rawLanguage === "xml"
          ? "application/xml"
          : body.rawLanguage === "html"
            ? "text/html"
            : body.rawLanguage === "javascript"
              ? "application/javascript"
              : body.rawLanguage === "json"
                ? "application/json"
                : "text/plain";
      return {
        required: true,
        content: { [mime]: { schema: { type: "string" }, example: body.raw } },
      };
    }
    case "formdata":
    case "urlencoded": {
      const rows = body.mode === "formdata" ? body.formdata : body.urlencoded;
      const properties: Json = {};
      for (const row of rows) {
        if (!row.enabled || !row.key) continue;
        properties[row.key] =
          row.type === "file"
            ? { type: "string", format: "binary" }
            : { type: "string", example: row.value };
      }
      const mime =
        body.mode === "formdata" ? "multipart/form-data" : "application/x-www-form-urlencoded";
      return { required: true, content: { [mime]: { schema: { type: "object", properties } } } };
    }
    case "binary":
      return {
        required: true,
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      };
    case "graphql": {
      const variables = parseJsonSafe(body.graphql.variables);
      return {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { query: { type: "string" }, variables: { type: "object" } },
            },
            example: {
              query: body.graphql.query,
              variables: variables === undefined ? {} : variables,
            },
          },
        },
      };
    }
    case "none":
      return undefined;
  }
}

function oasResponses(examples: SavedExample[]): Json {
  if (!examples.length) return { "200": { description: "OK" } };
  const responses: Json = {};
  for (const ex of examples) {
    const code = String(ex.status || 200);
    const parsed = parseJsonSafe(ex.body);
    const mime =
      ex.headers.find((h) => h.key.toLowerCase() === "content-type")?.value.split(";")[0] ||
      (parsed !== undefined ? "application/json" : "text/plain");
    const entry: Json = { description: ex.statusText || ex.name || "Response" };
    if (ex.body) {
      entry.content = {
        [mime]: {
          schema: parsed !== undefined ? schemaOfValue(parsed) : { type: "string" },
          example: parsed !== undefined ? parsed : ex.body,
        },
      };
    }
    responses[code] = entry;
  }
  return responses;
}

/** Path chain of folder names, used as the operation's tag. */
export function folderTag(folderId: string | null, folders: ApiFolder[]): string {
  const names: string[] = [];
  let current = folderId;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    guard.add(current);
    const folder = folders.find((f) => f.id === current);
    if (!folder) break;
    names.unshift(folder.name);
    current = folder.parent_id;
  }
  return names.join(" / ");
}

/**
 * Best-effort OpenAPI 3.1 description of a collection. Only `http`/`graphql` requests appear —
 * the socket protocols have no OpenAPI representation — and when two requests share a path and a
 * method the first one wins, since a path item can hold only one operation per verb.
 */
export function exportOpenApi(
  collection: ApiCollection,
  folders: ApiFolder[],
  requests: ApiRequestRow[],
): string {
  const own = requests
    .filter((r) => r.collection_id === collection.id)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const views = own
    .map((row) => ({ row, view: readSpec(row) }))
    .filter(({ view }) => view.protocol === "http" || view.protocol === "graphql");

  const vars = readVariables(collection.variables) ?? [];
  const server = guessServer(
    vars,
    views.map(({ view }) => view.url),
  );
  const serverPrefix = server.prefix;
  // OpenAPI requires a `url` on a server object; `/` is the spec's own "same host as the docs".
  const serverUrl = server.url || "/";

  const paths: Json = {};
  const securitySchemes: Json = {};
  const tags = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const { row, view } of views) {
    const path = oasPath(view.url, serverPrefix);
    const method = (view.method || "GET").toLowerCase();
    const item = isObj(paths[path]) ? (paths[path] as Json) : {};
    if (item[method] !== undefined) continue;

    const tag = folderTag(row.folder_id, folders);
    if (tag && !tags.has(tag)) tags.set(tag, "");

    const parameters: Json[] = [];
    for (const p of view.pathVars) {
      if (!p.key) continue;
      parameters.push({
        name: p.key,
        in: "path",
        required: true,
        description: p.description || undefined,
        schema: { type: "string" },
        example: p.value || undefined,
      });
    }
    for (const p of view.params) {
      if (!p.key) continue;
      parameters.push({
        name: p.key,
        in: "query",
        required: false,
        description: p.description || undefined,
        schema: { type: "string" },
        example: p.value || undefined,
      });
    }
    for (const h of view.headers) {
      const lower = h.key.toLowerCase();
      // Content-Type is implied by `requestBody`, and the other two are security, not parameters.
      if (!h.key || lower === "content-type" || lower === "authorization" || lower === "cookie") {
        continue;
      }
      parameters.push({
        name: h.key,
        in: "header",
        required: false,
        description: h.description || undefined,
        schema: { type: "string" },
        example: h.value || undefined,
      });
    }

    const operation: Json = {
      operationId: oasOperationId(row.name, usedIds),
      summary: row.name,
      responses: oasResponses(view.examples),
    };
    if (tag) operation.tags = [tag];
    if (view.description) operation.description = view.description;
    if (parameters.length) operation.parameters = parameters;
    const requestBody = oasRequestBody(view.body);
    if (requestBody) operation.requestBody = requestBody;
    if (view.auth && view.auth.type !== "inherit") {
      if (view.auth.type === "none") {
        operation.security = [];
      } else {
        const scheme = oasSecurityScheme(view.auth);
        if (scheme) {
          securitySchemes[scheme.name] = scheme.scheme;
          operation.security = [{ [scheme.name]: [] }];
        }
      }
    }

    item[method] = operation;
    paths[path] = item;
  }

  const doc: Json = {
    openapi: "3.1.0",
    info: {
      title: collection.name || "API",
      description: collection.description || undefined,
      version: "1.0.0",
    },
    servers: [{ url: serverUrl }],
    paths,
  };
  if (tags.size) {
    doc.tags = [...tags.keys()].map((name) => ({ name }));
  }

  const collectionAuth = readAuth(parseJsonSafe(collection.auth));
  if (collectionAuth && collectionAuth.type !== "inherit" && collectionAuth.type !== "none") {
    const scheme = oasSecurityScheme(collectionAuth);
    if (scheme) {
      securitySchemes[scheme.name] = scheme.scheme;
      doc.security = [{ [scheme.name]: [] }];
    }
  }
  if (Object.keys(securitySchemes).length) doc.components = { securitySchemes };

  return pretty(doc);
}
