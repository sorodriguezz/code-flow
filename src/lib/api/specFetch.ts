import { apiSendHttp } from "../tauri/apiCommands";
import { matchClientCert } from "./send";
import { detectFormat } from "./importers";
import type { ApiSettings, HttpSendRequest, NetworkOptions } from "../../types/api";

/**
 * Downloading an API description from a URL.
 *
 * Two things make this more than one `GET`.
 *
 * **It goes through the Rust transport, never `fetch`.** A webview asking `api.acme.com` for its
 * spec is a cross-origin request, and a spec endpoint has no reason to send CORS headers — the
 * browser would refuse the response before we ever saw it. Going through `api_send_http` also
 * means the proxy, the CA bundle, the mTLS certificate and the "don't verify TLS" escape hatch
 * the user already configured for sending apply to fetching too, which is the whole point when the
 * spec lives on the same corporate host as the API.
 *
 * **The URL people have is usually not the spec.** What is in the address bar, in the README and
 * in the ticket is the Swagger UI page — an HTML shell that loads the document from somewhere
 * else. Refusing that and asking for "the real URL" is asking the user to do a lookup we can do:
 * the page names its document, either inline or in the `swagger-initializer.js` beside it, and
 * failing that the generators put it at a handful of well-known paths.
 *
 * **Sometimes the document has no URL at all.** `swagger-ui-express` — what NestJS and most Express
 * apps mount — serialises the whole description *into* `swagger-ui-init.js` as a `swaggerDoc`
 * literal and never serves it as a document of its own. There is nothing to follow and nothing to
 * sweep for: the only copy on the wire is embedded in a script, so we read it out of one.
 */

/** Server-Driven candidates come first; these are the fallback sweep. */
const WELL_KNOWN_PATHS = [
  "/v3/api-docs",
  "/v2/api-docs",
  "/openapi.json",
  "/swagger.json",
  // Where Swagger 2.0 tooling puts it — the version in the path is the *API description's*, not the
  // app's, so it is a fixed layout rather than a guess about someone's routing. The petstore, which
  // is the URL everyone reaches for first when trying this feature out, is exactly this.
  "/v2/swagger.json",
  "/v1/swagger.json",
  "/swagger/v1/swagger.json",
  "/api-docs",
  "/api-json",
  "/openapi.yaml",
  "/swagger.yaml",
];

/** Each entry is a round trip, so the sweep is bounded rather than exhaustive. */
const MAX_PROBES = 24;

/** The page answered, so the host is up; a well-known path that isn't there 404s quickly. */
const PROBE_TIMEOUT_MS = 10_000;

