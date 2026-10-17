import { describe, expect, it } from "vitest";
import { KEPT_LINES, parseSavedDock, replayText, snapshotProject, tailOf } from "./terminalRestore";
import { newGroup } from "./terminalLayout";

describe("terminal restore", () => {
  it("reads a corrupt or foreign row as nothing to restore", () => {
    expect(parseSavedDock("{")).toEqual({ v: 1, projects: {} });
    expect(parseSavedDock('{"v":2}')).toEqual({ v: 1, projects: {} });
    expect(parseSavedDock(null)).toEqual({ v: 1, projects: {} });
  });

  it("keeps the end of the output", () => {
    const text = Array.from({ length: KEPT_LINES + 50 }, (_, n) => `line ${n}`).join("\n") + "\n\n  \n";
    const tail = tailOf(text).split("\n");
    expect(tail).toHaveLength(KEPT_LINES);
    expect(tail[tail.length - 1]).toBe(`line ${KEPT_LINES + 49}`);
  });

  it("saves the folder the shell is in, the split by position, and the focus", () => {
    const tabs = [
      { id: "a", title: "zsh", cwd: "/repo", liveCwd: "/repo/web", color: "red" },
      { id: "b", title: "api", cwd: "/repo" },
    ];
    const group = { ...newGroup(["b", "a"], "column"), sizes: [0.3, 0.7] };
    const saved = snapshotProject(tabs, [group], "b", (id) => (id === "a" ? "hello\n" : null));
    expect(saved.tabs).toEqual([
      { title: "zsh", cwd: "/repo/web", color: "red", text: "hello" },
      { title: "api", cwd: "/repo" },
    ]);
    expect(saved.groups).toEqual([{ tabs: [1, 0], dir: "column", sizes: [0.3, 0.7], broadcast: false }]);
    expect(saved.focused).toBe(1);
  });

  it("reprints old output dimmed, above a rule", () => {
    expect(replayText("a\nb", "restored")).toBe("\x1b[2ma\r\nb\x1b[0m\r\n\x1b[2m── restored ──\x1b[0m\r\n");
    expect(replayText("", "restored")).toBe("");
  });
});
