import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LIVE_CONVERSATIONS,
  pickEvictions,
  reduceDelta,
  revealedLength,
  startTypewriter,
  questionBehind,
  traceOf,
  type ConversationMessage,
  type EvictionCandidate,
  type StreamingBuffers,
} from "./conversationStore";
import type { AiChatDeltaEvent } from "../lib/tauri/events";

/** The three pieces of this store that need no backend: the reveal scheduler, the memory cap and
 *  the delta reducer. Everything else in the file talks to `invoke`. */

const EMPTY: StreamingBuffers = { text: {}, thinking: {} };

function delta(over: Partial<AiChatDeltaEvent> = {}): AiChatDeltaEvent {
  return {
    runId: "chat-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    kind: "text",
    text: "",
    ...over,
  };
}

describe("reduceDelta", () => {
  it("appends fragments in arrival order", () => {
    let buffers = reduceDelta(EMPTY, delta({ text: "Hel" }));
    buffers = reduceDelta(buffers, delta({ text: "lo, " }));
    buffers = reduceDelta(buffers, delta({ text: "world" }));
    expect(buffers.text["msg-1"]).toBe("Hello, world");
  });

  it("keeps thinking out of the answer", () => {
    let buffers = reduceDelta(EMPTY, delta({ kind: "thinking", text: "let me check" }));
    buffers = reduceDelta(buffers, delta({ text: "The answer is 4." }));
    expect(buffers.text["msg-1"]).toBe("The answer is 4.");
    expect(buffers.thinking["msg-1"]).toBe("let me check");
  });

  it("keeps two concurrent answers apart", () => {
    let buffers = reduceDelta(EMPTY, delta({ messageId: "a", text: "one" }));
    buffers = reduceDelta(buffers, delta({ messageId: "b", text: "two" }));
    buffers = reduceDelta(buffers, delta({ messageId: "a", text: " more" }));
    expect(buffers.text).toEqual({ a: "one more", b: "two" });
  });

  it("returns the same object for an empty chunk", () => {
    // A stray event must not re-render every subscriber of the store.
    const buffers = reduceDelta(EMPTY, delta({ text: "hi" }));
    expect(reduceDelta(buffers, delta({ text: "" }))).toBe(buffers);
  });

  it("never mutates the buffers it was given", () => {
    const before = reduceDelta(EMPTY, delta({ text: "one" }));
    const after = reduceDelta(before, delta({ text: " two" }));
    expect(before.text["msg-1"]).toBe("one");
    expect(after.text["msg-1"]).toBe("one two");
    expect(after.text).not.toBe(before.text);
  });

  it("does not copy the other buffer when only one side moved", () => {
    const before = reduceDelta(EMPTY, delta({ kind: "thinking", text: "hm" }));
    const after = reduceDelta(before, delta({ text: "answer" }));
    expect(after.thinking).toBe(before.thinking);
  });
});

describe("revealedLength", () => {
  it("shows nothing before the first frame", () => {
    expect(revealedLength(100, 0)).toBe(0);
    expect(revealedLength(100, -5)).toBe(0);
  });

  it("uncovers at the configured rate", () => {
    // 600 chars/sec — half a second is three hundred characters.
    expect(revealedLength(1000, 500)).toBe(300);
    expect(revealedLength(1000, 1000)).toBe(600);
  });

  it("never runs past the end of the text", () => {
    expect(revealedLength(10, 60_000)).toBe(10);
  });

  it("honours a custom rate", () => {
    expect(revealedLength(1000, 1000, 100)).toBe(100);
  });
});

