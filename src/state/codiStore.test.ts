import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodiState } from "../lib/tauri/codiCommands";

/**
 * Codi's window draws what this store reduces from the runtime's events — so the reducing is what
 * is pinned: the lists keep the newest first and stop growing, the face's listening is fed only
 * while Codi listens, a confirmation is shown until it is answered, and a microphone that cannot
 * open says why in the right place (what to download, or the privacy page).
 */

const calls = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
  answers: {} as Record<string, (args: Record<string, unknown> | undefined) => unknown>,
  handlers: {} as Record<string, (event: { payload: unknown }) => void>,
  levels: [] as number[],
  ended: 0,
  micErrors: [] as unknown[],
  toasts: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.invoked.push({ cmd, args });
    const answer = calls.answers[cmd];
    return answer ? answer(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    calls.handlers[event] = handler;
    return () => {};
  },
}));
vi.mock("../lib/thinking/listen", () => ({
  setListenLevel: (level: number) => calls.levels.push(level),
  endListen: () => {
    calls.ended += 1;
  },
}));
vi.mock("../lib/thinking/voice", () => ({ startVoice: () => {}, appendVoice: () => {}, endVoice: () => {} }));
vi.mock("../lib/settingsSync", () => ({ watchSettings: () => {} }));
vi.mock("../lib/tauri/commands", () => ({ getSettings: async () => ({}), setSetting: async () => {} }));
vi.mock("./dictationStore", () => ({ reportMicError: (error: unknown) => calls.micErrors.push(error) }));
vi.mock("./toastStore", () => ({ pushErrorToast: (message: string) => calls.toasts.push(message) }));
vi.mock("./languageStore", () => ({ translate: (key: string) => key }));

const store = await import("./codiStore");
const { useCodiStore, ensureCodiEvents, ensureCodiLevel, parseMissing, HEARD_KEPT, TURNS_KEPT } = store;

const state = (over: Partial<CodiState> = {}): CodiState => ({
  phase: "idle",
  mic: true,
  sound: true,
  mode: "wake",
  listenModel: "parakeet",
  missing: [],
  error: null,
  talking: false,
  pttKey: null,
  ...over,
});

/** An event from the backend, as `listen` would hand it over. */
function fire(event: string, payload: unknown) {
  const handler = calls.handlers[event];
  if (!handler) throw new Error(`nobody listens to ${event}`);
  handler({ payload });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  store.resetCodiStoreForTests();
  calls.invoked.length = 0;
  calls.answers = {};
  calls.handlers = {};
  calls.levels.length = 0;
  calls.ended = 0;
  calls.micErrors.length = 0;
  calls.toasts.length = 0;
});

describe("the runtime's events", () => {
  it("reads the state at load and follows it, noting when the phase changed", async () => {
    calls.answers.codi_status = () => state({ phase: "off", mic: false });
    await useCodiStore.getState().load();
    expect(useCodiStore.getState().state?.phase).toBe("off");
    const before = useCodiStore.getState().phaseSince;

    await new Promise((resolve) => setTimeout(resolve, 2));
    fire("codi:state", state({ phase: "thinking" }));
    expect(useCodiStore.getState().state?.phase).toBe("thinking");
    expect(useCodiStore.getState().phaseSince).toBeGreaterThan(before);

    // The same phase again (the talking flag moved) keeps the moment it began.
    const since = useCodiStore.getState().phaseSince;
    fire("codi:state", state({ phase: "thinking", talking: true }));
    expect(useCodiStore.getState().phaseSince).toBe(since);
    expect(useCodiStore.getState().state?.talking).toBe(true);
  });

  it("keeps what it heard newest first, and wakes only on what was said to it", () => {
    ensureCodiEvents();
    fire("codi:heard", { text: "qué hora es", addressed: false, ignored: "name" });
    expect(useCodiStore.getState().wakeAt).toBeNull();
    fire("codi:heard", { text: "codi abre flujos", addressed: true, ignored: null });
    const { heard, wakeAt } = useCodiStore.getState();
    expect(heard.map((line) => line.text)).toEqual(["codi abre flujos", "qué hora es"]);
    expect(heard[1].ignored).toBe("name");
    expect(wakeAt).not.toBeNull();

    for (let i = 0; i < HEARD_KEPT + 3; i += 1) fire("codi:heard", { text: `line ${i}`, addressed: false, ignored: "own" });
    expect(useCodiStore.getState().heard).toHaveLength(HEARD_KEPT);
    expect(useCodiStore.getState().heard[0].text).toBe(`line ${HEARD_KEPT + 2}`);
  });

  it("keeps the turns newest first, once each, up to its limit", () => {
    ensureCodiEvents();
    const turn = (id: number) => ({ id, order: `order ${id}`, reply: "ok", tier: "router", actions: [], ms: 10, error: null });
    fire("codi:turn", turn(1));
    fire("codi:turn", turn(2));
    fire("codi:turn", { ...turn(2), reply: "again" });
    expect(useCodiStore.getState().turns.map((t) => [t.id, t.reply])).toEqual([
      [2, "again"],
      [1, "ok"],
    ]);
    for (let i = 3; i < TURNS_KEPT + 10; i += 1) fire("codi:turn", turn(i));
    expect(useCodiStore.getState().turns).toHaveLength(TURNS_KEPT);
    expect(useCodiStore.getState().turns[0].id).toBe(TURNS_KEPT + 9);
  });

  it("logs what it announced", () => {
    ensureCodiEvents();
    fire("codi:announce", { text: "Revisor: terminó la revisión", source: "review" });
    expect(useCodiStore.getState().announced).toMatchObject([{ text: "Revisor: terminó la revisión", source: "review" }]);
  });
});

