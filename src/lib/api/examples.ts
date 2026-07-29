import type { ApiResponse, SavedExample } from "../../types/api";

/**
 * A saved example rendered as a response the panel can display.
 *
 * An example only ever kept what's worth reading back — status, headers, body — so everything
 * the wire would have supplied is zeroed rather than invented: `-1` timings are the same "not
 * available" the backend uses, and an empty `sent` keeps the console honest about the fact that
 * nothing was sent. The panel hides the metrics that would otherwise read as a real `0 ms`.
 */
export function exampleToResponse(example: SavedExample): ApiResponse {
  return {
    status: example.status,
    status_text: example.statusText,
    http_version: "",
    headers: example.headers
      .filter((header) => header.enabled && header.key.trim() !== "")
      .map((header) => [header.key, header.value] as [string, string]),
    body_text: example.body,
    body_base64: null,
    size_bytes: new TextEncoder().encode(example.body).length,
    duration_ms: 0,
    timings: {
      dns_ms: -1,
      connect_ms: -1,
      tls_ms: -1,
      first_byte_ms: -1,
      download_ms: -1,
      total_ms: -1,
    },
    redirects: [],
    set_cookies: [],
    sent: { method: "", url: "", headers: [], body_preview: "" },
    tests: [],
    consoleLines: [],
    visualizer: null,
    error: null,
  };
}
