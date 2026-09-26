import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiGlyph, AiSparkles, type AiGlyphName } from "./AiGlyph";

// Read as a file: `?raw` CSS imports are empty under vitest.
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

describe("AiGlyph", () => {
  it("is a size-square block that flows unless told to hold still", () => {
    const flowing = renderToStaticMarkup(<AiGlyph size={13} />);
    expect(flowing).toContain("cf-ai-glyph cf-ai-sparkles cf-ai-glyph-flowing");
    expect(flowing).toContain("width:13px;height:13px");
    expect(renderToStaticMarkup(<AiGlyph still />)).not.toContain("cf-ai-glyph-flowing");
  });

  it("takes a lucide icon's place in a menu item or a settings pane", () => {
    const markup = renderToStaticMarkup(<AiSparkles size={15} className="shrink-0" />);
    expect(markup).toContain("cf-ai-sparkles");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("width:15px");
  });

  // A name without its mask would render as a solid gradient square.
  it("has a mask for every glyph name", () => {
    const names: AiGlyphName[] = ["sparkles", "wand", "brain"];
    for (const name of names) {
      const at = css.indexOf(`\n.cf-ai-${name} {`);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, css.indexOf("\n}", at)), name).toContain("--cf-ai-mask: url(\"data:image/svg+xml;");
    }
    const glyph = css.slice(css.indexOf("\n.cf-ai-glyph {"), css.indexOf("\n}", css.indexOf("\n.cf-ai-glyph {")));
    expect(glyph).toContain("-webkit-mask-image: var(--cf-ai-mask);");
    expect(glyph).toMatch(/\n\s+mask-image: var\(--cf-ai-mask\);/);
  });
});
