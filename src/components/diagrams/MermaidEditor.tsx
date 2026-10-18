import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { AlertTriangle, Download, History, LayoutTemplate, Maximize2, Minus, Plus } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { ResizeHandle } from "../common/ResizeHandle";
import { monaco, OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { renderMermaid } from "../../lib/diagrams/mermaidRuntime";
import { convertMermaid, isMermaid } from "../../lib/diagrams/archify/mermaid";
import { FORMAT_ARCHIFY } from "../../lib/diagrams/doc";
import { THUMBNAIL_MAX_CHARS } from "../../lib/diagrams/embed";
import { saveBytes } from "../../lib/diagrams/exportFile";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

/**
 * A Mermaid diagram: the source on the left, the drawing on the right, redrawn as you type.
 *
 * The document **is** the Mermaid text — the same file `.mmd` holds — so it exports, versions, diffs
 * and lives in a repository as itself. Mermaid is loaded on first use (`mermaidRuntime`), never
 * bundled. A source that does not parse keeps the last drawing that did on screen, with Mermaid's
 * own message under it: a half-typed arrow should not blank the picture you are looking at.
 */
/** How many diagrams' buffers (and undo histories) are kept besides the one open. */
const KEPT_MODELS = 5;
const recentDiagrams: string[] = [];

function keepRecentMermaidModels(diagramId: string): void {
  const at = recentDiagrams.indexOf(diagramId);
  if (at >= 0) recentDiagrams.splice(at, 1);
  recentDiagrams.unshift(diagramId);
  const kept = new Set(recentDiagrams.slice(0, KEPT_MODELS + 1).map((id) => `/${id}.mmd`));
  recentDiagrams.length = Math.min(recentDiagrams.length, KEPT_MODELS + 1);
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === "cf-mermaid" && !kept.has(model.uri.path)) model.dispose();
  }
}

