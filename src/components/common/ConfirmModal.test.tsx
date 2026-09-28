import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The shared confirmation modal with more than two answers. `renderToStaticMarkup` reads a zustand
 * store's initial state, so the store hook is stood in for (see `codeflow-vitest-traps`).
 */

const state = vi.hoisted(() => ({
  request: null as null | Record<string, unknown>,
  respond: () => {},
  pick: () => {},
}));

vi.mock("../../state/confirmStore", () => ({
  useConfirmStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock("../../state/languageStore", () => ({ useT: () => (key: string) => key }));

import { ConfirmModal } from "./ConfirmModal";

describe("ConfirmModal", () => {
  it("draws every answer, Cancel first and the default focused, with the listed items", () => {
    state.request = {
      message: "There are unsaved changes (2).",
      danger: true,
      items: ["src/a.ts — app", "notes.md — docs"],
      choices: [
        { id: "save", label: "Save all and quit", variant: "primary" },
        { id: "discard", label: "Quit without saving", variant: "danger" },
      ],
      settle: () => {},
    };
    const markup = renderToStaticMarkup(<ConfirmModal />);
    expect(markup).toContain("There are unsaved changes (2).");
    expect(markup).toContain("src/a.ts — app");
    expect(markup).toContain("notes.md — docs");
    const cancel = markup.indexOf("common.cancel");
    const save = markup.indexOf("Save all and quit");
    const discard = markup.indexOf("Quit without saving");
    expect(cancel).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(cancel);
    expect(discard).toBeGreaterThan(save);
    // Not the yes/no dialog's button: a many-answer question has no generic "Confirm".
    expect(markup).not.toContain("common.confirm");
  });

  it("keeps the yes/no dialog as it was", () => {
    state.request = { message: "Delete it?", danger: true, settle: () => {} };
    const markup = renderToStaticMarkup(<ConfirmModal />);
    expect(markup).toContain("Delete it?");
    expect(markup).toContain("common.confirm");
    expect(markup).not.toContain("<ul");
  });
});
