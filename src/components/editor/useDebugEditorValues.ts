import { useEffect, useRef, type MutableRefObject } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IDisposable, Position } from "monaco-editor";
import { debugEvaluate, debugProperties, type DebugVariable } from "../../lib/tauri/commands";
import { normalizePath, useDebugStore } from "../../state/debugStore";
import { translate } from "../../state/languageStore";
import { valueKind } from "./debugValue";

/**
 * The debugger in the code, the way WebStorm puts it there (user request, 2026-11-18): while a
 * session is paused, in the file of the selected frame —
 *
 * - **hover** a name, or a member chain like `documento.numeroDocumento` / `this._repository`, and
 *   its value in that frame shows, with an object's first properties;
 * - **inline values**: each line from the top of the function down to the stopped one ends with
 *   `name = value` for the locals it mentions, in the faint italic of a comment.
 *
 * Both evaluate in `watch` context — no side effects, nothing printed — and read only what the
 * variables panel already could. A file other than the frame's gets neither: a name there means
 * something else, and showing this frame's value for it would be a confident lie.
 */
export function useDebugEditorValues(
  editorRef: MutableRefObject<MonacoEditorNS.IStandaloneCodeEditor | null>,
  monacoRef: MutableRefObject<Monaco | null>,
  /** The open file's absolute path, slash-normalized. */
  file: string | null,
  /** Bumped when the editor instance is (re)created. */
  editorReady: number,
) {
  const fileRef = useRef(file);
  fileRef.current = file;
  const inlineRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);

  // Hover: one provider per editor, asking the store at hover time.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const provider: IDisposable = monaco.languages.registerHoverProvider("*", {
      provideHover: async (model: MonacoEditorNS.ITextModel, position: Position) => {
        // Only the editor under the pointer: a file open in two groups shares one model, and both
        // providers answered — the value twice, every evaluation twice.
        if (model !== ed.getModel() || !ed.getDomNode()?.matches(":hover")) return null;
        const frame = pausedFrameIn(fileRef.current);
        if (!frame) return null;
        const found = expressionAt(model, position);
        if (!found) return null;
        try {
          // `hover`: refused rather than run when it would have side effects — a getter, a lazy
          // relation, a proxy — so moving the mouse can never query a database or change state.
          const result = await debugEvaluate(frame.id, found.expression, "hover");
          const lines = [`\`${found.expression}\` = ${inlineCode(await previewOf(result.value, result.object_id))}`];
          if (result.object_id) {
            const children = await childrenOf(result.object_id);
            const shown = children.filter((child) => !child.name.startsWith("[[")).slice(0, HOVER_CHILDREN);
            if (shown.length > 0) {
              lines.push(
                "```js\n" + shown.map((child) => `${child.name}: ${shorten(child.value, 120)}`).join("\n") +
                  (children.length > shown.length ? `\n… ${translate("debug.hoverMore", { n: String(children.length - shown.length) })}` : "") +
                  "\n```",
              );
            }
          }
          return {
            range: new monaco.Range(position.lineNumber, found.start, position.lineNumber, found.end),
            contents: [{ value: `**${translate("debug.hoverTitle")}**` }, { value: lines.join("\n\n") }],
          };
        } catch {
          // Not something the frame can evaluate (a type name, a keyword the regex let through).
          return null;
        }
      },
    });
    return () => provider.dispose();
  }, [editorRef, monacoRef, editorReady]);

  // Inline values: redrawn on every stop, frame change and file change.
  useEffect(() => {
    let generation = 0;
    const clear = () => inlineRef.current?.clear();

    const draw = async () => {
      const mine = ++generation;
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      const model = ed?.getModel();
      const frame = pausedFrameIn(fileRef.current);
      // A step under way keeps the last stop's values until the next stop redraws them, rather
      // than clearing and refilling on every F10.
      const debug = useDebugStore.getState();
      if (!frame && debug.stepping && debug.status === "running") return;
      if (!ed || !monaco || !model || !frame) {
        clear();
        return;
      }
      const locals = await localsOf(useDebugStore.getState().scopes);
      if (mine !== generation) return;
      if (locals.size === 0) {
        clear();
        return;
      }
      const stop = Math.min(frame.line, model.getLineCount());
      const first = Math.max(1, functionStart(model, stop), stop - INLINE_REACH);
      const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [];
      for (let line = first; line <= stop; line++) {
        const text = model.getLineContent(line);
        const names = namesIn(text).filter((name) => locals.has(name));
        if (names.length === 0) continue;
        const content = names.map((name) => `${name} = ${shorten(locals.get(name) ?? "", INLINE_VALUE_CHARS)}`).join(", ");
        const column = model.getLineMaxColumn(line);
        decorations.push({
          range: new monaco.Range(line, column, line, column),
          options: {
            after: { content: `  ${content}`, inlineClassName: "cf-debug-inline-value" },
            showIfCollapsed: true,
          },
        });
      }
      if (!inlineRef.current) inlineRef.current = ed.createDecorationsCollection();
      inlineRef.current.set(decorations);
    };

    void draw();
    const unsubscribe = useDebugStore.subscribe((state, previous) => {
      if (
        state.status !== previous.status ||
        state.selectedFrame !== previous.selectedFrame ||
        state.frames !== previous.frames ||
        state.scopes !== previous.scopes
      ) {
        void draw();
      }
    });
    return () => {
      generation++;
      unsubscribe();
      clear();
    };
  }, [editorRef, monacoRef, file, editorReady]);
}

