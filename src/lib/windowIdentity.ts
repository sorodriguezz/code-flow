import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Which window this code is running in, answered synchronously and answered once.
 *
 * # Why synchronous matters
 *
 * Half the things that read this are module-scope guards — "only the main window runs the agent
 * chain executor", "only the main window polls for pull requests" — and a guard that has to await
 * its answer is a guard that does not exist for the first few hundred milliseconds, which is
 * exactly the window in which a freshly opened satellite would start a second executor. Tauri keeps
 * the label in the webview's injected metadata, so `getCurrentWindow()` is a property read, not a
 * round trip.
 *
 * # Why it degrades to "main" outside Tauri
 *
 * The mobile bundle (`mobile.html`) and the unit tests run this code in an ordinary browser, where
 * there is no window system to ask. There is exactly one context in both cases, so "this is the
 * main one" is not a fallback so much as the truth: the alternative — treating an unknown context
 * as a satellite — would silently disable the executor, the pollers and the schedulers in the only
 * place they could run.
 */

/** Mirrors `LABEL_PREFIX` in `src-tauri/src/windows.rs`. */
const SATELLITE_PREFIX = "sat-";

/** What a satellite window holds. Mirrors `SatelliteKind` on the Rust side. */
export type SatelliteKind = "app" | "repo";

export interface WindowIdentity {
  /** The platform's own window label — `"main"`, or `sat-app-notes`. */
  label: string;
  /** `true` for the one window that owns the shell, the workspace selection and every scheduler. */
  main: boolean;
  /** What this satellite holds, or `null` in the main window. */
  satellite: { kind: SatelliteKind; refId: string } | null;
}

/**
 * The whole of the identity rule, as a pure function — which is what makes it testable.
 *
 * The two inputs are the only two the platform gives a window: the label it was built with, and
 * the query string it was loaded with. `windows.rs` writes both, and this is the only place either
 * is read, so the pair of them is the contract between the two sides. It is pinned by a test
 * because the failure it prevents is silent: a satellite that reads its identity as "main" would
 * start the agent-chain executor, the update checker and the pollers a second time.
 */
export function parseIdentity(label: string, search: string): WindowIdentity {
  if (!label.startsWith(SATELLITE_PREFIX)) {
    return { label, main: true, satellite: null };
  }

  // The identity travels in the query string the window was opened with, so the first frame can be
  // painted without a command round trip. `Url::join` on the Rust side preserves it verbatim.
  const params = new URLSearchParams(search);
  const kind = params.get("kind");
  const refId = params.get("ref") ?? "";
  return {
    label,
    main: false,
    // A satellite whose query string says nothing readable is still a satellite — it must not
    // fall back to being the main window, which is the one mistake with real consequences. It
    // renders "this window holds something this version does not know about" instead.
    satellite: (kind === "app" || kind === "repo") && refId ? { kind, refId } : null,
  };
}

function read(): WindowIdentity {
  try {
    return parseIdentity(getCurrentWindow().label, window.location.search);
  } catch {
    // No Tauri here — see the note above.
    return { label: "main", main: true, satellite: null };
  }
}

/**
 * Computed once at module load and never again. A window does not change what it is: the label is
 * fixed when the window is built, and the query string is fixed with it.
 */
export const WINDOW: WindowIdentity = read();

/** The guard every scheduler, poller and executor is wrapped in. See the module note. */
export function isMainWindow(): boolean {
  return WINDOW.main;
}
