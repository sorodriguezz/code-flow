import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DiffLine, FileDiffInfo } from "../../types/domain";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  useLanguageStore: Object.assign((select: (s: { language: string }) => unknown) => select({ language: "en" }), {
    getState: () => ({ language: "en" }),
  }),
}));

const { StagingDiff } = await import("./StagingDiff");

/**
 * What the Changes pane draws for a stageable diff: buttons above each hunk git would act on, and a
 * pickable gutter on changed rows only — never on context, and not at all where lines cannot be staged.
 */

const ctx = (n: number, text: string): DiffLine => ({ origin: " ", content: text, old_lineno: n, new_lineno: n });
const add = (n: number, text: string): DiffLine => ({ origin: "+", content: text, old_lineno: null, new_lineno: n });
const del = (n: number, text: string): DiffLine => ({ origin: "-", content: text, old_lineno: n, new_lineno: null });

const FILE: FileDiffInfo = {
  old_path: "a.txt",
  new_path: "a.txt",
  status: "modified",
  binary: false,
  hunks: [{ header: "@@ -1,3 +1,3 @@", lines: [ctx(1, "one"), del(2, "two"), add(2, "TWO"), ctx(3, "three")] }],
};

const render = (staged: boolean, pickable = true) =>
  renderToStaticMarkup(
    <StagingDiff
      file={FILE}
      staging={{ staged, path: "a.txt", narrow: FILE, pickable }}
      scrollRef={createRef<HTMLDivElement>()}
      changeMap={null}
    />,
  );

describe("StagingDiff", () => {
  it("puts a hunk's buttons above its first line and makes only changed rows pickable", () => {
    const markup = render(false);
    expect(markup).toContain("lines.hunkLabel {&quot;n&quot;:&quot;1&quot;,&quot;total&quot;:&quot;1&quot;}");
    expect(markup).toContain("lines.stageHunk");
    expect(markup).toContain("lines.discardHunk");
    expect(markup).not.toContain("lines.unstageHunk");
    // Two changed rows carry the gutter hint; the two context rows do not.
    expect(markup.split('title="lines.gutterHint"').length - 1).toBe(2);
  });

  it("offers only unstaging on the staged side", () => {
    const markup = render(true);
    expect(markup).toContain("lines.unstageHunk");
    expect(markup).not.toContain("lines.stageHunk");
    expect(markup).not.toContain("lines.discardHunk");
  });

  it("offers nothing to pick for a path lines cannot be staged in", () => {
    const markup = render(false, false);
    expect(markup).not.toContain("lines.hunkLabel");
    expect(markup).not.toContain("lines.gutterHint");
  });
});
