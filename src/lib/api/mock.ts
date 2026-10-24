/**
 * Building a collection's mock routes (`api::mock` serves them).
 *
 * The routes are compiled here, not in Rust, because everything they are made of already lives on
 * this side: the saved request specs, their saved examples, the last response in history, and the
 * OpenAPI importer. What reaches the server is plain rules — method, path, variants — so a mock
 * started from the Services dock serves exactly what the panel shows.
 */

import type { ApiRequestSpec, ApiResponse, ApiVariable, ImportedItem, ImportResult, SavedExample } from "../../types/api";
import type { MockConfig, MockHeader, MockLogEntry, MockRoute, MockVariant } from "../tauri/mockCommands";

const newId = () => crypto.randomUUID();

/** What a mock's log keeps — the same cap as the backend's (`api::mock::LOG_CAP`). */
export const LOG_LIMIT = 500;

export function defaultMockConfig(): MockConfig {
  return { port: 0, exposeLan: false, cors: true, withServices: false, routes: [] };
}

export function newVariant(partial: Partial<MockVariant> = {}): MockVariant {
  return {
    id: newId(),
    name: "",
    matchKind: "always",
    matchKey: "",
    matchValue: "",
    status: 200,
    headers: [],
    body: "",
    ...partial,
  };
}

export function newRoute(partial: Partial<MockRoute> = {}): MockRoute {
  return {
    id: newId(),
    enabled: true,
    name: "",
    method: "GET",
    path: "/",
    source: "manual",
    requestId: null,
    delayMinMs: 0,
    delayMaxMs: 0,
    errorMode: "none",
    errorStatus: 500,
    errorRate: 0,
    variants: [newVariant({ name: "200", body: "{}" })],
    ...partial,
  };
}

/** The variable a URL starts with (`{{baseUrl}}/x` → `baseUrl`), if any. */
function leadingVariable(url: string): string | null {
  const match = /^\s*\{\{\s*([^}\s]+)\s*\}\}/.exec(url);
  return match ? match[1] : null;
}

/** The path part of an absolute URL, without a trailing slash; `""` for none. */
function pathOfUrl(url: string): string {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(url.trim());
  const path = match ? match[1] : url.trim().startsWith("/") ? url.trim().split(/[?#]/)[0] : "";
  return path.replace(/\/+$/, "");
}

/**
 * A request URL as a mock path: the origin (or a leading `{{baseUrl}}`) goes, the query goes, and
 * every `{name}` / `{{name}}` segment becomes `:name`. When the leading variable is one of
 * `variables` holding a URL with a path (`https://api.example.com/v1`), that path is kept in front,
 * because it is part of what the caller will send.
 */
export function mockPathOf(url: string, variables: Pick<ApiVariable, "key" | "initialValue" | "currentValue">[] = []): string {
  let rest = url.trim();
  let prefix = "";
  const lead = leadingVariable(rest);
  if (lead) {
    const variable = variables.find((v) => v.key === lead);
    const value = variable ? variable.currentValue || variable.initialValue : "";
    prefix = pathOfUrl(value);
    rest = rest.replace(/^\s*\{\{[^}]*\}\}/, "");
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rest)) {
    rest = pathOfUrl(rest);
  }
  rest = rest.split(/[?#]/)[0];
  const segments = `${prefix}/${rest}`
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const braces = /^\{\{?\s*([^}]+?)\s*\}?\}$/.exec(segment);
      return braces ? `:${braces[1]}` : segment;
    });
  return `/${segments.join("/")}`;
}

/** Response headers worth replaying: framing and transport ones are the server's to set. */
const HOP_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "content-encoding", "date", "keep-alive"]);

function replayable(headers: MockHeader[]): MockHeader[] {
  return headers.filter((h) => h.key.trim() !== "" && !HOP_HEADERS.has(h.key.trim().toLowerCase()));
}

function variantFromExample(example: SavedExample): MockVariant {
  return newVariant({
    name: example.name || String(example.status),
    status: example.status || 200,
    headers: replayable(example.headers.map((h) => ({ key: h.key, value: h.value, enabled: h.enabled }))),
    body: example.body,
  });
}

