import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PaletteEntry } from "../../lib/flows/paletteEntries";

vi.mock("../../state/languageStore", () => ({ useT: () => (key: string) => key }));

import { NodePalette } from "./NodePalette";

const entry = (typeId: string, family: string): PaletteEntry => ({
  key: typeId,
  descriptor: { typeId, family, icon: "zap", inputs: 0, outputs: 1, inputLabels: [], outputLabels: [], milestone: 1, group: "", params: [] } as never,
  name: typeId,
  description: "",
  group: "",
});

describe("NodePalette", () => {
  it("opens with every family folded, a flow without a trigger included", () => {
    const html = renderToStaticMarkup(
      <NodePalette
        entries={[entry("trigger.manual", "trigger"), entry("net.http", "network")]}
        expanded
        onPick={() => {}}
        canDropAt={() => false}
        onDropAt={() => {}}
        onExpand={() => {}}
        onCollapse={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain("trigger.manual");
  });
});
