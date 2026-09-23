import { describe, expect, it } from "vitest";
import {
  CSV_START,
  RAINBOW_COLUMNS,
  csvLanguageFor,
  csvSeparatorFor,
  detectSeparator,
  fieldCounts,
  tokenizeCsvLine,
} from "./csvDialect";
import { ALL_THEMES, rainbowPalette } from "./codeThemes";

const AUTO = { rainbow: true, separator: "auto" as const };

describe("detectSeparator", () => {
  it("reads a European spreadsheet as semicolons, not as the decimal commas inside it", () => {
    const text = "nombre;precio;cantidad\nmanzana;1,5;10\npera;2,25;3\n";
    expect(detectSeparator(text, "comma")).toBe("semicolon");
  });

  it("does not split on a separator that only appears inside quotes", () => {
    const text = 'id,city\n1,"Santiago; Chile"\n2,"Lima; Perú"\n';
    expect(detectSeparator(text, "comma")).toBe("comma");
  });

  it("prefers more real columns over a character that happens to appear once per row", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `${i},name ${i},a|b,${i * 2},x,y,z`);
    expect(detectSeparator(["id,name,tags,score,c1,c2,c3", ...rows].join("\n"), "comma")).toBe("comma");
  });

  it("finds tabs, and falls back to the extension when nothing splits", () => {
    expect(detectSeparator("a\tb\tc\n1\t2\t3\n", "comma")).toBe("tab");
    expect(detectSeparator("one column\nonly\n", "tab")).toBe("tab");
    expect(detectSeparator("", "pipe")).toBe("pipe");
  });

  it("counts a quoted field that runs over two lines as one record", () => {
    expect(fieldCounts('a,b\n1,"two\nlines"\n3,4\n', ",")).toEqual([2, 2, 2]);
  });
});

describe("csvSeparatorFor", () => {
  it("only claims delimited files, and nothing at all when colouring is off", () => {
    expect(csvSeparatorFor("src/app.ts", "a,b", AUTO)).toBeNull();
    expect(csvSeparatorFor("data.csv", "a,b", { ...AUTO, rainbow: false })).toBeNull();
    expect(csvLanguageFor("data.csv", "a;b\n1;2", AUTO)).toBe("csv-semicolon");
    expect(csvLanguageFor("DATA.TSV", "a\tb", AUTO)).toBe("tsv");
  });

  it("forces the setting on a .csv but not on a .tsv, and a file's own pick beats both", () => {
    const forced = { rainbow: true, separator: "pipe" as const };
    expect(csvSeparatorFor("a.csv", "x,y\n1,2", forced)).toBe("pipe");
    expect(csvSeparatorFor("a.tsv", "x\ty\n1\t2", forced)).toBe("tab");
    expect(csvSeparatorFor("a.csv", "x,y", { ...forced, override: "caret" })).toBe("caret");
  });
});

describe("tokenizeCsvLine", () => {
  const slots = (line: string, state = CSV_START) =>
    tokenizeCsvLine(line, ",", state).spans.map(({ start, slot }) => [line.slice(start, start + 1), slot]);

  it("gives every column its own slot and every separator none", () => {
    expect(slots("a,b,c")).toEqual([
      ["a", 1],
      [",", null],
      ["b", 2],
      [",", null],
      ["c", 3],
    ]);
  });

  it("keeps a quoted separator inside its column", () => {
    const { spans, end } = tokenizeCsvLine('x,"a, b",y', ",", CSV_START);
    expect(spans.filter((span) => span.slot === null)).toHaveLength(2);
    expect(end).toEqual({ column: 2, quoted: false });
  });

  it("carries an open quote into the next line, in the same column", () => {
    const first = tokenizeCsvLine('1,"two', ",", CSV_START);
    expect(first.end).toEqual({ column: 1, quoted: true });
    const second = tokenizeCsvLine('lines",3', ",", first.end);
    expect(second.spans[0].slot).toBe(2);
    expect(second.end).toEqual({ column: 2, quoted: false });
  });

  it("starts every record at the first colour, and cycles after the last", () => {
    const line = Array.from({ length: RAINBOW_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
    const columns = tokenizeCsvLine(line, ",", { column: 5, quoted: false }).spans.filter((s) => s.slot !== null);
    expect(columns[0].slot).toBe(1);
    expect(columns[RAINBOW_COLUMNS].slot).toBe(1);
  });
});

describe("rainbowPalette", () => {
  it("gives every shipped scheme eight distinct column colours, none of them the separators'", () => {
    for (const theme of ALL_THEMES) {
      const palette = rainbowPalette(theme).map((color) => color.toLowerCase());
      expect(palette, theme.id).toHaveLength(RAINBOW_COLUMNS);
      expect(new Set(palette).size, theme.id).toBe(RAINBOW_COLUMNS);
      expect(palette, theme.id).not.toContain(theme.ui.textMuted.toLowerCase());
      expect(palette[0], theme.id).toBe(theme.tokens.variable.toLowerCase());
    }
  });
});
