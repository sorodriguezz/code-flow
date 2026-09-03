import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  Expand,
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
import { readLayout, writeLayout, type DbmlMarkKind, type DbmlMarks } from "../../lib/dbml/layout";
import { EMPTY_SCHEMA, type DbmlSchema } from "../../lib/dbml/types";
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

type Surface = "diagram" | "convert" | "import" | "diff";

interface Parser {
  parseDbml: (doc: string) => DbmlSchema;
  sqlToDbmlWithCore: (sql: string, dialect: SqlImportDialect) => string;
}

export function DbmlWorkbench({
  diagramId,
  onSaveAsTemplate,
  onAskAi,
}: {
  diagramId: string;
  onSaveAsTemplate: () => void;
  onAskAi: () => void;
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
  /** A declaration to jump to as soon as the text pane has an editor again. See `revealTable`. */
  const pendingReveal = useRef<string | null>(null);

  /** The document, split. Recomputed on every keystroke, which is a string scan and nothing more. */
  const { source, positions, marks } = useMemo(() => readLayout(doc ?? ""), [doc]);

  // ---- the parser, and what it produced -----------------------------------

  const [parser, setParser] = useState<Parser | null>(null);
  const [schema, setSchema] = useState<DbmlSchema>(EMPTY_SCHEMA);
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
        parsed.tables.length === 0 && parsed.enums.length === 0 && parsed.error
          ? { ...current, error: parsed.error }
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
    const flag = nextMark[from];
    delete nextAt[from];
    delete nextMark[from];
    if (to !== null) {
      if (place) nextAt[to] = place;
      if (flag) nextMark[to] = flag;
    }
    sidecar.current = { positions: nextAt, marks: nextMark };
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
   * Sets or clears a review mark.
   *
   * Writes the sidecar only, so unlike everything in `editing` below it stays available while the
   * document does not parse — see the note on `setMark` in `DbmlCanvas`. It also goes straight to
   * `editDoc` rather than through `applyEdit`: `applyEdit` routes through Monaco's `executeEdits`
   * so that ⌘Z takes back a structural change, and a mark changes no character the editor is
   * showing, so there would be nothing for Monaco to undo.
   */
  const setMark = useCallback(
    (id: string, mark: DbmlMarkKind | null) => {
      const next: DbmlMarks = { ...marks };
      if (mark) next[id] = mark;
      else delete next[id];
      cause.current = "marked";
      editDoc(writeLayout(source, positions, next));
    },
    [editDoc, source, positions, marks],
  );

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
  const editing = useMemo(
    () => ({
      blocked: Boolean(schema.error),
      blockedReason: t("dbml.editBlocked"),
      addField: (table: string, field: edits.FieldEdit) =>
        applyEdit((current) => edits.addField(current, table, field)),
      updateField: (table: string, name: string, field: edits.FieldEdit) =>
        applyEdit((current) => edits.updateField(current, table, name, field)),
      dropField: (table: string, name: string) =>
        applyEdit((current) => edits.dropField(current, table, name)),
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
    // regardless.
    [applyEdit, schema.error, source, t],
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
    setEditorOpen(false);
    setInspector(false);
    // Anything floating over the canvas goes with them, or it is left hanging over a black screen
    // with the control that opened it no longer on screen.
    setReference(false);
    setHistory(false);
    setViewAt(null);
    setExportAt(null);
  };

  const leaveZen = useCallback(() => {
    setZenFrom((from) => {
      if (!from) return null;
      setEditorOpen(from.editor);
      setInspector(from.inspector);
      return null;
    });
  }, []);

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
   * Four things in this workbench already answer Escape and each of them must win it: the history
   * and reference panels close themselves, the View and export menus dismiss, and every text field
   * on screen (the search box, the canvas's rename input, the inspector's editors) treats it as
   * "abandon what I am typing". Hence the guards on the subscription rather than inside the
   * handler: while any of those is open this listener is not bound at all.
   */
  useEffect(() => {
    if (!zen || history || reference || viewAt !== null || exportAt !== null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      leaveZen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen, history, reference, viewAt, exportAt, leaveZen]);

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

  const exportItems: MenuItem[] = [
    { label: t("diagrams.exportAs.png"), onClick: () => void exportAs("png") },
    { label: t("diagrams.exportAs.svg"), onClick: () => void exportAs("svg") },
    { label: t("diagrams.exportAs.dbml"), onClick: () => void exportAs("dbml") },
  ];

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
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

  const workbench = (
    <div
      className={
        zen
          ? // Between the app chrome and the things that must still be heard over it. `z-30` is the
            // title bar, `z-40` the popovers, and `z-50` is where the toasts and every modal live —
            // so full screen covers the app and a "name already taken" message still reaches the
            // person who is in it. At `z-[55]` the toast was painted behind an opaque background
            // and full screen became a mode where nothing could report anything.
            "fixed inset-0 z-[45] flex flex-col bg-[var(--cf-bg)]"
          : "relative flex h-full min-h-0 flex-col"
      }
    >
      {/* macOS keeps native window decorations (`titleBarStyle: Overlay`), so AppKit paints the
          traffic lights straight over a zen canvas — and with the app's own title bar covered, the
          window also loses every drag region. This strip gives both back: `h-11` matches the title
          bar's height and 96px clears the lights, which start at x=20. In OS fullscreen AppKit
          takes them away entirely, so the strip is not reserved. */}
      {/* The way out, at the root and not in the canvas's corner cluster — that cluster lives inside
          the branch that draws boxes, so on an empty schema (or before the 15 MB parser chunk has
          landed) it is not rendered, and full screen had no visible exit at all. Top-right, clear
          of the zoom controls in the opposite corner. */}
      {zen && (
        <button
          type="button"
          onClick={leaveZen}
          title={t("dbml.zenExit")}
          className={`absolute right-4 top-3 z-20 flex items-center gap-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 px-2 py-[5px] text-[10.5px] font-medium text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)] backdrop-blur transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] ${CHROME_FADE}`}
        >
          <Minimize size={12} />
          {t("dbml.zenExit")}
        </button>
      )}
      {zen && platformIsMac() && !windowFullscreen && (
        <div
          aria-hidden
          data-tauri-drag-region="deep"
          className="absolute left-0 top-0 z-10 h-11 w-[96px]"
        />
      )}
      {!zen && (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
        {/* One segmented control rather than four loose buttons: these are four views of the same
            document, not four commands, and a group reads as "pick one". */}
        <div className="flex items-center gap-[2px] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-field)] p-[2px]">
          {(["diagram", "convert", "import", "diff"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setSurface(entry)}
              className={`rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
                surface === entry
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              }`}
            >
              {t(`dbml.tab.${entry}` as "dbml.tab.diagram")}
            </button>
          ))}
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
          disabled={revisions.length === 0}
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
            to the document. Disabled on the other three surfaces — there is no canvas to fill. */}
        {/* Disabled while the AI panel is open rather than left to be undone a tick later by the
            effect below: pressing it then closed the reference and history panels and re-fitted the
            canvas on the way to doing nothing at all. */}
        <ToolbarButton
          onClick={enterZen}
          title={t("dbml.zen")}
          disabled={surface !== "diagram" || aiOpen}
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
          {!zen && (
            <EdgeTab
              side="left"
              open={editorOpen}
              title={t(editorOpen ? "dbml.collapseEditor" : "dbml.expandEditor")}
              onClick={() => setEditorOpen((open) => !open)}
            />
          )}
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

                  {!zen && (
                    <EdgeTab
                      side="right"
                      open={inspector}
                      title={t(inspector ? "dbml.collapseInspector" : "dbml.expandInspector")}
                      onClick={() => setInspector((open) => !open)}
                    />
                  )}
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
                    edit={editing}
                  />
                )}
              </div>
            ))}

          {surface === "convert" && <DbmlConvertPanel schema={schema} title={title} />}

          {surface === "import" &&
            (parser ? (
              <DbmlImportPanel
                convert={parser.sqlToDbmlWithCore}
                onReplace={(dbml) => {
                  cause.current = "imported";
                  writeSource(dbml);
                }}
                onAppend={(dbml) => {
                  cause.current = "merged";
                  editDoc(mergeDbml(doc, dbml));
                }}
              />
            ) : (
              <ViewSkeleton />
            ))}

          {surface === "diff" &&
            (parser ? (
              <DbmlDiffPanel schema={schema} parse={parser.parseDbml} />
            ) : (
              <ViewSkeleton />
            ))}
        </div>
      </div>

      {reference && <DbmlReference onClose={() => setReference(false)} />}

      {history && (
        <DbmlHistory
          revisions={revisions}
          onRevert={revert}
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
}: {
  side: "left" | "right";
  open: boolean;
  title: string;
  onClick: () => void;
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
      className={`absolute top-1/2 z-20 flex h-11 w-[13px] -translate-y-1/2 items-center justify-center border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 text-[var(--cf-text-muted)] backdrop-blur transition-colors hover:text-[var(--cf-accent)] ${
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
