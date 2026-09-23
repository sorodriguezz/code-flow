import { describe, expect, it } from "vitest";
import { parseIdentity } from "./windowIdentity";

/**
 * The contract between `src-tauri/src/windows.rs` and every guard in the frontend.
 *
 * Both halves are written on the Rust side — the label by `label_for`, the query string by
 * `open_satellite` — and read only here. What makes it worth a test rather than a careful reading
 * is the shape of the failure: a satellite misread as the main window does not look broken. It
 * quietly starts a second agent-chain executor, a second update checker and a second set of
 * pollers, and the first symptom is a chain step claimed twice.
 */
describe("window identity", () => {
  it("treats the main window as the main window", () => {
    const identity = parseIdentity("main", "");
    expect(identity.main).toBe(true);
    expect(identity.satellite).toBeNull();
  });

  it("reads what an app window holds", () => {
    // Exactly what `open_satellite` builds for the API client: the colon is percent-encoded on the
    // way out and `URLSearchParams` decodes it back.
    const identity = parseIdentity("sat-app-api_requests", "?kind=app&ref=api%3Arequests");
    expect(identity.main).toBe(false);
    expect(identity.satellite).toEqual({ kind: "app", refId: "api:requests" });
  });

  it("reads what a repository window holds", () => {
    const identity = parseIdentity("sat-repo-abc123", "?kind=repo&ref=abc123");
    expect(identity.satellite).toEqual({ kind: "repo", refId: "abc123" });
  });

  /**
   * The workspace it was opened from, which is where it opens.
   *
   * Without it an app window came back on whatever it was last switched to — or, when that
   * workspace had been deleted, on the first one in the list — instead of on the workspace the user
   * was looking at when they opened it.
   */
  it("reads the workspace it was opened from, and nothing when restored", () => {
    const opened = parseIdentity("sat-app-notes", "?kind=app&ref=notes&ws=62a2a45f-2441-4d42");
    expect(opened.openedIn).toBe("62a2a45f-2441-4d42");
    expect(opened.satellite).toEqual({ kind: "app", refId: "notes" });
    expect(parseIdentity("sat-app-notes", "?kind=app&ref=notes").openedIn).toBeNull();
    expect(parseIdentity("sat-app-notes", "?kind=app&ref=notes&ws=").openedIn).toBeNull();
    expect(parseIdentity("main", "?ws=62a2a45f").openedIn).toBeNull();
  });

  /**
   * The quick-ask window, which is the kind this guard forgot.
   *
   * `windows.rs` builds it as `window.html?kind=quick&ref=ask`, and for as long as `parseIdentity`
   * listed only `app` and `repo` it answered `satellite: null` for a window that was otherwise
   * perfectly healthy — so `SatelliteApp` fell through to its "nothing readable" branch and painted
   * a skeleton under a global hotkey, forever. Nothing failed loudly: the webview loaded, the label
   * was right, and every check but this one passed.
   */
  it("reads the quick-ask window", () => {
    const identity = parseIdentity("sat-quick-ask", "?kind=quick&ref=ask");
    expect(identity.main).toBe(false);
    expect(identity.satellite).toEqual({ kind: "quick", refId: "ask" });
  });

  /** The prefix is the whole of the test, so a window called `mobile` or `settings` one day is not
   *  silently treated as a satellite. */
  it("only the sat- prefix makes a satellite", () => {
    expect(parseIdentity("mobile", "?kind=app&ref=notes").main).toBe(true);
    expect(parseIdentity("main", "?kind=app&ref=notes").satellite).toBeNull();
  });

  /**
   * The direction the failure has to fall.
   *
   * A satellite whose query string is missing, truncated or from a future version is still a
   * satellite: it renders "this window holds something this version does not know about". Falling
   * back to `main: true` would be the one wrong answer — it would arm every scheduler a second
   * time in a window that has no UI for any of them.
   */
  it("a satellite with an unreadable query string is still a satellite", () => {
    for (const search of ["", "?kind=app", "?ref=notes", "?kind=nonsense&ref=notes"]) {
      const identity = parseIdentity("sat-app-notes", search);
      expect(identity.main, `search=${search}`).toBe(false);
      expect(identity.satellite, `search=${search}`).toBeNull();
    }
  });
});
