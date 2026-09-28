import { describe, expect, it } from "vitest";
import { isTopLayer, pushLayer, shortcutBlockedByDialog, topLayer } from "./useFocusTrap";

/**
 * The dialog layer stack. What it fixes: a confirmation opened from Settings used to close
 * Settings too on one Escape, and app chords ran behind open dialogs.
 */

const dialog = (owner?: string) => ({ dataset: owner ? { shortcutOwner: owner } : {} }) as unknown as HTMLElement;

describe("the dialog layer stack", () => {
  it("gives Escape to the dialog opened last, and back when it closes", () => {
    const settings = dialog("app.settings");
    const confirm = dialog();
    const popSettings = pushLayer(settings);
    const popConfirm = pushLayer(confirm);
    expect(isTopLayer(confirm)).toBe(true);
    expect(isTopLayer(settings)).toBe(false);
    popConfirm();
    expect(isTopLayer(settings)).toBe(true);
    popSettings();
    expect(topLayer()).toBeNull();
  });

  it("lets only the top dialog's own chord through", () => {
    expect(shortcutBlockedByDialog("view.graph")).toBe(false);
    const pop = pushLayer(dialog("app.commandPalette project.switcher"));
    expect(shortcutBlockedByDialog("view.graph")).toBe(true);
    expect(shortcutBlockedByDialog("app.commandPalette")).toBe(false);
    expect(shortcutBlockedByDialog("project.switcher")).toBe(false);
    pop();
    expect(shortcutBlockedByDialog("view.graph")).toBe(false);
  });

  it("survives dialogs closing out of order", () => {
    const first = dialog();
    const second = dialog();
    const popFirst = pushLayer(first);
    const popSecond = pushLayer(second);
    popFirst();
    expect(isTopLayer(second)).toBe(true);
    popSecond();
    expect(topLayer()).toBeNull();
  });
});
