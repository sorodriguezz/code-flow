import { describe, expect, it } from "vitest";
import { readLayout, writeLayout, type DbmlMarks } from "./layout";

/**
 * The sidecar the workbench rests on.
 *
 * `readLayout(writeLayout(x, …)).source === x`, byte for byte, is the invariant that keeps dragging
 * a box — or marking a table — from disturbing the text being typed. The editor's value *is* this
 * `source`, so a trim here deletes characters as the user enters them: press Enter twice at the end
 * of a schema whose boxes have been dragged and, with a greedy trim, the second one never lands.
 */

const SOURCE = `Table users {
  id integer [pk]
}

Table posts {
  id integer [pk]
}`;

const POSITIONS = { users: { x: 40, y: 80 }, posts: { x: 300, y: 80 } };
const MARKS: DbmlMarks = { posts: "remove", users: "keep" };

describe("the sidecar round-trips", () => {
  it.each([
    ["nothing", {}, {}],
    ["positions only", POSITIONS, {}],
    ["marks only", {}, MARKS],
    ["both", POSITIONS, MARKS],
  ])("with %s", (_name, positions, marks) => {
    const stored = writeLayout(SOURCE, positions, marks as DbmlMarks);
    const read = readLayout(stored);
    expect(read.source).toBe(SOURCE);
    expect(read.positions).toEqual(positions);
    expect(read.marks).toEqual(marks);
  });

  // The case the trim exists for.
  it.each([
    ["a trailing newline", `${SOURCE}\n`],
    ["two trailing newlines", `${SOURCE}\n\n`],
    ["trailing spaces", `${SOURCE}\n   `],
  ])("preserves %s in the source", (_name, source) => {
    expect(readLayout(writeLayout(source, POSITIONS, MARKS)).source).toBe(source);
  });

  it("writes nothing when there is nothing to write", () => {
    expect(writeLayout(SOURCE, {}, {})).toBe(SOURCE);
  });

  it("is stable across saves, so an unchanged diagram is not a diff", () => {
    const once = writeLayout(SOURCE, POSITIONS, MARKS);
    const twice = writeLayout(SOURCE, { posts: POSITIONS.posts, users: POSITIONS.users }, {
      users: "keep",
      posts: "remove",
    });
    expect(twice).toBe(once);
  });
});

describe("a hand-edited sidecar cannot break the canvas", () => {
  it("drops a position that is not two finite numbers", () => {
    const doc = `${SOURCE}\n// codeflow:layout {"a":[1,2],"b":"x","c":[1],"d":[1,null],"e":[1,1e999]}\n`;
    expect(readLayout(doc).positions).toEqual({ a: { x: 1, y: 2 } });
  });

  it("drops a mark that is not one of the three", () => {
    const doc = `${SOURCE}\n// codeflow:marks {"a":"remove","b":"nonsense","c":7}\n`;
    expect(readLayout(doc).marks).toEqual({ a: "remove" });
  });

  it("survives payloads that are not JSON at all", () => {
    const doc = `${SOURCE}\n// codeflow:layout {oops\n// codeflow:marks [\n`;
    const read = readLayout(doc);
    expect(read.source).toBe(SOURCE);
    expect(read.positions).toEqual({});
    expect(read.marks).toEqual({});
  });

  it("reads a document that has only the older layout line", () => {
    const doc = `${SOURCE}\n// codeflow:layout {"users":[40,80]}\n`;
    const read = readLayout(doc);
    expect(read.source).toBe(SOURCE);
    expect(read.positions).toEqual({ users: { x: 40, y: 80 } });
    expect(read.marks).toEqual({});
  });
});
