import { describe, expect, it } from "vitest";
import { bufferText, type TextRows } from "./bufferText";

/** A buffer the way xterm holds one: `[text, wrapped]` per row, rows padded to the pane's width. */
function rows(...lines: [string, boolean?][]): TextRows {
  const width = 12;
  return {
    length: lines.length,
    getLine: (y) => {
      const line = lines[y];
      if (!line) return undefined;
      const [text, wrapped = false] = line;
      return { isWrapped: wrapped, translateToString: (trimRight) => (trimRight ? text.replace(/\s+$/, "") : text.padEnd(width)) };
    },
  };
}

describe("a terminal's text", () => {
  it("joins a line xterm wrapped to the pane's width back into one", () => {
    expect(bufferText(rows(["Exception in", false], [" thread main", true], ["next", false]))).toBe("Exception in thread main\nnext");
  });

  it("keeps the spaces in the middle of a wrapped line", () => {
    expect(bufferText(rows(["at the end  ", false], ["of the row", true]))).toBe("at the end  of the row");
  });

  it("drops the screen's unused rows and the pane's exit line", () => {
    expect(bufferText(rows(["started", false], ["", false], ["[process exited]", false], ["", false], ["", false]))).toBe("started");
  });

  it("leaves an exit line the program printed in the middle", () => {
    expect(bufferText(rows(["[process exited]", false], ["again", false]))).toBe("[process exited]\nagain");
  });

  it("is empty for an empty pane", () => {
    expect(bufferText(rows(["", false], ["", false]))).toBe("");
  });
});

describe("bufferText's tail", () => {
  it("reads only the end of a long buffer, whole lines included", () => {
    const many: [string, boolean?][] = [];
    for (let n = 0; n < 2000; n++) many.push([`line ${n}`]);
    many.push(["a long line that", false], [" wraps", true]);
    const tail = bufferText(rows(...many), 10).split("\n");
    expect(tail.length).toBeLessThan(400);
    expect(tail[tail.length - 1]).toBe("a long line that wraps");
    expect(bufferText(rows(...many)).split("\n")).toHaveLength(2001);
  });
});
