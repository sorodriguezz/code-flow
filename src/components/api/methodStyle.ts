import type { ApiProtocol } from "../../types/api";

/**
 * The colour of the verb badge in the tab strip, the tree and the URL bar.
 *
 * Only palette tokens appear here, never a literal — the app has themes and a user-chosen accent,
 * and a hardcoded green would survive exactly one theme. That's also why PUT and PATCH share the
 * accent instead of the blue/purple Postman gives them: there is no fifth semantic colour to
 * spend, and inventing one would break the moment the user picks a different accent.
 */
const METHOD_COLORS: Record<string, string> = {
  GET: "var(--cf-success)",
  POST: "var(--cf-warning)",
  PUT: "var(--cf-accent)",
  PATCH: "var(--cf-accent)",
  DELETE: "var(--cf-danger)",
};

/** Protocol abbreviations are product names, not UI copy — they read the same in every language. */
const PROTOCOL_LABELS: Record<Exclude<ApiProtocol, "http">, string> = {
  graphql: "GQL",
  websocket: "WS",
  socketio: "IO",
  grpc: "gRPC",
  mqtt: "MQTT",
};

/** What the badge says: the HTTP verb, or the protocol for everything that isn't plain HTTP. */
export function badgeLabel(protocol: ApiProtocol, method: string): string {
  if (protocol !== "http") return PROTOCOL_LABELS[protocol];
  return (method.trim() || "GET").toUpperCase();
}

export function badgeColor(protocol: ApiProtocol, method: string): string {
  if (protocol === "graphql") return "var(--cf-accent)";
  if (protocol !== "http") return "var(--cf-text-muted)";
  return METHOD_COLORS[(method.trim() || "GET").toUpperCase()] ?? "var(--cf-text-muted)";
}
