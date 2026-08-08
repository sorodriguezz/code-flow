/**
 * The single path from an editable `ApiRequestSpec` to something on the wire.
 *
 * The builder, the collection runner and the code-snippet panel all go through `resolveRequest`,
 * which is what makes "the cURL snippet is exactly what Send would do" true by construction
 * instead of by three implementations happening to agree. Anything downstream that needs to know
 * what will actually be sent reads a `ResolvedRequest` — never an `ApiRequestSpec`.
 */

import type {
  ApiCookie,
  ApiProtocol,
  ApiRequestSpec,
  ApiSettings,
  AuthConfig,
  ClientCert,
  FormPart,
  HttpResponse,
  HttpSendRequest,
  KeyValue,
  NetworkOptions,
  RawLanguage,
  ResolvedBody,
  ResolvedRequest,
} from "../../types/api";
import { apiSendHttp, apiSendHttpTracked } from "../tauri/apiCommands";
import { applyAuth, resolveEffectiveAuth } from "./auth";
import { resolve, resolveKeyValues, type VariableContext } from "./variables";

/** `RequestSettings.encodeUrl` has no counterpart in `ApiSettings`, so `null` lands here. */
const DEFAULT_ENCODE_URL = true;

/** Exported so the body editor's language picker offers exactly the type the send path implies —
 * a second copy in the UI is a copy that eventually disagrees with what goes on the wire. */
export const RAW_CONTENT_TYPES: Record<RawLanguage, string> = {
  json: "application/json",
  xml: "application/xml",
  text: "text/plain",
  javascript: "application/javascript",
  html: "text/html",
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Turns an editable spec into the exact request that will be sent.
 *
 * In order: interpolate `{{variables}}` → substitute `:pathVars` → rebuild the query string →
 * build the body → add the implied `Content-Type` → resolve and apply auth → merge the global
 * settings with this request's overrides.
 *
 * Scripts (`preScript`/`postScript`) are deliberately *not* interpolated: they're JavaScript
 * source, and `{{...}}` inside them is either a template literal or the script's own business.
 *
 * `cookies` is optional so the mandated four-argument form still type-checks; pass the jar
 * whenever the request may need it, since only the caller knows the jar's current contents.
 */
export async function resolveRequest(
  spec: ApiRequestSpec,
  ctx: VariableContext,
  authChain: (AuthConfig | null)[],
  settings: ApiSettings,
  cookies: ApiCookie[] = [],
): Promise<ResolvedRequest> {
  const expand = (text: string) => resolve(text, ctx);

  const method = expand(spec.method).trim().toUpperCase() || "GET";
  const encodeUrl = spec.settings.encodeUrl ?? DEFAULT_ENCODE_URL;

  let url = withDefaultScheme(
    substitutePathVars(expand(spec.url).trim(), resolveKeyValues(spec.pathVars, ctx), encodeUrl),
    spec.protocol,
  );
  url = withQuery(url, resolveKeyValues(spec.params, ctx), encodeUrl);

  const headers = enabledRows(resolveKeyValues(spec.headers, ctx)).map(
    (row): [string, string] => [row.key, row.value],
  );

  const body = buildBody(spec, ctx);
  const implied = impliedContentType(body);
  if (implied && !hasHeader(headers, "content-type")) headers.push(["Content-Type", implied]);

  const effective = mapStrings(resolveEffectiveAuth(authChain), expand);
  const applied = await applyAuth(effective, {
    method,
    url,
    bodyText: body.kind === "text" ? body.text : "",
  });
  headers.push(...applied.headers);
  url = appendQuery(url, applied.queryParams, encodeUrl);

  return {
    protocol: spec.protocol,
    method,
    url,
    headers,
    body,
    backendAuth: applied.backend,
    options: buildOptions(spec, settings, url, cookies),
  };
}

/** Picks the one body representation the transport understands for this `ResolvedRequest`. */
export function toHttpSendRequest(req: ResolvedRequest): HttpSendRequest {
  const base: HttpSendRequest = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body_text: null,
    body_base64: null,
    body_file: null,
    form_data: null,
    urlencoded: null,
    auth: req.backendAuth,
    options: req.options,
  };
  switch (req.body.kind) {
    case "none":
      return base;
    case "text":
      return { ...base, body_text: req.body.text };
    case "formdata":
      return { ...base, form_data: req.body.parts };
    case "urlencoded":
      return { ...base, urlencoded: req.body.pairs };
    case "file":
      return { ...base, body_file: req.body.path };
  }
}

