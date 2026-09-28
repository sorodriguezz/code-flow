import { describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { breakpointGlyphClass, replacedWholesale } = await import("./useBreakpointGutter");

/** A content change as Monaco reports it, reduced to what the gutter reads. */
function change(parts: Array<{ offset: number; length: number }>, isFlush = false) {
  return {
    isFlush,
    changes: parts.map((part) => ({ rangeOffset: part.offset, rangeLength: part.length, text: "x" })),
  } as unknown as editor.IModelContentChangedEvent;
}

describe("the breakpoint gutter", () => {
  it("draws each kind of breakpoint in its own shape", () => {
    expect(breakpointGlyphClass({ line: 1, enabled: true })).toBe("cf-breakpoint-glyph");
    expect(breakpointGlyphClass({ line: 1, enabled: true, condition: "x" })).toBe(
      "cf-breakpoint-glyph cf-breakpoint-conditional",
    );
    // A logpoint is a logpoint even with a condition on it.
    expect(breakpointGlyphClass({ line: 1, enabled: false, condition: "x", logMessage: "y" })).toBe(
      "cf-breakpoint-glyph cf-breakpoint-log cf-breakpoint-disabled",
    );
  });

  /** A buffer replaced whole must not drag every breakpoint to one edge: that is not the code moving. */
  it("tells a buffer replaced whole from an edit", () => {
    expect(replacedWholesale(change([], true), 100)).toBe(true);
    expect(replacedWholesale(change([{ offset: 0, length: 100 }]), 100)).toBe(true);
    // Typing at the very top of a file is an edit — it is what moves every breakpoint down a line.
    expect(replacedWholesale(change([{ offset: 0, length: 0 }]), 100)).toBe(false);
    expect(replacedWholesale(change([{ offset: 40, length: 10 }]), 100)).toBe(false);
    // An empty buffer getting its first text is not a replacement of anything.
    expect(replacedWholesale(change([{ offset: 0, length: 0 }]), 0)).toBe(false);
  });
});
