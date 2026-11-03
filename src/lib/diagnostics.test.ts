import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<Record<string, unknown>> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (_name: string, args: Record<string, unknown>) => {
    sent.push(args);
  },
}));

const { describeThrown, monacoNoise, newIssueUrl, reportError } = await import("./diagnostics");

beforeEach(() => {
  sent.length = 0;
});

describe("frontend error reporting", () => {
  it("says what was thrown in one line, whatever it was", () => {
    expect(describeThrown(new TypeError("x is undefined"))).toBe("TypeError: x is undefined");
    expect(describeThrown("plain")).toBe("plain");
    expect(describeThrown({ code: 42 })).toBe('{"code":42}');
  });

  it("sends an error once, not once per frame of a render loop", () => {
    const error = new Error("boom");
    reportError("render", error, "at App");
    reportError("render", error, "at App");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "render", message: "Error: boom", detail: "at App" });
  });

  it("prefills an issue with what the caller wrote, encoded", () => {
    const url = newIssueUrl("CodeFlow 1.2.3 · macOS 15 (aarch64)");
    expect(url).toContain("/issues/new?body=");
    expect(decodeURIComponent(url.split("body=")[1])).toBe("CodeFlow 1.2.3 · macOS 15 (aarch64)");
  });
});

describe("monacoNoise", () => {
  it("drops Monaco's cancellations and its definition-preview miss, nothing else", () => {
    const canceled = Object.assign(new Error("Canceled"), { name: "Canceled" });
    expect(monacoNoise(canceled)).toBe(true);
    const miss = new Error("Model not found");
    miss.stack = "Error: Model not found\n    at m9._acquire (http://tauri.localhost/assets/monaco-TiZlJYyL.js:991:6643)";
    expect(monacoNoise(miss)).toBe(true);
    const ours = new Error("Model not found");
    ours.stack = "Error: Model not found\n    at pickModel (http://tauri.localhost/assets/index-abc.js:1:1)";
    expect(monacoNoise(ours)).toBe(false);
    expect(monacoNoise(new Error("Canceled"))).toBe(false);
    expect(monacoNoise("Canceled")).toBe(false);
  });
});
