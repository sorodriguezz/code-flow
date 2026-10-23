import { beforeEach, describe, expect, it } from "vitest";
import {
  CodiError,
  clearActionsForTests,
  installScreenHistory,
  registerAction,
  runRequest,
  undoDepth,
  undoNavigation,
  validateParams,
  type CodiAction,
  type ParamSchema,
} from "./registry";

/**
 * The catalogue's gate. A model calls these, often a small local one, so the validator has to repair
 * the slips with one reading ("12" for 12, "Flows" for "flows") and refuse the rest with an error the
 * next try can be built from — and `runRequest` must never throw, whatever the handler does.
 */

const schema: ParamSchema = {
  type: "object",
  properties: {
    app: { type: "string", enum: ["api:requests", "notes", "flows"] },
    line: { type: "integer", minimum: 1 },
    send: { type: "boolean" },
    name: { type: "string", minLength: 1 },
    tab: { type: "string" },
  },
  required: ["app"],
};

describe("validateParams", () => {
  it("passes what the schema allows, untouched", () => {
    expect(validateParams(schema, { app: "notes", line: 3, send: true })).toEqual({
      ok: true,
      params: { app: "notes", line: 3, send: true },
    });
  });

  it("names a missing required key and what it takes", () => {
    const checked = validateParams(schema, {});
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toContain('missing "app"');
    expect(checked.error).toContain("one of: api:requests, notes, flows");
    // …and lists every key, so the next try can be complete.
    expect(checked.error).toContain("line?: integer");
  });

  it("repairs the slips that have exactly one reading", () => {
    expect(validateParams(schema, { app: "Flows", line: "12", send: "true" })).toEqual({
      ok: true,
      params: { app: "flows", line: 12, send: true },
    });
    // Separators fold away too: a spoken "api requests" is the key `api:requests`.
    expect(validateParams(schema, { app: "api requests" })).toEqual({ ok: true, params: { app: "api:requests" } });
  });

  it("takes a value by the name a person gives it, when one value answers to it", () => {
    // «abre la aplicación de base de datos»: a model wrote what it heard instead of the key.
    const names = { app: { "api:requests": { es: ["peticiones", "cliente api"], en: ["requests"] }, notes: { es: ["notas"], en: ["notes"] } } };
    expect(validateParams(schema, { app: "requests" })).toEqual({ ok: true, params: { app: "api:requests" } });
    expect(validateParams(schema, { app: "Cliente API" }, names)).toEqual({ ok: true, params: { app: "api:requests" } });
    expect(validateParams(schema, { app: "notas" }, names)).toEqual({ ok: true, params: { app: "notes" } });
    expect(validateParams(schema, { app: "calendario" }, names).ok).toBe(false);
    // A part, the words, a slipped letter: still one value.
    expect(validateParams(schema, { app: "la app de notas" }, names)).toEqual({ ok: true, params: { app: "notes" } });
    expect(validateParams(schema, { app: "peticion" }, names)).toEqual({ ok: true, params: { app: "api:requests" } });
    expect(validateParams(schema, { app: "flujos" }, { app: { flows: { es: ["flujos"], en: ["flows"] } } })).toEqual({ ok: true, params: { app: "flows" } });
    expect(validateParams(schema, { app: "flowz" })).toEqual({ ok: true, params: { app: "flows" } });
  });

  it("refuses a value outside the enum, listing the enum", () => {
    const checked = validateParams(schema, { app: "calendar" });
    expect(checked).toMatchObject({ ok: false });
    if (!checked.ok) expect(checked.error).toContain('"app" must be one of: api:requests, notes, flows');
  });

  it("refuses wrong types and out-of-range numbers", () => {
    const checked = validateParams(schema, { app: "notes", line: 0, send: "maybe" });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toContain('"line" must be at least 1');
    expect(checked.error).toContain('"send" must be true or false');
  });

  it("drops unknown keys and an empty optional string, but keeps the backend's confirmed", () => {
    expect(validateParams(schema, { app: "notes", nmae: "x", tab: "", confirmed: true })).toEqual({
      ok: true,
      params: { app: "notes", confirmed: true },
    });
  });

  it("refuses an empty required string through its minLength", () => {
    const checked = validateParams({ type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] }, { name: "  " });
    expect(checked).toMatchObject({ ok: false });
    if (!checked.ok) expect(checked.error).toContain('"name" must not be empty');
  });

  it("treats missing params as an empty object, and anything else as an error", () => {
    expect(validateParams({ type: "object", properties: {} }, undefined)).toEqual({ ok: true, params: {} });
    expect(validateParams({ type: "object", properties: {} }, [1, 2])).toEqual({ ok: false, error: "params must be an object" });
  });
});

function action(id: string, run: CodiAction["run"], params: Record<string, unknown> = { type: "object", properties: {} }): CodiAction {
  return { id, title: { en: id, es: id }, params, risk: "read", where: "any", run };
}

