import { defaultBody, type ApiProtocol, type ApiRequestSpec } from "../../types/api";

/**
 * Full protocol names for the picker. Unlike the abbreviations in `methodStyle.ts` these are
 * still product names — "GraphQL" and "MQTT" are spelled the same in every language — so they
 * are not translation keys. The *descriptions* beside them are, and live in `api.protocolHint.*`.
 */
export const PROTOCOL_NAMES: Record<ApiProtocol, string> = {
  http: "HTTP",
  graphql: "GraphQL",
  websocket: "WebSocket",
  socketio: "Socket.IO",
  grpc: "gRPC",
  mqtt: "MQTT",
};

/**
 * Retargets a request at a different protocol, keeping everything the new one can still use.
 *
 * The URL, headers, auth, scripts, description and per-request settings all survive: switching a
 * REST call to GraphQL against the same endpoint with the same bearer token is the common reason
 * anyone does this, and making them retype it would defeat the point. What changes is only what
 * would otherwise be left in a state the new protocol can't express:
 *
 * - **GraphQL is POST with a GraphQL body.** Nothing else is a valid GraphQL request, so the
 *   method and body mode are forced rather than offered.
 * - **Leaving GraphQL** would strand `body.mode = "graphql"` on a protocol with no GraphQL
 *   editor, so the body resets — but the query itself is kept, so flipping back and forth by
 *   accident doesn't destroy it.
 *
 * The protocol-specific blocks (`websocket`, `socketio`, `mqtt`, `grpc`) are always carried
 * across untouched: they cost nothing when inactive, and discarding a configured broker or a
 * loaded `.proto` path because the user glanced at another protocol would be its own bug.
 */
export function switchProtocol(spec: ApiRequestSpec, next: ApiProtocol): ApiRequestSpec {
  if (spec.protocol === next) return spec;

  if (next === "graphql") {
    return {
      ...spec,
      protocol: next,
      method: "POST",
      body: { ...spec.body, mode: "graphql" },
    };
  }

  const body = spec.body.mode === "graphql" ? { ...spec.body, mode: defaultBody().mode } : spec.body;
  return { ...spec, protocol: next, body };
}
