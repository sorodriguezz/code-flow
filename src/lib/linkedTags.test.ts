import { describe, expect, it } from "vitest";
import { linkedTagRanges, scanTags } from "./linkedTags";

describe("linkedTagRanges", () => {
  const jsx = `return (<Card title={a > b ? "x" : "y"}>\n  <Item />\n  <Card>in</Card>\n</Card>);`;

  it("pairs a tag with its own closing tag, nested ones included", () => {
    const outerOpen = jsx.indexOf("Card");
    const ranges = linkedTagRanges(jsx, outerOpen + 2)!;
    expect(ranges.map(([s, e]) => jsx.slice(s, e))).toEqual(["Card", "Card"]);
    expect(ranges[1][0]).toBe(jsx.lastIndexOf("Card"));
    const innerClose = jsx.indexOf("</Card>") + 2;
    expect(linkedTagRanges(jsx, innerClose)![0][0]).toBe(jsx.indexOf("<Card>") + 1);
  });

  it("ignores generics, self-closing tags and the text between tags", () => {
    expect(scanTags("useState<string>(x)")).toEqual([]);
    expect(linkedTagRanges(jsx, jsx.indexOf("Item") + 1)).toBeNull();
    expect(linkedTagRanges(jsx, jsx.indexOf(">in<") + 2)).toBeNull();
  });
});
