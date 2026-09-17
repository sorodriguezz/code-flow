import { describe, expect, it } from "vitest";
import type { Translate } from "../../state/languageStore";
import { vncBridgeFailure } from "./vncBridge";

/**
 * Which sentence a close frame earns.
 *
 * What these hold down is the seam between two processes. The bridge classifies an `io::Error` it
 * alone can see and spells the verdict into 123 bytes of close-frame reason; this side turns that
 * back into wording. Neither half fails to compile when the other renames a token, so the tokens
 * are asserted here by name — `src-tauri/src/remotes/wsbridge.rs` asserts the same strings from its
 * end, and between them a rename that breaks the pair stops being silent.
 *
 * The `null` cases matter as much as the rest: a close that carries no diagnosis has to stay
 * indistinguishable from one that never went through this at all, or an ordinary hangup starts
 * reading as a connect failure.
 */

/** Stands in for the translator — returns the key, so a test can assert which one was picked. */
const t: Translate = (key, params) =>
  params
    ? `${key}|${Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(",")}`
    : key;

/** A close event as the function reads it: a code and a reason, and nothing else. */
const closed = (code: number, reason: string) => ({ code, reason }) as CloseEvent;

describe("vncBridgeFailure", () => {
  it("names a refused port", () => {
    expect(vncBridgeFailure(closed(4000, "refused"), t)).toBe("remote.vncRefused");
  });

  it("names a host with no route to it", () => {
    expect(vncBridgeFailure(closed(4000, "unreachable"), t)).toBe("remote.vncUnreachable");
  });

  it("names a host that never answered", () => {
    expect(vncBridgeFailure(closed(4000, "timeout"), t)).toBe("remote.vncTimedOut");
  });

  it("names the permission macOS withheld, which is the whole reason this exists", () => {
    expect(vncBridgeFailure(closed(4000, "blocked"), t)).toBe("remote.vncBlocked");
  });

  it("carries the OS's own text through for a failure it has no wording for", () => {
    expect(vncBridgeFailure(closed(4000, "failed:Operation not permitted"), t)).toBe(
      "remote.vncBridgeFailed|detail=Operation not permitted",
    );
  });

  it("keeps a detail that has colons of its own", () => {
    expect(vncBridgeFailure(closed(4000, "failed:connect: bad address"), t)).toBe(
      "remote.vncBridgeFailed|detail=connect: bad address",
    );
  });

  it("says nothing about a connection that simply dropped", () => {
    // 1006 with an empty reason is what an aborted socket looks like — including every one this
    // whole path was built to stop being the only thing the user ever saw.
    expect(vncBridgeFailure(closed(1006, ""), t)).toBeNull();
  });

  it("says nothing about a tidy shutdown, even one carrying text", () => {
    // Only 4000 is ours. A reason on any other code belongs to whoever sent it.
    expect(vncBridgeFailure(closed(1000, "refused"), t)).toBeNull();
  });

  it("falls back to the generic wording for a token it doesn't know", () => {
    // An app talking to an older or newer bridge. Unrecognised must read as "no diagnosis", never
    // throw inside a close handler.
    expect(vncBridgeFailure(closed(4000, "kaput"), t)).toBeNull();
    expect(vncBridgeFailure(closed(4000, ""), t)).toBeNull();
  });

  it("falls back when a detail was promised and not delivered", () => {
    expect(vncBridgeFailure(closed(4000, "failed:"), t)).toBeNull();
    expect(vncBridgeFailure(closed(4000, "failed:   "), t)).toBeNull();
  });
});
