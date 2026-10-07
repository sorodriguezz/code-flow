import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingOrb } from "./ThinkingOrb";
import { DEFAULT_THINKING_DESIGN, isThinkingDesign, thinkingFinishMs, THINKING_DESIGNS } from "../../lib/thinkingDesigns";
import { translations } from "../../lib/i18n/translations";
import { es } from "../../lib/i18n/translations.es";

// Read from disk: vitest hands CSS imports back empty, `?raw` included.
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

// The setting, stood in for. A static render reads a zustand store's *initial* state (its server
// snapshot), so `setState` could never show here whether the orb follows the store.
const setting = vi.hoisted(() => ({ design: "sphere" }));
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
    setting.design = "bot";
    for (const { id } of THINKING_DESIGNS) {
      expect(renderToStaticMarkup(<ThinkingOrb design={id} />)).toContain(`cf-orb--${id}`);
    }
  });

  it("follows the setting when it is not pinned", () => {
    expect(renderToStaticMarkup(<ThinkingOrb size="sm" />)).toContain("cf-orb--sphere");
    setting.design = "plasma";
    const markup = renderToStaticMarkup(<ThinkingOrb size="sm" />);
    expect(markup).toContain("cf-orb--plasma");
    expect(markup).toContain("cf-orb-sm");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("draws the canvas designs on a canvas and the others from parts", () => {
    for (const { id, kind } of THINKING_DESIGNS) {
      const markup = renderToStaticMarkup(<ThinkingOrb design={id} />);
      expect(markup.includes("<canvas"), `${id} is ${kind}`).toBe(kind === "canvas");
    }
  });

  it("says the run's state on the mark, and nothing while it simply runs", () => {
    expect(renderToStaticMarkup(<ThinkingOrb activity={{ phase: "read" }} />)).not.toContain("data-state");
    expect(renderToStaticMarkup(<ThinkingOrb activity={{ quiet: true }} />)).toContain('data-state="quiet"');
    expect(renderToStaticMarkup(<ThinkingOrb activity={{ done: true, quiet: true }} />)).toContain('data-state="done"');
    expect(renderToStaticMarkup(<ThinkingOrb activity={{ stopping: true }} />)).toContain('data-state="stopping"');
  });

  it("has a rule in the stylesheet for every part of every design", () => {
    for (const { id } of THINKING_DESIGNS) {
      for (const name of partClasses(renderToStaticMarkup(<ThinkingOrb design={id} />))) {
        expect(css.includes(`.${name}`), `${id}: .${name} has no CSS`).toBe(true);
      }
    }
    // Every size the component accepts has its square.
    for (const size of ["sm", "md", "card", "lg"]) expect(css.includes(`.cf-orb-${size} {`), size).toBe(true);
  });

  it("gives every CSS design a still frame under reduced motion", () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    for (const { id, kind } of THINKING_DESIGNS) {
      // The canvas designs paint their own still frame (`Painter.still`) when motion is reduced.
      if (kind === "canvas") continue;
      const animated = partClasses(renderToStaticMarkup(<ThinkingOrb design={id} />)).filter(
        (name) => !/^cf-orb-(sm|md|card|lg)$/.test(name),
      );
      expect(
        animated.some((name) => reduced.includes(`.${name}`)),
        `${id} has no reduced-motion rule`,
      ).toBe(true);
    }
  });
});

describe("the thinking designs", () => {
  it("are twelve, the sphere first and by default", () => {
    const ids = THINKING_DESIGNS.map((design) => design.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("sphere");
    expect(DEFAULT_THINKING_DESIGN).toBe("sphere");
  });

  it("give the avatar time for the finishes built around one, and a brief resolve to the rest", () => {
    for (const id of ["liquid", "crystal", "star", "pixels"] as const) {
      expect(thinkingFinishMs(id), id).toBeGreaterThanOrEqual(1400);
      // Within the window in which a landed turn still counts as just landed (`AssistantAvatar`).
      expect(thinkingFinishMs(id), id).toBeLessThan(4000);
    }
    expect(thinkingFinishMs("sphere")).toBe(900);
  });

  it("are named in both languages", () => {
    for (const { id, labelKey } of THINKING_DESIGNS) {
      expect(translations.en[labelKey], `${id} (en)`).toBeTruthy();
      expect(es[labelKey], `${id} (es)`).toBeTruthy();
    }
  });

  it("recognises only its own ids — the retired ones fall back to the default", () => {
    expect(isThinkingDesign("orb")).toBe(true);
    expect(isThinkingDesign("reactor")).toBe(false);
    expect(isThinkingDesign("spinner")).toBe(false);
    expect(isThinkingDesign(null)).toBe(false);
  });
});