/** `url:`/`configUrl:` in Swagger UI's inline config, its initializer script, or a config JSON. */
const URL_FIELD = /["']?(?:configUrl|url)["']?\s*:\s*["']([^"']+)["']/g;

/**
 * Any quoted string that looks like a document URL, anywhere in a script or config we fetched.
 *
 * `URL_FIELD` assumes the URL sits in the field that consumes it, and a real initializer routinely
 * does not: Swagger UI's own ships as `const defaultDefinitionUrl = "…/v2/swagger.json"` and then
 * `url: definitionURL`, so the field holds an identifier and the only literal in the file is the
 * assignment above it. Matching on the shape of the value instead of on its key finds it.
 *
 * Only applied to text we already know is not a document (see `fetchSpec`), and every hit is a
 * *candidate* that still has to answer 2xx with something `detectFormat` recognises — so a stray
 * `package.json` costs one bounded probe rather than a wrong import.
 */
const DOC_URL = /["'`]((?:https?:\/\/|\.{0,2}\/)[^"'`\s]+\.(?:json|ya?ml))["'`]/gi;

/**
 * `<script src="./swagger-initializer.js">` — Swagger UI 4+ moved the config out of the page — and
 * `swagger-ui-init.js`, which is the same idea under swagger-ui-express's spelling.
 *
 * Deliberately narrower than "any script with swagger in the name": the page also loads
 * `swagger-ui-bundle.js` and `swagger-ui-standalone-preset.js`, and probing those means
 * downloading a megabyte of minified library to learn it isn't an API description. `-init` is the
 * substring both initializers share and neither bundle has.
 */
const SCRIPT_SRC = /<script[^>]+src\s*=\s*["']([^"']*(?:-init|swagger-config)[^"']*\.js)["']/gi;

/** `swaggerDoc: {…}` under swagger-ui-express, `spec: {…}` in a hand-written `SwaggerUIBundle`. */
const EMBEDDED_DOC = /["']?(?:swaggerDoc|spec)["']?\s*:\s*\{/g;

export type SpecFetchFailure =
  | { code: "badUrl" }
  | { code: "http"; status: number }
  | { code: "network"; detail: string }
  | { code: "notASpec" };

export class SpecFetchError extends Error {
  constructor(readonly failure: SpecFetchFailure) {
    super(failure.code);
    this.name = "SpecFetchError";
  }
}

export interface FetchedSpec {
  /** The document, ready for `importAny`. */
  text: string;
  /** Where it actually came from. */
  url: string;
  /** Set when the URL the user gave was a Swagger UI page and the document was found elsewhere. */
  resolvedFrom: string | null;
}

/** A bare host is a typo often enough, but a bare `host/v3/api-docs` is just how people write it. */
export function normalizeSpecUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function networkOptions(settings: ApiSettings, url: string): NetworkOptions {
  const cert = matchClientCert(settings.clientCerts, url);
  return {
    timeout_ms: settings.timeoutMs,
    // A spec URL redirecting — to a CDN, to a versioned path, http to https — is ordinary, and
    // there is no request body or credential here for a redirect to leak.
    follow_redirects: true,
    max_redirects: Math.max(settings.maxRedirects, 5),
    verify_ssl: settings.verifySsl,
    keep_auth_on_redirect: false,
    proxy_url: settings.proxyEnabled ? settings.proxyUrl : "",
    client_cert_path: cert?.certPath ?? "",
    client_cert_password: cert?.passphrase ?? "",
    ca_cert_path: settings.caCertPath,
    cookies: [],
    max_response_bytes: settings.maxResponseBytes,
  };
}

function specRequest(url: string, settings: ApiSettings, timeoutMs?: number): HttpSendRequest {
  const options = networkOptions(settings, url);
  return {
    method: "GET",
    url,
    headers: [
      ["Accept", "application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8"],
    ],
    body_text: null,
    body_base64: null,
    body_file: null,
    form_data: null,
    urlencoded: null,
    auth: null,
    options:
      timeoutMs === undefined
        ? options
        : { ...options, timeout_ms: Math.min(options.timeout_ms, timeoutMs) },
  };
}

/**
 * One `GET`, as text. A non-2xx or an unreadable body is `null` rather than a throw: on the
 * well-known sweep, a 404 is the expected answer for most of the list.
 */
async function probe(url: string, settings: ApiSettings): Promise<string | null> {
  const response = await apiSendHttp(specRequest(url, settings, PROBE_TIMEOUT_MS)).catch(() => null);
  if (!response) return null;
  if (response.status < 200 || response.status >= 300) return null;
  return response.body_text || null;
}

/** Every document URL a Swagger UI page, initializer script or config JSON points at. */
function referencedUrls(text: string, base: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return [];
  }
  const host = parsed.hostname;

  // `<script src="./swagger-ui-init.js">` on a page served at `/api/docs` resolves to
  // `/api/swagger-ui-init.js` by the URL rules, but to `/api/docs/swagger-ui-init.js` in the
  // browser that rendered it — the server redirected to the trailing slash on the way in, and a
  // redirect we didn't make is invisible in the body we got. So a relative lead is tried both ways
  // rather than guessed at.
  const asDirectory = new URL(parsed.href);
  if (!asDirectory.pathname.endsWith("/")) asDirectory.pathname += "/";
  const bases = asDirectory.href === parsed.href ? [base] : [base, asDirectory.href];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string, from: string) => {
    let resolved: URL;
    try {
      resolved = new URL(raw, from);
    } catch {
      return; /* a relative URL we can't resolve is not a candidate */
    }
    // Swagger UI ships pointing at the petstore, so a self-hosted copy whose config was never
    // changed would otherwise import somebody else's API. Only a lead *off* the host being imported
    // is dropped: asking for the petstore — which is the first URL anyone tries this with — has to
    // be able to return the petstore.
    if (resolved.hostname !== host && /(^|\.)petstore\d*\.swagger\.io$/i.test(resolved.hostname)) {
      return;
    }
    const href = resolved.toString();
    if (seen.has(href)) return;
    seen.add(href);
    out.push(href);
  };
  const push = (raw: string) => {
    if (!raw || raw.includes("{{")) return;
    // Absolute and root-relative leads land in the same place against either base; only a genuinely
    // relative one is ambiguous enough to be worth the second probe.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) add(raw, base);
    else for (const from of bases) add(raw, from);
  };
  // Ordered by how specific the evidence is: a `url:` field is the document, a script tag is one
  // more hop, and a bare literal is a guess about a string that merely looks like one.
  for (const match of text.matchAll(URL_FIELD)) push(match[1]);
  for (const match of text.matchAll(SCRIPT_SRC)) push(match[1]);
  for (const match of text.matchAll(DOC_URL)) push(match[1]);
  return out;
}

/**
 * The `{…}` that starts at `text[start]`, or null if it never closes.
 *
 * Brace counting has to understand strings, because an API description is full of path templates:
 * a summary reading `Fetch the order for {orderId}` would otherwise close the object early and hand
 * back a fragment that doesn't parse.
 */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The API description serialised *into* a script, for when it is served nowhere else.
 *
 * Every hit still has to parse and still has to look like OpenAPI to `detectFormat`, so the
 * `customOptions: {…}` sitting next to it in the same literal — and any unrelated `spec:` in a
 * page we misjudged — is rejected on its contents rather than on where it happened to sit.
 */
function embeddedSpec(text: string): string | null {
  for (const match of text.matchAll(EMBEDDED_DOC)) {
    const object = balancedObject(text, match.index + match[0].length - 1);
    if (object && detectFormat(object) === "openapi") return object;
  }
  return null;
}

function wellKnownUrls(base: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return [];
  }
  const origin = parsed.origin;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (candidate: string) => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };

  // swagger-ui-express — which is what NestJS and most Express apps use — mounts the page at
  // `/docs` and the document at `/docs-json`. Derived from the page's own path, so it works
  // wherever it happens to be mounted, and tried first because it is the specific guess.
  const page = parsed.pathname.replace(/\/index\.html?$/i, "").replace(/\/$/, "");
  if (page) {
    add(`${origin}${page}-json`);
    add(`${origin}${page}.json`);
    // Same family, and the one that survives a reverse proxy: an Ingress routing the page by path
    // prefix forwards `<page>/…` and 404s `<page>-json`, because prefix matching is per segment and
    // `docs-json` is a different segment from `docs`. It is also the only candidate that exists at
    // all when the app was set up without `jsonDocumentUrl`.
    add(`${origin}${page}/swagger-ui-init.js`);
  }

  // `https://host/api/swagger-ui/index.html` → try `https://host/api/swagger-ui/…` before the
  // origin, because an app served under a context path publishes its document under the same one.
  const dir = new URL(".", parsed).toString().replace(/\/$/, "");
  for (const root of dir === origin ? [origin] : [dir, origin]) {
    for (const path of WELL_KNOWN_PATHS) add(`${root}${path}`);
  }
  return out;
}

/**
 * Fetches the document at `rawUrl`, following a Swagger UI page to whatever it actually loads.
 *
 * Throws `SpecFetchError` so the caller can say *which* way it failed — "that host didn't answer"
 * and "that page is a Swagger UI we couldn't read a document out of" want different advice.
 */
export async function fetchSpec(rawUrl: string, settings: ApiSettings): Promise<FetchedSpec> {
  const url = normalizeSpecUrl(rawUrl);
  if (!url) throw new SpecFetchError({ code: "badUrl" });

  // The transport rejects with a human-readable string on a transport failure — DNS, TLS, refused
  // connection — so anything that resolves is a real HTTP answer, however unhelpful.
  const first = await apiSendHttp(specRequest(url, settings)).catch((e: unknown) => {
    throw new SpecFetchError({ code: "network", detail: String(e) });
  });
  if (first.status < 200 || first.status >= 300) {
    throw new SpecFetchError({ code: "http", status: first.status });
  }

  const body = first.body_text ?? "";
  if (detectFormat(body)) return { text: body, url, resolvedFrom: null };
  // A page carrying its own description — a single-file export, or the initializer itself pasted in
  // by someone who already did the lookup by hand.
  const inline = embeddedSpec(body);
  if (inline) return { text: inline, url, resolvedFrom: null };

  // Not a document. Walk what the page points at, one level of indirection deep — index.html
  // names swagger-initializer.js, which names swagger-config.json, which names the spec — then
  // fall back to sweeping the well-known paths.
  const visited = new Set<string>([url]);
  const queue = [...referencedUrls(body, url), ...wellKnownUrls(url)];
  let budget = MAX_PROBES;

  while (queue.length > 0 && budget > 0) {
    const candidate = queue.shift() as string;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    budget -= 1;

    const hit = await probe(candidate, settings);
    if (!hit) continue;
    if (detectFormat(hit)) return { text: hit, url: candidate, resolvedFrom: url };
    const embedded = embeddedSpec(hit);
    if (embedded) return { text: embedded, url: candidate, resolvedFrom: url };
    // A config or another shell: put what it references at the front, ahead of the blind sweep.
    queue.unshift(...referencedUrls(hit, candidate).filter((next) => !visited.has(next)));
  }

  throw new SpecFetchError({ code: "notASpec" });
}
