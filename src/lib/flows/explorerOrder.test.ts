import { describe, expect, it } from "vitest";
import { flowGroups, ownList, placeIn } from "./explorerOrder";
import { planDrop } from "../../state/flowsDragStore";

/**
 * The Flows explorer's order and what a drag does to it — the pure half, which is where the rules
 * live. The writes are two commands (`flows_move_flow`, `flows_reorder_flows`), tested in Rust.
 */

const flow = (id: string, sort_order: number, folder_id: string | null = null, workspace_id = "w1") => ({
  id,
  name: id,
  sort_order,
  folder_id,
  workspace_id,
});
const folder = (id: string, sort_order: number) => ({ id, name: id, sort_order });

describe("the order the explorer draws", () => {
  it("draws every list in its dragged order, names only breaking ties", () => {
    const groups = flowGroups(
      [flow("b", 0), flow("a", 1), flow("c", 1), flow("x", 0, "f2"), flow("w", 1, "f2")],
      [folder("f2", 0), folder("f1", 1)],
      "w1",
      "",
    );
    expect(groups.folders.map((group) => group.folder.id)).toEqual(["f2", "f1"]);
    expect(groups.folders[0].flows.map((f) => f.id)).toEqual(["x", "w"]);
    expect(groups.root.map((f) => f.id)).toEqual(["b", "a", "c"]);
  });

  it("puts another workspace's global flows after this one's top level, by name", () => {
    const groups = flowGroups(
      [flow("Zeta", 5, "elsewhere", "w2"), flow("mine", 9), flow("Alfa", 0, null, "w2")],
      [],
      "w1",
      "",
    );
    expect(groups.root.map((f) => f.id)).toEqual(["mine", "Alfa", "Zeta"]);
  });

  it("hides a folder with nothing matching while searching", () => {
    const groups = flowGroups([flow("deploy", 0, "f1"), flow("informe", 0)], [folder("f1", 0), folder("f2", 1)], "w1", "dep");
    expect(groups.folders.map((group) => group.folder.id)).toEqual(["f1"]);
    expect(groups.root).toEqual([]);
  });
});

describe("what a drop does to a list", () => {
  const list = ["a", "b", "c"].map((id, index) => flow(id, index));

  it("places an item before or after its anchor, wherever it came from", () => {
    expect(placeIn(list, list[2], { id: "a", after: false }).map((f) => f.id)).toEqual(["c", "a", "b"]);
    expect(placeIn(list, list[0], { id: "b", after: true }).map((f) => f.id)).toEqual(["b", "a", "c"]);
    const incoming = flow("z", 0, "f1");
    expect(placeIn(list, incoming, { id: "b", after: false }).map((f) => f.id)).toEqual(["a", "z", "b", "c"]);
  });

  it("appends with no anchor, or one that is not in the list", () => {
    expect(placeIn(list, flow("z", 0), null).map((f) => f.id)).toEqual(["a", "b", "c", "z"]);
    expect(placeIn(list, list[0], { id: "gone", after: true }).map((f) => f.id)).toEqual(["b", "c", "a"]);
  });

  it("renumbers only this workspace's own list", () => {
    const flows = [flow("mine", 1), flow("theirs", 0, null, "w2"), flow("inside", 0, "f1")];
    expect(ownList(flows, [folder("f1", 0)], "w1", null).map((f) => f.id)).toEqual(["mine"]);
    expect(ownList(flows, [folder("f1", 0)], "w1", "f1").map((f) => f.id)).toEqual(["inside"]);
  });
});

describe("where a held row would land", () => {
  const dragging = { kind: "flow" as const, id: "a", fromFolderId: null };

  it("files a flow into a folder over the folder's whole row", () => {
    expect(planDrop(dragging, { kind: "folder", id: "f1" }, "before")).toEqual({ mode: "into", folderId: "f1" });
    expect(planDrop(dragging, { kind: "folder", id: "f1" }, "after")).toEqual({ mode: "into", folderId: "f1" });
  });

  it("places a flow next to a flow, in that flow's list", () => {
    expect(planDrop(dragging, { kind: "flow", id: "b", folderId: "f1", own: true }, "after")).toEqual({
      mode: "order",
      anchorId: "b",
      after: true,
      folderId: "f1",
    });
  });

  it("files at the top level over another workspace's flow, and nowhere over itself", () => {
    expect(planDrop(dragging, { kind: "flow", id: "g", folderId: null, own: false }, "before")).toEqual({
      mode: "into",
      folderId: null,
    });
    expect(planDrop(dragging, { kind: "flow", id: "a", folderId: null, own: true }, "after")).toBeNull();
  });

  it("only ever places a folder among folders", () => {
    const folderDrag = { kind: "folder" as const, id: "f1", fromFolderId: null };
    expect(planDrop(folderDrag, { kind: "folder", id: "f2" }, "before")).toEqual({
      mode: "order",
      anchorId: "f2",
      after: false,
      folderId: null,
    });
    expect(planDrop(folderDrag, { kind: "flow", id: "b", folderId: null, own: true }, "after")).toBeNull();
  });
});
