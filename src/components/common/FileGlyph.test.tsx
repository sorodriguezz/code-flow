import { renderToStaticMarkup } from "react-dom/server";
import vscodeIcons from "@iconify-json/vscode-icons/icons.json";
import { describe, expect, it } from "vitest";
import { CatalogGlyph } from "./FileGlyph";

describe("CatalogGlyph", () => {
  it.each(["file-type-rust", "file-type-python", "file-type-cargo"] as const)(
    "keeps the SVG references in %s local when a cached view is hidden",
    (name) => {
      const icon = { id: `vscode-icons:${name}`, width: 32, height: 32, body: vscodeIcons.icons[name].body };
      const markup = renderToStaticMarkup(
        <>
          <div hidden><CatalogGlyph icon={icon} /></div>
          <CatalogGlyph icon={icon} />
        </>,
      );
      const bodies = Array.from(markup.matchAll(/<svg\b[^>]*>(.*?)<\/svg>/gs), (match) => match[1]);
      expect(bodies).toHaveLength(2);

      const ids = bodies.map((body) => {
        const definitions = Array.from(body.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
        const references = Array.from(body.matchAll(/(?:url\(#|href="#)([^")]+)/g), (match) => match[1]);
        expect(references.length).toBeGreaterThan(0);
        expect(definitions).toEqual(expect.arrayContaining(references));
        return definitions;
      });

      expect(ids[1].some((id) => ids[0].includes(id))).toBe(false);
    },
  );
});
