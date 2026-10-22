import { foldName } from "./fuzzy";

/**
 * The generic fallback: what «Codi» can reach when no typed action covers it.
 *
 * `ui.controls` lists the interactive elements this window is showing — role, accessible name, a
 * short ref — and `ui.press` / `ui.fill` act on one by its ref. It is how "press Format" or "fill the
 * search box with invoices" works on a screen nobody wrote an action for. The typed actions stay the
 * preferred route: they do not break when a button is renamed, and this does.
 *
 * # What it never touches
 *
 * - **Anything inside `[data-codi-private]`.** The keyring's views carry it on their root (`VaultView`),
 *   and so do the fields that reveal a secret when asked to (a token's "show" toggle turns its input
 *   into `type=text`, which would otherwise make it fair game).
 * - **Password fields**, by type and by `autocomplete` — whatever their surroundings say.
 * - **The keyring's own island**, all of it: a window that *is* the vault lists nothing.
 *
 * A private control is not listed, cannot be pressed or filled by a ref guessed from an earlier
 * listing, and its value is never read — the rule `cf` keeps for secrets (used, never shown).
 *
 * # Pressing something that cannot be taken back
 *
 * A control whose name sounds destructive — delete, discard, push, send, merge, force… in either
 * language — is refused with `needs-confirmation` unless the request says `confirmed: true`. The
 * backend asks the user out loud and resends; the check is here, beside the press, so no engine can
 * skip it by phrasing the request differently.
 *
 * # Testable without a browser
 *
 * The tests run in node, with no DOM. Everything below reads elements through a small slice of the
 * `Element` interface — attributes, the parent chain, text, rects — never through `instanceof
 * HTMLInputElement` or a global, so a hand-built node tree exercises the same code the webview runs.
 */

/** What is listed for one control. Flags appear only when true, to keep the listing short. */
export interface ControlEntry {
  ref: string;
  role: string;
  name: string;
  disabled?: true;
  checked?: true;
  expanded?: true;
  current?: true;
  /** A text field's value, shortened — never for a private field. */
  value?: string;
}

/** How many controls one listing returns. Past this a screen is better reached by `filter`. */
export const MAX_CONTROLS = 80;

const INTERACTIVE = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[contenteditable='']",
  ...[
    "button",
    "link",
    "menuitem",
    "menuitemradio",
    "menuitemcheckbox",
    "tab",
    "option",
    "checkbox",
    "switch",
    "radio",
    "combobox",
    "textbox",
    "searchbox",
    "treeitem",
  ].map((role) => `[role='${role}']`),
].join(", ");

/** The words that make a press need a "yes" first, folded (no accents, lowercase). */
const DESTRUCTIVE =
  /(^|[^a-z])(eliminar|elimina|eliminalo|eliminala|borrar|borra|borralo|borrala|borrarlo|delete|deletes|remove|quitar|quita|push|enviar|envia|send|merge|fusionar|forzar|fuerza|force|descartar|descarta|discard|vaciar|vacia|purge|purgar|reset|restablecer|overwrite|sobrescribir|quit)([^a-z]|$)/;

/** Whether a control called `name` does something that is not taken back with a click. */
export function soundsDestructive(name: string): boolean {
  const folded = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return DESTRUCTIVE.test(folded);
}

function attr(el: Element, name: string): string | null {
  return el.getAttribute(name);
}

function tag(el: Element): string {
  return el.tagName.toLowerCase();
}

/** A password by any of the names a field can give itself one. */
export function isPasswordField(el: Element): boolean {
  if (tag(el) !== "input") return false;
  if ((attr(el, "type") ?? "").toLowerCase() === "password") return true;
  const complete = (attr(el, "autocomplete") ?? "").toLowerCase();
  return complete.includes("password") || complete === "one-time-code";
}

/** Inside `[data-codi-private]`, or a password field — never listed, pressed, filled or read. */
export function isPrivateControl(el: Element): boolean {
  if (isPasswordField(el)) return true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("data-codi-private")) return true;
  }
  return false;
}

