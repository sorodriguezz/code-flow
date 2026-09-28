import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptTrustRow } from "../tauri/apiCommands";

// The gate's IPC is injected in every test below; this only keeps the module's defaults (and the
// debounced write the editor path makes) away from a real Tauri bridge.
const recorded: ScriptTrustRow[][] = [];
vi.mock("../tauri/apiCommands", () => ({
  apiScriptTrustLookup: async () => [],
  apiScriptTrustRecord: async (entries: ScriptTrustRow[]) => {
    recorded.push(entries);
  },
}));

const {
  findUntrusted,
  flushAuthoredScripts,
  forgetAuthoredScripts,
  gateScripts,
  isAuthored,
  noteAuthoredScript,
  scriptHash,
  trustScripts,
} = await import("./scriptTrust");
type ScriptRef = import("./scriptTrust").ScriptRef;

function ref(code: string, extra: Partial<ScriptRef> = {}): ScriptRef {
  return { level: "request", phase: "pre", owner: "List orders", collectionId: "c1", code, ...extra };
}

/** A lookup over an in-memory table, recording what it was asked. */
function table(rows: ScriptTrustRow[]) {
  const asked: string[][] = [];
  return {
    asked,
    lookup: async (hashes: string[]) => {
      asked.push(hashes);
      return rows.filter((row) => hashes.includes(row.hash));
    },
  };
}

beforeEach(() => {
  forgetAuthoredScripts();
  recorded.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scriptHash", () => {
  // The same vectors `api_trust::script_hash` is pinned to in Rust — the two sides must agree
  // byte for byte, or a script trusted by the migration would ask again forever.
  it("is plain SHA-256 of the UTF-8 text, lowercase hex", async () => {
    expect(await scriptHash('pm.test("ok", () => {});\n')).toBe(
      "f289d1ab16f967646ba0624bd086604655b6f271938f9287383df05cb2e6e56b",
    );
    expect(await scriptHash('console.log("ñandú")')).toBe(
      "d28ea6a847ceee6f67b3f947729152308fb58fbcf1c73aacab80f98379f4b983",
    );
  });

  it("does not normalise — whitespace is part of the program", async () => {
    expect(await scriptHash("a();")).not.toBe(await scriptHash("a();\n"));
  });
});

describe("findUntrusted", () => {
  it("never asks about blank scripts, and asks once per distinct text", async () => {
    const { lookup, asked } = table([]);
    const untrusted = await findUntrusted(
      [
        ref(""),
        ref("   \n"),
        ref("pm.test('a', () => {})", { owner: "A" }),
        ref("pm.test('a', () => {})", { owner: "B", phase: "post" }),
      ],
      lookup,
    );
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0].refs.map((r) => r.owner)).toEqual(["A", "B"]);
    expect(asked).toEqual([[await scriptHash("pm.test('a', () => {})")]]);
  });

  it("lets trusted rows through and reports where untrusted ones came from", async () => {
    const trusted = "pm.environment.set('token', 'x')";
    const imported = "pm.sendRequest('https://api.example.test/v1/orders')";
    const { lookup } = table([
      { hash: await scriptHash(trusted), trusted: true, origin: "migration" },
      { hash: await scriptHash(imported), trusted: false, origin: "import:postman" },
    ]);
    const untrusted = await findUntrusted([ref(trusted), ref(imported), ref("brand new()")], lookup);
    expect(untrusted.map((entry) => [entry.code, entry.origin])).toEqual([
      [imported, "import:postman"],
      ["brand new()", null],
    ]);
  });

  it("trusts what the editor authored this session without a lookup", async () => {
    noteAuthoredScript("tab-1/pre", "console.log(1)");
    const { lookup, asked } = table([]);
    expect(await findUntrusted([ref("console.log(1)")], lookup)).toEqual([]);
    expect(asked).toEqual([]);
    // Only the buffer's *latest* text: typing on replaces what the buffer vouched for.
    noteAuthoredScript("tab-1/pre", "console.log(2)");
    expect(isAuthored("console.log(1)")).toBe(false);
    expect(isAuthored("console.log(2)")).toBe(true);
  });

  it("asks about everything unauthored when the lookup itself fails", async () => {
    const untrusted = await findUntrusted([ref("a()"), ref("b()")], async () => {
      throw new Error("database is locked");
    });
    expect(untrusted.map((entry) => entry.code)).toEqual(["a()", "b()"]);
  });
});

