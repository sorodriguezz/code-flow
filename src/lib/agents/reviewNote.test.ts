import { describe, expect, it } from "vitest";
import { anchorOf, buildReviewMessage, diffStats, fenceFor, sortComments, type ReviewComment } from "./reviewNote";

const LABELS = { intro: "Revisión de los cambios — 2 comentarios.", general: "Nota general" };

function comment(patch: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    path: "src/a.ts",
    side: "new",
    lineno: 42,
    code: "+  const a = 1",
    body: "usa una constante nombrada",
    createdAt: 1,
    ...patch,
  };
}

describe("anchorOf", () => {
  it("names the line", () => {
    expect(anchorOf({ path: "src/a.ts", lineno: 42 })).toBe("src/a.ts:42");
  });

  it("names only the file for a whole-file comment", () => {
    expect(anchorOf({ path: "src/a.ts", lineno: null })).toBe("src/a.ts");
  });
});

describe("fenceFor", () => {
  it("is three backticks for ordinary code", () => {
    expect(fenceFor("const a = 1")).toBe("```");
  });

  /** The case that breaks the note: a diff of Markdown quotes a fence of its own. */
  it("outgrows any fence inside the text", () => {
    expect(fenceFor("+```ts")).toBe("````");
    expect(fenceFor("+`````")).toBe("``````");
  });
});

describe("sortComments", () => {
  it("reads file by file, down each file, whole-file notes first", () => {
    const sorted = sortComments([
      comment({ id: "b", path: "src/b.ts", lineno: 2 }),
      comment({ id: "a2", lineno: 90 }),
      comment({ id: "a1", lineno: 10 }),
      comment({ id: "aFile", lineno: null }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["aFile", "a1", "a2", "b"]);
  });

  it("keeps two comments on one line in the order they were written", () => {
    const sorted = sortComments([comment({ id: "second", createdAt: 2 }), comment({ id: "first", createdAt: 1 })]);
    expect(sorted.map((entry) => entry.id)).toEqual(["first", "second"]);
  });
});

describe("buildReviewMessage", () => {
  it("is empty when there is nothing to say, so no turn is spent", () => {
    expect(buildReviewMessage([], "   ", LABELS)).toBe("");
    expect(buildReviewMessage([comment({ body: "  " })], "", LABELS)).toBe("");
  });

  it("puts every comment under its file and line, with the code quoted", () => {
    const text = buildReviewMessage([comment()], "", LABELS);
    expect(text).toBe(
      ["Revisión de los cambios — 2 comentarios.", "### src/a.ts:42", "```\n+  const a = 1\n```", "> usa una constante nombrada"].join(
        "\n\n",
      ),
    );
  });

  it("fences code that contains a fence", () => {
    const text = buildReviewMessage([comment({ code: "+```ts" })], "", LABELS);
    expect(text).toContain("````\n+```ts\n````");
  });

  it("quotes every line of a multi-line comment", () => {
    const text = buildReviewMessage([comment({ body: "dos cosas:\n\nla segunda" })], "", LABELS);
    expect(text).toContain("> dos cosas:\n>\n> la segunda");
  });

  it("drops the code block for a whole-file comment", () => {
    const text = buildReviewMessage([comment({ lineno: null, code: "" })], "", LABELS);
    expect(text).toContain("### src/a.ts\n\n> usa una constante nombrada");
    expect(text).not.toContain("```");
  });

  it("adds the general note last, under its own heading", () => {
    const text = buildReviewMessage([comment()], "ojo con el rendimiento", LABELS);
    expect(text.endsWith("### Nota general\n\n> ojo con el rendimiento")).toBe(true);
  });

  it("says only the general note when no line was commented", () => {
    expect(buildReviewMessage([], "revisa los tests", LABELS)).toBe(
      "Revisión de los cambios — 2 comentarios.\n\n### Nota general\n\n> revisa los tests",
    );
  });
});

describe("diffStats", () => {
  it("counts added and removed lines, ignoring context", () => {
    expect(
      diffStats([
        { lines: [{ origin: "+" }, { origin: "+" }, { origin: " " }] },
        { lines: [{ origin: "-" }, { origin: " " }] },
      ]),
    ).toEqual({ added: 2, removed: 1 });
  });

  it("is zero for a file with no hunks", () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0 });
  });
});
