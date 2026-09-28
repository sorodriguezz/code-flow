import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LIVE_BODY,
  MAX_LIVE_EVENTS,
  applyStreamMessage,
  emptyLiveState,
  provisionalResponse,
  watchStream,
  type HttpStreamMessage,
} from "./liveStream";
import type { ResolvedRequest } from "../../types/api";

const open: HttpStreamMessage = {
  id: "send-1",
  kind: "open",
  status: 200,
  status_text: "OK",
  http_version: "HTTP/1.1",
  headers: [["content-type", "text/event-stream"]],
  sse: true,
  at: 1_000,
};

const request = {
  protocol: "http",
  method: "GET",
  url: "https://api.example.test/v1/events",
  headers: [],
  body: { kind: "none" },
  backendAuth: null,
} as unknown as ResolvedRequest;

afterEach(() => vi.useRealTimers());

describe("applyStreamMessage", () => {
  it("builds the head, the body and the events list as messages arrive", () => {
    let state = applyStreamMessage(emptyLiveState(), open);
    state = applyStreamMessage(state, { id: "send-1", kind: "chunk", text: "data: one\n\n", size: 11, at: 1_010 });
    state = applyStreamMessage(state, { id: "send-1", kind: "event", event: "message", data: "one", last_event_id: "", at: 1_010 });
    expect(state.head?.status).toBe(200);
    expect(state.sse).toBe(true);
    expect(state.body).toBe("data: one\n\n");
    expect(state.size).toBe(11);
    expect(state.events).toEqual([{ at: 1_010, event: "message", data: "one", lastEventId: "" }]);
  });

  it("keeps only the latest events, counting what it let go", () => {
    let state = applyStreamMessage(emptyLiveState(), open);
    for (let i = 0; i < MAX_LIVE_EVENTS + 5; i += 1) {
      state = applyStreamMessage(state, { id: "send-1", kind: "event", event: "tick", data: String(i), last_event_id: "", at: i });
    }
    expect(state.events).toHaveLength(MAX_LIVE_EVENTS);
    expect(state.droppedEvents).toBe(5);
    expect(state.events[0].data).toBe("5");
  });

  it("stops growing the live text at its cap while still counting the bytes", () => {
    let state = applyStreamMessage(emptyLiveState(), open);
    const big = "x".repeat(MAX_LIVE_BODY);
    state = applyStreamMessage(state, { id: "send-1", kind: "chunk", text: big, size: big.length, at: 1 });
    state = applyStreamMessage(state, { id: "send-1", kind: "chunk", text: "more", size: 4, at: 2 });
    expect(state.body.length).toBe(MAX_LIVE_BODY);
    expect(state.size).toBe(MAX_LIVE_BODY + 4);
  });
});

describe("provisionalResponse", () => {
  it("is nothing until the head has arrived, then a live response", () => {
    expect(provisionalResponse(emptyLiveState(), request, 900)).toBeNull();
    const response = provisionalResponse(applyStreamMessage(emptyLiveState(), open), request, 900, 1_500);
    expect(response?.status).toBe(200);
    expect(response?.stream?.live).toBe(true);
    expect(response?.timings.first_byte_ms).toBe(100);
    expect(response?.duration_ms).toBe(600);
    expect(response?.sent.url).toBe("https://api.example.test/v1/events");
  });
});

describe("watchStream", () => {
  it("publishes the head at once, batches what follows, ignores other sends and stops cleanly", async () => {
    vi.useFakeTimers();
    let handler: ((event: { payload: HttpStreamMessage }) => void) | null = null;
    const unlisten = vi.fn();
    const subscribe = (async (_name: string, fn: (event: { payload: HttpStreamMessage }) => void) => {
      handler = fn;
      return unlisten;
    }) as unknown as Parameters<typeof watchStream>[2];

    const published: number[] = [];
    const watcher = await watchStream("send-1", (state) => published.push(state.events.length), subscribe);
    const emit = (payload: HttpStreamMessage) => handler?.({ payload });

    emit(open);
    expect(published).toEqual([0]);
    emit({ id: "send-1", kind: "event", event: "message", data: "a", last_event_id: "", at: 1 });
    emit({ id: "send-1", kind: "event", event: "message", data: "b", last_event_id: "", at: 2 });
    emit({ id: "other-send", kind: "event", event: "message", data: "not ours", last_event_id: "", at: 3 });
    expect(published).toEqual([0]);
    await vi.advanceTimersByTimeAsync(150);
    expect(published).toEqual([0, 2]);

    const final = watcher.stop();
    expect(final.events.map((event) => event.data)).toEqual(["a", "b"]);
    expect(unlisten).toHaveBeenCalledTimes(1);
    emit({ id: "send-1", kind: "event", event: "message", data: "late", last_event_id: "", at: 4 });
    await vi.advanceTimersByTimeAsync(150);
    expect(published).toEqual([0, 2]);
  });
});
