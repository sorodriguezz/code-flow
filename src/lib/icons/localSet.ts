import type { IconifySet } from "./catalog";
import { frameworkGlyphs } from "./frameworkGlyphs";
import { SHIPPED_PACKS } from "./packs";

/**
 * This repo's own icon set — the marks neither installed set draws well enough, and the reason for
 * each.
 *
 * **The framework packs' kinds** (`frameworkGlyphs.ts`): NestJS's cat, Angular's shield, React's
 * atom, Vue's V and Bun's bun, each in the kind's colour with the kind's emblem — controller, service,
 * component, hook, store and some fifty more — and a folder per kind. Composed for exactly the ids the
 * shipped packs name; vscode-icons' own framework glyphs, and why they were not enough, are in that
 * file.
 *
 * **IRIS.** Neither installed set has an InterSystems mark. `@iconify-json/vscode-icons` (1,572
 * icons) and `@iconify-json/logos` (2,091) between them offer Memcached, Cachet and
 * `file-type-class` in Java orange; nothing that says IRIS. So a `.cls` file had no icon that named what it was, in a picker
 * whose whole index is the name you search for.
 *
 * The mark is the InterSystems IRIS one the user asked for: two angled ribbons forming a bracket, the
 * left in indigo and the right in teal. That is a deliberate exception to the rule `dbChrome` states
 * for the database engine glyphs ("deliberately not brand logos … a licensing question rather than a
 * design one") — this one is nominative use in a file-type picker, naming the product whose files it
 * marks, and it was an explicit request.
 *
 * **The geometry is an approximation, redrawn from a screenshot rather than from the official asset.**
 * If brand fidelity matters, replacing it is a single field: drop the official SVG's paths into `body`
 * below, keeping `width`/`height` in step with its `viewBox`. Nothing else in the app needs to know.
 *
 * Bundled rather than fetched: the whole set is a few kilobytes of markup — the folders are composed
 * from the file glyphs at load, not stored — and the fetch machinery in `catalog.ts` exists to keep
 * 11MB out of the entry chunk.
 *
 * Named `iris` under the prefix `cf`, so the picker's id — which is also its only label — reads
 * `cf:iris`, and searching "iris" ranks it first.
 */
export const LOCAL_ICON_SET: IconifySet = {
  prefix: "cf",
  width: 32,
  height: 32,
  icons: {
    ...frameworkGlyphs(SHIPPED_PACKS.flatMap((pack) => pack.rules.map((rule) => rule.icon))),
    iris: {
      /**
       * Not the 32×32 box its neighbours use, and deliberately: the mark is far taller than it is
       * wide (295:760 in the source artwork), and padding it into a square would render it at 40% of
       * the height every other file glyph gets. The renderer sets `width`/`height` to the requested
       * size and leaves `preserveAspectRatio` alone, so a viewBox of these proportions is scaled to
       * full height and centred — which is what the mark wants.
       */
      width: 13,
      height: 32,
      /**
       * Two identical brackets, one rotated 180°, interlocking around a diagonal gap: the indigo one
       * is a bar down the left with a foot along the bottom, the teal one the same shape turned over —
       * bar down the right, arm across the top. Every slanted edge shares one 2:1 skew, which is what
       * makes the pair read as one folded ribbon rather than as two bars.
       *
       * They meet without overlapping, so the paint order carries no meaning and neither shape needs a
       * clip. No stroke anywhere: at 13px, which is what the file tree renders, a hairline would go to
       * mush before the fills do.
       */
      body:
        '<path fill="#49ac9e" d="M4.42 1 12.32 4.95V28.55L8.49 26.66V6.92L4.42 4.91Z"/>' +
        '<path fill="#2e3192" d="M.67 3.45 4.5 5.34V25.08L8.56 27.09V31L.67 27.05Z"/>',
    },
  },
};