describe("startTypewriter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes immediately on an empty answer", () => {
    const frames: [string, boolean][] = [];
    startTypewriter("", (visible, done) => frames.push([visible, done]));
    expect(frames).toEqual([["", true]]);
  });

  it("uncovers the text a frame at a time and ends on the whole of it", () => {
    vi.useFakeTimers();
    let clock = 0;
    const frames: string[] = [];
    let finished = false;
    // 600 chars/sec with 100ms frames: sixty characters per frame.
    startTypewriter(
      "x".repeat(180),
      (visible, done) => {
        frames.push(visible);
        finished = done;
      },
      { tickMs: 100, now: () => clock },
    );

    clock = 100;
    vi.advanceTimersByTime(100);
    expect(frames[0]).toHaveLength(60);
    expect(finished).toBe(false);

    clock = 200;
    vi.advanceTimersByTime(100);
    expect(frames[1]).toHaveLength(120);

    clock = 300;
    vi.advanceTimersByTime(100);
    expect(frames[2]).toHaveLength(180);
    expect(finished).toBe(true);
  });

  it("stops scheduling once it is done", () => {
    vi.useFakeTimers();
    let clock = 0;
    const frames: string[] = [];
    startTypewriter("abc", (visible) => frames.push(visible), { tickMs: 100, now: () => clock });
    clock = 10_000;
    vi.advanceTimersByTime(100);
    expect(frames).toEqual(["abc"]);
    vi.advanceTimersByTime(10_000);
    expect(frames).toEqual(["abc"]);
  });

  it("jumps to the end on finish, emitting the final frame exactly once", () => {
    vi.useFakeTimers();
    let clock = 0;
    const frames: [string, boolean][] = [];
    const typewriter = startTypewriter("hello world", (visible, done) => frames.push([visible, done]), {
      tickMs: 100,
      now: () => clock,
    });
    typewriter.finish();
    expect(frames).toEqual([["hello world", true]]);
    // The interval is gone, so nothing else can arrive behind the final frame.
    clock = 10_000;
    vi.advanceTimersByTime(10_000);
    expect(frames).toHaveLength(1);
  });

  it("emits nothing after cancel", () => {
    vi.useFakeTimers();
    let clock = 0;
    const frames: string[] = [];
    const typewriter = startTypewriter("hello", (visible) => frames.push(visible), {
      tickMs: 100,
      now: () => clock,
    });
    typewriter.cancel();
    clock = 10_000;
    vi.advanceTimersByTime(10_000);
    expect(frames).toEqual([]);
  });

  it("catches up after a dropped frame rather than stretching the reveal", () => {
    vi.useFakeTimers();
    let clock = 0;
    const frames: string[] = [];
    startTypewriter("x".repeat(600), (visible) => frames.push(visible), { tickMs: 100, now: () => clock });
    // One tick, but a whole second of wall clock went by — a backgrounded window, a slow render.
    clock = 1000;
    vi.advanceTimersByTime(100);
    expect(frames[0]).toHaveLength(600);
  });
});

describe("pickEvictions", () => {
  function candidate(id: string, over: Partial<EvictionCandidate> = {}): EvictionCandidate {
    return { id, sending: false, active: false, persisted: true, holdsUnwritten: false, ...over };
  }

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `conv-${i}`);

  it("keeps everything while under the cap", () => {
    const list = ids(MAX_LIVE_CONVERSATIONS).map((id) => candidate(id));
    expect(pickEvictions(ids(MAX_LIVE_CONVERSATIONS), list)).toEqual([]);
  });

  it("drops the least recently used down to the cap", () => {
    const list = ids(8).map((id) => candidate(id));
    expect(pickEvictions(ids(8), list)).toEqual(["conv-0", "conv-1", "conv-2"]);
  });

  it("never collapses a turn in flight", () => {
    const list = ids(7).map((id) => candidate(id, { sending: id === "conv-0" }));
    // conv-0 is oldest but is answering, so the next two go instead.
    expect(pickEvictions(ids(7), list)).toEqual(["conv-1", "conv-2"]);
  });

  it("never collapses what is on screen", () => {
    const list = ids(7).map((id) => candidate(id, { active: id === "conv-1" }));
    expect(pickEvictions(ids(7), list)).toEqual(["conv-0", "conv-2"]);
  });

  it("never collapses a transcript disk cannot bring back", () => {
    const list = ids(8).map((id) =>
      candidate(id, { persisted: id !== "conv-0", holdsUnwritten: id === "conv-1" }),
    );
    expect(pickEvictions(ids(8), list)).toEqual(["conv-2", "conv-3", "conv-4"]);
  });

  it("treats an untouched conversation as freshest", () => {
    const list = ids(7).map((id) => candidate(id));
    // Only two ids were ever opened, so only those two can be candidates — and dropping both still
    // leaves five, which is the cap.
    expect(pickEvictions(["conv-3", "conv-6"], list)).toEqual(["conv-3", "conv-6"]);
  });

  it("ignores ids in the order that no longer exist", () => {
    const list = ids(6).map((id) => candidate(id));
    expect(pickEvictions(["gone-1", "conv-0", "gone-2"], list)).toEqual(["conv-0"]);
  });

  it("keeps everything when nothing is evictable", () => {
    const list = ids(9).map((id) => candidate(id, { sending: true }));
    expect(pickEvictions(ids(9), list)).toEqual([]);
  });
});

