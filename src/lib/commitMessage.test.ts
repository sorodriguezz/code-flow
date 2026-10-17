import { describe, expect, it } from "vitest";
import { extensionPatternFor, ignorePatternFor, messageHistory, person, withIgnored, withTrailer } from "./commitMessage";

describe("withTrailer", () => {
  const co = `Co-authored-by: ${person("Ada", "ada@example.com")}`;

  it("starts a trailer block after a blank line, and adds to one that is there", () => {
    expect(withTrailer("fix: thing", co)).toBe(`fix: thing\n\n${co}`);
    expect(withTrailer(`fix: thing\n\n${co}`, "Signed-off-by: Me <me@example.com>")).toBe(
      `fix: thing\n\n${co}\nSigned-off-by: Me <me@example.com>`,
    );
    expect(withTrailer("", co)).toBe(co);
  });

  it("does not add the same line twice, nor treat a one-line subject as trailers", () => {
    expect(withTrailer(`fix\n\n${co}`, co)).toBe(`fix\n\n${co}`);
    expect(withTrailer("Fix: a thing", co)).toBe(`Fix: a thing\n\n${co}`);
  });
});

describe(".gitignore lines", () => {
  it("adds a pattern once, on its own line, keeping line endings", () => {
    expect(withIgnored("", "/a.log")).toBe("/a.log\n");
    expect(withIgnored("node_modules", "/a.log")).toBe("node_modules\n/a.log\n");
    expect(withIgnored("x\r\n", "/a.log")).toBe("x\r\n/a.log\r\n");
    expect(withIgnored("/a.log\n", "/a.log")).toBe("/a.log\n");
  });

  it("anchors a path and finds an extension", () => {
    expect(ignorePatternFor("tmp/out.log")).toBe("/tmp/out.log");
    expect(extensionPatternFor("tmp/out.log")).toBe("*.log");
    expect(extensionPatternFor("Makefile")).toBeNull();
    expect(extensionPatternFor(".env")).toBeNull();
  });
});

describe("messageHistory", () => {
  it("puts this box's messages first and keeps each once", () => {
    expect(messageHistory(["b", "a"], ["a", "c", " "])).toEqual(["b", "a", "c"]);
  });
});
