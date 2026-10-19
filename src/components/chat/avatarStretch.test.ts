import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The mark beside an answer sits in a cell of the turn's grid, and **a grid item stretches by
 * default**. While the conversation had a session id to copy, the fixed-size mark was wrapped in a
 * button with no height of its own, so the cell grew that button to the height of the whole answer:
 * the glyph ended up centred in the vertical middle of a long turn, screens away from the line it
 * belongs to, and the tooltip appeared at the edge of a box several screens tall — which is what
 * "the tooltip shows up wherever it likes" was. One missing rule, two symptoms.
 *
 * Read as source rather than rendered: this suite has no DOM (see `vite.config.ts` — there is no
 * jsdom), and the bubble reaches `themeStore`, which asks `window.matchMedia` at import. The same
 * route `indexCss.test.ts` takes for the same reason.
 */

const source = readFileSync(new URL("./ChatMessageBubble.tsx", import.meta.url), "utf8");

/** The attributes of the one `<button>` that copies the session id. */
function copySessionButton(): string {
  const at = source.indexOf('onClick={copySession}');
  expect(at, "no copy-session button").toBeGreaterThanOrEqual(0);
  const opens = source.lastIndexOf("<button", at);
  return source.slice(opens, source.indexOf(">", source.indexOf("className", at)));
}

describe("the mark that copies the session id", () => {
  it("is aligned to the top of its grid cell instead of stretching down the turn", () => {
    expect(copySessionButton()).toContain("self-start");
  });

  it("keeps the glyph's own size, so the hit target is the glyph and not a column", () => {
    // `box` is the same size token the bare mark uses — `h-8 w-8` reading, `h-[22px] w-[22px]` in
    // the panel — so the button and the glyph can never disagree about how big the mark is.
    expect(copySessionButton()).toContain("${box}");
  });
});