/** `trackId` registers the send under a cancellation token so the Cancel button can abort it. */
export async function sendResolved(req: ResolvedRequest, trackId?: string): Promise<HttpResponse> {
  const payload = toHttpSendRequest(req);
  return trackId ? apiSendHttpTracked(trackId, payload) : apiSendHttp(payload);
}

/**
 * The headers the transport supplies on its own, minus any the user already set explicitly —
 * Postman's greyed-out "hidden headers" list.
 *
 * Advisory only: the authoritative record of what went on the wire is `HttpResponse.sent.headers`,
 * which the backend fills in from the built request. Values that can only be known once the body
 * is framed use Postman's own `<calculated…>` wording rather than a guess.
 */
export function buildImplicitHeaders(req: ResolvedRequest): [string, string][] {
  const calculated = "<calculated when the request is sent>";
  const candidates: [string, string][] = [
    ["Host", authorityOf(req.url) || calculated],
    ["User-Agent", "CodeFlow"],
    ["Accept", "*/*"],
    // Must mirror `ADVERTISED_ENCODINGS` in `src-tauri/src/api/http.rs`.
    ["Accept-Encoding", "gzip, br, deflate"],
    ["Connection", "keep-alive"],
  ];
  // A bodiless request gets no `Content-Length` at all, so listing one would be a lie.
  if (req.body.kind !== "none") {
    candidates.push(["Content-Length", contentLengthOf(req.body) ?? calculated]);
  }
  return candidates.filter(([name]) => !hasHeader(req.headers, name));
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** What a bare `host:port` means for each protocol. gRPC is absent on purpose: it addresses a
 *  plain `host:port` authority and gets its scheme from the request's own TLS toggle. */
const DEFAULT_SCHEMES: Partial<Record<ApiProtocol, string>> = {
  http: "http://",
  graphql: "http://",
  websocket: "ws://",
  socketio: "ws://",
  mqtt: "mqtt://",
};

/**
 * Fills in the scheme when the user didn't type one, so `localhost:3000` and `google.cl` are
 * valid things to type — which is what every other client allows and what people actually do.
 *
 * The test is `://` rather than a leading `word:`, because that is the only way to tell a scheme
 * from a port: in `localhost:3000` the part before the colon looks exactly like a scheme name.
 * Applied here rather than in the input so the field keeps whatever was typed, and so the code
 * snippet — built from this same resolved request — shows the URL that is really sent.
 *
 * Nothing is validated: an unparseable URL is left alone and allowed to fail at the transport,
 * where the error names the actual problem.
 */
function withDefaultScheme(url: string, protocol: ApiProtocol): string {
  const scheme = DEFAULT_SCHEMES[protocol];
  if (!scheme || url === "" || url.includes("://")) return url;
  // A leftover `{{var}}` that will expand to a full URL later must not be prefixed.
  if (url.startsWith("{{")) return url;
  return scheme + url;
}

/**
 * Replaces `:name` path segments with their value. The scheme is skipped explicitly rather than
 * relying on a lookbehind, and `:8080` can't match because a variable name may not start with a
 * digit — so a port survives untouched.
 */
function substitutePathVars(url: string, pathVars: KeyValue[], encode: boolean): string {
  const rows = enabledRows(pathVars);
  if (rows.length === 0) return url;
  const schemeEnd = url.indexOf("://");
  const head = schemeEnd < 0 ? "" : url.slice(0, schemeEnd + 3);
  const tail = schemeEnd < 0 ? url : url.slice(schemeEnd + 3);
  const replaced = tail.replace(/:([A-Za-z_][A-Za-z0-9_-]*)/g, (match, name: string) => {
    const row = rows.find((r) => r.key === name);
    if (!row) return match;
    return encode ? encodeURIComponent(row.value) : row.value;
  });
  return head + replaced;
}

/**
 * Rebuilds the query string from the params table.
 *
 * The table wins whenever it has any rows at all — that's what lets unchecking a row actually
 * drop it from the URL. A spec with an empty table keeps whatever was typed into the URL, so an
 * ad-hoc `?a=1` still works before the URL bar has parsed it into rows.
 */
function withQuery(url: string, params: KeyValue[], encode: boolean): string {
  if (params.length === 0) return url;
  const pairs = enabledRows(params).map((row): [string, string] => [row.key, row.value]);
  return rewriteQuery(url, () => render(pairs, encode));
}

/** Adds auth-supplied params on top of the query the request already has. */
function appendQuery(url: string, pairs: [string, string][], encode: boolean): string {
  if (pairs.length === 0) return url;
  return rewriteQuery(url, (existing) => [existing, render(pairs, encode)].filter(Boolean).join("&"));
}

function rewriteQuery(url: string, next: (existing: string) => string): string {
  const hashAt = url.indexOf("#");
  const fragment = hashAt < 0 ? "" : url.slice(hashAt);
  const withoutFragment = hashAt < 0 ? url : url.slice(0, hashAt);

  const queryAt = withoutFragment.indexOf("?");
  const base = queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt);
  const query = next(queryAt < 0 ? "" : withoutFragment.slice(queryAt + 1));

  return query ? `${base}?${query}${fragment}` : base + fragment;
}

