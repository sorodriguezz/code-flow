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
 * `<script src="./swagger-initializer.js">` — Swagger UI 4+ moved the config out of the page.
 *
 * Deliberately narrower than "any script with swagger in the name": the page also loads
 * `swagger-ui-bundle.js` and `swagger-ui-standalone-preset.js`, and probing those means
 * downloading a megabyte of minified library to learn it isn't an API description.
 */
const SCRIPT_SRC = /<script[^>]+src\s*=\s*["']([^"']*(?:initializer|swagger-config)[^"']*\.js)["']/gi;

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
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    if (!raw || raw.includes("{{")) return;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
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
  // Ordered by how specific the evidence is: a `url:` field is the document, a script tag is one
  // more hop, and a bare literal is a guess about a string that merely looks like one.
  for (const match of text.matchAll(URL_FIELD)) push(match[1]);
  for (const match of text.matchAll(SCRIPT_SRC)) push(match[1]);
  for (const match of text.matchAll(DOC_URL)) push(match[1]);
  return out;
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
    // A config or another shell: put what it references at the front, ahead of the blind sweep.
    queue.unshift(...referencedUrls(hit, candidate).filter((next) => !visited.has(next)));
  }

  throw new SpecFetchError({ code: "notASpec" });
}