describe("gateScripts", () => {
  const imported = "pm.globals.set('from', 'elsewhere')";
  const mine = "pm.test('mine', () => {})";

  async function lookupWithMine() {
    return table([{ hash: await scriptHash(mine), trusted: true, origin: "authored" }]).lookup;
  }

  it("does not ask when everything is trusted", async () => {
    const ask = vi.fn();
    const result = await gateScripts([ref(mine)], ask, { lookup: await lookupWithMine() });
    expect(ask).not.toHaveBeenCalled();
    expect(result?.allows(ref(mine))).toBe(true);
    expect(result?.skipped).toEqual([]);
  });

  it("trust: records the approval and lets everything run", async () => {
    const record = vi.fn(async () => {});
    const result = await gateScripts([ref(mine), ref(imported)], async () => "trust", {
      lookup: await lookupWithMine(),
      record,
    });
    expect(result?.allows(ref(imported))).toBe(true);
    expect(record).toHaveBeenCalledWith([{ hash: await scriptHash(imported), trusted: true, origin: "approved" }]);
  });

  it("skip: only the listed texts stay out, wherever they appear", async () => {
    const result = await gateScripts([ref(mine), ref(imported)], async () => "skip", {
      lookup: await lookupWithMine(),
      record: async () => {
        throw new Error("a skip must not write anything");
      },
    });
    expect(result?.allows(ref(mine))).toBe(true);
    expect(result?.allows(ref(imported))).toBe(false);
    expect(result?.allows(ref(imported, { level: "folder", owner: "v1" }))).toBe(false);
    expect(result?.skipped.map((entry) => entry.code)).toEqual([imported]);
  });

  it("cancel: nothing runs and nothing is sent", async () => {
    const result = await gateScripts([ref(imported)], async () => "cancel", { lookup: table([]).lookup });
    expect(result).toBeNull();
  });

  it("an approval that fails to save still runs this time", async () => {
    const result = await gateScripts([ref(imported)], async () => "trust", {
      lookup: table([]).lookup,
      record: async () => {
        throw new Error("disk full");
      },
    });
    expect(result?.allows(ref(imported))).toBe(true);
  });
});

describe("authored scripts are written down", () => {
  it("after the editor sits still, as trusted 'authored'", async () => {
    vi.useFakeTimers();
    noteAuthoredScript("tab-2/post", "pm.test('x', () => {})");
    expect(recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(recorded).toEqual([
      [{ hash: await scriptHash("pm.test('x', () => {})"), trusted: true, origin: "authored" }],
    ]);
  });

  it("at once on flush, and never for a blank buffer", async () => {
    noteAuthoredScript("tab-3/pre", "   ");
    noteAuthoredScript("tab-3/post", "console.log('saved')");
    await flushAuthoredScripts();
    expect(recorded).toEqual([
      [{ hash: await scriptHash("console.log('saved')"), trusted: true, origin: "authored" }],
    ]);
    // Nothing left pending: a second flush writes nothing.
    await flushAuthoredScripts();
    expect(recorded).toHaveLength(1);
  });

  it("trustScripts dedupes and skips blanks", async () => {
    const record = vi.fn(async () => {});
    await trustScripts(["a()", "a()", "", "  "], "approved", record);
    expect(record).toHaveBeenCalledWith([{ hash: await scriptHash("a()"), trusted: true, origin: "approved" }]);
  });
});