/** How many of an object's properties a hover lists before saying how many more. */
const HOVER_CHILDREN = 25;
/** How far above the stopped line inline values reach, at most. */
const INLINE_REACH = 80;
/** How long one inline value may run before it is cut. */
const INLINE_VALUE_CHARS = 90;

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "return", "const", "let", "var", "function", "class", "new", "await", "async",
  "import", "export", "from", "type", "interface", "extends", "implements", "public", "private", "protected",
  "readonly", "static", "throw", "try", "catch", "finally", "switch", "case", "default", "break", "continue",
  "typeof", "instanceof", "in", "of", "void", "delete", "yield", "true", "false", "null", "undefined", "as",
  "def", "self", "None", "True", "False", "lambda", "pass", "elif", "with", "not", "and", "or", "is",
]);

/** The selected frame of a paused session, when it is in `file`. */
function pausedFrameIn(file: string | null) {
  const state = useDebugStore.getState();
  if (state.status !== "paused" || !file) return null;
  const frame = state.frames[state.selectedFrame];
  if (!frame || normalizePath(frame.file) !== file) return null;
  return frame;
}

/** The expression under the pointer: the word, with the member chain before it (`a.b.c`, `this.x`). */
function expressionAt(model: MonacoEditorNS.ITextModel, position: Position): { expression: string; start: number; end: number } | null {
  const word = model.getWordAtPosition(position);
  if (!word || KEYWORDS.has(word.word) || /^\d/.test(word.word)) return null;
  const line = model.getLineContent(position.lineNumber);
  // Walk left over `.name` / `?.name` links: `documento.numeroDocumento` hovered on its second word
  // is the whole chain; hovered on its first, just `documento`.
  let start = word.startColumn - 1;
  while (start > 0) {
    const before = line.slice(0, start);
    const link = before.match(/([A-Za-z_$][\w$]*)(\?)?\.$/);
    if (!link) break;
    start -= link[0].length;
  }
  const expression = line.slice(start, word.endColumn - 1);
  // A chain that goes on to the left past what this walk understands — `a[0].b`, `f().b`,
  // `"x".length` — would otherwise be evaluated as its last name alone, and show an unrelated
  // local's value as the property's.
  const before = line.slice(0, start).trimEnd();
  if (!expression || /[.'"`\])]$/.test(before) || before.endsWith("?.")) return null;
  return { expression, start: start + 1, end: word.endColumn };
}

/** Identifiers on a line that stand alone — not a property after a dot, not inside a string. */
export function namesIn(text: string): string[] {
  const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => " ".repeat(m.length)).replace(/\/\/.*$/, "");
  const seen = new Set<string>();
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const at = match.index ?? 0;
    if (code[at - 1] === "." || KEYWORDS.has(match[0])) continue;
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * Where the function holding `line` starts, read off the indentation: up from the stopped line while
 * lines sit at least as deep as it, then the signature above — with a multi-line parameter list
 * (`findByDocumento(` / `documento: Documento,` / `): Promise<…> {`) taken whole.
 */
function functionStart(model: MonacoEditorNS.ITextModel, line: number): number {
  const floor = Math.max(1, line - INLINE_REACH);
  const indentOf = (at: number) => model.getLineContent(at).match(/^\s*/)?.[0].length ?? 0;
  const blank = (at: number) => model.getLineContent(at).trim() === "";
  const body = indentOf(line);
  let at = line;
  while (at - 1 >= floor && (blank(at - 1) || indentOf(at - 1) >= body)) at--;
  const boundary = at - 1;
  if (boundary < floor) return at;
  const edge = indentOf(boundary);
  let start = boundary;
  while (start - 1 >= floor && !blank(start - 1) && indentOf(start - 1) > edge) start--;
  if (start !== boundary && start - 1 >= floor && indentOf(start - 1) === edge) start--;
  return start;
}

/**
 * The frame's locals by name: the children of every scope but the global one, nearest first. Read
 * from what the variables panel already loaded where it can, asked for otherwise — once per scope
 * object per stop.
 */
const LOCALS_CACHE = new Map<string, Promise<DebugVariable[]>>();
// Object ids are only good for the stop they came from — a DAP adapter renumbers them on every stop
// and reuses the numbers — so the cache is emptied whenever the session moves: a new stop, a resume,
// an end. Before, it lived until it grew, and a later stop could show an earlier one's fields.
useDebugStore.subscribe((state, previous) => {
  if (state.frames !== previous.frames || state.status !== previous.status) LOCALS_CACHE.clear();
});
async function localsOf(scopes: DebugVariable[]): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  let previews = 0;
  const expanded = useDebugStore.getState().expanded;
  for (const scope of scopes) {
    if (!scope.object_id || /^global/i.test(scope.name)) continue;
    const children = expanded[scope.object_id] ?? (await childrenOf(scope.object_id));
    for (const child of children) {
      if (values.has(child.name) || child.name.startsWith("__") || child.name === "this") continue;
      const kind = valueKind(child.value);
      if (kind === "function" || kind === "accessor") continue;
      // An object as its first fields rather than the word "Object" — which is all the backend's
      // preview says, and all the inline values said (user report, 2026-11-18).
      const shown = previews < MAX_PREVIEWS ? await previewOf(child.value, child.object_id) : child.value;
      if (shown !== child.value) previews++;
      values.set(child.name, shown);
    }
  }
  return values;
}

/** How many objects one redraw previews — each is a round trip to the debugger. */
const MAX_PREVIEWS = 16;
/** How many fields an object's preview lists before `…`. */
const PREVIEW_FIELDS = 5;

/** The children of an object, once per object per stop — and one request however many ask at once
 *  (the inline values, the variables rows and the hover all want the same objects on a stop). */
function childrenOf(objectId: string): Promise<DebugVariable[]> {
  const known = useDebugStore.getState().expanded[objectId];
  if (known) return Promise.resolve(known);
  let pending = LOCALS_CACHE.get(objectId);
  if (!pending) {
    pending = debugProperties(objectId).catch(() => [] as DebugVariable[]);
    LOCALS_CACHE.set(objectId, pending);
  }
  return pending;
}

/**
 * An object's value as its first fields — `{tipoDocumento: "RUT", numeroDocumento: "1984…"}`, an
 * array as `[1, 2, 3, …]` — one level deep: a nested object stays its own one-word preview. Anything
 * that is not an expandable object comes back as it was.
 */
export async function previewOf(value: string, objectId: string | null): Promise<string> {
  if (!objectId || valueKind(value) !== "object") return value;
  const fields = (await childrenOf(objectId)).filter((child) => {
    if (child.name.startsWith("[[") || child.name === "__proto__" || child.name === "constructor") return false;
    const kind = valueKind(child.value);
    return kind !== "function" && kind !== "accessor";
  });
  if (fields.length === 0) return value === "Object" ? "{}" : value;
  // A long array comes back in slices (`[0 … 99]`): its own description says it best.
  if (fields.some((child) => child.value === "" && /^\[\d+ … \d+\]$/.test(child.name))) return value;
  const isArray = /^Array/.test(value) || fields.every((child) => /^\d+$/.test(child.name) || child.name === "length");
  const items = fields.filter((child) => !(isArray && child.name === "length")).slice(0, PREVIEW_FIELDS);
  const parts = items.map((child) => (isArray ? shorten(child.value, 24) : `${child.name}: ${shorten(child.value, 24)}`));
  const more = fields.length - (isArray ? fields.filter((child) => child.name === "length").length : 0) > items.length ? ", …" : "";
  return isArray ? `[${parts.join(", ")}${more}]` : `{${parts.join(", ")}${more}}`;
}

function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A value as Markdown inline code, whatever backticks it holds. */
function inlineCode(value: string): string {
  const text = shorten(value, 400);
  const fence = text.includes("`") ? "``" : "`";
  return `${fence} ${text} ${fence}`;
}
