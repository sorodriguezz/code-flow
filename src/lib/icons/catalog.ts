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
 * Together they are 11.18 MB of JSON — 3.74 MB of vscode-icons and 7.45 MB of logos — and the
 * overwhelming majority of it is never looked at: a repository uses a few dozen icons and the
 * picker's search touches the rest only while it is open. A static import would put all of it in
 * the entry chunk, parsed before the window paints, to draw an icon on a tree that may not even be
 * on screen. So both are emitted as plain JSON assets and fetched behind a module-level cache: the
 * first thing that needs a glyph pays for it once, everything after that is a map lookup, and the
 * explorer draws its built-in Lucide icons in the meantime rather than an empty column.
 *
 * # Why the two sets load separately
 *
 * They are fetched independently because they are wanted at completely different moments, and the
 * one that costs two thirds of the weight is the one almost nobody asks for. `FileGlyph` — which
 * mounts once *per row* of the explorer, the tab strip, the Changes panel, search hits, bookmarks
 * and the file palette — only ever needs **vscode-icons**, so that is all `loadFileIcons()` pulls.
 * **logos** is reachable from exactly two places: the icon picker (which calls
 * `loadIconCatalog()` and wants everything) and a user rule that names a `logos:` id — which
 * `iconEntry` notices and loads on demand. Loading both from every file row put 7.45 MB of JSON and
 * ~2,100 permanent objects into memory to draw a tree that, in the common case, never shows a
 * single brand mark.
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
/** The same entries as an array, rebuilt only when a set lands — at most twice in a session.
 * `searchIcons` runs on every keystroke and spreading a 3,600-entry map each time is the one
 * allocation in this file that would actually be felt. These are references, not copies. */
let flat: CatalogIcon[] = [];
/** In-flight load per set, so twenty rows mounting at once produce one fetch rather than twenty. */
const pending = new Map<string, Promise<void>>();
/** Which sets are in `catalog` already. Two of them now, so "loaded" is no longer one bit. */
const loadedSets = new Set<string>();
/** Bumped each time a set lands, so a component that drew a fallback can tell it should look
 * again. A counter rather than a flag because there are two arrivals, and the second one has to
 * reach anything that already rendered against the first. */
let version = 0;
/** Told when a set finishes loading, so components that rendered a fallback can re-render. */
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
 * Loads one set into the shared map, once. Safe to call from anywhere, including render — it hands
 * the same promise to every caller and resolves immediately once that set is in memory.
 */
function loadSet(prefix: string, url: string): Promise<void> {
  if (loadedSets.has(prefix)) return Promise.resolve();
  const inFlight = pending.get(prefix);
  if (inFlight) return inFlight;
  const promise = (async () => {
    // `?url` and `fetch`, not a JSON import. Imported, a set becomes a JS object literal in a
    // chunk — megabytes of source the engine parses as *code*. Emitted as an asset it stays JSON,
    // a third of the size, and `JSON.parse` on a multi-megabyte string is an order of magnitude
    // faster than evaluating the equivalent literal.
    const set = (await fetch(url).then((response) => response.json())) as IconifySet;
    // Merged into the existing map rather than replacing it: the other set may already be in
    // there, and nothing derives React state from this map's identity.
    if (!catalog) catalog = new Map<string, CatalogIcon>();
    ingest(set, catalog);
    flat = [...catalog.values()];
    loadedSets.add(prefix);
    version += 1;
    for (const listener of listeners) listener();
  })().catch(() => {
    // A failed load leaves everything on its Lucide fallback, which is a degraded explorer rather
    // than a broken one. Cleared so a later mount can try again.
    pending.delete(prefix);
  });
  pending.set(prefix, promise);
  return promise;
}

/**
 * The file-icon theme: what every `FileGlyph` in the app draws from, and all it ever needs.
 *
 * Deliberately *not* the brand set — see the note at the top of this file. This is the one that
 * mounts hundreds of times on a cold explorer, so it is the one that has to stay cheap.
 */
export function loadFileIcons(): Promise<void> {
  return loadSet("vscode-icons", vscodeIconsUrl);
}

/**
 * The brand set. Two thirds of the catalogue's weight, and only reachable from the icon picker or
 * from a user rule that names a `logos:` id — so it is never pulled by drawing a tree.
 */
export function loadBrandIcons(): Promise<void> {
  return loadSet("logos", logosUrl);
}

/** Both sets. What the picker wants: its search is over everything, so everything has to be here. */
export function loadIconCatalog(): Promise<void> {
  return Promise.all([loadFileIcons(), loadBrandIcons()]).then(() => undefined);
}

/** Whether a lookup against the *whole* catalogue will succeed right now — which is the question
 * the picker asks, since its search ranks across both sets. A tree row asks a narrower one and
 * simply lets `iconEntry` answer `null` until its set arrives. */
export function iconCatalogReady(): boolean {
  return loadedSets.has("vscode-icons") && loadedSets.has("logos");
}

/** How many sets have landed. The value components re-render against — see `subscribeIconCatalog`. */
export function iconCatalogVersion(): number {
  return version;
}

/**
 * Told when the *whole* catalogue has finished loading. Returns its own unsubscribe.
 *
 * Gated on `iconCatalogReady`, and that gate is load-bearing now that the sets arrive separately:
 * the picker subscribes once and unsubscribes on the first notification, so an unfiltered listener
 * would settle it on whichever set won the race — a search over vscode-icons with the 2,091 brand
 * marks silently missing, and nothing left subscribed to correct it.
 */
export function onIconCatalogReady(listener: () => void): () => void {
  const whenComplete = () => {
    if (iconCatalogReady()) listener();
  };
  listeners.add(whenComplete);
  return () => listeners.delete(whenComplete);
}

/**
 * `useSyncExternalStore` subscription for anything drawing a path's icon.
 *
 * Subscribing is also what kicks the load off, so a row never has to run an effect of its own just
 * to say "somebody wants icons" — on a cold explorer that was a `useState` + `useEffect` pair per
 * row. Only the file set: a row that turns out to want a brand mark gets it through `iconEntry`.
 */
export function subscribeIconCatalog(listener: () => void): () => void {
  void loadFileIcons();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One glyph by id, or `null` if its set is still loading or the id is unknown. */
export function iconEntry(id: string): CatalogIcon | null {
  const icon = catalog?.get(id) ?? null;
  // A rule pointing at a brand mark is the one way a `logos:` id reaches a file row, and the brand
  // set isn't loaded by drawing a tree. Without this the rule would silently fall back to the
  // Lucide icon forever, with nothing to retry it — a user watching their own rule do nothing.
  // Fire-and-forget: the listeners above are what re-render the row once the set lands.
  if (!icon && id.startsWith("logos:")) void loadBrandIcons();
  return icon;
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
