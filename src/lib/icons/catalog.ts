/**
 * The icon catalogue behind the explorer's custom iconography: ~3,600 SVGs, loaded on demand — plus
 * one bundled glyph of our own (`localSet.ts`), for the mark neither package ships.
 *
 * Two fetched sets, because they answer different halves of the question. **vscode-icons** is a file-icon
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
 * # Why almost none of what is fetched is kept
 *
 * Fetching a set is not the same as holding it. The tree can only ever draw an icon some *rule*
 * names — there is no `file-type-<extension>` derivation anywhere in the app, so every id it can
 * ask for comes from `DEFAULT_ICON_RULES`, from a built-in profile, or from a rule the user wrote.
 * That is around sixty ids out of 1,572, and materialising the other 1,512 cost ~3.5 MB of SVG
 * markup, held for the life of the process, to draw nothing.
 *
 * So a set is parsed whole (transient) and *ingested* through an allowlist (`wanted`). The
 * allowlist is seeded from the shipped rules and profiles, widened by `declareIconIds` when the
 * user's own profiles land, and widened again — once per id, see `attemptedWiden` — by
 * [`iconEntry`] whenever something asks for a glyph that was pruned away. That last path is what
 * makes the optimisation safe rather than merely likely: a miss is not a broken icon, it is a
 * Lucide fallback for one frame and a re-render when the set comes back. Which is exactly what a
 * cold start already looks like.
 *
 * The picker is the one consumer that genuinely wants all 3,600, so `loadIconCatalog` turns the
 * pruning off and re-reads both sets whole; `releaseIconCatalog` puts it back when the picker
 * closes. Both re-reads hit the webview's cache — the JSON is a local asset.
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
import { LOCAL_ICON_SET } from "./localSet";
import { DEFAULT_ICON_RULES } from "./rules";
import { BUILT_IN_PROFILES } from "./profiles";

/** One glyph: the raw SVG children and the viewBox they were drawn in. */
export interface CatalogIcon {
  id: string;
  /** Inner SVG markup. Comes from the icon packages or from this repo's own set (`localSet.ts`),
   * which are the source of truth — it is never built from user input, which is what makes rendering
   * it with `dangerouslySetInnerHTML` safe. */
  body: string;
  width: number;
  height: number;
}

/** An Iconify icon set as shipped in `@iconify-json/*`, or this repo's own (`localSet.ts`) — the
 * fields this file reads, no more. */
