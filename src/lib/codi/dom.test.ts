import { beforeEach, describe, expect, it } from "vitest";
import { listControls, pressControl, resetControlsForTests, soundsDestructive, isPrivateControl } from "./dom";

/**
 * The generic fallback, on a hand-built tree — there is no DOM in these tests, and `dom.ts` is
 * written against the slice of `Element` this fake provides. The rules under test: private fields
 * and passwords are never listed (nor pressable by a guessed ref), and a destructive-sounding press
 * needs `confirmed`.
 */

class FakeElement {
  readonly tagName: string;
  readonly attrs: Map<string, string>;
  parentElement: FakeElement | null = null;
  textContent: string;
  isConnected = true;
  ownerDocument = null;
  clicks = 0;
  value?: string;

  constructor(tag: string, attrs: Record<string, string> = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.textContent = text;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  getClientRects(): unknown[] {
    return this.attrs.has("data-test-offscreen") ? [] : [{}];
  }

  click(): void {
    this.clicks += 1;
  }

  focus(): void {}

  dispatchEvent(): boolean {
    return true;
  }

  /** Puts `child` under this element and returns it. */
  add<T extends FakeElement>(child: T): T {
    child.parentElement = this;
    return child;
  }
}

/** A root whose `querySelectorAll` hands back the controls (and no modal dialogs). */
function rootOf(controls: FakeElement[]): ParentNode {
  return {
    querySelectorAll: (selector: string) => (selector.includes("dialog") ? [] : controls),
  } as unknown as ParentNode;
}

const el = (tag: string, attrs: Record<string, string> = {}, text = "") => new FakeElement(tag, attrs, text);

let vault: FakeElement;
let save: FakeElement;
let remove: FakeElement;
let password: FakeElement;
let token: FakeElement;
let secretRow: FakeElement;
let hidden: FakeElement;
let search: FakeElement;
let controls: FakeElement[];

beforeEach(() => {
  resetControlsForTests();
  const app = el("div");
  vault = app.add(el("div", { "data-codi-private": "" })).add(el("button", {}, "Copy password"));
  save = app.add(el("button", { "aria-label": "Save" }));
  remove = app.add(el("button", {}, "Eliminar rama"));
  password = app.add(el("input", { type: "password", "aria-label": "Master password" }));
  // A token field whose "show" toggle made it plain text: private by its autocomplete hint.
  token = app.add(el("input", { type: "text", autocomplete: "new-password", placeholder: "Token" }));
  secretRow = app.add(el("div", { "data-codi-private": "true" })).add(el("input", { placeholder: "Value" }));
  hidden = app.add(el("div", { hidden: "" })).add(el("button", {}, "Ghost"));
  search = app.add(el("input", { type: "search", placeholder: "Search notes" }));
  search.value = "invoices";
  controls = [vault, save, remove, password, token, secretRow, hidden, search];
});

describe("listControls", () => {
  it("lists what the user can see and use, and nothing private", () => {
    const { controls: listed } = listControls(rootOf(controls));
    expect(listed.map((c) => c.name)).toEqual(["Save", "Eliminar rama", "Search notes"]);
    expect(listed.find((c) => c.name === "Search notes")).toMatchObject({ role: "textbox", value: "invoices" });
  });

  it("knows a private control by its marker, its type or its autocomplete hint", () => {
    expect(isPrivateControl(vault as unknown as Element)).toBe(true);
    expect(isPrivateControl(password as unknown as Element)).toBe(true);
    expect(isPrivateControl(token as unknown as Element)).toBe(true);
    expect(isPrivateControl(secretRow as unknown as Element)).toBe(true);
    expect(isPrivateControl(save as unknown as Element)).toBe(false);
  });

  it("filters by name, keeps refs stable across listings, and lists nothing in the keyring's island", () => {
    const first = listControls(rootOf(controls)).controls;
    const again = listControls(rootOf(controls), { filter: "save" }).controls;
    expect(again).toEqual([{ ref: first[0].ref, role: "button", name: "Save" }]);
    expect(listControls(rootOf(controls), { everythingPrivate: true }).controls).toEqual([]);
  });
});

describe("pressControl", () => {
  it("presses a harmless control straight away", () => {
    const { controls: listed } = listControls(rootOf(controls));
    expect(pressControl(listed.find((c) => c.name === "Save")!.ref)).toEqual({ ok: true, name: "Save", role: "button" });
    expect(save.clicks).toBe(1);
  });

  it("refuses a destructive-sounding press until it is confirmed", () => {
    const { controls: listed } = listControls(rootOf(controls));
    const ref = listed.find((c) => c.name === "Eliminar rama")!.ref;
    expect(pressControl(ref)).toEqual({ ok: false, error: "needs-confirmation", name: "Eliminar rama" });
    expect(remove.clicks).toBe(0);
    expect(pressControl(ref, true)).toMatchObject({ ok: true });
    expect(remove.clicks).toBe(1);
  });

  it("refuses refs that were not in the latest listing", () => {
    expect(pressControl("c999")).toMatchObject({ ok: false });
    listControls(rootOf(controls));
    // The private button was never given a ref, so no ref reaches it.
    expect(vault.clicks).toBe(0);
  });
});

describe("soundsDestructive", () => {
  it("hears the words in both languages, accents or not", () => {
    for (const name of ["Delete branch", "Eliminar", "Borrar todo", "Descartar cambios", "Force push", "Forzar", "Merge", "Enviar", "Send", "Remove", "Vaciar papelera", "Push"]) {
      expect(soundsDestructive(name), name).toBe(true);
    }
  });

  it("leaves ordinary verbs alone", () => {
    // "Borrador" and "Sender" start like "borra" and "send", and are neither.
    for (const name of ["Save", "Guardar", "Open", "Abrir", "Sender settings", "Guardar borrador"]) {
      expect(soundsDestructive(name), name).toBe(false);
    }
  });
});