export function MermaidEditor({
  diagramId,
  onSaveAsTemplate,
  onHistory,
}: {
  diagramId: string;
  onSaveAsTemplate: () => void;
  onHistory: () => void;
}) {
  const t = useT();
  const doc = useDiagramsStore((s) => (s.draft?.id === diagramId ? s.draft.doc : null));
  const title = useDiagramsStore((s) => s.diagrams.find((d) => d.id === diagramId)?.title ?? "");
  const dark = useThemeStore((s) => s.resolved === "dark");
  const monacoTheme = useThemeStore((s) => s.monacoTheme);

  const [text, setText] = useState<string | null>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(420);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** The document as this editor last wrote or loaded it — see `ExcalidrawEditor.written`. */
  const written = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const renderTimer = useRef<number | null>(null);
  const renderSerial = useRef(0);

  // The buffers of the last few diagrams opened keep their undo history; older ones are freed. The
  // library disposes only the model on screen, so every Mermaid diagram ever opened kept its own.
  useEffect(() => keepRecentMermaidModels(diagramId), [diagramId]);

  // The document arriving, or replaced from outside (a restored version, the file reloaded).
  useEffect(() => {
    if (doc === null || doc === written.current) return;
    written.current = doc;
    setText(doc);
  }, [doc]);

  // Redrawn a moment after the typing stops, and on a theme change. Only the newest render lands.
  useEffect(() => {
    if (text === null) return;
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    renderTimer.current = window.setTimeout(() => {
      renderTimer.current = null;
      const serial = ++renderSerial.current;
      if (!text.trim()) {
        setSvg("");
        setError(null);
        return;
      }
      renderMermaid(text, dark).then(
        (drawn) => {
          if (serial !== renderSerial.current) return;
          setSvg(drawn);
          setError(null);
          // The gallery's card: the drawing itself, when it is small enough to keep.
          const uri = `data:image/svg+xml;base64,${toBase64(drawn)}`;
          useDiagramsStore.getState().setThumbnail(diagramId, uri.length > THUMBNAIL_MAX_CHARS ? "" : uri);
        },
        (failure: unknown) => {
          if (serial !== renderSerial.current) return;
          setError(failure instanceof Error ? failure.message : String(failure));
        },
      );
    }, RENDER_DEBOUNCE_MS);
  }, [text, dark, diagramId]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    },
    [],
  );

  const onChange = useCallback((value: string | undefined) => {
    const next = value ?? "";
    setText(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      written.current = next;
      const store = useDiagramsStore.getState();
      store.editDoc(next);
      store.clearGenerationUndo();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const html = useMemo(() => ({ __html: svg }), [svg]);

  const exportAs = async (format: "svg" | "png" | "pdf" | "mermaid") => {
    const name = title || "diagram";
    try {
      let saved = false;
      if (format === "mermaid") saved = await saveBytes(new TextEncoder().encode(text ?? ""), "mermaid", name);
      else if (format === "svg") saved = await saveBytes(new TextEncoder().encode(svg), "svg", name);
      // Mermaid draws its labels as SVG text (see `mermaidRuntime`), so the PDF is all vectors.
      else if (format === "pdf") saved = await saveBytes(await (await import("../../lib/diagrams/pdf")).svgToPdf(svg), "pdf", name);
      else saved = await saveBytes(await svgToPng(svg, dark ? "#1e1e1e" : "#ffffff"), "png", name);
      if (saved) pushSuccessToast(t("diagrams.exported"));
    } catch (failure) {
      pushErrorToast(String(failure));
    }
  };

  /** archify's architecture map for this source — flowcharts, sequences and state diagrams. */
  const toArchify = () => {
    const source = text ?? "";
    const converted = isMermaid(source) ? convertMermaid(source) : ({ ok: false, reason: "unsupported" } as const);
    if (!converted.ok) {
      pushErrorToast(t(converted.reason === "empty" ? "archify.mermaidEmpty" : "archify.mermaidUnsupported"));
      return;
    }
    const store = useDiagramsStore.getState();
    const folderId = store.diagrams.find((d) => d.id === diagramId)?.folder_id ?? null;
    void store.createWithDoc(folderId, title || "diagram", `${JSON.stringify(converted.doc, null, 2)}\n`, FORMAT_ARCHIFY);
  };

  if (doc === null || text === null) return <ViewSkeleton />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2">
        <span className="mr-auto truncate text-[11px] text-[var(--cf-text-muted)]">Mermaid</span>
        <Tooltip label={t("diagrams.zoomOut")}>
          <button type="button" className={iconButtonClass()} onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>
            <Minus size={14} />
          </button>
        </Tooltip>
        <button
          type="button"
          className="min-w-[44px] rounded-md px-1 text-[11px] tabular-nums text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)} %
        </button>
        <Tooltip label={t("diagrams.zoomIn")}>
          <button type="button" className={iconButtonClass()} onClick={() => setZoom((z) => Math.min(4, z * 1.25))}>
            <Plus size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t("diagrams.zoomFit")}>
          <button type="button" className={iconButtonClass()} onClick={() => setZoom(0)}>
            <Maximize2 size={13} />
          </button>
        </Tooltip>
        <span className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
        <Tooltip label={t("diagrams.saveAsTemplate")}>
          <button type="button" className={iconButtonClass()} onClick={onSaveAsTemplate}>
            <LayoutTemplate size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t("diagrams.export")}>
          <button
            type="button"
            className={iconButtonClass()}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenu({
                x: box.left,
                y: box.bottom + 4,
                items: [
                  { label: t("diagrams.mermaidExport.svg"), disabled: !svg, onClick: () => void exportAs("svg") },
                  { label: t("diagrams.mermaidExport.png"), disabled: !svg, onClick: () => void exportAs("png") },
                  { label: t("diagrams.mermaidExport.pdf"), disabled: !svg, onClick: () => void exportAs("pdf") },
                  { label: t("diagrams.mermaidExport.mmd"), onClick: () => void exportAs("mermaid") },
                  { label: t("diagrams.mermaidToArchify"), separated: true, onClick: toArchify },
                ],
              });
            }}
          >
            <Download size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t("versions.open")}>
          <button type="button" className={iconButtonClass()} onClick={onHistory}>
            <History size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1">
        <div style={{ width }} className="min-w-0 shrink-0">
          <Editor
            height="100%"
            path={`cf-mermaid:/${diagramId}.mmd`}
            language="mermaid"
            value={text}
            onChange={onChange}
            beforeMount={registerMermaidLanguage}
            theme={monacoTheme}
            options={{
              ...OVERFLOW_SAFE_OPTIONS,
              minimap: { enabled: false },
              fontSize: 12.5,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              tabSize: 2,
              wordWrap: "on",
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
        <ResizeHandle axis="x" value={width} min={220} max={900} onChange={setWidth} onCommit={setWidth} />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto bg-[var(--cf-surface)] p-4">
            {svg ? (
              <div
                className={`cf-mermaid-preview mx-auto ${zoom === 0 ? "[&>svg]:!h-auto [&>svg]:!max-w-full" : ""}`}
                style={zoom === 0 ? undefined : { transform: `scale(${zoom})`, transformOrigin: "top center" }}
                dangerouslySetInnerHTML={html}
              />
            ) : (
              !error && <p className="text-center text-[12px] text-[var(--cf-text-muted)]">{t("diagrams.mermaidEmpty")}</p>
            )}
          </div>
          {error && (
            <div className="flex max-h-[30%] shrink-0 items-start gap-1.5 overflow-auto border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 text-[11.5px] text-[var(--cf-danger)]">
              <AlertTriangle size={13} className="mt-[1px] shrink-0" />
              <pre className="min-w-0 whitespace-pre-wrap font-mono">{error}</pre>
            </div>
          )}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const SAVE_DEBOUNCE_MS = 400;
const RENDER_DEBOUNCE_MS = 250;

/** Base64 of a UTF-8 string — `btoa` alone takes Latin-1, and diagram labels are not. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/**
 * The drawing as a PNG at twice its size, on the theme's background. Works because labels are drawn
 * as SVG text (`htmlLabels: false` in `mermaidRuntime`): HTML inside a `<foreignObject>` taints the
 * canvas and the export would be refused.
 */
async function svgToPng(svg: string, background: string): Promise<Uint8Array> {
  const image = new Image();
  image.src = `data:image/svg+xml;base64,${toBase64(svg)}`;
  await image.decode();
  const scale = 2;
  const width = Math.max(1, Math.ceil((image.naturalWidth || 800) * scale));
  const height = Math.max(1, Math.ceil((image.naturalHeight || 600) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG export failed");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Keywords, arrows, strings and `%%` comments — enough colour to read a diagram by, registered once. */
function registerMermaidLanguage(monaco: Monaco) {
  if (monaco.languages.getLanguages().some((language: { id: string }) => language.id === "mermaid")) return;
  monaco.languages.register({ id: "mermaid", extensions: [".mmd", ".mermaid"] });
  monaco.languages.setMonarchTokensProvider("mermaid", {
    keywords: [
      "graph", "flowchart", "subgraph", "end", "direction", "sequenceDiagram", "participant", "actor",
      "note", "over", "loop", "alt", "else", "opt", "par", "and", "rect", "critical", "break", "activate",
      "deactivate", "autonumber", "classDiagram", "class", "stateDiagram", "stateDiagram-v2", "state",
      "erDiagram", "gantt", "title", "section", "dateFormat", "axisFormat", "pie", "journey", "gitGraph",
      "commit", "branch", "checkout", "merge", "mindmap", "timeline", "quadrantChart", "xychart-beta",
      "sankey-beta", "block-beta", "requirementDiagram", "C4Context", "classDef", "style", "linkStyle",
      "click", "TD", "TB", "BT", "LR", "RL",
    ],
    tokenizer: {
      root: [
        [/%%.*$/, "comment"],
        [/"[^"]*"/, "string"],
        [/(-->|---|-\.->|==>|->>|-->>|-x|--x|-\)|--\)|<-->|o--o|x--x|\.\.>|<\|--|\*--|o--|-->|\|)/, "operator"],
        [/[a-zA-Z_][\w-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/\d+/, "number"],
        [/[[\](){}]/, "delimiter.bracket"],
      ],
    },
  });
}
