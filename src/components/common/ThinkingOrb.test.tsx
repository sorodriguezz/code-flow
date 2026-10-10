import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingOrb } from "./ThinkingOrb";
import {
  DEFAULT_THINKING_DESIGN,
  isThinkingDesign,
  storedThinkingDesign,
  thinkingFinishMs,
  thinkingSpeaksItself,
  THINKING_DESIGNS,
} from "../../lib/thinkingDesigns";
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
    // A failure wins over `done`: the mark must not celebrate a run that failed.
    expect(renderToStaticMarkup(<ThinkingOrb activity={{ failed: true, done: true }} />)).toContain('data-state="failed"');
  });

  it("tells the CSS designs what kind of phase is running, and only while it runs", () => {
    const phaseOf = (activity: Parameters<typeof ThinkingOrb>[0]["activity"], design: "bot" | "sphere" = "bot") =>
      renderToStaticMarkup(<ThinkingOrb design={design} activity={activity} />).match(/data-phase="(\w+)"/)?.[1];
    expect(phaseOf({ phase: "think" })).toBe("think");
    expect(phaseOf({ phase: "search" })).toBe("read");
    expect(phaseOf({ phase: "edit" })).toBe("work");
    expect(phaseOf({ phase: "tool" })).toBe("work");
    expect(phaseOf({ phase: "write" })).toBe("write");
    expect(phaseOf({ phase: "write", done: true })).toBeUndefined();
    // The canvas designs read the phase itself.
    expect(phaseOf({ phase: "edit" }, "sphere")).toBeUndefined();
  });

  it("styles a failure for every CSS design, and shudders every design", () => {
    expect(css).toContain('.cf-orb[data-state="failed"] {');
    expect(css).toContain("--cf-orb-end: var(--cf-danger)");
    for (const { id, kind } of THINKING_DESIGNS) {
      if (kind !== "css") continue;
      const parts = partClasses(renderToStaticMarkup(<ThinkingOrb design={id} />));
      expect(
        parts.some((name) => css.includes(`.cf-orb[data-state="failed"] .${name}`)),
        `${id} has no failed rule`,
      ).toBe(true);
    }
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
  it("are twenty, the sphere first and by default", () => {
    const ids = THINKING_DESIGNS.map((design) => design.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("sphere");
    expect(DEFAULT_THINKING_DESIGN).toBe("sphere");
  });

  it("give the avatar time for the finishes built around one, and a brief resolve to the rest", () => {
    const finishing = [
      "orb", "network", "wave", "liquid", "crystal", "cat", "pixels", "ghost",
      "crab", "moon", "atom", "spark", "cloud", "bulb", "alien",
    ] as const;
    for (const id of finishing) {
      expect(thinkingFinishMs(id), id).toBeGreaterThanOrEqual(1400);
      // Within the window in which a landed turn still counts as just landed (`AssistantAvatar`).
      expect(thinkingFinishMs(id), id).toBeLessThan(4000);
    }
    expect(thinkingFinishMs("sphere")).toBe(900);
  });

  it("draw speaking from the voice where they can, and are handed writing's look elsewhere", () => {
    const voiced = THINKING_DESIGNS.filter((design) => thinkingSpeaksItself(design.id)).map((design) => design.id);
    // The shader and the waves, and the four mascots with a lip-synced mouth.
    expect(voiced).toEqual(["orb", "wave", "spark", "cloud", "bulb", "alien"]);
    // Only a painter can read the voice frame by frame; a CSS design has no voice of its own.
    for (const id of voiced) expect(THINKING_DESIGNS.find((design) => design.id === id)?.kind, id).toBe("canvas");
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

  it("reads a replaced design as its successor, and anything else unknown as the default", () => {
    expect(isThinkingDesign("star")).toBe(false);
    expect(storedThinkingDesign("star")).toBe("cat");
    expect(storedThinkingDesign("panda")).toBe("moon");
    expect(storedThinkingDesign("cat")).toBe("cat");
    expect(storedThinkingDesign("reactor")).toBe(DEFAULT_THINKING_DESIGN);
    expect(storedThinkingDesign(null)).toBe(DEFAULT_THINKING_DESIGN);
  });
});
