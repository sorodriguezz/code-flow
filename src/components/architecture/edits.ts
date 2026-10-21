/**
 * The edits the editor's panels make, as text edits on the open document — see `jsonEdit`. Each
 * reads the current text from the store, so two quick edits compose instead of the second undoing
 * the first.
 */
import { appendAt, formatDoc, removeAt, setAt, type JsonPath } from "../../lib/architecture/jsonEdit";
import { parseArchText } from "../../lib/architecture/parse";
import { isGroup, isZone, type ArchComponent, type ArchDoc, type Connection, type LayoutNode } from "../../lib/architecture/types";
import { useArchitectureStore } from "../../state/architectureStore";
import { pushErrorToast } from "../../state/toastStore";
import { translate } from "../../state/languageStore";

function edit(fn: (text: string) => string): boolean {
  const store = useArchitectureStore.getState();
  const text = store.draft?.text;
  if (text == null) return false;
  try {
    const next = fn(text);
    if (next !== text) store.editText(next);
    return true;
  } catch {
    // The text is mid-edit and does not parse; the panel's change waits for valid JSON.
    pushErrorToast(translate("arch.editNeedsValidJson"));
    return false;
  }
}

/**
 * A structural change from the canvas — a move, a drop, a delete — as a whole new document. These
 * rewrite the text from the parsed document (`formatDoc`), so comments a hand-written import carried
 * do not survive them; the panels' single-field edits above still edit in place.
 */
export function mutate<T = void>(fn: (doc: ArchDoc) => ArchDoc | { doc: ArchDoc; result: T }): T | undefined {
  const doc = currentDoc();
  if (!doc) { pushErrorToast(translate("arch.editNeedsValidJson")); return undefined; }
  const out = fn(doc);
  const next = "result" in out && "doc" in out ? out.doc : (out as ArchDoc);
  const text = formatDoc(next);
  const store = useArchitectureStore.getState();
  if (store.draft && text !== store.draft.text) store.editText(text);
  return "result" in out && "doc" in out ? out.result : undefined;
}

export const currentDoc = (): ArchDoc | null => {
  const text = useArchitectureStore.getState().draft?.text;
  const r = text != null ? parseArchText(text) : null;
  return r?.ok ? r.doc : null;
};

export const setValue = (path: JsonPath, value: unknown) =>
  edit((text) => (value === undefined || value === "" ? removeIfPresent(text, path) : setAt(text, path, value)));

function removeIfPresent(text: string, path: JsonPath): string {
  try { return removeAt(text, path); } catch { return text; }
}

export const removeValue = (path: JsonPath) => edit((text) => removeIfPresent(text, path));

export function setComponentField(id: string, field: keyof ArchComponent, value: unknown) {
  return setValue(["components", id, field], value);
}

/** A figure typed by the person is theirs, not an estimate: setting one clears `estimated`. */
export function setSimField(id: string, field: string, value: number | boolean | undefined) {
  if (field === "estimated" || field === "managed") return setValue(["components", id, "sim", field], value);
  return batch([
    (text) => (value === undefined ? removeIfPresent(text, ["components", id, "sim", field]) : setAt(text, ["components", id, "sim", field], value)),
    (text) => removeIfPresent(text, ["components", id, "sim", "estimated"]),
  ]);
}

/** Paths in `layout` where the id sits, deepest last — removing them from the end keeps indexes valid. */
function layoutPaths(nodes: LayoutNode[] | undefined, id: string, base: JsonPath = ["layout"]): JsonPath[] {
  const out: JsonPath[] = [];
  (nodes ?? []).forEach((n, i) => {
    if (n === id) out.push([...base, i]);
    else if (isZone(n)) out.push(...layoutPaths(n.children, id, [...base, i, "children"]));
    else if (isGroup(n)) out.push(...layoutPaths(n.row ?? n.column, id, [...base, i, n.row ? "row" : "column"]));
  });
  return out;
}

/** A free id from a name: `bookings_api`, then `bookings_api_2`… */
export function freeId(doc: ArchDoc, name: string): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "component";
  let id = base, n = 2;
  while (doc.components?.[id]) id = `${base}_${n++}`;
  return id;
}

/** Adds a component and places it — in `zoneId` when given, else at the end of the drawing. */
export function addComponent(component: ArchComponent, zoneId: string | null): string | null {
  const doc = currentDoc();
  if (!doc) { pushErrorToast(translate("arch.editNeedsValidJson")); return null; }
  const id = freeId(doc, component.name ?? "component");
  const zonePath = zoneId ? findZonePath(doc.layout, zoneId) : null;
  edit((text) => {
    let next = setAt(text, ["components", id], component);
    next = appendAt(next, zonePath ? [...zonePath, "children"] : ["layout"], id);
    return next;
  });
  return id;
}

function findZonePath(nodes: LayoutNode[] | undefined, zoneId: string, base: JsonPath = ["layout"]): JsonPath | null {
  for (let i = 0; i < (nodes ?? []).length; i++) {
    const n = nodes![i];
    if (isZone(n)) {
      if (n.id === zoneId) return [...base, i];
      const inner = findZonePath(n.children, zoneId, [...base, i, "children"]);
      if (inner) return inner;
    } else if (isGroup(n)) {
      const inner = findZonePath(n.row ?? n.column, zoneId, [...base, i, n.row ? "row" : "column"]);
      if (inner) return inner;
    }
  }
  return null;
}

export const zonePathOf = (doc: ArchDoc, zoneId: string) => findZonePath(doc.layout, zoneId);

/** Removes a component everywhere it is named: its entry, its places in the layout, its connections. */
export function removeComponent(id: string) {
  const doc = currentDoc();
  if (!doc) return false;
  return edit((text) => {
    let next = text;
    const conns = (doc.connections ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e.from === id || e.to === id).map(({ i }) => i);
    for (const i of conns.sort((a, b) => b - a)) next = removeAt(next, ["connections", i]);
    for (const p of layoutPaths(doc.layout, id).reverse()) next = removeAt(next, p);
    return removeAt(next, ["components", id]);
  });
}

export function addConnection(connection: Connection) {
  return edit((text) => appendAt(text, ["connections"], connection));
}

export function removeConnection(index: number) {
  return edit((text) => removeAt(text, ["connections", index]));
}

export function appendTo(path: JsonPath, value: unknown) {
  return edit((text) => appendAt(text, path, value));
}

/** Applies several text edits as one change in the editor (one undo step for the user). */
export function batch(fns: Array<(text: string) => string>) {
  return edit((text) => fns.reduce((acc, fn) => fn(acc), text));
}
