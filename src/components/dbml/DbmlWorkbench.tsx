import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  FileCode2,
  LayoutGrid,
  Maximize2,
  Search,
  Shrink,
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
import { DbmlReference } from "./DbmlReference";
import { DbmlConvertPanel } from "./DbmlConvertPanel";
import { DbmlDiffPanel } from "./DbmlDiffPanel";
import { DbmlImportPanel } from "./DbmlImportPanel";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { ToolbarButton } from "../db/dbChrome";
import { formatDbml } from "../../lib/dbml/format";
import { hintFor } from "../../lib/dbml/errors";
import { mergeDbml } from "../../lib/dbml/merge";
import { readLayout, writeLayout } from "../../lib/dbml/layout";
import { EMPTY_SCHEMA, type DbmlSchema } from "../../lib/dbml/types";
import type { SqlImportDialect } from "../../lib/dbml/parse";
import { rasterize, standaloneSvg } from "../../lib/diagramSvg";
// The one ceiling on a stored picture, imported rather than restated: it is a property of what the
// gallery keeps, not of the editor that produced it, and two numbers would mean a schema's
// thumbnail and a drawing's were allowed to be different sizes for no reason anyone chose.
import { THUMBNAIL_MAX_CHARS } from "../../lib/diagrams/embed";
import { safeFileName, saveBytes } from "../../lib/diagrams/exportFile";
import type { DiagramColumnMode, DiagramDensity } from "../../lib/db/erLayout";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useThemeStore } from "../../state/themeStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

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