function render(pairs: [string, string][], encode: boolean): string {
  return pairs
    .map(([key, value]) =>
      encode ? `${encodeURIComponent(key)}=${encodeURIComponent(value)}` : `${key}=${value}`,
    )
    .join("&");
}

/** `host:port`, or `""` for a URL too malformed to parse. */
function authorityOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function buildBody(spec: ApiRequestSpec, ctx: VariableContext): ResolvedBody {
  const body = spec.body;
  switch (body.mode) {
    case "none":
      return { kind: "none" };
    case "raw":
      return {
        kind: "text",
        text: resolve(body.raw, ctx),
        contentType: RAW_CONTENT_TYPES[body.rawLanguage],
      };
    case "graphql":
      return { kind: "text", text: graphqlPayload(spec, ctx), contentType: "application/json" };
    case "urlencoded":
      return {
        kind: "urlencoded",
        pairs: enabledRows(resolveKeyValues(body.urlencoded, ctx)).map(
          (row): [string, string] => [row.key, row.value],
        ),
      };
    case "formdata":
      return { kind: "formdata", parts: formParts(resolveKeyValues(body.formdata, ctx)) };
    case "binary":
      return {
        kind: "file",
        path: resolve(body.binaryPath, ctx),
        contentType: "application/octet-stream",
      };
  }
}

/** GraphQL goes out as an ordinary JSON POST body — there is no separate GraphQL transport. */
function graphqlPayload(spec: ApiRequestSpec, ctx: VariableContext): string {
  const { query, variables, operationName } = spec.body.graphql;
  const payload: { query: string; variables?: unknown; operationName?: string } = {
    query: resolve(query, ctx),
  };
  const rawVariables = resolve(variables, ctx).trim();
  if (rawVariables) {
    try {
      payload.variables = JSON.parse(rawVariables);
    } catch (e) {
      // Sending `{}` instead would silently run the wrong query; failing here is the honest move.
      throw new Error(`GraphQL variables are not valid JSON: ${String(e)}`);
    }
  }
  const name = resolve(operationName, ctx).trim();
  if (name) payload.operationName = name;
  return JSON.stringify(payload);
}