export interface IconifySet {
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

/** Where each fetched set lives, so a widen can re-read one by prefix alone. */
const SET_URLS: Record<string, string> = {
  "vscode-icons": vscodeIconsUrl,
  logos: logosUrl,
};

/**
 * Every id anything outside the picker can ask for. See the note at the top of the file.
 *
 * Both an id and its `-opened` twin, always: `openedVariant` answers by asking the map whether
 * `<id>-opened` is in it, so pruning the twin away would silently cost the expanded-folder glyph —
 * a signal the tree has always had, and one whose absence looks like nothing rather than like a
 * bug.
 */
const wanted = new Set<string>();

/** Whether ingestion filters through `wanted`. Off only while the picker is open. */
let pruning = true;

/** Sets that are in memory in pruned form, and can therefore be widened. */
const prunedSets = new Set<string>();

/** Ids a widen has already been spent on. Without this, an id that is in no set — a rule pointing
 * at a glyph a package upgrade removed — would schedule a re-fetch on every render of every row
 * that draws it. One attempt each, then the Lucide fallback stands. */
const attemptedWiden = new Set<string>();

function want(id: string | null | undefined): boolean {
  if (!id || wanted.has(id)) return false;
  wanted.add(id);
  wanted.add(`${id}-opened`);
  return true;
}

for (const rule of DEFAULT_ICON_RULES) want(rule.icon);
for (const profile of BUILT_IN_PROFILES) {
  want(profile.defaultFolderIcon);
  for (const rule of profile.rules) want(rule.icon);
}
// This repo's own set is a handful of glyphs that are seeded, never fetched, and must survive both
// the ingest filter below and `releaseIconCatalog`. Naming them here is cheaper than teaching
// either of those about a third category.
for (const name of Object.keys(LOCAL_ICON_SET.icons)) wanted.add(`${LOCAL_ICON_SET.prefix}:${name}`);

function ingest(set: IconifySet, into: Map<string, CatalogIcon>): void {
  const setWidth = set.width ?? 16;
  const setHeight = set.height ?? 16;
  for (const [name, icon] of Object.entries(set.icons)) {
    if (pruning && !wanted.has(`${set.prefix}:${name}`)) continue;
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

// This repo's own set, seeded at module evaluation rather than fetched. Two consequences that matter:
// `iconEntry` answers for `cf:` on the very first render, so a `.cls` row never draws a fallback and
// then swaps to the real glyph a tick later; and `iconCatalogReady` below can keep asking only about
// the two fetched sets, because this one can never arrive late. `loadSet` merges into this map and
// rebuilds `flat`, so both fetched sets land on top of the seed without disturbing it.
catalog = new Map<string, CatalogIcon>();
ingest(LOCAL_ICON_SET, catalog);
flat = [...catalog.values()];
loadedSets.add(LOCAL_ICON_SET.prefix);

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
    if (pruning) prunedSets.add(prefix);
    else prunedSets.delete(prefix);
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

/**
 * Re-reads one already-loaded set so ids that were pruned away can come back.
 *
 * Debounced to a task, because the trigger is `iconEntry` answering `null` for a row — and rows
 * arrive in dozens. One pass serves all of them.
 *
 * Deleting the `loadedSets`/`pending` entries first is what makes the re-read happen at all:
 * `loadSet` short-circuits on both, and without clearing them this would hand back the stale
 * resolved promise and no glyph would ever appear.
 */
let widenTimer: ReturnType<typeof setTimeout> | null = null;
const widenQueue = new Set<string>();

function scheduleWiden(prefix: string): boolean {
  // `prunedSets` only holds a set once it has *landed* pruned. A miss before that is the ordinary
  // cold-start case — the fetch is still in flight — and answering `false` here is what tells the
  // caller not to spend its one attempt: `wanted` has the id by then, so the ingest about to run
  // will keep it and no re-read is needed at all.
  if (!SET_URLS[prefix] || !prunedSets.has(prefix)) return false;
  widenQueue.add(prefix);
  if (widenTimer !== null) return true;
  widenTimer = setTimeout(() => {
    widenTimer = null;
    const prefixes = [...widenQueue];
    widenQueue.clear();
    for (const each of prefixes) {
      loadedSets.delete(each);
      pending.delete(each);
      void loadSet(each, SET_URLS[each]);
    }
  }, 0);
  return true;
}

/**
 * Tells the catalogue about ids it must keep — the user's own profiles, which are read from disk
 * and so arrive after the first tree has already drawn.
 *
 * Called by `iconRulesStore` whenever the profile list lands or changes. Ids that were pruned away
 * before this ran are recovered by re-reading their set; ids already present cost nothing.
 */
export function declareIconIds(ids: Iterable<string | null | undefined>): void {
  const missing = new Set<string>();
  for (const id of ids) {
    if (!want(id) || !id) continue;
    const prefix = id.slice(0, id.indexOf(":"));
    if (prunedSets.has(prefix) && !catalog?.has(id)) missing.add(prefix);
  }
  for (const prefix of missing) scheduleWiden(prefix);
}

/**
 * Both sets, whole. What the picker wants: its search ranks across everything, so everything has
 * to be here — the ~3,600 glyphs this file's header is about.
 *
 * Turning `pruning` off has to be paired with dropping the load guards, since what is in memory at
 * that point is a pruned copy that `loadSet` would happily consider "loaded". The re-read is a
 * webview cache hit — these are local assets — behind the picker's existing not-ready state.
 */
export function loadIconCatalog(): Promise<void> {
  if (pruning) {
    pruning = false;
    for (const prefix of prunedSets) {
      loadedSets.delete(prefix);
      pending.delete(prefix);
    }
    prunedSets.clear();
  }
  return Promise.all([loadFileIcons(), loadBrandIcons()]).then(() => undefined);
}

/**
 * Gives back everything the picker asked for and the tree cannot use.
 *
 * Called when the picker closes. Roughly 3,500 glyphs of `vscode-icons` and 2,090 of `logos` — on
 * the order of 10 MB of SVG markup — that would otherwise stay resident for the rest of the
 * session because a dialog was opened once.
 *
 * `version` is deliberately left alone: no listener is told, because nothing on screen loses a
 * glyph. Every id a row can draw is in `wanted` and therefore survives, and anything that turns out
 * not to be is recovered by `iconEntry`'s widen — the same path a cold start already uses.
 */
export function releaseIconCatalog(): void {
  if (pruning || !catalog) return;
  pruning = true;
  for (const id of [...catalog.keys()]) {
    if (!wanted.has(id)) catalog.delete(id);
  }
  flat = [...catalog.values()];
  for (const prefix of loadedSets) {
    if (SET_URLS[prefix]) prunedSets.add(prefix);
  }
  // An id that was resolvable from the full catalogue may be gone now, so the one-attempt ledger
  // has to reopen — otherwise a rule whose glyph was pruned here could never widen it back.
  attemptedWiden.clear();
}

/** Whether a lookup against the *whole* catalogue will succeed right now — which is the question
 * the picker asks, since its search ranks across both sets. A tree row asks a narrower one and
 * simply lets `iconEntry` answer `null` until its set arrives. */
export function iconCatalogReady(): boolean {
  // The bundled `cf` set is deliberately not in the predicate: it is seeded at module evaluation, so
  // asking whether it has arrived could only ever answer yes.
  //
  // `!pruning` is the first clause and belongs in this predicate rather than beside it: a pruned
  // catalogue holds both sets by name and roughly sixty glyphs in fact, so answering "ready" for it
  // would hand the picker a search over a fiftieth of the icons with no way to tell.
  return !pruning && loadedSets.has("vscode-icons") && loadedSets.has("logos");
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

/** One glyph by id, or `null` if its set is still loading, was pruned, or the id is unknown. */
export function iconEntry(id: string): CatalogIcon | null {
  const icon = catalog?.get(id) ?? null;
  if (icon) return icon;
  // A rule pointing at a brand mark is the one way a `logos:` id reaches a file row, and the brand
  // set isn't loaded by drawing a tree. Without this the rule would silently fall back to the
  // Lucide icon forever, with nothing to retry it — a user watching their own rule do nothing.
  // Fire-and-forget: the listeners above are what re-render the row once the set lands.
  if (id.startsWith("logos:")) {
    void loadBrandIcons();
    return null;
  }
  // The safety net under the allowlist (see the header). A miss here means either an id nobody
  // declared — a rule written against a glyph the shipped profiles never name — or one that was
  // pruned before its profile had been read from disk. Either way the answer is the same: want it
  // from now on, and re-read the set once. `attemptedWiden` is what keeps "once" honest for an id
  // that is in no set at all.
  if (!attemptedWiden.has(id)) {
    // `want` first and unconditionally: if the set is still in flight this is the whole fix, since
    // the ingest that follows will keep the id. The attempt is only spent when a re-read was
    // actually scheduled, so a miss during the cold start does not burn it.
    want(id);
    if (scheduleWiden(id.slice(0, id.indexOf(":")))) attemptedWiden.add(id);
  }
  return null;
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
