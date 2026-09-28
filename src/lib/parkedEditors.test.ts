import { describe, expect, it } from "vitest";
import { newGroup } from "./editorGroups";
import { editorAfterSwitch, isDirtyBuffer, parkedAfterSwitch, type EditorSlice, type Parked } from "./parkedEditors";

/**
 * What a project switch does to the editor. It used to empty it, unsaved buffers and all; now a
 * project with unsaved tabs is set aside whole and comes back whole.
 */

interface Tab {
  path: string;
  loading: boolean;
  content: string;
  originalContent: string;
}
interface P {
  local_path: string;
  name: string;
}

const tab = (path: string, content: string, originalContent = content, loading = false): Tab => ({
  path,
  content,
  originalContent,
  loading,
});
const projectA: P = { local_path: "/repos/a", name: "a" };

function slice(tabs: Tab[]): EditorSlice<Tab> {
  const group = newGroup(tabs.map((t) => t.path), tabs[0]?.path ?? null);
  return { tabs, groups: [group], activeGroupId: group.id };
}

describe("isDirtyBuffer", () => {
  it("is an edit the disk does not have — and never a tab still loading", () => {
    expect(isDirtyBuffer(tab("a.ts", "new", "old"))).toBe(true);
    expect(isDirtyBuffer(tab("a.ts", "same"))).toBe(false);
    expect(isDirtyBuffer(tab("a.ts", "", "x", true))).toBe(false);
  });
});

describe("parkedAfterSwitch", () => {
  it("sets a project with unsaved tabs aside whole — clean tabs, groups and focus with it", () => {
    const current = slice([tab("a.ts", "edited", "saved"), tab("b.ts", "clean")]);
    const parked = parkedAfterSwitch({}, current, projectA, "/repos/b");
    expect(parked["/repos/a"]).toEqual({ ...current, project: projectA });
  });

  it("parks nothing for a project with nothing unsaved, and hands back the same object", () => {
    const empty: Parked<Tab, P> = {};
    expect(parkedAfterSwitch(empty, slice([tab("a.ts", "clean")]), projectA, "/repos/b")).toBe(empty);
    expect(parkedAfterSwitch(empty, slice([]), null, "/repos/b")).toBe(empty);
  });

  it("takes a project out of the parked set as the window returns to it", () => {
    const current = slice([tab("a.ts", "edited", "saved")]);
    const parked = parkedAfterSwitch({}, current, projectA, "/repos/b");
    const back = parkedAfterSwitch(parked, slice([]), { local_path: "/repos/b", name: "b" }, "/repos/a");
    expect(back).toEqual({});
  });
});

describe("editorAfterSwitch", () => {
  it("gives a returning project its parked editor, and says so", () => {
    const current = slice([tab("a.ts", "edited", "saved")]);
    const parked = parkedAfterSwitch({}, current, projectA, "/repos/b");
    const { editor, restored } = editorAfterSwitch(parked, "/repos/a", () => newGroup());
    expect(restored).toBe(true);
    expect(editor).toEqual(current);
  });

  it("gives any other project an empty editor with one fresh group", () => {
    const { editor, restored } = editorAfterSwitch<Tab, P>({}, "/repos/b", () => newGroup());
    expect(restored).toBe(false);
    expect(editor.tabs).toEqual([]);
    expect(editor.groups).toHaveLength(1);
    expect(editor.activeGroupId).toBe(editor.groups[0].id);
    // No project at all — a workspace switch passing through — is an empty editor too.
    expect(editorAfterSwitch<Tab, P>({}, null, () => newGroup()).restored).toBe(false);
  });
});
