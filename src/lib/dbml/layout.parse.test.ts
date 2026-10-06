import { describe, expect, it } from "vitest";
import { addTable, dropField, dropTable, renameTable } from "./edit";
import { fieldMarkKey, holdPlaces, layoutDbml, liveMarks, placeNear, type DbmlMarks } from "./layout";
import { parseDbml } from "./parse";

/**
 * The three things the workbench does around an edit so the canvas does not lie about it: count
 * only the marks it can draw, keep every box still across a rename, and put a new table where the
 * person is looking.
 *
 * Laid out through the real parser and the real engine, because both bugs these guard against live
 * in the engine — it deals each layer and the shelf of unwired tables in name order — and a test
 * against hand-made coordinates would only prove the helpers agree with themselves.
 */

const SCHEMA = `Table users {
  id integer [pk]
  email varchar
}

Table posts {
  id integer [pk]
  user_id integer [ref: > users.id]
}

Table comments {
  id integer [pk]
  post_id integer [ref: > posts.id]
}

Table audit {
  id integer
}

Table zebra {
  id integer
}`;

const lay = (source: string, pinned: Record<string, { x: number; y: number }> = {}) =>
  layoutDbml(parseDbml(source), { mode: "all", density: "roomy", pinned });

const places = (laid: ReturnType<typeof lay>) =>
  Object.fromEntries(laid.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

describe("a rename keeps the picture still", () => {
  const before = lay(SCHEMA);
  // `zebra` is on the unwired shelf, after `audit`; as `aardvark` it sorts first and takes the slot
  // `audit` had, pushing `audit` along — the jump the user saw.
  const next = renameTable(SCHEMA, "zebra", "aardvark");

  it("moves boxes when left to the engine (what this guards against)", () => {
    const after = places(lay(next));
    expect(after.aardvark).not.toEqual(places(before).zebra);
    expect(after.audit).not.toEqual(places(before).audit);
  });

  it("pins whatever would move, so nothing does", () => {
    const pinned = holdPlaces(before.nodes, lay(next).nodes, {}, { aardvark: "zebra" });
    const held = places(lay(next, pinned));
    const was = places(before);
    expect(held.aardvark).toEqual(was.zebra);
    for (const id of ["users", "posts", "comments", "audit"]) expect(held[id]).toEqual(was[id]);
  });

  it("pins only what would move", () => {
    const pinned = holdPlaces(before.nodes, lay(next).nodes, {}, { aardvark: "zebra" });
    // The wired flow does not sort against the shelf, so none of it needs holding.
    expect(Object.keys(pinned).sort()).toEqual(["aardvark", "audit"]);
  });

  it("leaves a box the user already dragged where they put it", () => {
    const dragged = { audit: { x: 900, y: 40 } };
    const drawn = lay(SCHEMA, dragged);
    const pinned = holdPlaces(drawn.nodes, lay(next).nodes, dragged, { aardvark: "zebra" });
    expect(pinned.audit).toEqual({ x: 900, y: 40 });
  });
});

describe("a new table appears where you are looking", () => {
  const before = lay(SCHEMA);
  const next = addTable(SCHEMA, "orders");
  const fresh = lay(next).nodes.find((node) => node.id === "orders")!;

  it("lands centred on the point when it is free", () => {
    const centre = { x: 5000, y: 5000 };
    expect(placeNear(centre, fresh, before.nodes)).toEqual({
      x: Math.round(centre.x - fresh.width / 2),
      y: Math.round(centre.y - fresh.height / 2),
    });
  });

  it("lands beside a box that sits on the point, not on top of it, and close to it", () => {
    const users = before.nodes.find((node) => node.id === "users")!;
    const centre = { x: users.x + users.width / 2, y: users.y + users.height / 2 };
    const at = placeNear(centre, fresh, before.nodes);
    for (const box of before.nodes) {
      const apart =
        at.x + fresh.width <= box.x ||
        box.x + box.width <= at.x ||
        at.y + fresh.height <= box.y ||
        box.y + box.height <= at.y;
      expect(apart).toBe(true);
    }
    const middle = { x: at.x + fresh.width / 2, y: at.y + fresh.height / 2 };
    expect(Math.hypot(middle.x - centre.x, middle.y - centre.y)).toBeLessThan(
      Math.max(fresh.width, fresh.height) + users.width,
    );
  });

  it("does not shuffle the shelf it joins", () => {
    const centre = { x: 5000, y: 5000 };
    let pinned = holdPlaces(before.nodes, lay(next).nodes, {});
    pinned = { ...pinned, orders: placeNear(centre, fresh, before.nodes) };
    const held = places(lay(next, pinned));
    const was = places(before);
    for (const id of Object.keys(was)) expect(held[id]).toEqual(was[id]);
    expect(held.orders).toEqual(pinned.orders);
  });
});

describe("the review counts match what is drawn", () => {
  const schema = parseDbml(`${SCHEMA}

Enum status {
  open
  closed
}`);
  const ref = schema.refs[0].id;

  it("keeps a mark on a table, an enum, a column and a relationship that exist", () => {
    const marks: DbmlMarks = {
      users: "remove",
      status: "review",
      [fieldMarkKey("users", "email")]: "review",
      [ref]: "keep",
    };
    expect(liveMarks(schema, marks)).toEqual(marks);
  });

  it("drops the marks left behind by what was deleted or renamed by typing", () => {
    const gone = parseDbml(dropField(dropTable(SCHEMA, "zebra"), "users", "email"));
    const marks: DbmlMarks = {
      zebra: "remove",
      [fieldMarkKey("users", "email")]: "remove",
      [fieldMarkKey("zebra", "id")]: "remove",
      "ghost.a->users.id": "review",
      posts: "remove",
    };
    expect(liveMarks(gone, marks)).toEqual({ posts: "remove" });
  });
});