/** How long after the last keystroke the document is re-parsed. */
const PARSE_DEBOUNCE_MS = 260;
/** And how long after the last change the gallery's picture is redrawn. Longer: it rasterises. */
const THUMBNAIL_DEBOUNCE_MS = 1400;

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

  const editorWidth = useLayoutStore((s) => s.sizes.dbmlEditorWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [surface, setSurface] = useState<Surface>("diagram");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** Only so the canvas's chip can print it. Updated when the rounded percentage actually moves,
   *  or a pinch would re-render the workbench once per frame for a number that did not change. */
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<DiagramColumnMode>("all");
  /** The two side panes. Both on by default and both closable from the canvas's own edges, because
   *  three columns is a lot of window and which one you want depends on whether you are writing the
   *  schema or reading it. */
  const [inspector, setInspector] = useState(true);
  const [editorOpen, setEditorOpen] = useState(true);
  const [reference, setReference] = useState(false);
  const [density, setDensity] = useState<DiagramDensity>("roomy");
  const [exportAt, setExportAt] = useState<{ x: number; y: number } | null>(null);

  const canvas = useRef<DbmlCanvasHandle>(null);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);

  /** The document, split. Recomputed on every keystroke, which is a string scan and nothing more. */
  const { source, positions } = useMemo(() => readLayout(doc ?? ""), [doc]);

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
    if (!exists) setSelected(null);
  }, [schema, selected]);

  // ---- writing -------------------------------------------------------------

  /** One edit to the DBML itself, with the dragged boxes carried through untouched. */
  const writeSource = useCallback(
    (next: string) => editDoc(writeLayout(next, positions)),
    [editDoc, positions],
  );

  /** One box moved. Only the layout comment changes, so Monaco's value does not — see the header. */
  const moveTable = useCallback(
    (id: string, x: number, y: number) =>
      editDoc(writeLayout(source, { ...positions, [id]: { x, y } })),
    [editDoc, source, positions],
  );

  const tidy = () => {
    const formatted = formatDbml(source);
    if (formatted === source) return;
    writeSource(formatted);
    useToastStore.getState().pushToast(t("dbml.formatted"), "success");
  };

  /** Throws the hand-arrangement away, which puts every box back under the layout engine. */
  const rearrange = () => {
    if (Object.keys(positions).length === 0) {
      canvas.current?.fit();
      return;
    }
    editDoc(writeLayout(source, {}));
    useToastStore.getState().pushToast(t("dbml.layoutReset"), "success");
  };

  /** Puts the cursor on a table's declaration. What double-clicking a box does. */
  const revealTable = useCallback(
    (id: string) => {
      const editor = editorRef.current;
      if (!editor) return;
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

  const exportItems: MenuItem[] = [
    { label: t("diagrams.exportAs.png"), onClick: () => void exportAs("png") },
    { label: t("diagrams.exportAs.svg"), onClick: () => void exportAs("svg") },
    { label: t("diagrams.exportAs.dbml"), onClick: () => void exportAs("dbml") },
  ];

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // The document has not arrived from the database yet, or belongs to another diagram.
  if (doc === null || draftId !== diagramId) return <ViewSkeleton />;

  const hint = schema.error ? hintFor(schema.error) : null;
  const lineCount = source === "" ? 0 : source.split("\n").length;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
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
          onClick={() => setReference((open) => !open)}
          title={t("dbml.reference")}
          active={reference}
        >
          <BookOpen size={12} />
        </ToolbarButton>
        <ToolbarButton onClick={tidy} title={t("dbml.format")}>
          <Wand2 size={12} />
        </ToolbarButton>
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
      </div>

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
          <EdgeTab
            side="left"
            open={editorOpen}
            title={t(editorOpen ? "dbml.collapseEditor" : "dbml.expandEditor")}
            onClick={() => setEditorOpen((open) => !open)}
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
                <div className="relative min-w-0 flex-1">
                  <DbmlCanvas
                    ref={canvas}
                    schema={schema}
                    positions={positions}
                    onMoveTable={moveTable}
                    selected={selected}
                    onSelect={setSelected}
                    onOpen={revealTable}
                    onZoom={(scale) =>
                      setZoom((current) =>
                        Math.round(scale * 100) === Math.round(current * 100) ? current : scale,
                      )
                    }
                    mode={mode}
                    density={density}
                    query={query}
                    className="h-full"
                  />

                  {/* What is in here, and how close you are to it. Over the canvas rather than in
                      the toolbar: they describe the picture, and they change as you move it. */}
                  <div className="pointer-events-none absolute left-4 top-2 flex flex-col items-start gap-1.5">
                    <div className="flex items-center gap-1">
                      <Chip>{t("dbml.chipTables", { count: String(schema.tables.length) })}</Chip>
                      <Chip>{t("dbml.chipRefs", { count: String(schema.refs.length) })}</Chip>
                      <Chip>{`${Math.round(zoom * 100)}%`}</Chip>
                    </div>
                    <div className="pointer-events-auto relative">
                      <Search
                        size={11}
                        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
                      />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setQuery("");
                        }}
                        placeholder={t("dbml.searchPlaceholder")}
                        className="w-52 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 py-[5px] pl-[26px] pr-2 text-[11px] shadow-[var(--cf-shadow)] outline-none backdrop-blur transition-colors placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
                      />
                    </div>
                  </div>

                  {/* The two files anybody actually asks for. The menu in the toolbar still has
                      these and `.dbml` besides — this is the shortcut, not the only way. */}
                  <div className="absolute right-4 top-2 flex items-center gap-1">
                    <Pill onClick={() => void exportAs("png")} title={t("diagrams.exportAs.png")}>
                      <Download size={11} />
                      PNG
                    </Pill>
                    <Pill onClick={() => void exportAs("svg")} title={t("diagrams.exportAs.svg")}>
                      <FileCode2 size={11} />
                      SVG
                    </Pill>
                  </div>

                  {/* How the picture is drawn and where it sits, stacked in the corner nearest the
                      hand that is already on the canvas. */}
                  <div className="absolute bottom-2 right-4 flex flex-col gap-1">
                    <Pad
                      onClick={() => setMode((current) => (current === "all" ? "keys" : "all"))}
                      title={t(mode === "all" ? "dbml.columnsAll" : "dbml.columnsKeys")}
                      active={mode === "keys"}
                    >
                      <Columns3 size={13} />
                    </Pad>
                    <Pad
                      onClick={() =>
                        setDensity((current) => (current === "roomy" ? "compact" : "roomy"))
                      }
                      title={t(density === "roomy" ? "dbml.roomy" : "dbml.compact")}
                      active={density === "compact"}
                    >
                      <Shrink size={13} />
                    </Pad>
                    <Pad onClick={rearrange} title={t("dbml.autoLayout")}>
                      <LayoutGrid size={13} />
                    </Pad>
                    <Pad onClick={() => canvas.current?.fit()} title={t("dbml.fit")}>
                      <Maximize2 size={13} />
                    </Pad>
                    <Pad onClick={() => canvas.current?.zoomBy(1.2)} title={t("dbml.zoomIn")}>
                      <ZoomIn size={13} />
                    </Pad>
                    <Pad onClick={() => canvas.current?.zoomBy(1 / 1.2)} title={t("dbml.zoomOut")}>
                      <ZoomOut size={13} />
                    </Pad>
                  </div>

                  <EdgeTab
                    side="right"
                    open={inspector}
                    title={t(inspector ? "dbml.collapseInspector" : "dbml.expandInspector")}
                    onClick={() => setInspector((open) => !open)}
                  />
                </div>

                {inspector && (
                  <DbmlInspector
                    schema={schema}
                    id={selected}
                    onSelect={setSelected}
                    onClose={() => setSelected(null)}
                    onOpen={revealTable}
                  />
                )}
              </div>
            ))}

          {surface === "convert" && <DbmlConvertPanel schema={schema} title={title} />}

          {surface === "import" &&
            (parser ? (
              <DbmlImportPanel
                convert={parser.sqlToDbmlWithCore}
                onReplace={(dbml) => writeSource(dbml)}
                onAppend={(dbml) => editDoc(mergeDbml(doc, dbml))}
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
 * The three shapes of floating control the canvas wears.
 *
 * All three share one surface — translucent raised, hairline border, the app's own shadow — because
 * they are all the same thing: chrome sitting *on* the drawing rather than around it, which has to
 * stay legible over a dotted ground and over a table that happens to be underneath it.
 */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 px-2 py-[3px] text-[10.5px] tabular-nums text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)] backdrop-blur">
      {children}
    </span>
  );
}

function Pill({
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
      className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 px-2 py-[4px] text-[10.5px] font-medium text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)] backdrop-blur transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
    >
      {children}
    </button>
  );
}

function Pad({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-8 w-8 items-center justify-center rounded-md border shadow-[var(--cf-shadow)] backdrop-blur transition-colors ${
        active
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "border-[var(--cf-border)] bg-[var(--cf-surface-raised)]/90 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
      }`}
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