describe("runRequest", () => {
  beforeEach(() => clearActionsForTests());

  it("answers an unknown id with ok:false", async () => {
    const { answer } = await runRequest({ id: "1", window: "main", action: "nope", params: {} }, "main");
    expect(answer).toEqual({ id: "1", ok: false, error: "unknown action" });
  });

  it("refuses bad params before the handler runs, prefixed with the action", async () => {
    let ran = false;
    registerAction(
      action("app.open", async () => {
        ran = true;
        return {};
      }, schema as Record<string, unknown>),
    );
    const { answer } = await runRequest({ id: "2", window: "main", action: "app.open", params: { app: "calendar" } }, "main");
    expect(ran).toBe(false);
    expect(answer?.ok).toBe(false);
    expect(answer?.error).toMatch(/^app\.open: "app" must be one of/);
  });

  it("asks about a value it cannot place instead of only failing", async () => {
    const names = { app: { "api:requests": { es: ["peticiones"], en: ["requests"] }, notes: { es: ["notas"], en: ["notes"] }, flows: { es: ["flujos"], en: ["flows"] } } };
    registerAction({ ...action("app.open", async () => ({}), schema as Record<string, unknown>), vocabulary: names });
    // One nearest: «¿quisiste decir…?», and a yes runs it with that value.
    const near = (await runRequest({ id: "n", window: "main", action: "app.open", params: { app: "notitas" } }, "main")).answer;
    expect(near?.ok).toBe(false);
    expect(near?.say).toContain("notitas");
    expect(near?.offer).toMatchObject({ action: "app.open", params: { app: "notes" } });
    // Several answering: which one, nothing run on a yes.
    const both = (await runRequest({ id: "b", window: "main", action: "app.open", params: { app: "s" } }, "main")).answer;
    expect(both?.ok).toBe(false);
    expect(both?.offer).toBeUndefined();
    // Nothing near: the error alone, for the model's next try.
    const none = (await runRequest({ id: "x", window: "main", action: "app.open", params: { app: "calendario" } }, "main")).answer;
    expect(none).toMatchObject({ ok: false });
    expect(none?.say).toBeUndefined();
  });

  it("hands the handler its checked params and returns result and say", async () => {
    registerAction(action("app.open", async (params) => ({ result: params, say: "Listo" }), schema as Record<string, unknown>));
    const { answer } = await runRequest({ id: "3", window: "main", action: "app.open", params: { app: "Notes" } }, "main");
    expect(answer).toEqual({ id: "3", ok: true, result: { app: "notes" }, say: "Listo" });
  });

  it("turns a throw into ok:false, keeping a CodiError's spoken line", async () => {
    registerAction(action("plain", async () => Promise.reject(new Error("boom"))));
    registerAction(action("spoken", async () => {
      throw new CodiError("ambiguous", "¿Cuál?");
    }));
    expect((await runRequest({ id: "4", window: "main", action: "plain", params: {} }, "main")).answer).toEqual({
      id: "4",
      ok: false,
      error: "boom",
    });
    expect((await runRequest({ id: "5", window: "main", action: "spoken", params: {} }, "main")).answer).toEqual({
      id: "5",
      ok: false,
      error: "ambiguous",
      say: "¿Cuál?",
    });
  });

  it("sends nothing for a request handed to another window, and passes on what runs after", async () => {
    const after = () => {};
    registerAction(action("away", async () => ({ forwarded: true })));
    registerAction(action("closing", async () => ({ say: "bye", after })));
    expect((await runRequest({ id: "6", window: "main", action: "away", params: {} }, "main")).answer).toBeNull();
    const closing = await runRequest({ id: "7", window: "main", action: "closing", params: {} }, "main");
    expect(closing.answer).toEqual({ id: "7", ok: true, say: "bye" });
    expect(closing.after).toBe(after);
  });
});

describe("undoing a navigation", () => {
  /** A one-field "screen", moved by the actions below. */
  let screen = "graph";
  const restored: string[] = [];

  beforeEach(() => {
    clearActionsForTests();
    screen = "graph";
    restored.length = 0;
    installScreenHistory({
      capture: () => screen,
      restore: async (to) => {
        restored.push(String(to));
        screen = String(to);
      },
    });
    const go = (id: string, risk: CodiAction["risk"], to: string): CodiAction => ({
      ...action(id, async () => {
        screen = to;
        return {};
      }),
      risk,
    });
    registerAction(go("view.notes", "navigate", "notes"));
    registerAction(go("view.flows", "navigate", "flows"));
    registerAction(go("git.pull", "write", "pulled"));
    registerAction(action("view.stay", async () => ({})));
    registerAction({ ...action("view.fail", async () => Promise.reject(new Error("no"))), risk: "navigate" });
  });

  const run = (name: string) => runRequest({ id: name, window: "main", action: name, params: {} }, "main");

  it("puts back the screens before each navigation, newest first", async () => {
    await run("view.notes");
    await run("view.flows");
    expect(undoDepth()).toBe(2);
    expect(await undoNavigation()).toBe(true);
    expect(screen).toBe("notes");
    expect(await undoNavigation()).toBe(true);
    expect(screen).toBe("graph");
    expect(await undoNavigation()).toBe(false);
  });

  it("records only navigations that moved something and succeeded", async () => {
    await run("git.pull");
    expect(undoDepth()).toBe(0);
    registerAction({ ...action("view.stay", async () => ({})), risk: "navigate" });
    await run("view.stay");
    await run("view.fail");
    expect(undoDepth()).toBe(0);
  });
});
