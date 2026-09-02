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