/** Hidden from the user — by layout, by `hidden`/`inert`, or by `aria-hidden` on the way up. */
function isHidden(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.hasAttribute("inert") || attr(node, "aria-hidden") === "true") return true;
  }
  const visible = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof visible === "function") return !visible.call(el);
  return el.getClientRects().length === 0;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The accessible name, the way a screen reader would look for it — the name the UI gives a control. */
export function accessibleName(el: Element): string {
  const label = attr(el, "aria-label");
  if (label?.trim()) return clip(label.trim());
  const labelledBy = attr(el, "aria-labelledby");
  if (labelledBy && el.ownerDocument) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => textOf(el.ownerDocument.getElementById(id)))
      .filter(Boolean)
      .join(" ");
    if (text) return clip(text);
  }
  const labels = (el as Element & { labels?: ArrayLike<Element> | null }).labels;
  if (labels && labels.length > 0) {
    const text = textOf(labels[0]);
    if (text) return clip(text);
  }
  for (const name of ["placeholder", "title", "alt", "name"]) {
    const value = attr(el, name);
    if (value?.trim()) return clip(value.trim());
  }
  // A field's text is its value, not its name.
  if (!isTextField(el)) {
    const text = textOf(el);
    if (text) return clip(text);
  }
  return "";
}

/** A field one types into — an input that takes text, a textarea, or something contenteditable. */
export function isTextField(el: Element): boolean {
  const name = tag(el);
  if (name === "textarea") return true;
  if (name === "input") {
    const type = (attr(el, "type") ?? "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "number", ""].includes(type);
  }
  const editable = attr(el, "contenteditable");
  return editable === "" || editable === "true";
}

/** The role a control plays: its own `role`, else what its tag means. */
export function roleOf(el: Element): string {
  const role = attr(el, "role");
  if (role) return role;
  const name = tag(el);
  if (name === "a") return "link";
  if (name === "select") return "combobox";
  if (name === "summary") return "button";
  if (name === "textarea") return "textbox";
  if (name === "input") {
    const type = (attr(el, "type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return type;
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "range") return "slider";
    return "textbox";
  }
  if (isTextField(el)) return "textbox";
  return name === "button" ? "button" : name;
}

function isDisabled(el: Element): boolean {
  if (el.hasAttribute("disabled") || attr(el, "aria-disabled") === "true") return true;
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (tag(node) === "fieldset" && node.hasAttribute("disabled")) return true;
  }
  return false;
}

// Refs stay with their element across listings, so a press after a fresh listing still means the
// control the engine was looking at. Only what the latest listing returned can be pressed: a ref
// from three screens ago names an element that may still exist and no longer be what it was.
const refByElement = new WeakMap<Element, string>();
let listed = new Map<string, Element>();
let counter = 0;

function refFor(el: Element): string {
  let ref = refByElement.get(el);
  if (!ref) {
    counter += 1;
    ref = `c${counter}`;
    refByElement.set(el, ref);
  }
  return ref;
}

/** The narrowest place the user can act in right now: the topmost modal dialog, else everything. */
function scopeOf(root: ParentNode): ParentNode {
  const dialogs = [...root.querySelectorAll("[role='dialog'][aria-modal='true'], dialog[open]")].filter(
    (dialog) => !isHidden(dialog),
  );
  return dialogs.length > 0 ? dialogs[dialogs.length - 1] : root;
}

export interface ListOptions {
  /** Keep only controls whose name or role contains these words (case and accents ignored). */
  filter?: string;
  /** The whole window is private — the keyring's island. */
  everythingPrivate?: boolean;
}

/** The controls this window shows, with fresh refs for the ones listed. See the module note. */
export function listControls(root: ParentNode, options: ListOptions = {}): { controls: ControlEntry[]; truncated: number } {
  listed = new Map();
  if (options.everythingPrivate) return { controls: [], truncated: 0 };
  const wanted = options.filter ? foldName(options.filter) : "";
  const controls: ControlEntry[] = [];
  let truncated = 0;
  for (const el of scopeOf(root).querySelectorAll(INTERACTIVE)) {
    if (isPrivateControl(el) || isHidden(el)) continue;
    const role = roleOf(el);
    const name = accessibleName(el);
    if (!name && role !== "textbox") continue;
    if (wanted && !foldName(`${name} ${role}`).includes(wanted)) continue;
    if (controls.length >= MAX_CONTROLS) {
      truncated += 1;
      continue;
    }
    const ref = refFor(el);
    listed.set(ref, el);
    const entry: ControlEntry = { ref, role, name };
    if (isDisabled(el)) entry.disabled = true;
    if (attr(el, "aria-checked") === "true" || (el as Element & { checked?: boolean }).checked === true) entry.checked = true;
    if (attr(el, "aria-expanded") === "true") entry.expanded = true;
    const current = attr(el, "aria-current");
    if ((current && current !== "false") || attr(el, "aria-selected") === "true") entry.current = true;
    if (isTextField(el)) {
      const value = (el as Element & { value?: unknown }).value;
      const text = typeof value === "string" ? value : tag(el) === "input" || tag(el) === "textarea" ? "" : textOf(el);
      if (text) entry.value = clip(text, 40);
    }
    controls.push(entry);
  }
  return { controls, truncated };
}

export type PressOutcome =
  | { ok: true; name: string; role: string }
  | { ok: false; error: "needs-confirmation"; name: string }
  | { ok: false; error: string };

/** The element a ref from the latest listing names, if it is still there and still allowed. */
function resolve(ref: string): Element | string {
  const el = listed.get(ref);
  if (!el) return `unknown ref "${ref}" — list the controls again (ui.controls) and use a ref from that listing`;
  if (!el.isConnected) return `"${ref}" is no longer on screen — list the controls again`;
  if (isPrivateControl(el)) return "that control is private";
  return el;
}

/** Clicks the control `ref` names. Destructive-sounding ones need `confirmed` — see the module note. */
export function pressControl(ref: string, confirmed = false): PressOutcome {
  const el = resolve(ref);
  if (typeof el === "string") return { ok: false, error: el };
  const name = accessibleName(el);
  if (isDisabled(el)) return { ok: false, error: `"${name}" is disabled` };
  if (!confirmed && soundsDestructive(`${name} ${attr(el, "title") ?? ""}`)) {
    return { ok: false, error: "needs-confirmation", name };
  }
  (el as Element & { focus?: () => void }).focus?.();
  (el as Element & { click: () => void }).click();
  return { ok: true, name, role: roleOf(el) };
}

/**
 * Puts `value` into a field the way typing would, so a React-controlled input keeps it: the
 * element's own `value` setter, then `input` (and `change` for a select). Assigning `value` alone is
 * undone on the next render — the same point `insertDictation` makes.
 */
export function setFieldValue(el: Element, value: string): void {
  const proto = Object.getPrototypeOf(el) as object | null;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : undefined;
  if (setter) setter.call(el, value);
  else (el as Element & { value: string }).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  if (tag(el) === "select") el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Replaces what the field `ref` names holds with `text`. */
export function fillControl(ref: string, text: string): PressOutcome {
  const el = resolve(ref);
  if (typeof el === "string") return { ok: false, error: el };
  const name = accessibleName(el);
  if (isDisabled(el)) return { ok: false, error: `"${name}" is disabled` };
  const role = roleOf(el);
  (el as Element & { focus?: () => void }).focus?.();
  if (tag(el) === "input" || tag(el) === "textarea" || tag(el) === "select") {
    if (tag(el) !== "select" && !isTextField(el)) return { ok: false, error: `"${name}" is a ${role}, not a text field` };
    setFieldValue(el, text);
    return { ok: true, name, role };
  }
  if (isTextField(el)) {
    // contenteditable: select what is there and type over it, which the editors built on it hear.
    const doc = el.ownerDocument;
    doc.getSelection()?.selectAllChildren(el);
    doc.execCommand("insertText", false, text);
    return { ok: true, name, role };
  }
  return { ok: false, error: `"${name}" is a ${role}, not a text field` };
}

/** Tests only. */
export function resetControlsForTests(): void {
  listed = new Map();
  counter = 0;
}