describe("the microphone's level", () => {
  it("is drawn only while Codi listens — idle or hearing", () => {
    ensureCodiEvents();
    ensureCodiLevel();
    fire("codi:state", state({ phase: "idle" }));
    fire("codi:level", 0.4);
    fire("codi:state", state({ phase: "hearing" }));
    fire("codi:level", 0.7);
    expect(calls.levels).toEqual([0.4, 0.7]);
    expect(calls.ended).toBe(0);

    fire("codi:state", state({ phase: "thinking" }));
    expect(calls.ended).toBe(1);
    fire("codi:level", 0.9);
    fire("codi:state", state({ phase: "speaking" }));
    fire("codi:level", 0.5);
    expect(calls.levels).toEqual([0.4, 0.7]);

    fire("codi:state", state({ phase: "off", mic: false }));
    fire("codi:level", 0.3);
    expect(calls.levels).toEqual([0.4, 0.7]);
  });
});

describe("a confirmation", () => {
  const question = { id: "q1", action: "git.discard", params: {}, what: "Descartar 3 cambios", answer: null };

  it("is shown when asked and cleared by its own answer only", () => {
    ensureCodiEvents();
    fire("codi:confirm", question);
    expect(useCodiStore.getState().confirmation?.id).toBe("q1");
    fire("codi:confirm", { ...question, id: "other", answer: true });
    expect(useCodiStore.getState().confirmation?.id).toBe("q1");
    fire("codi:confirm", { ...question, answer: false });
    expect(useCodiStore.getState().confirmation).toBeNull();
  });

  it("is answered from the card, and gone at once", async () => {
    ensureCodiEvents();
    fire("codi:confirm", question);
    await useCodiStore.getState().confirm(true);
    expect(useCodiStore.getState().confirmation).toBeNull();
    expect(calls.invoked).toContainEqual({ cmd: "codi_confirm", args: { id: "q1", yes: true } });
  });

  it("does not outlive the wait", () => {
    ensureCodiEvents();
    fire("codi:state", state({ phase: "waiting" }));
    fire("codi:confirm", question);
    fire("codi:state", state({ phase: "acting" }));
    expect(useCodiStore.getState().confirmation).toBeNull();
  });
});

describe("opening the microphone", () => {
  it("reads what is missing from the refusal", () => {
    expect(parseMissing("CODI_MISSING:library,detector,listener")).toEqual(["library", "detector", "listener"]);
    expect(parseMissing("Error: CODI_MISSING:listener:parakeet")).toEqual(["listener"]);
    expect(parseMissing("MIC_DENIED")).toBeNull();
  });

  it("offers to prepare what is missing instead of reporting a microphone error", async () => {
    useCodiStore.setState({ state: state({ phase: "off", mic: false }) });
    calls.answers.codi_set_mic = () => Promise.reject("CODI_MISSING:library,listener");
    calls.answers.codi_status = () => state({ phase: "off", mic: false, missing: ["library", "listener"] });
    await useCodiStore.getState().setMic(true);
    expect(useCodiStore.getState().state?.missing).toEqual(["library", "listener"]);
    expect(calls.micErrors).toEqual([]);
  });

  it("hands a refused microphone to dictation's privacy path", async () => {
    useCodiStore.setState({ state: state({ phase: "off", mic: false }) });
    calls.answers.codi_set_mic = () => Promise.reject("MIC_DENIED");
    await useCodiStore.getState().setMic(true);
    expect(calls.micErrors).toEqual(["MIC_DENIED"]);
    expect(useCodiStore.getState().switching).toBe(false);
  });

  it("prepares, then opens the microphone — and a late progress frame does not restart the bar", async () => {
    ensureCodiEvents();
    useCodiStore.setState({ state: state({ phase: "off", mic: false, missing: ["detector"] }) });
    let finish: (value: CodiState) => void = () => {};
    calls.answers.codi_prepare = () => new Promise<CodiState>((resolve) => (finish = resolve));
    calls.answers.codi_set_mic = (args) => state({ phase: "idle", mic: !!args?.on });

    const running = useCodiStore.getState().prepareAndListen();
    await flush();
    fire("codi:prepare", { item: "detector", done: 300, total: 600 });
    expect(useCodiStore.getState().prepare).toMatchObject({ running: true, item: "detector", done: 300, total: 600 });

    finish(state({ phase: "off", mic: false, missing: [] }));
    await running;
    expect(calls.invoked.some((call) => call.cmd === "codi_set_mic" && call.args?.on === true)).toBe(true);
    expect(useCodiStore.getState().state?.mic).toBe(true);
    expect(useCodiStore.getState().prepare.running).toBe(false);

    fire("codi:prepare", { item: "detector", done: 600, total: 600 });
    expect(useCodiStore.getState().prepare.running).toBe(false);
  });
});
