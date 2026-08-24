/**
 * Where the user is, and how they get back.
 *
 * # The bug this file exists for
 *
 * Every deeper view in this client used to be a boolean in the screen that opened it —
 * `openDiff`, `openCommit`, `pickingBranch`, `openChain`, `openRun` — and three of them drew
 * themselves as `fixed inset-0` overlays *on top of the tab bar*. So the only way out of a file's
 * diff was one 18-pixel chevron in the top-left corner. Miss it and there was nothing else: the
 * tabs were behind the overlay, and the phone's own back button did something far worse than
 * nothing.
 *
 * Nothing in this client had ever touched the History API. A page that never calls `pushState` has
 * exactly one history entry, so Android's back gesture — and the back button, and the three-button
 * navbar — went straight past the app: out of the PWA, or back to whatever page the browser was on
 * before. On iOS in standalone mode there is no back affordance at all, and the edge swipe does
 * nothing, because there is no browser chrome to swipe. *"Si entro a un archivo no puedo volver"*
 * is the exact and predictable consequence.
 *
 * # The model: one stack, and the invariant that makes it work
 *
 * `stack.length` **is** the number of this app's history entries above the current tab's root entry.
 * Everything else follows from keeping that true: `back()` is one `history.back()`, `popToRoot()` is
 * one `history.go(-depth)`, and the app's idea of where it is can never drift from the browser's,
 * because the browser is the only thing that writes it.
 *
 * A stack *per tab* was tried first and is the nicer iOS behaviour, and it cannot be represented in
 * a linear session history: every entry below the current one then belongs to a tab you are not on.
 * The failure is not theoretical. Open a chain on Agents, tap Repo, tap Agents — the per-tab model
 * restores the chain, so `depth()` is 1 and a back control appears, and pressing it runs
 * `history.back()`, which pops the *tab switch* and lands on Repo. A button labelled "Atrás" that
 * changes tab is worse than the bug this file was written to fix.
 *
 * So: one stack, and leaving a tab closes what was open in it. One sentence, learnable in one
 * gesture, and it makes tapping Agents always show the gate list the badge is counting.
 *
 * Four ways out of any pushed screen, and they are all the same code path:
 *
 * * the chevron in the app bar,
 * * the edge-swipe gesture (see `useSwipeBack`),
 * * the phone's own back button or gesture,
 * * tapping the tab you are already on, which pops the whole stack.
 *
 * # Why the state lives in `history.state`
 *
 * `pushState` takes an arbitrary structured-clonable value, and the whole navigation state is put
 * in it rather than in a counter that indexes some array held in memory. The array would be lost on
 * reload; `history.state` is restored by the browser. It also means `popstate` needs no
 * reconciliation logic at all — the state to restore *is* the event payload, so forward, back, and
 * a back that jumps several entries at once are one line each and cannot disagree with the stack.
 *
 * The URL is deliberately never touched. `server.rs` would serve a path — it mounts an SPA fallback
 * for exactly that — but `vite.mobile.config.ts` roots the *dev* build at the repository root, where
 * Vite's own fallback answers an unknown path with the **desktop** entry. A URL scheme that works in
 * production and serves the wrong app in development is worse than none, and there is nobody to
 * share a link with: this page is one device's control panel for one desktop on one LAN.
 */

import { create } from "zustand";
import { newId } from "./ids";
import type { CommitInfo } from "../types/domain";

export type Tab = "repo" | "prs" | "chat" | "agents" | "terminal";

export const TAB_IDS: Tab[] = ["repo", "prs", "chat", "agents", "terminal"];

/**
 * One pushed screen.
 *
 * Every field a route carries is either an id or something already on screen in the row that was
 * tapped. That is on purpose: a route goes into `history.state`, so it must be plain JSON, and
 * carrying the title means a pushed screen can draw its own app bar on the first frame instead of
 * showing an empty header while a fetch resolves.
 *
 * Every scope-bound route also carries the scope it was opened under — `repoPath`, `projectId` or
 * `workspaceId`. The stack is unwound when the scope changes, but a pop is a frame or two away and
 * these screens have buttons that write: a review's "approve" must name the project it was opened
 * for, not whichever one the picker is on by the time the tap lands.
 */
export type Route =
  | { k: "diff"; repoPath: string; path: string; staged: boolean }
  | { k: "commit"; repoPath: string; commit: CommitInfo }
  | { k: "branches"; repoPath: string }
  | { k: "chain"; workspaceId: string; chainId: string; title: string }
  | { k: "review"; projectId: string; runId: string; prId: number; iter: number }
  | { k: "job"; projectId: string; id: string; label: string }
  | { k: "settings" }
  /** The workspace/project picker. Presented as a sheet rather than a push — see `isSheet`. */
  | { k: "scope" };

