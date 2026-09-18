import { beforeEach, describe, expect, it } from "vitest";
import { dropTarget, useChatDragStore, type ChatDrag } from "./chatDragStore";

const ROW: ChatDrag = { conversationId: "c1", fromGroupId: null, title: "About Postgres" };
const FILED: ChatDrag = { conversationId: "c2", fromGroupId: "g1", title: "Deploy notes" };

const state = () => useChatDragStore.getState();

beforeEach(() => {
  state().end();
});

describe("press before drag", () => {
  it("a press alone is not a drag — that is what makes a click still a click", () => {
    state().press(ROW, 10, 10);
    expect(state().drag).toBeNull();
    expect(state().origin).not.toBeNull();
  });

  it("begin promotes the armed press and clears the origin", () => {
    state().press(ROW, 10, 10);
    state().begin();
    expect(state().drag).toEqual(ROW);
    expect(state().origin).toBeNull();
    // The ghost has to be somewhere from the first frame, or it appears at 0,0 and flies in.
    expect(state().pointer).toEqual({ x: 10, y: 10 });
  });

  it("begin does nothing without a press behind it", () => {
    state().begin();
    expect(state().drag).toBeNull();
  });

  it("a second begin cannot replace a live drag", () => {
    state().press(ROW, 0, 0);
    state().begin();
    state().press(FILED, 5, 5);
    state().begin();
    expect(state().drag?.conversationId).toBe("c1");
  });
});

describe("hover targets", () => {
  it("is ignored entirely while nothing is being dragged", () => {
    // The rows call this from `pointermove`, so an unguarded store would take a write several times
    // a frame for a pointer that is only passing through the sidebar.
    state().hover("g1");
    expect(state().over).toBeNull();
    expect(state().overUngrouped).toBe(false);
  });

  it("separates a folder from the ungrouped list, because both are real destinations", () => {
    state().press(FILED, 0, 0);
    state().begin();

    state().hover("g2");
    expect(state().over).toBe("g2");
    expect(state().overUngrouped).toBe(false);

    // Not the same as "no target": this is how a filed conversation comes back out of a folder.
    state().hover("ungrouped");
    expect(state().over).toBeNull();
    expect(state().overUngrouped).toBe(true);

    state().hover(null);
    expect(state().over).toBeNull();
    expect(state().overUngrouped).toBe(false);
  });

  it("does not write when the target has not changed", () => {
    state().press(ROW, 0, 0);
    state().begin();
    state().hover("g1");
    const before = useChatDragStore.getState();
    state().hover("g1");
    // Identity, not equality: a `set` with an unchanged value still notifies every subscriber, and
    // crossing one row is an event per pixel.
    expect(useChatDragStore.getState().over).toBe(before.over);
    expect(useChatDragStore.getState().overUngrouped).toBe(before.overUngrouped);
  });
});

describe("the pointer, for the ghost", () => {
  it("only tracks while a drag is live", () => {
    state().move(50, 50);
    expect(state().pointer).toBeNull();

    state().press(ROW, 0, 0);
    state().begin();
    state().move(50, 60);
    expect(state().pointer).toEqual({ x: 50, y: 60 });
  });
});

describe("end", () => {
  it("clears every field, including a press that never became a drag", () => {
    state().press(ROW, 1, 2);
    state().begin();
    state().hover("g1");
    state().end();
    expect(state()).toMatchObject({ drag: null, over: null, overUngrouped: false, origin: null, pointer: null });
  });
});

describe("what a release actually writes", () => {
  it("files a loose conversation into the folder under the pointer", () => {
    expect(dropTarget(ROW, "g1", false)).toBe("g1");
  });

  it("takes a filed conversation back out when released over the loose list", () => {
    // `null` is the destination, not the absence of one.
    expect(dropTarget(FILED, null, true)).toBeNull();
  });

  it("moves a conversation straight from one folder to another", () => {
    expect(dropTarget(FILED, "g2", false)).toBe("g2");
  });

  it("writes nothing when the conversation is dropped back where it started", () => {
    // Not merely a harmless no-op: the write would still re-read the list and the folder counts.
    expect(dropTarget(FILED, "g1", false)).toBeUndefined();
  });

  it("writes nothing when a loose conversation is released over the loose list", () => {
    expect(dropTarget(ROW, null, true)).toBeUndefined();
  });

  it("writes nothing when the release lands on no target at all", () => {
    // The case that made `cancelDrag` and `dropHere` separate functions: a pointer leaving the list
    // must not commit to whichever folder it last crossed on the way out. `undefined` here is what
    // distinguishes that from a deliberate release over the loose list.
    expect(dropTarget(ROW, null, false)).toBeUndefined();
    expect(dropTarget(FILED, null, false)).toBeUndefined();
  });
});