function variantFromResponse(response: ApiResponse): MockVariant {
  return newVariant({
    name: String(response.status),
    status: response.status || 200,
    headers: replayable(response.headers.map(([key, value]) => ({ key, value, enabled: true }))),
    body: response.body_text ?? "",
  });
}

/**
 * The variants a set of documented responses becomes. The first 2xx is the default and goes last
 * (the server falls back to the last variant); every other one is picked by `Prefer: code=<status>`,
 * the convention Prism and other mock servers already use for "give me the 404".
 */
export function variantsFromExamples(examples: SavedExample[]): MockVariant[] {
  if (!examples.length) return [];
  const defaultIndex = Math.max(
    0,
    examples.findIndex((e) => e.status >= 200 && e.status < 300),
  );
  const others = examples
    .filter((_, i) => i !== defaultIndex)
    .map((e) => ({ ...variantFromExample(e), matchKind: "header" as const, matchKey: "Prefer", matchValue: `code=${e.status}` }));
  return [...others, variantFromExample(examples[defaultIndex])];
}

export interface RouteSourceRequest {
  id: string | null;
  name: string;
  spec: ApiRequestSpec;
  /** The newest response history holds for it, used when it has no saved example. */
  lastResponse?: ApiResponse | null;
}

export function routeFromRequest(
  request: RouteSourceRequest,
  variables: Pick<ApiVariable, "key" | "initialValue" | "currentValue">[],
  source: MockRoute["source"] = "request",
): MockRoute {
  const examples = request.spec.examples ?? [];
  let variants = variantsFromExamples(examples);
  if (!variants.length && request.lastResponse && !request.lastResponse.error && request.lastResponse.status > 0) {
    variants = [variantFromResponse(request.lastResponse)];
  }
  if (!variants.length) variants = [newVariant({ name: "200", body: "{}" })];
  return newRoute({
    name: request.name,
    method: (request.spec.method || "GET").toUpperCase(),
    path: mockPathOf(request.spec.url, variables),
    source,
    requestId: request.id,
    variants,
  });
}

/** Every HTTP request in an imported document (an OpenAPI/Swagger one, as the panel uses it). */
export function routesFromImport(result: ImportResult): MockRoute[] {
  const routes: MockRoute[] = [];
  for (const collection of result.collections) {
    const walk = (items: ImportedItem[]) => {
      for (const item of items) {
        if (item.kind === "folder") walk(item.items);
        else if (item.spec.protocol === "http")
          routes.push(routeFromRequest({ id: null, name: item.name, spec: item.spec }, collection.variables, "openapi"));
      }
    };
    walk(collection.items);
  }
  return routes;
}

const routeKey = (route: MockRoute) => `${route.method.toUpperCase()} ${route.path.replace(/:[^/]+/g, ":")}`;

/**
 * Adds `incoming` to `existing` without touching a route already there — the same request, or the
 * same method and path. Generating twice must not undo what the user edited after the first time.
 */
export function mergeRoutes(existing: MockRoute[], incoming: MockRoute[]): { routes: MockRoute[]; added: number } {
  const requestIds = new Set(existing.map((r) => r.requestId).filter(Boolean));
  const keys = new Set(existing.map(routeKey));
  const fresh: MockRoute[] = [];
  for (const route of incoming) {
    if (route.requestId && requestIds.has(route.requestId)) continue;
    const key = routeKey(route);
    if (keys.has(key)) continue;
    keys.add(key);
    fresh.push(route);
  }
  return { routes: [...existing, ...fresh], added: fresh.length };
}

/** «Añadir ruta desde esta llamada»: the call's method and path, answering `{}` until edited. */
export function routeFromLog(entry: MockLogEntry): MockRoute {
  return newRoute({
    name: `${entry.method} ${entry.path}`,
    method: entry.method.toUpperCase(),
    path: entry.path,
    source: "log",
  });
}

const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token)$/i;

/** Headers whose value is a credential — masked in the log until the user reveals them. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE.test(name.trim()) || /token|secret|password/i.test(name);
}

export function maskValue(value: string): string {
  return value ? "•".repeat(Math.min(12, Math.max(6, value.length))) : "";
}
