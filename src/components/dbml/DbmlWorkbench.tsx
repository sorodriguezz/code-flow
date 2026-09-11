import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Expand,
  FileCode2,
  FileUp,
  GitCompare,
  History,
  LayoutGrid,
  Maximize2,
  Minimize,
  Search,
  Shrink,
  SlidersHorizontal,
  Spline,
  X,
  Sparkles,
  Table2,
  Wand2,
  Wrench,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "../../lib/monacoSetup";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { DbmlCanvas, DBML_CANVAS_ID, type DbmlCanvasHandle } from "./DbmlCanvas";
import { DbmlInspector } from "./DbmlInspector";
import { DbmlHistory } from "./DbmlHistory";
import { DbmlReference } from "./DbmlReference";
import { DbmlConvertPanel } from "./DbmlConvertPanel";
import { DbmlDiffPanel } from "./DbmlDiffPanel";
import { DbmlImportPanel } from "./DbmlImportPanel";
import { DbmlDataPanel } from "./DbmlDataPanel";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { ToolbarButton } from "../db/dbChrome";
import * as edits from "../../lib/dbml/edit";
import { formatDbml } from "../../lib/dbml/format";
import { hintFor } from "../../lib/dbml/errors";
import { mergeDbml } from "../../lib/dbml/merge";
import { pushRevision, type Revision, type RevisionCause } from "../../lib/dbml/history";
import {
  fieldMarkKey,
  readLayout,
  splitFieldMarkKey,
  writeLayout,
  type DbmlMarkKind,
  type DbmlMarks,
} from "../../lib/dbml/layout";
import { EMPTY_SCHEMA, type DbmlSchema } from "../../lib/dbml/types";
import { sandboxOf, useSandboxStore } from "../../state/sandboxStore";
import type { SqlImportDialect } from "../../lib/dbml/parse";
import { rasterize, standaloneSvg } from "../../lib/diagramSvg";
// The one ceiling on a stored picture, imported rather than restated: it is a property of what the
// gallery keeps, not of the editor that produced it, and two numbers would mean a schema's
// thumbnail and a drawing's were allowed to be different sizes for no reason anyone chose.
import { THUMBNAIL_MAX_CHARS } from "../../lib/diagrams/embed";
import { safeFileName, saveBytes } from "../../lib/diagrams/exportFile";
import type { DiagramColumnMode, DiagramDensity } from "../../lib/db/erLayout";
import { ROUTING_NODE_LIMIT, type EdgeRouting } from "../../lib/dbml/route";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useThemeStore } from "../../state/themeStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { isMac as platformIsMac } from "../../lib/platform";
import { getWindowStatus, subscribeWindowStatus } from "../../lib/windowControls";
import { isTypingTarget } from "../../lib/keys";

/**
 * The editor for a diagram whose format is `dbml`.
 *
 * The counterpart of `DrawioFrame`: same contract — it is handed a diagram id, reads the document
 * out of `diagramsStore.draft` and writes every edit back through `editDoc` — and the same reason
 * for existing at all, which is that the choice of editor is a property of the *format*, not of the
 * workspace. See `types/diagrams.ts`, where that column is described.
 *
 * What it is not is an iframe. Everything here is this app's own code, so unlike draw.io it can be
 * given the app's toolbar, the app's theme and the app's AI panel without anything being injected
 * into a foreign document.
 *
 * # The two halves of the document
 *
 * A stored `dbml` document is the DBML plus a trailing comment holding the boxes the user has
 * dragged (`lib/dbml/layout.ts`). They are split on the way in and rejoined on the way out, and
 * that split is what keeps dragging a box from disturbing the text editor: the editor's `value` is
 * the DBML alone, so a drag — which only ever changes the comment — leaves it byte for byte
 * identical, and Monaco never sees a new value to reset the cursor and the undo stack for.
 *
 * # The parser is loaded, not imported
 *
 * `@dbml/core` is ~15 MB. It arrives through an `import()` the first time this component mounts,
 * and until it lands the canvas shows its skeleton. Everything else in `lib/dbml` — the layout, the
 * formatter, the ten generators, the diff — is ordinary code with no such cost, which is why only
 * this one thing is deferred.
 */

/**
 * What the overlays fade to when the pointer is not on the canvas.
 *
 * Low enough that the drawing is what you see and the controls are not part of it; high enough that
 * you can still tell what and where they are, so arriving at one is aiming rather than hunting.
 * They are receded, never hidden — a control that disappears is a control you have to remember
 * exists.
 */
const DIMMED = 0.32;

/** `motion-reduce` drops the *transition*, not the fade: the fade is the information. */
const CHROME_FADE = "transition-opacity duration-200 motion-reduce:transition-none";

/** How long after the last keystroke the document is re-parsed. */
const PARSE_DEBOUNCE_MS = 260;
/** And how long after the last change the gallery's picture is redrawn. Longer: it rasterises. */
const THUMBNAIL_DEBOUNCE_MS = 1400;
/** How long a document has to sit still before the change to it is recorded as one. Between the
 *  parse and the thumbnail: long enough that a sentence is one revision, short enough that a
 *  revision is still there when you reach for it. */
const REVISION_DEBOUNCE_MS = 900;

/**
 * The two things you alternate between mid-thought.
 *
 * It used to be four, and the segmented control's own comment already argued why they belonged in
 * one group — "four views of the same document, not four commands". With two that argument gets
 * stronger rather than weaker: Diagrama and Datos are the only pair you switch between while
 * holding a question in your head. Generate code, Import SQL and Compare are whole, occasional
 * things you go and do, which is what a drawer is for — see `Tool`.
 */
type Surface = "diagram" | "data";

/**
 * The three tools, as a drawer over the canvas rather than as surfaces.
 *
 * Three reasons, in the order they matter. **A surface unmounts the canvas and loses your place**:
 * `DbmlCanvas` holds pan and zoom in local state, so going to Compare and back used to throw away
 * your framing; with a drawer, Escape and you are where you were. **The precedent is already here**
 * — `DbmlHistory` and `DbmlReference` are whole, occasional things that are already toggled panels.
 * And **Import gains something from the move**: it is the only one that writes back, so as a drawer
 * it closes itself on apply and leaves you on the diagram it just changed.
 */
type Tool = "convert" | "import" | "diff";

/**
 * The three, in order, each with the glyph it is marked by.
 *
 * One list rather than three literals: the drawer's tabs, the toolbar menu and the button's label
 * all have to name the same three things in the same order, and they used to do it from three
 * separate `["convert", "import", "diff"]` arrays.
 */
const TOOLS: { id: Tool; Icon: typeof FileCode2 }[] = [
  { id: "convert", Icon: FileCode2 },
  { id: "import", Icon: FileUp },
  { id: "diff", Icon: GitCompare },
];

/**
 * One position of the view control — Diagrama, Datos, or the tool.
 *
 * The selected one is filled in the accent and the others are muted, and that is the whole contract
 * the control has to keep: exactly one of the three is what you are looking at.
 */
function viewPill(selected: boolean): string {
  return (
    "flex items-center gap-1 rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors " +
    (selected
      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
      : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]")
  );
}

interface Parser {
  parseDbml: (doc: string) => DbmlSchema;
  sqlToDbmlWithCore: (sql: string, dialect: SqlImportDialect) => string;
}

