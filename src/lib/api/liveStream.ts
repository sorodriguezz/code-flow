/**
 * A streamed response, assembled in the UI while it arrives.
 *
 * The backend emits `api:http-stream` for a tracked send whose response is `text/event-stream` (or
 * that asked to stream): the head as soon as it lands, then the body as text chunks and — for an
 * event stream — each parsed event. The final `HttpResponse` still arrives when the send ends, the
 * same as for any request; this is only what is on screen *before* then, and the events list,
 * which the final response has no field for.
 *
 * Bounded twice over, because a stream may never end: the events list keeps the latest
 * `MAX_LIVE_EVENTS` (counting what it let go), and the live body text stops growing at
 * `MAX_LIVE_BODY` — the backend applies the real body cap to what the final response keeps.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ApiResponse, ResolvedRequest, ResponseStream, StreamedEvent } from "../../types/api";

export const MAX_LIVE_EVENTS = 2000;
export const MAX_LIVE_BODY = 2 * 1024 * 1024;

/** One `api:http-stream` message, as `api::stream::HttpStreamMessage` serialises it. */
export type HttpStreamMessage = { id: string } & (
  | {
      kind: "open";
      status: number;
      status_text: string;
      http_version: string;
      headers: [string, string][];
      sse: boolean;
      at: number;
    }
  | { kind: "chunk"; text: string; size: number; at: number }
  | { kind: "event"; event: string; data: string; last_event_id: string; at: number }
);

export interface LiveState {
  head: { status: number; statusText: string; httpVersion: string; headers: [string, string][] } | null;
  sse: boolean;
  body: string;
  /** Bytes received, whether or not the live text still grows. */
  size: number;
  openedAt: number;
  events: StreamedEvent[];
  droppedEvents: number;
}

export function emptyLiveState(): LiveState {
  return { head: null, sse: false, body: "", size: 0, openedAt: 0, events: [], droppedEvents: 0 };
}

/** Folds one message into the state. Returns a new object; the event array is copied on write. */
export function applyStreamMessage(state: LiveState, message: HttpStreamMessage): LiveState {
  switch (message.kind) {
    case "open":
      return {
        ...state,
        head: {
          status: message.status,
          statusText: message.status_text,
          httpVersion: message.http_version,
          headers: message.headers,
        },
        sse: message.sse,
        openedAt: message.at,
      };
    case "chunk": {
      const room = MAX_LIVE_BODY - state.body.length;
      return {
        ...state,
        body: room > 0 ? state.body + message.text.slice(0, room) : state.body,
        size: state.size + message.size,
      };
    }
    case "event": {
      const events = [
        ...state.events,
        { at: message.at, event: message.event, data: message.data, lastEventId: message.last_event_id },
      ];
      const overflow = Math.max(0, events.length - MAX_LIVE_EVENTS);
      return {
        ...state,
        events: overflow > 0 ? events.slice(overflow) : events,
        droppedEvents: state.droppedEvents + overflow,
      };
    }
  }
}

export function streamOf(state: LiveState, live: boolean): ResponseStream {
  return { live, sse: state.sse, events: state.events, droppedEvents: state.droppedEvents };
}

/** What the response panel shows while the body is still arriving; `null` until the head has. */
export function provisionalResponse(
  state: LiveState,
  request: ResolvedRequest,
  startedAt: number,
  now = Date.now(),
): ApiResponse | null {
  if (state.head === null) return null;
  const elapsed = Math.max(0, now - startedAt);
  return {
    status: state.head.status,
    status_text: state.head.statusText,
    http_version: state.head.httpVersion,
    headers: state.head.headers,
    body_text: state.body,
    body_base64: null,
    size_bytes: state.size,
    duration_ms: elapsed,
    timings: {
      dns_ms: -1,
      connect_ms: -1,
      tls_ms: -1,
      first_byte_ms: Math.max(0, state.openedAt - startedAt),
      download_ms: -1,
      total_ms: elapsed,
    },
    redirects: [],
    set_cookies: [],
    sent: { method: request.method, url: request.url, headers: request.headers, body_preview: "" },
    tests: [],
    consoleLines: [],
    visualizer: null,
    error: null,
    stream: streamOf(state, true),
  };
}

/** How often the panel is re-rendered while a stream flows — enough to feel live, not per event. */
const PUBLISH_EVERY_MS = 100;

/**
 * Listens for one send's messages. `publish` is called at most every `PUBLISH_EVERY_MS` with the
 * state so far; `stop()` ends the listening and hands back the final state.
 */
export async function watchStream(
  trackId: string,
  publish: (state: LiveState) => void,
  subscribe: typeof listen = listen,
): Promise<{ stop: () => LiveState }> {
  let state = emptyLiveState();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const flush = () => {
    timer = null;
    if (!stopped) publish(state);
  };
  const unlisten: UnlistenFn = await subscribe<HttpStreamMessage>("api:http-stream", (event) => {
    if (stopped || event.payload.id !== trackId) return;
    const first = state.head === null && event.payload.kind === "open";
    state = applyStreamMessage(state, event.payload);
    // The head is shown the moment it lands; everything after it is batched.
    if (first) flush();
    else if (timer === null) timer = setTimeout(flush, PUBLISH_EVERY_MS);
  });
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      unlisten();
      return state;
    },
  };
}
