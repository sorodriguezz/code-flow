import { beforeEach, describe, expect, it } from "vitest";
import { chooseAction, confirmAction, useConfirmStore } from "./confirmStore";

/**
 * The shared confirmation modal's store, now with a many-answer form. What must not change: a
 * question that is replaced or cancelled resolves as "no" — never hangs, never picks an answer.
 */

beforeEach(() => useConfirmStore.setState({ request: null }));

describe("confirm store", () => {
  it("still answers a yes/no question with a boolean", async () => {
    const asked = confirmAction("Delete it?");
    useConfirmStore.getState().respond(true);
    expect(await asked).toBe(true);

    const cancelled = confirmAction("Delete it?");
    useConfirmStore.getState().respond(false);
    expect(await cancelled).toBe(false);
  });

  it("answers a many-answer question with the chosen id, and cancel with null", async () => {
    const choices = [
      { id: "compare", label: "Compare" },
      { id: "overwrite", label: "Overwrite", variant: "danger" as const },
    ];
    const asked = chooseAction({ message: "Changed on disk", choices, items: ["a.ts"] });
    expect(useConfirmStore.getState().request).toMatchObject({ choices, items: ["a.ts"] });
    useConfirmStore.getState().pick("overwrite");
    expect(await asked).toBe("overwrite");

    const cancelled = chooseAction({ message: "Changed on disk", choices });
    useConfirmStore.getState().respond(false);
    expect(await cancelled).toBeNull();
  });

  it("resolves a question another one replaced as cancelled, whichever form either was", async () => {
    const first = chooseAction({ message: "Leave?", choices: [{ id: "save", label: "Save" }] });
    const second = confirmAction("Quit?");
    expect(await first).toBeNull();
    useConfirmStore.getState().respond(true);
    expect(await second).toBe(true);

    const third = confirmAction("Quit?");
    const fourth = chooseAction({ message: "Leave?", choices: [{ id: "save", label: "Save" }] });
    expect(await third).toBe(false);
    useConfirmStore.getState().pick("save");
    expect(await fourth).toBe("save");
  });

  it("never turns the single confirm button into a choice", async () => {
    const asked = chooseAction({ message: "Leave?", choices: [{ id: "save", label: "Save" }] });
    // What Enter on a plain dialog does — here it must not be read as one of the ids.
    useConfirmStore.getState().respond(true);
    expect(await asked).toBeNull();
  });
});