describe("traceOf", () => {
  it("answers undefined for a row read without traces", () => {
    expect(traceOf(null)).toBeUndefined();
    expect(traceOf(undefined)).toBeUndefined();
  });

  it("reads the stored JSON shape", () => {
    const raw = JSON.stringify([
      { stream: "stdout", line: "hello" },
      { stream: "stderr", line: "oops" },
    ]);
    expect(traceOf(raw)).toEqual([
      { stream: "stdout", text: "hello" },
      { stream: "stderr", text: "oops" },
    ]);
  });

  it("reads an already-parsed array too", () => {
    expect(traceOf([{ stream: "stderr", line: "oops" }])).toEqual([{ stream: "stderr", text: "oops" }]);
  });

  it("passes formatted entries through", () => {
    expect(traceOf([{ stream: "stdout", text: "already formatted" }])).toEqual([
      { stream: "stdout", text: "already formatted" },
    ]);
  });

  it("survives anything that is not a trace", () => {
    expect(traceOf("{not json")).toBeUndefined();
    expect(traceOf(42)).toBeUndefined();
    expect(traceOf([1, null, "two"])).toBeUndefined();
  });
});

describe("questionBehind", () => {
  /** A transcript the way `chat_queries` orders one: the question and its answer share a turn. */
  function exchange(turn: number, question: string, answer: string): ConversationMessage[] {
    const base = {
      conversationId: "conv-1",
      provider: "claude",
      model: null,
      engineVersion: null,
      responseTimeMs: null,
      isError: false,
      isCancelled: false,
      createdAt: turn * 1000,
    } as unknown as ConversationMessage;
    return [
      { ...base, id: `u${turn}`, turn, role: "user", content: question },
      { ...base, id: `a${turn}`, turn, role: "assistant", content: answer },
    ];
  }

  it("finds the question of the very first exchange", () => {
    // The case Regenerate did nothing at all on: with `<` there is no user message before turn 0.
    const messages = exchange(0, "why is the sky blue?", "Rayleigh scattering.");
    expect(questionBehind(messages, 0)?.content).toBe("why is the sky blue?");
  });

  it("finds this exchange's question, not the one before it", () => {
    const messages = [
      ...exchange(0, "why is the sky blue?", "Rayleigh scattering."),
      ...exchange(1, "and at sunset?", "Longer path, more scattering."),
    ];
    expect(questionBehind(messages, 1)?.content).toBe("and at sunset?");
  });

  it("reaches back when an exchange has no question of its own", () => {
    // A turn the engine added without being asked — a continuation — still regenerates from the
    // last question that was actually put to it.
    const messages = [
      ...exchange(0, "summarise this", "Part one."),
      { ...exchange(1, "", "Part two.")[1], id: "a1" },
    ];
    expect(questionBehind(messages, 1)?.content).toBe("summarise this");
  });

  it("answers null when nothing was ever asked", () => {
    expect(questionBehind([], 0)).toBeNull();
    expect(questionBehind(exchange(3, "later", "answer"), 1)).toBeNull();
  });
});
