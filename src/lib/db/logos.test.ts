import { describe, expect, it } from "vitest";
import { DRIVER_CATALOG } from "./drivers";
import { DB_LOGOS, dbLogo } from "./logos";

describe("database logos", () => {
  it("gives every catalogue driver a mark", () => {
    // The point of the module: no catalogue driver falls back to two letters. A driver added to
    // `driverCatalog.json` without a mark fails here rather than shipping as initials.
    const missing = DRIVER_CATALOG.filter((driver) => !dbLogo(driver.id)).map((driver) => driver.id);
    expect(missing).toEqual([]);
  });

  it("files marks only under drivers the catalogue has", () => {
    const known = new Set(DRIVER_CATALOG.map((driver) => driver.id));
    expect(Object.keys(DB_LOGOS).filter((id) => !known.has(id))).toEqual([]);
  });

  it("has no mark for a driver the user added, or for a prototype key", () => {
    expect(dbLogo("custom-1a2b3c4d")).toBeNull();
    expect(dbLogo("constructor")).toBeNull();
  });

  it("draws with a real viewBox", () => {
    for (const [id, logo] of Object.entries(DB_LOGOS)) {
      expect(logo.width, id).toBeGreaterThan(0);
      expect(logo.height, id).toBeGreaterThan(0);
      expect(logo.body.length, id).toBeGreaterThan(0);
    }
  });

  it("only draws", () => {
    // Bodies are inlined with `dangerouslySetInnerHTML`, and a few of them came from vendors' own
    // files rather than from an icon set. Nothing in one may run, load or style anything: no script,
    // no event handler, no foreign HTML, no stylesheet, and no reference that leaves the mark except
    // the two embedded rasters.
    for (const [id, logo] of Object.entries(DB_LOGOS)) {
      expect(logo.body, id).not.toMatch(/<script|<foreignObject|<style|<iframe|<use\b[^>]*href="(?!#)/i);
      expect(logo.body, id).not.toMatch(/\son[a-z]+\s*=/i);
      expect(logo.body, id).not.toMatch(/javascript:/i);
      for (const [, url] of logo.body.matchAll(/href="([^"]*)"/g)) {
        expect(url.startsWith("#") || url.startsWith("data:image/png;base64,"), `${id}: ${url.slice(0, 40)}`).toBe(true);
      }
    }
  });

  it("references only ids it declares", () => {
    // `BrandGlyph` scopes declared ids per instance; a `url(#x)` to an id the body doesn't declare
    // would resolve against whatever else is on the page.
    for (const [id, logo] of Object.entries(DB_LOGOS)) {
      const declared = new Set([...logo.body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
      const referenced = [...logo.body.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)].map((match) => match[1] ?? match[2]);
      expect(referenced.filter((ref) => !declared.has(ref)), id).toEqual([]);
    }
  });

  it("names an ink only where something is painted with it", () => {
    for (const [id, logo] of Object.entries(DB_LOGOS)) {
      if (logo.ink) expect(logo.body, id).toMatch(/currentColor|<path(?![^>]*fill=)|<rect(?![^>]*fill=)/);
    }
  });
});