/**
 * Which routes come up from the bottom behind a scrim instead of in from the side.
 *
 * A sheet is for a choice you make and dismiss; a push is for a place you go. The scope picker is
 * the only sheet, and it is one because picking a project is a modal act that then puts you back
 * exactly where you were.
 */
export function isSheet(route: Route): boolean {
  return route.k === "scope";
}

/**
 * A route once it is on the stack, with the identity React needs to tell two of them apart.
 *
 * # Why the key is minted here and not derived
 *
 * The layer list used to be keyed by `${index}-${route.k}` — position and kind — and a popped layer
 * is deliberately kept mounted for the length of its exit animation. Open the diff of a *staged*
 * file, go back, and tap an *unstaged* file within that quarter-second: both are `0-diff`, so React
 * matched the new layer to the one still sliding out and *updated* it instead of mounting it. The
 * new screen inherited the old one's state — including which side of the index it thought it was
 * showing, which is the one thing that screen's buttons act on.
 *
 * Minted in `push` rather than computed from the route's fields, so that even re-opening the very
 * same file is a different screen. It travels in `history.state`, so it survives a popstate.
 */
export type StackEntry = Route & { navKey: string };

export interface NavState {
  tab: Tab;
  /** The pushed routes, oldest first. Empty means the tab's own screen is showing. */
  stack: StackEntry[];
}

/** What actually goes into `history.state`, stamped with the page load that wrote it. */
interface StoredNav extends NavState {
  session: string;
}

/**
 * This page load's own id.
 *
 * The browser restores `history.state` across a reload, which is usually the point — and is exactly
 * wrong for the entries *underneath* the current one. `reloadIfStale` reloads the page when the
 * desktop has been rebuilt, and the entries from before that reload still carry routes into a diff
 * of a file in a project this fresh boot has not loaded yet. Stamping the session lets the popstate
 * handler tell "an entry this page pushed" from "an entry a previous life pushed", and treat the
 * second as a tab root.
 */
const SESSION = `${Date.now().toString(36)}-${newId().slice(0, 8)}`;

const TAB_KEY = "codeflow.remote.tab";
/** The key our state hides under inside `history.state`, so a value written by anything else — a
 *  browser extension, a future version of this file — is recognisably not ours. */
const STATE_KEY = "cfnav";

function storedTab(): Tab {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    return TAB_IDS.includes(raw as Tab) ? (raw as Tab) : "agents";
  } catch {
    // Safari in private browsing throws rather than returning null.
    return "agents";
  }
}

function rememberTab(tab: Tab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* nothing to do — the tab is simply not remembered across reloads */
  }
}

/**
 * A cold start: the remembered tab, and no depth.
 *
 * Deliberately **not** the stack the browser restored. `history.state` survives a reload, so a
 * phone whose page was rebuilt under it (see `reloadIfStale`) would come back inside a diff of a
 * file in a project the store has not loaded yet, on a route whose `repoPath` may no longer be the
 * selected one. Restoring the tab is the useful half of that memory; restoring the depth is the
 * half that produces a screen about nothing.
 */
function initial(): NavState {
  return { tab: storedTab(), stack: [] };
}

/**
 * Whether a `history.go()` this file asked for has not landed yet.
 *
 * `go` and `back` are **asynchronous**: the popstate arrives on a later task. Two jumps queued
 * before the first lands break the one invariant this file has, because the second is computed
 * against a depth the first has already spent. A double-tap on a tab bar is how a user produces
 * that, so it is guarded rather than documented.
 */
let navigating = false;
/** The tab to settle on once the unwind below has landed. See `select`. */
let pendingTab: Tab | null = null;
/** A dead-man's switch for `navigating`: a `go()` past the end of the history fires no popstate at
 *  all, and without this the client would refuse to navigate for the rest of the session. */
let settle: number | undefined;

function arm() {
  navigating = true;
  window.clearTimeout(settle);
  settle = window.setTimeout(() => {
    navigating = false;
    pendingTab = null;
  }, 500);
}

function disarm() {
  window.clearTimeout(settle);
  navigating = false;
}

interface NavStore extends NavState {
  /** Switches tab, closing whatever was open in the one being left. Tapping the tab you are already
   *  on pops its stack instead. */
  select: (tab: Tab) => void;
  /** Opens a route on the stack. */
  push: (route: Route) => void;
  /** Closes the top route. A no-op at a tab root, so the phone's back button keeps its own
   *  meaning there — leaving the app — rather than being swallowed. */
  back: () => void;
  /** The route on top, or `null` at a tab root. For a caller that has to check, after awaiting
   *  something slow, that the screen it belongs to is still the one on screen. */
  top: () => StackEntry | null;
  /** Closes everything that is open. */
  popToRoot: () => void;
  /** How deep the stack is — and, by the invariant, how many history entries above the tab root
   *  are ours. Every jump in this file is computed from it. */
  depth: () => number;
}