export function DbmlWorkbench({
  diagramId,
  onSaveAsTemplate,
  onAskAi,
  onOlderVersions,
}: {
  diagramId: string;
  onSaveAsTemplate: () => void;
  onAskAi: () => void;
  /** Opens the saved-version history. Owned by `DiagramsView` — it is the same modal the draw.io
   *  editor and the gallery use, and it belongs to the diagram rather than to this editor. */
  onOlderVersions: () => void;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const doc = useDiagramsStore((s) => s.draft?.doc ?? null);
  const draftId = useDiagramsStore((s) => s.draft?.id ?? null);
  const title = useDiagramsStore((s) => s.diagrams.find((d) => d.id === diagramId)?.title ?? "");
  const editDoc = useDiagramsStore((s) => s.editDoc);
  /** Read only so full screen can get out of the AI panel's way — see the effect below. */
  const aiOpen = useDiagramsStore((s) => s.aiOpen);

  const editorWidth = useLayoutStore((s) => s.sizes.dbmlEditorWidth);
  const inspectorWidth = useLayoutStore((s) => s.sizes.dbmlInspectorWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [surface, setSurface] = useState<Surface>("diagram");
  /** Which tool drawer is open, or `null`. One at a time — they are alternatives, not panes. */
  const [tool, setTool] = useState<Tool | null>(null);
  const [toolsAt, setToolsAt] = useState<DOMRect | null>(null);
  /**
   * What the Datos pill says, read straight from the sandbox store.
   *
   * Subscribed here rather than lifted out of the panel because the panel is *unmounted* while you
   * are on the diagram, and "your data is stale" is exactly the thing you want to learn without
   * having to go and look.
   */
  const sandbox = useSandboxStore(sandboxOf(diagramId));
  const sandboxRows = useMemo(
    () =>
      Object.values(sandbox.status?.counts ?? {}).reduce((total, count) => total + count, 0),
    [sandbox.status],
  );
  const sandboxDrifted = sandbox.drift !== null && !sandbox.driftIgnored;

  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** Only so the canvas's chip can print it. Updated when the rounded percentage actually moves,
   *  or a pinch would re-render the workbench once per frame for a number that did not change. */
  const [zoom, setZoom] = useState(1);
  /** How many tables the query hit. `null` when there is no query. */
  const [hits, setHits] = useState<number | null>(null);
  /** The relationship the pointer is on in the inspector, lit on the canvas. See `focusRef`. */
  const [hoveredRef, setHoveredRef] = useState<string | null>(null);
  /** How many boxes the layout produced — see `onNodeCount` on the canvas. Read only by the
   *  routing row, which must decide from the same number `routeEdges` gates on. */
  const [nodeCount, setNodeCount] = useState(0);
  /**
   * The selection, held.
   *
   * A pin makes the inspector stop following the canvas: clicks on a box or on the background no
   * longer change what is being read. Deliberate navigation — a relation in the inspector — still
   * moves it, and the pin comes along, because that is walking the schema rather than losing your
   * place in it.
   */
  const [pinned, setPinned] = useState(false);
  const [mode, setMode] = useState<DiagramColumnMode>("all");
  /** Curved or right-angled relationship lines. Session state, like `mode` and `density`. */
  const [routing, setRouting] = useState<EdgeRouting>("curved");
  /** The two side panes. Both on by default and both closable from the canvas's own edges, because
   *  three columns is a lot of window and which one you want depends on whether you are writing the
   *  schema or reading it. */
  const [inspector, setInspector] = useState(true);
  const [editorOpen, setEditorOpen] = useState(true);
  const [reference, setReference] = useState(false);
  const [history, setHistory] = useState(false);
  /**
   * Full screen: the diagram and nothing else.
   *
   * The **snapshot is the flag**. Holding what the panes were doing when zen started, rather than a
   * separate boolean beside it, is what makes "put them back exactly as they were" impossible to
   * get out of step with "are we in zen" — there is only one piece of state and it carries both
   * answers.
   */
  const [zenFrom, setZenFrom] = useState<{ editor: boolean; inspector: boolean } | null>(null);
  const zen = zenFrom !== null;
  /** Which panes the user opened or closed *by hand* since entering full screen. A ref and not
   *  state: nothing draws it, and it is only ever read at the moment zen ends. */
  const zenTouched = useRef({ editor: false, inspector: false });
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [density, setDensity] = useState<DiagramDensity>("roomy");
  const [exportAt, setExportAt] = useState<{ x: number; y: number } | null>(null);
  /**
   * The "View" button's rect while its menu is open, or `null`.
   *
   * A rect and not a point, unlike the export menu in the toolbar: this button sits in the *bottom*
   * right corner of the canvas, and a menu placed at the click and then merely clamped to the window
   * ends up lying over the button it came from and the status bar under it. `ContextMenu` opens
   * upwards from a trigger when it is given one — see its `anchor` prop.
   */
  const [viewAt, setViewAt] = useState<DOMRect | null>(null);
  /**
   * The pointer is over the canvas, so the tools are wanted.
   *
   * The controls on the drawing are for working on it, and while you are *reading* one they are
   * five bright objects sitting on top of the thing you are trying to read. Off the canvas they
   * fall back to a low opacity — still there, still legible enough to find, no longer competing —
   * and come back the moment the pointer arrives.
   *
   * The search box is exempt whenever it holds text or the focus: it is not a tool at that point
   * but a filter that is still applied, and fading a live filter hides the reason half the schema
   * is dimmed. Same for the menus, which are held open by a click that has already left the canvas.
   */
  const [chromeHot, setChromeHot] = useState(false);
  const [searchHot, setSearchHot] = useState(false);

  const canvas = useRef<DbmlCanvasHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** The document as of the last recorded revision, and what caused the change now in flight. Refs
   *  because neither is drawn: they are the two things the capture effect below needs to remember
   *  between renders it does not trigger. */
  const recorded = useRef<string | null>(null);
  const cause = useRef<RevisionCause>("edited");
  const nextRevision = useRef(1);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  /** The Monaco namespace, kept from the mount. Markers are set on the *model*, not on the editor,
   *  so they need the module rather than the instance. */
  const monacoRef = useRef<Monaco | null>(null);
  /** A declaration to jump to as soon as the text pane has an editor again. See `revealTable`. */
  const pendingReveal = useRef<string | null>(null);

  /** The document, split. Recomputed on every keystroke, which is a string scan and nothing more. */
  const { source, positions, marks: stored } = useMemo(() => readLayout(doc ?? ""), [doc]);

  /**
   * The marks, from both of the places one is written.
   *
   * The `// codeflow:marks` sidecar wins, because it is the half that survives a rename and can be
   * written while the text does not parse. On top of it come the marks the *document* states in its
   * own comments — see `marksFromComments`, whose header carries the argument.
   *
   * Without the second half a `// REVISAR` the sidecar has forgotten is a mark nothing in the app
   * will admit to: it is not drawn, so no menu offers to clear it, so `setMarkComment` is never
   * asked to take it out — and the comment stays in the document with no way to remove it short of
   * deleting the line by hand. Reading them back makes what the file says and what the canvas shows
   * the same fact, which is the only way "clear this mark" can be relied on to clear both.
   */
  const marks = useMemo(
    () => ({ ...edits.marksFromComments(source), ...stored }),
    [source, stored],
  );

  // ---- the parser, and what it produced -----------------------------------

  const [parser, setParser] = useState<Parser | null>(null);
  const [schema, setSchema] = useState<DbmlSchema>(EMPTY_SCHEMA);
  /** The latest parse, for effects that want it without wanting to re-run on every keystroke. */
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  /**
   * Read the sandbox's status once when the workbench opens, without waiting for Datos to be
   * visited.
   *
   * The counts on the canvas and the state on the Datos pill both exist so you learn about your
   * data *without* going to look at it — which they could not do if they only appeared after you
   * had. Keyed on the diagram and not on `schema`, through the ref above: this is the "is there
   * one, and how big" read. Whether the model has moved under it is re-derived by the panel, on
   * every parse, while you are actually there.
   */
  useEffect(() => {
    void useSandboxStore.getState().refresh(diagramId, schemaRef.current);
  }, [diagramId]);
  useEffect(() => {
    let cancelled = false;
    void import("../../lib/dbml/parse")
      .then((module) => {
        if (!cancelled) setParser(module);
      })
      .catch((error: unknown) => {
        if (!cancelled) pushErrorToast(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The parse, debounced.
   *
   * **The last good schema stays on screen while a new one is being typed**, which is the whole
   * reason the parse is not inline in a `useMemo`. A document is invalid for most of the time
   * anybody is editing it, and a canvas that empties itself between two keystrokes is unusable —
   * so `schema` is only replaced when there is something to replace it with, and the error rides
   * along on the schema that produced it.
   */
  useEffect(() => {
    if (!parser) return;
    const timer = window.setTimeout(() => {
      const parsed = parser.parseDbml(source);
      setSchema((current) =>
        // A failed parse that recovered nothing keeps the previous tables and takes the new error.
        // `errorAt` travels with `error` — they are one fact, and a stale caret pointing at a line
        // that no longer holds the problem is worse than no caret.
        parsed.tables.length === 0 && parsed.enums.length === 0 && parsed.error
          ? { ...current, error: parsed.error, errorAt: parsed.errorAt }
          : parsed,
      );
    }, PARSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [parser, source]);

  // The selection cannot outlive the table it names — renaming or deleting one would otherwise
  // leave the inspector open on nothing and the canvas dimmed around a table that is gone.
  useEffect(() => {
    if (!selected) return;
    const exists =
      schema.tables.some((table) => table.id === selected) ||
      schema.enums.some((entry) => entry.id === selected);
    if (!exists) {
      // The pin goes with it. A pin held on a table that no longer exists would lock the inspector
      // on the empty state with no way back except un-pinning something that is not there.
      setSelected(null);
      setPinned(false);
    }
  }, [schema, selected]);

  // ---- writing -------------------------------------------------------------

  /** What the *canvas* is allowed to do to the selection. The inspector calls `setSelected`. */
  const selectFromCanvas = useCallback(
    (id: string | null) => {
      if (pinned) return;
      setSelected(id);
    },
    [pinned],
  );

  /**
   * Holds the inspector on one table, or lets it go — from the canvas rather than from the panel.
   *
   * Three cases and one expression. Held on *this* table, it is released. Held on another, the hold
   * moves here rather than being refused, which is what "pin this one" means when something else is
   * already pinned. Not held at all, it takes hold. `setSelected` is called directly and not through
   * `selectFromCanvas`, which refuses while pinned — that guard exists to stop a *click* moving the
   * panel, and this is the one gesture whose whole purpose is to move it.
   *
   * Pinning opens the panel. A pin with nothing to hold is a state with no effect, and the pin is
   * reachable from the canvas precisely so it can be used without going to the panel first — so
   * arriving there by this route has to bring the panel with it. In full screen that counts as
   * opening it by hand, or leaving zen would slam shut a panel the user just asked for.
   */
  const togglePinFromCanvas = useCallback(
    (id: string) => {
      const release = pinned && selected === id;
      setPinned(!release);
      setSelected(id);
      if (release) return;
      if (zen) zenTouched.current.inspector = true;
      setInspector(true);
    },
    [pinned, selected, zen],
  );

  /**
   * The sidecar as it stands, in a ref.
   *
   * `writeSource` is called by Monaco's own `onChange`, which fires *during* the edit that changed
   * the text — before React has re-rendered with a new `marks` or `positions`. An operation that
   * has to change both halves at once (renaming a table also renames the key its mark and its
   * pinned position are filed under) can therefore not do it by setting state: the write would
   * carry the values from the render it started in, and the migration would be lost.
   *
   * So the two sidecar halves are mutated here first and read from here on the way out. It is the
   * same trick `cause` uses one screen down, and for the same reason: a value that has to be true
   * by the time a callback fires cannot live in state.
   */
  const sidecar = useRef({ positions, marks });
  sidecar.current = { positions, marks };

  /** One edit to the DBML itself, with the dragged boxes and the marks carried through. */
  const writeSource = useCallback(
    (next: string) => editDoc(writeLayout(next, sidecar.current.positions, sidecar.current.marks)),
    [editDoc],
  );

  /**
   * Renames a key in both halves of the sidecar, or drops it from both.
   *
   * A table's mark and its dragged position are filed under its **id** — the qualified name — so
   * renaming the table without this silently loses both (the box jumps back to wherever the layout
   * engine puts it and the mark stops being drawn) and leaves a key behind that will never match
   * anything again. Every caller therefore hands this an id and not a bare name: they used to hand
   * it names, which for `Table core.users` deleted a key that was never there.
   *
   * Called from inside `applyEdit`'s callback, never before it. `applyEdit` has two early exits —
   * a document that does not parse, and an edit that changed nothing — and running ahead of them
   * meant a *refused* rename still moved the mark and the pinned position. Inside the callback the
   * ordering still works, because `applyEdit` computes the new text before it hands it to Monaco,
   * so the ref is mutated before `writeSource` reads it from `onChange`.
   */
  const moveSidecarKey = (from: string, to: string | null) => {
    const { positions: at, marks: mark } = sidecar.current;
    const nextAt = { ...at };
    const nextMark = { ...mark };
    const place = nextAt[from];
    delete nextAt[from];
    if (to !== null && place) nextAt[to] = place;

    // The table's own mark, and every one of its columns' — a column's key is `<tableId>|<column>`,
    // so a renamed table leaves forty of them behind pointing at a table that no longer exists and
    // takes forty decisions with it. Rebuilt rather than mutated in place, because the keys being
    // moved and the keys being kept are interleaved in the same object.
    for (const [key, value] of Object.entries(mark)) {
      const field = splitFieldMarkKey(key);
      const owner = field ? field.table : key;
      if (owner !== from) continue;
      delete nextMark[key];
      if (to === null) continue;
      nextMark[field ? fieldMarkKey(to, field.column) : to] = value;
    }
    sidecar.current = { positions: nextAt, marks: nextMark };
  };

  /**
   * The same, one column down: a renamed column keeps its mark and a deleted one takes it with it.
   *
   * Separate from `moveSidecarKey` because the two are keyed by different things — that one takes
   * table ids and this takes a table id plus a column name — and because only a table has a dragged
   * position to carry. Called from inside `applyEdit`'s callback for the same reason: a refused
   * edit must not move the sidecar.
   */
  const moveFieldKey = (table: string, from: string, to: string | null) => {
    const { positions: at, marks: mark } = sidecar.current;
    const key = fieldMarkKey(table, from);
    const flag = mark[key];
    if (!flag) return;
    const next = { ...mark };
    delete next[key];
    if (to !== null) next[fieldMarkKey(table, to)] = flag;
    sidecar.current = { positions: at, marks: next };
  };

  /**
   * One structural edit to the schema, from a click rather than from typing.
   *
   * # Through Monaco, not around it
   *
   * The edit is applied with `executeEdits` whenever the text pane is mounted, and only falls back
   * to `writeSource` when it is folded away. That is not a detail: `executeEdits` puts the change on
   * Monaco's undo stack, so ⌘Z takes back "add a column" exactly as it takes back a keystroke, and
   * the two kinds of edit share one history instead of the visual ones being unreachable from the
   * keyboard. Assigning through the `value` prop instead would reset that stack.
   *
   * The write still lands in the store the same way, because Monaco's own `onChange` calls
   * `writeSource` — so there is one path out of here regardless of which branch ran.
   *
   * # Refused while the document does not parse
   *
   * `edit.ts` works on text and would happily do the edit. The problem is upstream of it: with a
   * syntax error the parsed schema is empty or stale, so the *table this edit names* comes from a
   * model that no longer describes the document — and "add a column to `orders`" can land in a table
   * the author has since renamed. Buttons are disabled on the same condition, so this is the
   * backstop rather than the message.
   */
  const applyEdit = useCallback(
    (edit: (current: string) => string) => {
      if (schema.error) return;
      const next = edit(source);
      if (next === source) return;
      cause.current = "edited";

      const editor = editorRef.current;
      const model = editor?.getModel();
      if (editor && model) {
        editor.executeEdits("cf-dbml-visual", [{ range: model.getFullModelRange(), text: next }]);
        editor.pushUndoStop();
        return;
      }
      writeSource(next);
    },
    [schema.error, source, writeSource],
  );

  /**
   * Sets or clears one review mark, in both of the places a mark is written.
   *
   * The `// codeflow:marks` sidecar wins where the two halves disagree — it is what survives a
   * rename and what can be written while the document does not parse. On top of it the mark is
   * written into the DBML as a comment, so the decision is legible in a diff, in
   * a review and in any editor that opens the file: above the declaration for a table, at the end
   * of the line for a column. A *relationship* gets no comment — it has no one line of its own to
   * sit on — which is why the comment is passed in as a function rather than decided here: `setMark`
   * and `setFieldMark` below are the two that know which document edit, if any, their key wants.
   *
   * # Still not gated on `schema.error`
   *
   * Unlike everything in `editing` below, this stays available while the document is broken — see
   * the note on `setMark` in `DbmlCanvas`. What changes when it is broken is only how much gets
   * written: with nothing to find in the text, the `comment` callback returns it unchanged and the
   * sidecar is written alone. The mark is never lost, it just has no comment until the text parses
   * again.
   *
   * # Through Monaco when there is a comment to write
   *
   * A mark used to change no character the editor was showing, so it went straight to `editDoc`
   * with nothing for Monaco to undo. Now it usually does change one, and that change belongs on the
   * same undo stack as every other visual edit — hence `executeEdits`, and the sidecar mutation
   * before it, because the write comes back out through Monaco's `onChange` → `writeSource`, which
   * reads the marks from `sidecar.current`.
   *
   * # The store is written first, and unconditionally
   *
   * `executeEdits` used to be an early `return`: the document reached the store only by coming back
   * round through Monaco's change event. That made one editor's behaviour load-bearing for whether
   * a mark was saved at all — and every way that event can fail to arrive (a model disposed between
   * the render and the click, an edit the editor declines, a value it considers unchanged) is a
   * *silent* one, where the sidecar, the comment and the canvas all stay as they were and the
   * button simply did nothing.
   *
   * So the store write happens here, first, and Monaco is told afterwards purely so ⌘Z can take the
   * change back. Writing twice costs nothing: `editDoc` returns early on a document identical to the
   * one it holds, which is what `writeSource` then hands it.
   */
  const writeMark = useCallback(
    (key: string, mark: DbmlMarkKind | null, comment: (current: string) => string) => {
      const next: DbmlMarks = { ...sidecar.current.marks };
      if (mark) next[key] = mark;
      else delete next[key];
      cause.current = "marked";
      sidecar.current = { positions: sidecar.current.positions, marks: next };

      const nextSource = comment(source);
      editDoc(writeLayout(nextSource, sidecar.current.positions, next));
      if (nextSource === source) return;

      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return;
      editor.executeEdits("cf-dbml-mark", [
        { range: model.getFullModelRange(), text: nextSource },
      ]);
      editor.pushUndoStop();
    },
    [editDoc, source],
  );

  /**
   * A table's or a relationship's mark. See `writeMark` for everything the two setters share.
   *
   * A relationship is told apart from a table by the shape of its id and **not** by asking the
   * parsed schema. The hazard being avoided is the same one either way — `refId` is `a.b->c.d`,
   * whose bare tail (`d`) `findBlock` would happily match against a table called `d` and put
   * somebody's mark on the wrong declaration — and `->` is what says which kind of id this is
   * without leaving the answer to a parse.
   *
   * That mattered: `schema` is *debounced* and keeps its last good tables through a failed parse, so
   * a table the current parse did not recover is a table this used to decline to write a comment
   * for. On a set that is a mark with no comment, which is merely incomplete; on a **clear** it is
   * the comment left behind in the document with the mark gone from everywhere else — the exact
   * mismatch `marksFromComments` now exists to be able to recover from. Clearing is a text edit and
   * `blocksOf` reads text, half-typed or not, so there is nothing here for a parse to decide.
   */
  const setMark = useCallback(
    (id: string, mark: DbmlMarkKind | null) =>
      writeMark(id, mark, (current) =>
        id.includes("->") ? current : edits.setMarkComment(current, id, mark),
      ),
    [writeMark],
  );

  /**
   * One column's mark.
   *
   * No guard of `setMark`'s kind is needed here and none would help: the table and the column
   * arrive as two arguments rather than as one id, so there is nothing to disambiguate, and
   * `setFieldMarkComment` returns the document untouched when either half names nothing — which is
   * exactly what should happen while the text is mid-edit.
   */
  const setFieldMark = useCallback(
    (table: string, column: string, mark: DbmlMarkKind | null) =>
      writeMark(fieldMarkKey(table, column), mark, (current) =>
        edits.setFieldMarkComment(current, table, column, mark),
      ),
    [writeMark],
  );

  /**
   * Every mark in the document, gone — the sidecar's and the comments' alike.
   *
   * The way out that does not depend on finding anything. Each of the setters above has to locate
   * what it is clearing: a table by its id, a column inside it, a marker on the line it is expected
   * to be on. A document where one of those lookups comes up empty is a document where a mark can
   * be taken off the canvas and its `// REVISAR` stays in the text, with nothing left in the app
   * that will admit the comment is there — and the user's only recourse is to delete the line by
   * hand. `stripMarkComments` looks at lines and nothing else, so there is no document it can fail
   * on, and this pairs it with emptying the sidecar in the same write.
   *
   * Offered only while something is marked, beside the counts that say so.
   */
  const clearAllMarks = useCallback(() => {
    cause.current = "marked";
    sidecar.current = { positions: sidecar.current.positions, marks: {} };

    const nextSource = edits.stripMarkComments(source);
    editDoc(writeLayout(nextSource, sidecar.current.positions, {}));
    if (nextSource === source) return;

    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.executeEdits("cf-dbml-mark", [
      { range: model.getFullModelRange(), text: nextSource },
    ]);
    editor.pushUndoStop();
  }, [editDoc, source]);

  /** How the review is going, for the strip along the bottom. */
  const marked = useMemo(() => {
    const counts = { remove: 0, review: 0, keep: 0 };
    for (const mark of Object.values(marks)) counts[mark] += 1;
    return counts;
  }, [marks]);

  /** Every table and enum name in the document — what a new one has to avoid colliding with. */
  const declared = useMemo(
    () => [...schema.tables.map((entry) => entry.name), ...schema.enums.map((entry) => entry.name)],
    [schema],
  );

  /**
   * The schema operations, bound to `applyEdit`.
   *
   * A single object handed to both the inspector and the canvas, so the two surfaces cannot end up
   * writing the document by different routes — every one of these is `applyEdit(edits.something)`,
   * and `applyEdit` is the only thing in this component that knows how a change reaches Monaco.
   */
  /**
   * A table's id from whatever a caller had to hand.
   *
   * The column operations below are given a table *name* — that is what the inspector and the
   * canvas menu have always passed, and what `findBlock` resolves — while the sidecar a column's
   * mark lives in is keyed by the table's **id**. One is not the other the moment a schema is
   * qualified: `users` is the name and `core.users` is the id. Accepts either, so a caller that
   * already has the id (the canvas, which reads it off the node) is not made to convert it back.
   */
  const tableIdOf = (name: string) =>
    schema.tables.find((entry) => entry.id === name || entry.name === name)?.id ?? name;

  const editing = useMemo(
    () => ({
      blocked: Boolean(schema.error),
      blockedReason: t("dbml.editBlocked"),
      addField: (table: string, field: edits.FieldEdit) =>
        applyEdit((current) => edits.addField(current, table, field)),
      updateField: (table: string, name: string, field: edits.FieldEdit) =>
        applyEdit((current) => {
          const next = edits.updateField(current, table, name, field);
          // A renamed column is a new key for its mark. `edit.ts` carries the comment across; this
          // is the sidecar half, and without it the decision is lost on a typo correction.
          if (next !== current && name !== field.name) {
            moveFieldKey(tableIdOf(table), name, field.name);
          }
          return next;
        }),
      dropField: (table: string, name: string) =>
        applyEdit((current) => {
          const next = edits.dropField(current, table, name);
          if (next !== current) moveFieldKey(tableIdOf(table), name, null);
          return next;
        }),
      addTable: (name: string) => applyEdit((current) => edits.addTable(current, name)),
      addEnum: (name: string) => applyEdit((current) => edits.addEnum(current, name)),
      // `from` and `name` are **ids**, not bare names — see `moveSidecarKey`. `edit.ts` finds the
      // block by either (`blocksOf` captures `core.users` whole and `findBlock` matches the full
      // name), so passing the id costs the text edit nothing and buys the sidecar correctness.
      renameTable: (from: string, to: string) => {
        // Refused loudly here rather than silently in `edit.ts`, which declines by returning the
        // document untouched. A control that does nothing when pressed reads as broken; the reason
        // is the whole message. See `nameIsTaken` for why an enum's name counts as taken.
        if (edits.nameIsTaken(source, to, from)) {
          pushErrorToast(t("dbml.nameTaken", { name: to }));
          return;
        }
        applyEdit((current) => {
          const next = edits.renameTable(current, from, to);
          if (next !== current) moveSidecarKey(from, to);
          return next;
        });
      },
      dropTable: (name: string) => {
        applyEdit((current) => {
          const next = edits.dropTable(current, name);
          if (next !== current) moveSidecarKey(name, null);
          return next;
        });
      },
      setNote: (table: string, note: string) =>
        applyEdit((current) => edits.setTableNote(current, table, note)),
      addRef: (from: edits.RefEnd, to: edits.RefEnd, cardinality: edits.Cardinality) =>
        applyEdit((current) => edits.addRef(current, from, to, cardinality)),
      dropRef: (from: edits.RefEnd, to: edits.RefEnd) =>
        applyEdit((current) => edits.dropRef(current, from, to)),
      setRefCardinality: (
        from: edits.RefEnd,
        to: edits.RefEnd,
        cardinality: edits.Cardinality,
      ) => applyEdit((current) => edits.setRefCardinality(current, from, to, cardinality)),
    }),
    // `source` for the name check in `renameTable`. It does not widen anything in practice —
    // `applyEdit` already closes over the same string, so this memo was rebuilding per keystroke
    // regardless. `schema.tables` for `tableIdOf`, for the same reason.
    [applyEdit, schema.error, schema.tables, source, t],
  );

  /** One box moved. Only the layout comment changes, so Monaco's value does not — see the header. */
  const moveTable = useCallback(
    (id: string, x: number, y: number) => {
      cause.current = "moved";
      editDoc(writeLayout(source, { ...positions, [id]: { x, y } }, marks));
    },
    [editDoc, source, positions, marks],
  );

  /**
   * Into and out of full screen.
   *
   * Zen is **only** a view state: it moves no character of the document, never touches `sidecar`,
   * and writes nothing. Leaving it puts the two panes back exactly as they were rather than to
   * their defaults, which is the whole reason the snapshot is the flag.
   */
  const enterZen = () => {
    setZenFrom({ editor: editorOpen, inspector });
    zenTouched.current = { editor: false, inspector: false };
    setEditorOpen(false);
    setInspector(false);
    // Anything floating over the canvas goes with them, or it is left hanging over a black screen
    // with the control that opened it no longer on screen.
    setReference(false);
    setHistory(false);
    setViewAt(null);
    setExportAt(null);
    setTool(null);
    setToolsAt(null);
  };

  const leaveZen = useCallback(() => {
    setZenFrom((from) => {
      if (!from) return null;
      // Per pane, and that is the whole subtlety. The snapshot exists so leaving full screen does
      // not cost the layout you had before entering it — but the panes can now be opened *inside*
      // zen, and a pane the user deliberately opened there being slammed shut on the way out is the
      // snapshot overruling a newer decision. So it only answers for the panes nobody touched.
      if (!zenTouched.current.editor) setEditorOpen(from.editor);
      if (!zenTouched.current.inspector) setInspector(from.inspector);
      zenTouched.current = { editor: false, inspector: false };
      return null;
    });
  }, []);

  /** Toggles a pane, and remembers that it was done by hand while in zen — see `leaveZen`. */
  const toggleEditorPane = () => {
    if (zen) zenTouched.current.editor = true;
    setEditorOpen((open) => !open);
  };
  const toggleInspectorPane = () => {
    if (zen) zenTouched.current.inspector = true;
    setInspector((open) => !open);
  };

  const tidy = () => {
    const formatted = formatDbml(source);
    if (formatted === source) return;
    cause.current = "formatted";
    writeSource(formatted);
    useToastStore.getState().pushToast(t("dbml.formatted"), "success");
  };

  /**
   * Throws the hand-arrangement away, which puts every box back under the layout engine.
   *
   * **Says so when there was nothing to throw away.** With no dragged boxes this can only re-fit
   * the viewport, because the engine had already placed everything — and a button that moves
   * nothing and reports nothing reads as broken to exactly the person most likely to press it: the
   * one looking at a freshly generated, imported or AI-written schema, where nothing has been
   * dragged yet.
   */
  const rearrange = () => {
    if (Object.keys(positions).length === 0) {
      canvas.current?.fit();
      useToastStore.getState().pushToast(t("dbml.layoutAlready"), "info");
      return;
    }
    cause.current = "rearranged";
    // The marks are about the model, not about where its boxes sit — a re-layout keeps them.
    editDoc(writeLayout(source, {}, marks));
    useToastStore.getState().pushToast(t("dbml.layoutReset"), "success");
  };

  /**
   * The parse error, drawn on the line it is about.
   *
   * A banner under the editor says *what* is wrong; this is what says *where*. Monaco owns the
   * squiggle, the gutter mark, the overview-ruler tick and the hover — setting a marker gets all
   * four for the price of one call, and they track the text as it is edited rather than pointing at
   * a line number that has since moved.
   *
   * The span is from the reported column to the end of that line. `@dbml/core` reports a start and
   * no end (its diagnostics are points, not ranges), and a zero-width marker draws nothing at all —
   * so "from here to the end of the line" is the smallest honest range that is also visible.
   *
   * Runs on `source` too, not only on the error: the model's content changes under the marker as
   * the user types, and a marker left on a line that has since been fixed is a lie that survives
   * until the next failure.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const OWNER = "cf-dbml-parse";
    if (!schema.error || !schema.errorAt) {
      monaco.editor.setModelMarkers(model, OWNER, []);
      return;
    }
    const line = Math.min(Math.max(1, schema.errorAt.line), model.getLineCount());
    const column = Math.max(1, schema.errorAt.column);
    monaco.editor.setModelMarkers(model, OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: schema.error,
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: Math.max(column + 1, model.getLineMaxColumn(line)),
      },
    ]);
  }, [schema.error, schema.errorAt, source, editorOpen]);

  /**
   * Puts the caret on the error.
   *
   * Opens the text pane first when it is folded away: the banner is reachable from a canvas-only
   * layout, and "go to the error" that silently does nothing because the editor is not on screen is
   * the same dead control this feature exists to replace. The reveal is deferred a frame in that
   * case, because the editor does not exist until the pane has rendered.
   */
  const goToError = () => {
    const at = schema.errorAt;
    if (!at) return;
    const focus = (editor: MonacoEditorNS.IStandaloneCodeEditor) => {
      const model = editor.getModel();
      if (!model) return;
      const line = Math.min(Math.max(1, at.line), model.getLineCount());
      const column = Math.max(1, at.column);
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    };
    if (editorOpen && editorRef.current) {
      focus(editorRef.current);
      return;
    }
    setEditorOpen(true);
    // One frame for the pane, then the editor is there. `requestAnimationFrame` rather than a
    // timeout: this is waiting on a render, which is exactly what it measures.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (editorRef.current) focus(editorRef.current);
      });
    });
  };

  /** Puts the document back to how it was before one recorded change. */
  const revert = (doc: string) => {
    cause.current = "reverted";
    editDoc(doc);
    useToastStore.getState().pushToast(t("dbml.history.done"), "success");
  };

  /**
   * Puts the cursor on a declaration, in an editor we already have.
   *
   * Works on the **text**: `findMatches` is a regex over the model and nothing here reads `schema`.
   * That is what lets the menu row it backs stay live while the document does not parse — the worst
   * a stale name can do is fail to find a line.
   */
  const revealIn = useCallback(
    (editor: MonacoEditorNS.IStandaloneCodeEditor, id: string) => {
      const model = editor.getModel();
      if (!model) return;
      const bare = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
      const matches = model.findMatches(
        `(table|enum)\\s+"?(${escapeForSearch(id)}|${escapeForSearch(bare)})"?`,
        true,
        true,
        false,
        null,
        false,
        1,
      );
      const at = matches[0]?.range;
      if (!at) return;
      editor.revealLineInCenter(at.startLineNumber);
      editor.setPosition({ lineNumber: at.startLineNumber, column: at.startColumn });
      editor.focus();
    },
    [],
  );

  /**
   * Jumps to a table's — or an enum's — declaration. What double-clicking a box does, and what its
   * context menu offers.
   *
   * **Opens the text pane if it is shut.** Folding it away unmounts `<Editor>`, which disposes the
   * editor and its model, so a jump made with the pane closed would find nothing and quietly do
   * nothing. Double-click has behaved that way since it shipped and nobody noticed, because you
   * cannot double-click a box and reasonably expect a pane you closed to react; a menu row that
   * says "go to its definition" and does nothing is a bug the moment it ships. The id is parked and
   * replayed from `onEditorMount` rather than after a timeout — the editor is created
   * asynchronously and there is no number of frames that is the right guess.
   */
  const revealTable = useCallback(
    (id: string) => {
      const editor = editorRef.current;
      if (editor?.getModel()) {
        revealIn(editor, id);
        return;
      }
      pendingReveal.current = id;
      // Asking for the code is asking to leave full screen, since the text pane is the thing full
      // screen hides. `setZenFrom` directly rather than `leaveZen`, so the snapshot can put the
      // inspector back without also restoring an editor the user has just asked to see.
      setZenFrom((from) => {
        if (from) setInspector(from.inspector);
        return null;
      });
      setEditorOpen(true);
    },
    [revealIn],
  );

  // ---- the change history --------------------------------------------------

  /**
   * A revision per settled change.
   *
   * Watching the *document* rather than instrumenting each write is what makes this complete: every
   * path that can change a schema ends up in `draft.doc`, including the ones added later and the
   * ones that go around this component entirely (the AI panel merges its answer straight into the
   * store). A list of call sites would be a list somebody has to remember to add to.
   *
   * Debounced, because a change to the document is a change per keystroke and per frame of a drag.
   * The delay is what turns "a hundred edits" into "you typed", and `pushRevision` folds what is
   * left. `recorded` deliberately does not move until the burst settles, so a revision's `before`
   * is the document as it stood before the whole burst rather than before its last character.
   */
  useEffect(() => {
    if (doc === null || draftId !== diagramId) return;
    // The first document for this diagram is the baseline, not a change.
    if (recorded.current === null) {
      recorded.current = doc;
      return;
    }
    if (recorded.current === doc) return;
    const timer = window.setTimeout(() => {
      const before = recorded.current ?? doc;
      recorded.current = doc;
      setRevisions((list) =>
        pushRevision(list, {
          id: nextRevision.current++,
          cause: cause.current,
          at: Date.now(),
          before,
          after: doc,
        }),
      );
      cause.current = "edited";
    }, REVISION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc, draftId, diagramId]);

  // A history belongs to one document. Carrying it across would offer to revert diagram B to a
  // state diagram A was in, which is a data-loss button wearing an undo icon.
  useEffect(() => {
    recorded.current = null;
    cause.current = "edited";
    setRevisions([]);
    setHistory(false);
  }, [diagramId]);

  // ---- the gallery's picture ----------------------------------------------

  /**
   * A PNG of the canvas, stored with the document.
   *
   * Debounced well past the parse: it serialises the SVG, resolves every theme variable in it and
   * rasterises the result, which is not work to do on a keystroke. Only ever taken from the
   * *diagram* surface — the other three do not have a canvas mounted, and a thumbnail taken while
   * the convert panel is open would be a picture of the previous schema.
   */
  useEffect(() => {
    if (surface !== "diagram" || draftId !== diagramId) return;
    const timer = window.setTimeout(() => {
      const element = canvas.current?.element();
      const layout = canvas.current?.layout();
      if (!element || !layout || layout.width === 0) return;
      void rasterize(standaloneSvg(element, layout, DBML_CANVAS_ID), layout, 1)
        .then((base64) => {
          const uri = `data:image/png;base64,${base64}`;
          useDiagramsStore
            .getState()
            .setThumbnail(diagramId, uri.length > THUMBNAIL_MAX_CHARS ? "" : uri);
        })
        .catch(() => {
          // A picture that could not be drawn is not worth a message: the card falls back to its
          // glyph, which is what a diagram with no thumbnail has always looked like.
        });
    }, THUMBNAIL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [schema, positions, surface, diagramId, draftId]);

  // ---- getting it out ------------------------------------------------------

  const exportAs = async (format: "png" | "svg" | "dbml") => {
    try {
      const name = safeFileName(title, "schema");
      if (format === "dbml") {
        // The document as written, layout comment and all: it is a valid DBML file either way, and
        // keeping the arrangement is what makes an exported schema re-openable as the same picture.
        await saveBytes(new TextEncoder().encode(doc ?? ""), "dbml", name);
        useToastStore.getState().pushToast(t("diagrams.exported"), "success");
        return;
      }
      const element = canvas.current?.element();
      const layout = canvas.current?.layout();
      if (!element || !layout || layout.width === 0) throw new Error(t("diagrams.exportEmpty"));
      const svg = standaloneSvg(element, layout, DBML_CANVAS_ID);
      const bytes =
        format === "svg"
          ? new TextEncoder().encode(svg)
          : bytesFromBase64(await rasterize(svg, layout));
      await saveBytes(bytes, format, name);
      useToastStore.getState().pushToast(t("diagrams.exported"), "success");
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  /**
   * Escape leaves full screen — but only when nothing nearer wants the press.
   *
   * Five things in this workbench already answer Escape and each of them must win it: the history
   * and reference panels close themselves, the tools drawer closes, the View and export menus
   * dismiss, and every text field on screen (the search box, the canvas's rename input, the
   * inspector's editors) treats it as "abandon what I am typing". Hence the guards on the
   * subscription rather than inside the handler: while any of those is open this listener is not
   * bound at all.
   */
  useEffect(() => {
    if (!zen || history || reference || viewAt !== null || exportAt !== null || tool !== null) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      leaveZen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen, history, reference, viewAt, exportAt, tool, leaveZen]);

  /**
   * Escape closes the tools drawer.
   *
   * Its own listener rather than a branch in the one above, because the two must never both answer
   * a press: the full-screen listener is guarded off while `tool` is set, so exactly one of them is
   * bound at any moment. The same typing guard applies — the import panel is a textarea, and
   * Escape in it means "abandon what I am typing", not "close the panel I am typing into".
   */
  useEffect(() => {
    if (tool === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      setTool(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  /**
   * Re-fit on the way into and out of full screen.
   *
   * The canvas fits once on its first layout and never measures again, so a frame that suddenly
   * became the whole window would still be drawn at the old scale and translate — the schema
   * parked in a corner of an empty screen. One frame of delay is required rather than optimistic:
   * `fit()` reads the frame's `clientWidth`, which is only correct after the browser has laid the
   * new box out.
   *
   * Deliberately *not* on every pane toggle. Hiding the inspector should not throw away the zoom a
   * user set on one table; entering full screen is a request to see the whole thing.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => canvas.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [zen]);

  /**
   * The AI panel wins over full screen.
   *
   * `DiagramAiPanel` is `absolute z-30` inside the Diagrams pane, so the zen canvas — portalled over
   * the whole window — buries it. The sparkle in the shared header, the parked-generation button
   * and ⌘⇧A can all open it from outside this component, and "the panel opened behind the black
   * screen" is not a state anyone can diagnose.
   */
  useEffect(() => {
    if (aiOpen && zen) leaveZen();
  }, [aiOpen, zen, leaveZen]);

  /** Whether the OS window is in macOS fullscreen — AppKit takes the traffic lights away when it is. */
  const windowFullscreen = useSyncExternalStore(
    subscribeWindowStatus,
    () => platformIsMac() && getWindowStatus().fullscreen,
  );

  /**
   * Whether AppKit is painting the traffic lights over the workbench itself.
   *
   * They are real buttons above the webview, so nothing in the DOM can cover them and nothing the
   * pane draws in that corner can be clicked. Outside full screen the app's own title bar keeps the
   * row for them; in full screen it is buried, so the row has to be reserved here instead.
   */
  const lightsOverWorkbench = zen && platformIsMac() && !windowFullscreen;

  const exportItems: MenuItem[] = [
    { label: t("diagrams.exportAs.png"), onClick: () => void exportAs("png") },
    { label: t("diagrams.exportAs.svg"), onClick: () => void exportAs("svg") },
    { label: t("diagrams.exportAs.dbml"), onClick: () => void exportAs("dbml") },
  ];

  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // A disposed editor answers `getModel()` with `null` rather than throwing, and this ref is
    // otherwise never cleared — so without this, folding the text pane away leaves a live-looking
    // editor here forever and everything that checks it silently does nothing.
    editor.onDidDispose(() => {
      if (editorRef.current === editor) editorRef.current = null;
    });
    // Replay a jump that was asked for while the pane was shut. Cleared *before* the reveal, so a
    // jump that finds nothing does not stay armed for the next time the pane is opened by hand.
    const pending = pendingReveal.current;
    pendingReveal.current = null;
    if (pending) revealIn(editor, pending);
  };

  // The document has not arrived from the database yet, or belongs to another diagram.
  if (doc === null || draftId !== diagramId) return <ViewSkeleton />;

  const hint = schema.error ? hintFor(schema.error) : null;
  const lineCount = source === "" ? 0 : source.split("\n").length;
  /**
   * Whether the inspector is *on screen*, which is not the same as `inspector` being true.
   *
   * The panel is rendered inside the branch that draws boxes, so it is absent on the Datos surface,
   * before the parser chunk has landed, and on a schema with nothing in it — in all three of which
   * the flag can still be set from a previous document. Anything that gets out of the panel's way
   * has to read this rather than the flag, or it steps aside for a panel that is not there.
   */
  const inspectorShowing =
    inspector &&
    surface === "diagram" &&
    parser !== null &&
    (schema.tables.length > 0 || schema.enums.length > 0);

  const workbench = (
    <div
      className={
        zen
          ? // Between the app chrome and the things that must still be heard over it. `z-30` is the
            // title bar, `z-40` the popovers, and `z-50` is where the toasts and every modal live —
            // so full screen covers the app and a "name already taken" message still reaches the
            // person who is in it. At `z-[55]` the toast was painted behind an opaque background
            // and full screen became a mode where nothing could report anything.
            `fixed inset-0 z-[45] flex flex-col bg-[var(--cf-bg)] ${
              lightsOverWorkbench ? "pt-11" : ""
            }`
          : "relative flex h-full min-h-0 flex-col"
      }
    >
      {/* macOS keeps native window decorations (`titleBarStyle: Overlay`), so AppKit paints the
          traffic lights straight over a zen canvas — and with the app's own title bar covered, the
          window also loses every drag region. The `pt-11` above and this strip give both back:
          `h-11` matches the title bar's height, so the search box and the first lines of the code
          pane start *below* the lights rather than underneath them, and 96px of it drags the window
          — that is where the lights sit, starting at x=20. In OS fullscreen AppKit takes them away
          entirely, so neither the row nor the strip is reserved. */}
      {/* The way out, at the root and not in the canvas's corner cluster — that cluster lives inside
          the branch that draws boxes, so on an empty schema (or before the 15 MB parser chunk has
          landed) it is not rendered, and full screen had no visible exit at all. Top-right, clear
          of the zoom controls in the opposite corner.

          **But it moves off the inspector.** Being at the root means being pinned to the *window's*
          right edge, and the inspector opens against that same edge — so opening it in full screen
          slid a panel over the only way out of full screen. The offset is the panel's width plus its
          one-pixel seam, which puts this where every other floating control here already sits: at
          the canvas's own edge. That is what the search box does when the code pane opens, and it
          gets it for free by living inside the canvas column; this one cannot, for the reason above,
          so it does the same arithmetic by hand.

          Deliberately not transitioned. The panel appears in one frame and the resize handle drags
          `inspectorWidth` continuously, so an animated `right` would trail behind both. */}
      {zen && (
        <button
          type="button"
          onClick={leaveZen}
          title={t("dbml.zenExit")}
          /* Its own pointer handlers, because it is the one overlay that is not *inside* the canvas
             column — see the note above on why it hangs off the root. `chromeHot` is set by that
             column's enter/leave, and this button is stacked over it rather than within it, so
             moving onto it counts as leaving the canvas: without these, pointing at the control
             would be what faded it, and it would take the search box and the zoom cluster down with
             it. Focus is handled too, so arriving here with the keyboard lights it the same way.

             Setting the shared flag rather than a second one of its own is the honest model: chrome
             lying over the drawing *is* the drawing as far as "are the tools wanted" goes. */
          onPointerEnter={() => setChromeHot(true)}
          onPointerLeave={() => setChromeHot(false)}
          onFocus={() => setChromeHot(true)}
          onBlur={() => setChromeHot(false)}
          style={{
            right: inspectorShowing ? inspectorWidth + 1 + 16 : 16,
            opacity: chromeHot ? 1 : DIMMED,
          }}
          className={`absolute top-3 z-20 flex items-center gap-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 px-2 py-[5px] text-[10.5px] font-medium text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)] backdrop-blur transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] ${CHROME_FADE}`}
        >
          <Minimize size={12} />
          {t("dbml.zenExit")}
        </button>
      )}
      {lightsOverWorkbench && (
        <div
          aria-hidden
          data-tauri-drag-region="deep"
          className="absolute left-0 top-0 z-10 h-11 w-[96px]"
        />
      )}
      {!zen && (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
        {/* One segmented control with *three* positions, because there are three things that can be
            in front of you and only ever one of them is.

            The tools button used to sit outside this group, bordered, on the theory that it was a
            menu rather than a view. It isn't: what it opens covers the surface whole. Outside the
            group it left Diagrama filled in the accent while Comparar was what you were reading —
            the control claiming the canvas was showing while a panel covered it. Inside, the rule
            is simple and visible: whichever one is filled is what you are looking at, and pressing
            another replaces it. */}
        <div className="flex items-center gap-[2px] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-field)] p-[2px]">
          {(["diagram", "data"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => {
                setSurface(entry);
                // Diagrama and Datos *are* the view. A tool left open over the surface you just
                // chose would mean pressing Datos and still looking at generated Prisma.
                setTool(null);
              }}
              // Only when no tool is covering it — see the note above.
              aria-pressed={tool === null && surface === entry}
              className={viewPill(tool === null && surface === entry)}
            >
              {t(`dbml.tab.${entry}` as "dbml.tab.diagram")}
              {/* The Datos pill carries state, so the diagram can tell you your data is stale
                  without your going to look. The count is what there is; the amber dot is that the
                  model has moved under it. */}
              {entry === "data" && sandboxRows > 0 && (
                <span className="font-mono text-[9.5px] tabular-nums opacity-70">
                  {sandboxRows}
                </span>
              )}
              {entry === "data" && sandboxDrifted && (
                <span
                  aria-hidden
                  className="h-[5px] w-[5px] rounded-full bg-[var(--cf-warning)]"
                />
              )}
            </button>
          ))}

          {/* The third position. It is one button and not three because the three tools are
              alternatives to *this slot*, not to each other — so the chevron: press it and pick
              which one goes here. Once one is open the pill wears that tool's name and glyph, which
              is what makes the group readable at a glance: Diagrama, Datos, Comparar. */}
          {(() => {
            const open = TOOLS.find((entry) => entry.id === tool);
            const Icon = open ? open.Icon : Wrench;
            return (
              <button
                type="button"
                onClick={(event) => setToolsAt(event.currentTarget.getBoundingClientRect())}
                aria-pressed={tool !== null}
                aria-haspopup="menu"
                className={viewPill(tool !== null)}
              >
                <Icon size={11} />
                {open ? t(`dbml.tab.${open.id}` as "dbml.tab.convert") : t("dbml.tools")}
                <ChevronDown size={11} className="opacity-70" />
              </button>
            );
          })()}
        </div>

        <span className="flex-1" />

        {/* Whether the document currently parses, as a light. It is the one thing about a schema
            being typed that you want to know without looking away from the canvas. */}
        <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
          <span
            className="h-[6px] w-[6px] rounded-full"
            style={{
              background: schema.error ? "var(--cf-danger)" : "var(--cf-success)",
            }}
          />
          {schema.error
            ? t("dbml.statusError")
            : t("dbml.statusParsed", { count: String(schema.tables.length) })}
        </span>

        <ToolbarButton
          onClick={() => {
            setReference(false);
            setHistory((open) => !open);
          }}
          title={t("dbml.history")}
          active={history}
          // Never disabled, even with nothing recorded yet. The panel is not only this session's
          // change list — the saved versions, which reach back past today, are reached from the
          // foot of it — and a freshly opened schema is exactly the case with no revisions and a
          // month of versions behind it. Greying it out there put the only way to those versions
          // behind a button that looked broken.
        >
          <History size={12} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            setHistory(false);
            setReference((open) => !open);
          }}
          title={t("dbml.reference")}
          active={reference}
        >
          <BookOpen size={12} />
        </ToolbarButton>
        <ToolbarButton onClick={tidy} title={t("dbml.format")}>
          <Wand2 size={12} />
        </ToolbarButton>
        {/* Next to the formatter, because they are the same gesture on the two halves of the
            document: one tidies the text, the other tidies the picture. It had only ever been a row
            in a popover behind a button in the canvas's bottom-right corner that fades to a third
            opacity when the pointer leaves — which is to say it existed and nobody could find it. */}
        {/* No arrange and no line-style button here on purpose. Both change how the *picture* is
            drawn rather than what the document says, and both already live where that decision
            belongs: the canvas's own "Ver" menu, in the corner of the drawing they act on, and its
            background context menu. This toolbar is for the document. */}
        <ToolbarButton onClick={onSaveAsTemplate} title={t("diagrams.saveAsTemplate")}>
          <Table2 size={12} />
        </ToolbarButton>
        <ToolbarButton
          onClick={(event) => setExportAt({ x: event.clientX, y: event.clientY })}
          title={t("diagrams.export")}
        >
          <Download size={12} />
        </ToolbarButton>
        {/* The sparkle, in this workbench's own toolbar — the same place draw.io's injected one
            sits, and it opens the same panel. See `DiagramsView`. */}
        <ToolbarButton onClick={onAskAi} title={t("diagrams.ai.title")}>
          <Sparkles size={12} />
        </ToolbarButton>
        {/* Full screen last, next to the sparkle: both are things you do *to the view* rather than
            to the document. Disabled on the Datos surface — there is no canvas to fill. */}
        {/* Disabled while the AI panel or a tool drawer is open rather than left to be undone a tick
            later by the effect below: pressing it then closed the reference and history panels and
            re-fitted the canvas on the way to doing nothing at all. */}
        <ToolbarButton
          onClick={enterZen}
          title={t("dbml.zen")}
          disabled={surface !== "diagram" || aiOpen || tool !== null}
        >
          <Expand size={12} />
        </ToolbarButton>
      </div>
      )}

      <div className="flex min-h-0 flex-1">
        {editorOpen && (
        <div style={{ width: editorWidth }} className="flex shrink-0 flex-col border-r border-[var(--cf-border)]">
          <div className="min-h-0 flex-1">
            <Editor
              path={`cf-dbml:/${diagramId}.dbml`}
              language="dbml"
              value={source}
              theme={monacoTheme}
              onMount={onEditorMount}
              onChange={(value) => writeSource(value ?? "")}
              options={{
                ...OVERFLOW_SAFE_OPTIONS,
                fontSize: 12.5,
                minimap: { enabled: false },
                lineNumbers: "on",
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderLineHighlight: "line",
                tabSize: 2,
                wordWrap: "off",
              }}
            />
          </div>
          {schema.error && (
            <div className="max-h-[38%] shrink-0 overflow-auto border-t border-[var(--cf-danger)] bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-2 py-1.5">
              <p className="flex items-start gap-1.5 text-[11px] font-medium text-[var(--cf-danger)]">
                <AlertTriangle size={12} className="mt-[1px] shrink-0" />
                <span className="whitespace-pre-wrap">{schema.error}</span>
              </p>
              {/* The coordinate, as a control. The message above already ends in `(12:5)`, but a
                  number in a sentence is something to go and find by hand — this is the same fact
                  with the trip attached, and it is the only thing in the banner that is clickable
                  so there is no question about what it does. */}
              {schema.errorAt && (
                <button
                  type="button"
                  onClick={goToError}
                  className="mt-1 ml-[18px] rounded border border-[var(--cf-danger)]/40 px-1.5 py-[1px] font-mono text-[10px] tabular-nums text-[var(--cf-danger)] transition-colors hover:bg-[color-mix(in_oklab,var(--cf-danger)_12%,transparent)]"
                >
                  {t("dbml.goToError", {
                    line: String(schema.errorAt.line),
                    column: String(schema.errorAt.column),
                  })}
                </button>
              )}
              {hint && (
                <div className="mt-1.5 pl-[18px]">
                  <p className="text-[9.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                    {t("dbml.hints")}
                  </p>
                  <ul className="mt-0.5 list-disc pl-3.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {hint.suggestions.map((key) => (
                      <li key={key}>{t(key)}</li>
                    ))}
                  </ul>
                  {hint.example && (
                    <pre className="mt-1 overflow-x-auto rounded border border-[var(--cf-border)] bg-[var(--cf-field)] p-1.5 font-mono text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                      {hint.example}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* What the document is, in numbers. The one thing a text pane owes its writer that the
              canvas cannot answer, and the place every editor in the world puts it. */}
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-2.5 py-[3px] text-[9.5px] tabular-nums text-[var(--cf-text-muted)]">
            <span>{t("dbml.editorLines", { count: String(lineCount) })}</span>
            <span className="flex-1" />
            <span>{t("dbml.editorChars", { count: String(source.length) })}</span>
          </div>
        </div>
        )}

        {editorOpen && (
          <ResizeHandle
            axis="x"
            value={editorWidth}
            min={240}
            max={720}
            onChange={(value) => setSize("dbmlEditorWidth", value)}
            onCommit={(value) => commitSize("dbmlEditorWidth", value)}
          />
        )}

        <div className="relative min-w-0 flex-1">
          {/* The two panes fold away from the canvas's own edges rather than from the toolbar: the
              control belongs against the thing it moves, and it is the edge your eye is already on
              when you decide the drawing needs more room. This one rides the seam because that is
              this container's left edge whether the editor is open or shut. */}
          {/* Drawn in full screen too. Zen *starts* with both panes folded — that is what makes it
              full screen — but it is a view state, not a mode with fewer tools: needing the code or
              the inspector while working large used to mean leaving zen, doing the edit at normal
              size and going back in. The tabs are the same control in both states, in the same
              place, so there is nothing new to learn. */}
          <EdgeTab
            side="left"
            open={editorOpen}
            // Kept above the tools drawer, and it is the only control that is. The drawer covers
            // this container whole, and the pane this handle folds is *outside* it — so folding the
            // text away is how a tool gets the width of the window, and burying the handle under
            // the panel would mean closing the tool to make room for it.
            above
            title={t(editorOpen ? "dbml.collapseEditor" : "dbml.expandEditor")}
            onClick={toggleEditorPane}
          />
          {surface === "diagram" &&
            (!parser ? (
              <ViewSkeleton />
            ) : schema.tables.length === 0 && schema.enums.length === 0 ? (
              <EmptyState
                icon={Table2}
                title={t("dbml.emptyTitle")}
                subtitle={t("dbml.emptySubtitle")}
              />
            ) : (
              <div className="flex h-full min-h-0">
                <div
                  className="relative flex min-w-0 flex-1 flex-col"
                  onPointerEnter={() => setChromeHot(true)}
                  onPointerLeave={() => setChromeHot(false)}
                >
                  <div className="relative min-h-0 flex-1">
                    <DbmlCanvas
                      ref={canvas}
                      schema={schema}
                      positions={positions}
                      rowCounts={sandbox.status?.counts}
                      onMoveTable={moveTable}
                      selected={selected}
                      onSelect={selectFromCanvas}
                      onOpen={revealTable}
                      onMatchCount={setHits}
                      onNodeCount={setNodeCount}
                      onZoom={(scale) =>
                        setZoom((current) =>
                          Math.round(scale * 100) === Math.round(current * 100) ? current : scale,
                        )
                      }
                      mode={mode}
                      density={density}
                      routing={routing}
                      query={query}
                      marks={marks}
                      pinnedId={pinned ? selected : null}
                      focusRef={hoveredRef}
                      editing={{
                        blocked: editing.blocked,
                        // A drawn relationship is a foreign key until told otherwise, which is what
                        // `>` means and what nine of ten drawn relationships are. The inspector's
                        // form is where the other three arrows live.
                        connect: (from, to) => editing.addRef(from, to, ">"),
                        rename: editing.renameTable,
                        // Every one of these invents a name, so every one of them has to check that
                        // the name is free — see `freeName`. A second `new_table` does not make a
                        // messy schema, it makes one that does not parse.
                        addField: (table) => {
                          const target = schema.tables.find((entry) => entry.name === table);
                          editing.addField(table, {
                            name: edits.freeName(
                              (target?.fields ?? []).map((field) => field.name),
                              "column",
                            ),
                            type: "varchar",
                          });
                        },
                        dropTable: editing.dropTable,
                        addTable: () => editing.addTable(edits.freeName(declared, t("dbml.newTable"))),
                        addEnum: () => editing.addEnum(edits.freeName(declared, t("dbml.newEnum"))),
                        setMark,
                        setFieldMark,
                        // The table's **id**, which is what the canvas menu passes and what the
                        // sidecar key a column's mark lives under is built from. `editing` resolves
                        // it back to a block either way — see `tableIdOf`.
                        dropField: editing.dropField,
                        togglePin: togglePinFromCanvas,
                        autoArrange: rearrange,
                        orthogonal: routing === "orthogonal",
                        toggleRouting: () =>
                          setRouting((current) =>
                            current === "curved" ? "orthogonal" : "curved",
                          ),
                        dropRef: editing.dropRef,
                        // The arrow the canvas offers is the one it does not already have. `>` and
                        // `<` are the same relationship read from the two ends, so "flip" is the
                        // one gesture that needs no dialog to choose between them.
                        flipRef: (from, to) => editing.setRefCardinality(from, to, "<"),
                      }}
                      className="h-full"
                    />

                    {/* Just the search now. The three chips that used to sit above it — tables, refs,
                        zoom — said what the document *is*, which is a job for a status bar and not
                        for the middle of the drawing; the first two are in the one along the bottom
                        and the zoom reads off the control that changes it. */}
                    <div
                      className={`absolute left-4 top-2 ${CHROME_FADE}`}
                      style={{ opacity: chromeHot || searchHot || query ? 1 : DIMMED }}
                    >
                      <div className="relative">
                        <Search
                          size={11}
                          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
                        />
                        <input
                          ref={searchRef}
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          onFocus={() => setSearchHot(true)}
                          onBlur={() => setSearchHot(false)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setQuery("");
                              event.currentTarget.blur();
                            }
                            // Enter walks the hits left to right rather than re-running the search,
                            // which is what a search box that has already found everything is for.
                            if (event.key === "Enter") canvas.current?.nextMatch();
                          }}
                          placeholder={t("dbml.searchPlaceholder")}
                          className={`w-56 rounded-lg border bg-[var(--cf-surface-raised)]/90 py-[5px] pl-[26px] text-[11px] shadow-[var(--cf-shadow)] outline-none backdrop-blur transition-colors placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)] ${
                            query ? "pr-[52px]" : "pr-2"
                          } ${
                            query && hits === 0
                              ? "border-[var(--cf-danger)]"
                              : "border-[var(--cf-border)]"
                          }`}
                        />
                        {query && (
                          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                            <span className="text-[9.5px] tabular-nums text-[var(--cf-text-muted)]">
                              {hits ?? 0}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setQuery("");
                                searchRef.current?.focus();
                              }}
                              title={t("dbml.clearSearch")}
                              aria-label={t("dbml.clearSearch")}
                              className="flex h-4 w-4 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
                            >
                              <X size={11} />
                            </button>
                          </div>
                        )}
                      </div>
                  </div>

                  {/* Six stacked pads became two things.

                      The zoom cluster is one control rather than three, because `−`, the number and
                      `+` are one idea and the number was a chip in the opposite corner — you
                      changed the zoom here and read it over there. Everything else about how the
                      picture is drawn is behind "View": those four are settings you reach for once
                      and then leave alone, and a button you press twice an hour does not deserve
                      permanent floor space over the drawing.

                      The PNG and SVG pills are gone from the canvas entirely. They were a shortcut
                      to two entries of the export menu that is still two inches away in the
                      toolbar, and they were the only overlay in the top-right corner — which is
                      where the boxes of a left-to-right layout end up. */}
                  <div
                    className={`absolute bottom-2 right-4 flex items-center gap-1 ${CHROME_FADE}`}
                    style={{ opacity: chromeHot || viewAt ? 1 : DIMMED }}
                  >
                    <button
                      type="button"
                      onClick={(event) =>
                        setViewAt(viewAt ? null : event.currentTarget.getBoundingClientRect())
                      }
                      aria-expanded={Boolean(viewAt)}
                      title={t("dbml.view")}
                      className="flex items-center gap-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 px-2 py-[5px] text-[10.5px] font-medium text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)] backdrop-blur transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                    >
                      <SlidersHorizontal size={12} />
                      {t("dbml.view")}
                    </button>

                    <div className="flex items-center rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 shadow-[var(--cf-shadow)] backdrop-blur">
                      <ZoomStep onClick={() => canvas.current?.zoomBy(1 / 1.2)} title={t("dbml.zoomOut")}>
                        <ZoomOut size={13} />
                      </ZoomStep>
                      {/* The readout doubles as "fit": the number tells you the zoom is wrong and
                          this is the control you are already looking at when it does. */}
                      <button
                        type="button"
                        onClick={() => canvas.current?.fit()}
                        title={t("dbml.fit")}
                        className="min-w-[42px] px-1 py-[5px] text-[10.5px] tabular-nums text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
                      >
                        {`${Math.round(zoom * 100)}%`}
                      </button>
                      <ZoomStep onClick={() => canvas.current?.zoomBy(1.2)} title={t("dbml.zoomIn")}>
                        <ZoomIn size={13} />
                      </ZoomStep>
                    </div>
                  </div>

                  {viewAt && (
                    <ContextMenu
                      x={viewAt.left}
                      y={viewAt.top}
                      // Right-aligned and opening upward: the button is in the bottom-right corner
                      // of the canvas, so those are the only two directions with room.
                      anchor={{
                        top: viewAt.top,
                        bottom: viewAt.bottom,
                        left: viewAt.left,
                        right: viewAt.right,
                        align: "end",
                      }}
                      heading={t("dbml.view")}
                      onClose={() => setViewAt(null)}
                      items={[
                        {
                          // The label is the state it switches *to*, which is how every other menu
                          // in this app reads. The pads said the state they were in and relied on
                          // a fill to mean "active"; a menu row has no fill to lean on.
                          label: t(mode === "all" ? "dbml.columnsKeys" : "dbml.columnsAll"),
                          icon: Columns3,
                          onClick: () => setMode((current) => (current === "all" ? "keys" : "all")),
                        },
                        {
                          label: t(density === "roomy" ? "dbml.compact" : "dbml.roomy"),
                          icon: Shrink,
                          onClick: () =>
                            setDensity((current) => (current === "roomy" ? "compact" : "roomy")),
                        },
                        {
                          // The label is the state it switches *to*, like the two rows above.
                          // Disabled past the point where re-routing on every drag frame would cost
                          // more than the drag has to spend — see `ROUTING_NODE_LIMIT`.
                          label: t(
                            routing === "curved" ? "dbml.routingOrthogonal" : "dbml.routingCurved",
                          ),
                          icon: Spline,
                          // The layout's node count, not the schema's table count: the two can
                          // differ, and gating on the smaller one leaves a switch that is enabled
                          // and silently does nothing.
                          disabled: nodeCount > ROUTING_NODE_LIMIT,
                          onClick: () =>
                            setRouting((current) =>
                              current === "curved" ? "orthogonal" : "curved",
                            ),
                        },
                        {
                          label: t("dbml.autoLayout"),
                          icon: LayoutGrid,
                          onClick: rearrange,
                          separated: true,
                        },
                        { label: t("dbml.fit"), icon: Maximize2, onClick: () => canvas.current?.fit() },
                      ]}
                    />
                  )}

                  {/* Its counterpart on the other edge — see the note on the left one. */}
                  <EdgeTab
                    side="right"
                    open={inspector}
                    title={t(inspector ? "dbml.collapseInspector" : "dbml.expandInspector")}
                    onClick={toggleInspectorPane}
                  />
                  </div>

                  {/* What the picture contains, in the strip along the bottom — the same place and
                      the same treatment as the line and character counts under the text pane. The
                      two numbers describe the document rather than the view, so they belong in
                      furniture that is always there and never in front of the drawing. */}
                  <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-2.5 py-[3px] text-[9.5px] tabular-nums text-[var(--cf-text-muted)]">
                    <span>{t("dbml.chipTables", { count: String(schema.tables.length) })}</span>
                    <span>{t("dbml.chipRefs", { count: String(schema.refs.length) })}</span>
                    {/* How the review is going. Only the two counts that are a to-do list — a
                        "settled" tally is a number that only ever goes up and asks nothing of
                        anybody. Each is hidden at zero rather than shown as "0 to remove", which
                        would put a permanent red nought under a diagram nobody is reviewing. */}
                    {marked.remove > 0 && (
                      <span style={{ color: "var(--cf-danger)" }}>
                        {t("dbml.mark.countRemove", { count: String(marked.remove) })}
                      </span>
                    )}
                    {marked.review > 0 && (
                      <span style={{ color: "var(--cf-warning)" }}>
                        {t("dbml.mark.countReview", { count: String(marked.review) })}
                      </span>
                    )}
                    {/* The end of a review, and the way out of one that has gone wrong. It sits
                        with the counts because that is the only place on screen that says a review
                        is in progress at all, and it appears and disappears with them — a diagram
                        nobody has marked is not offered a way to unmark it. Counted off `marked`
                        rather than `marks` so it follows exactly what the strip beside it shows. */}
                    {marked.remove + marked.review + marked.keep > 0 && (
                      <button
                        type="button"
                        onClick={clearAllMarks}
                        title={t("dbml.mark.clearAllHow")}
                        className="rounded px-1 text-[9.5px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                      >
                        {t("dbml.mark.clearAll")}
                      </button>
                    )}
                    <span className="flex-1" />
                    {query && <span>{t("dbml.searchHits", { count: String(hits ?? 0) })}</span>}
                  </div>
                </div>

                {inspector && (
                  <ResizeHandle
                    axis="x"
                    // The seam is to the *left* of the panel it sizes, so dragging left has to make
                    // it wider — which is what `invert` is for.
                    invert
                    value={inspectorWidth}
                    min={200}
                    max={520}
                    onChange={(value) => setSize("dbmlInspectorWidth", value)}
                    onCommit={(value) => commitSize("dbmlInspectorWidth", value)}
                  />
                )}

                {inspector && (
                  <DbmlInspector
                    width={inspectorWidth}
                    schema={schema}
                    id={selected}
                    onSelect={setSelected}
                    onClose={() => {
                      setPinned(false);
                      setSelected(null);
                    }}
                    onOpen={revealTable}
                    onHoverRef={setHoveredRef}
                    pinned={pinned}
                    onTogglePin={() => setPinned((held) => !held)}
                    mark={
                      selected
                        ? { current: marks[selected], set: (next) => setMark(selected, next) }
                        : undefined
                    }
                    // A lookup and a setter rather than the map itself, so the panel never has to
                    // know how a column's mark is keyed — and so it cannot accidentally read a
                    // mark belonging to a column of the table that *was* selected.
                    fieldMark={
                      selected
                        ? {
                            of: (column) => marks[fieldMarkKey(selected, column)],
                            set: (column, next) => setFieldMark(selected, column, next),
                          }
                        : undefined
                    }
                    edit={editing}
                  />
                )}
              </div>
            ))}

          {surface === "data" && (
            <DbmlDataPanel diagramId={diagramId} schema={schema} onFocusTable={revealTable} />
          )}

          {/* The tools, as a drawer over whatever surface is showing — over the *whole* of it.
              It used to leave a 420px strip of canvas uncovered, on the theory that Generate code is
              read while you type. It isn't: the DBML editor is its own pane, to the left of this
              container and never covered either way, so all the strip bought was a sliver of diagram
              too narrow to read and three panels squeezed into two thirds of the room they wanted —
              ten code targets and a two-column diff, wrapping. Full width, and the thing you came
              here to read is the thing you can see.

              **No close-on-click-outside**, and that is a detail deliberately not copied from the
              precedent. `DbmlHistory`'s backdrop is `onMouseDown={onClose}`, and
              `DbmlImportPanel` keeps its pasted SQL in local `useState`. Copy that here and a
              stray click eats a SQL dump somebody just pasted. Escape and the X are the ways out,
              and both are deliberate.
          */}
          {tool !== null && (
            <div className="absolute inset-0 z-30 flex flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)]">
              {/* No bar of its own, and that is the point: the panel *is* the drawer. A title bar
                  here would be the third row of chrome above the same code — the toolbar already
                  names the open tool and offers the other two, and each panel already has a row of
                  its own actions. So the way out lives in that row, last in the cluster, instead of
                  in a strip that exists to hold one X. */}
              {/* All three stay mounted and are hidden rather than swapped out. `DbmlImportPanel`
                  holds its pasted SQL in `useState`, so unmounting it to show another tool would
                  eat a dump somebody had just pasted in. */}
              <div className="min-h-0 flex-1" hidden={tool !== "convert"}>
                <DbmlConvertPanel schema={schema} title={title} onClose={() => setTool(null)} />
              </div>
              <div className="min-h-0 flex-1" hidden={tool !== "import"}>
                {parser ? (
                  <DbmlImportPanel
                    onClose={() => setTool(null)}
                    convert={parser.sqlToDbmlWithCore}
                    onReplace={(dbml) => {
                      cause.current = "imported";
                      writeSource(dbml);
                      setTool(null);
                    }}
                    onAppend={(dbml) => {
                      cause.current = "merged";
                      editDoc(mergeDbml(doc, dbml));
                      setTool(null);
                    }}
                  />
                ) : (
                  <ViewSkeleton />
                )}
              </div>
              <div className="min-h-0 flex-1" hidden={tool !== "diff"}>
                {parser ? (
                  <DbmlDiffPanel
                    schema={schema}
                    parse={parser.parseDbml}
                    onClose={() => setTool(null)}
                  />
                ) : (
                  <ViewSkeleton />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {reference && <DbmlReference onClose={() => setReference(false)} />}

      {history && (
        <DbmlHistory
          revisions={revisions}
          onRevert={revert}
          onOlder={() => {
            // Full screen has to go with it: the modal is mounted by `DiagramsView`, which is
            // *under* this portalled overlay, so opening it from zen would put it behind a black
            // canvas with no way to reach it.
            if (zen) leaveZen();
            onOlderVersions();
          }}
          onClose={() => setHistory(false)}
        />
      )}

      {exportAt && (
        <ContextMenu
          x={exportAt.x}
          y={exportAt.y}
          items={exportItems}
          onClose={() => setExportAt(null)}
        />
      )}

      {toolsAt && (
        <ContextMenu
          x={toolsAt.left}
          y={toolsAt.bottom}
          anchor={{
            top: toolsAt.top,
            bottom: toolsAt.bottom,
            left: toolsAt.left,
            right: toolsAt.right,
            align: "start",
          }}
          onClose={() => setToolsAt(null)}
          items={TOOLS.map(({ id: entry, Icon }) => ({
            label: t(`dbml.tab.${entry}` as "dbml.tab.convert"),
            icon: Icon,
            // The open one, in the accent. `leading` wins over `icon`, so this is the same glyph
            // in a different colour rather than a tick that would replace it.
            leading:
              entry === tool ? (
                <Icon size={13} className="mt-[2px] shrink-0 text-[var(--cf-accent)]" />
              ) : undefined,
            onClick: () => {
              // Opening a tool leaves full screen, for the same reason the history modal does: the
              // drawer would otherwise sit over a black canvas with the control that opened it off
              // the screen.
              if (zen) leaveZen();
              setTool(entry);
            },
          }))}
        />
      )}
    </div>
  );

  /**
   * Full screen goes through a portal, and it has to.
   *
   * `.cf-ambient-bg` — the element `MainContent` renders inside — carries `isolation: isolate`, which
   * makes it a stacking context. No `z-index` on a descendant can lift over the title bar, the app
   * rail, the status bar or the terminal dock, because those are its *siblings* rather than its
   * children: a `fixed inset-0 z-50` in here would cover the viewport geometrically and still paint
   * underneath every bar. `ApiModal`, `FilePalette` and `CodeSnapModal` all document the same trap.
   *
   * The cost is one remount of the subtree per toggle, and it is a cost worth paying here: entering
   * full screen folds the text pane away, which unmounts Monaco either way, and the canvas is
   * re-fitted on the transition on purpose.
   */
  return zen ? createPortal(workbench, document.body) : workbench;
}

/**
 * A pane's fold-away handle, riding the edge it folds.
 *
 * Half-height of a normal button and flush against the seam, because it is chrome for chrome: it
 * has to be findable without being one more thing competing with the drawing. The chevron always
 * points the way the pane will go, which is the only part of it anybody reads.
 */
function EdgeTab({
  side,
  open,
  title,
  onClick,
  above = false,
}: {
  side: "left" | "right";
  open: boolean;
  title: string;
  onClick: () => void;
  /** Draw over the tools drawer instead of under it — see the left tab's note. */
  above?: boolean;
}) {
  // Pointing away from the canvas closes; pointing into it opens.
  const pointsLeft = side === "left" ? open : !open;
  const Glyph = pointsLeft ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={open}
      className={`absolute top-1/2 ${above ? "z-40" : "z-20"} flex h-11 w-[13px] -translate-y-1/2 items-center justify-center border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 text-[var(--cf-text-muted)] backdrop-blur transition-colors hover:text-[var(--cf-accent)] ${
        side === "left" ? "left-0 rounded-r-md border-l-0" : "right-0 rounded-l-md border-r-0"
      }`}
    >
      <Glyph size={11} />
    </button>
  );
}

/**
 * One step of the zoom cluster.
 *
 * Was three separate `Pad`s — two zoom buttons in a stack of six, and the percentage as a chip in
 * the opposite corner. Joining them into one bordered group is the whole point: `−`, the number and
 * `+` are one control, and the number is the readout of the two buttons beside it rather than a
 * fourth fact about the document.
 *
 * The group keeps the surface every floating control here wears — translucent raised, hairline
 * border, the app's own shadow — because it is still chrome sitting *on* the drawing, and has to
 * stay legible over a dotted ground and over whatever table it lands on. Its two siblings, `Chip`
 * and `Pill`, went with the overlays they drew.
 */
function ZoomStep({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-[26px] w-[26px] items-center justify-center text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
    >
      {children}
    </button>
  );
}

/** Bytes from what `rasterize` hands back, which is base64 with no `data:` prefix. */
function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** A table name, safe to drop into the regular expression `findMatches` is given. */
function escapeForSearch(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
