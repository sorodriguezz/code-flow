import { describe, expect, it } from "vitest";
import { appCommandFor } from "./CommandMenu";

/**
 * What a typed line does when Enter is pressed.
 *
 * This function decides between "run something" and "send this to the model", and both mistakes are
 * bad in ways the user cannot undo: a message swallowed as a command is gone from the composer, and
 * a command sent as a message is a turn spent asking a model about a slash.
 */
describe("appCommandFor", () => {
  it("runs a bare command", () => {
    expect(appCommandFor("/compact")).toEqual({ id: "compact", args: "" });
    expect(appCommandFor("/new")).toEqual({ id: "new", args: "" });
  });

  it("hands everything after the name to a command that takes arguments", () => {
    expect(appCommandFor("/compact quédate con las rutas de archivo")).toEqual({
      id: "compact",
      args: "quédate con las rutas de archivo",
    });
  });

  it("carries a caveman level, and the bare command too", () => {
    // Both spellings have to reach the handler: bare means the default level, and the handler is
    // the only place that knows what the default is.
    expect(appCommandFor("/caveman")).toEqual({ id: "caveman", args: "" });
    expect(appCommandFor("/caveman ultra")).toEqual({ id: "caveman", args: "ultra" });
    expect(appCommandFor("/caveman wenyan-full")).toEqual({ id: "caveman", args: "wenyan-full" });
    // "off" is an argument like any other here — turning the mode off is the handler's business,
    // not the parser's.
    expect(appCommandFor("/caveman off")).toEqual({ id: "caveman", args: "off" });
  });

  it("treats arguments to a command that takes none as an ordinary message", () => {
    // `/new empezar de cero` must not silently run `/new` and drop the sentence. The safe reading
    // of an unrecognised shape is always "this is a message": the worst case is a model answering a
    // question about a slash command, rather than an action taken by surprise.
    expect(appCommandFor("/new empezar de cero")).toBeNull();
    expect(appCommandFor("/branch desde el turno 3")).toBeNull();
  });

  it("does not match a line that merely begins with the same letters", () => {
    expect(appCommandFor("/compactar")).toBeNull();
    expect(appCommandFor("/compacta esto")).toBeNull();
    expect(appCommandFor("/nuevo")).toBeNull();
  });

  it("leaves ordinary text alone, including text about commands", () => {
    expect(appCommandFor("qué hace /compact")).toBeNull();
    expect(appCommandFor("hola")).toBeNull();
    expect(appCommandFor("")).toBeNull();
    expect(appCommandFor("   ")).toBeNull();
    expect(appCommandFor("/")).toBeNull();
  });

  it("is not fooled by a pasted paragraph under the command", () => {
    // A command with a second line is a message *about* a command. Running it would swallow the
    // paragraph, which is the one thing here that loses the user's own words.
    expect(appCommandFor("/compact\ny aquí va el texto que pegué")).toBeNull();
  });

  it("ignores the case of the name but not of the arguments", () => {
    expect(appCommandFor("/COMPACT")).toEqual({ id: "compact", args: "" });
    // The steer is prose handed to a model — "Conserva los IDs" must survive as written.
    expect(appCommandFor("/Compact Conserva los IDs")).toEqual({
      id: "compact",
      args: "Conserva los IDs",
    });
  });

  it("tolerates the whitespace a real keystroke leaves behind", () => {
    expect(appCommandFor("  /compact  ")).toEqual({ id: "compact", args: "" });
    expect(appCommandFor("/compact    sé breve")).toEqual({ id: "compact", args: "sé breve" });
  });
});
