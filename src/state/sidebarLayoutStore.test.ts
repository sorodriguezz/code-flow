import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri/commands", () => ({ getSetting: async () => null, setSetting: async () => {} }));
vi.mock("../lib/settingsSync", () => ({ watchSettings: () => {} }));
const { sectionsOf } = await import("./sidebarLayoutStore");

const project = (id: string) => ({ id, name: id, local_path: `/r/${id}` }) as never;
const ids = (list: { id: string }[]) => list.map((p) => p.id);

describe("sectionsOf", () => {
  const projects = ["a", "b", "c", "d", "e"].map(project);

  it("puts pinned first, then each group, then the rest — each in sort order", () => {
    const sections = sectionsOf(projects, {
      pinned: ["d"],
      groups: [
        { id: "g1", name: "Front", collapsed: false },
        { id: "g2", name: "Empty", collapsed: true },
      ],
      groupOf: { b: "g1", e: "g1", d: "g1" },
    });
    expect(sections.map((s) => s.kind)).toEqual(["pinned", "group", "group", "rest"]);
    expect(ids(sections[0].projects)).toEqual(["d"]);
    // A pinned project is shown pinned, not in its group as well.
    expect(ids(sections[1].projects)).toEqual(["b", "e"]);
    expect(ids(sections[2].projects)).toEqual([]);
    expect(ids(sections[3].projects)).toEqual(["a", "c"]);
  });

  it("treats a project filed in a group that no longer exists as ungrouped", () => {
    const sections = sectionsOf(projects, { pinned: ["gone"], groups: [], groupOf: { a: "gone-group" } });
    expect(sections.map((s) => s.kind)).toEqual(["rest"]);
    expect(ids(sections[0].projects)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
