import type { IconifySet } from "./catalog";
import { EMBLEMS, KINDS } from "./emblems";
import { MARKS } from "./frameworkMarks";

/**
 * File and folder glyphs for the framework packs — NestJS, Angular, React, Vue and Bun — composed from
 * a framework's mark and a kind's emblem.
 *
 * # Why not vscode-icons' own
 *
 * The set has framework glyphs, and the packs used them: for Nest, the cat with its gradient changed
 * per kind and "TS" over its lower right; for Angular, the same trick with the shield. At the 13px the
 * tree draws, `auth.controller.ts`, `auth.service.ts` and `auth.module.ts` were three near-identical
 * smudges — the "TS" is two pixels and names the language, which the file name already did. The kinds
 * the set has no glyph for — repositories, tests, hooks, stores, `main.ts` — fell through to the
 * generic icons every stack uses.
 *
 * # A file: the mark, the colour, the emblem
 *
 * **The framework's mark stays** (`frameworkMarks.ts`) — the cat, the shield, the atom, the V, the bun.
 * It is what says which framework a tree is, and the user asked for exactly that (2026-10-14, after a
 * first version without it: "que tuvieran el gato como el resto de iconos de nestjs"). The mark takes
 * the kind's **colour**, so the hue is legible before anything else; where vscode-icons wrote "TS",
 * the kind's **emblem** sits at half size (`emblems.ts`), in a disk cut out of the mark so it never
 * melts into a mark of its own colour.
 *
 * # A folder: the colour and the emblem
 *
 * The folder in the kind's colour, made translucent so it sits back from the files inside it, with
 * the same emblem in the same cut-out disk. Folders carry no mark — `guards/` is a guards folder in
 * any framework — so they are shared: `cf:folder-guard`. The exception is a kind whose colour the
 * framework sets (the component, in React's blue or Angular's red), which gets a folder per framework:
 * `cf:folder-react-component`. Each comes with its `-opened` twin, the name `openedVariant` in
 * `catalog.ts` looks for.
 *
 * # Made for what the packs name, and nothing else
 *
 * There is no list of glyphs here. `frameworkGlyphs` is handed every icon id the shipped packs use
 * (`localSet.ts` does that) and composes those — `cf:react-hook` becomes the atom in the hook's pink
 * with the hook emblem. So a glyph exists exactly when a pack draws it, and a pack that names a kind
 * this file cannot compose — an unknown kind, or a component for a framework with no colour for one —
 * shows up in `packs.test.ts` as a missing icon.
 *
 * **To add a framework**, add its mark to `frameworkMarks.ts` and its entry to `FRAMEWORKS`; **a
 * kind**, its emblem and its `KINDS` row in `emblems.ts`; then name them in the pack (`packs.ts`).
 */

interface Framework {
  /** Colours this framework sets itself, by kind — the ones a kind's `tint` leaves as `TINT`. */
  tints?: Record<string, string>;
}

/** The frameworks that draw their own glyphs, by the prefix their ids use: `cf:<framework>-<kind>`. */
const FRAMEWORKS: Record<string, Framework> = {
  nest: {},
  angular: { tints: { component: "#dd0031" } },
  react: { tints: { component: "#22b8dd" } },
  vue: { tints: { component: "#41b883" } },
  bun: {},
};

/** The id of a framework's file glyph for a kind. */
export function fileGlyphId(framework: string, kind: string): string {
  return `cf:${framework}-${kind}`;
}

/** The id of the folder for a kind — shared across frameworks unless this one colours the kind. */
export function folderGlyphId(framework: string, kind: string): string {
  return FRAMEWORKS[framework]?.tints?.[kind] ? `cf:folder-${framework}-${kind}` : `cf:folder-${kind}`;
}

/** The kind's colour in this framework, or `null` when it has none. */
function tintOf(framework: string | null, kind: string): string | null {
  const own = KINDS[kind]?.tint;
  if (!own) return null;
  if (own !== "TINT") return own;
  return (framework && FRAMEWORKS[framework]?.tints?.[kind]) || null;
}

/** `#rrggbb` toward black — Vue's inner chevron. */
function darker(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

/** The emblem at half size, centred on the disk cut out of the mark and the folder. */
function badge(kind: string, tint: string): string {
  return `<g transform="translate(15.2 14.4) scale(.5)">${EMBLEMS[KINDS[kind].emblem].split("TINT").join(tint)}</g>`;
}

function file(framework: string, kind: string): { body: string } | null {
  const mark = MARKS[framework];
  const tint = tintOf(framework, kind);
  if (!mark || !tint) return null;
  const paths = mark.map(({ tone, d }) => `<path fill="${tone ? darker(tint, 0.38) : tint}" fill-rule="evenodd" d="${d}"/>`);
  return { body: paths.join("") + badge(kind, tint) };
}

const CLOSED =
  "M2 7.5A2.5 2.5 0 0 1 4.5 5h7.3a2 2 0 0 1 1.4.6L15.6 8h11.9A2.5 2.5 0 0 1 30 10.5v14a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 24.5Z";
/** The back panel, then the front flap swung down and forward. */
const OPENED =
  "M2 7.5A2.5 2.5 0 0 1 4.5 5h7.3a2 2 0 0 1 1.4.6L15.6 8h10.9A2.5 2.5 0 0 1 29 10.5V13H9.2a2.5 2.5 0 0 0-2.3 1.6L2 27Z" +
  "M8.6 15.4A2 2 0 0 1 10.5 14H30a1.5 1.5 0 0 1 1.4 2l-3.8 9.6A2.5 2.5 0 0 1 25.3 27H3Z";
/** The disk the marks have cut out, cut out of the folder too: radius 9.4 round (23.2, 22.4). */
const KNOCKOUT = "M13.8 22.4a9.4 9.4 0 1 0 18.8 0a9.4 9.4 0 1 0 -18.8 0Z";

function folder(framework: string | null, kind: string, open: boolean): { body: string } | null {
  const tint = tintOf(framework, kind);
  if (!tint) return null;
  return {
    body:
      `<path fill="${tint}" fill-opacity=".72" fill-rule="evenodd" d="${(open ? OPENED : CLOSED) + KNOCKOUT}"/>` +
      badge(kind, tint),
  };
}

/** One glyph by its name in the `cf` set, or `null` when the name is not a framework glyph. */
function compose(name: string): { body: string } | null {
  const isFolder = name.startsWith("folder-");
  const open = isFolder && name.endsWith("-opened");
  const bare = isFolder ? name.slice("folder-".length, open ? -"-opened".length : undefined) : name;
  const parts = bare.split("-");
  if (isFolder) {
    if (parts.length === 1) return folder(null, parts[0], open);
    return parts.length === 2 && parts[0] in FRAMEWORKS ? folder(parts[0], parts[1], open) : null;
  }
  return parts.length === 2 && parts[0] in FRAMEWORKS ? file(parts[0], parts[1]) : null;
}

/**
 * The framework glyphs among these catalogue ids, composed, under their names in the `cf` set — a
 * folder with its `-opened` twin. Ids that are not framework glyphs (`cf:iris`, anything from
 * another set) are skipped.
 */
export function frameworkGlyphs(ids: Iterable<string>): IconifySet["icons"] {
  const out: IconifySet["icons"] = {};
  for (const id of ids) {
    if (!id.startsWith("cf:")) continue;
    const name = id.slice(3);
    for (const each of name.startsWith("folder-") ? [name, `${name}-opened`] : [name]) {
      if (out[each]) continue;
      const glyph = compose(each);
      if (glyph) out[each] = glyph;
    }
  }
  return out;
}
