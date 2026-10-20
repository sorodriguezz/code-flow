import { describe, expect, it, vi } from "vitest";
import { scrollMoves } from "./scrollMoves";

/** Just enough of a DOM node for `contains`: the suite runs without a DOM. */
class FakeNode {
  children: FakeNode[] = [];
  constructor(...children: FakeNode[]) {
    this.children = children;
  }
  contains(other: FakeNode | null): boolean {
    return other === this || this.children.some((child) => child.contains(other));
  }
}

const scrollOn = (target: unknown) => ({ target }) as unknown as Event;

describe("scrollMoves", () => {
  vi.stubGlobal("Node", FakeNode);

  // The editor's tree and the chat side by side, the way the repo chat streams beside the explorer.
  const row = new FakeNode();
  const tree = new FakeNode(row);
  const transcript = new FakeNode(new FakeNode());
  const menu = new FakeNode(new FakeNode());
  const page = new FakeNode(tree, transcript, menu);

  it("ignores a chat following its answer while a menu is open over the tree", () => {
    expect(scrollMoves(scrollOn(transcript), row as unknown as Node, [menu as unknown as Node])).toBe(false);
  });

  it("closes for the scroller holding what the menu points at, and for the page", () => {
    expect(scrollMoves(scrollOn(tree), row as unknown as Node)).toBe(true);
    expect(scrollMoves(scrollOn(page), row as unknown as Node)).toBe(true);
  });

  it("never closes for the panel's own list", () => {
    expect(scrollMoves(scrollOn(menu.children[0]), row as unknown as Node, [menu as unknown as Node])).toBe(false);
  });

  it("counts every scroll when there is nothing to point at, as before", () => {
    expect(scrollMoves(scrollOn(transcript), null)).toBe(true);
    // `window` is not a node: a scroll event aimed at it is the page moving.
    expect(scrollMoves(scrollOn({}), row as unknown as Node)).toBe(true);
  });
});
