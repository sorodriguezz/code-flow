import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingOrb } from "./ThinkingOrb";
import { DEFAULT_THINKING_DESIGN, isThinkingDesign, THINKING_DESIGNS } from "../../lib/thinkingDesigns";
import { translations } from "../../lib/i18n/translations";
import { es } from "../../lib/i18n/translations.es";

// Read from disk: vitest hands CSS imports back empty, `?raw` included.
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

// The setting, stood in for. A static render reads a zustand store's *initial* state (its server
// snapshot), so `setState` could never show here whether the orb follows the store.
const setting = vi.hoisted(() => ({ design: "reactor" }));
vi.mock("../../state/thinkingDesignStore", () => ({
  useThinkingDesignStore: (select: (state: { design: string }) => unknown) => select(setting),
}));

/**
 * The thinking mark's designs. What can break silently is the join between the component and the
 * stylesheet — a part with no rule is an element with no size, so a design renders as nothing and
 * the row it sits in just looks idle — and the join between the orb and the setting, which is the
 * whole feature: every orb that was not told otherwise must wear the chosen design.
 */

/** Every `cf-orb-…` class a rendered orb carries — its size and its parts, not the `cf-orb--<design>`
 *  marker, which names the design for anyone reading the DOM and styles nothing. */
function partClasses(markup: string): string[] {
  const classes = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/));
  return [...new Set(classes.filter((name) => name.startsWith("cf-orb-") && !name.startsWith("cf-orb--")))];
}

afterEach(() => {
  setting.design = DEFAULT_THINKING_DESIGN;
});

describe("ThinkingOrb", () => {
  it("draws the design it is pinned to, whatever the setting says", () => {
    setting.design = "pulse";
    for (const { id } of THINKING_DESIGNS) {
      expect(renderToStaticMarkup(<ThinkingOrb design={id} />)).toContain(`cf-orb--${id}`);
    }
  });

  it("follows the setting when it is not pinned", () => {
    expect(renderToStaticMarkup(<ThinkingOrb size="sm" />)).toContain("cf-orb--reactor");
    setting.design = "helix";
    const markup = renderToStaticMarkup(<ThinkingOrb size="sm" />);
    expect(markup).toContain("cf-orb--helix");
    expect(markup).toContain("cf-orb-sm");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("has a rule in the stylesheet for every part of every design", () => {
    for (const { id } of THINKING_DESIGNS) {
      for (const name of partClasses(renderToStaticMarkup(<ThinkingOrb design={id} />))) {
        // The size classes are shared; the parts are each design's own.
        expect(css.includes(`.${name}`), `${id}: .${name} has no CSS`).toBe(true);
      }
    }
  });

  it("gives every design a still frame under reduced motion", () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    for (const { id } of THINKING_DESIGNS) {
      const animated = partClasses(renderToStaticMarkup(<ThinkingOrb design={id} />)).filter(
        (name) => !/^cf-orb-(sm|md|lg)$/.test(name),
      );
      // At least one part of each design is named in a reduced-motion block.
      expect(
        animated.some((name) => reduced.includes(`.${name}`)),
        `${id} has no reduced-motion rule`,
      ).toBe(true);
    }
  });
});

describe("the thinking designs", () => {
  it("are twelve, the reactor first and by default", () => {
    const ids = THINKING_DESIGNS.map((design) => design.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("reactor");
    expect(DEFAULT_THINKING_DESIGN).toBe("reactor");
  });

  it("are named in both languages", () => {
    for (const { id, labelKey } of THINKING_DESIGNS) {
      expect(translations.en[labelKey], `${id} (en)`).toBeTruthy();
      expect(es[labelKey], `${id} (es)`).toBeTruthy();
    }
  });

  it("recognises only its own ids", () => {
    expect(isThinkingDesign("aurora")).toBe(true);
    expect(isThinkingDesign("spinner")).toBe(false);
    expect(isThinkingDesign(null)).toBe(false);
  });
});
