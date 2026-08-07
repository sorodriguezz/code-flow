/**
 * The icon catalogue behind the explorer's custom iconography: ~3,600 SVGs, loaded on demand.
 *
 * Two sets, because they answer different halves of the question. **vscode-icons** is a file-icon
 * theme — 1,169 `file-type-*` and 398 `folder-type-*` glyphs, drawn to be legible at 13px and
 * already thinking in terms of "this is a TypeScript file" and "this is a source folder". **logos**
 * is the brand set: 2,091 marks for the services and tools a repository talks to but has no file
 * type for — a Vercel folder, a Supabase one, a Stripe integration.
 *
 * # Why it is loaded, not bundled
 *
 * Together they are ~3.7 MB of JSON, and the overwhelming majority of it is never looked at: a
 * repository uses a few dozen icons and the picker's search touches the rest only while it is open.
 * A static import would put all of it in the entry chunk, parsed before the window paints, to draw
 * an icon on a tree that may not even be on screen. So both are emitted as plain JSON assets and
 * fetched behind a module-level cache: the first thing that needs a glyph pays for it once,
 * everything after that is a map lookup, and the explorer draws its built-in Lucide icons in the
 * meantime rather than an empty column.
 *
 * # Ids
 *
 * `"<set>:<name>"`, exactly as Iconify writes them — `vscode-icons:file-type-typescript`. Stored in
 * the user's rules that way too, so a rule keeps meaning the same glyph across an upgrade of either
 * set, and a rule pointing at an icon that has since been removed can be told apart from one that
 * was never valid.
 */

import vscodeIconsUrl from "@iconify-json/vscode-icons/icons.json?url";
import logosUrl from "@iconify-json/logos/icons.json?url";

/** One glyph: the raw SVG children and the viewBox they were drawn in. */
export interface CatalogIcon {
  id: string;
  /** Inner SVG markup. Comes from the packages, which are the source of truth — it is never built
   * from user input, which is what makes rendering it with `dangerouslySetInnerHTML` safe. */
  body: string;
  width: number;
  height: number;
}

/** An Iconify icon set as shipped in `@iconify-json/*` — the fields this file reads, no more. */
interface IconifySet {
  prefix: string;
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
}

let catalog: Map<string, CatalogIcon> | null = null;
/** The same entries as an array, built once. `searchIcons` runs on every keystroke and spreading a
 * 3,600-entry map each time is the one allocation in this file that would actually be felt. */
let flat: CatalogIcon[] = [];
/** In-flight load, so twenty rows mounting at once produce one import rather than twenty. */
let loading: Promise<void> | null = null;
/** Bumped when the catalogue arrives, so components that rendered a fallback can re-render. */
const listeners = new Set<() => void>();

function ingest(set: IconifySet, into: Map<string, CatalogIcon>): void {
  const setWidth = set.width ?? 16;
  const setHeight = set.height ?? 16;
  for (const [name, icon] of Object.entries(set.icons)) {
    into.set(`${set.prefix}:${name}`, {
      id: `${set.prefix}:${name}`,
      body: icon.body,
      // Per-icon dimensions win: `logos` is mostly 256×256 but every non-square mark carries its
      // own, and using the set's default for those squashes them.
      width: icon.width ?? setWidth,
      height: icon.height ?? setHeight,
    });
  }
}

/**
 * Loads both sets, once. Safe to call from anywhere, including render — it returns the same promise
 * to every caller and resolves immediately once the catalogue is in memory.
 */
export function loadIconCatalog(): Promise<void> {
  if (catalog) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    // `?url` and `fetch`, not a JSON import. Imported, the two sets become JS object literals in a
    // chunk — 11 MB of source the engine parses as *code*. Emitted as assets they stay JSON, a
    // third of the size, and `JSON.parse` on a 3.7 MB string is an order of magnitude faster than
    // evaluating the equivalent literal.
    const [vscodeIcons, logos] = await Promise.all([
      fetch(vscodeIconsUrl).then((response) => response.json() as Promise<IconifySet>),
      fetch(logosUrl).then((response) => response.json() as Promise<IconifySet>),
    ]);
    const next = new Map<string, CatalogIcon>();
    ingest(vscodeIcons, next);
    ingest(logos, next);
    catalog = next;
    flat = [...next.values()];
    for (const listener of listeners) listener();
  })().catch(() => {
    // A failed load leaves `catalog` null and everything on its Lucide fallback, which is a degraded
    // explorer rather than a broken one. Cleared so a later mount can try again.
    loading = null;
  });
  return loading;
}

/** Whether a lookup will succeed right now. */
export function iconCatalogReady(): boolean {
  return catalog !== null;
}

/** Told when the catalogue finishes loading. Returns its own unsubscribe. */
export function onIconCatalogReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One glyph by id, or `null` if the catalogue is still loading or the id is unknown. */
export function iconEntry(id: string): CatalogIcon | null {
  return catalog?.get(id) ?? null;
}

/**
 * The picker's search.
 *
 * Ranked rather than filtered, because "angular" matches `file-type-angular`,
 * `folder-type-angular`, `file-type-ng-component-ts` and forty others, and the one the user means
 * is almost always the shortest name that starts with what they typed. Word-boundary matches beat
 * mid-word ones for the same reason: searching "go" should find Go before it finds Django.
 */
export function searchIcons(query: string, limit = 240): CatalogIcon[] {
  if (!catalog) return [];
  const needle = query.trim().toLowerCase().replace(/\s+/g, "-");
  if (!needle) return flat.slice(0, limit);

  const scored: { icon: CatalogIcon; score: number }[] = [];
  for (const icon of flat) {
    // The set prefix is searchable too, so "logos" narrows to the brand set.
    const name = icon.id.toLowerCase();
    const bare = name.slice(name.indexOf(":") + 1);
    const at = bare.indexOf(needle);
    if (at < 0) {
      if (!name.includes(needle)) continue;
      scored.push({ icon, score: 400 });
      continue;
    }
    // Shorter names first within each tier: `file-type-go` before `file-type-google-cloud`.
    const boundary = at === 0 || bare[at - 1] === "-";
    scored.push({ icon, score: (at === 0 ? 0 : boundary ? 100 : 200) + bare.length });
  }
  scored.sort((a, b) => a.score - b.score || a.icon.id.localeCompare(b.icon.id));
  return scored.slice(0, limit).map((entry) => entry.icon);
}

/**
 * The open-folder twin of an icon, when the set ships one.
 *
 * vscode-icons draws every one of its 199 folder types twice — `folder-type-src` and
 * `folder-type-src-opened` — and without this the tree loses a signal it has always had: a folder
 * with a custom icon looked identical expanded and collapsed, which is worse than the plain Lucide
 * folder it replaced. Derived rather than stored, so a rule holds one id and picking an icon never
 * asks the user for two.
 */
export function openedVariant(id: string): string | null {
  if (id.endsWith("-opened")) return id;
  return catalog?.has(`${id}-opened`) ? `${id}-opened` : null;
}
