import { describe, expect, it } from "vitest";
import { confirmKeyAction, focusPlace } from "./dialogKeys";

/**
 * The confirmation dialog's keys. The regression this pins: Enter with the focus on Cancel used to
 * confirm, because a window listener answered Enter before the focused button could.
 */

const panel = (inside: object[]) => ({ contains: (node: never) => inside.includes(node) });
const element = (tagName: string, interactive: boolean) => ({ tagName, matches: () => interactive });

describe("confirmKeyAction", () => {
  it("leaves Enter to whichever control has the focus — Cancel included", () => {
    expect(confirmKeyAction("Enter", "control")).toEqual({ kind: "native" });
    expect(confirmKeyAction("Enter", "control", [{ id: "save" }])).toEqual({ kind: "native" });
  });

  it("gives the default answer only when nothing interactive is focused", () => {
    expect(confirmKeyAction("Enter", "inert")).toEqual({ kind: "confirm" });
    expect(confirmKeyAction("Enter", "inert", [{ id: "save" }, { id: "discard" }])).toEqual({
      kind: "pick",
      id: "save",
    });
  });

  it("never lets Enter act behind the dialog", () => {
    expect(confirmKeyAction("Enter", "outside")).toEqual({ kind: "block" });
  });

  it("cancels on Escape wherever the focus is, and ignores other keys", () => {
    for (const place of ["control", "inert", "outside"] as const) {
      expect(confirmKeyAction("Escape", place)).toEqual({ kind: "cancel" });
      expect(confirmKeyAction("a", place)).toEqual({ kind: "ignore" });
    }
  });
});

describe("focusPlace", () => {
  it("tells a focused button from the dialog's own panel", () => {
    const cancel = element("BUTTON", true);
    const text = element("P", false);
    const dialog = panel([cancel, text]);
    expect(focusPlace(dialog, cancel)).toBe("control");
    expect(focusPlace(dialog, text)).toBe("inert");
  });

  it("reads no focus at all as inert, and focus behind the dialog as outside", () => {
    const behind = element("BUTTON", true);
    expect(focusPlace(panel([]), null)).toBe("inert");
    expect(focusPlace(panel([]), element("BODY", false))).toBe("inert");
    expect(focusPlace(panel([]), behind)).toBe("outside");
  });
});