function write(next: NavState, mode: "push" | "replace") {
  const entry = { [STATE_KEY]: { session: SESSION, ...next } satisfies StoredNav };
  if (mode === "push") history.pushState(entry, "");
  else history.replaceState(entry, "");
}

export const useNav = create<NavStore>((set, get) => ({
  ...initial(),

  select: (tab) => {
    if (navigating) return;
    const state = get();
    if (state.tab === tab) {
      get().popToRoot();
      return;
    }
    rememberTab(tab);
    const depth = get().depth();
    if (depth === 0) {
      // Nothing of ours is open, so the current entry *is* the tab root and can simply become the
      // new one. Replaced rather than pushed: back then leaves the app from any tab root, which is
      // what the platform means by back on a root screen, and it keeps the history shallow.
      write({ tab, stack: [] }, "replace");
      set({ tab, stack: [] });
      return;
    }
    // Something is open. The entries holding it have to go, or they would sit under the new tab
    // describing screens from the old one — which is the failure the per-tab model could not avoid.
    // The store is updated *now* so the tab bar responds on this frame, and the history catches up
    // when the jump lands; `pendingTab` is what the handler settles on.
    set({ tab, stack: [] });
    pendingTab = tab;
    arm();
    history.go(-depth);
  },

  push: (route) => {
    if (navigating) return;
    const state = get();
    const next: NavState = {
      tab: state.tab,
      stack: [...state.stack, { ...route, navKey: newId() }],
    };
    write(next, "push");
    set(next);
  },

  // Everything that closes a screen goes through the browser rather than writing the state itself.
  // If it did not, the app's idea of where it is and the history's would drift apart on the very
  // first tap of the chevron, and the next press of the phone's own back button would restore a
  // screen the user had already closed.
  back: () => {
    if (navigating || get().depth() === 0) return;
    // Armed, like the other two.
    //
    // It was not, and that is reachable without any timing luck: a sheet has two Escape listeners on
    // it — its own and the layer stack's — so one key press ran `back()` twice in the same task,
    // both saw `navigating === false` and a depth the store had not been told about yet, and two
    // synchronous `history.back()` calls traverse two entries. From a one-deep stack that walks the
    // user out of the app. (The duplicate listener is gone too; this is the guard that makes the
    // whole class of double-intent harmless.)
    arm();
    history.back();
  },

  popToRoot: () => {
    if (navigating) return;
    const depth = get().depth();
    if (depth === 0) return;
    // One jump rather than `depth` separate `back()` calls: each of those would fire its own
    // `popstate` and animate a screen out, so a three-deep stack would play three transitions.
    arm();
    history.go(-depth);
  },

  top: () => {
    const stack = get().stack;
    return stack.length > 0 ? stack[stack.length - 1] : null;
  },

  depth: () => get().stack.length,
}));

/**
 * Wires the store to the browser's history. Called once, before the first render.
 *
 * The `replaceState` on the way in is what gives this client an entry of its own to sit on. Without
 * it the first `pushState` would put our state on the *second* entry and leave the first — the one
 * the phone lands on — with `state: null`, so the first back press would restore `initial()` while
 * the browser stayed on the page: the app would appear to jump to a random tab instead of closing
 * the diff.
 */
export function initNav(): void {
  write({ tab: useNav.getState().tab, stack: [] }, "replace");

  window.addEventListener("popstate", (event) => {
    disarm();

    // A tab change that had depth to unwind first. The jump has landed on the old tab's root entry,
    // which is now the new tab's root — rewritten in place rather than pushed, so the history does
    // not grow by a tab tap.
    if (pendingTab) {
      const tab = pendingTab;
      pendingTab = null;
      write({ tab, stack: [] }, "replace");
      useNav.setState({ tab, stack: [] });
      return;
    }

    const restored = (event.state as Record<string, StoredNav> | null)?.[STATE_KEY];
    // No state of ours on this entry means the browser has gone back past everything this page
    // pushed and is on its way somewhere else. A state from a *previous* page load — the reload
    // `reloadIfStale` forces — is not ours either: its routes name things this boot has not loaded.
    // Both land on a tab root, which is a screen that is always true.
    if (!restored || restored.session !== SESSION) {
      const next = { tab: restored?.tab ?? initial().tab, stack: [] };
      rememberTab(next.tab);
      useNav.setState(next);
      return;
    }
    rememberTab(restored.tab);
    useNav.setState({ tab: restored.tab, stack: restored.stack });
  });
}

/**
 * Drops any open route that a change of scope has made meaningless, without touching the tab.
 *
 * A pushed screen names a repository path, a chain or a review run. Switch project at the top of
 * the app and the diff you were reading is a diff of a file in a repository that is no longer
 * selected — it would keep rendering, and keep being *right*, which is worse than being wrong
 * because nothing on screen says the scope moved underneath it.
 */
export function resetDepth(): void {
  if (useNav.getState().stack.length === 0) return;
  useNav.getState().popToRoot();
}