function formParts(rows: KeyValue[]): FormPart[] {
  return enabledRows(rows).map((row) => ({
    name: row.key,
    value: row.type === "file" ? null : row.value,
    file_path: row.type === "file" ? (row.src ?? "") : null,
    content_type: null,
  }));
}

/** `formdata` is missing on purpose: only the transport knows the multipart boundary. */
function impliedContentType(body: ResolvedBody): string | null {
  switch (body.kind) {
    case "text":
      return body.contentType;
    case "urlencoded":
      return "application/x-www-form-urlencoded";
    case "file":
      return body.contentType;
    default:
      return null;
  }
}

/** Byte length for the bodies held in memory; `null` when only the transport can know it. */
function contentLengthOf(body: ResolvedBody): string | null {
  switch (body.kind) {
    case "text":
      return String(new TextEncoder().encode(body.text).length);
    case "urlencoded": {
      const encoded = body.pairs
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
      return String(new TextEncoder().encode(encoded).length);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Network options
// ---------------------------------------------------------------------------

function buildOptions(
  spec: ApiRequestSpec,
  settings: ApiSettings,
  url: string,
  jar: ApiCookie[],
): NetworkOptions {
  const overrides = spec.settings;
  const cert = matchClientCert(settings.clientCerts, url);
  const sendCookies = overrides.sendCookies ?? settings.sendCookies;
  return {
    timeout_ms: overrides.timeoutMs ?? settings.timeoutMs,
    follow_redirects: overrides.followRedirects ?? settings.followRedirects,
    max_redirects: overrides.maxRedirects ?? settings.maxRedirects,
    verify_ssl: overrides.verifySsl ?? settings.verifySsl,
    keep_auth_on_redirect: overrides.keepAuthOnRedirect ?? settings.keepAuthOnRedirect,
    proxy_url: settings.proxyEnabled ? settings.proxyUrl : "",
    client_cert_path: cert?.certPath ?? "",
    client_cert_password: cert?.passphrase ?? "",
    ca_cert_path: settings.caCertPath,
    cookies: sendCookies ? matchCookies(jar, url) : [],
    max_response_bytes: settings.maxResponseBytes,
  };
}

/** Exact host, or a `*.example.com` wildcard covering any single-or-deeper subdomain. */
export function matchClientCert(certs: ClientCert[], url: string): ClientCert | null {
  const host = hostOf(url);
  if (!host) return null;
  return (
    certs.find((cert) => {
      const pattern = cert.host.trim().toLowerCase();
      if (!pattern) return false;
      if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
      return pattern === host;
    }) ?? null
  );
}

/** RFC 6265 matching: domain suffix, path prefix, `Secure` only over https, not expired. */
function matchCookies(jar: ApiCookie[], url: string): [string, string][] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  const isSecure = parsed.protocol === "https:";
  const now = Date.now();

  return jar
    .filter((cookie) => {
      if (cookie.secure && !isSecure) return false;
      if (cookie.expires && Date.parse(cookie.expires) <= now) return false;
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      if (domain && host !== domain && !host.endsWith(`.${domain}`)) return false;
      return pathMatches(parsed.pathname, cookie.path || "/");
    })
    .map((cookie): [string, string] => [cookie.name, cookie.value]);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function enabledRows(rows: KeyValue[]): KeyValue[] {
  return rows.filter((row) => row.enabled && row.key.trim() !== "");
}

function hasHeader(headers: [string, string][], name: string): boolean {
  const wanted = name.toLowerCase();
  return headers.some(([key]) => key.toLowerCase() === wanted);
}

/**
 * Rewrites every string reachable from `value`, leaving numbers, booleans and nulls alone.
 *
 * Walking the shape instead of naming fields is what keeps interpolation working when a new
 * auth scheme or body mode adds a field — the alternative is a list that silently goes stale.
 */
function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out as T;
  }
  return value;
}
