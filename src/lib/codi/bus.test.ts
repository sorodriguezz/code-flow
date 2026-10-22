import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bus: every window hears every `codi:act`, so each must answer only its own label — and answer
 * every one of those exactly once, with `ok: false` when the handler throws rather than silence.
 */

const calls = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  emitted: [] as { target: string; event: string; payload: unknown }[],
  handler: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.invoked.push({ cmd, args });
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === "codi:act") calls.handler = handler;
    return () => {};
  },
  emit: async () => {},
  emitTo: async (target: string, event: string, payload: unknown) => {
    calls.emitted.push({ target, event, payload });
  },
}));
vi.mock("../windowIdentity", () => ({
  WINDOW: { label: "main", main: true, satellite: null, openedIn: null },
  MAIN_LABEL: "main",
  isMainWindow: () => true,
}));
vi.mock("../../state/windowStore", () => ({
  useWindowStore: {
    getState: () => ({ satellites: [{ label: "sat-app-notes", kind: "app", ref_id: "notes" }] }),
  },
}));
vi.mock("../../state/languageStore", () => ({
  useLanguageStore: { getState: () => ({ language: "en" }), subscribe: () => () => {} },
  translate: (key: string) => key,
}));
vi.mock("./actions", () => ({
  catalogueFor: () => [
    {
      id: "test.echo",
      title: { en: "Echo", es: "Eco" },
      params: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      risk: "read",
      where: "any",
      run: async (params: Record<string, unknown>) => ({ result: params, say: `said ${String(params.text)}` }),
    },
    {
      id: "test.boom",
      title: { en: "Boom", es: "Bum" },
      params: { type: "object", properties: {} },
      risk: "read",
      where: "any",
      run: async () => {
        throw new Error("handler exploded");
      },
    },
    {
      id: "notes.create",
      title: { en: "Note", es: "Nota" },
      params: { type: "object", properties: {} },
      risk: "write",
      where: "app:notes",
      run: async () => ({ say: "should not run here" }),
    },
  ],
}));

const { startCodiBus, handleCodiRequest, resetCodiBusForTests } = await import("./bus");

const results = () => calls.invoked.filter((c) => c.cmd === "codi_act_result").map((c) => c.args.answer);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  calls.invoked.length = 0;
  calls.emitted.length = 0;
});

describe("the Codi bus", () => {
  it("registers this window's catalogue under its label, without the functions", async () => {
    resetCodiBusForTests();
    startCodiBus();
    await settle();
    const register = calls.invoked.find((c) => c.cmd === "codi_register_actions");
    expect(register?.args.window).toBe("main");
    const specs = register?.args.actions as { id: string; run?: unknown }[];
    expect(specs.map((s) => s.id)).toEqual(["test.echo", "test.boom", "notes.create"]);
    expect(specs.every((s) => s.run === undefined)).toBe(true);
    expect(calls.handler).not.toBeNull();
  });

  it("answers only requests carrying its own label", async () => {
    calls.handler?.({ payload: { id: "a", window: "sat-app-notes", action: "test.echo", params: { text: "hi" } } });
    await settle();
    expect(results()).toEqual([]);
    calls.handler?.({ payload: { id: "b", window: "main", action: "test.echo", params: { text: "hi" } } });
    await settle();
    expect(results()).toEqual([{ id: "b", ok: true, result: { text: "hi" }, say: "said hi" }]);
  });

  it("turns a throwing handler, bad params and an unknown id into ok:false", async () => {
    await handleCodiRequest({ id: "c", window: "main", action: "test.boom", params: {} });
    await handleCodiRequest({ id: "d", window: "main", action: "test.echo", params: {} });
    await handleCodiRequest({ id: "e", window: "main", action: "no.such", params: {} });
    const [boom, bad, unknown] = results() as { id: string; ok: boolean; error: string }[];
    expect(boom).toEqual({ id: "c", ok: false, error: "handler exploded" });
    expect(bad).toMatchObject({ id: "d", ok: false });
    expect(bad.error).toContain('missing "text"');
    expect(unknown).toEqual({ id: "e", ok: false, error: "unknown action" });
  });

  it("hands an app's action to the island holding that app, and answers nothing itself", async () => {
    await handleCodiRequest({ id: "f", window: "main", action: "notes.create", params: {} });
    expect(results()).toEqual([]);
    expect(calls.emitted).toEqual([
      { target: "sat-app-notes", event: "codi:act", payload: { id: "f", window: "sat-app-notes", action: "notes.create", params: {} } },
    ]);
  });
});
